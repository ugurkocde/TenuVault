import { describe, expect, it, vi } from "vitest"
import { moduleForFolder, type Need } from "../src/shared/services/modules"
import { isConfiguration8c, STAGED_8C_OPERATIONS } from "../src/main/restore/configuration-8c"
import { RESTORE_MATRIX } from "../src/shared/intune/restore-matrix"
import { typeForFolder, restoreCapability, type Item } from "../src/shared/intune/registry"
import { restoreMatrixRow } from "../src/shared/intune/restore-matrix"
import { GuardedRunJournal, executeGuardedRun, restoreFingerprint, type GuardedRun, type GuardedStep } from "../src/main/restore/guarded-run"
import { guardedGraphIO } from "../src/main/restore/graph-io"
import { checkConfigurationLockout, configurationApproval, configurationConfirmation, configurationDifference, configurationPayload, requireConfigurationApproval } from "../src/main/restore/entra-configuration"

const actor = { tenantId: "tenant", userId: "admin", clientId: "client", applicationObjectId: "app", servicePrincipalId: "sp", recoveryAccountIds: [] }
const id = "00000000-0000-4000-8000-000000000001"
const source = "00000000-0000-4000-8000-000000000002"
const cases: Record<string, Item> = {
  CrossTenantAccessPolicy: { displayName: "TV06-TEST-Cross" },
  ExternalIdentitiesPolicy: { allowExternalIdentitiesToLeave: false },
  UserFlowAttributes: { displayName: "TV06-TEST-Attribute", description: "Lab original", dataType: "string" },
  AccessPackageCatalogs: { displayName: "TV06-TEST-Catalog", description: "Lab original", state: "unpublished", isExternallyVisible: false },
  AccessReviewPolicy: { isGroupOwnerManagementEnabled: false },
  LifecycleWorkflowSettings: { workflowScheduleIntervalInHours: 3 },
  LifecycleWorkflows: { displayName: "TV06-TEST-Workflow", description: "Metadata", isEnabled: false, isSchedulingEnabled: false },
  DefenderCustomDetectionRules: { id: "TV06-TEST-detection", displayName: "TV06-TEST-Detection", description: "Metadata", status: "disabled", queryCondition: { queryText: "DeviceEvents | where false" }, schedule: { frequency: "P1D" }, detectionAction: { alertTemplate: { title: "Lab", description: "Lab", severity: "informational", recommendedActions: "None" } } },
}
const fixtureFor = (folder: string, operation: "create" | "update"): Item => Object.fromEntries(Object.entries(cases[folder]!).filter(([key]) => restoreMatrixRow(folder)![operation]!.properties.includes(key)))
const store = () => { const values = new Map<string, string>(); return { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value) }, delete: (key: string) => { values.delete(key) } } }
const approvalRun = { id: "test-run", tenant: "tenant", actor, origin: "restore" as const }
function approve(step: GuardedStep, run = approvalRun) { step.confirmation = { kind: configurationConfirmation(step.folder), fingerprint: configurationApproval(step, run) }; return step }

