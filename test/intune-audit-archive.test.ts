import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { archiveIntuneAudit } from "../src/main/backup/audit-archive"
import { GraphSession } from "../src/main/backup/graph-session"
import { NetworkCircuit } from "../src/main/backup/engine"
import { AUDIT_ARCHIVE_FILE } from "../src/shared/intune/audit-archive"

const pwsh = ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh", `${process.env.HOME}/.local/bin/pwsh`].find(existsSync)
const started = "2026-11-23T12:00:00.000Z"
const tenant = "11111111-2222-3333-4444-555555555555"
const current = "backup-2026-11-23-120000"
const previous = "backup-2026-11-23-115900"
const earlier = "backup-2026-11-23-115800"
const other = "backup-2026-11-23-115930"
const from = "2026-11-23T11:49:00.000Z"
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
  [`${earlier}/${AUDIT_ARCHIVE_FILE}`]: { window: olderWindow, value: [alreadySaved] },
}
const folders = [earlier, current, previous, other]
const fixture = { started, tenant, current, folders, files, pages }

async function runDesktop(retry: boolean) {
  const reads: string[] = []
  const attempts: string[] = []
  const graph = new GraphSession((async (url: string) => {
    attempts.push(url)
    if (retry && attempts.length === 1) return new Response(null, { status: 429, headers: { "retry-after": "0" } })
    return Response.json(pages[reads.push(url) - 1])
  }) as typeof fetch, async () => "token", new NetworkCircuit(5))
  const put = vi.fn()
  const window = await archiveIntuneAudit({
    list: async () => ({ blobs: [], prefixes: folders.map((folder) => `${folder}/`) }),
    readJson: async (name) => files[name] ?? null,
    put,
  }, graph, tenant, current, new Date(started))
  const [name, body] = put.mock.calls[0]!
  return { result: { window, reads, archive: { name, body: JSON.parse(body) } }, attempts }
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
    const script = fileURLToPath(new URL("./fixtures/cloud-backup/audit-archive.ps1", import.meta.url))
    const output = execFileSync(pwsh!, ["-NoProfile", "-File", script], { input: JSON.stringify(fixture), encoding: "utf8", timeout: 15_000 })
    const cloud = JSON.parse(output)
    const { result: desktop } = await runDesktop(false)
    expect(new URL(cloud.reads[0]).searchParams.toString()).toBe(new URL(desktop.reads[0]!).searchParams.toString())
    expect(cloud.reads.slice(1)).toEqual(desktop.reads.slice(1))
    expect(cloud.window).toEqual(desktop.window)
    expect(cloud.archive).toEqual(desktop.archive)
  }, 30_000)
})
