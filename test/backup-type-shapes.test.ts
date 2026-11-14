import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fixture, jwt, refusal, registerTestTypes, scriptedGraph, testType } from "./helpers/backup-fixture"
import { detailPath, listPath, readObject, type GraphReader } from "../src/shared/intune/read"
import type { Item } from "../src/shared/intune/registry"

/**
 * What a type can declare so the engine can read Entra ID and Defender: a Graph version, request
 * headers, a mandatory filter, a tenant-wide object in either shape Graph uses, an answer that
 * means "not configured", properties that are never stored, and sub-collections kept as sorted IDs.
 * Whether only a signed-in admin can read a type is a fact of its folder in the permission manifest.
 *
 * Every feature is proven with a test-only type; the shapes are the ones the lab tenant returned on
 * 2026-11-14 (v1.0 continuation links, the filter re-encoded in a link, the authorization policy as
 * an object in v1.0 and as a one-item list in beta, 404 Request_ResourceNotFound for a policy that was never set).
 */

const next = (path: string) => `https://graph.microsoft.com${path}`

const TYPES = {
  // v1.0, with paging.
  assignments: testType("EntraRoleAssignments", "roleManagement/directory/roleAssignments", { apiVersion: "v1.0", nameKey: "name", listOnly: true }),
  // A header on every request, and a sub-collection stored as sorted IDs.
  units: testType("AdministrativeUnits", "directory/administrativeUnits", {
    apiVersion: "v1.0",
    headers: { ConsistencyLevel: "eventual", Authorization: "Bearer stolen" },
    extras: [{ property: "members", path: (id) => `directory/administrativeUnits/${id}/members?$select=id`, ids: true }],
  }),
  // A filter Graph requires, and properties that change on their own.
  payloads: testType("DefenderAttackSimulationPayloads", "security/attackSimulation/payloads", {
    apiVersion: "v1.0",
    filter: "source eq 'tenant'",
    listQuery: "$top=2",
    listOnly: true,
    neverStored: ["lastRunDetails", "schedule.nextRunDateTime", "steps.startedAt", "id"],
  }),
  // A tenant-wide object Graph answers as the object itself, with a sub-read.
  authorization: testType("AuthorizationPolicy", "policies/authorizationPolicy", {
    apiVersion: "v1.0",
    singleton: { id: "authorizationPolicy", name: "Authorization policy" },
    neverStored: ["lastModifiedDateTime"],
    extras: [{ property: "defaultUserRoleOverrides", path: (id) => `policies/authorizationPolicy/${id}/defaultUserRoleOverrides` }],
  }),
  // The same kind of object in the shape beta uses: a list with exactly one entry.
  externalIdentities: testType("ExternalIdentitiesPolicy", "policies/externalIdentitiesPolicy", { singleton: { id: "externalIdentitiesPolicy", name: "External identities policy", collection: true } }),
  // Never set in most tenants.
  federatedToken: testType("FederatedTokenValidationPolicy", "policies/federatedTokenValidationPolicy", {
    apiVersion: "v1.0",
    singleton: { id: "federatedTokenValidationPolicy", name: "Federated token validation policy" },
    notConfigured: [{ status: 404, code: "Request_ResourceNotFound" }],
  }),
  // Only a signed-in admin can read it: the permission manifest says so for this folder.
  mdm: testType("MdmEnrollmentPolicies", "policies/mobileDeviceManagementPolicies"),
  // Keeps only some of its own properties, never stores one of them and a part of another, and reads its members apart.
  domains: testType("Domains", "domains", {
    apiVersion: "v1.0",
    keep: ["displayName", "settings", "credentials"],
    neverStored: ["credentials", "settings.secret"],
    extras: [{ property: "members", path: (id) => `domains/${id}/members?$select=id`, ids: true }],
  }),
  // The same, stored from its list entry.
  claims: testType("ClaimsMappingPolicies", "policies/claimsMappingPolicies", { apiVersion: "v1.0", listOnly: true, keep: ["displayName", "settings", "credentials"], neverStored: ["credentials", "settings.secret"] }),
}

