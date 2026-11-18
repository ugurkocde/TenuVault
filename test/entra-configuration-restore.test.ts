import { describe, expect, it, vi } from "vitest"
import { moduleForFolder, type Need } from "../src/shared/services/modules"
import { ENTRA_AREAS } from "../src/shared/services/entra"
import { typeForFolder, restoreCapability, type Item } from "../src/shared/intune/registry"
import { restoreMatrixRow } from "../src/shared/intune/restore-matrix"
import { canRequestRestore } from "../src/shared/services/onboarding"
import { GuardedRunJournal, executeGuardedRun, restoreFingerprint, type GuardedRun, type GuardedStep } from "../src/main/restore/guarded-run"
import { guardedGraphIO } from "../src/main/restore/graph-io"
import { CONFIGURATION_BLOCKERS, ENTRA_CONFIGURATION_FOLDERS, checkConfigurationLockout, configurationApproval, configurationConfirmation, configurationDifference, configurationPayload, requireConfigurationApproval } from "../src/main/restore/entra-configuration"

const actor = { tenantId: "tenant", userId: "admin", clientId: "client", applicationObjectId: "app", servicePrincipalId: "sp", recoveryAccountIds: [] }
const id = "00000000-0000-4000-8000-000000000001"
const source = "00000000-0000-4000-8000-000000000002"
const definitions = { TokenLifetimePolicies: [JSON.stringify({ TokenLifetimePolicy: { Version: 1, AccessTokenLifetime: "01:00:00" } })], ActivityBasedTimeoutPolicies: [JSON.stringify({ ActivityBasedTimeoutPolicy: { Version: 1, ApplicationPolicies: [{ ApplicationId: "default", WebSessionIdleTimeout: "01:00:00" }] } })] }
const cases: Record<string, Item> = {
  AuthorizationPolicy: { displayName: "TV06-TEST-Authorization" },
  SecurityDefaults: { isEnabled: false },
  AdminConsentRequestPolicy: { isEnabled: false, notifyReviewers: false, remindersEnabled: false, requestDurationInDays: 30, reviewers: [] },
  PermissionGrantPolicies: { displayName: "TV06-TEST-Consent", description: "Example" },
  TokenLifetimePolicies: { displayName: "TV06-TEST-Tokens", definition: definitions.TokenLifetimePolicies, isOrganizationDefault: false },
  ActivityBasedTimeoutPolicies: { displayName: "TV06-TEST-Timeout", definition: definitions.ActivityBasedTimeoutPolicies, isOrganizationDefault: false },
  DirectorySettings: { values: [{ name: "EnableGroupCreation", value: "false" }] },
  EntraCompanyBranding: { usernameHintText: "TV06-TEST-Example" },
  AuthenticationFlowsPolicy: { selfServiceSignUp: { isEnabled: false } },
  AuthenticationContexts: { displayName: "TV06-TEST-Context", isAvailable: false },
}
const store = () => { const values = new Map<string, string>(); return { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value) }, delete: (key: string) => { values.delete(key) } } }
function approve(step: GuardedStep) { step.confirmation = { kind: configurationConfirmation(step.folder), fingerprint: configurationApproval(step) }; return step }

