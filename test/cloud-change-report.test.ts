import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { POST as detectDrifts } from "../src/portal/app/api/detect-drifts/route"
import { clearSettingNames } from "../src/portal/lib/drift/setting-names"
import { mapAuditEvent, type AuditEventRaw } from "../src/shared/notifications/audit"
import { buildChangeReport, changeReportMarkdown, reportFileName } from "../src/shared/reports/change-report"
import { buildChangeReportDocument } from "../src/shared/reports/change-report-html"
import { reportEmail } from "../src/main/features/reports"
import { MAX_BACKUP_ARCHIVE_BYTES } from "../src/shared/constants"
import type { DriftResult } from "../src/shared/intune/drift"
import { readFileSync } from "node:fs"
import fixture from "./fixtures/reports/cloud-backups.json"

const pwsh = ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh", ...(process.env.HOME ? [`${process.env.HOME}/.local/bin/pwsh`] : [])].find((candidate) => existsSync(candidate))
const fixturePath = fileURLToPath(new URL("./fixtures/reports/cloud-backups.json", import.meta.url))
const script = fileURLToPath(new URL("./fixtures/reports/cloud-report.ps1", import.meta.url))
const mailScript = fileURLToPath(new URL("./fixtures/reports/cloud-report-mail.ps1", import.meta.url))
const runScript = fileURLToPath(new URL("./fixtures/reports/cloud-report-run.ps1", import.meta.url))
const deliverScript = fileURLToPath(new URL("./fixtures/reports/cloud-report-deliver.ps1", import.meta.url))
const cappedScript = fileURLToPath(new URL("./fixtures/reports/capped-read.ps1", import.meta.url))

type Run = { output: string[]; methods: string[]; reads: string[]; writes: Array<{ uri: string; contentType: string; headers: Record<string, string>; body: string }> }
const runReport = (scenario = "default", level = "full") => JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", runScript, "-FixturePath", fixturePath, "-Level", level, "-Scenario", scenario], { encoding: "utf8", maxBuffer: 100_000_000 })) as Run
const manifestReads = (run: Run) => run.reads.filter((uri) => uri.endsWith("/metadata.json")).map((uri) => uri.split("/")[4])

type Backup = { name: string; metadata: unknown; files: Record<string, unknown> }
const backups: Backup[] = [fixture.older as Backup, fixture.newer as Backup]
const definitions = fixture.definitions as Record<string, unknown>

afterEach(() => vi.unstubAllGlobals())

/** The desktop app's report of the fixture: the drift route over storage and Graph fakes, then the report code. */
async function desktopReport(options: { values: boolean; actors: boolean; auditError?: string; trigger?: "manual" | "scheduled" }) {
  clearSettingNames()
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "test" })
    if (url.pathname === "/api/revert-metadata") return Response.json({ reverts: {} })
    if (url.hostname === "graph.microsoft.com") {
      const { requests } = JSON.parse(String(init?.body)) as { requests: Array<{ id: string; url: string }> }
      return Response.json({ responses: requests.map((request) => {
        const id = decodeURIComponent(request.url.split("/").pop()!)
        return Object.hasOwn(definitions, id) && definitions[id] !== null ? { id: request.id, status: 200, body: definitions[id] } : { id: request.id, status: 404 }
      }) })
    }
    if (url.searchParams.get("delimiter")) return new Response(backups.map((backup) => `<BlobPrefix><Name>${backup.name}/</Name></BlobPrefix>`).join(""))
    const prefix = url.searchParams.get("prefix")
    if (prefix) {
      const backup = backups.find((entry) => prefix === `${entry.name}/`)!
      return new Response(Object.keys(backup.files).map((file) => `<Blob><Name>${backup.name}/${file.replace(/&/g, "&amp;")}</Name></Blob>`).join(""))
    }
    const path = decodeURIComponent(url.pathname.split("/").slice(2).join("/"))
    const backup = backups.find((entry) => path.startsWith(`${entry.name}/`))!
    const rest = path.slice(backup.name.length + 1)
    if (rest === "metadata.json") return Response.json(backup.metadata)
    return Object.hasOwn(backup.files, rest) ? Response.json(backup.files[rest]) : new Response("", { status: 404 })
  }))
  const response = await detectDrifts(new NextRequest("http://tenuvault.internal/api/detect-drifts", { method: "POST", body: JSON.stringify({ tenantId: fixture.tenantId, appId: "app", clientSecret: "test", storageAccountName: "store", documentItems: true }) }))
  const drift = (await response.json()) as DriftResult
  expect(response.status, JSON.stringify(drift)).toBe(200)
  const changes = fixture.audit.flatMap((raw) => { const change = mapAuditEvent(raw as AuditEventRaw); return change ? [{ ...change, source: "Intune" }] : [] })
  const report = buildChangeReport(drift, options.auditError ? { error: options.auditError } : { changes, note: null }, { tenantId: fixture.tenantId, tenantName: fixture.tenantName, generatedAt: fixture.generatedAt, trigger: options.trigger ?? "scheduled", cloud: true, includeValues: options.values, includeActors: options.actors })
  return { report, markdown: changeReportMarkdown(report), html: buildChangeReportDocument(report).html, email: reportEmail({ report }, null, "azure-watcher"), fileName: reportFileName(report) }
}