let unregister: () => void
beforeAll(() => {
  unregister = registerTestTypes(Object.values(TYPES))
})
afterAll(() => unregister())

/** Answers for every test-only type, so a test only names what it changes. */
function graph(routes: Record<string, unknown> = {}) {
  return scriptedGraph({
    "/v1.0/roleManagement/directory/roleAssignments": { value: [] },
    "/v1.0/directory/administrativeUnits": { value: [] },
    "/v1.0/security/attackSimulation/payloads?$filter=source eq 'tenant'&$top=2": { value: [] },
    "/v1.0/policies/authorizationPolicy": { id: "authorizationPolicy", displayName: "Authorization Policy" },
    "/v1.0/policies/authorizationPolicy/authorizationPolicy/defaultUserRoleOverrides": { value: [] },
    "/beta/policies/externalIdentitiesPolicy": { value: [{ id: "externalIdentitiesPolicy", allowExternalIdentitiesToLeave: true }] },
    "/v1.0/policies/federatedTokenValidationPolicy": refusal(404, "Request_ResourceNotFound", "Resource '' does not exist or one of its queried reference-property objects are not present."),
    "/beta/policies/mobileDeviceManagementPolicies": { value: [] },
    "/v1.0/domains": { value: [] },
    "/v1.0/policies/claimsMappingPolicies": { value: [] },
    ...routes,
  })
}

const outcome = (job: { outcomes?: { types: Array<{ folder: string }> } }, folder: string) => job.outcomes!.types.find((type) => type.folder === folder)

describe("a type read from Microsoft Graph v1.0", () => {
  it("is listed, paged and stored from v1.0, while Intune stays on beta", async () => {
    const { run, requests, files, manifest } = fixture(graph({
      "/v1.0/roleManagement/directory/roleAssignments": {
        value: [{ id: "ra1", name: "First" }],
        // As the lab tenant returns it: the same version, with the query kept and a paging token added.
        "@odata.nextLink": next("/v1.0/roleManagement/directory/roleAssignments?$top=1&$skiptoken=ZWIxZDhj"),
      },
      "/v1.0/roleManagement/directory/roleAssignments?$top=1&$skiptoken=ZWIxZDhj": { value: [{ id: "ra2", name: "Second" }] },
    }))
    const job = await run()
    expect(job.status).toBe("Completed")
    expect((await files(job)).filter((name) => name.startsWith("EntraRoleAssignments/")).sort()).toEqual(["EntraRoleAssignments/First.json", "EntraRoleAssignments/Second.json"])
    expect((await manifest(job)).ItemCounts.EntraRoleAssignments).toBe(2)
    expect(outcome(job, "EntraRoleAssignments")).toMatchObject({ outcome: "saved", saved: 2, service: "entra" })
    // Nothing of Intune moved to v1.0, and nothing of the v1.0 type was asked from beta.
    expect(requests.filter((request) => request.path.includes("deviceManagement")).every((request) => request.path.startsWith("/beta/"))).toBe(true)
    expect(requests.some((request) => request.path.startsWith("/beta/roleManagement"))).toBe(false)
  })

  it.each([
    ["leaves Microsoft Graph", "https://graph.microsoft.com.attacker.example/v1.0/roleManagement/directory/roleAssignments?page=2"],
    ["names another host on the Graph path", "https://attacker.example/v1.0/roleManagement/directory/roleAssignments?page=2"],
    ["switches to another Graph version", next("/beta/roleManagement/directory/roleAssignments?page=2")],
    ["uses plain HTTP", "http://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?page=2"],
  ])("refuses a continuation link that %s, and sends the sign-in nowhere else", async (_what, link) => {
    const { run, requests, files } = fixture(graph({
      "/v1.0/roleManagement/directory/roleAssignments": { value: [{ id: "ra1", name: "First" }], "@odata.nextLink": link },
    }))
    const job = await run()
    // Only the first page was requested; the link was never followed.
    expect(requests.filter((request) => request.path.includes("roleAssignments")).map((request) => request.path)).toEqual(["/v1.0/roleManagement/directory/roleAssignments"])
    // A list that could not be read in full stores nothing of the type.
    expect((await files(job)).some((name) => name.startsWith("EntraRoleAssignments/"))).toBe(false)
    expect(outcome(job, "EntraRoleAssignments")).toMatchObject({ outcome: "failed", error: "Invalid Graph continuation link" })
  })

  it("still refuses a v1.0 continuation link for a beta list", async () => {
    const { run, requests } = fixture(graph({
      "/beta/deviceManagement/deviceCategories": { value: [{ id: "c1", displayName: "Kiosk" }], "@odata.nextLink": next("/v1.0/deviceManagement/deviceCategories?page=2") },
    }))
    const job = await run()
    expect(requests.some((request) => request.path.startsWith("/v1.0/deviceManagement"))).toBe(false)
    expect(job.failedTypes).toEqual(["DeviceCategories"])
  })
})