describe("phase 1 configuration staging", () => {
  it("accounts for every type in exactly the two requested areas without enabling an unverified write or access request", () => {
    expect(ENTRA_CONFIGURATION_FOLDERS).toEqual(ENTRA_AREAS.slice(0, 2).flatMap(area => area.folders))
    for (const folder of ENTRA_CONFIGURATION_FOLDERS) {
      expect(cases[folder] || CONFIGURATION_BLOCKERS[folder], folder).toBeTruthy()
      expect(restoreCapability(typeForFolder(folder)!)).toBe(["AuthenticationFlowsPolicy", "EntraCompanyBranding"].includes(folder) ? "singleton" : ["TokenLifetimePolicies", "ActivityBasedTimeoutPolicies"].includes(folder) ? "create" : "none")
    }
    expect(canRequestRestore("entra")).toBe(true)
  })
  for (const [folder, reason] of Object.entries(CONFIGURATION_BLOCKERS)) it(`${folder}: keeps its unresolved or never-restorable reason`, () => {
    expect(() => configurationPayload(folder, "create", {})).toThrow(reason)
    expect(() => configurationPayload(folder, "update", {})).toThrow(reason)
  })
  for (const [folder, fixture] of Object.entries(cases)) {
    const row = restoreMatrixRow(folder)!
    for (const operation of ["create", "update"] as const) {
      if (!row[operation]) continue
      it(`${folder} ${operation}: validates its closed payload, difference and exact own confirmation`, () => {
        const snapshot = { ...fixture, ...(operation === "create" && folder === "PermissionGrantPolicies" ? { id: "TV06-TEST-permission" } : {}), ...(operation === "create" && folder === "DirectorySettings" ? { templateId: source } : {}) }
        const desired = configurationPayload(folder, operation, snapshot)
        expect(desired).toEqual(snapshot)
        expect(() => configurationPayload(folder, operation, { ...snapshot, unexpected: true })).toThrow("reviewed")
        const step: GuardedStep = { key: folder, folder, operation, sourceId: source, desired, properties: Object.keys(desired), preview: restoreFingerprint(null), requires: [] }
        expect(() => requireConfigurationApproval(step)).toThrow("separately")
        approve(step)
        requireConfigurationApproval(step)
        expect(configurationDifference(step, null).map(change => change.property)).toEqual(Object.keys(desired))
        expect(() => requireConfigurationApproval({ ...step, preview: "changed" })).toThrow("separately")
        expect(() => requireConfigurationApproval({ ...step, allowRemoval: true })).toThrow("separately")
      })
    }
    for (const operation of ["create", "update"] as const) {
      const contract = row[operation]
      if (!contract || (folder === "AuthorizationPolicy" && operation === "create")) continue
      for (const outcome of ["success", "timeout", "refused", "unconfirmed", "stale"] as const) it(`${folder} ${operation}: ${outcome} through the guarded transport and persistent journal`, async () => {
        const type = typeForFolder(folder)!, savedType = type.restore, savedContract = { ...contract }
        // Test-only evidence substitution. Production rows and capabilities remain blocked.
        type.restore = row.detection.kind === "singleton" ? "singleton" : "create"
        contract.index = "matched"; delete contract.blockedReason
        const need = moduleForFolder(folder)!.part.restore as { delegated: Need }, previousNeed = need.delegated
        need.delegated = [contract.permissions]
        const permissions = [...contract.permissions, "Policy.Read.All", "Policy.ReadWrite.SecurityDefaults", "Policy.ReadWrite.ConditionalAccess"]
        const token = `header.${Buffer.from(JSON.stringify({ tid: actor.tenantId, oid: actor.userId, appid: actor.clientId, scp: permissions.join(" ") })).toString("base64url")}.signature`
        const objectId = folder === "Organization" ? actor.tenantId : id
        let writes = 0, live: Item | null = operation === "create" ? null : { id: objectId, ...fixture }
        const desired = configurationPayload(folder, operation, { ...fixture, ...(operation === "create" && folder === "PermissionGrantPolicies" ? { id: "TV06-TEST-permission" } : {}), ...(operation === "create" && folder === "DirectorySettings" ? { templateId: source } : {}) })
        const step = approve({ key: folder, folder, operation, sourceId: source, ...(operation === "update" ? { targetId: objectId } : {}), desired, properties: Object.keys(desired), preview: restoreFingerprint(live), requires: [] })
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
            expect(result.run.entries[0]!.before).toEqual(operation === "create" ? null : { id: objectId, ...fixture })
            expect(result.run.entries[0]!.sent).toEqual(desired)
            expect(result.run.mappings).toHaveLength(1)
          }
        } finally { need.delegated = previousNeed; type.restore = savedType; Object.assign(contract, savedContract); if (!savedContract.blockedReason) delete contract.blockedReason }
      })
    }
  }
  it("refuses a different body at the final send boundary even when its properties are allowlisted", async () => {
    const type = typeForFolder("SecurityDefaults")!, previous = type.restore
    type.restore = "singleton"
    const token = `h.${Buffer.from(JSON.stringify({ tid: actor.tenantId, oid: actor.userId, appid: actor.clientId, scp: "Policy.Read.All Policy.ReadWrite.ConditionalAccess" })).toString("base64url")}.s`
    let writes = 0
    const current = { id, isEnabled: false }
    const step = approve({ key: "security", folder: "SecurityDefaults", operation: "update", sourceId: id, targetId: id, properties: ["isEnabled"], desired: { isEnabled: false }, preview: restoreFingerprint(current), requires: [] })
    const io = guardedGraphIO(token, actor, async () => ({ complete: true, principals: [], applications: [] }), async (_input, init) => { if (init?.method !== "GET") writes++; return Response.json(current) })
    const need = moduleForFolder("SecurityDefaults")!.part.restore as { delegated: Need }, previousNeed = need.delegated
    need.delegated = [["Policy.Read.All"]]
    try { await expect(io.write(step, { isEnabled: true }, id, () => {})).rejects.toThrow("confirmed configuration difference"); expect(writes).toBe(0) }
    finally { need.delegated = previousNeed; type.restore = previous }
  })
  it("projects known read-only backup properties without hiding unsupported writable configuration", () => {
    expect(configurationPayload("SecurityDefaults", "update", { id: "securityDefaults", displayName: "Security defaults", description: "Tenant state", isEnabled: false })).toEqual({ isEnabled: false })
    expect(configurationPayload("AuthenticationFlowsPolicy", "update", { id: "authenticationFlowsPolicy", displayName: "Flows", description: "Configuration", selfServiceSignUp: { isEnabled: false } })).toEqual({ selfServiceSignUp: { isEnabled: false } })
    expect(configurationPayload("AdminConsentRequestPolicy", "update", { ...cases.AdminConsentRequestPolicy, version: 3 })).toEqual(cases.AdminConsentRequestPolicy)
    expect(() => configurationPayload("AuthenticationFlowsPolicy", "update", { unknown: true })).toThrow()
  })
  it("refuses unsupported nested children, opaque definitions and incomplete replacements", () => {
    for (const [folder, snapshot] of [["AuthenticationFlowsPolicy", { selfServiceSignUp: { isEnabled: false, secret: "x" } }], ["TokenLifetimePolicies", { definition: ['{"TokenLifetimePolicy":{"Version":1,"SigningKey":"x"}}'] }], ["TokenLifetimePolicies", { definition: ["invalid"] }], ["TokenLifetimePolicies", { definition: [] }], ["PermissionGrantPolicies", { includes: [{ id: source }] }], ["PermissionGrantPolicies", { id: "microsoft-admin", displayName: "built in" }], ["AdminConsentRequestPolicy", { requestDurationInDays: 1 }], ["DirectorySettings", { values: [{ name: "x" }] }]] as Array<[string, Item]>) expect(() => configurationPayload(folder, "update", snapshot)).toThrow()
  })
  it("clears the default branding hint with the narrow role and normalizes the empty read-back", async () => {
    const scopedToken = `h.${Buffer.from(JSON.stringify({ tid: actor.tenantId, oid: actor.userId, appid: actor.clientId, scp: "Organization.Read.All OrganizationalBranding.ReadWrite.All Application.Read.All" })).toString("base64url")}.s`
    const sent: Item[] = []
    const io = guardedGraphIO(scopedToken, actor, async () => ({ complete: true, principals: [], applications: [] }), async (input, init) => {
      if (String(input).includes("?$select=id")) return Response.json({ value: [{ id: actor.tenantId }] })
      expect(new Headers(init?.headers).get("Accept-Language")).toBe("0")
      if (init?.method !== "GET") { sent.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }) }
      return Response.json({ id, usernameHintText: "" })
    })
    const desired = configurationPayload("EntraCompanyBranding", "update", { usernameHintText: "" })
    expect(desired).toEqual({ usernameHintText: null })
    const step = approve({ key: "branding", folder: "EntraCompanyBranding", operation: "update", sourceId: id, targetId: id, properties: ["usernameHintText"], desired, preview: restoreFingerprint({ id, usernameHintText: null }), requires: [] })
    await io.write(step, desired, id, () => {})
    expect(sent).toEqual([{ usernameHintText: null }])
    expect(await io.read(step, id)).toEqual({ id, usernameHintText: null })
  })
  it("refuses default, bound and unresolved token policies before changing a tenant", async () => {
    expect(() => configurationPayload("TokenLifetimePolicies", "create", { ...cases.TokenLifetimePolicies, isOrganizationDefault: true })).toThrow("Organization-default")
    const step: GuardedStep = { key: "tokens", folder: "TokenLifetimePolicies", sourceId: id, operation: "update", targetId: id, properties: [], desired: {}, preview: "", requires: [] }
    const reader = { get: vi.fn(), list: vi.fn(async () => [{ id }]) }
    await expect(checkConfigurationLockout(reader, step, { isOrganizationDefault: true }, {})).rejects.toThrow("Organization-default")
    await expect(checkConfigurationLockout(reader, step, {}, {})).rejects.toThrow("Organization-default")
    await expect(checkConfigurationLockout(reader, step, { isOrganizationDefault: false }, {})).rejects.toThrow("Bound token")
  })
  it("checks enabled Conditional Access before security defaults and refuses unresolved state and authentication lock-out", async () => {
    const step: GuardedStep = { key: "s", folder: "SecurityDefaults", sourceId: id, operation: "update", properties: ["isEnabled"], desired: { isEnabled: true }, preview: "", requires: [] }
    const reader = { get: vi.fn(), list: vi.fn(async () => [{ state: "enabled" }]) }
    await expect(checkConfigurationLockout(reader, step, { isEnabled: false }, step.desired)).rejects.toThrow("Conditional Access")
    reader.list.mockResolvedValue([{ state: "unknown" }])
    await expect(checkConfigurationLockout(reader, step, null, step.desired)).rejects.toThrow("resolved")
    reader.list.mockRejectedValue(new Error("missing read access"))
    await expect(checkConfigurationLockout(reader, step, null, step.desired)).rejects.toThrow("missing")
    for (const folder of ["AuthenticationMethodsPolicy", "AuthorizationPolicy"]) {
      await expect(checkConfigurationLockout(reader, { ...step, folder }, { isEnabled: true }, { isEnabled: false })).rejects.toThrow("usable authentication")
      await expect(checkConfigurationLockout(reader, { ...step, folder }, { isEnabled: true }, { isEnabled: true })).resolves.toBeUndefined()
    }
  })
})
