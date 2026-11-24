vi.hoisted(() => vi.stubGlobal("__TV_LAB_EXPANDED_ENTRA__", true))

import { describe, expect, it, vi } from "vitest"
import { ENTRA_5B_TYPES as TYPES, PIM_GROUP_READ_BUDGET_MS, PIM_GROUP_SCHEDULE_REQUEST_LIMIT } from "../src/shared/intune/entra"
import { INTUNE_TYPES, restoreCapability, type Item } from "../src/shared/intune/registry"
import { readEntries, readObject, listPath, graphVersion, type GraphReader } from "../src/shared/intune/read"
import { compareBackups } from "../src/shared/intune/backup-changes"
import { sameSnapshot } from "../src/shared/intune/compare"
import { adminCenterLink } from "../src/shared/intune/admin-links"
import { buildRestorePlan, buildUpdatePlan } from "../src/shared/intune/restore-plan"
import { MODULE_BY_ID, canBackUp } from "../src/shared/services/modules"
import { backupTypeUse } from "../src/shared/services/backup-use"
import { runObservation } from "../src/shared/connection-health/observe"
import { classifyAnswer } from "../src/shared/backup-outcomes"
import { compareObjects } from "../src/portal/app/api/detect-drifts/route"
import { GraphError } from "../src/main/backup/request"
import { fixture, scriptedGraph, refusal, jwt } from "./helpers/backup-fixture"
import { readEntraType, recorded, replay } from "./helpers/entra-5b"

