import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { archiveIntuneAudit } from "../src/main/backup/audit-archive"
import { GraphSession } from "../src/main/backup/graph-session"
import { RequestTimeoutError } from "../src/main/backup/request"
import { NetworkCircuit } from "../src/main/backup/engine"
import { AUDIT_ARCHIVE_FILE } from "../src/shared/intune/audit-archive"

const pwsh = ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh", `${process.env.HOME}/.local/bin/pwsh`].find(existsSync)
const started = "2026-11-23T12:00:00.000Z"
const tenant = "11111111-2222-3333-4444-555555555555"
const current = "backup-2026-11-23-120000"
const previous = "backup-2026-11-23-115900"
const earlier = "backup-2026-11-23-115800"
const other = "backup-2026-11-23-115930"
const from = "2026-11-23T11:29:00.000Z"
const next = "https://graph.microsoft.com/beta/deviceManagement/auditEvents?$skiptoken=page2"
const event = (id: string, activityDateTime: string) => ({ id, activityDateTime, actor: { applicationDisplayName: "Contoso IT" }, resources: [{ modifiedProperties: [{ oldValue: null, newValue: "updated" }] }] })
const alreadySaved = event("saved", "2026-11-23T11:57:00Z")
const late = event("late", "2026-11-23T11:53:00Z")
const fresh = event("fresh", "2026-11-23T11:59:30Z")
const pages = [{ value: [alreadySaved, late], "@odata.nextLink": next }, { value: [late, fresh] }]
const olderWindow = { from: "2025-11-23T11:58:00.000Z", to: "2026-11-23T11:58:00.000Z", count: 1 }
const files: Record<string, Record<string, unknown>> = {
  [`${other}/metadata.json`]: { TenantId: "other", AuditArchive: { ...olderWindow, to: started } },
  [`${previous}/metadata.json`]: { TenantId: tenant, AuditArchive: { from: "2026-11-23T11:48:00.000Z", to: "2026-11-23T11:59:00.000Z", count: 0 } },
  [`${earlier}/metadata.json`]: { TenantId: tenant, AuditArchive: olderWindow },
  [`${previous}/${AUDIT_ARCHIVE_FILE}`]: { window: { from: "2026-11-23T11:48:00.000Z", to: "2026-11-23T11:59:00.000Z", count: 0 }, value: [] },
  [`${earlier}/${AUDIT_ARCHIVE_FILE}`]: { window: olderWindow, value: [alreadySaved] },
}
const folders = [earlier, current, previous, other]
type Page = { value: ReturnType<typeof event>[]; "@odata.nextLink"?: string }
type Fixture = {
  started: string
  tenant: string
  current: string
  folders: string[]
  files: Record<string, Record<string, unknown> | "unreadable">
  pages: (Page | "timeout")[]
  maxBytes?: number
}
const fixture: Fixture = { started, tenant, current, folders, files, pages }

function runCloud(input: Fixture) {
  const script = fileURLToPath(new URL("./fixtures/cloud-backup/audit-archive.ps1", import.meta.url))
  const output = execFileSync(pwsh!, ["-NoProfile", "-File", script], { input: JSON.stringify(input), encoding: "utf8", timeout: 15_000 })
  return JSON.parse(output)
}

async function runDesktop(retry: boolean, input = fixture) {
  const reads: string[] = []
  const attempts: string[] = []
  const notes: string[] = []
  const deadline = new AbortController()
  const graph = new GraphSession((async (url: string) => {
    attempts.push(url)
    if (retry && attempts.length === 1) return new Response(null, { status: 429, headers: { "retry-after": "0" } })
    const page = input.pages[reads.push(url) - 1]
    if (page === "timeout") deadline.abort(new RequestTimeoutError("timed out"))
    deadline.signal.throwIfAborted()
    if (!page) throw new Error("Unexpected Graph request.")
    return Response.json(page)
  }) as typeof fetch, async () => "token", new NetworkCircuit(5, deadline.signal))
  const put = vi.fn()
  const window = await archiveIntuneAudit({
    list: async () => ({ blobs: [], prefixes: input.folders.map((folder) => `${folder}/`) }),
    readJson: async (name) => {
      const data = input.files[name]
      if (data === "unreadable") throw new Error("Unreadable")
      return data ?? null
    },
    put,
  }, graph, input.tenant, input.current, new Date(input.started), { signal: deadline.signal, maxBytes: input.maxBytes, note: message => notes.push(message) })
  const [name, body] = put.mock.calls[0]!
  return { result: { window, reads, notes, archive: { name, body: JSON.parse(body) } }, attempts }
}