describe("a type with request headers", () => {
  it("sends them with the list, the object and its sub-reads, and never in place of the sign-in", async () => {
    const { run, requests } = fixture(graph({
      "/v1.0/directory/administrativeUnits": { value: [{ id: "au1", displayName: "Berlin" }], "@odata.nextLink": next("/v1.0/directory/administrativeUnits?$skiptoken=p2") },
      "/v1.0/directory/administrativeUnits?$skiptoken=p2": { value: [] },
      "/v1.0/directory/administrativeUnits/au1": { id: "au1", displayName: "Berlin" },
      "/v1.0/directory/administrativeUnits/au1/members?$select=id": { value: [] },
    }))
    const job = await run()
    expect(job.status).toBe("Completed")
    const sent = requests.filter((request) => request.path.includes("administrativeUnits"))
    expect(sent).toHaveLength(4)
    for (const request of sent) {
      expect(request.headers.get("ConsistencyLevel")).toBe("eventual")
      expect(request.headers.get("Authorization")).toBe("Bearer token")
    }
    // A type's headers stay with the type.
    expect(requests.filter((request) => request.path.includes("deviceManagement")).every((request) => request.headers.get("ConsistencyLevel") === null)).toBe(true)
  })
})

describe("a type whose list needs a filter", () => {
  it("sends the filter with the list and puts it back on a page whose link left it out", async () => {
    const { run, requests, files } = fixture(graph({
      "/v1.0/security/attackSimulation/payloads?$filter=source eq 'tenant'&$top=2": {
        value: [{ id: "p1", displayName: "One", source: "tenant" }],
        // As the lab tenant returns a filtered link: the filter kept, with + for spaces.
        "@odata.nextLink": next("/v1.0/security/attackSimulation/payloads?$filter=source+eq+%27tenant%27&$top=2&$skiptoken=A"),
      },
      "/v1.0/security/attackSimulation/payloads?$filter=source+eq+'tenant'&$top=2&$skiptoken=A": {
        value: [{ id: "p2", displayName: "Two", source: "tenant" }],
        // A link that dropped the filter would list Microsoft's own payloads, or be refused.
        "@odata.nextLink": next("/v1.0/security/attackSimulation/payloads?$top=2&$skiptoken=B"),
      },
      "/v1.0/security/attackSimulation/payloads?$top=2&$skiptoken=B&$filter=source eq 'tenant'": { value: [{ id: "p3", displayName: "Three", source: "tenant" }] },
    }))
    const job = await run()
    const pages = requests.filter((request) => request.path.includes("attackSimulation")).map((request) => request.path)
    expect(pages).toEqual([
      "/v1.0/security/attackSimulation/payloads?$filter=source eq 'tenant'&$top=2",
      // Left as Graph sent it: the filter is there.
      "/v1.0/security/attackSimulation/payloads?$filter=source+eq+'tenant'&$top=2&$skiptoken=A",
      "/v1.0/security/attackSimulation/payloads?$top=2&$skiptoken=B&$filter=source eq 'tenant'",
    ])
    expect((await files(job)).filter((name) => name.startsWith("DefenderAttackSimulationPayloads/"))).toHaveLength(3)
    expect(outcome(job, "DefenderAttackSimulationPayloads")).toMatchObject({ outcome: "saved", saved: 3, service: "defender" })
  })

  it("builds the list path from the filter and the extra query", () => {
    expect(listPath(TYPES.payloads)).toBe("security/attackSimulation/payloads?$filter=source%20eq%20'tenant'&$top=2")
    expect(listPath(TYPES.units)).toBe("directory/administrativeUnits")
  })
})

