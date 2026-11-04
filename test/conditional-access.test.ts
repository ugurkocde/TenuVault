import { mkdtempSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { POST as detectDrifts } from "../src/portal/app/api/detect-drifts/route"
import { POST as restorePreview } from "../src/portal/app/api/restore-preview/route"
import { BackupEngine } from "../src/main/backup/engine"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { localStorageAccountName } from "../src/shared/constants"
import { policyChanges, policyReferences, replaceState, createState, REPORT_ONLY, uncheckedReferencesWarning } from "../src/shared/intune/conditional-access"
import { INTUNE_TYPES, restoreOrder, typeForFolder, type Item } from "../src/shared/intune/registry"
import { buildRestorePlan, buildUpdatePlan, restoreCapabilities } from "../src/shared/intune/restore-plan"
import { EVERYTHING } from "../src/shared/intune/scope"
import { Restorer, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import { checkModules, entraApiPermissionsUrl, MODULE_BY_ID, restoreAccessCommands, restorePermissionBlocker, type GrantedPermissions } from "../src/shared/services/modules"

const policies = typeForFolder("ConditionalAccessPolicies")!
const strengths = typeForFolder("AuthenticationStrengths")!
const locations = typeForFolder("NamedLocations")!

const LOCATION = "0e5a9eae-0aed-424e-91f9-3a0427c179fa"
const STRENGTH = "91c38116-a804-47cb-bd4e-c822c7646139"
const BREAK_GLASS = "4b1f6c3e-9d2a-4e8b-8f71-2c5a9e0d7b13"

/** A policy as Microsoft Graph beta returns it (shape verified with Lokka). */
const policy = (overrides: Item = {}): Item => ({
  "@odata.context": "https://graph.microsoft.com/beta/$metadata#identity/conditionalAccess/policies/$entity",
  id: "7d469816-69d4-41dd-b262-baeeac5fcda0",
  templateId: null,
  displayName: "Require MFA outside the office",
  createdDateTime: "2026-11-03T22:15:27Z",
  modifiedDateTime: null,
  state: "enabled",
  deletedDateTime: null,
  partialEnablementStrategy: null,
  sessionControls: null,
  conditions: {
    clientAppTypes: ["all"],
    applications: { includeApplications: ["All"], excludeApplications: [] },
    users: { includeUsers: ["All"], excludeUsers: [], includeGroups: [], excludeGroups: [BREAK_GLASS], includeRoles: ["62e90394-69f5-4237-9190-012177145e10"], excludeRoles: [] },
    locations: { includeLocations: ["All"], excludeLocations: [LOCATION, "AllTrusted"] },
    clientApplications: null,
  },
  grantControls: {
    operator: "OR",
    builtInControls: [],
    "authenticationStrength@odata.context": "https://graph.microsoft.com/beta/$metadata#identity/conditionalAccess/policies('x')/grantControls/authenticationStrength/$entity",
    authenticationStrength: { id: STRENGTH, displayName: "FIDO2", policyType: "custom", allowedCombinations: ["fido2"], createdDateTime: "2026-11-03T22:14:38Z" },
  },
  ...overrides,
})

const strength = (overrides: Item = {}): Item => ({
  id: STRENGTH,
  createdDateTime: "2026-11-03T22:14:38Z",
  modifiedDateTime: "2026-11-03T22:14:38Z",
  displayName: "TenuVault verify strength",
  description: "",
  policyType: "custom",
  requirementsSatisfied: "mfa",
  allowedCombinations: ["windowsHelloForBusiness", "fido2"],
  "combinationConfigurations@odata.context": "ctx",
  combinationConfigurations: [{ "@odata.type": "#microsoft.graph.fido2CombinationConfiguration", id: "9c3e2f50-b533-4577-b19b-694822e46ee3", appliesToCombinations: ["fido2"], allowedAAGUIDs: ["de1e552d-db1d-4423-a619-566b625cdc84"] }],
  ...overrides,
})

describe("Conditional Access registry types", () => {
  it("sends only what Graph accepts: no server fields or annotations, and the authentication strength as a reference", () => {
    const body = buildRestorePlan(policies, policy()).create.body
    for (const key of ["id", "templateId", "createdDateTime", "modifiedDateTime", "deletedDateTime", "@odata.context"]) expect(body).not.toHaveProperty(key)
    // The expanded object is rejected by Graph with error 1007.
    expect((body.grantControls as Item).authenticationStrength).toEqual({ id: STRENGTH })
    expect(body.grantControls).not.toHaveProperty("authenticationStrength@odata.context")
    expect(body.conditions).toEqual(policy().conditions)
  })

  it("never creates an enforced policy", () => {
    expect(buildRestorePlan(policies, policy()).create.body.state).toBe(REPORT_ONLY)
    expect(buildRestorePlan(policies, policy({ state: REPORT_ONLY })).create.body.state).toBe(REPORT_ONLY)
    expect(buildRestorePlan(policies, policy({ state: "disabled" })).create.body.state).toBe("disabled")
    expect(createState("somethingNew")).toBe(REPORT_ONLY)
  })

  it("never raises enforcement when replacing, and puts back what the backup says otherwise", () => {
    expect(replaceState("enabled", "enabled")).toBe("enabled")
    expect(replaceState("enabled", REPORT_ONLY)).toBe(REPORT_ONLY)
    expect(replaceState("enabled", "disabled")).toBe(REPORT_ONLY)
    expect(replaceState("disabled", "enabled")).toBe("disabled")
    expect(replaceState(REPORT_ONLY, "disabled")).toBe(REPORT_ONLY)
    const steps = buildUpdatePlan(policies, policy(), "p1", { current: policy({ state: "disabled" }) })
    expect(steps.map((step) => `${step.method} ${step.path}`)).toEqual(["PATCH identity/conditionalAccess/policies/p1"])
    // A PATCH of conditions merges, so the whole snapshot is sent.
    expect(steps[0]!.body).toMatchObject({ state: REPORT_ONLY, conditions: policy().conditions })
  })

  it("keeps Microsoft-managed policies for drift only", () => {
    const managed = policy({ displayName: "Microsoft-managed: Multifactor authentication for admins accessing Microsoft Admin Portals" })
    const { blocker, replaceBlocker } = restoreCapabilities(policies, managed)
    expect(blocker).toMatch(/Microsoft creates and maintains this policy/)
    expect(replaceBlocker).toMatch(/Microsoft creates and maintains this policy/)
    expect(restoreCapabilities(policies, policy())).toEqual({ blocker: undefined, replaceBlocker: undefined })
  })

  it("leaves built-in authentication strengths out and fits a restored copy's name into 30 characters", () => {
    expect(strengths.skip?.(strength({ policyType: "builtIn" }))).toBeTruthy()
    expect(strengths.skip?.(strength())).toBeUndefined()
    const body = buildRestorePlan(strengths, strength(), { prefix: "[Restored]" }).create.body
    expect(body.displayName).toBe("[Restored] TenuVault verify st")
    expect((body.displayName as string).length).toBeLessThanOrEqual(30)
    for (const key of ["policyType", "requirementsSatisfied", "id", "combinationConfigurations@odata.context"]) expect(body).not.toHaveProperty(key)
    expect(body.combinationConfigurations).toEqual([{ "@odata.type": "#microsoft.graph.fido2CombinationConfiguration", appliesToCombinations: ["fido2"], allowedAAGUIDs: ["de1e552d-db1d-4423-a619-566b625cdc84"] }])
    // A replacement fits the name too, for a backup edited to hold a longer one.
    const long = strength({ displayName: "A strength name well over thirty characters" })
    const rename = buildUpdatePlan(strengths, long, "s1", { current: long })[0]!
    expect(rename.body).toMatchObject({ displayName: "A strength name well over thir" })
  })

  it("updates an authentication strength the way Graph allows: name by PATCH, combinations by action, configurations one by one", () => {
    const live = strength({ displayName: "Renamed", allowedCombinations: ["fido2", "x509CertificateMultiFactor"], combinationConfigurations: [{ "@odata.type": "#microsoft.graph.fido2CombinationConfiguration", id: "live-config", appliesToCombinations: ["fido2"], allowedAAGUIDs: ["90a3ccdf-635c-4729-a248-9b709135078f"] }] })
    const steps = buildUpdatePlan(strengths, strength(), "s1", { current: live })
    // The FIDO2 restriction changes in place (verified in a test tenant), so a failed restore never leaves FIDO2 accepting any key.
    expect(steps.map((step) => `${step.method} ${step.path}`)).toEqual([
      "PATCH identity/conditionalAccess/authenticationStrength/policies/s1",
      "PATCH identity/conditionalAccess/authenticationStrength/policies/s1/combinationConfigurations/live-config",
      "POST identity/conditionalAccess/authenticationStrength/policies/s1/updateAllowedCombinations",
    ])
    // PATCH with allowedCombinations returns 405.
    expect(steps[0]!.body).toEqual({ displayName: "TenuVault verify strength", description: "" })
    expect(steps[1]!.body).toEqual({ "@odata.type": "#microsoft.graph.fido2CombinationConfiguration", appliesToCombinations: ["fido2"], allowedAAGUIDs: ["de1e552d-db1d-4423-a619-566b625cdc84"] })
    expect(steps[2]!.body).toEqual({ allowedCombinations: ["windowsHelloForBusiness", "fido2"] })
    // A configuration the backup does not have is removed, one it has and the live strength lacks is added.
    const certificate = { "@odata.type": "#microsoft.graph.x509CertificateCombinationConfiguration", id: "cert-config", appliesToCombinations: ["x509CertificateMultiFactor"], allowedIssuerSkis: ["A1"] }
    const swapped = buildUpdatePlan(strengths, strength(), "s1", { current: strength({ combinationConfigurations: [certificate] }) })
    expect(swapped.map((step) => `${step.method} ${step.path.split("/").slice(-2).join("/")}`)).toEqual([
      "PATCH policies/s1",
      "DELETE combinationConfigurations/cert-config",
      "POST s1/combinationConfigurations",
    ])
    // Same combinations in another order and the same configurations: only the PATCH.
    const same = buildUpdatePlan(strengths, strength(), "s1", { current: strength({ allowedCombinations: ["fido2", "windowsHelloForBusiness"], combinationConfigurations: [{ ...(strength().combinationConfigurations as Item[])[0]!, id: "other-id" }] }) })
    expect(same.map((step) => step.method)).toEqual(["PATCH"])
  })

  it("keeps a named location's type, which Graph requires on create", () => {
    const body = buildRestorePlan(locations, { "@odata.type": "#microsoft.graph.ipNamedLocation", id: LOCATION, displayName: "Office", deletedDateTime: null, isTrusted: false, ipRanges: [{ "@odata.type": "#microsoft.graph.iPv4CidrRange", cidrAddress: "203.0.113.0/24" }] }).create.body
    expect(body).toEqual({ "@odata.type": "#microsoft.graph.ipNamedLocation", displayName: "Office", isTrusted: false, ipRanges: [{ "@odata.type": "#microsoft.graph.iPv4CidrRange", cidrAddress: "203.0.113.0/24" }] })
  })

  it("restores named locations and authentication strengths before the policies that use them", () => {
    const order = restoreOrder(["b/ConditionalAccessPolicies/p.json", "b/AuthenticationStrengths/s.json", "b/NamedLocations/l.json"])
    expect(order).toEqual(["b/NamedLocations/l.json", "b/AuthenticationStrengths/s.json", "b/ConditionalAccessPolicies/p.json"])
  })

  it("finds the objects a policy points to and ignores keywords and service-wide IDs", () => {
    const references = policyReferences(policy({ grantControls: { authenticationStrength: { id: "00000000-0000-0000-0000-000000000004" } } }))
    expect(references.map((reference) => `${reference.kind}:${reference.exclude ? "exclude" : "include"}:${reference.id}`)).toEqual([
      `group:exclude:${BREAK_GLASS}`,
      "role:include:62e90394-69f5-4237-9190-012177145e10",
      `namedLocation:exclude:${LOCATION}`,
    ])
  })

  it("warns in the review when a replace removes an exclusion or keeps a policy from being enforced", () => {
    const live = policy({ state: REPORT_ONLY, conditions: { ...(policy().conditions as Item), users: { includeUsers: ["All"], excludeGroups: [BREAK_GLASS, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] } } })
    const changes = policyChanges(policy(), live)
    expect(changes.find((change) => change.label === "State")).toMatchObject({ from: REPORT_ONLY, to: "enabled", restored: false })
    expect(changes.find((change) => change.label === "Users: excludeGroups")?.warning).toMatch(/emergency access/)
  })
})

describe("Conditional Access module permissions", () => {
  const delegated = (...scopes: string[]): GrantedPermissions => ({ kind: "delegated", permissions: new Set(scopes) })

  it("backs up with the default Policy.Read.All, and restores only with the opt-in write permission", () => {
    const readOnly = checkModules(delegated("Policy.Read.All")).find((check) => check.id === "conditionalAccess")!
    expect(readOnly).toMatchObject({ backup: "ready", restore: "missing" })
    expect(readOnly.areas.find((area) => area.label === "Policies")?.missingRestore).toEqual([["Policy.ReadWrite.ConditionalAccess"]])
    const writable = checkModules(delegated("Policy.Read.All", "Policy.ReadWrite.ConditionalAccess")).find((check) => check.id === "conditionalAccess")!
    expect(writable).toMatchObject({ backup: "ready", restore: "ready" })
    // Microsoft Graph also needs Policy.Read.All to write policies.
    expect(checkModules(delegated("Policy.ReadWrite.ConditionalAccess")).find((check) => check.id === "conditionalAccess")!.areas.find((area) => area.label === "Policies")).toMatchObject({ backup: false, restore: false, missingRestore: [["Policy.Read.All"]] })
  })

  it("explains how to add the restore permission, and leads to the card that fixes it", () => {
    expect(restorePermissionBlocker("ConditionalAccessPolicies", delegated("Policy.Read.All"))).toMatch(/Policy.ReadWrite.ConditionalAccess.*Services and permissions shows how to add it/)
    expect(restorePermissionBlocker("ConditionalAccessPolicies", delegated("Policy.Read.All", "Policy.ReadWrite.ConditionalAccess"))).toBeUndefined()
  })

  it("changes the existing app registration instead of re-running the setup script, which would create a new one", () => {
    const module = MODULE_BY_ID.get("conditionalAccess")!
    const commands = restoreAccessCommands(module, "ffc10f05-e837-4803-81b1-7c4dee678c2a", "22222222-2222-2222-2222-222222222222")!.split("\n")
    expect(commands).toEqual([
      "# Adds Policy.ReadWrite.ConditionalAccess (delegated) to the TenuVault app registration 22222222-2222-2222-2222-222222222222, then grants admin consent.",
      "az login --tenant ffc10f05-e837-4803-81b1-7c4dee678c2a --allow-no-subscriptions",
      // The delegated permission ID read from the Microsoft Graph service principal.
      "az ad app permission add --id 22222222-2222-2222-2222-222222222222 --api 00000003-0000-0000-c000-000000000000 --api-permissions ad902697-1014-4ef5-81ef-2b4301988e8c=Scope",
      "az ad app permission admin-consent --id 22222222-2222-2222-2222-222222222222",
    ])
    expect(restoreAccessCommands(MODULE_BY_ID.get("intune")!, "t", "c")).toBeUndefined()
    expect(entraApiPermissionsUrl("22222222-2222-2222-2222-222222222222")).toBe("https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/22222222-2222-2222-2222-222222222222/isMSAApp~/false")
  })
})

/** A fake Graph for the Restorer: answers reads from `live`, records writes. */
function fakeGraph(live: Record<string, Item | number> = {}, writes: Array<{ method: string; path: string; body?: Item }> = []) {
  let next = 0
  const graph: GraphCall = async (method, path, body) => {
    if (method !== "GET") {
      writes.push({ method, path, body })
      const answer = live[`${method} ${path}`]
      if (typeof answer === "number") return { status: answer, body: { error: { code: "Forbidden", message: "Insufficient privileges to complete the operation." } } }
      return { status: 201, body: { id: `new-${++next}`, ...body } }
    }
    const key = path.split("?")[0]!
    const answer = live[key]
    if (typeof answer === "number") return { status: answer, body: { error: { code: answer === 404 ? "ResourceNotFound" : "Forbidden", message: "x" } } }
    if (answer) return { status: 200, body: answer }
    return { status: 404, body: { error: { code: "ResourceNotFound", message: "not found" } } }
  }
  return { graph, writes }
}

describe("Restoring Conditional Access", () => {
  const PERMITTED: GrantedPermissions = { kind: "delegated", permissions: new Set(["Policy.Read.All", "Policy.ReadWrite.ConditionalAccess"]) }
  const path = "backup-2026-11-03-120000/ConditionalAccessPolicies/Require MFA.json"

  it("stops before any write when the app registration cannot change Conditional Access", async () => {
    const { graph, writes } = fakeGraph()
    const outcome = await new Restorer(graph, { mode: "copy", assignments: false, granted: { kind: "delegated", permissions: new Set(["Policy.Read.All"]) } }).restore(path, policy())
    expect(outcome).toMatchObject({ success: false, action: "skipped" })
    expect(outcome.error).toMatch(/Policy.ReadWrite.ConditionalAccess/)
    expect(writes).toEqual([])
  })

  it("refuses a policy whose excluded group is gone, because the exclusion would protect nobody", async () => {
    const { graph, writes } = fakeGraph({ [`identity/conditionalAccess/namedLocations/${LOCATION}`]: { id: LOCATION }, [`identity/conditionalAccess/authenticationStrength/policies/${STRENGTH}`]: { id: STRENGTH } })
    const outcome = await new Restorer(graph, { mode: "copy", assignments: false, granted: PERMITTED }).restore(path, policy())
    expect(outcome).toMatchObject({ success: false, action: "skipped" })
    expect(outcome.error).toContain(`excluded group ${BREAK_GLASS}`)
    expect(writes).toEqual([])
  })

  it("creates a copy in report-only mode and says what it could not check", async () => {
    const { graph, writes } = fakeGraph({
      [`identity/conditionalAccess/namedLocations/${LOCATION}`]: { id: LOCATION },
      [`identity/conditionalAccess/authenticationStrength/policies/${STRENGTH}`]: { id: STRENGTH },
      [`groups/${BREAK_GLASS}`]: 403,
    })
    const outcome = await new Restorer(graph, { mode: "copy", assignments: false, granted: PERMITTED }).restore(path, policy())
    expect(outcome).toMatchObject({ success: true, action: "created" })
    expect(writes).toHaveLength(1)
    expect(writes[0]!.body).toMatchObject({ displayName: "[Restored] Require MFA outside the office", state: REPORT_ONLY })
    expect(outcome.adminLink).toEqual({ url: "https://entra.microsoft.com/#view/Microsoft_AAD_ConditionalAccess/PolicyBlade/policyId/new-1", center: "Entra", exact: true })
    expect(outcome.warnings?.join("\n")).toMatch(/report-only mode instead of enabled/)
    expect(outcome.warnings).toContain(`The app registration has no permission to read groups, so TenuVault did not check that excluded group ${BREAK_GLASS} still exists. Check it in Entra before you turn the policy on: an exclusion of a deleted account, such as an emergency access account, protects nobody.`)
  })

  it("says why a reference was not checked and gives advice that fits an included object", () => {
    const group = { kind: "group", id: "g1", path: "conditions.users.includeGroups", exclude: false } as const
    const user = { kind: "user", id: "u1", path: "conditions.users.includeUsers", exclude: false } as const
    expect(uncheckedReferencesWarning("forbidden", [])).toBeUndefined()
    expect(uncheckedReferencesWarning("forbidden", [group])).toBe("The app registration has no permission to read groups, so TenuVault did not check that included group g1 still exists. If it was deleted, the policy applies to fewer people than in the backup.")
    expect(uncheckedReferencesWarning("unanswered", [group, user])).toBe("Microsoft did not answer when TenuVault checked that included group g1 and included user u1 still exist. If one was deleted, the policy applies to fewer people than in the backup.")
    expect(uncheckedReferencesWarning("forbidden", [group, user, { ...user, id: "u2", exclude: true }])).toMatch(/^The app registration has no permission to read groups and users, so TenuVault did not check that included group g1, included user u1 and excluded user u2 still exist\. Check them in Entra/)
  })

  it("points a policy at the named location and authentication strength recreated earlier in the same restore", async () => {
    const { graph, writes } = fakeGraph({ [`groups/${BREAK_GLASS}`]: { id: BREAK_GLASS } })
    const restorer = new Restorer(graph, { mode: "copy", assignments: false, granted: PERMITTED })
    await restorer.restore("b/NamedLocations/Office.json", { "@odata.type": "#microsoft.graph.ipNamedLocation", id: LOCATION, displayName: "Office", ipRanges: [] })
    await restorer.restore("b/AuthenticationStrengths/FIDO2.json", strength())
    const outcome = await restorer.restore(path, policy())
    expect(outcome.success).toBe(true)
    const body = writes[2]!.body!
    expect(((body.conditions as Item).locations as Item).excludeLocations).toEqual(["new-1", "AllTrusted"])
    expect((body.grantControls as Item).authenticationStrength).toEqual({ id: "new-2" })
  })

  it("explains a refusal by Microsoft with the permission and the roles that are needed", async () => {
    const { graph } = fakeGraph({ [`groups/${BREAK_GLASS}`]: { id: BREAK_GLASS }, [`identity/conditionalAccess/namedLocations/${LOCATION}`]: { id: LOCATION }, [`identity/conditionalAccess/authenticationStrength/policies/${STRENGTH}`]: { id: STRENGTH }, "POST identity/conditionalAccess/policies": 403 })
    const outcome = await new Restorer(graph, { mode: "copy", assignments: false }).restore(path, policy())
    expect(outcome.success).toBe(false)
    expect(outcome.error).toMatch(/Policy.Read.All and Policy.ReadWrite.ConditionalAccess/)
    expect(outcome.error).toMatch(/Conditional Access Administrator or Security Administrator/)
  })

  it("does not copy a policy to another tenant while it names users, groups or locations of this one", async () => {
    const { graph, writes } = fakeGraph()
    const outcome = await new Restorer(graph, { mode: "copy", assignments: false, prefix: "", crossTenant: true, granted: PERMITTED }).restore(path, policy())
    expect(outcome.success).toBe(false)
    expect(outcome.error).toMatch(/exist only in the source tenant/)
    expect(writes).toEqual([])
  })

  it("never overwrites a Microsoft-managed policy in place", async () => {
    const managed = policy({ displayName: "Microsoft-managed: Block legacy authentication" })
    const { graph, writes } = fakeGraph({ [`identity/conditionalAccess/policies/${managed.id}`]: { ...managed, state: "disabled" } })
    const outcome = await new Restorer(graph, { mode: "replace", assignments: false, granted: PERMITTED }).restore(path, managed)
    expect(outcome.success).toBe(false)
    expect(outcome.error).toMatch(/Microsoft creates and maintains this policy/)
    expect(writes).toEqual([])
  })
})

describe("Backing up Conditional Access", () => {
  const TENANT = "11111111-1111-1111-1111-111111111111"
  const ACCOUNT = localStorageAccountName(TENANT)
  const jwt = (scp: string) => `e30.${Buffer.from(JSON.stringify({ scp })).toString("base64url")}.sig`

  function setup(options: { modules: Array<"conditionalAccess">; scopes: string }) {
    const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-ca-")), [randomBytes(32)])
    const graphPaths: string[] = []
    const engine = new BackupEngine({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
        const graphPath = decodeURIComponent(url.pathname)
        graphPaths.push(graphPath)
        if (graphPath === "/beta/identity/conditionalAccess/policies") return Response.json({ value: [{ id: "p1", displayName: "Require MFA" }] })
        if (graphPath === "/beta/identity/conditionalAccess/policies/p1") return Response.json(policy({ id: "p1", displayName: "Require MFA" }))
        if (graphPath === "/beta/identity/conditionalAccess/authenticationStrength/policies") return Response.json({ value: [strength({ id: "00000000-0000-0000-0000-000000000002", policyType: "builtIn" })] })
        if (graphPath.startsWith("/beta/")) return Response.json({ value: [] })
        throw new Error(`unexpected ${url}`)
      }) as typeof fetch,
      getToken: async () => jwt(options.scopes),
      enabledModules: () => options.modules,
      now: () => new Date("2026-11-03T02:00:00Z"),
    })
    const run = async () => {
      const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: "22222222-2222-2222-2222-222222222222", storageAccountName: ACCOUNT, scope: EVERYTHING, trigger: "manual" }))
      const metadata = JSON.parse((await store.get(ACCOUNT, "intune-backups", `${job.backupFolder}/metadata.json`)).data.toString())
      return { job, metadata }
    }
    return { run, graphPaths }
  }

  it("leaves Conditional Access out while the service is off for the tenant", async () => {
    const { run, graphPaths } = setup({ modules: [], scopes: "Policy.Read.All DeviceManagementConfiguration.ReadWrite.All" })
    const { metadata } = await run()
    expect(graphPaths.some((graphPath) => graphPath.includes("conditionalAccess"))).toBe(false)
    expect(metadata.Scope.Included).not.toContain("ConditionalAccessPolicies")
  })

  it("backs up policies once the service is on, without the built-in authentication strengths", async () => {
    const { run } = setup({ modules: ["conditionalAccess"], scopes: "Policy.Read.All DeviceManagementConfiguration.ReadWrite.All" })
    const { job, metadata } = await run()
    expect(metadata.ItemCounts.ConditionalAccessPolicies).toBe(1)
    expect(metadata.ItemCounts.AuthenticationStrengths).toBe(0)
    expect(metadata.Items["ConditionalAccessPolicies/p1"]).toBeTruthy()
    expect(job.log.join("\n")).toContain("1 built-in skipped")
  })

  it("names the missing permission instead of failing when the service is on but not permitted", async () => {
    const { run, graphPaths } = setup({ modules: ["conditionalAccess"], scopes: "DeviceManagementConfiguration.ReadWrite.All" })
    const { job, metadata } = await run()
    expect(graphPaths.some((graphPath) => graphPath.includes("conditionalAccess/policies"))).toBe(false)
    expect(job.log.join("\n")).toContain("Leaving out Conditional Access policies: the TenuVault app registration has no Policy.Read.All permission for Entra Conditional Access. Services and permissions in Settings shows how to add it.")
    expect(metadata.Scope.Included).not.toContain("ConditionalAccessPolicies")
    // Recorded like a denied read, so coverage, completeness and Backup Details see it.
    expect(metadata.SkippedTypes).toEqual(expect.arrayContaining(["NamedLocations", "AuthenticationStrengths", "ConditionalAccessPolicies"]))
    expect(metadata.Failures).toBe(0)
  })
})