describe("verified configuration subsets and blocked candidates", () => {
  it("enables only live-verified 8c subsets and keeps all other types blocked with their specific reason", () => {
    for (const row of RESTORE_MATRIX.filter(row => isConfiguration8c(row.folder))) {
      if (["CrossTenantAccessPolicy", "AccessPackageCatalogs", "AccessReviewPolicy"].includes(row.folder)) {
        expect(restoreCapability(typeForFolder(row.folder)!)).toBe(row.configurationRestore!.capability)
        expect(row.configurationRestore!.blockedReason).toBe("")
        continue
      }
      expect(restoreCapability(typeForFolder(row.folder)!)).toBe("none")
      expect(moduleForFolder(row.folder)!.part.restore.delegated).toBe("unsupported")
      expect(row.configurationRestore!.blockedReason).toBeTruthy()
      if (!STAGED_8C_OPERATIONS[row.folder]) for (const operation of ["create", "update"] as const) expect(() => configurationPayload(row.folder, operation, {})).toThrow()
    }
  })
  for (const folder of Object.keys(cases)) {
    const row = restoreMatrixRow(folder)!
    for (const operation of ["create", "update"] as const) {
      if (!STAGED_8C_OPERATIONS[folder]?.includes(operation)) continue
      const fixture = fixtureFor(folder, operation)
      it(`${folder} ${operation}: validates its closed payload, difference and exact own confirmation`, () => {
        const snapshot = { ...fixture }
        const desired = configurationPayload(folder, operation, snapshot)
        expect(desired).toEqual(snapshot)
        expect(() => configurationPayload(folder, operation, { ...snapshot, unexpected: true })).toThrow("reviewed")
        const step: GuardedStep = { key: folder, folder, operation, sourceId: source, desired, properties: Object.keys(desired), preview: restoreFingerprint(null), requires: [] }
        expect(() => requireConfigurationApproval(step, approvalRun)).toThrow("separately")
        approve(step)
        requireConfigurationApproval(step, approvalRun)
        for (const other of [
          { ...approvalRun, id: "another-run" }, { ...approvalRun, tenant: "another-tenant" },
          { ...approvalRun, actor: { ...actor, userId: "another-admin" } },
          { ...approvalRun, source: { path: "another-backup/policy.json", fingerprint: "another-source" } },
          { ...approvalRun, origin: "sync" as const },
        ]) expect(() => requireConfigurationApproval(step, other)).toThrow("separately")
        expect(configurationDifference(step, null).map(change => change.property)).toEqual(Object.keys(desired))
        expect(() => requireConfigurationApproval({ ...step, preview: "changed" }, approvalRun)).toThrow("separately")
        expect(() => requireConfigurationApproval({ ...step, allowRemoval: true }, approvalRun)).toThrow("separately")
      })
    }
    for (const operation of ["create", "update"] as const) {
      const contract = row[operation]
      if (!contract || !STAGED_8C_OPERATIONS[folder]?.includes(operation)) continue
      const fixture = fixtureFor(folder, operation)
      for (const outcome of ["success", "timeout", "refused", "unconfirmed", "stale"] as const) it(`${folder} ${operation}: ${outcome} through the guarded transport and persistent journal`, async () => {
        const type = typeForFolder(folder)!, savedType = type.restore, savedContract = { ...contract }
        // Test-only evidence substitution. Production rows and capabilities remain blocked.
        type.restore = row.detection.kind === "singleton" ? "singleton" : "create"
        contract.index = "matched"; delete contract.blockedReason
        const need = moduleForFolder(folder)!.part.restore as { delegated: Need }, previousNeed = need.delegated
        need.delegated = [contract.permissions]
        const permissions = [...contract.permissions, "Policy.Read.All", "Policy.ReadWrite.SecurityDefaults", "Policy.ReadWrite.ConditionalAccess"]
        const token = `header.${Buffer.from(JSON.stringify({ tid: actor.tenantId, oid: actor.userId, appid: actor.clientId, scp: permissions.join(" ") })).toString("base64url")}.signature`
        const objectId = id
        const currentFixture: Item = { id: objectId, ...fixture, ...(folder === "AccessPackageCatalogs" ? { catalogType: "userManaged" } : {}), ...(folder === "UserFlowAttributes" ? { userFlowAttributeType: "custom" } : {}) }
        let writes = 0, live: Item | null = operation === "create" ? null : currentFixture
        const desired = configurationPayload(folder, operation, { ...fixture })
        const step = approve({ key: folder, folder, operation, sourceId: source, ...(operation === "update" ? { targetId: objectId } : {}), desired, properties: Object.keys(desired), preview: restoreFingerprint(live), requires: [] }, { ...approvalRun, id: `${folder}-${operation}-${outcome}` })
        if (outcome === "unconfirmed") delete step.confirmation
        const fetcher = vi.fn(async (_input: RequestInfo | URL, options?: RequestInit) => {
          if (options?.method !== "GET") {
            writes++
            if (outcome === "refused") return new Response(null, { status: 403 })
            live = { id, ...JSON.parse(String(options?.body)) }
            if (outcome === "timeout") throw new Error("Committed, answer lost")
            return Response.json(live, { status: 200 })
          }
          if (String(_input).endsWith("organization?$select=id")) return Response.json({ value: [{ id: actor.tenantId }] })
          if (String(_input).includes("/appliesTo?")) return Response.json({ value: [] })
          return String(_input).includes("?$select=id,state") ? Response.json({ value: [] }) : String(_input).endsWith(row.readPath) && row.detection.kind !== "singleton" ? Response.json({ value: live ? [live] : [] }) : live ? Response.json(live) : new Response(null, { status: 404 })
        })
        const saved = store(), journal = new GuardedRunJournal(saved)
        const run: GuardedRun = { version: 1, id: `${folder}-${operation}-${outcome}`, tenant: "tenant", actor, origin: "restore", entries: [{ step, state: "pending" }], mappings: [] }
        const io = guardedGraphIO(token, actor, async () => ({ complete: true, principals: [], applications: [] }), fetcher, async () => [])
        try {
          if (outcome === "stale") live = { ...desired, id: desired.id ?? id, changed: true }
          let result = await executeGuardedRun(journal, run, io)
          if (outcome === "timeout") {
            expect(result.run.entries[0]!.state).toBe("uncertain")
            result = await executeGuardedRun(new GuardedRunJournal(saved), run, io)
          }
          expect(result.run.entries[0]!.state).toBe(outcome === "refused" ? "failed" : ["unconfirmed", "stale"].includes(outcome) ? "blocked" : "applied")
          expect(writes).toBe(["unconfirmed", "stale"].includes(outcome) ? 0 : 1)
          if (["success", "timeout"].includes(outcome)) {
            expect(result.run.entries[0]!.before).toEqual(operation === "create" ? null : currentFixture)
            expect(result.run.entries[0]!.sent).toEqual(desired)
            expect(result.run.mappings).toHaveLength(1)
          }
        } finally { need.delegated = previousNeed; type.restore = savedType; Object.assign(contract, savedContract); if (!savedContract.blockedReason) delete contract.blockedReason }
      })
    }
  }
  it("forces workflow and detection execution off and refuses action fields, secrets and built-in attributes", () => {
    expect(configurationPayload("LifecycleWorkflows", "update", { isEnabled: true, isSchedulingEnabled: true })).toEqual({ isEnabled: false, isSchedulingEnabled: false })
    expect(configurationPayload("DefenderCustomDetectionRules", "update", { status: "enabled" })).toEqual({ status: "disabled" })
    for (const body of ([{ detectionAction: { automatedActions: {} } }, { detectionAction: { responseActions: [] } }, { queryCondition: { queryText: "x", extra: true } }, { schedule: { frequency: "PT0S" } }, { clientSecret: "secret" }] as Item[])) expect(() => configurationPayload("DefenderCustomDetectionRules", "update", body)).toThrow()
    expect(() => configurationPayload("UserFlowAttributes", "update", { description: "x", userFlowAttributeType: "builtIn" })).toThrow("Built-in")
    expect(() => configurationPayload("AccessPackageCatalogs", "create", { displayName: "x", state: "published", isExternallyVisible: true })).toThrow("unpublished")
    expect(() => configurationPayload("LifecycleWorkflows", "create", {})).toThrow("recycle-bin")
  })
})

