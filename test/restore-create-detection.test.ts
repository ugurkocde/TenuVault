import { configurationApproval, configurationConfirmation, isEntraConfiguration } from "../src/main/restore/entra-configuration"
import { describe, expect, it } from "vitest"
import { findCreatedByDescriptor } from "../src/main/restore/create-detection"
import { GuardedRunJournal, executeGuardedRun, restoreFingerprint, type GuardedIO, type GuardedRun, type GuardedStep } from "../src/main/restore/guarded-run"
import { RESTORE_MATRIX } from "../src/shared/intune/restore-matrix"
import { typeForFolder, restoreCapability, type Item } from "../src/shared/intune/registry"

const actor = { tenantId: "tenant", userId: "admin", clientId: "client", applicationObjectId: "app-object", servicePrincipalId: "sp-object", recoveryAccountIds: [] }
const token = `header.${Buffer.from(JSON.stringify({ scp: "test-only", tid: "tenant", oid: "admin", appid: "client" })).toString("base64url")}.signature`
const creates = RESTORE_MATRIX.filter(row => row.create)

describe("every matrix create detection contract", () => {
  it("lists every create without a verified detection key and its reason", () => {
    const blocked = creates.filter(row => row.detection.kind === "id" || !row.detection.properties?.length)
    expect(blocked.map(row => row.folder)).toEqual(["Applications"])
    for (const row of blocked) {
      expect(row.detection.reason).toBeTruthy()
      expect(row.create!.blockedReason).toContain("reconciliation key")
      expect(restoreCapability(typeForFolder(row.folder)!)).toBe("none")
    }
  })
  for (const row of creates.filter(row => row.detection.properties?.length)) for (const lost of [false, true]) it(`${row.folder}: ${lost ? "reconciles a lost response" : "creates successfully"} and restarts with exactly one object`, async () => {
    const write = row.create!, type = typeForFolder(row.folder)!
    expect(restoreCapability(type)).toBe(["TokenLifetimePolicies", "ActivityBasedTimeoutPolicies", "AccessPackageCatalogs", "Users", "Groups"].includes(type.folder) ? "create" : "none")
    const keys = row.detection.properties!
    // Each fixture contains the complete declared detection tuple. Values are opaque to the
    // generic transport; nested builders and live schema verification belong to later layers.
    const desired: Item = Object.fromEntries(write.properties.filter(key => !["secretKey", "passwordProfile", "authenticationConfiguration"].includes(key)).map(key => [key, `fixture-${key}`]))
    for (const key of keys) expect(key in desired, `${row.folder} detection key ${key} must be writable on create`).toBe(true)
    const step: GuardedStep = { key: "one", folder: row.folder, sourceId: "source-id", operation: "create", properties: write.properties, desired, preview: restoreFingerprint(null), requires: [] }
    const memory = new Map<string, string>()
    const store = { get: (key: string) => memory.get(key) ?? null, set: (key: string, value: string) => { memory.set(key, value) }, delete: (key: string) => { memory.delete(key) } }
    const input: GuardedRun = { version: 1, tenant: "tenant", id: "run", actor, origin: "restore", entries: [{ step, state: "pending" }], mappings: [] }
    if (isEntraConfiguration(step.folder)) step.confirmation = { kind: configurationConfirmation(step.folder), fingerprint: configurationApproval(step, input) }
    let sends = 0, lookups = 0
    const objects: Item[] = []
    // The only substitution resolves the parent scope in this fixture. The real generic
    // adapter still refuses unresolved parents, unverified contracts and capability none.
    const descriptor = { ...row, readPath: row.readPath.replace("{organizationId}", "fixture-organization") }
    const root = `https://graph.microsoft.com/${write.version}/`
    const collection = root + descriptor.readPath
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (init?.method !== "GET") {
        expect(init?.method).toBe(write.method)
        expect(url.pathname).toBe(new URL(root + write.path.replace(/\{[^}]+\}/g, "fixture-organization")).pathname)
        expect(JSON.parse(String(init?.body))).toEqual(desired)
        sends++
        objects.push({ ...desired, id: typeof desired.id === "string" ? desired.id : "created-id" })
        if (lost) throw new Error("The server committed before the response was lost")
        return Response.json(objects[0])
      }
      lookups++
      expect(url.pathname).toBe(new URL(collection).pathname)
      // A candidate that differs in the final detection property must not be selected.
      if (!url.searchParams.has("$skiptoken")) return Response.json({ value: objects.length ? [{ ...objects[0], [keys.at(-1)!]: "decoy" }] : [], "@odata.nextLink": collection + "?$skiptoken=next" })
      return Response.json({ value: objects })
    }
    const read = async (url: string) => (await fetcher(url, { method: "GET" })).json() as Promise<Item>
    const find = () => findCreatedByDescriptor(descriptor, desired, read)
    // Test-only capability enablement uses a copy, so no production descriptor is mutated.
    const io: GuardedIO = {
      token, type: () => ({ ...type, restore: "create" }), replacedReferences: async () => [],
      read: async () => { const matches = await find(); expect(matches.length).toBeLessThanOrEqual(1); return matches[0] ?? null },
      findCreated: (_step, sent) => findCreatedByDescriptor(descriptor, sent, read),
      references: async () => ({ complete: true, principals: [], applications: [] }),
      write: async (_step, body, _id, beforeSend) => {
        beforeSend()
        const response = await fetcher(root + write.path.replace(/\{[^}]+\}/g, "fixture-organization"), { method: write.method, body: JSON.stringify(body) })
        return { id: (await response.json() as Item).id as string }
      },
    }
    const first = await executeGuardedRun(new GuardedRunJournal(store), input, io)
    expect(first.run.entries[0]!.state).toBe(lost ? "uncertain" : "applied")
    const restart = await executeGuardedRun(new GuardedRunJournal(store), input, io)
    expect(restart.status).toBe("complete")
    expect(restart.run.entries[0]).toMatchObject({ state: "applied", targetId: objects[0]!.id })
    await executeGuardedRun(new GuardedRunJournal(store), input, io)
    expect(sends).toBe(1)
    expect(objects).toHaveLength(1)
    expect(lookups).toBeGreaterThanOrEqual(lost ? 4 : 2)
    expect(restoreCapability(type)).toBe(["TokenLifetimePolicies", "ActivityBasedTimeoutPolicies", "AccessPackageCatalogs", "Users", "Groups"].includes(type.folder) ? "create" : "none")
  })
})