describe("Conditional Access in a drift scan", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reports a removed exclusion as critical and offers a revert", async () => {
    const older = "backup-2026-11-02-020000"
    const newer = "backup-2026-11-03-020000"
    const file = "ConditionalAccessPolicies/Require MFA.json"
    const withoutExclusion = policy({ conditions: { ...(policy().conditions as Item), users: { includeUsers: ["All"], excludeUsers: [], includeGroups: [], excludeGroups: [], includeRoles: [], excludeRoles: [] } } })
    const contents: Record<string, Item> = { [older]: policy(), [newer]: withoutExclusion }
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "test" })
      if (url.pathname === "/api/revert-metadata") return Response.json({ reverts: {} })
      if (url.searchParams.get("delimiter")) return new Response([newer, older].map((name) => `<BlobPrefix><Name>${name}/</Name></BlobPrefix>`).join(""))
      const prefix = url.searchParams.get("prefix")
      if (prefix) return new Response(`<Blob><Name>${prefix.split("/")[0]}/${file}</Name></Blob>`)
      if (url.pathname.endsWith("/metadata.json")) return Response.json({ Status: "Success", Scope: { Excluded: [], Included: INTUNE_TYPES.map((type) => type.folder) } })
      return Response.json(contents[decodeURIComponent(url.pathname).split("/")[2]!])
    }))
    const body = { tenantId: "tenant", appId: "app", clientSecret: "test", storageAccountName: "store", subscriptionId: "local", resourceGroupName: "local" }
    const response = await detectDrifts(new NextRequest("http://tenuvault.internal/api/test", { method: "POST", body: JSON.stringify(body) }))
    expect(response.status).toBe(200)
    const { drifts } = await response.json()
    expect(drifts).toHaveLength(1)
    expect(drifts[0]).toMatchObject({ type: "Conditional Access policies", changeType: "modified", severity: "critical" })
    expect(drifts[0].changes.some((change: { field: string }) => change.field.startsWith("conditions.users.excludeGroups"))).toBe(true)
    expect(drifts[0].replaceBlocker).toBeUndefined()
  })
})