const typeOf = (folder: string) => TYPES.find(type => type.folder === folder)!
const only = (...folders: string[]) => ({ excluded: INTUNE_TYPES.filter(type => !folders.includes(type.folder)).map(type => type.folder) })
const secretKey = /^(clientSecret|password|privateKey|sharedSecret|secretKey|tokenSeed|seed|tunnelKey|keyCredentials|passwordCredentials|secret|accessToken|refreshToken|clientAssertion|pfx|pkcs12|secretText|authenticationConfiguration|certificateData)$/i
const secretValue = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|Bearer\s+[\w.-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|<RSAKeyValue>[\s\S]*<D>|data:application\/(?:x-pkcs12|pkcs12)/i
function scan(value: unknown): void {
  if (typeof value === "string") expect(value).not.toMatch(secretValue)
  if (!value || typeof value !== "object") return
  for (const [key, entry] of Object.entries(value)) { expect(key).not.toMatch(secretKey); scan(entry) }
}

describe("Entra 5b declarations and sanitized live responses", () => {
  it("covers every folder and admits only the verified cross-tenant metadata restore", () => {
    expect(TYPES.map(type => type.folder).sort()).toEqual(MODULE_BY_ID.get("entra")!.areas.filter(area => ["externalIdentities", "roles"].includes(area.id)).flatMap(area => area.folders).sort())
    for (const type of TYPES) {
      expect(restoreCapability(type)).toBe(type.folder === "CrossTenantAccessPolicy" ? "singleton" : "none")
      expect(adminCenterLink(type.folder, "example")?.center).toBe("Entra")
      expect(() => buildRestorePlan(type, { id: "example" })).toThrow()
      expect(() => buildUpdatePlan(type, { id: "example" }, "example")).toThrow()
    }
  })

  for (const type of TYPES) it(`${type.folder}: replays its live read and scans every stored object`, async () => {
    const data = recorded(type.folder)
    const read = await readEntraType(type, replay(data, type))
    expect(read.outcome).toBe(data.outcome)
    expect(read.objects).toHaveLength(data.objectCount)
    if ("cause" in read) expect(read.cause).toBe(data.cause)
    read.objects.forEach(scan)
    if (type.folder === "RoleManagementPolicies") for (const object of read.objects) expect(object.rules).toEqual(expect.any(Array))
  })

  for (const type of TYPES) it(`${type.folder}: reads a nonempty documented shape, removes nested secrets and compares drift`, async () => {
    // Synthetic configuration supplements empty lab collections; this is not evidence of a live detail read.
    const object: Item = { id: "example", tenantId: "example", displayName: "Example", isEnabled: true, nested: [{ clientSecret: "fixture", privateKey: "fixture", settings: { password: "fixture", enabled: true } }], publicCertificate: "-----BEGIN CERTIFICATE-----\nUFVCTElD\n-----END CERTIFICATE-----" }
    const graph: GraphReader = {
      get: async () => structuredClone(object),
      list: async path => path.includes("?$select=id") ? [{ id: "z" }, { id: "a" }, { id: "z" }] : [{ id: "rule", tenantId: "tenant", enabled: true }],
    }
    const before = await readObject(type, "example", graph)
    scan(before)
    expect(before.nested).toEqual([{ settings: { enabled: true } }])
    expect(before.publicCertificate).toContain("BEGIN CERTIFICATE")
    for (const extra of type.extras ?? []) if (extra.ids) expect(before[extra.property]).toEqual(["a", "z"])
    const after = { ...before, isEnabled: false }
    expect(sameSnapshot(before, structuredClone(before))).toBe(true)
    expect(sameSnapshot(before, after)).toBe(false)
    expect(compareObjects(before, after)).toContainEqual({ field: "isEnabled", oldValue: true, newValue: false })
    expect(backupTypeUse(type)).toEqual({ policyCount: true, compare: true, hygiene: false, auditService: undefined })
  })

  for (const folder of ["PimGroupEligibilitySchedules", "PimGroupAssignmentSchedules"]) it(`${folder}: replays the separately labelled filtered permission probe`, async () => {
    const data = recorded(folder + ".probe")
    const paths = Object.keys(data.responses)
    expect(paths).toHaveLength(1)
    expect(data.responses[paths[0]!]!.status).toBe(200)
    const entries = await replay(data, typeOf(folder)).list("https://graph.microsoft.com" + paths[0])
    expect(entries).toHaveLength(data.objectCount)
    entries.forEach(scan)
  })

  it("requires group discovery access alongside schedule access without enabling group object backups", () => {
    for (const kind of ["Eligibility", "Assignment"]) {
      const folder = `PimGroup${kind}Schedules`
      const permission = `Privileged${kind}Schedule.Read.AzureADGroup`
      expect(canBackUp(folder, { kind: "application", permissions: new Set([permission]) })).toBe(false)
      expect(canBackUp(folder, { kind: "application", permissions: new Set([permission, "GroupMember.Read.All"]) })).toBe(true)
      expect(canBackUp(folder, { kind: "application", permissions: new Set(["PrivilegedAccess.Read.AzureADGroup", "GroupMember.Read.All"]) })).toBe(true)
      expect(typeOf(folder).listOnly).toBe(true)
      expect(typeOf(folder).listSource?.path).toContain("$select=id")
      const query = new URL(typeOf(folder).listSource!.path, "https://graph.microsoft.com/v1.0/")
      expect(query.searchParams.get("$filter")).toContain("DynamicMembership")
      expect(query.searchParams.get("$filter")).toContain("onPremisesSyncEnabled ne true")
      expect(typeOf(folder).headers).toMatchObject({ ConsistencyLevel: "eventual" })
    }
  })

  it("never interprets a 404 of a new endpoint or sub-read as not configured", async () => {
    for (const type of TYPES) {
      expect(type.notConfigured).toBeUndefined()
      const graph: GraphReader = { get: async () => { throw new GraphError("Not found", 404) }, list: async () => { throw new GraphError("Not found", 404) } }
      await expect(readObject(type, "example", graph)).rejects.toThrow("Not found")
    }
  })

  it("classifies unavailable features separately from missing permissions", () => {
    for (const folder of ["ApiConnectors", "UserFlowAttributes", "AuthenticationEventsFlows"]) expect(recorded(folder)).toMatchObject({ outcome: "skipped", cause: "license" })
    expect(classifyAnswer({ status: 403, code: "AADB2C", message: "requires feature: 'EnableMsGraphAuthenticationEventListener'" }, { mode: "app-only", unavailable: typeOf("AuthenticationEventsFlows").unavailable })).toEqual({ outcome: "skipped", cause: "license" })
    expect(classifyAnswer({ status: 403, message: "Missing application roles" }, { mode: "app-only" })).toEqual({ outcome: "skipped", cause: "permission" })
  })

  it("stores identity providers from the live list instead of losing an implicit provider on its detail 404", () => {
    expect(typeOf("IdentityProviders").listOnly).toBe(true)
    expect(Object.keys(recorded("IdentityProviders").responses)).toEqual(["/v1.0/identity/identityProviders"])
  })
})

const templateDetail = (path: string, id: string) => ({
  "@odata.context": `https://graph.microsoft.com/v1.0/$metadata#${path}/${id}/$entity`,
  id: "tenant-specific-id",
  templateApplicationLevel: "newPartners",
})

describe("Entra 5b engine paths", () => {
  it("reads both templates under stable distinct identities and never lists their container", async () => {
    const type = typeOf("CrossTenantAccessMtoTemplates")
    const setup = fixture(scriptedGraph(Object.fromEntries(type.staticIds!.map(id => [`/v1.0/${type.path}/${id}`, templateDetail(type.path, id)]))))
    const job = await setup.run({ scope: only(type.folder) })
    expect(job.outcomes).toMatchObject({ coverage: "complete", types: [{ outcome: "saved", saved: 2 }] })
    const files = (await setup.files(job)).filter(file => file.startsWith(type.folder + "/"))
    expect(files).toHaveLength(2)
    for (const file of files) expect((await setup.file(job, file))?.id).toBeTruthy()
    expect(setup.requests).toHaveLength(2)
  })

  it("keeps missing template coverage incomplete", async () => {
    const type = typeOf("CrossTenantAccessMtoTemplates")
    const setup = fixture(scriptedGraph({ [`/v1.0/${type.path}/${type.staticIds![0]}`]: templateDetail(type.path, type.staticIds![0]!) }))
    const job = await setup.run({ scope: only(type.folder) })
    expect(job.outcomes).toMatchObject({ coverage: "incomplete", types: [{ outcome: "failed", saved: 1 }] })
  })

  it("keys partners by tenantId, reads synchronization and never stores partner names", async () => {
    const type = typeOf("CrossTenantAccessPartners")
    const setup = fixture(scriptedGraph({
      [`/v1.0/${type.path}`]: { value: [{ tenantId: "partner" }] },
      [`/v1.0/${type.path}/partner`]: { tenantId: "partner", displayName: "Partner name", b2bCollaborationInbound: { usersAndGroups: { targets: [{ target: "group-id", targetType: "group" }] } } },
      [`/v1.0/${type.path}/partner/identitySynchronization`]: { tenantId: "partner", displayName: "Partner name", userSyncInbound: { isSyncAllowed: true } },
    }))
    const job = await setup.run({ scope: only(type.folder) })
    expect(job.outcomes).toMatchObject({ coverage: "complete", types: [{ outcome: "saved", saved: 1 }] })
    const file = (await setup.files(job)).find(file => file.startsWith(type.folder + "/"))!
    expect(await setup.file(job, file)).toMatchObject({ id: "partner", tenantId: "partner", identitySynchronization: { userSyncInbound: { isSyncAllowed: true } } })
    expect(JSON.stringify(await setup.file(job, file))).not.toContain("Partner name")
  })

  for (const folder of ["RoleManagementPolicies", "RoleManagementPolicyAssignments", "EntraRoleDefinitions", "PimAlertConfigurations"]) it(`${folder}: keeps its mandatory filter on every page`, async () => {
    const type = typeOf(folder)
    const start = listPath(type)
    const next = `https://graph.microsoft.com/${graphVersion(type)}/${type.path}?$skiptoken=example`
    const setup = fixture(scriptedGraph({
      [`/${graphVersion(type)}/${decodeURIComponent(start)}`]: { value: [], "@odata.nextLink": next },
      [`/${graphVersion(type)}/${type.path}?$skiptoken=example&$filter=${type.filter}`]: { value: [] },
    }))
    const job = await setup.run({ scope: only(folder) })
    expect(job.outcomes).toMatchObject({ coverage: "complete", types: [{ outcome: "saved", saved: 0 }] })
    expect(setup.requests).toHaveLength(2)
    expect(setup.requests.every(request => request.path.includes(`$filter=${type.filter}`))).toBe(true)
    expect(start).not.toContain("$top")
  })

  for (const folder of ["PimGroupEligibilitySchedules", "PimGroupAssignmentSchedules"]) it(`${folder}: fans out per discovered group and preserves filters on continuation pages`, async () => {
    const type = typeOf(folder)
    const setup = fixture(scriptedGraph({
      ["/v1.0/" + decodeURIComponent(type.listSource!.path)]: { value: [{ id: "a" }, { id: "b" }] },
      [`/v1.0/${type.path}?$filter=groupId eq 'a'`]: { value: [{ id: "schedule" }], "@odata.nextLink": `https://graph.microsoft.com/v1.0/${type.path}?$skiptoken=more` },
      [`/v1.0/${type.path}?$skiptoken=more&$filter=groupId eq 'a'`]: { value: [] },
      [`/v1.0/${type.path}?$filter=groupId eq 'b'`]: { value: [] },
      [`/v1.0/${type.path}/schedule`]: { id: "schedule", groupId: "a", principalId: "principal" },
    }))
    const job = await setup.run({ scope: only(folder) })
    expect(job.outcomes).toMatchObject({ coverage: "complete", types: [{ outcome: "saved", saved: 1 }] })
    expect(setup.requests).toHaveLength(4)
    expect(setup.requests.every(request => request.headers.get("Accept-Language") === "en-US")).toBe(true)
  })

  for (const status of [403, 404]) it(`does not count refused PIM discovery (${status}) as an empty covered schedule list`, async () => {
    const type = typeOf("PimGroupEligibilitySchedules")
    const setup = fixture(scriptedGraph({ ["/v1.0/" + decodeURIComponent(type.listSource!.path)]: refusal(status, "Denied", "Discovery refused") }))
    const job = await setup.run({ scope: only(type.folder) })
    expect(job.outcomes?.coverage).toBe("incomplete")
    expect(job.outcomes?.types[0]?.outcome).toBe(status === 403 ? "skipped" : "failed")
    expect(setup.requests).toHaveLength(1)
  })

  it("never applies the type's not-configured answer to a discovery error", async () => {
    const type = typeOf("PimGroupEligibilitySchedules")
    const original = type.notConfigured
    type.notConfigured = [{ status: 404 }]
    try {
      const setup = fixture(scriptedGraph({ ["/v1.0/" + decodeURIComponent(type.listSource!.path)]: refusal(404, "NotFound", "Discovery missing") }))
      const job = await setup.run({ scope: only(type.folder) })
      expect(job.outcomes).toMatchObject({ coverage: "incomplete", types: [{ outcome: "failed" }] })
    } finally { type.notConfigured = original }
  })

  it("does not read API connectors as a signed-in admin even with all permissions", async () => {
    const setup = fixture(scriptedGraph({}))
    const job = await setup.run({ scope: only("ApiConnectors") })
    expect(job.outcomes).toMatchObject({ coverage: "incomplete", types: [{ outcome: "skipped", cause: "appOnly" }] })
    expect(job.exception).toContain("needs the Backup Reader; a signed-in admin cannot read it")
    expect(job.exception).not.toContain("lack the permission")
    expect(setup.requests).toHaveLength(0)
    expect(job.results?.types[0]?.reason).toContain("Backup Reader")
    expect(runObservation(job.outcomes!).refused).toEqual([])
    expect(runObservation(job.outcomes!).unread).toEqual(["ApiConnectors"])
  })

  it("reads API connectors app-only and removes every credential configuration", async () => {
    const setup = fixture(scriptedGraph({ "/v1.0/identity/apiConnectors": { value: [{ id: "connector" }] }, "/v1.0/identity/apiConnectors/connector": { id: "connector", targetUrl: "https://example.test", authenticationConfiguration: { password: "fixture", certificate: "fixture" } } }), { unattendedTokens: () => ({ mode: "app-only", graph: async () => jwt({ roles: ["APIConnectors.Read.All"] }), storage: async () => "storage" }) })
    const job = await setup.run({ scope: only("ApiConnectors"), trigger: "scheduled" })
    expect(job.outcomes).toMatchObject({ coverage: "complete", types: [{ outcome: "saved", saved: 1 }] })
    const file = (await setup.files(job)).find(file => file.startsWith("ApiConnectors/"))!
    const saved = await setup.file(job, file)
    scan(saved)
    expect(saved).not.toHaveProperty("authenticationConfiguration")
  })

  it("reads expanded policy rule continuation pages before claiming complete coverage", async () => {
    const type = typeOf("RoleManagementPolicies")
    const setup = fixture(scriptedGraph({
      [`/v1.0/${decodeURIComponent(listPath(type))}`]: { value: [{ id: "policy" }] },
      "/v1.0/policies/roleManagementPolicies/policy?$expand=rules": { id: "policy", rules: [{ id: "rule-a", isApprovalRequired: true }], "rules@odata.nextLink": "https://graph.microsoft.com/v1.0/policies/roleManagementPolicies/policy/rules?$skiptoken=more" },
      "/v1.0/policies/roleManagementPolicies/policy/rules?$skiptoken=more": { value: [{ id: "rule-b", maximumDuration: "PT8H" }] },
    }))
    const job = await setup.run({ scope: only(type.folder) })
    expect(job.outcomes).toMatchObject({ coverage: "complete", types: [{ outcome: "saved", saved: 1 }] })
    const file = (await setup.files(job)).find(file => file.startsWith(type.folder + "/"))!
    expect((await setup.file(job, file))?.rules).toEqual([{ id: "rule-a", isApprovalRequired: true }, { id: "rule-b", maximumDuration: "PT8H" }])
  })

  for (const status of [403, 404]) it(`does not turn an unread partner synchronization (${status}) into empty complete coverage`, async () => {
    const type = typeOf("CrossTenantAccessPartners")
    const setup = fixture(scriptedGraph({
      [`/v1.0/${type.path}`]: { value: [{ tenantId: "partner" }] },
      [`/v1.0/${type.path}/partner`]: { tenantId: "partner" },
      [`/v1.0/${type.path}/partner/identitySynchronization`]: refusal(status, "NotFound", "Synchronization unread"),
    }))
    const job = await setup.run({ scope: only(type.folder) })
    expect(job.outcomes?.coverage).toBe("incomplete")
    expect(job.outcomes?.types[0]?.outcome).not.toBe("saved")
    expect(job.outcomes?.types[0]?.outcome).not.toBe("notConfigured")
    expect((await setup.files(job)).filter(file => file.startsWith(type.folder + "/"))).toEqual([])
  })

  it("rejects invalid discovery and partner identities", async () => {
    const graph: GraphReader = { get: async () => ({}), list: async () => [{}] }
    await expect(readEntries(typeOf("PimGroupEligibilitySchedules"), graph)).rejects.toThrow("scope without an ID")
    await expect(readEntries(typeOf("CrossTenantAccessPartners"), graph)).rejects.toThrow("without tenantId")
  })
})

describe("Entra 5b review regressions", () => {
  const folders = ["PimGroupEligibilitySchedules", "PimGroupAssignmentSchedules"]
  const intune = {
    "/beta/deviceManagement/deviceConfigurations": { value: [{ id: "intune", displayName: "Intune policy" }] },
    "/beta/deviceManagement/deviceConfigurations/intune?$expand=assignments": { id: "intune", displayName: "Intune policy" },
  }

  // Let the local encrypted store finish its real I/O without advancing the backup deadline.
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 10_000 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve))
    expect(predicate()).toBe(true)
  }

  it("shares discovery and caps actual schedule requests including retries and pages at 500 per type", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    try {
      const attempts = new Map<string, number>()
      const setup = fixture(async request => {
        const url = new URL(request.url)
        if (url.pathname === "/v1.0/groups") return Response.json({ value: Array.from({ length: 20_000 }, (_, i) => ({ id: `g${i}` })) })
        const type = TYPES.find(type => folders.includes(type.folder) && url.pathname.endsWith(type.path))
        if (!type) return scriptedGraph(intune)(request)
        const count = (attempts.get(type.folder) ?? 0) + 1
        attempts.set(type.folder, count)
        if (count === 1) return refusal(429, "TooManyRequests", "Throttled", { "Retry-After": "1" })()
        return Response.json({ value: [], ...(count === 2 ? { "@odata.nextLink": `https://graph.microsoft.com/v1.0/${type.path}?$skiptoken=more` } : {}) })
      })
      const pending = setup.run({ scope: only("DeviceConfigurations", ...folders) })
      await until(() => attempts.size === 2)
      await vi.advanceTimersByTimeAsync(1000)
      const job = await pending
      expect(job.status).toBe("Completed")
      expect(job.outcomes?.coverage).toBe("incomplete")
      expect(setup.requests.filter(request => request.path.startsWith("/v1.0/groups?"))).toHaveLength(1)
      for (const folder of folders) {
        expect(attempts.get(folder)).toBe(PIM_GROUP_SCHEDULE_REQUEST_LIMIT)
        expect(job.outcomes?.types.find(type => type.folder === folder)).toMatchObject({ outcome: "failed", error: expect.stringContaining("Too many groups to read within the backup's time budget") })
      }
      expect(job.outcomes?.types.find(type => type.folder === "DeviceConfigurations")).toMatchObject({ outcome: "saved", saved: 1 })
      expect((await setup.files(job)).some(file => file.startsWith("DeviceConfigurations/"))).toBe(true)
      expect(job.exception).toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it("ends only PIM types after 120 seconds of throttling and saves Intune before the run deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    try {
      const setup = fixture(async request => {
        const url = new URL(request.url)
        if (url.pathname === "/v1.0/groups") return Response.json({ value: Array.from({ length: 20_000 }, (_, i) => ({ id: `g${i}` })) })
        if (url.pathname.includes("privilegedAccess/group")) return refusal(429, "TooManyRequests", "Throttled", { "Retry-After": "60" })()
        return scriptedGraph(intune)(request)
      })
      const started = Date.now()
      const pending = setup.run({ scope: only("DeviceConfigurations", ...folders) })
      await until(() => setup.requests.filter(request => request.path.includes("privilegedAccess/group")).length === 2)
      await vi.advanceTimersByTimeAsync(PIM_GROUP_READ_BUDGET_MS)
      const job = await pending
      expect(job.status).toBe("Completed")
      expect(Date.now() - started).toBe(PIM_GROUP_READ_BUDGET_MS)
      for (const folder of folders) expect(job.outcomes?.types.find(type => type.folder === folder)).toMatchObject({ outcome: "failed", saved: 0, error: expect.stringContaining("time budget") })
      expect(job.outcomes?.types.find(type => type.folder === "DeviceConfigurations")).toMatchObject({ outcome: "saved", saved: 1 })
      expect((await setup.files(job)).some(file => file.startsWith("DeviceConfigurations/"))).toBe(true)
      expect(job.outcomes?.coverage).toBe("incomplete")
    } finally { vi.useRealTimers() }
  })

  for (const stage of ["discovery", "schedule"]) it(`cancels a pending ${stage} GET with the run`, async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    try {
      let discoverySignal: AbortSignal | undefined
      const setup = fixture(async request => {
        const url = new URL(request.url)
        if (stage === "schedule" && url.pathname === "/v1.0/groups") return Response.json({ value: [{ id: "g" }] })
        if (stage === "discovery" ? url.pathname !== "/v1.0/groups" : !url.pathname.includes("privilegedAccess/group")) return scriptedGraph(intune)(request)
        discoverySignal = request.signal
        return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))
      })
      const pending = setup.run({ scope: only("DeviceConfigurations", ...folders) })
      await until(() => !!discoverySignal)
      setup.engine.cancel(setup.engine.liveRuns("11111111-1111-1111-1111-111111111111")[0]!)
      const job = await pending
      expect(job.status).toBe("Cancelled")
      expect(discoverySignal?.aborted).toBe(true)
      expect(setup.requests.filter(request => request.path.startsWith("/v1.0/groups?"))).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it("ends throttled shared discovery within the type budget without losing Intune", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    try {
      const setup = fixture(async request => new URL(request.url).pathname === "/v1.0/groups"
        ? refusal(429, "TooManyRequests", "Throttled discovery", { "Retry-After": "60" })()
        : scriptedGraph(intune)(request))
      const pending = setup.run({ scope: only("DeviceConfigurations", ...folders) })
      await until(() => setup.requests.some(request => request.path.startsWith("/v1.0/groups?")))
      await vi.advanceTimersByTimeAsync(PIM_GROUP_READ_BUDGET_MS)
      const job = await pending
      expect(job.status).toBe("Completed")
      expect(job.outcomes?.coverage).toBe("incomplete")
      for (const folder of folders) expect(job.outcomes?.types.find(type => type.folder === folder)).toMatchObject({ outcome: "failed", error: expect.stringContaining("time budget") })
      expect(job.outcomes?.types.find(type => type.folder === "DeviceConfigurations")).toMatchObject({ outcome: "saved", saved: 1 })
    } finally { vi.useRealTimers() }
  })

  it("keeps ordered arrays and refuses malformed entries in declared unordered collections", async () => {
    const type = typeOf("RoleManagementPolicies")
    const ordered = [{ id: "z" }, { id: "a" }]
    const graph: GraphReader = { get: async () => ({ id: "p", rules: ordered, stages: ordered }), list: async () => [] }
    const snapshot = await readObject(type, "p", graph)
    expect(snapshot.rules).toEqual([...ordered].reverse())
    expect(snapshot.stages).toEqual(ordered)
    for (const rules of ["invalid", [{}], [null], ["rule"], [{ id: "" }]]) {
      await expect(readObject(type, "p", { ...graph, get: async () => ({ id: "p", rules }) })).rejects.toThrow("without id in rules")
    }
  })

  for (const folder of ["RoleManagementPolicies", "UserFlows", "MultiTenantOrganization", "CustomSecurityAttributeDefinitions"]) it(`${folder}: shuffled unordered sub-collections, including expanded pages, keep fingerprints and comparison equal`, async () => {
    const type = typeOf(folder)
    const objects: Item[] = []
    for (const reverse of [false, true]) {
      const entries = [{ id: "a", tenantId: "a", enabled: true }, { id: "b", tenantId: "b", enabled: false }]
      if (reverse) entries.reverse()
      const properties = Object.keys(type.unorderedCollections!)
      const graph: GraphReader = {
        get: async () => ({ id: "policy", ...(folder === "RoleManagementPolicies" ? { rules: [entries[0]!], "rules@odata.nextLink": "https://graph.microsoft.com/v1.0/policies/roleManagementPolicies/policy/rules?$skiptoken=next" } : {}) }),
        list: async path => path.includes("skiptoken") ? [entries[1]!] : path.includes("$select=id") ? entries : folder === "MultiTenantOrganization" ? entries.map(({ id: _id, ...tenant }) => tenant) : structuredClone(entries),
      }
      const object = await readObject(type, "policy", graph)
      for (const property of properties) expect((object[property] as Item[]).map(entry => entry[type.unorderedCollections![property]!])).toEqual(["a", "b"])
      objects.push(object)
    }
    expect(sameSnapshot(objects[0]!, objects[1]!)).toBe(true)
    expect(compareObjects(objects[0]!, objects[1]!)).toEqual([])
  })

  for (const folder of ["CrossTenantAccessPartners", "CrossTenantAccessMtoTemplates", "RoleEligibilitySchedules", "RoleAssignmentSchedules", ...folders, "RoleManagementPolicies"]) it(`${folder}: shuffling the top-level collection preserves saved fingerprints`, async () => {
    const type = typeOf(folder)
    const fingerprints = []
    for (const reverse of [false, true]) {
      const entries = [{ id: "a", tenantId: "a" }, { id: "b", tenantId: "b" }]
      if (reverse) entries.reverse()
      const setup = fixture(async request => {
        const url = new URL(request.url)
        if (url.pathname === "/v1.0/groups") return Response.json({ value: [{ id: "g" }] })
        if (url.pathname === `/v1.0/${type.path}`) return Response.json({ value: entries })
        return Response.json({ id: url.pathname.split("/").pop(), tenantId: url.pathname.split("/").pop(), ...(folder === "RoleManagementPolicies" ? { rules: reverse ? [{ id: "z" }, { id: "a" }] : [{ id: "a" }, { id: "z" }] } : {}) })
      })
      const job = await setup.run({ scope: only(folder) })
      expect(job.outcomes?.coverage).toBe("complete")
      fingerprints.push((await setup.manifest(job)).Items)
    }
    expect(fingerprints[0]).toEqual(fingerprints[1])
    expect(compareBackups({ Status: "Success", Items: fingerprints[0] }, { Status: "Success", Items: fingerprints[1] })).toEqual([])
  })

  it("keeps availability answers local to the declared type's list, including code and message", async () => {
    const type = typeOf("AuthenticationEventsFlows")
    const answer = refusal(403, "AADB2C", "requires feature: 'EnableMsGraphAuthenticationEventListener'")
    for (const [path, routes, expected] of [
      [type.path, { [`/v1.0/${type.path}`]: answer }, "license"],
      [type.path, { [`/v1.0/${type.path}`]: { value: [{ id: "a" }] }, [`/v1.0/${type.path}/a`]: answer }, "failed"],
      [typeOf(folders[0]!).path, { ["/v1.0/" + decodeURIComponent(typeOf(folders[0]!).listSource!.path)]: answer }, "permission"],
      [type.path, { [`/v1.0/${type.path}`]: refusal(403, "Forbidden", "requires feature: 'EnableMsGraphAuthenticationEventListener'") }, "permission"],
      [type.path, { [`/v1.0/${type.path}`]: refusal(403, "AADB2C", "Access denied") }, "permission"],
    ] as const) {
      const folder = TYPES.find(type => type.path === path)!.folder
      const setup = fixture(scriptedGraph(routes))
      const job = await setup.run({ scope: only(folder) })
      expect(job.outcomes?.types[0]).toMatchObject(expected === "failed" ? { outcome: "failed", status: 403 } : { outcome: "skipped", cause: expected })
    }
  })
})
