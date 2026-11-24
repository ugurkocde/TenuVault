import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ENTRA_5A_TYPES as ENTRA_TYPES } from "../src/shared/intune/entra"
import { INTUNE_TYPES, restoreCapability, type Item } from "../src/shared/intune/registry"
import { detailPath, graphVersion, organizationReader, readObject, type GraphReader } from "../src/shared/intune/read"
import { sameSnapshot } from "../src/shared/intune/compare"
import { adminCenterLink } from "../src/shared/intune/admin-links"
import { LEGACY_FOLDERS, includedTypes } from "../src/shared/intune/scope"
import { MODULE_BY_ID, moduleForFolder, signedInOnly } from "../src/shared/services/modules"
import { backupTypeUse } from "../src/shared/services/backup-use"
import { GRAPH_CLI_CLIENT_ID } from "../src/shared/tenant-connection"
import { ModuleSettings } from "../src/main/services/settings"
import { GraphSession } from "../src/main/backup/graph-session"
import { GraphError } from "../src/main/backup/request"
import { NetworkCircuit } from "../src/main/backup/engine"
import { buildRestorePlan, buildUpdatePlan } from "../src/shared/intune/restore-plan"
import { NextRequest } from "../src/main/api/next-server-shim"
import { POST as listBackups } from "../src/portal/app/api/list-backups/route"
import { POST as detectDrifts, compareObjects } from "../src/portal/app/api/detect-drifts/route"
import { CLIENT, fixture, jwt, scriptedGraph, refusal } from "./helpers/backup-fixture"
import { readEntraType, type ReadFixture } from "./helpers/entra-5a"

