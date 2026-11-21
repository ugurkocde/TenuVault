import { describe, expect, it } from "vitest"
import { GuardedRunJournal, executeGuardedRun, restoreFingerprint, type GuardedIO, type GuardedRun, type GuardedStep } from "../src/main/restore/guarded-run"
import { requireRestoreActor } from "../src/main/restore/restore-actor"
import { addsOnly, addsOnlyPayload, RestoreWriteRefusedError, guardRestoreItem, mergeConsentScopes, restoreOriginBlocker, type RestoreActor } from "../src/shared/intune/restore-guards"
import { dependencyOrder, mappedReference, rememberMapping, replacedReferenceReport, type RestoreMapping } from "../src/shared/intune/restore-references"
import { INTUNE_TYPES, restoreCapability, type Item } from "../src/shared/intune/registry"
import { writeBlocker } from "../src/shared/intune/restore-plan"

const actor: RestoreActor = { tenantId: "tenant", userId: "admin", clientId: "client", applicationObjectId: "application", servicePrincipalId: "sp", recoveryAccountIds: ["recovery"] }
const token = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`
const delegated = token({ scp: "Policy.ReadWrite.Authorization", oid: "admin", tid: "tenant", appid: "client" })
const references = { principals: [], applications: [], complete: true }
function setup(count = 3) {
  const memory = new Map<string, string>()
  const journal = new GuardedRunJournal({ get: key => memory.get(key) ?? null, set: (key, value) => { memory.set(key, value) }, delete: key => { memory.delete(key) } })
  const objects = new Map<string, Item>()
  let writes = 0
  const steps: GuardedStep[] = Array.from({ length: count }, (_, i) => ({ key: `step${i}`, folder: "Fixture", sourceId: `old${i}`, operation: "create", properties: ["displayName"], desired: { displayName: `Policy ${i}` }, preview: restoreFingerprint(null), requires: i ? [`step${i - 1}`] : [] }))
  const input: GuardedRun = { version: 1, id: "run", tenant: "tenant", actor, origin: "restore", entries: steps.map(step => ({ step, state: "pending" })), mappings: [] }
  const io: GuardedIO = {
    token: delegated,
    replacedReferences: async () => [],
    type: () => ({ folder: "Fixture", label: "Fixture", path: "fixtures", area: "Tenant settings", nameKey: "displayName", restore: "create" }),
    read: async (_step, id) => id ? objects.get(id) ?? null : null,
    findCreated: async (step) => [...objects.values()].filter(value => value.displayName === step.desired.displayName),
    references: async () => references,
    write: async (_step, body, _id, beforeSend) => { beforeSend(); const id = `new${++writes}`; objects.set(id, { ...body, id }); return { id } },
  }
  return { journal, objects, input, io, memory, writes: () => writes }
}

describe("identity restore admission", () => {
  it("admits only verified identity capabilities and retains the journaled safety boundary", () => {
    const types = INTUNE_TYPES.filter(type => type.restoreSafety === "identity")
    expect(types).toHaveLength(91)
    for (const type of types) {
      expect(restoreCapability(type)).toBe(["AuthenticationFlowsPolicy", "EntraCompanyBranding", "CrossTenantAccessPolicy", "AccessReviewPolicy"].includes(type.folder) ? "singleton" : ["TokenLifetimePolicies", "ActivityBasedTimeoutPolicies", "AccessPackageCatalogs", "Users", "Groups", "Applications"].includes(type.folder) ? "create" : "none")
      for (const operation of ["create", "update", "delete", "assign"] as const) expect(writeBlocker({ ...type, restore: "create" }, operation)).toContain("journaled restore safety")
    }
  })
  it("refuses reference-only capabilities and singleton creates in the guarded runner", async () => {
    for (const restore of ["metadata", "singleton"] as const) {
      const s = setup(1)
      const type = s.io.type("Fixture")
      s.io.type = () => ({ ...type, restore })
      expect((await executeGuardedRun(s.journal, s.input, s.io)).run.entries[0]!.state).toBe("blocked")
      expect(s.writes()).toBe(0)
    }
  })
  it("rejects app-only, Backup Reader, unknown and wrong-connection tokens", () => {
    requireRestoreActor(delegated, actor)
    for (const claims of [{ roles: ["Directory.ReadWrite.All"] }, { scp: "", oid: "admin" }, { scp: "write", oid: "other", tid: "tenant", appid: "client" }, { scp: "write", oid: "admin", tid: "other", appid: "client" }, { scp: "write", oid: "admin", tid: "tenant", appid: "other" }, { scp: "write", oid: "admin", tid: "tenant", appid: "client", idtyp: "app" }]) expect(() => requireRestoreActor(token(claims), actor)).toThrow("signed-in admin")
    expect(() => requireRestoreActor("unknown", actor)).toThrow("signed-in admin")
  })
  it("refuses protected users, roles, methods, applications and unresolved safety evidence", () => {
    for (const principal of ["ADMIN", "recovery", "sp"]) expect(() => guardRestoreItem(actor, "EntraRoleAssignments", undefined, { ...references, principals: [principal] }, false)).toThrow("protected")
    for (const application of ["application", "client", "sp"]) expect(() => guardRestoreItem(actor, "Applications", application, references, false)).toThrow("protected")
    expect(() => guardRestoreItem(actor, "Users", "admin", references, false)).toThrow("protected")
    expect(() => guardRestoreItem(actor, "Groups", "group", { ...references, complete: false }, false)).toThrow("resolved")
    for (const remaining of [undefined, { global: [], privilegedRole: ["other"] }, { global: ["other"], privilegedRole: [] }]) expect(() => guardRestoreItem(actor, "EntraRoleAssignments", "assignment", { ...references, remainingAdministrators: remaining }, true)).toThrow("last Global Administrator")
    guardRestoreItem(actor, "EntraRoleAssignments", "assignment", { ...references, remainingAdministrators: { global: ["a"], privilegedRole: ["b"] } }, true)
  })
  it("refuses imported grants and assignments and every new cross-tenant type", () => {
    for (const folder of ["OAuth2PermissionGrants", "EntraRoleAssignments", "DefenderRoleAssignments", "PimGroupAssignmentSchedules"]) expect(restoreOriginBlocker(folder, "import")).toContain("never restored")
    expect(restoreOriginBlocker("Users", "cross-tenant")).toContain("cannot be copied")
    expect(restoreOriginBlocker("Groups", "restore")).toBeUndefined()
  })
})

describe("adds-only defaults", () => {
  it("retains members, owners and entries and canonicalizes object keys", () => {
    expect(addsOnly(["a", { id: "b", name: "B" }], [{ name: "B", id: "b" }, "c"])).toEqual(["a", { name: "B", id: "b" }, "c"])
    expect(addsOnly(["a"], [], true)).toEqual([])
    expect(mergeConsentScopes("User.Read Mail.Read", "User.Read Group.Read.All")).toBe("Group.Read.All Mail.Read User.Read")
    expect(mergeConsentScopes("User.Read Mail.Read", "User.Read", true)).toBe("User.Read")
  })
})

describe("durable touched-object journal", () => {
  it("captures before the write, saves every created ID, resumes without duplicate writes and reports partial per item", async () => {
    const s = setup()
    const write = s.io.write
    s.io.write = async (step, body, id, beforeSend) => {
      const entry = s.journal.load("tenant", "run")!.entries.find(entry => entry.step.key === step.key)!
      expect(entry).toMatchObject({ before: null, sent: body, state: "captured" })
      return write(step, body, id, beforeSend)
    }
    expect((await executeGuardedRun(s.journal, s.input, s.io)).status).toBe("complete")
    expect(s.journal.load("tenant", "run")!.mappings).toHaveLength(3)
    expect((await executeGuardedRun(s.journal, s.input, s.io)).status).toBe("complete")
    expect(s.writes()).toBe(3)
  })
  for (let boundary = 0; boundary < 3; boundary++) it(`cancels and restarts after step ${boundary} without duplicate creates`, async () => {
    const s = setup()
    const controller = new AbortController()
    const write = s.io.write
    s.io.write = async (step, body, id, beforeSend) => { const result = await write(step, body, id, beforeSend); if (step.key === `step${boundary}`) controller.abort(); return result }
    const first = await executeGuardedRun(s.journal, s.input, s.io, controller.signal)
    expect(first.status).toBe(boundary === 2 ? "complete" : "partial")
    expect((await executeGuardedRun(s.journal, s.input, s.io)).status).toBe("complete")
    expect(s.writes()).toBe(3)
  })
  it("reconciles a committed create whose response timed out before resuming its dependents", async () => {
    const s = setup()
    const write = s.io.write
    s.io.write = async (step, body, id, beforeSend) => { await write(step, body, id, beforeSend); throw new Error("timeout") }
    const first = await executeGuardedRun(s.journal, s.input, s.io)
    expect(first).toMatchObject({ status: "partial", run: { entries: [{ state: "uncertain" }, { state: "blocked" }, { state: "blocked" }] } })
    s.io.write = write
    const retry = await executeGuardedRun(s.journal, s.input, s.io)
    expect(retry.run.entries[0]).toMatchObject({ state: "applied", targetId: "new1" })
    expect(retry.status).toBe("complete")
    expect(s.objects.size).toBe(3)
    expect(s.writes()).toBe(3)
  })
  it("never retries an unanswered create based on absence or an ambiguous match", async () => {
    for (const matches of [[], [{ id: "one", displayName: "Policy 0" }, { id: "two", displayName: "Policy 0" }]]) {
      const s = setup(1)
      s.io.write = async (_step, _body, _id, beforeSend) => { beforeSend(); throw new Error("secret tenant error") }
      await executeGuardedRun(s.journal, s.input, s.io)
      s.io.findCreated = async () => matches
      const retry = await executeGuardedRun(s.journal, s.input, s.io)
      expect(retry.run.entries[0]!.state).toBe("uncertain")
      expect([...s.memory.values()].join()).not.toContain("secret tenant error")
    }
  })
  it("rejects a stale preview and blocks its dependents", async () => {
    const s = setup()
    s.io.read = async () => ({ id: "live", displayName: "Changed" })
    const result = await executeGuardedRun(s.journal, s.input, s.io)
    expect(result.status).toBe("partial")
    expect(result.run.entries[0]!.reason).toContain("changed after this preview")
    expect(result.run.entries[1]!.reason).toContain("Prerequisite step0")
    expect(s.writes()).toBe(0)
  })
  it("binds the persisted plan and actor to the run and refuses secrets and corrupt history", async () => {
    const s = setup(1)
    await executeGuardedRun(s.journal, s.input, s.io)
    s.input.entries[0]!.step.desired = { displayName: "different" }
    await expect(executeGuardedRun(s.journal, s.input, s.io)).rejects.toThrow("plan changed")
    for (const value of [{ password: "x" }, { description: "Bearer secret" }] as Item[]) expect(() => s.journal.save({ ...s.input, entries: [{ ...s.input.entries[0]!, before: value }] })).toThrow("Credential")
    s.memory.set([...s.memory.keys()][0]!, "broken")
    expect(() => s.journal.load("tenant", "run")).toThrow()
  })
  it("captures updates, merges nested collections and scopes, and reconciles a lost update response", async () => {
    const s = setup(1)
    const current: Item = { id: "existing", scope: "User.Read Mail.Read", nested: { owners: ["keep"] }, displayName: "Before" }
    s.objects.set("existing", structuredClone(current))
    const step = s.input.entries[0]!.step
    Object.assign(step, { folder: "OAuth2PermissionGrants", operation: "update", targetId: "existing", properties: ["scope", "nested", "displayName"], desired: { scope: "User.Read", nested: { owners: ["add"] }, displayName: "After" }, preview: restoreFingerprint(current) })
    let attempts = 0
    s.io.write = async (_step, body, id, beforeSend) => { beforeSend(); attempts++; s.objects.set(id!, { ...body, id: id! }); throw new Error("timeout") }
    const first = await executeGuardedRun(s.journal, s.input, s.io)
    expect(first.run.entries[0]).toMatchObject({ state: "uncertain", before: current, sent: { scope: "Mail.Read User.Read", nested: { owners: ["keep", "add"] } } })
    expect((await executeGuardedRun(s.journal, s.input, s.io)).status).toBe("complete")
    expect(attempts).toBe(1)
    expect(() => addsOnlyPayload({ nested: { owners: ["keep"] } }, { nested: null })).toThrow("explicit choice")
    expect(() => addsOnlyPayload({ owners: ["keep"] }, { owners: null })).toThrow("explicit choice")
  })
  it("persists typed mappings and rewrites only the declared reference on dependent writes", async () => {
    const s = setup(2)
    s.input.entries[1]!.step.desired = { displayName: "old0", resource: { objectId: "old0" } }
    s.input.entries[1]!.step.properties.push("resource")
    s.input.entries[1]!.step.references = [{ property: "resource.objectId", kind: "objectId", folder: "Fixture", source: "old0" }]
    const result = await executeGuardedRun(s.journal, s.input, s.io)
    expect(result.status).toBe("complete")
    expect(s.objects.get("new2")).toMatchObject({ displayName: "old0", resource: { objectId: "new1" } })
    expect(s.journal.load("tenant", "run")!.mappings).toHaveLength(2)
  })
  it("restarts a captured but unsent step and rejects disabled capabilities, unresolved references and cycles", async () => {
    const s = setup(1)
    const controller = new AbortController()
    s.io.references = async () => { controller.abort(); return references }
    expect((await executeGuardedRun(s.journal, s.input, s.io, controller.signal)).run.entries[0]!.state).toBe("captured")
    expect(s.writes()).toBe(0)
    s.io.references = async () => references
    expect((await executeGuardedRun(s.journal, s.input, s.io)).status).toBe("complete")
    for (const mode of ["capability", "references", "cycle"] as const) {
      const next = setup(1)
      if (mode === "capability") { const type = next.io.type("Fixture"); delete type.restore; next.io.type = () => type }
      if (mode === "references") next.io.references = async () => ({ ...references, complete: false })
      if (mode === "cycle") next.input.entries[0]!.step.requires = ["step0"]
      expect((await executeGuardedRun(next.journal, next.input, next.io)).run.entries[0]!.state).toBe("blocked")
      expect(next.writes()).toBe(0)
    }
  })
  it("persists replaced-reference reports and reports an incomplete scan as partial", async () => {
    const s = setup(1)
    delete s.io.replacedReferences
    const first = await executeGuardedRun(s.journal, s.input, s.io)
    expect(first).toMatchObject({ status: "partial", run: { referenceWarning: expect.stringContaining("reference scan did not complete") } })
    s.io.replacedReferences = async mappings => replacedReferenceReport([{ path: "backup/ConditionalAccessPolicies/policy.json", snapshot: { excludedGroups: ["old0"] } }], mappings)
    const reviewed = await executeGuardedRun(s.journal, s.input, s.io)
    expect(reviewed.status).toBe("complete")
    expect(reviewed.run.replacedReferences).toMatchObject([{ property: "excludedGroups.0", mapping: { kind: "objectId", source: "old0", target: "new1" } }])
    expect(s.journal.load("tenant", "run")!.replacedReferences).toHaveLength(1)
    expect(s.writes()).toBe(1)
  })
  it("blocks a new run while an earlier write is unanswered, but permits a new preview after a definite refusal", async () => {
    for (const refused of [false, true]) {
      const s = setup(1)
      const write = s.io.write
      s.io.write = async (_step, _body, _id, beforeSend) => { beforeSend(); if (refused) throw new RestoreWriteRefusedError(403); throw new Error("timeout") }
      const first = await executeGuardedRun(s.journal, s.input, s.io)
      expect(first.run.entries[0]!.state).toBe(refused ? "failed" : "uncertain")
      s.io.write = write
      s.input.id = "new-run"
      const next = await executeGuardedRun(s.journal, s.input, s.io)
      expect(next.status).toBe(refused ? "complete" : "partial")
      expect(s.writes()).toBe(refused ? 1 : 0)
      if (!refused) expect(next.run.entries[0]!.reason).toContain("earlier restore")
    }
  })
  it("loads typed mappings from previous runs and refuses to recreate an object they still identify", async () => {
    const s = setup(1)
    await executeGuardedRun(s.journal, s.input, s.io)
    s.input.id = "new-run"
    const next = await executeGuardedRun(s.journal, s.input, s.io)
    expect(next.run.mappings).toEqual([{ kind: "objectId", folder: "Fixture", source: "old0", target: "new1" }])
    expect(next.run.entries[0]!.reason).toContain("changed after this preview")
    expect(s.writes()).toBe(1)
    s.objects.delete("new1")
    s.input.id = "another-run"
    const deleted = await executeGuardedRun(s.journal, s.input, s.io)
    expect(deleted.run.entries[0]!.reason).toContain("Review its mapping")
    expect(s.writes()).toBe(1)
  })
  it("validates journal mappings even when a preview was already saved", async () => {
    const s = setup(1)
    const saved = { ...structuredClone(s.input), id: "prepared" }
    s.journal.save(saved)
    await executeGuardedRun(s.journal, s.input, s.io)
    const result = await executeGuardedRun(s.journal, saved, s.io)
    expect(result.run.entries[0]!.state).toBe("blocked")
    expect(s.writes()).toBe(1)
    saved.mappings = [{ kind: "objectId", folder: "Fixture", source: "old0", target: "conflicting" }]
    s.journal.save({ ...saved, mappings: [] })
    await expect(executeGuardedRun(s.journal, saved, s.io)).resolves.toBeDefined()
    const unsaved = { ...saved, id: "conflict" }
    await expect(executeGuardedRun(s.journal, unsaved, s.io)).rejects.toThrow("ambiguous")
  })
  it("uses fresh recovery protections for later writes while allowing read-only reconciliation", async () => {
    const s = setup(2), write = s.io.write
    s.io.write = async (step, body, id, beforeSend) => { await write(step, body, id, beforeSend); throw new Error("lost response") }
    await executeGuardedRun(s.journal, s.input, s.io)
    const changed = { ...s.input, actor: { ...actor, recoveryAccountIds: ["new-recovery"] } }
    const reconciled = await executeGuardedRun(s.journal, changed, s.io, undefined, true)
    expect(reconciled.run.entries[0]!.state).toBe("applied")
    s.io.references = async () => ({ ...references, principals: ["new-recovery"] })
    s.io.write = write
    const resumed = await executeGuardedRun(s.journal, changed, s.io)
    expect(resumed.run.entries[1]!.reason).toContain("protected")
    expect(s.writes()).toBe(1)
    await expect(executeGuardedRun(s.journal, { ...changed, actor: { ...changed.actor, clientId: "different" } }, s.io)).rejects.toThrow()
  })
  it("retains mappings and every unresolved write when settled history reaches its boundary", () => {
    const s = setup(1)
    const old = { ...structuredClone(s.input), id: "old", entries: [{ ...s.input.entries[0]!, state: "applied" as const }], mappings: [{ kind: "objectId" as const, folder: "Fixture", source: "old0", target: "new1" }] }
    // Migrate the original on-disk shape with history already at its boundary.
    const runs = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i), { ...old, id: String(i), mappings: i ? [] : old.mappings }]))
    s.memory.set("restore.guarded.tenant", JSON.stringify(runs))
    s.journal.save({ ...s.input, id: "unanswered", entries: [{ ...s.input.entries[0]!, state: "uncertain", sent: { displayName: "Policy 0" } }] })
    s.journal.save({ ...old, id: "1001", mappings: [] })
    expect(s.journal.list("tenant")).toHaveLength(1001)
    expect(s.journal.load("tenant", "0")).toBeUndefined()
    expect(s.journal.load("tenant", "unanswered")!.entries[0]!.state).toBe("uncertain")
    expect(s.journal.mappings("tenant")).toEqual(old.mappings)
    expect(s.journal.hasEarlierUnanswered({ ...s.input, id: "fresh" }, s.input.entries[0]!.step)).toBe(true)
    s.journal.save({ ...old, id: "1002", mappings: [] })
    expect(s.journal.list("tenant")).toHaveLength(1001)
  })
  it("refuses overlapping execution and a journal that cannot save", async () => {
    const s = setup(1)
    let release!: () => void
    s.io.read = async () => { await new Promise<void>(resolve => { release = resolve }); return null }
    const first = executeGuardedRun(s.journal, s.input, s.io)
    await Promise.resolve()
    await expect(executeGuardedRun(s.journal, s.input, s.io)).rejects.toThrow("already running")
    release(); await first
    const failed = new GuardedRunJournal({ get: () => null, set: () => { throw new Error("disk full") }, delete: () => {} })
    await expect(executeGuardedRun(failed, s.input, s.io)).rejects.toThrow("disk full")
  })
})

describe("typed reference dependencies", () => {
  it("keeps ID namespaces and folders apart, persists mappings and refuses ambiguity", () => {
    const mappings: RestoreMapping[] = []
    rememberMapping(mappings, { kind: "objectId", folder: "Applications", source: "same", target: "object" })
    rememberMapping(mappings, { kind: "appId", folder: "Applications", source: "same", target: "app" })
    expect(mappedReference(mappings, "objectId", "Applications", "same")).toBe("object")
    expect(mappedReference(mappings, "appId", "Applications", "same")).toBe("app")
    expect(mappedReference(mappings, "templateId", "Applications", "same")).toBeUndefined()
    expect(() => rememberMapping(mappings, { ...mappings[0]!, target: "other" })).toThrow("ambiguous")
    expect(replacedReferenceReport([{ path: "backup/ConditionalAccessPolicies/policy.json", snapshot: { conditions: { appId: "same" } } }], mappings)).toHaveLength(2)
  })
  it("orders prerequisites, blocks missing prerequisites and cycles with dependents", () => {
    expect(dependencyOrder([{ key: "b", requires: ["a"] }, { key: "a", requires: [] }])).toEqual({ order: ["a", "b"], blocked: {} })
    expect(Object.keys(dependencyOrder([{ key: "a", requires: ["b"] }, { key: "b", requires: ["a"] }, { key: "c", requires: ["a"] }]).blocked)).toHaveLength(3)
    expect(dependencyOrder([{ key: "a", requires: ["missing"] }]).blocked.a).toContain("missing")
  })
})

it("preserves a newer same-attempt acknowledgement when publishing an older applied snapshot", () => {
  const env = setup(1), entry = env.input.entries[0]!
  entry.state = "applied"; entry.attempt = 1; entry.acknowledged = true; entry.acknowledgedAt = 100
  entry.reason = "The write did not return a confirmed result. It must be read back before any retry."
  const publish = env.journal.publication(env.input, entry)
  entry.state = "uncertain"; entry.acknowledgedAt = 200
  env.journal.save(env.input)
  publish()
  const saved = env.journal.load("tenant", "run")!.entries[0]!
  expect(saved).toMatchObject({ state: "applied", attempt: 1, acknowledged: true, acknowledgedAt: 200 })
  expect(saved.reason).toBeUndefined()
})