// Enabled operations use the real production matrix and generated access. Blocked candidates
// are admitted only inside the test process, then their original contracts are restored.
for (const [folder, operations] of Object.entries(STAGED_8C_OPERATIONS)) for (const operation of operations) it(`${folder} ${operation}: uses only generated area scopes through the production service`, async () => {
  const { areaPermissions } = await import("../src/shared/services/manifest")
  const { IdentityRestoreService } = await import("../src/main/restore/service")
  const { RecoveryAccounts } = await import("../src/main/restore/safety-resolvers")
  const type = typeForFolder(folder)!, row = restoreMatrixRow(folder)!, oldCapability = type.restore
  const savedContracts = [row.create, row.update].map(contract => contract ? { ...contract } : null)
  const module = moduleForFolder(folder)!, need = module.part.restore as { delegated: Need }, oldNeed = need.delegated
  const fixture = fixtureFor(folder, operation), liveId = "00000000-0000-4000-8000-000000000003"
  if (!row.configurationRestore?.capability) {
    type.restore = row.detection.kind === "singleton" ? "singleton" : "create"
    need.delegated = [[row[operation]!.permissions[0]!]]
    for (const contract of [row.create, row.update]) if (contract) { delete contract.blockedReason; contract.index = "matched" }
  }
  try {
    const scopes = new Set(areaPermissions(module.area, "restore", "delegated"))
    const identity = { tenantId: "00000000-0000-4000-8000-000000000004", userId: source, clientId: id }
    const token = `h.${Buffer.from(JSON.stringify({ tid: identity.tenantId, oid: identity.userId, appid: identity.clientId, scp: [...scopes].join(" ") })).toString("base64url")}.s`
    let live: Item | null = operation === "create" ? null : { ...fixture, id: source, ...(folder === "AccessPackageCatalogs" ? { catalogType: "userManaged" } : {}), ...(folder === "UserFlowAttributes" ? { userFlowAttributeType: "custom" } : {}) }, writes = 0
    const forbidden: string[] = []
    const fetcher = (async (input, init) => {
      const url = new URL(String(input)), resource = url.pathname.replace(/^\/(v1\.0|beta)\//, "")
      if (!scopes.has(row[operation]!.permissions[0]!) || ![row.readPath, `${row.readPath}/${source}`, `${row.readPath}/${liveId}`].includes(resource)) { forbidden.push(resource); throw new Error("Request outside generated access") }
      if (init?.method !== "GET") { writes++; live = { ...live, ...JSON.parse(String(init?.body)), id: operation === "create" ? liveId : source }; return Response.json(live) }
      if (resource === row.readPath && row.detection.kind !== "singleton") return Response.json({ value: live ? [live] : [] })
      return live ? Response.json(live) : new Response(null, { status: 404 })
    }) as typeof fetch
    const saved = store(), journal = new GuardedRunJournal(saved)
    const service = new IdentityRestoreService(journal, new RecoveryAccounts(saved), async () => ({ ...identity, token }), fetcher)
    const request = { path: `backup/${folder}/Policy.json`, snapshot: { ...fixture, id: source, ...(folder === "CrossTenantAccessPolicy" ? { allowedCloudEndpoints: ["microsoftonline.com"] } : folder === "AccessPackageCatalogs" ? { catalogType: "userManaged", resources: [], createdDateTime: "2026-11-18T00:00:00Z" } : {}) }, origin: "restore" as const }
    const run = await service.prepare(identity.tenantId, request, operation)
    const review = await service.review(identity.tenantId, run.id)
    expect(review.kind).toBe(configurationConfirmation(folder))
    await service.confirm(identity.tenantId, run.id, review.fingerprint)
    await service.restore(identity.tenantId, { ...request, runId: run.id })
    expect(journal.load(identity.tenantId, run.id)!.entries[0]!.state).toBe("applied")
    expect(forbidden).toEqual([])
    expect(writes).toBe(1)
    expect(run.actor).not.toHaveProperty("token")
  } finally {
    type.restore = oldCapability; need.delegated = oldNeed
    for (const [i, contract] of [row.create, row.update].entries()) if (contract) { Object.assign(contract, savedContracts[i]); if (!savedContracts[i]!.blockedReason) delete contract.blockedReason }
  }
})

it.each(["LifecycleWorkflows", "DefenderCustomDetectionRules"])("%s: refuses activation at the final Graph send boundary", async folder => {
  const row = restoreMatrixRow(folder)!, contract = row.update!, savedContract = { ...contract }
  const type = typeForFolder(folder)!, previous = type.restore
  const need = moduleForFolder(folder)!.part.restore as { delegated: Need }, previousNeed = need.delegated
  type.restore = "create"; delete contract.blockedReason; contract.index = "matched"; need.delegated = [contract.permissions]
  let writes = 0
  const token = `h.${Buffer.from(JSON.stringify({ tid: actor.tenantId, oid: actor.userId, appid: actor.clientId, scp: contract.permissions.join(" ") })).toString("base64url")}.s`
  const desired: Item = folder === "LifecycleWorkflows" ? { isEnabled: true, isSchedulingEnabled: true } : { status: "enabled" }
  const step = approve({ key: folder, folder, sourceId: source, targetId: source, operation: "update", desired, properties: Object.keys(desired), preview: "", requires: [] })
  const io = guardedGraphIO(token, actor, async () => ({ complete: true, principals: [], applications: [] }), async () => { writes++; return Response.json({}) })
  try {
    await expect(io.write(step, step.desired, source, () => {}, { ...approvalRun, version: 1, entries: [], mappings: [] })).rejects.toThrow("activation requires separate approval")
    expect(writes).toBe(0)
  } finally { type.restore = previous; need.delegated = previousNeed; Object.assign(contract, savedContract) }
})

it("projects immutable attribute fields but requires positive live evidence that an update targets a custom attribute", async () => {
  expect(configurationPayload("UserFlowAttributes", "update", { id: source, displayName: "Saved", dataType: "string", userFlowAttributeType: "custom", description: "Saved description" })).toEqual({ description: "Saved description" })
  const contract = restoreMatrixRow("UserFlowAttributes")!.update!, savedContract = { ...contract }
  const need = moduleForFolder("UserFlowAttributes")!.part.restore as { delegated: Need }, previousNeed = need.delegated
  const type = typeForFolder("UserFlowAttributes")!, previous = type.restore
  delete contract.blockedReason; type.restore = "create"; need.delegated = [contract.permissions]
  const token = `h.${Buffer.from(JSON.stringify({ tid: actor.tenantId, oid: actor.userId, appid: actor.clientId, scp: contract.permissions.join(" ") })).toString("base64url")}.s`
  let writes = 0
  try {
    for (const attributeType of [undefined, "builtIn"]) {
      const current: Item = { id: source, description: "Live", ...(attributeType ? { userFlowAttributeType: attributeType } : {}) }
      const desired = { description: "Saved" }
      const step = approve({ key: "attribute", folder: "UserFlowAttributes", sourceId: source, targetId: source, operation: "update", desired, properties: ["description"], preview: restoreFingerprint(current), requires: [] })
      const io = guardedGraphIO(token, actor, async () => ({ complete: true, principals: [], applications: [] }), async (_input, init) => { if (init?.method !== "GET") writes++; return Response.json(current) })
      await expect(io.references(step, current, desired)).rejects.toThrow("custom type")
      await expect(io.write(step, desired, source, () => {}, { ...approvalRun, version: 1, entries: [], mappings: [] })).rejects.toThrow("custom type")
    }
    expect(writes).toBe(0)
  } finally { Object.assign(contract, savedContract); need.delegated = previousNeed; type.restore = previous }
})

it("keeps populated backup resources and service-default or published live catalogs outside the verified subset", async () => {
  expect(() => configurationPayload("AccessPackageCatalogs", "create", { ...cases.AccessPackageCatalogs!, resources: [{ id: source }] })).toThrow("reviewed")
  expect(() => configurationPayload("AccessPackageCatalogs", "update", { ...cases.AccessPackageCatalogs!, catalogType: "serviceDefault" })).toThrow("reviewed")
  const reader = { list: vi.fn() } as unknown as import("../src/shared/intune/read").GraphReader
  const step = { folder: "AccessPackageCatalogs" } as GuardedStep
  for (const current of [{ state: "published", isExternallyVisible: false, catalogType: "userManaged" }, { state: "unpublished", isExternallyVisible: true, catalogType: "userManaged" }, { state: "unpublished", isExternallyVisible: false, catalogType: "serviceDefault" }]) {
    await expect(checkConfigurationLockout(reader, step, current, cases.AccessPackageCatalogs!)).rejects.toThrow("user-managed")
  }
})
it("admits absent catalog index entries only with explicit documentation and verified live round-trip evidence", async () => {
  const contract = restoreMatrixRow("AccessPackageCatalogs")!.create!, evidence = contract.liveVerification
  expect(contract.index).toBe("not-matched")
  let reads = 0
  const token = `h.${Buffer.from(JSON.stringify({ tid: actor.tenantId, oid: actor.userId, appid: actor.clientId, scp: "EntitlementManagement.ReadWrite.All" })).toString("base64url")}.s`
  const io = guardedGraphIO(token, actor, async () => ({ complete: true, principals: [], applications: [] }), async () => { reads++; return Response.json({ value: [] }) })
  const step = { folder: "AccessPackageCatalogs", operation: "create", properties: contract.properties, desired: cases.AccessPackageCatalogs! } as GuardedStep
  try {
    delete contract.liveVerification
    await expect(io.read(step)).rejects.toThrow("not been verified")
    expect(reads).toBe(0)
    contract.liveVerification = evidence
    await expect(io.read(step)).resolves.toBeNull()
    expect(reads).toBe(1)
  } finally { contract.liveVerification = evidence }
})
