import { afterEach, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { POST as detectDrifts } from "../src/portal/app/api/detect-drifts/route"
import { POST as inventoryPage } from "../src/portal/app/api/large-backup-page/route"
import { generateReport } from "../src/main/features/reports"
import { fakeDeps, TENANT_A } from "./feature-helpers"

afterEach(() => vi.unstubAllGlobals())
it.each(["valid", "missing", "mismatch", "incomplete", "invalid"])("reports a mixed run through real drift and bounded index routes with a %s companion", async state => {
  const older = "backup-2026-11-05-020000", newer = "backup-2026-11-06-020000"
  const largeOlder = older.replace("backup-", "backup-large-"), largeNewer = newer.replace("backup-", "backup-large-")
  const manifests = Object.fromEntries([[older, largeOlder], [newer, largeNewer]].flatMap(([id, companion]) => {
    const base = { TenantId: TENANT_A, Status: "Success", Coverage: "Complete", Failures: 0, RunId: id, Items: {} }
    return [
      [id, { ...base, BackupFolder: id, CompanionBackup: state === "invalid" ? "backup-large-../../outside" : companion, LargeBackupOutcomes: [{ Folder: "Users", Outcome: "saved" }], Scope: { Included: [], Excluded: [] } }],
      [companion, { ...base, RunId: state === "mismatch" ? "wrong" : id, BackupFolder: companion, CompanionBackup: id, Scope: { Included: ["Users"], Excluded: [] }, LargeItems: { Users: { version: 1, count: 1001, shards: 2, complete: state !== "incomplete" } } }],
    ]
  }))
  const reads: string[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://tenuvault.internal")
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "test" })
    if (url.pathname === "/api/revert-metadata") return Response.json({ reverts: {} })
    if (url.searchParams.get("delimiter")) return new Response([older, newer].map(id => `<BlobPrefix><Name>${id}/</Name></BlobPrefix>`).join(""))
    if (url.searchParams.get("comp") === "list") return new Response("")
    const [id, ...rest] = decodeURIComponent(url.pathname).replace("/payload/", "/").split("/").slice(2)
    const name = rest.join("/")
    reads.push(`${id}/${name}`)
    if (name === ".tenuvault-owner.json") return new Response(null, { status: 404 })
    if (state === "missing" && id === largeOlder) return new Response(null, { status: 404 })
    if (name === "metadata.json") return Response.json(manifests[id!])
    if (name.startsWith("_index/Users/")) {
      const shard = Number(name.split("/").pop()!.replace(".json", ""))
      return Response.json(Array.from({ length: shard === 0 ? 1000 : 1 }, (_, offset) => {
        const at = shard * 1000 + offset, object = String(at).padStart(6, "0")
        return { id: object, file: `${object}.json`, hash: (id === largeNewer && at === 1000 ? "b" : "a").repeat(22) }
      }))
    }
    throw new Error(`Report must not read object snapshots: ${name}`)
  })
  const deps = fakeDeps({ api: async (route, _tenant, body) => {
    const request = new NextRequest(`http://tenuvault.internal${route}`, { method: "POST", body: JSON.stringify({ tenantId: TENANT_A, appId: "app", clientSecret: "test", storageAccountName: "store", ...body }) })
    return route === "/api/detect-drifts" ? detectDrifts(request) : inventoryPage(request)
  } })
  const record = await generateReport(deps, TENANT_A, { baseline: older, comparison: newer, trigger: "manual", actor: null })
  expect(record.report.comparison?.inventory[0]).toMatchObject({ folder: "Users", status: state === "valid" ? "complete" : "not-performed", modified: state === "valid" ? 1 : 0 })
  expect(record.summary).not.toContain("No changes between")
  expect(reads.some(name => name.includes("outside"))).toBe(false)
  if (state === "valid") {
    expect(record.report.comparison?.inventory[0]).toMatchObject({ unchanged: 1000, examined: 1001 })
    expect(reads.filter(name => name.includes("_index/"))).toHaveLength(4)
  }
})