describe("a tenant-wide object", () => {
  it("is stored whole under its type's ID when Graph answers the object itself, with its sub-reads", async () => {
    const { run, file, manifest } = fixture(graph({
      "/v1.0/policies/authorizationPolicy": {
        "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#policies/authorizationPolicy/$entity",
        id: "authorizationPolicy",
        displayName: "Authorization Policy",
        allowInvitesFrom: "adminsAndGuestInviters",
        defaultUserRolePermissions: { allowedToCreateApps: false },
        lastModifiedDateTime: "2026-11-01T10:00:00Z",
      },
      "/v1.0/policies/authorizationPolicy/authorizationPolicy/defaultUserRoleOverrides": { value: [{ id: "o1", isDefault: false }] },
    }))
    const job = await run()
    expect(await file(job, "AuthorizationPolicy/Authorization policy.json")).toEqual({
      id: "authorizationPolicy",
      displayName: "Authorization Policy",
      allowInvitesFrom: "adminsAndGuestInviters",
      defaultUserRolePermissions: { allowedToCreateApps: false },
      defaultUserRoleOverrides: [{ id: "o1", isDefault: false }],
    })
    const metadata = await manifest(job)
    expect(metadata.ItemCounts.AuthorizationPolicy).toBe(1)
    expect(Object.keys(metadata.Items)).toContain("AuthorizationPolicy/authorizationPolicy")
    expect(outcome(job, "AuthorizationPolicy")).toMatchObject({ outcome: "saved", saved: 1 })
  })

  it("is stored the same way when Graph answers a list with that one object", async () => {
    const { run, file } = fixture(graph({
      "/beta/policies/externalIdentitiesPolicy": { "@odata.context": "ctx", value: [{ id: "externalIdentitiesPolicy", displayName: "External Identities Policy", allowExternalIdentitiesToLeave: true }] },
    }))
    const job = await run()
    expect(await file(job, "ExternalIdentitiesPolicy/External identities policy.json")).toEqual({ id: "externalIdentitiesPolicy", displayName: "External Identities Policy", allowExternalIdentitiesToLeave: true })
    expect(outcome(job, "ExternalIdentitiesPolicy")).toMatchObject({ outcome: "saved", saved: 1 })
  })

  it.each([
    ["no object", []],
    ["two objects", [{ id: "a" }, { id: "b" }]],
  ])("is not stored when the list holds %s, because one of them would pass for the tenant's setting", async (_what, value) => {
    const { run, files } = fixture(graph({ "/beta/policies/externalIdentitiesPolicy": { value } }))
    const job = await run()
    expect((await files(job)).some((name) => name.startsWith("ExternalIdentitiesPolicy/"))).toBe(false)
    expect(outcome(job, "ExternalIdentitiesPolicy")).toMatchObject({ outcome: "failed", saved: 0 })
    expect(job.coverage).toBe("incomplete")
  })

  it("is not stored when the list continues on another page, and the page is never asked for", async () => {
    const { run, files, requests, manifest } = fixture(graph({
      "/beta/policies/externalIdentitiesPolicy": { value: [{ id: "externalIdentitiesPolicy", allowExternalIdentitiesToLeave: true }], "@odata.nextLink": next("/beta/policies/externalIdentitiesPolicy?$skiptoken=2") },
      "/beta/policies/externalIdentitiesPolicy?$skiptoken=2": { value: [{ id: "second", allowExternalIdentitiesToLeave: false }] },
    }))
    const job = await run()
    expect((await files(job)).some((name) => name.startsWith("ExternalIdentitiesPolicy/"))).toBe(false)
    expect(requests.some((request) => request.path.includes("$skiptoken=2"))).toBe(false)
    expect(outcome(job, "ExternalIdentitiesPolicy")).toMatchObject({ outcome: "failed", saved: 0, error: expect.stringContaining("continues on another page") })
    expect(await manifest(job)).toMatchObject({ Status: "CompletedWithWarnings", Failures: 1, Coverage: "Incomplete" })
    expect((await manifest(job)).ItemCounts.ExternalIdentitiesPolicy).toBe(0)
  })

  it("keeps the properties a type names, and reads the object with the type's query", async () => {
    const reads: string[] = []
    const reader: GraphReader = { get: async (path) => (reads.push(path), { value: [{ id: "x", a: 1, b: 2, c: 3 }] }), list: async (path) => (reads.push(path), [{ id: "m2" }, { id: "m1" }]) }
    const type = testType("Organization", "organization", {
      singleton: { id: "organization", name: "Organization", properties: ["a", "b"], collection: true },
      filter: "x eq 1",
      select: "id,a,b",
      extras: [{ property: "members", path: (id) => `organization/${id}/members`, ids: true }],
    })
    expect(detailPath(type, "organization")).toBe("organization?$filter=x%20eq%201&$select=id,a,b")
    // The sub-read is addressed by the ID Graph gave the object; the snapshot is stored under the type's ID.
    expect(await readObject(type, "organization", reader)).toEqual({ id: "organization", a: 1, b: 2, members: ["m1", "m2"] })
    expect(reads).toEqual(["organization?$filter=x%20eq%201&$select=id,a,b", "organization/x/members"])
  })
})

