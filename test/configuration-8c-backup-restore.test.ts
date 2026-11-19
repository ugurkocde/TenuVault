import { expect, it } from "vitest"
import { readObject } from "../src/shared/intune/read"
import { typeForFolder, type Item } from "../src/shared/intune/registry"
import { restoreMatrixRow } from "../src/shared/intune/restore-matrix"
import { areaPermissions } from "../src/shared/services/manifest"
import { moduleForFolder } from "../src/shared/services/modules"
import { configurationApproval } from "../src/main/restore/entra-configuration"
import { GuardedRunJournal, restoreFingerprint } from "../src/main/restore/guarded-run"
import { IdentityRestoreService } from "../src/main/restore/service"
import { RecoveryAccounts } from "../src/main/restore/safety-resolvers"

const source = "00000000-0000-4000-8000-000000000001"
const created = "00000000-0000-4000-8000-000000000002"
const identity = { tenantId: "00000000-0000-4000-8000-000000000003", userId: "00000000-0000-4000-8000-000000000004", clientId: "00000000-0000-4000-8000-000000000005" }
// Full detail response shapes verified by GET on 2026-11-18, before backup normalization.
const responses: Record<string, Item> = {
  AccessReviewPolicy: { displayName: "Access Review Policy", description: "Policy contains directory-level access review settings.", isGroupOwnerManagementEnabled: false },
  CrossTenantAccessPolicy: { id: source, displayName: "CrossTenantAccessPolicy for tenant", allowedCloudEndpoints: [] },
  AccessPackageCatalogs: { id: source, displayName: "General", uniqueName: null, description: "Built-in catalog.", catalogType: "serviceDefault", state: "published", isExternallyVisible: true, createdDateTime: "2024-05-07T09:11:58.477Z", modifiedDateTime: "2024-05-07T09:11:58.477Z", serviceManagementReference: null },
}
const safeCatalog = { ...responses.AccessPackageCatalogs!, displayName: "Saved catalog", description: "Saved description", catalogType: "userManaged", state: "unpublished", isExternallyVisible: false }
async function backup(folder: string, detail = responses[folder]!) {
  const type = typeForFolder(folder)!
  return readObject(type, String(detail.id ?? type.singleton!.id), {
    get: async path => {
      expect(path).toBe(type.singleton ? type.path : `${type.path}/${detail.id}`)
      return structuredClone({ "@odata.context": `https://graph.microsoft.com/${type.apiVersion}/$metadata`, ...detail })
    },
    list: async path => {
      expect(folder).toBe("AccessPackageCatalogs")
      expect(path).toBe(`${type.path}/${detail.id}/resources?$expand=roles,scopes`)
      return []
    },
  })
}
function world(folder: string, operation: "create" | "update") {
  const values = new Map<string, string>()
  const saved = { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value) }, delete: (key: string) => { values.delete(key) } }
  const scopes = areaPermissions(moduleForFolder(folder)!.area, "restore", "delegated")
  const token = `h.${Buffer.from(JSON.stringify({ tid: identity.tenantId, oid: identity.userId, appid: identity.clientId, scp: scopes.join(" ") })).toString("base64url")}.s`
  const row = restoreMatrixRow(folder)!, contract = row[operation]!
  let live: Item | null = operation === "create" ? null : folder === "AccessPackageCatalogs" ? { ...safeCatalog, displayName: "Current catalog" } : folder === "AccessReviewPolicy" ? { ...responses[folder], isGroupOwnerManagementEnabled: true } : { ...responses[folder], displayName: "Current parent" }
  let loseResponse = false
  const writes: Array<{ method: string; path: string; body: Item }> = []
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)), resource = url.pathname.replace(/^\/(v1\.0|beta)\//, "")
    expect(url.origin).toBe("https://graph.microsoft.com")
    expect(url.pathname.startsWith(`/${contract.version}/`)).toBe(true)
    expect([row.readPath, `${row.readPath}/${source}`, `${row.readPath}/${created}`]).toContain(resource)
    if (init?.method !== "GET") {
      const body = JSON.parse(String(init?.body)) as Item
      writes.push({ method: init!.method!, path: resource, body })
      live = { ...live, ...body, ...(folder === "AccessPackageCatalogs" ? { id: operation === "create" ? created : source, catalogType: "userManaged" } : {}) }
      if (loseResponse) throw new Error("Committed, response lost")
      return operation === "create" ? Response.json(live, { status: 201 }) : new Response(null, { status: 204 })
    }
    if (folder === "AccessPackageCatalogs" && resource === `${row.readPath}/${source}` && operation === "create") return new Response(null, { status: 404 })
    if (folder === "AccessPackageCatalogs" && resource === row.readPath) return Response.json({ value: live ? [live] : [] })
    return live ? Response.json(live) : new Response(null, { status: 404 })
  }) as typeof fetch
  const journal = new GuardedRunJournal(saved)
  const service = () => new IdentityRestoreService(new GuardedRunJournal(saved), new RecoveryAccounts(saved), async () => ({ ...identity, token }), fetcher)
  return { journal, service, writes, loseResponse: () => { loseResponse = true }, current: () => live }
}