const recorded = (folder: string): ReadFixture => JSON.parse(readFileSync(new URL(`./fixtures/entra-5a/${folder}.json`, import.meta.url), "utf8"))
const only = (...folders: string[]) => ({ excluded: INTUNE_TYPES.filter(type => !folders.includes(type.folder)).map(type => type.folder) })
const secretKey = /^(clientSecret|password|privateKey|sharedSecret|secretKey|tokenSeed|seed|tunnelKey|keyCredentials|passwordCredentials|secret|accessToken|refreshToken|clientAssertion|pfx|pkcs12|secretText)$/i
const secretValue = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|Bearer\s+[\w.-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|<RSAKeyValue>[\s\S]*<D>|data:application\/(?:x-pkcs12|pkcs12)/i
function scan(value: unknown): void {
  if (typeof value === "string") expect(value).not.toMatch(secretValue)
  if (!value || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    const restrictions = ["passwordCredentials", "keyCredentials"].includes(key) && Array.isArray(child) && child.every(entry => entry && typeof entry === "object" && typeof entry.restrictionType === "string")
    if (!restrictions) expect(key).not.toMatch(secretKey)
    scan(child)
  }
}

function replay(data: ReadFixture, type: typeof ENTRA_TYPES[number]): GraphReader {
  const session = new GraphSession((async (input) => {
    const url = new URL(String(input))
    const answer = data.responses[url.pathname + url.search]
    if (!answer) throw new Error(`Fixture misses ${type.folder}: ${url.pathname}`)
    return Response.json(answer.body, { status: answer.status, headers: answer.headers })
  }) as typeof fetch, async () => "fixture", new NetworkCircuit(10), { service: "entra", isolated: true })
  const url = (path: string) => path.startsWith("https://") ? path : `https://graph.microsoft.com/${graphVersion(type)}/${path}`
  return { get: path => session.get(url(path), type.headers), list: path => session.list(url(path), { headers: type.headers }) as Promise<Item[]> }
}

describe("Entra 5a declarations and live fixtures", () => {
  it("covers every folder of this part with its final manifest name and no restore capability", () => {
    const wanted = MODULE_BY_ID.get("entra")!.areas.filter(area => ["tenantSettings", "authentication"].includes(area.id)).flatMap(area => area.folders)
    expect(ENTRA_TYPES.map(type => type.folder).sort()).toEqual([...wanted, "GroupLifecyclePolicies", "OwnerlessGroupPolicy"].sort())
    for (const type of ENTRA_TYPES) {
      expect(moduleForFolder(type.folder)?.module.id).toBe("entra")
      expect(restoreCapability(type)).toBe(["AuthenticationFlowsPolicy", "EntraCompanyBranding"].includes(type.folder) ? "singleton" : ["TokenLifetimePolicies", "ActivityBasedTimeoutPolicies"].includes(type.folder) ? "create" : "none")
      expect(adminCenterLink(type.folder, "example")?.center).toBe("Entra")
      expect(() => buildRestorePlan(type, { id: "example" })).toThrow()
      expect(() => buildUpdatePlan(type, { id: "example" }, "example")).toThrow()
    }
  })

  for (const type of ENTRA_TYPES) it(`${type.folder}: replays the sanitized live answer through the reader`, async () => {
    const data = recorded(type.folder)
    const result = await readEntraType(type, replay(data, type))
    expect(result.outcome).toBe(data.outcome)
    if ("cause" in result) expect(result.cause).toBe(data.cause)
    result.objects.forEach(scan)
  })

  for (const folder of ["MdmEnrollmentPolicies", "MamEnrollmentPolicies", "OnPremisesSynchronization", "OwnerlessGroupPolicy"]) it(`${folder}: reads the documented delegated shape`, async () => {
    const data = JSON.parse(readFileSync(new URL(`./fixtures/entra-5a/${folder}.documented.json`, import.meta.url), "utf8")) as ReadFixture
    const type = ENTRA_TYPES.find(type => type.folder === folder)!
    const result = await readEntraType(type, replay(data, type))
    expect(result.outcome).toBe("saved")
    expect(result.objects).toHaveLength(1)
    result.objects.forEach(scan)
    if (folder === "OwnerlessGroupPolicy") expect(result.objects[0]?.enabledGroupIds).toEqual(["example-group"])
    if (folder.startsWith("Mdm") || folder.startsWith("Mam")) expect(result.objects[0]?.includedGroups).toEqual(["a", "z"])
  })

  for (const type of ENTRA_TYPES) it(`${type.folder}: keeps configuration, removes nested secrets and compares changes`, async () => {
    // Supplement empty live lists and app-only refusals with documented object shapes. This is not a live claim.
    const object: Item = { id: "example", displayName: "Example", isEnabled: true, settings: { password: "fixture password", nested: [{ privateKey: "fixture key", enabled: true }] }, secretKey: "fixture seed", publicCertificate: "-----BEGIN CERTIFICATE-----\nUFVCTElD\n-----END CERTIFICATE-----" }
    const graph: GraphReader = {
      get: async () => type.singleton?.collection ? { value: [structuredClone(object)] } : structuredClone(object),
      list: async () => [{ id: "z" }, { id: "a" }, { id: "z" }],
    }
    const before = await readObject(type, "example", graph)
    scan(before)
    expect(before.settings).toEqual({ nested: [{ enabled: true }] })
    expect(before.publicCertificate).toContain("BEGIN CERTIFICATE")
    for (const extra of type.extras ?? []) if (extra.ids) expect(before[extra.property]).toEqual(["a", "z"])
    const after = { ...before, isEnabled: false }
    expect(sameSnapshot(before, structuredClone(before))).toBe(true)
    expect(sameSnapshot(before, after)).toBe(false)
    expect(compareObjects(before, after)).toContainEqual({ field: "isEnabled", oldValue: true, newValue: false })
    expect(backupTypeUse(type)).toEqual({ policyCount: !type.inventory, compare: true, hygiene: false, auditService: undefined })
  })

  it("keeps credential restriction definitions while excluding credential values", async () => {
    for (const folder of ["DefaultAppManagementPolicy", "AppManagementPolicies"]) {
      const type = ENTRA_TYPES.find(type => type.folder === folder)!
      const snapshot = await readObject(type, "x", { get: async () => ({ id: "x", passwordCredentials: [{ secretText: "fixture" }], applicationRestrictions: { passwordCredentials: [{ restrictionType: "passwordLifetime", maxLifetime: "P90D" }] } }), list: async () => [] })
      expect(snapshot).not.toHaveProperty("passwordCredentials")
      expect(snapshot.applicationRestrictions).toEqual({ passwordCredentials: [{ restrictionType: "passwordLifetime", maxLifetime: "P90D" }] })
    }
  })

  it("does not request a select or list the embedded authentication method configurations", () => {
    const type = ENTRA_TYPES.find(type => type.folder === "AuthenticationMethodsPolicy")!
    expect(detailPath(type, "x")).toBe("policies/authenticationMethodsPolicy")
    expect(type.extras).toBeUndefined()
    const data = recorded(type.folder)
    expect(Object.keys(data.responses)).toEqual(["/v1.0/policies/authenticationMethodsPolicy"])
  })

  it("stores customized banned password words as configuration", async () => {
    const type = ENTRA_TYPES.find(type => type.folder === "DirectorySettings")!
    const object = { id: "example", values: [{ name: "BannedPasswordList", value: "example,company" }] }
    const snapshot = await readObject(type, "example", { get: async () => structuredClone(object), list: async () => [] })
    scan(snapshot)
    expect(snapshot.values).toEqual(object.values)
  })

  it("records the signed-in-only types without claiming a delegated lab read", () => {
    expect(ENTRA_TYPES.filter(type => signedInOnly(type.folder)).map(type => type.folder)).toEqual(["MdmEnrollmentPolicies", "MamEnrollmentPolicies", "OnPremisesSynchronization", "OwnerlessGroupPolicy"])
    for (const folder of ["MdmEnrollmentPolicies", "MamEnrollmentPolicies"]) expect(recorded(folder)).toMatchObject({ outcome: "skipped", cause: "signedIn" })
  })
})

describe("Entra backup integration", () => {
  it("accepts the documented one-entry timeout policy envelope and checks its identity and page", async () => {
    const type = ENTRA_TYPES.find(type => type.folder === "ActivityBasedTimeoutPolicies")!
    const policy = { id: "policy-1", displayName: "Activity timeout", definition: [] }
    const read = (response: Item) => readObject(type, policy.id, { get: async () => structuredClone(response), list: async () => [], detailVersion: "v1.0" })
    await expect(read({ value: [{ ...policy, id: "wrong-id" }] })).rejects.toThrow("without the requested id")
    await expect(read({ value: [policy, policy] })).rejects.toThrow("did not return a single policy object")
    await expect(read({ value: [policy], "@odata.nextLink": null })).rejects.toThrow("did not return a single policy object")
    await expect(read({ value: [policy] })).resolves.toEqual(policy)
  })

  it("uses the declared version of an object envelope for a tenant-wide policy", async () => {
    const type = ENTRA_TYPES.find(type => type.folder === "FederatedTokenValidationPolicy")!
    const policy = { id: "provider-id", validatingDomains: { rootDomains: "enumerated", domainNames: ["example.test"] } }
    const backup = await readObject(type, type.singleton!.id, {
      get: async () => ({ value: structuredClone(policy) }), list: async () => [], detailVersion: "beta",
    })
    expect(backup).toEqual({ ...policy, id: type.singleton!.id })
  })

  it.each([
    ["Start now", GRAPH_CLI_CLIENT_ID, "/beta/policies/authorizationPolicy/authorizationPolicy"],
    ["own registration", CLIENT, "/v1.0/policies/authorizationPolicy"],
  ])("saves Authorization Policy through its entity route with %s", async (_method, clientId, entityPath) => {
    const policy = { id: "authorizationPolicy", displayName: "Authorization Policy", allowInvitesFrom: "everyone" }
    const overrides = "/beta/policies/authorizationPolicy/authorizationPolicy/defaultUserRoleOverrides"
    const setup = fixture(scriptedGraph({
      "/beta/policies/authorizationPolicy": { value: [policy] },
      "/beta/policies/authorizationPolicy/authorizationPolicy": policy,
      "/v1.0/policies/authorizationPolicy": policy,
      [overrides]: { value: [{ id: "override", isDefault: true }] },
    }), {
      services: () => ({ services: ["entra"] }),
      getToken: async () => jwt({ scp: "Policy.Read.All" }),
      graphCliGrant: () => new Set(["Policy.Read.All"]),
    })
    const job = await setup.run({ clientId, scope: only("AuthorizationPolicy") })
    expect(job.outcomes?.types).toEqual([{ folder: "AuthorizationPolicy", service: "entra", outcome: "saved", saved: 1 }])
    expect(job.coverage).toBe("complete")
    expect(setup.requests.map(request => request.path)).toEqual([entityPath, entityPath, overrides])
    expect(await setup.file(job, "AuthorizationPolicy/Authorization policy.json")).toMatchObject({
      id: "AuthorizationPolicy", allowInvitesFrom: "everyone", defaultUserRoleOverrides: [{ id: "override", isDefault: true }],
    })
  })

  it("backs up Directory Settings from its beta collection with Start now", async () => {
    const setup = fixture(scriptedGraph({
      "/beta/groupSettings": refusal(400, "BadRequest", "Resource not found for the segment 'groupSettings'."),
      "/beta/settings": { value: [] },
    }), {
      services: () => ({ services: ["entra"] }),
      graphCliGrant: () => new Set(["GroupSettings.Read.All"]),
    })
    const job = await setup.run({ clientId: GRAPH_CLI_CLIENT_ID, scope: only("DirectorySettings") })
    expect(job.outcomes?.types).toEqual([{ folder: "DirectorySettings", service: "entra", outcome: "saved", saved: 0 }])
    expect(job.coverage).toBe("complete")
    expect(setup.requests.map(request => request.path)).toEqual(["/beta/settings"])
  })

  it("saves a populated Directory Settings detail from beta with Start now", async () => {
    const setting = {
      id: "setting-1", displayName: "Group.Unified", templateId: "template-1",
      values: [{ name: "EnableGroupCreation", value: "false" }],
    }
    const setup = fixture(scriptedGraph({
      "/beta/settings": { value: [{ id: setting.id, displayName: setting.displayName }] },
      "/beta/settings/setting-1": { "@odata.context": "https://graph.microsoft.com/beta/$metadata#settings/$entity", ...setting },
    }), {
      services: () => ({ services: ["entra"] }),
      graphCliGrant: () => new Set(["GroupSettings.Read.All"]),
    })
    const job = await setup.run({ clientId: GRAPH_CLI_CLIENT_ID, scope: only("DirectorySettings") })
    expect(job.outcomes?.types).toEqual([{ folder: "DirectorySettings", service: "entra", outcome: "saved", saved: 1 }])
    expect(job.coverage).toBe("complete")
    expect(setup.requests.map(request => request.path)).toEqual(["/beta/settings", "/beta/settings/setting-1"])
    expect(await setup.file(job, "DirectorySettings/Group.Unified.json")).toEqual(setting)
  })

  it("keeps a pre-update everything tenant's exact folder set and sends no Entra request", async () => {
    const settings = new ModuleSettings({ get: () => null, set: () => undefined, delete: () => undefined })
    const selection = settings.selection("old-tenant")
    const expected = JSON.parse(readFileSync(new URL("./fixtures/entra-5a/legacy-everything.json", import.meta.url), "utf8")) as string[]
    expect(includedTypes({ excluded: [] }, selection).map(type => type.folder)).toEqual(expected)
    expect(LEGACY_FOLDERS.some(folder => ENTRA_TYPES.some(type => type.folder === folder))).toBe(false)
    const setup = fixture(scriptedGraph({}), { services: () => selection })
    await setup.run({ scope: { excluded: [] } })
    expect(setup.requests.every(request => request.path.startsWith("/beta/device"))).toBe(true)
  })

  it("selects the two group policies only when the opt-in Groups area is on", () => {
    const folders = (areas: string[]) => includedTypes({ excluded: [] }, { services: ["entra"], areas: { entra: areas } }).map(type => type.folder)
    expect(folders([])).not.toContain("GroupLifecyclePolicies")
    expect(folders([])).not.toContain("OwnerlessGroupPolicy")
    expect(folders(["groups"])).toEqual(INTUNE_TYPES.filter(type => moduleForFolder(type.folder)?.module.id === "entra" && (!type.volume || type.folder === "Groups")).map(type => type.folder))
  })

  it("ignores Retry-After on a successful security defaults read and keeps the singleton's full JSON", async () => {
    const type = ENTRA_TYPES.find(type => type.folder === "SecurityDefaults")!
    const data = recorded(type.folder)
    expect(data.responses["/v1.0/policies/identitySecurityDefaultsEnforcementPolicy"]?.headers).toEqual({ "retry-after": "1209600" })
    const routes = Object.fromEntries(Object.entries(data.responses).map(([key, answer]) => [key, () => Response.json(answer.body, { headers: answer.headers })]))
    const setup = fixture(scriptedGraph(routes))
    const job = await setup.run({ scope: only(type.folder) })
    expect(job.outcomes?.types).toEqual([{ folder: type.folder, service: "entra", outcome: "saved", saved: 1 }])
    expect(job.outcomes?.coverage).toBe("complete")
    const objects = (await setup.files(job)).filter(file => file.startsWith(`${type.folder}/`))
    const saved = await setup.file(job, objects[0]!)
    expect(saved?.isEnabled).toBe(false)
    expect(saved?.securityDefaultsUpsell).toBeDefined()
    scan(saved)
  })

  it("keeps every domain when federation settings are refused and marks coverage incomplete", async () => {
    const setup = fixture(scriptedGraph({
      "/v1.0/domains": { value: [{ id: "a.example.test" }, { id: "b.example.test" }] },
      ...Object.fromEntries(["a", "b"].flatMap(id => [
        [`/v1.0/domains/${id}.example.test`, { id: `${id}.example.test`, isVerified: true }],
        [`/v1.0/domains/${id}.example.test/federationConfiguration`, refusal(403, "Authorization_RequestDenied", "Insufficient privileges")],
        [`/v1.0/domains/${id}.example.test/verificationDnsRecords`, { value: [] }],
        [`/v1.0/domains/${id}.example.test/serviceConfigurationRecords`, { value: [] }],
      ])),
    }))
    const job = await setup.run({ scope: only("Domains") })
    expect(job.outcomes?.coverage).toBe("incomplete")
    const evidence = "HTTP 403, Authorization_RequestDenied"
    expect(job.log.join("\n")).toContain(`Domains (${evidence}): federationConfiguration could not be read; the parent configuration was kept.`)
    expect(job.outcomes?.types).toEqual([expect.objectContaining({ folder: "Domains", outcome: "failed", saved: 2, status: 403, code: "Authorization_RequestDenied" })])
    const objects = (await setup.files(job)).filter(file => file.startsWith("Domains/"))
    expect(objects).toHaveLength(2)
    for (const file of objects) {
      const saved = await setup.file(job, file)
      expect(saved).toMatchObject({ isVerified: true, verificationDnsRecords: [], serviceConfigurationRecords: [] })
      expect(saved).not.toHaveProperty("federationConfiguration")
    }
    const manifest = await setup.manifest(job)
    expect(manifest.Failures).toBe(2)
    expect(manifest.Outcomes[0]).toMatchObject({ Status: 403, Code: "Authorization_RequestDenied", Error: expect.stringContaining(evidence) })
  })

  for (const authenticationType of ["Managed", "Federated", undefined]) it(`treats a federation 404 as empty only for a managed domain (${authenticationType ?? "unknown"})`, async () => {
    const setup = fixture(scriptedGraph({
      "/v1.0/domains": { value: [{ id: "example.test" }] },
      "/v1.0/domains/example.test": { id: "example.test", ...(authenticationType ? { authenticationType } : {}) },
      "/v1.0/domains/example.test/federationConfiguration": refusal(404, "Request_ResourceNotFound", "Not found"),
      "/v1.0/domains/example.test/verificationDnsRecords": { value: [] },
      "/v1.0/domains/example.test/serviceConfigurationRecords": { value: [] },
    }))
    const job = await setup.run({ scope: only("Domains") })
    const files = (await setup.files(job)).filter(file => file.startsWith("Domains/"))
    expect(files).toHaveLength(1)
    const saved = await setup.file(job, files[0]!)
    if (authenticationType === "Managed") {
      expect(saved?.federationConfiguration).toEqual([])
      expect(job.outcomes).toMatchObject({ coverage: "complete", types: [{ outcome: "saved", saved: 1 }] })
    } else {
      expect(saved).not.toHaveProperty("federationConfiguration")
      expect(job.outcomes).toMatchObject({ coverage: "incomplete", types: [{ outcome: "failed", saved: 1 }] })
    }
  })

  for (const failure of ["read", "write"]) it(`records a later ${failure} failure after an optional federation refusal without claiming the parent was kept`, async () => {
    const setup = fixture(scriptedGraph({
      "/v1.0/domains": { value: [{ id: "example.test" }] },
      "/v1.0/domains/example.test": { id: "example.test", authenticationType: "Federated" },
      "/v1.0/domains/example.test/federationConfiguration": refusal(403, "Authorization_RequestDenied", "Insufficient privileges"),
      "/v1.0/domains/example.test/verificationDnsRecords": failure === "read" ? refusal(400, "BadRequest", "DNS read failed") : { value: [] },
      "/v1.0/domains/example.test/serviceConfigurationRecords": { value: [] },
    }))
    if (failure === "write") {
      const put = setup.store.put.bind(setup.store)
      vi.spyOn(setup.store, "put").mockImplementation((...args) => {
        if (args[2].includes("/Domains/")) throw new Error("Domain write failed")
        return put(...args)
      })
    }
    const job = await setup.run({ scope: only("Domains") })
    expect(job.outcomes).toMatchObject({ coverage: "incomplete", types: [{ outcome: "failed", saved: 0 }] })
    expect(job.results?.types[0]).toMatchObject({ failed: 1, saved: 0 })
    expect((await setup.files(job)).filter(file => file.startsWith("Domains/"))).toEqual([])
    expect(JSON.stringify(job)).not.toContain("the parent configuration was kept")
    const manifest = await setup.manifest(job)
    expect(manifest.Outcomes[0]).toMatchObject({ Outcome: "failed", Saved: 0 })
    expect(JSON.stringify(manifest)).not.toContain("the parent configuration was kept")
  })

  for (const failureFirst of [true, false]) it(`does not let a partial read hide another domain's failure (failure first: ${failureFirst})`, async () => {
    const setup = fixture(scriptedGraph({
      "/v1.0/domains": { value: (failureFirst ? ["a.test", "b.test"] : ["b.test", "a.test"]).map(id => ({ id })) },
      "/v1.0/domains/a.test": refusal(400, "BadRequest", "Domain read failed"),
      "/v1.0/domains/b.test": { id: "b.test", authenticationType: "Federated" },
      "/v1.0/domains/b.test/federationConfiguration": refusal(403, "Authorization_RequestDenied", "Insufficient privileges"),
      "/v1.0/domains/b.test/verificationDnsRecords": { value: [] },
      "/v1.0/domains/b.test/serviceConfigurationRecords": { value: [] },
    }), { concurrency: 1 })
    const job = await setup.run({ scope: only("Domains") })
    expect(job.outcomes).toMatchObject({ coverage: "incomplete", types: [{ outcome: "failed", saved: 1 }] })
  })

  for (const status of [403, 404]) it(`does not classify an organization resolver ${status} as absent company branding`, async () => {
    const setup = fixture(scriptedGraph({
      "/v1.0/organization?$select=id": refusal(status, "Request_ResourceNotFound", "Organization lookup failed"),
    }))
    const job = await setup.run({ scope: only("EntraCompanyBranding") })
    expect(job.outcomes?.coverage).toBe("incomplete")
    expect(job.outcomes?.types[0]?.outcome).not.toBe("notConfigured")
    expect(setup.requests.map(request => request.path)).toEqual(["/v1.0/organization?$select=id"])
    expect((await setup.manifest(job)).Coverage).toBe("Incomplete")
  })

  it("keeps permission refusals from organization resolution during an object read incomplete", async () => {
    let lookups = 0
    const setup = fixture(scriptedGraph({
      "/v1.0/organization?$select=id": () => ++lookups === 1 ? Response.json({ value: [{ id: "example" }] }) : refusal(403, "Authorization_RequestDenied", "Organization lookup denied")(),
      "/v1.0/organization/example/certificateBasedAuthConfiguration": { value: [{ id: "certificate-config" }] },
    }))
    const job = await setup.run({ scope: only("CertificateBasedAuthConfigurations") })
    expect(job.outcomes).toMatchObject({ coverage: "incomplete", types: [{ outcome: "failed", status: 403 }] })
    expect(setup.requests.map(request => request.path)).not.toContain("/v1.0/organization/example/certificateBasedAuthConfiguration/certificate-config")
  })

  it("accepts a not-configured answer from the branding endpoint itself", async () => {
    const setup = fixture(scriptedGraph({
      "/v1.0/organization?$select=id": { value: [{ id: "example" }] },
      "/v1.0/organization/example/branding": refusal(404, "Request_ResourceNotFound", "Branding not configured"),
    }))
    const job = await setup.run({ scope: only("EntraCompanyBranding") })
    expect(job.outcomes).toMatchObject({ coverage: "complete", types: [{ outcome: "notConfigured" }] })
  })

  it("requires a caller to record incomplete coverage before tolerating a refused optional sub-read", async () => {
    const type = ENTRA_TYPES.find(type => type.folder === "Domains")!
    await expect(readObject(type, "example.test", { get: async () => ({ id: "example.test" }), list: async () => { throw new GraphError("Denied", 403) } })).rejects.toThrow("Denied")
  })

  it("resolves the organization once and refuses an ambiguous organization list", async () => {
    let lists = 0
    const reader = organizationReader({ get: async path => ({ id: path }), list: async () => { lists++; return [{ id: "a/b" }] } })
    expect(await reader.get("organization/{organizationId}/branding")).toEqual({ id: "organization/a%2Fb/branding" })
    await reader.list("organization/{organizationId}/certificates")
    expect(lists).toBe(2) // One resolver request, one requested list.
    const invalid = organizationReader({ get: async () => ({}), list: async () => [] })
    await expect(invalid.get("organization/{organizationId}/branding")).rejects.toThrow("exactly one")
  })

  it("bounds branding JSON and does not store binary streams or localized streams", async () => {
    const type = ENTRA_TYPES.find(type => type.folder === "EntraCompanyBranding")!
    const graph: GraphReader = { get: async () => ({ id: "0", signInPageText: "text", bannerLogo: "binary" }), list: async () => [{ id: "0", bannerLogo: "binary", signInPageText: "text" }] }
    const snapshot = await readObject(type, "0", graph)
    expect(snapshot).not.toHaveProperty("bannerLogo")
    expect(snapshot.localizations).toEqual([{ id: "0", signInPageText: "text" }])
    await expect(readObject(type, "0", { ...graph, get: async () => ({ id: "0", signInPageText: "x".repeat(1024 * 1024) }) })).rejects.toThrow("byte limit")
  })
})


describe("two backups of every Entra 5a type", () => {
  afterEach(() => vi.unstubAllGlobals())
  it("lists configuration and inventory counts and detects each change without offering a write", async () => {
    const older = "backup-2026-11-13-120000"
    const newer = "backup-2026-11-14-120000"
    const counts = Object.fromEntries(ENTRA_TYPES.map(type => [type.folder, 1]))
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "fixture" })
      if (url.pathname.endsWith("/.tenuvault-owner.json")) return new Response(null, { status: 404 })
      if (url.pathname === "/api/revert-metadata") return Response.json({ reverts: {} })
      if (url.searchParams.get("delimiter")) return new Response([newer, older].map(id => `<BlobPrefix><Name>${id}/</Name></BlobPrefix>`).join(""))
      const prefix = url.searchParams.get("prefix")
      if (prefix) {
        const backup = prefix.split("/")[0]!
        return new Response(ENTRA_TYPES.map(type => `${backup}/${type.folder}/Example.json`).filter(file => file.startsWith(prefix)).map(file => `<Blob><Name>${file}</Name><Properties><Content-Length>100</Content-Length></Properties></Blob>`).join(""))
      }
      if (url.pathname.endsWith("/metadata.json")) return Response.json({ Status: "Success", TenantId: "11111111-1111-1111-1111-111111111111", Scope: { Included: ENTRA_TYPES.map(type => type.folder) }, ItemCounts: { ...counts, TotalPolicies: 29 } })
      return Response.json({ id: "example", displayName: "Example", isEnabled: url.pathname.includes(newer) })
    })
    const request = () => new NextRequest("http://tenuvault.internal/api/test", { method: "POST", body: JSON.stringify({ tenantId: "11111111-1111-1111-1111-111111111111", appId: "app", clientSecret: "fixture", storageAccountName: "store", subscriptionId: "local", resourceGroupName: "local" }) })
    const history = await listBackups(request())
    expect(history.status).toBe(200)
    const listing = await history.json()
    expect(listing.backups).toHaveLength(2)
    for (const backup of listing.backups) expect(backup.policyCount).toBe(29)
    const response = await detectDrifts(request())
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.drifts).toHaveLength(30)
    expect(new Set(result.drifts.map((drift: { type: string }) => drift.type))).toEqual(new Set(ENTRA_TYPES.map(type => type.label)))
    for (const drift of result.drifts) {
      expect(drift.changeType).toBe("modified")
      expect(drift.createBlocker).toBeTruthy()
      expect(drift.replaceBlocker).toBeTruthy()
    }
  })
})