describe("a type only a signed-in admin can read", () => {
  const reader = (excludedTypes?: string[]) => ({
    unattendedTokens: () => ({
      mode: "app-only" as const,
      graph: async () => jwt({ roles: ["Policy.Read.All", "DeviceManagementConfiguration.Read.All"] }),
      storage: async () => "storage",
      ...(excludedTypes ? { excludedTypes: async () => excludedTypes } : {}),
    }),
  })

  it("is left out of a Backup Reader run with that cause, before any request for it", async () => {
    const { run, requests, manifest } = fixture(graph(), reader())
    const job = await run({ trigger: "scheduled" })
    expect(requests.some((request) => request.path.includes("mobileDeviceManagementPolicies"))).toBe(false)
    expect(job.results!.types.find((type) => type.folder === "MdmEnrollmentPolicies")).toMatchObject({
      state: "skipped",
      reason: "Microsoft Graph lets only a signed-in admin read this type, so the Backup Reader leaves it out. Manual backups include it.",
    })
    expect(outcome(job, "MdmEnrollmentPolicies")).toMatchObject({ outcome: "skipped", cause: "signedIn" })
    const metadata = await manifest(job)
    expect(metadata.SkippedTypes).toContain("MdmEnrollmentPolicies")
    expect(metadata.Scope.Included).not.toContain("MdmEnrollmentPolicies")
    expect(metadata.Coverage).toBe("Incomplete")
  })

  it("is left out with the same cause when the Backup Reader names it among the types it does not read", async () => {
    const { run, requests, manifest } = fixture(graph(), reader(["MdmEnrollmentPolicies"]))
    const job = await run({ trigger: "scheduled" })
    expect(requests.some((request) => request.path.includes("mobileDeviceManagementPolicies"))).toBe(false)
    expect(outcome(job, "MdmEnrollmentPolicies")).toMatchObject({ outcome: "skipped", cause: "signedIn", reader: true })
    expect((await manifest(job)).AppOnlyExcludedTypes).toEqual(["MdmEnrollmentPolicies"])
  })

  it("is left out although the Backup Reader's token cannot be read", async () => {
    const { run, requests } = fixture(graph(), { unattendedTokens: () => ({ mode: "app-only", graph: async () => "opaque", storage: async () => "storage" }) })
    const job = await run({ trigger: "scheduled" })
    expect(requests.some((request) => request.path.includes("mobileDeviceManagementPolicies"))).toBe(false)
    expect(outcome(job, "MdmEnrollmentPolicies")).toMatchObject({ outcome: "skipped", cause: "signedIn" })
  })

  it("is read by a signed-in admin", async () => {
    const { run, files } = fixture(graph({
      "/beta/policies/mobileDeviceManagementPolicies": { value: [{ id: "mdm1", displayName: "Microsoft Intune" }] },
      "/beta/policies/mobileDeviceManagementPolicies/mdm1": { id: "mdm1", displayName: "Microsoft Intune", appliesTo: "all" },
    }))
    const job = await run()
    expect(await files(job)).toContain("MdmEnrollmentPolicies/Microsoft Intune.json")
    expect(outcome(job, "MdmEnrollmentPolicies")).toMatchObject({ outcome: "saved", saved: 1 })
  })
})

