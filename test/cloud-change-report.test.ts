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
import type { DriftResult } from "../src/shared/intune/drift"
import { readFileSync } from "node:fs"
import fixture from "./fixtures/reports/cloud-backups.json"

const pwsh = ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh", ...(process.env.HOME ? [`${process.env.HOME}/.local/bin/pwsh`] : [])].find((candidate) => existsSync(candidate))
const fixturePath = fileURLToPath(new URL("./fixtures/reports/cloud-backups.json", import.meta.url))
const script = fileURLToPath(new URL("./fixtures/reports/cloud-report.ps1", import.meta.url))
const mailScript = fileURLToPath(new URL("./fixtures/reports/cloud-report-mail.ps1", import.meta.url))
const runScript = fileURLToPath(new URL("./fixtures/reports/cloud-report-run.ps1", import.meta.url))
const deliverScript = fileURLToPath(new URL("./fixtures/reports/cloud-report-deliver.ps1", import.meta.url))

type Backup = { name: string; metadata: unknown; files: Record<string, unknown> }
const backups: Backup[] = [fixture.older as Backup, fixture.newer as Backup]
const definitions = fixture.definitions as Record<string, unknown>

afterEach(() => vi.unstubAllGlobals())

/** The desktop app's report of the fixture: the drift route over storage and Graph fakes, then the report code. */
async function desktopReport(options: { values: boolean; actors: boolean }) {
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
  const report = buildChangeReport(drift, { changes, note: null }, { tenantId: fixture.tenantId, tenantName: fixture.tenantName, generatedAt: fixture.generatedAt, trigger: "scheduled", includeValues: options.values, includeActors: options.actors })
  return { report, markdown: changeReportMarkdown(report), html: buildChangeReportDocument(report).html, email: reportEmail({ report }, null, "azure-watcher"), fileName: reportFileName(report) }
}

function cloudReport(options: { values: boolean; actors: boolean }) {
  const output = execFileSync(pwsh!, ["-NoProfile", "-File", script, "-FixturePath", fixturePath, "-Level", options.values ? "full" : "names", "-Actors", String(options.actors)], { encoding: "utf8", maxBuffer: 20_000_000 })
  return JSON.parse(output) as { report: unknown; markdown: string; html: string; email: Record<string, unknown>; fileName: string }
}

describe.runIf(Boolean(pwsh))("cloud change reports match the desktop app", () => {
  for (const options of [{ values: true, actors: true }, { values: false, actors: false }]) {
    it(`builds the same report, Markdown and HTML (${options.values ? "with values" : "names only"})`, async () => {
      const desktop = await desktopReport(options)
      const cloud = cloudReport(options)
      expect(cloud.report).toEqual(JSON.parse(JSON.stringify(desktop.report)))
      expect(cloud.markdown).toBe(desktop.markdown)
      expect(cloud.html).toBe(desktop.html)
      expect(cloud.fileName).toBe(desktop.fileName)
    }, 60_000)
  }

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
    const run = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", runScript, "-FixturePath", fixturePath], { encoding: "utf8", maxBuffer: 20_000_000 })) as { output: string[]; methods: string[]; writes: Array<{ uri: string; contentType: string; headers: Record<string, string>; body: string }> }
    // Storage and Graph are only read, and the report is the one write.
    expect(run.methods).toEqual(["Get", "Put"])
    expect(run.writes).toHaveLength(1)
    const [write] = run.writes
    expect(write!.uri).toBe("https://tvteststore.blob.core.windows.net/tenuvault-backup-results/cloud-change-reports/backup-2026-11-06-020000.json")
    expect(write!.headers["If-None-Match"]).toBe("*")
    expect(write!.contentType).toBe("application/json; charset=utf-8")
    const note = JSON.parse(write!.body)
    expect(note).toMatchObject({ schema: "tenuvault.cloud-change-report/v1", tenantId: fixture.tenantId, runId: "run-1", backupFolder: "backup-2026-11-06-020000" })
    // The newest earlier backup is sealed, and the backups in between completed with warnings,
    // belong to another tenant, name no tenant or an invalid one: all skipped.
    expect(note.email.details[0]).toEqual({ label: "From backup", value: "backup-2026-11-05-020000" })
    expect(run.output).toContain("Skipped 1 newer backup(s) sealed before plain Azure backups: TenuVault in Azure cannot open them. Comparing with backup-2026-11-05-020000.")
    expect(note.files.map((file: { name: string }) => file.name)).toEqual(["change-report-contoso-m-ller-co-2026-11-06.html", "change-report-contoso-m-ller-co-2026-11-06.md"])
    expect(write!.body).not.toMatch(/hunter2|old-key|new-key|old-secret|new-secret/)
    // Setting names come from Graph, read one definition at a time.
    expect(note.files[1].content).toContain("| Allow Cloud Protection | Allowed. Turns on Cloud Protection. | Not allowed. Turns off Cloud Protection. |")
    // Read past the empty first audit page Graph answers with: the changes still have actors.
    expect(run.output.join("\n")).toContain("Left a change report for the notification watcher: 6 changed, 2 added, 1 deleted; 3 of 9 with matching audit events.")
  }, 60_000)

  it("makes no report when no earlier complete plain backup of the tenant exists, and says why", () => {
    const run = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", runScript, "-FixturePath", fixturePath, "-Scenario", "nopredecessor"], { encoding: "utf8", maxBuffer: 20_000_000 })) as { output: string[]; writes: unknown[] }
    expect(run.writes).toHaveLength(0)
    expect(run.output).toEqual(["No earlier complete plain backup of this tenant to compare with (2 earlier backup(s) sealed before plain Azure backups were skipped: TenuVault in Azure cannot open them), so no change report was made."])
  }, 60_000)

  it("leaves values out at the names level", () => {
    const run = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", runScript, "-FixturePath", fixturePath, "-Level", "names"], { encoding: "utf8", maxBuffer: 20_000_000 })) as { writes: Array<{ body: string }> }
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
      expect(sent.result).toMatchObject({ Sent: 1, Expired: 1, Ignored: 1, Waiting: 0, Error: null })
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
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }, 60_000)

  it("covers the cases that matter in the fixture", async () => {
    const { report, html } = await desktopReport({ values: true, actors: true })
    const json = JSON.stringify(report)
    expect(json).not.toMatch(/hunter2|old-key|new-key|old-secret|new-secret/)
    expect(report.items.find((item) => item.name === "WIN - Defender")!.settings.map((setting) => setting.name)).toContain("Allow Cloud Protection")
    expect(report.items.find((item) => item.name === "Wi-Fi")!.settings.map((setting) => setting.name)).toContain("Secret values")
    expect(report.items.find((item) => item.name === "Windows 11 - Compliance")).toMatchObject({ previousName: "Win11 Compliance" })
    expect(report.items.find((item) => item.name === "macOS - FileVault")!.activity[0]).toMatchObject({ who: "alex@contoso.example" })
    expect(report.otherActivity).toHaveLength(1)
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
    expect(setup).toContain('Set-TenuVaultAutomationVariable -Name "TenuVaultTenantName-$tenantKey" -Value $TenantName.Trim()')
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