function cloudReport(options: { values: boolean; actors: boolean; auditError?: string; trigger?: "manual" | "scheduled" }) {
  const output = execFileSync(pwsh!, ["-NoProfile", "-File", script, "-FixturePath", fixturePath, "-Level", options.values ? "full" : "names", "-Actors", String(options.actors), ...(options.auditError ? ["-AuditError", options.auditError] : []), ...(options.trigger ? ["-Trigger", options.trigger] : [])], { encoding: "utf8", maxBuffer: 20_000_000 })
  return JSON.parse(output) as { report: unknown; markdown: string; html: string; email: Record<string, unknown>; fileName: string }
}

describe.runIf(Boolean(pwsh))("cloud change reports match the desktop app", () => {
  // A raw Graph error as the audit note: both clean it the same way before it is shown or sent.
  const rawAuditError = 'The Intune audit log could not be read: Microsoft Graph returned 400: {"error":{"code":"BadRequest","message":"https://proxy.example/x tenant 8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14 Operation ID: 1"}}'
  // The throttled read as the desktop app words it, and as the cloud runbook leaves it.
  const throttledDesktop = "The Intune audit log could not be read: Microsoft Graph throttled the request (429). Generate the report again in a few minutes."
  const throttledRaw = 'The Intune audit log could not be read: Microsoft Graph returned 429: {"_version":3,"Message":"Operation ID: 1 https://proxy.example/x"}'
  const cases: Array<{ values: boolean; actors: boolean; auditError?: string; trigger?: "manual" | "scheduled" }> = [
    { values: true, actors: true },
    { values: false, actors: false },
    { values: true, actors: true, auditError: rawAuditError },
    { values: true, actors: true, auditError: "Microsoft Graph throttled the Intune audit log request." },
    { values: true, actors: true, auditError: throttledDesktop },
    { values: false, actors: true, auditError: throttledRaw },
    { values: true, actors: true, trigger: "manual" },
  ]
  for (const options of cases) {
    it(`builds the same report, Markdown and HTML (${options.values ? "with values" : "names only"}${options.auditError ? `, audit error ${options.auditError.slice(0, 40)}` : ""}${options.trigger ? `, ${options.trigger}` : ""})`, async () => {
      const desktop = await desktopReport(options)
      const cloud = cloudReport(options)
      expect(cloud.report).toEqual(JSON.parse(JSON.stringify(desktop.report)))
      expect(cloud.markdown).toBe(desktop.markdown)
      expect(cloud.html).toBe(desktop.html)
      expect(cloud.fileName).toBe(desktop.fileName)
      expect((cloud.report as { cloud?: boolean }).cloud).toBe(true)
      if (options.auditError === rawAuditError) expect(cloud.markdown).toContain("- Audit log: Microsoft Graph returned 400.")
      // An emailed report never advises generating it again: a throttled read says who is unknown and why.
      for (const text of [cloud.markdown, cloud.html, JSON.stringify(cloud.email)]) expect(text).not.toMatch(/again/i)
      if (options.auditError && /429|throttl/.test(options.auditError)) {
        expect(cloud.markdown).toContain("- Audit log: Microsoft Graph throttled the Intune audit log request.")
        expect(cloud.html).toContain("<b>Who made the changes is unknown.</b> Microsoft Graph throttled the Intune audit log request.")
        expect(cloud.email.summary).toBe("8 changed, 2 added, 1 deleted. Who made them is unknown. Microsoft Graph throttled the Intune audit log request.")
      }
      // The report says it followed a scheduled backup only when the schedule started it.
      expect(cloud.markdown.includes(" after a scheduled backup")).toBe(options.trigger !== "manual")
    }, 60_000)
  }

  it("sends the same email as the desktop app when the audit log was throttled, saying who is unknown and why", async () => {
    const desktop = await desktopReport({ values: true, actors: true, auditError: throttledDesktop })
    const cloud = cloudReport({ values: true, actors: true, auditError: throttledDesktop })
    const folder = mkdtempSync(join(tmpdir(), "tenuvault-report-throttled-"))
    try {
      const notePath = join(folder, "note.json")
      writeFileSync(notePath, JSON.stringify({ schema: "tenuvault.cloud-change-report/v1", tenantId: fixture.tenantId, runId: "run-1", backupFolder: fixture.newer.name, createdAt: fixture.generatedAt, changes: 11, email: cloud.email, files: [] }))
      const mail = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", mailScript, "-NotePath", notePath, "-TenantId", fixture.tenantId, "-TenantName", fixture.tenantName], { encoding: "utf8", maxBuffer: 20_000_000 }))
      expect(mail.html).toBe(desktop.email.html)
      expect(mail.html).toContain("Who made them is unknown. Microsoft Graph throttled the Intune audit log request.")
      expect(mail.html).not.toMatch(/again/i)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }, 60_000)

  it("sends the same email as the desktop app, from the note the backup leaves", async () => {
    const desktop = await desktopReport({ values: true, actors: true })
    const cloud = cloudReport({ values: true, actors: true })
    const note = {
      schema: "tenuvault.cloud-change-report/v1", tenantId: fixture.tenantId, runId: "run-1", backupFolder: fixture.newer.name, createdAt: fixture.generatedAt, changes: 8,
      email: cloud.email,
      files: [{ name: `${cloud.fileName}.html`, contentType: "text/html", content: cloud.html }, { name: `${cloud.fileName}.md`, contentType: "text/markdown", content: cloud.markdown }],
    }
    const folder = mkdtempSync(join(tmpdir(), "tenuvault-report-note-"))
    try {
      const notePath = join(folder, "note.json")
      writeFileSync(notePath, JSON.stringify(note))
      const mail = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", mailScript, "-NotePath", notePath, "-TenantId", fixture.tenantId, "-TenantName", fixture.tenantName], { encoding: "utf8", maxBuffer: 20_000_000 }))
      expect(mail.html).toBe(desktop.email.html)
      expect(`TenuVault: [Warning] ${mail.title}`).toBe(desktop.email.subject)
      expect(mail.attachments).toEqual([`${desktop.fileName}.html`, `${desktop.fileName}.md`])
      // A note from another tenant, or with an unexpected attachment, is refused.
      writeFileSync(notePath, JSON.stringify({ ...note, tenantId: "11111111-1111-1111-1111-111111111111" }))
      expect(() => execFileSync(pwsh!, ["-NoProfile", "-File", mailScript, "-NotePath", notePath, "-TenantId", fixture.tenantId], { encoding: "utf8", stdio: "pipe" })).toThrow(/refused/)
      writeFileSync(notePath, JSON.stringify({ ...note, files: [{ name: "payload.exe", contentType: "text/html", content: "x" }] }))
      expect(() => execFileSync(pwsh!, ["-NoProfile", "-File", mailScript, "-NotePath", notePath, "-TenantId", fixture.tenantId], { encoding: "utf8", stdio: "pipe" })).toThrow(/refused/)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }, 60_000)

  it("leaves the report next to the result notes after a backup, compared with the previous complete plain backup", () => {
    const run = runReport()
    // Storage and Graph are only read (GET), and the report is the one write.
    expect(run.methods).toEqual(["Get", "Put"])
    expect(run.writes).toHaveLength(1)
    const [write] = run.writes
    expect(write!.uri).toBe("https://tvteststore.blob.core.windows.net/tenuvault-backup-results/cloud-change-reports/backup-2026-11-06-020000.json")
    expect(write!.headers["If-None-Match"]).toBe("*")
    expect(write!.contentType).toBe("application/json; charset=utf-8")
    const note = JSON.parse(write!.body)
    expect(note).toMatchObject({ schema: "tenuvault.cloud-change-report/v1", tenantId: fixture.tenantId, runId: "run-1", backupFolder: "backup-2026-11-06-020000" })
    // The newest earlier backup is sealed, and the backups in between completed with warnings,
    // record failures or no completed status, belong to another tenant, name no tenant or an
    // invalid one: all skipped. The one whose marker names another tenant is skipped unread.
    expect(note.email.details[0]).toEqual({ label: "From backup", value: "backup-2026-11-05-020000" })
    expect(run.output).toContain("Skipped 1 newer backup(s) sealed before plain Azure backups: TenuVault in Azure cannot open them. Comparing with backup-2026-11-05-020000.")
    expect(manifestReads(run)).toEqual(["backup-2026-11-05-220000", "backup-2026-11-05-210000", "backup-2026-11-05-200000", "backup-2026-11-05-180000", "backup-2026-11-05-120000", "backup-2026-11-05-115000", "backup-2026-11-05-110000", "backup-2026-11-05-020000"])
    expect(note.files.map((file: { name: string }) => file.name)).toEqual(["change-report-contoso-m-ller-co-2026-11-06.html", "change-report-contoso-m-ller-co-2026-11-06.md"])
    expect(write!.body).not.toMatch(/hunter2|old-key|new-key|old-secret|new-secret/)
    // Setting names come from Graph, read one definition at a time.
    expect(note.files[1].content).toContain("| Allow Cloud Protection | Allowed. Turns on Cloud Protection. | Not allowed. Turns off Cloud Protection. |")
    // Read past the empty first audit page Graph answers with: the changes still have actors.
    expect(run.output.join("\n")).toContain("Left a change report for the notification watcher: 8 changed, 2 added, 1 deleted; 4 of 11 with matching audit events.")
  }, 60_000)

  it("accepts an earlier backup recorded as Succeeded with no failures, like the app's status normalizer", () => {
    const run = runReport("succeeded")
    expect(JSON.parse(run.writes[0]!.body).email.details[0]).toEqual({ label: "From backup", value: "backup-2026-11-05-100000" })
  }, 60_000)

  it("skips a backup whose manifest is over 32 MiB with a line in the output, and notes an oversized policy file", () => {
    const run = runReport("oversized")
    expect(run.output[0]).toBe("Skipped backup-2026-11-05-230000: metadata.json is larger than the 32 MiB TenuVault reads.")
    const note = JSON.parse(run.writes[0]!.body)
    expect(note.email.details[0]).toEqual({ label: "From backup", value: "backup-2026-11-05-020000" })
    expect(note.files[1].content).toContain("DeviceConfigurations/Wi-Fi.json \\(backup-2026-11-05-020000\\): Wi-Fi.json is larger than the 32 MiB TenuVault reads.")
  }, 120_000)

  it("counts a body that misses the read deadline as a failed read: the backup is skipped, the file not compared", () => {
    const run = runReport("stalled")
    expect(run.output[0]).toBe("Skipped backup-2026-11-05-230000: metadata.json did not arrive within 90 seconds.")
    const note = JSON.parse(run.writes[0]!.body)
    expect(note.email.details[0]).toEqual({ label: "From backup", value: "backup-2026-11-05-020000" })
    expect(note.files[1].content).toContain("DeviceConfigurations/Wi-Fi.json \\(backup-2026-11-05-020000\\): Wi-Fi.json did not arrive within 90 seconds.")
  }, 60_000)

  it("finds this tenant's previous backup past other tenants' folders without reading their manifests", () => {
    const run = runReport("crowded")
    expect(JSON.parse(run.writes[0]!.body).email.details[0]).toEqual({ label: "From backup", value: "backup-2026-11-05-020000" })
    expect(manifestReads(run).some((name) => /^backup-2026-11-05-03\d{4}$/.test(name!))).toBe(false)
    expect(run.reads.filter((uri) => uri.endsWith("/.tenuvault-owner.json")).length).toBeGreaterThanOrEqual(40)
  }, 60_000)

  it("never makes the report step throw, whatever storage does", () => {
    const run = runReport("throws")
    expect(run.output).toEqual(["No change report was made: storage is unavailable"])
    expect(run.writes).toHaveLength(0)
  }, 60_000)

  it("stops reading a response at the cap, by declared length and by bytes read, and at the body deadline", () => {
    const read = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", cappedScript], { encoding: "utf8", timeout: 60_000 }))
    expect(read).toMatchObject({ declared: "oversized", chunked: "oversized", small: "read 100", stall: "timed out" })
    // A body that stops mid-way ends at the 1 second deadline, long before the server gives up.
    expect(read.stallSeconds).toBeLessThan(4)
    // Error bodies go through the same reader with a 64 KiB cap: an 8 MiB one and a stalled one
    // both end as the HTTP error, quickly.
    expect(read).toMatchObject({ errorlarge: "http 403", errorstall: "http 403" })
    expect(read.errorlargeSeconds).toBeLessThan(4)
    expect(read.errorstallSeconds).toBeLessThan(2.5)
    expect(readFileSync(new URL("../resources/runbooks/Invoke-TenuVaultBackup.ps1", import.meta.url), "utf8")).toContain(`$script:MaxBlobBytes = ${MAX_BACKUP_ARCHIVE_BYTES}`)
  }, 60_000)

  it("makes no report when no earlier complete plain backup of the tenant exists, and says why", () => {
    const run = runReport("nopredecessor")
    expect(run.writes).toHaveLength(0)
    expect(run.output).toEqual(["No earlier complete plain backup of this tenant to compare with (2 earlier backup(s) sealed before plain Azure backups were skipped: TenuVault in Azure cannot open them), so no change report was made."])
  }, 60_000)

  it("leaves values out at the names level", () => {
    const run = runReport("default", "names")
    const markdown = JSON.parse(run.writes[0]!.body).files[1].content as string
    expect(markdown).toContain("Setting values are left out of this report.")
    expect(markdown).not.toContain("10.0.22631")
  }, 60_000)

  it("watcher sends waiting reports with both files attached, deletes them once sent, and drops old or invalid ones", () => {
    const cloud = cloudReport({ values: true, actors: true })
    const note = (createdAt: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      schema: "tenuvault.cloud-change-report/v1", tenantId: fixture.tenantId, runId: "run-1", backupFolder: fixture.newer.name, createdAt, changes: 9,
      email: cloud.email, files: [{ name: `${cloud.fileName}.html`, contentType: "text/html", content: cloud.html }, { name: `${cloud.fileName}.md`, contentType: "text/markdown", content: cloud.markdown }], ...extra,
    })
    const folder = mkdtempSync(join(tmpdir(), "tenuvault-report-notes-"))
    try {
      const notesPath = join(folder, "notes.json")
      writeFileSync(notesPath, JSON.stringify({
        "backup-2026-11-06-020000.json": note("2026-11-06T02:14:00.000Z"),
        "backup-2026-10-20-020000.json": note("2026-10-20T02:14:00.000Z"),
        "backup-2026-11-05-020000.json": note("2026-11-05T02:14:00.000Z", { tenantId: "11111111-1111-1111-1111-111111111111" }),
      }))
      const run = (mailEnabled: boolean, failMail = false) => JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", deliverScript, "-NotesPath", notesPath, "-TenantId", fixture.tenantId, "-MailEnabled", String(mailEnabled), "-FailMail", String(failMail)], { encoding: "utf8", maxBuffer: 20_000_000 }))
      const sent = run(true)
      expect(sent.result).toMatchObject({ Sent: 1, Expired: 1, Ignored: 1, Waiting: 0 })
      // A report dropped because it expired is never silent.
      expect(sent.result.Error).toBe("1 change report(s) were deleted unsent because they were older than 7 days (they waited for verified mail or for room in the watcher state). 1 change report(s) were deleted unsent because they are not valid for this watcher (1 refused by the report checks).")
      expect(sent.result.Messages).toContain("1 change report(s) were deleted unsent because they are not valid for this watcher (1 refused by the report checks).")
      expect(sent.deleted.sort()).toEqual(["cloud-change-reports/backup-2026-10-20-020000.json", "cloud-change-reports/backup-2026-11-05-020000.json", "cloud-change-reports/backup-2026-11-06-020000.json"])
      expect(sent.mails).toHaveLength(1)
      expect(sent.mails[0]).toMatchObject({ from: "reports@contoso.example", to: ["security@contoso.example", "auditor@fabrikam.example"], attachments: [`${cloud.fileName}.html`, `${cloud.fileName}.md`] })
      // Without verified mail the report waits; a failed send keeps it for the next run.
      const waiting = run(false)
      expect(waiting.result).toMatchObject({ Sent: 0, Waiting: 1 })
      expect(waiting.deleted).not.toContain("cloud-change-reports/backup-2026-11-06-020000.json")
      const failed = run(true, true)
      expect(failed.result.Error).toMatch(/403/)
      expect(failed.deleted).not.toContain("cloud-change-reports/backup-2026-11-06-020000.json")
      // Graph accepts the mail but the delete fails, twice: the report is mailed once, the
      // delivered name is kept in the watcher state, and both runs name the failed cleanup.
      const statePath = join(folder, "state.json")
      const runWithState = (failDelete: boolean) => JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", deliverScript, "-NotesPath", notesPath, "-TenantId", fixture.tenantId, "-StatePath", statePath, "-FailDelete", String(failDelete)], { encoding: "utf8", maxBuffer: 20_000_000 }))
      const first = runWithState(true)
      expect(first.mails).toHaveLength(1)
      expect(first.result.Sent).toBe(1)
      expect(first.result.Error).toMatch(/Could not remove the change report cloud-change-reports\/backup-2026-11-06-020000\.json: .*403.*It was sent and is not sent again/)
      expect(first.delivered).toEqual(["cloud-change-reports/backup-2026-11-06-020000.json"])
      const second = runWithState(true)
      expect(second.mails).toHaveLength(0)
      expect(second.result.Sent).toBe(0)
      expect(second.result.Error).toMatch(/Could not remove the change report cloud-change-reports\/backup-2026-11-06-020000\.json/)
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(["cloud-change-reports/backup-2026-11-06-020000.json"])
      // Once the delete works, the note goes, nothing is sent again and the state forgets it.
      const third = runWithState(false)
      expect(third.mails).toHaveLength(0)
      expect(third.deleted).toContain("cloud-change-reports/backup-2026-11-06-020000.json")
      expect(third.result.Error).toMatch(/^1 change report\(s\) were deleted unsent because they were older than 7 days/)
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual([])

      // The lease is lost between the download and the send (renewals: list, item, before send):
      // nothing is sent or deleted, and the run stops with the lease error.
      const single = join(folder, "single.json")
      writeFileSync(single, JSON.stringify({ "backup-2026-11-06-020000.json": note("2026-11-06T02:14:00.000Z") }))
      const leaseLost = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", deliverScript, "-NotesPath", single, "-TenantId", fixture.tenantId, "-LeaseFailAt", "3"], { encoding: "utf8", maxBuffer: 20_000_000 }))
      expect(leaseLost.downloads).toBe(1)
      expect(leaseLost.mails).toHaveLength(0)
      expect(leaseLost.deleted).toEqual([])
      expect(leaseLost.thrown).toMatch(/Failed to renew the state lease/)
      // A state that cannot be saved after a send stops the run too, after one last delete.
      const saveLost = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", deliverScript, "-NotesPath", single, "-TenantId", fixture.tenantId, "-FailSave", "true"], { encoding: "utf8", maxBuffer: 20_000_000 }))
      expect(saveLost.mails).toHaveLength(1)
      expect(saveLost.deleted).toEqual(["cloud-change-reports/backup-2026-11-06-020000.json"])
      expect(saveLost.thrown).toMatch(/state lease was lost/)
      // At least once: when the state save and the fallback delete both fail after Graph took the
      // mail, the run says the report may be sent again, and the next run sends it once more.
      const bothFail = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", deliverScript, "-NotesPath", single, "-TenantId", fixture.tenantId, "-FailSave", "true", "-FailDelete", "true"], { encoding: "utf8", maxBuffer: 20_000_000 }))
      expect(bothFail.mails).toHaveLength(1)
      expect(bothFail.thrown).toMatch(/was sent but could neither be recorded in the watcher state nor deleted, so the next run may send it once more/)
      const nextRun = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", deliverScript, "-NotesPath", single, "-TenantId", fixture.tenantId, "-StatePath", join(folder, "fresh-state.json")], { encoding: "utf8", maxBuffer: 20_000_000 }))
      expect(nextRun.mails.length).toBeLessThanOrEqual(1)
      expect(nextRun.deleted).toEqual(["cloud-change-reports/backup-2026-11-06-020000.json"])
      expect(nextRun.thrown).toBeNull()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }, 60_000)

  it("never sends a report twice when more sent reports than the state keeps cannot be deleted", () => {
    const cloud = cloudReport({ values: false, actors: false })
    const notes: Record<string, string> = {}
    for (let i = 0; i < 201; i++) {
      const name = `backup-2026-11-05-${String(10 + Math.floor(i / 60)).padStart(2, "0")}${String(i % 60).padStart(2, "0")}00`
      notes[`${name}.json`] = JSON.stringify({ schema: "tenuvault.cloud-change-report/v1", tenantId: fixture.tenantId, runId: `run-${i}`, backupFolder: name, createdAt: "2026-11-06T02:14:00.000Z", changes: 1, email: cloud.email, files: [] })
    }
    const folder = mkdtempSync(join(tmpdir(), "tenuvault-report-backlog-"))
    try {
      const notesPath = join(folder, "notes.json")
      const statePath = join(folder, "state.json")
      writeFileSync(notesPath, JSON.stringify(notes))
      const run = () => JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", deliverScript, "-NotesPath", notesPath, "-TenantId", fixture.tenantId, "-StatePath", statePath, "-FailDelete", "true"], { encoding: "utf8", maxBuffer: 50_000_000 }))
      const first = run()
      expect(first.mails).toHaveLength(200)
      expect(first.result).toMatchObject({ Sent: 200, Held: 1 })
      expect(first.delivered).toHaveLength(200)
      const second = run()
      // The 200 sent ones are only retried for deletion; the one held back still waits.
      expect(second.mails).toHaveLength(0)
      expect(second.result).toMatchObject({ Sent: 0, Held: 1 })
      expect(second.delivered).toEqual(first.delivered)
      // The backlog is the run's error, so the heartbeat shows it.
      expect(second.result.Error).toContain("1 change report(s) wait: 200 sent report(s) could not be deleted yet")
      // The watcher state keeps every delivered name whose note still exists: it is never trimmed.
      const watcher = readFileSync(new URL("../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1", import.meta.url), "utf8")
      expect(watcher).toContain("deliveredReports = @($deliveredReports.ToArray())")
      expect(watcher).not.toMatch(/deliveredReports\.ToArray\(\) \| Select-Object/)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }, 180_000)

  it("warns when a report held at the state limit expires and is deleted unsent", () => {
    const cloud = cloudReport({ values: false, actors: false })
    const notes: Record<string, string> = {}
    const delivered: string[] = []
    for (let i = 0; i < 200; i++) {
      const name = `backup-2026-11-05-${String(10 + Math.floor(i / 60)).padStart(2, "0")}${String(i % 60).padStart(2, "0")}00`
      notes[`${name}.json`] = JSON.stringify({ schema: "tenuvault.cloud-change-report/v1", tenantId: fixture.tenantId, runId: `run-${i}`, backupFolder: name, createdAt: "2026-11-06T02:14:00.000Z", changes: 1, email: cloud.email, files: [] })
      delivered.push(`cloud-change-reports/${name}.json`)
    }
    // Held while the state was full, and now past its original 7 day expiry.
    notes["backup-2026-10-20-020000.json"] = JSON.stringify({ schema: "tenuvault.cloud-change-report/v1", tenantId: fixture.tenantId, runId: "run-old", backupFolder: "backup-2026-10-20-020000", createdAt: "2026-10-20T02:14:00.000Z", changes: 1, email: cloud.email, files: [] })
    const folder = mkdtempSync(join(tmpdir(), "tenuvault-report-expired-"))
    try {
      const notesPath = join(folder, "notes.json")
      const statePath = join(folder, "state.json")
      writeFileSync(notesPath, JSON.stringify(notes))
      writeFileSync(statePath, JSON.stringify(delivered))
      const run = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", deliverScript, "-NotesPath", notesPath, "-TenantId", fixture.tenantId, "-StatePath", statePath], { encoding: "utf8", maxBuffer: 50_000_000 }))
      expect(run.mails).toHaveLength(0)
      expect(run.deleted).toHaveLength(201)
      expect(run.result.Expired).toBe(1)
      expect(run.result.Error).toBe("1 change report(s) were deleted unsent because they were older than 7 days (they waited for verified mail or for room in the watcher state).")
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }, 180_000)

  it("clips long tenant and policy names in the email fields so the watcher accepts the report", () => {
    const cloud = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", script, "-FixturePath", fixturePath, "-LongNames", "true"], { encoding: "utf8", maxBuffer: 20_000_000 })) as { email: { title: string; items: Array<{ title: string }> } }
    expect(cloud.email.title.length).toBe(400)
    expect(cloud.email.title.endsWith("...")).toBe(true)
    expect(Math.max(...cloud.email.items.map((item) => item.title.length))).toBe(600)
    const folder = mkdtempSync(join(tmpdir(), "tenuvault-report-long-"))
    try {
      const notePath = join(folder, "note.json")
      writeFileSync(notePath, JSON.stringify({ schema: "tenuvault.cloud-change-report/v1", tenantId: fixture.tenantId, runId: "run-1", backupFolder: fixture.newer.name, createdAt: fixture.generatedAt, changes: 1, email: cloud.email, files: [] }))
      // Not refused: the mail fixture throws on a refused note.
      const mail = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", mailScript, "-NotePath", notePath, "-TenantId", fixture.tenantId], { encoding: "utf8", maxBuffer: 20_000_000 }))
      expect(mail.title).toMatch(/^Changes in Contoso Contoso/)
      expect(mail.html).toContain("Policy Policy")
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }, 60_000)

  it("counts a note that is valid JSON but not a report as refused by the report checks", () => {
    const folder = mkdtempSync(join(tmpdir(), "tenuvault-report-null-"))
    try {
      const notesPath = join(folder, "notes.json")
      writeFileSync(notesPath, JSON.stringify({ "backup-2026-11-06-020000.json": "null" }))
      const out = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", deliverScript, "-NotesPath", notesPath, "-TenantId", fixture.tenantId], { encoding: "utf8", maxBuffer: 20_000_000 })) as { result: { Ignored: number; Messages: string[]; Error: string | null }; mails: unknown[]; deleted: string[] }
      expect(out.result.Ignored).toBe(1)
      expect(out.mails).toHaveLength(0)
      expect(out.deleted).toEqual(["cloud-change-reports/backup-2026-11-06-020000.json"])
      const message = out.result.Messages.find((line) => line.includes("refused by the report checks"))
      expect(message).toBeDefined()
      expect(message).not.toContain("()")
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }, 60_000)

  it("never cuts an email field or the saved tenant name between the halves of an emoji", () => {
    const runbook = fileURLToPath(new URL("../resources/runbooks/Invoke-TenuVaultBackup.ps1", import.meta.url))
    const setupScript = readFileSync(fileURLToPath(new URL("../resources/New-TenuVaultCloudBackup.ps1", import.meta.url)), "utf8")
    // The setup's tenant name clipping, run on its own with a name whose 200th character starts an emoji.
    const clip = /    if \(\$savedName\.Length -gt 200\) \{[\s\S]*?\n    \}\n/.exec(setupScript)![0]
    const command = [
      `. '${runbook.replace(/'/g, "''")}' -LibraryOnly`,
      `$emoji = [char]::ConvertFromUtf32(0x1F600)`,
      // 596 ASCII characters, then an emoji across the 597th and 598th units: a cut at 597 would split it.
      `$email = Get-TvEmailText -Text (('a' * 596) + $emoji + ('b' * 50)) -Max 600`,
      `$savedName = ('c' * 199) + $emoji + ('d' * 50)`,
      clip,
      `[Console]::Out.Write((ConvertTo-Json -Compress @{ email = $email; name = $savedName }))`,
    ].join("\n")
    const out = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-Command", command], { encoding: "utf8" })) as { email: string; name: string }
    const whole = (text: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
    expect(out.email).toBe("a".repeat(596) + "...")
    expect(whole(out.email)).toBe(true)
    expect(out.name).toBe("c".repeat(199))
    expect(whole(out.name)).toBe(true)
  }, 60_000)

  it("covers the cases that matter in the fixture", async () => {
    const { report, html } = await desktopReport({ values: true, actors: true })
    const json = JSON.stringify(report)
    expect(json).not.toMatch(/hunter2|old-key|new-key|old-secret|new-secret/)
    expect(report.items.find((item) => item.name === "WIN - Defender")!.settings.map((setting) => setting.name)).toContain("Allow Cloud Protection")
    expect(report.items.find((item) => item.name === "Wi-Fi")!.settings.map((setting) => setting.name)).toContain("Secret values")
    expect(report.items.find((item) => item.name === "Windows 11 - Compliance")).toMatchObject({ previousName: "Win11 Compliance" })
    expect(report.items.find((item) => item.name === "macOS - FileVault")!.activity[0]).toMatchObject({ who: "alex@contoso.example" })
    // A live-shaped event (activity null, the operation in activityType) reads as its activityType.
    expect(report.items.find((item) => item.name === "APP - Android")!.activity[0]).toMatchObject({ who: "sam@contoso.example", activity: "Patch AndroidManagedAppProtection" })
    expect(report.otherActivity).toHaveLength(1)
    // Unkeyed and app lists are matched like the desktop: an inserted app, an exclusion inserted
    // before an unchanged assignment, and a removed app are reported as themselves; a reorder
    // (with new item IDs) is not a change.
    const android = report.items.find((item) => item.name === "APP - Android")!
    expect(android.settings.map((setting) => [setting.name, setting.before, setting.after])).toEqual([
      ["Allowed data storage locations: box", "Not set", "box"],
      ["Apps: com.microsoft.teams", "com.microsoft.teams", "Not set"],
      ["Apps: com.microsoft.emmx", "Not set", "com.microsoft.emmx"],
      ["Assignments (item 1)", "Not set", "Excluded group bbbbbbbb-2222-4222-8222-222222222222"],
    ])
    expect(report.items.find((item) => item.name === "APP - iOS")!.settings.map((setting) => setting.name)).toEqual(["PIN required"])
    expect(html).not.toContain("<script>alert")
  })
})

describe("cloud change report setup", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

  it("is opt-in in the setup script and the template, per tenant", () => {
    const setup = read("../resources/New-TenuVaultCloudBackup.ps1")
    expect(setup).toContain('[ValidateSet("Off", "Names", "Full")][string]$ChangeReport = "Off"')
    expect(setup).toContain('Set-TenuVaultAutomationVariable -Name "TenuVaultChangeReport-$tenantKey" -Value $ChangeReport.ToLowerInvariant()')
    expect(setup).toContain('"TenuVaultChangeReport-$tenantKey", "TenuVaultChangeReportActors-$tenantKey"')
    const template = JSON.parse(read("../resources/cloud-backup/azuredeploy.json")) as { parameters: Record<string, { defaultValue?: unknown; allowedValues?: unknown }> }
    expect(template.parameters.changeReport).toMatchObject({ defaultValue: "off", allowedValues: ["off", "names", "full"] })
    expect(template.parameters.changeReportActors).toMatchObject({ defaultValue: true })
    // Reports name the tenant, so the name is stored with the cloud backup's own variables.
    expect(setup).toContain('Set-TenuVaultAutomationVariable -Name "TenuVaultTenantName-$tenantKey" -Value $savedName')
    expect(template.parameters.tenantName).toMatchObject({ maxLength: 200 })
    expect(setup).toContain('"TenuVaultTenantName-$tenantKey"')
    expect(template.parameters.tenantName).toMatchObject({ defaultValue: "" })
  })

  it("lets the watcher send reports to their own recipients", () => {
    const setup = read("../resources/New-TenuVaultNotificationWatcher.ps1")
    expect(setup).toContain("[string[]]$ReportRecipients")
    expect(setup).toContain('Set-TenuVaultAutomationVariable -Name "TenuVaultReportRecipients"')
    const watcher = read("../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1")
    expect(watcher).toContain('Get-TvAutomationVariable "TenuVaultReportRecipients"')
    // Report recipients alone are enough: delivery does not wait for the alert recipients.
    expect(watcher).toContain("-MailEnabled ([bool]($mailSender -and $reportTo -and $senderVerified))")
    expect(setup).toContain("(-not $MailRecipients -and -not $ReportRecipients)")
    expect([...watcher].every((char) => char.codePointAt(0)! <= 0x7f)).toBe(true)
  })

  it("keeps the backup runbook read-only towards Graph, with no key to open sealed backups", () => {
    const runbook = read("../resources/runbooks/Invoke-TenuVaultBackup.ps1")
    expect(runbook).not.toMatch(/Method\s+"(Delete|Post|Patch)"/)
    expect(runbook).toContain('$script:ReportPrefix = "cloud-change-reports/"')
    expect(runbook).not.toMatch(/AesGcm|Decrypt\(|KeyVault\/|vault\.azure\.net|RecoveryMasterKey/)
    expect([...runbook].every((char) => char.codePointAt(0)! <= 0x7f)).toBe(true)
  })
})