describe("a type the tenant never set up", () => {
  it("is recorded as not configured: nothing saved, nothing missing, no failure", async () => {
    const { run, files, manifest } = fixture(graph())
    const job = await run()
    expect(job.status).toBe("Completed")
    expect(job.progressMessage).toBe("Backup completed successfully")
    expect(job.results!.types.find((type) => type.folder === "FederatedTokenValidationPolicy")).toMatchObject({ state: "notConfigured", saved: 0, failed: 0 })
    expect(outcome(job, "FederatedTokenValidationPolicy")).toEqual({ folder: "FederatedTokenValidationPolicy", service: "entra", outcome: "notConfigured" })
    expect((await files(job)).some((name) => name.startsWith("FederatedTokenValidationPolicy/"))).toBe(false)
    const metadata = await manifest(job)
    expect(metadata).toMatchObject({ Status: "Success", Failures: 0, SkippedTypes: [], FailedTypes: [], Coverage: "Complete" })
    // Attempted and not missing: the backup covers the type, with the answer that there is nothing.
    expect(metadata.Scope.Included).toContain("FederatedTokenValidationPolicy")
    expect(job.log.join("\n")).toContain("FederatedTokenValidationPolicy (test) is not set up in this tenant.")
  })

  it("fails the type for a 404 it does not declare, so a wrong path never reads as not configured", async () => {
    const { run } = fixture(graph({ "/v1.0/policies/authorizationPolicy": refusal(404, "UnknownError", "") }))
    const job = await run()
    expect(outcome(job, "AuthorizationPolicy")).toMatchObject({ outcome: "failed", status: 404 })
    expect(job.failures).toBe(1)
    expect(job.coverage).toBe("incomplete")
  })

  it("matches a declared answer by status, code and message", async () => {
    const { run } = fixture(graph({ "/v1.0/policies/federatedTokenValidationPolicy": refusal(404, "SomethingElse", "No such segment") }))
    expect(outcome(await run(), "FederatedTokenValidationPolicy")).toMatchObject({ outcome: "failed", code: "SomethingElse" })
  })
})