for (const [folder, operation] of [["AccessReviewPolicy", "update"], ["CrossTenantAccessPolicy", "update"], ["AccessPackageCatalogs", "create"], ["AccessPackageCatalogs", "update"]] as const) {
  for (const lost of [false, true]) it(`${folder} ${operation}: restores a full readObject backup${lost ? " and reconciles a lost response after restart" : " after exact confirmation"}`, async () => {
    const snapshot = await backup(folder, folder === "AccessPackageCatalogs" ? safeCatalog : responses[folder]!)
    const state = world(folder, operation), service = state.service()
    const request = { path: `backup/${folder}/Policy.json`, snapshot, origin: "restore" as const }
    await expect(service.prepare(identity.tenantId, { ...request, snapshot: { ...snapshot, unexpected: true } }, operation)).rejects.toThrow("reviewed request builder")
    const run = await service.prepare(identity.tenantId, request, operation)
    const expected = Object.fromEntries(restoreMatrixRow(folder)![operation]!.properties.map(key => [key, snapshot[key]]))
    expect(run.entries[0]!.step.desired).toEqual(expected)
    expect(run.source!.fingerprint).toBe(restoreFingerprint(snapshot))
    expect(state.writes).toEqual([])
    const review = await service.review(identity.tenantId, run.id)
    const changed = { ...snapshot, ...(folder === "AccessReviewPolicy" ? { description: "Changed read-only description" } : folder === "CrossTenantAccessPolicy" ? { allowedCloudEndpoints: ["microsoftonline.com"] } : { modifiedDateTime: "2026-11-18T00:00:00Z" }) }
    expect(configurationApproval(run.entries[0]!.step, { ...run, source: { ...run.source!, fingerprint: restoreFingerprint(changed) } })).not.toBe(review.fingerprint)
    await expect(service.confirm(identity.tenantId, run.id, "stale-confirmation")).rejects.toThrow("no longer matches")
    await service.confirm(identity.tenantId, run.id, review.fingerprint)
    expect((await service.restore(identity.tenantId, { ...request, snapshot: changed, runId: run.id })).success).toBe(false)
    expect(state.writes).toEqual([])
    const before = structuredClone(state.current())
    if (lost) state.loseResponse()
    const result = await service.restore(identity.tenantId, { ...request, runId: run.id })
    // A recreated ID has an advisory reference warning with these exact area scopes.
    expect(result.success).toBe(!lost && operation !== "create")
    if (!lost && operation === "create") { expect(result.partial).toBe(true); expect(result.warnings).toHaveLength(1) }
    if (lost) {
      expect(state.journal.load(identity.tenantId, run.id)!.entries[0]!.state).toBe("uncertain")
      await state.service().reconcile(identity.tenantId, run.id)
    }
    const final = state.journal.load(identity.tenantId, run.id)!
    expect(final.entries[0]!.state).toBe("applied")
    expect(final.entries[0]!.before).toEqual(before)
    expect(final.entries[0]!.sent).toEqual(expected)
    expect(state.writes).toEqual([{ method: operation === "create" ? "POST" : "PATCH", path: restoreMatrixRow(folder)![operation]!.path.replace("{accessPackageCatalogId}", source), body: expected }])
    expect(final.mappings).toHaveLength(1)
  })
}

for (const operation of ["create", "update"] as const) it(`AccessPackageCatalogs ${operation}: deliberately refuses unsafe full backups before any write`, async () => {
  const state = world("AccessPackageCatalogs", operation), service = state.service()
  for (const [detail, reason] of [
    [responses.AccessPackageCatalogs!, "Only user-managed catalog backups"],
    [{ ...safeCatalog, state: "published" }, "unpublished and hidden externally"],
    [{ ...safeCatalog, isExternallyVisible: true }, "unpublished and hidden externally"],
    [{ ...safeCatalog, uniqueName: "configured" }, "uniqueName is configured"],
    [{ ...safeCatalog, serviceManagementReference: "configured" }, "serviceManagementReference is configured"],
  ] as const) {
    const snapshot = await backup("AccessPackageCatalogs", detail)
    await expect(service.prepare(identity.tenantId, { path: "backup/AccessPackageCatalogs/Policy.json", snapshot, origin: "restore" }, operation)).rejects.toThrow(reason)
  }
  const snapshot = { ...await backup("AccessPackageCatalogs", safeCatalog), resources: [{ id: source }] }
  await expect(service.prepare(identity.tenantId, { path: "backup/AccessPackageCatalogs/Policy.json", snapshot, origin: "restore" }, operation)).rejects.toThrow("resources needs a reviewed request builder")
  expect(state.writes).toEqual([])
})