describe("Intune audit backup archive", () => {
  it("follows continuations, retries throttling and deduplicates within and across overlapping backups", async () => {
    const { result, attempts } = await runDesktop(true)
    expect(attempts).toEqual([result.reads[0], result.reads[0], next])
    expect(new URL(result.reads[0]!).searchParams.get("$filter")).toBe(`activityDateTime ge ${from} and activityDateTime le ${started}`)
    const window = { from, to: started, count: 2 }
    expect(result).toMatchObject({ window, archive: { name: `${current}/${AUDIT_ARCHIVE_FILE}`, body: { window, value: [late, fresh] } } })
  })

  it.runIf(Boolean(pwsh))("writes the same archive file, window and raw events in PowerShell", async () => {
    const cloud = runCloud(fixture)
    const { result: desktop } = await runDesktop(false)
    expect(new URL(cloud.reads[0]).searchParams.toString()).toBe(new URL(desktop.reads[0]!).searchParams.toString())
    expect(cloud.reads.slice(1)).toEqual(desktop.reads.slice(1))
    expect(cloud.window).toEqual(desktop.window)
    expect(cloud.archive).toEqual(desktop.archive)
  }, 30_000)
})

describe("Intune audit checkpoint recovery", () => {
  function assertParity(desktop: Awaited<ReturnType<typeof runDesktop>>["result"], input: Fixture) {
    if (!pwsh) return
    const cloud = runCloud(input)
    expect(cloud.archive).toEqual(desktop.archive)
    expect(cloud.window).toEqual(desktop.window)
    expect(cloud.notes).toEqual(desktop.notes)
    expect(cloud.reads.map((url: string) => new URL(url).searchParams.toString())).toEqual(desktop.reads.map(url => new URL(url).searchParams.toString()))
  }

  it.each(["deleted", "missing archive", "invalid window", "unreadable metadata"])("uses the earlier checkpoint when the latest backup has %s", async problem => {
    const input = { ...fixture, files: { ...fixture.files } }
    if (problem === "invalid window") input.files[`${previous}/metadata.json`] = { TenantId: tenant, AuditArchive: { ...olderWindow, to: "invalid" } }
    if (problem === "unreadable metadata") input.files[`${previous}/metadata.json`] = "unreadable"
    if (problem === "deleted") input.folders = input.folders.filter(folder => folder !== previous)
    delete input.files[`${previous}/${AUDIT_ARCHIVE_FILE}`]
    const { result } = await runDesktop(false, input)
    expect(result.window).toEqual({ from: "2026-11-23T11:28:00.000Z", to: started, count: 2 })
    expect(result.archive.body.value).toEqual([late, fresh])
    if (problem !== "deleted") expect(result.notes).toEqual([expect.stringContaining(`Skipped ${previous}`)])
    assertParity(result, input)
  }, 25_000)

  it("commits completed slices across size and time limits and finishes on the third backup", async () => {
    const date = (day: number, time: string) => `2026-11-${day}T${time}:00.000Z`
    const folder = (day: number, clock = "120000") => `backup-2026-11-${day}-${clock}`
    const seed = folder(20)
    const window = { from: date(20, "11:00"), to: date(20, "12:00"), count: 0 }
    const history: Fixture["files"] = {
      [`${seed}/metadata.json`]: { TenantId: tenant, AuditArchive: window },
      [`${seed}/${AUDIT_ARCHIVE_FILE}`]: { window, value: [] },
    }
    const first = event("first", date(20, "14:00"))
    const second = { ...event("second", date(21, "14:00")), activity: "x".repeat(500) }
    const third = event("third", date(22, "14:00"))

    async function backup(current: string, started: string, pages: Fixture["pages"], to: string, events: Page["value"]) {
      const input = { ...fixture, files: { ...history }, folders: [...Object.keys(history).filter(key => key.endsWith("/metadata.json")).map(key => key.split("/")[0]!), current], current, started, pages, maxBytes: 1000 }
      const { result } = await runDesktop(false, input)
      expect(result.window.to).toBe(to)
      expect(result.archive.body.value).toEqual(events)
      assertParity(result, input)
      history[`${current}/metadata.json`] = { TenantId: tenant, AuditArchive: result.window }
      history[result.archive.name] = result.archive.body
      return result.window
    }

    await backup(folder(23), date(23, "12:00"), [{ value: [first] }, { value: [second] }], date(21, "11:30"), [first])
    await backup(folder(23, "120100"), date(23, "12:01"), [{ value: [second] }, "timeout"], date(22, "11:00"), [second])
    const finalEnd = date(23, "12:02")
    const final = await backup(folder(23, "120200"), finalEnd, [{ value: [third] }, { value: [] }], finalEnd, [third])
    expect(final.from).toBe(date(22, "10:30"))
  }, 30_000)
})