describe("properties a type never stores", () => {
  const payload = (run: string, nextRun: string, started: string) => ({
    value: [{ id: "p1", displayName: "One", source: "tenant", lastRunDetails: { at: run }, schedule: { period: "24H", nextRunDateTime: nextRun }, steps: [{ name: "a", startedAt: started }, { name: "b", startedAt: started }] }],
  })

  it("are removed from the stored object, at any depth and in every entry of a list, and never the ID", async () => {
    const { run, file } = fixture(graph({ "/v1.0/security/attackSimulation/payloads?$filter=source eq 'tenant'&$top=2": payload("2026-11-01", "2026-11-02", "09:00") }))
    const job = await run()
    expect(await file(job, "DefenderAttackSimulationPayloads/One.json")).toEqual({ id: "p1", displayName: "One", source: "tenant", schedule: { period: "24H" }, steps: [{ name: "a" }, { name: "b" }] })
  })

  it("do not change the object's fingerprint, so two backups of it compare as unchanged", async () => {
    const hash = async (routes: Record<string, unknown>) => {
      const { run, manifest } = fixture(graph(routes))
      return (await manifest(await run())).Items["DefenderAttackSimulationPayloads/p1"].hash
    }
    const key = "/v1.0/security/attackSimulation/payloads?$filter=source eq 'tenant'&$top=2"
    expect(await hash({ [key]: payload("2026-11-01", "2026-11-02", "09:00") })).toBe(await hash({ [key]: payload("2026-12-24", "2026-12-25", "17:30") }))
  })
})

describe("a type that keeps only some of its properties", () => {
  const object = (credentials: string, secret: string) => ({ id: "g1", displayName: "Admins", description: "not kept", credentials, settings: { mode: "strict", secret } })
  const routes = (credentials = "hunter2", secret = "s3cret") => ({
    "/v1.0/domains": { value: [{ id: "g1", displayName: "Admins" }] },
    "/v1.0/domains/g1": object(credentials, secret),
    "/v1.0/domains/g1/members?$select=id": { value: [{ id: "u2" }, { id: "u1" }] },
  })

  it("stores the kept properties of the object itself and what its sub-reads return, and never a property it declares as never stored", async () => {
    const { run, file, requests } = fixture(graph(routes()))
    const job = await run()
    expect(await file(job, "Domains/Admins.json")).toEqual({ id: "g1", displayName: "Admins", settings: { mode: "strict" }, members: ["u1", "u2"] })
    expect(requests.map((request) => request.path)).toContain("/v1.0/domains/g1/members?$select=id")
    expect(outcome(job, "Domains")).toMatchObject({ outcome: "saved", saved: 1 })
  })

  it("leaves the never-stored values out of the fingerprint too", async () => {
    const hash = async (credentials: string, secret: string) => {
      const { run, manifest } = fixture(graph(routes(credentials, secret)))
      return (await manifest(await run())).Items["Domains/g1"].hash
    }
    expect(await hash("hunter2", "s3cret")).toBe(await hash("rotated", "changed"))
  })

  it("stores nothing of the object when a sub-read fails, instead of an object without its members", async () => {
    const { run, files } = fixture(graph({ ...routes(), "/v1.0/domains/g1/members?$select=id": refusal(400, "BadRequest", "Malformed") }))
    const job = await run()
    expect((await files(job)).some((name) => name.startsWith("Domains/"))).toBe(false)
    expect(outcome(job, "Domains")).toMatchObject({ outcome: "failed", saved: 0 })
  })

  it("removes the never-stored properties from a list entry that is stored as it was listed", async () => {
    const { run, file, manifest } = fixture(graph({ "/v1.0/policies/claimsMappingPolicies": { value: [object("hunter2", "s3cret")] } }))
    const job = await run()
    expect(await file(job, "ClaimsMappingPolicies/Admins.json")).toEqual({ id: "g1", displayName: "Admins", settings: { mode: "strict" } })
    const other = fixture(graph({ "/v1.0/policies/claimsMappingPolicies": { value: [object("rotated", "changed")] } }))
    expect((await manifest(job)).Items["ClaimsMappingPolicies/g1"].hash).toBe((await other.manifest(await other.run())).Items["ClaimsMappingPolicies/g1"].hash)
  })

  it("reads the object, then its sub-collections, and keeps a kept value Graph left out as an empty text", async () => {
    const reads: string[] = []
    const reader: GraphReader = { get: async (path) => (reads.push(path), { id: "g1", displayName: "Admins", credentials: "hunter2" }), list: async (path) => (reads.push(path), [{ id: "u1" }]) }
    expect(await readObject(TYPES.domains, "g1", reader)).toEqual({ id: "g1", displayName: "Admins", settings: "", members: ["u1"] })
    expect(reads).toEqual(["domains/g1", "domains/g1/members?$select=id"])
  })
})

