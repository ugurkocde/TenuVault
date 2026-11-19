import { afterEach, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { COMPANION_LOOKUP_BUDGET, POST as history } from "../src/portal/app/api/list-backups/route"

const tenant = "11111111-1111-1111-1111-111111111111"
afterEach(() => vi.unstubAllGlobals())
for (const discovery of ["complete", "failed", "partial"]) it(`bounds 500 absent companion lookups after ${discovery} discovery`, async () => {
  const ids = Array.from({ length: 500 }, (_, at) => `backup-${new Date(Date.UTC(2020, 0, 1 + at)).toISOString().slice(0, 10)}-000000`)
  let lookups = 0
  const xml = (names: string[], marker = "") => `<EnumerationResults><Blobs>${names.map(name => `<Blob><Name>${name}</Name><Properties><Content-Length>100</Content-Length></Properties></Blob>`).join("")}</Blobs><NextMarker>${marker}</NextMarker></EnumerationResults>`
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    const url = new URL(String(input))
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "storage" })
    if (url.searchParams.get("comp") === "list") {
      if (url.pathname === "/intune-backups") return new Response(xml(ids.map(id => `${id}/metadata.json`)))
      if (discovery === "complete") return new Response(xml([]))
      if (discovery === "partial" && !url.searchParams.get("marker")) return new Response(xml([], "page2"))
      return new Response("Discovery denied", { status: 403 })
    }
    if (url.pathname.startsWith("/intune-backups-large/")) { lookups++; return new Response("", { status: 404 }) }
    const id = url.pathname.split("/")[2]!
    return Response.json({ BackupFolder: id, TenantId: tenant, RunId: id, Status: "Success", Coverage: "Complete", Failures: 0, CompanionBackup: id.replace("backup-", "backup-large-") })
  }))
  const response = await history(new NextRequest("http://tenuvault.internal/api/list-backups", { method: "POST", body: JSON.stringify({ tenantId: tenant, appId: discovery, clientSecret: "test", subscriptionId: "test", resourceGroupName: "test", storageAccountName: "lookupbudget", summary: true }) }))
  expect(response.status).toBe(200)
  const result = await response.json()
  expect(result.backups).toHaveLength(500)
  expect(lookups).toBe(discovery === "complete" ? 0 : COMPANION_LOOKUP_BUDGET)
  expect(result.backups.every((row: any) => row.status === "incomplete")).toBe(true)
  if (discovery !== "complete") expect(result.backups.filter((row: any) => row.warning.includes("budget was reached"))).toHaveLength(500 - COMPANION_LOOKUP_BUDGET)
})