describe("Conditional Access in the restore review", () => {
  afterEach(() => vi.unstubAllGlobals())
  const jwt = (scp: string) => `e30.${Buffer.from(JSON.stringify({ scp })).toString("base64url")}.sig`

  async function preview(scopes: string) {
    const backupId = "backup-2026-11-04-114043"
    const path = `${backupId}/ConditionalAccessPolicies/Block legacy auth.json`
    const graph: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: jwt(scopes) })
      if (url.hostname === "graph.microsoft.com") graph.push(url.pathname)
      if (decodeURIComponent(url.pathname) === `/intune-backups/${path}`) return Response.json(policy(), { headers: { "x-tenuvault-authenticated": "true" } })
      return new Response("", { status: 404 })
    }))
    const body = { tenantId: "tenant", appId: "app", clientSecret: "test", storageAccountName: "store", backupId, paths: [path] }
    const response = await restorePreview(new NextRequest("http://tenuvault.internal/api/restore-preview", { method: "POST", body: JSON.stringify(body) }))
    expect(response.status).toBe(200)
    return { item: (await response.json()).items[0], graph }
  }

  it("shows a policy as not restorable before the restore starts when the write permission is missing", async () => {
    const { item, graph } = await preview("Policy.Read.All")
    expect(item.blocker).toMatch(/needs the Policy\.ReadWrite\.ConditionalAccess permission.*Services and permissions/)
    expect(item.replaceBlocker).toBe(item.blocker)
    // The check reads the token only; it sends nothing to Microsoft Graph.
    expect(graph).toEqual([])
  })

  it("offers the policy once the permission is granted", async () => {
    const { item } = await preview("Policy.Read.All Policy.ReadWrite.ConditionalAccess")
    expect(item.blocker).toBeUndefined()
    expect(item.replaceBlocker).toBeUndefined()
  })
})