describe("a sub-collection stored as IDs", () => {
  const unit = { "/v1.0/directory/administrativeUnits": { value: [{ id: "au1", displayName: "Berlin" }] }, "/v1.0/directory/administrativeUnits/au1": { id: "au1", displayName: "Berlin" } }

  it("keeps each ID once, sorted, whatever order and pages Graph returns", async () => {
    const { run, file } = fixture(graph({
      ...unit,
      "/v1.0/directory/administrativeUnits/au1/members?$select=id": { value: [{ id: "c" }, { id: "a" }], "@odata.nextLink": next("/v1.0/directory/administrativeUnits/au1/members?$select=id&$skiptoken=2") },
      "/v1.0/directory/administrativeUnits/au1/members?$select=id&$skiptoken=2": { value: [{ id: "b" }, { id: "a" }] },
    }))
    const job = await run()
    expect(await file(job, "AdministrativeUnits/Berlin.json")).toEqual({ id: "au1", displayName: "Berlin", members: ["a", "b", "c"] })
  })

  it("stores an empty list only when Graph answered that the collection is empty", async () => {
    const { run, file } = fixture(graph({ ...unit, "/v1.0/directory/administrativeUnits/au1/members?$select=id": { value: [] } }))
    expect(await file(await run(), "AdministrativeUnits/Berlin.json")).toEqual({ id: "au1", displayName: "Berlin", members: [] })
  })

  it.each([
    ["its second page cannot be read", { value: [{ id: "a" }], "@odata.nextLink": next("/v1.0/directory/administrativeUnits/au1/members?$select=id&$skiptoken=gone") }],
    ["an entry has no ID", { value: [{ id: "a" }, { displayName: "no id" }] }],
    ["Graph answers something that is not a collection", { id: "au1" }],
  ])("stores nothing of the object when %s", async (_what, members) => {
    const { run, files, manifest } = fixture(graph({ ...unit, "/v1.0/directory/administrativeUnits/au1/members?$select=id": members }))
    const job = await run()
    // No file with a shorter or empty member list: the object is missing from the backup, and the backup says so.
    expect((await files(job)).some((name) => name.startsWith("AdministrativeUnits/"))).toBe(false)
    expect(outcome(job, "AdministrativeUnits")).toMatchObject({ outcome: "failed", saved: 0 })
    expect(await manifest(job)).toMatchObject({ Status: "CompletedWithWarnings", Failures: 1, Coverage: "Incomplete" })
  })
})

describe("readObject with the new shapes", () => {
  it("removes never-stored properties from a list entry without changing the entry", async () => {
    const { listSnapshot } = await import("../src/shared/intune/read")
    const entry: Item = { id: "p1", schedule: { nextRunDateTime: "x", period: "24H" }, lastRunDetails: 1 }
    expect(listSnapshot(TYPES.payloads, entry)).toEqual({ id: "p1", schedule: { period: "24H" } })
    expect(entry).toEqual({ id: "p1", schedule: { nextRunDateTime: "x", period: "24H" }, lastRunDetails: 1 })
  })
})
