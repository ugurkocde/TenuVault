import { mkdtempSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BackupEngine } from "../src/main/backup/engine"
import { requireServiceAccess } from "../src/main/services/access"
import { ModuleSettings } from "../src/main/services/settings"
import { servicesStatus } from "../src/main/services/status"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { Restorer, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import { localStorageAccountName } from "../src/shared/constants"
import { INTUNE_TYPES, type Item } from "../src/shared/intune/registry"
import { DEFAULT_SCOPE, EVERYTHING, LEGACY_FOLDERS, type BackupScope } from "../src/shared/intune/scope"
import { disabledFolders, MODULES, restorePermissionBlocker, type GrantedPermissions, type ModuleId } from "../src/shared/services/modules"
import { memoryStore } from "./helpers"

const KEY = "services.modules"
/** A tenant ID with letters, so its case matters. */
const TENANT = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d"
const ACCOUNT = localStorageAccountName(TENANT)
const jwt = (scp: string) => `e30.${Buffer.from(JSON.stringify({ scp })).toString("base64url")}.sig`

/**
 * The folders the 0.5 release backs up, in its order: Intune, then Conditional Access. Written out
 * here, not read from the registry, so a type added later cannot change what "before the update" means.
 */
const INTUNE_FOLDERS = [
  "DeviceConfigurations", "ConfigurationPolicies", "GroupPolicyConfigurations", "ReusablePolicySettings", "HardwareConfigurations",
  "CompliancePolicies", "ComplianceSettingsPolicies", "ComplianceScripts", "CompliancePolicySettings", "EndpointSecurityIntents",
  "PowerShellScripts", "ShellScripts", "CustomAttributeScripts", "Remediations", "FeatureUpdateProfiles", "QualityUpdateProfiles",
  "QualityUpdatePolicies", "DriverUpdateProfiles", "AppCategories", "Apps", "AppConfigurationPolicies", "ManagedAppConfigurations",
  "AppProtectionIOS", "AppProtectionAndroid", "AppProtectionWindows", "PolicySets", "EnrollmentConfigurations", "AutopilotProfiles",
  "AutopilotDevices", "AppleEnrollmentProfiles", "AppleAutomatedEnrollment", "AndroidEnrollmentProfiles", "DeviceCategories",
  "TermsAndConditions", "AssignmentFilters", "ScopeTags", "RoleDefinitions", "NotificationTemplates", "Branding", "DeviceCleanupRules",
  "MultiAdminApprovalPolicies",
]
const CONDITIONAL_ACCESS_FOLDERS = ["NamedLocations", "AuthenticationStrengths", "ConditionalAccessPolicies"]

/** What the 0.5 release selected: every Intune folder in the scope, and Conditional Access only when the tenant had it on. */
const selectedBefore = (scope: BackupScope, conditionalAccess: boolean) =>
  [...INTUNE_FOLDERS, ...(conditionalAccess ? CONDITIONAL_ACCESS_FOLDERS : [])].filter((folder) => !scope.excluded.includes(folder))

const storeWith = (value: string | null) => {
  const store = memoryStore()
  if (value !== null) store.set(KEY, value)
  return store
}

/** Runs one backup with everything permitted and reports what it selected and which Graph paths it read. */
async function backup(settings: ModuleSettings, scope: BackupScope, tenantId = TENANT) {
  const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-services-")), [randomBytes(32)])
  const graphPaths: string[] = []
  const engine = new BackupEngine({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
      graphPaths.push(decodeURIComponent(url.pathname))
      return Response.json({ value: [] })
    }) as typeof fetch,
    getToken: async () => jwt("Policy.Read.All DeviceManagementConfiguration.ReadWrite.All"),
    services: (tenant) => settings.selection(tenant),
    now: () => new Date("2026-11-14T02:00:00Z"),
  })
  const job = await engine.waitForJob(engine.start({ tenantId, clientId: "22222222-2222-2222-2222-222222222222", storageAccountName: ACCOUNT, scope, trigger: "manual" }))
  const metadata = JSON.parse((await store.get(ACCOUNT, "intune-backups", `${job.backupFolder}/metadata.json`)).data.toString()) as { Status: string; Scope: { Included: string[] } }
  return { job, included: metadata.Scope.Included, status: metadata.Status, graphPaths }
}

const intuneRead = (paths: string[]) => paths.filter((path) => path.startsWith("/beta/deviceManagement") || path.startsWith("/beta/deviceAppManagement"))

describe("The folders this test calls the 0.5 release", () => {
  it("are the registry's folders at the layer base, and the legacy list has not grown", () => {
    expect([...INTUNE_FOLDERS, ...CONDITIONAL_ACCESS_FOLDERS]).toEqual(INTUNE_TYPES.map((type) => type.folder))
    // Backups without a recorded type list covered exactly these 39 folders. A folder added here would count as covered by them.
    expect(LEGACY_FOLDERS).toEqual([
      "DeviceConfigurations", "ConfigurationPolicies", "GroupPolicyConfigurations", "ReusablePolicySettings", "HardwareConfigurations",
      "CompliancePolicies", "ComplianceSettingsPolicies", "ComplianceScripts", "EndpointSecurityIntents", "PowerShellScripts", "ShellScripts",
      "CustomAttributeScripts", "Remediations", "FeatureUpdateProfiles", "QualityUpdateProfiles", "QualityUpdatePolicies", "DriverUpdateProfiles",
      "AppCategories", "Apps", "AppConfigurationPolicies", "ManagedAppConfigurations", "AppProtectionIOS", "AppProtectionAndroid",
      "AppProtectionWindows", "PolicySets", "EnrollmentConfigurations", "AutopilotProfiles", "AppleEnrollmentProfiles", "AppleAutomatedEnrollment",
      "AndroidEnrollmentProfiles", "DeviceCategories", "TermsAndConditions", "AssignmentFilters", "ScopeTags", "RoleDefinitions",
      "NotificationTemplates", "Branding", "DeviceCleanupRules", "MultiAdminApprovalPolicies",
    ])
  })
})

/** Settings as the 0.5 release stored them, or as they can be found on disk, with what that release backed up for them. */
const FIXTURES: Array<{ name: string; stored: string | null; conditionalAccess: boolean; readAs?: string }> = [
  { name: "nothing stored", stored: null, conditionalAccess: false },
  { name: "Conditional Access on", stored: JSON.stringify({ [TENANT]: { conditionalAccess: { enabled: true, connection: "default" } } }), conditionalAccess: true },
  { name: "Conditional Access off", stored: JSON.stringify({ [TENANT]: { conditionalAccess: { enabled: false, connection: "default" } } }), conditionalAccess: false },
  { name: "corrupt JSON", stored: "{not json", conditionalAccess: false },
  { name: "a stored value that is not an object", stored: JSON.stringify(["conditionalAccess"]), conditionalAccess: false },
  { name: "a tenant entry that is not an object", stored: JSON.stringify({ [TENANT]: "conditionalAccess" }), conditionalAccess: false },
  { name: "an empty tenant entry, so no list of services", stored: JSON.stringify({ [TENANT]: {} }), conditionalAccess: false },
  { name: "a corrupt Intune entry next to Conditional Access on", stored: JSON.stringify({ [TENANT]: { intune: "broken", conditionalAccess: { enabled: true, connection: "default" } } }), conditionalAccess: true },
  { name: "an Intune entry without a choice", stored: JSON.stringify({ [TENANT]: { intune: { connection: "default" }, conditionalAccess: { enabled: false, connection: "default" } } }), conditionalAccess: false },
  { name: "a Conditional Access choice that is not a boolean", stored: JSON.stringify({ [TENANT]: { conditionalAccess: { enabled: "yes", connection: "default" } } }), conditionalAccess: false },
  { name: "unknown service IDs", stored: JSON.stringify({ [TENANT]: { exchange: { enabled: true, connection: "default" }, conditionalAccess: { enabled: true, connection: "default" }, teams: 7 } }), conditionalAccess: true },
  { name: "another tenant's settings only", stored: JSON.stringify({ "99999999-9999-9999-9999-999999999999": { conditionalAccess: { enabled: true, connection: "default" } } }), conditionalAccess: false },
  { name: "a tenant ID asked for in upper case", stored: JSON.stringify({ [TENANT]: { conditionalAccess: { enabled: true, connection: "default" } } }), conditionalAccess: true, readAs: TENANT.toUpperCase() },
  // No version has read a key in another case than lower case, so the choice stored under it was never in effect.
  { name: "a tenant ID stored in mixed case, which no version reads", stored: JSON.stringify({ "0A1B2C3D-4e5f-6A7B-8c9d-0E1F2A3B4C5D": { conditionalAccess: { enabled: true, connection: "default" } } }), conditionalAccess: false },
]

const SCOPES: Array<{ name: string; scope: BackupScope }> = [
  { name: "everything", scope: EVERYTHING },
  { name: "the default without apps", scope: DEFAULT_SCOPE },
  { name: "custom exclusions", scope: { excluded: ["DeviceConfigurations", "Apps", "ScopeTags", "NamedLocations"] } },
]

describe("Settings stored by the 0.5 release", () => {
  for (const fixture of FIXTURES) {
    describe(fixture.name, () => {
      const tenantId = fixture.readAs ?? TENANT

      it("keeps Intune on, Conditional Access as it was, and Entra ID and Defender off", () => {
        const settings = new ModuleSettings(storeWith(fixture.stored))
        expect(settings.selection(tenantId).services).toEqual(["intune", ...(fixture.conditionalAccess ? ["conditionalAccess"] : [])])
        expect(settings.get(tenantId)).toEqual({
          intune: { enabled: true, connection: "default", access: "restore", areas: {} },
          conditionalAccess: { enabled: fixture.conditionalAccess, connection: "default", access: "backup", areas: {} },
          entra: { enabled: false, connection: "default", access: "backup", areas: { groups: false, usersAndDevices: false, applications: false } },
          defender: { enabled: false, connection: "default", access: "backup", areas: {} },
        })
      })

      for (const { name, scope } of SCOPES) {
        it(`backs up exactly the folders it backed up before, with ${name}`, async () => {
          const { included, graphPaths, status } = await backup(new ModuleSettings(storeWith(fixture.stored)), scope, tenantId)
          expect(included).toEqual(selectedBefore(scope, fixture.conditionalAccess))
          expect(status).toBe("Success")
          // Nothing of a service that is off is even asked for.
          if (!fixture.conditionalAccess) expect(graphPaths.some((path) => path.includes("conditionalAccess"))).toBe(false)
        })
      }
    })
  }
})

describe("Saving a setting on top of stored settings", () => {
  const read = (store: ReturnType<typeof memoryStore>) => JSON.parse(store.get(KEY)!) as Record<string, Record<string, unknown>>

  it("keeps a stored Conditional Access choice, other tenants and entries it does not know", () => {
    const other = "99999999-9999-9999-9999-999999999999"
    const store = storeWith(JSON.stringify({
      [TENANT]: { conditionalAccess: { enabled: true, connection: "default" }, exchange: { enabled: true, connection: "identity-team", mailboxes: ["a"] } },
      [other]: { conditionalAccess: { enabled: false, connection: "default" } },
      note: "not a tenant",
    }))
    const settings = new ModuleSettings(store)
    settings.set(TENANT, "entra", true)
    settings.setAccess(TENANT, "entra", "restore")
    settings.setArea(TENANT, "entra", "groups", true)
    expect(read(store)).toEqual({
      [TENANT]: {
        conditionalAccess: { enabled: true, connection: "default" },
        exchange: { enabled: true, connection: "identity-team", mailboxes: ["a"] },
        entra: { connection: "default", enabled: true, access: "restore", areas: { groups: true } },
      },
      [other]: { conditionalAccess: { enabled: false, connection: "default" } },
      note: "not a tenant",
    })
    expect(settings.selection(TENANT)).toEqual({ services: ["intune", "conditionalAccess", "entra"], areas: { intune: [], conditionalAccess: [], entra: ["groups"] } })
  })

  it("keeps fields of a service entry that a later version added, such as its own app registration", () => {
    const store = storeWith(JSON.stringify({ [TENANT]: { entra: { enabled: true, connection: "identity-team", future: { a: 1 } } } }))
    new ModuleSettings(store).setAccess(TENANT, "entra", "restore")
    expect(read(store)[TENANT]!.entra).toEqual({ enabled: true, connection: "identity-team", future: { a: 1 }, access: "restore" })
  })

  it("writes what the 0.5 release reads: a service entry with enabled and the default connection", () => {
    const store = memoryStore()
    new ModuleSettings(store).set(TENANT.toUpperCase(), "conditionalAccess", true)
    expect(read(store)).toEqual({ [TENANT]: { conditionalAccess: { connection: "default", enabled: true } } })
  })

  it("leaves a key stored in another case unread and untouched, and saves under the lower-case key", () => {
    const mixed = "0A1B2C3D-4e5f-6A7B-8c9d-0E1F2A3B4C5D"
    const entry = { conditionalAccess: { enabled: true, connection: "default" } }
    const store = storeWith(JSON.stringify({ [mixed]: entry }))
    const settings = new ModuleSettings(store)
    // As in the release before: only the lower-case key counts, so Conditional Access stays off.
    expect(settings.selection(TENANT).services).toEqual(["intune"])
    settings.set(TENANT, "conditionalAccess", true)
    expect(read(store)).toEqual({ [mixed]: entry, [TENANT]: { conditionalAccess: { connection: "default", enabled: true } } })
    expect(settings.selection(TENANT.toUpperCase()).services).toEqual(["intune", "conditionalAccess"])
  })

  it("starts over from a corrupt value instead of failing, and replaces a tenant entry that is not an object", () => {
    const corrupt = storeWith("{not json")
    expect(new ModuleSettings(corrupt).set(TENANT, "conditionalAccess", true).conditionalAccess.enabled).toBe(true)
    expect(read(corrupt)).toEqual({ [TENANT]: { conditionalAccess: { connection: "default", enabled: true } } })

    const broken = storeWith(JSON.stringify({ [TENANT]: "conditionalAccess" }))
    new ModuleSettings(broken).set(TENANT, "defender", true)
    expect(read(broken)).toEqual({ [TENANT]: { defender: { connection: "default", enabled: true } } })
  })

  it("tells its listener about every saved change", () => {
    let changes = 0
    const settings = new ModuleSettings(memoryStore(), () => { changes++ })
    settings.set(TENANT, "intune", false)
    settings.setAccess(TENANT, "intune", "backup")
    settings.setArea(TENANT, "entra", "applications", true)
    expect(changes).toBe(3)
  })
})

describe("Access level and opt-in areas per tenant", () => {
  it("stores the access level per service and refuses anything else", () => {
    const settings = new ModuleSettings(memoryStore())
    expect(settings.setAccess(TENANT, "intune", "backup").intune.access).toBe("backup")
    expect(settings.setAccess(TENANT, "defender", "restore").defender.access).toBe("restore")
    expect(settings.get(TENANT).conditionalAccess.access).toBe("backup")
    for (const [id, access] of [["intune", "write"], ["intune", undefined], ["exchange", "backup"], [7, "backup"]] as const) {
      expect(() => settings.setAccess(TENANT, id, access)).toThrow("Choose a service, and backup or restore as its access.")
    }
    // An unreadable stored level falls back to the service's default.
    const stored = new ModuleSettings(storeWith(JSON.stringify({ [TENANT]: { intune: { enabled: true, access: "admin" } } })))
    expect(stored.get(TENANT).intune.access).toBe("restore")
  })

  it("turns opt-in areas on and off, and refuses an area that is not opt-in", () => {
    const settings = new ModuleSettings(memoryStore())
    settings.set(TENANT, "entra", true)
    expect(settings.setArea(TENANT, "entra", "usersAndDevices", true).entra.areas).toEqual({ groups: false, usersAndDevices: true, applications: false })
    expect(settings.setArea(TENANT, "entra", "usersAndDevices", false).entra.areas.usersAndDevices).toBe(false)
    for (const [id, area, enabled] of [["entra", "authentication", true], ["entra", "unknown", true], ["intune", "apps", true], ["entra", "groups", "yes"], ["exchange", "groups", true]] as const) {
      expect(() => settings.setArea(TENANT, id, area, enabled)).toThrow("Choose an area that can be turned on or off.")
    }
  })

  it("keeps an opt-in area off while only its service is on, and leaves it out of the selection of a service that is off", () => {
    const settings = new ModuleSettings(memoryStore())
    settings.setArea(TENANT, "entra", "groups", true)
    // The area is remembered, but its service is off, so it is not part of what the tenant backs up.
    expect(settings.get(TENANT).entra).toMatchObject({ enabled: false, areas: { groups: true } })
    expect(settings.selection(TENANT).areas?.entra).toBeUndefined()
    settings.set(TENANT, "entra", true)
    expect(settings.selection(TENANT).areas?.entra).toEqual(["groups"])
  })

  it("never lets a stored access level decide a restore: the token does", async () => {
    const settings = new ModuleSettings(memoryStore())
    settings.set(TENANT, "conditionalAccess", true)
    settings.setAccess(TENANT, "conditionalAccess", "backup")
    settings.setAccess(TENANT, "intune", "backup")
    expect(settings.get(TENANT)).toMatchObject({ intune: { access: "backup" }, conditionalAccess: { access: "backup" } })

    // The gate takes the token's permissions and nothing else, so "backup" in Settings cannot block a write the token allows.
    const allowed: GrantedPermissions = { kind: "delegated", permissions: new Set(["Policy.Read.All", "Policy.ReadWrite.ConditionalAccess"]) }
    expect(restorePermissionBlocker("NamedLocations", allowed)).toBeUndefined()
    const writes: string[] = []
    const graph: GraphCall = async (method, path, body) => {
      if (method === "GET") return { status: 404, body: { error: { code: "ResourceNotFound", message: "not found" } } }
      writes.push(`${method} ${path}`)
      const created: Item = { id: "new", ...body }
      return { status: 201, body: created }
    }
    const location = { id: "l1", displayName: "Office", "@odata.type": "#microsoft.graph.ipNamedLocation", isTrusted: true, ipRanges: [] }
    expect((await new Restorer(graph, { mode: "copy", assignments: false, granted: allowed }).restore("backup/NamedLocations/Office.json", location)).success).toBe(true)
    // Intune is not checked against the token at all, whatever its level and whatever the token holds.
    expect((await new Restorer(graph, { mode: "copy", assignments: false, granted: { kind: "delegated", permissions: new Set(["User.Read"]) } }).restore("backup/DeviceCategories/Kiosk.json", { id: "c1", displayName: "Kiosk" })).success).toBe(true)
    expect(writes).toEqual(["POST identity/conditionalAccess/namedLocations", "POST deviceManagement/deviceCategories"])
    // Conditional Access stays gated by the token, also with "restore" stored as its level.
    settings.setAccess(TENANT, "conditionalAccess", "restore")
    expect(restorePermissionBlocker("NamedLocations", { kind: "delegated", permissions: new Set(["Policy.Read.All"]) })).toMatch(/Policy\.ReadWrite\.ConditionalAccess/)
  })
})

/** Every subset of the four services, from none to all. */
const COMBINATIONS: ModuleId[][] = Array.from({ length: 2 ** MODULES.length }, (_, bits) => MODULES.filter((_module, index) => bits & (1 << index)).map((module) => module.id))

describe("Any combination of services for a tenant", () => {
  it("covers all sixteen, with Entra ID only and Defender only among them", () => {
    expect(COMBINATIONS).toHaveLength(16)
    expect(COMBINATIONS).toContainEqual(["entra"])
    expect(COMBINATIONS).toContainEqual(["defender"])
  })

  for (const combination of COMBINATIONS) {
    const name = combination.length ? combination.join(", ") : "no service"

    it(`${name}: is stored and read back, and a backup reads only the services that are on`, async () => {
      const store = memoryStore()
      const settings = new ModuleSettings(store)
      for (const module of MODULES) settings.set(TENANT, module.id, combination.includes(module.id))
      // Read back by another instance, as after a restart.
      const reopened = new ModuleSettings(store)
      expect(reopened.selection(TENANT).services).toEqual(combination)
      for (const module of MODULES) expect(reopened.get(TENANT)[module.id].enabled).toBe(combination.includes(module.id))

      const { job, included, graphPaths, status } = await backup(reopened, EVERYTHING)
      expect(job.status).toBe("Completed")
      expect(job.exception).toBeUndefined()
      expect(status).toBe("Success")
      expect(included).toEqual([...(combination.includes("intune") ? INTUNE_FOLDERS : []), ...(combination.includes("conditionalAccess") ? CONDITIONAL_ACCESS_FOLDERS : [])])
      if (!combination.includes("intune")) expect(intuneRead(graphPaths)).toEqual([])
      if (!combination.includes("conditionalAccess")) expect(graphPaths.filter((path) => path.includes("conditionalAccess"))).toEqual([])
      // Entra ID and Defender have no types yet, so they add no request and no folder: every read is a selected type's.
      expect(new Set(graphPaths)).toEqual(new Set(included.map((folder) => `/beta/${INTUNE_TYPES.find((type) => type.folder === folder)!.path}`)))
      // The results list holds the selected types only, and a turned-off Intune is named.
      expect(job.results?.types.map((type) => type.folder)).toEqual(included)
      // A warning, so a backup without Intune stands out in the result instead of reading like any other success.
      const warnings = job.results?.notices.filter((notice) => notice.level === "warning").map((notice) => notice.message) ?? []
      expect(warnings.includes("Intune is turned off for this tenant, so its types are not backed up. Services and permissions in Settings turns it on again.")).toBe(!combination.includes("intune"))
      expect(job.progressMessage).toBe("Backup completed successfully")
    })

    it(`${name}: the services status and the Backup Reader's left-out types follow it without failing`, async () => {
      const settings = new ModuleSettings(memoryStore())
      for (const module of MODULES) settings.set(TENANT, module.id, combination.includes(module.id))
      const status = await servicesStatus(TENANT, settings, async () => ({ accessToken: jwt("Policy.Read.All") }))
      expect(status.error).toBeUndefined()
      expect(status.modules.map((module) => [module.id, module.enabled])).toEqual([["intune", combination.includes("intune")], ["conditionalAccess", combination.includes("conditionalAccess")]])
      const off = disabledFolders(settings.selection(TENANT))
      // Every folder of a service that is off, and of an opt-in area nobody turned on.
      expect(off).toEqual(MODULES.flatMap((module) => module.areas.filter((area) => !combination.includes(module.id) || area.optIn).flatMap((area) => area.folders)))
      // Of the types this version backs up, that leaves out what it left out before Entra ID and Defender had folders.
      const backedUp = new Set(INTUNE_TYPES.map((type) => type.folder))
      expect(off.filter((folder) => backedUp.has(folder))).toEqual([...(combination.includes("intune") ? [] : MODULES[0]!.areas.flatMap((area) => area.folders)), ...(combination.includes("conditionalAccess") ? [] : CONDITIONAL_ACCESS_FOLDERS)])
    })
  }

  it("names the progress step after what it reads", async () => {
    const seen: string[] = []
    const settings = new ModuleSettings(memoryStore())
    const run = async () => {
      const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-services-")), [randomBytes(32)])
      let job: ReturnType<BackupEngine["start"]> | undefined
      const engine = new BackupEngine({
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          if (localAccountFromUrl(new URL(request.url))) return handleLocalBlobRequest(store, request)
          if (job) seen.push(job.progressMessage)
          return Response.json({ value: [] })
        }) as typeof fetch,
        getToken: async () => jwt("Policy.Read.All"),
        services: (tenant) => settings.selection(tenant),
      })
      job = engine.start({ tenantId: TENANT, clientId: "22222222-2222-2222-2222-222222222222", storageAccountName: ACCOUNT, scope: EVERYTHING, trigger: "manual" })
      await engine.waitForJob(job)
    }
    settings.set(TENANT, "conditionalAccess", true)
    await run()
    // The first requests list the types; later ones save objects under their own step.
    expect(seen[0]).toBe("Reading Intune configuration...")
    seen.length = 0
    settings.set(TENANT, "intune", false)
    await run()
    expect(seen[0]).toBe("Reading configuration...")
    expect(seen).not.toContain("Reading Intune configuration...")
  })
})

describe("The access check behind restore history", () => {
  const answer = (body: unknown, status = 200) => async (path: string) => { reads.push(path); return Response.json(body, { status }) }
  const reads: string[] = []
  const check = (services: ModuleId[], read: (path: string) => Promise<Response>) => requireServiceAccess({ services }, read, "this tenant's restore history")

  it("reads Intune for a tenant with Intune on, as before, also when other services are on", async () => {
    reads.length = 0
    await check(["intune"], answer({ value: [] }))
    await check(["intune", "conditionalAccess", "entra"], answer({ value: [{ id: "c1" }] }))
    expect(reads).toEqual(["deviceManagement/deviceCategories?$top=1&$select=id", "deviceManagement/deviceCategories?$top=1&$select=id"])
    await expect(check(["intune"], answer({ error: { code: "Forbidden" } }, 403))).rejects.toThrow("Intune management access is required for this tenant's restore history.")
    await expect(check(["intune"], answer({ value: "none" }))).rejects.toThrow("Intune management access is required for this tenant's restore history.")
  })

  it("reads Conditional Access, and nothing of Intune, for a tenant without Intune", async () => {
    reads.length = 0
    await check(["conditionalAccess", "defender"], answer({ value: [{ id: "p1" }] }))
    expect(reads).toEqual(["identity/conditionalAccess/policies?$top=1&$select=id"])
    await expect(check(["conditionalAccess"], answer({}, 403))).rejects.toThrow("Entra Conditional Access management access is required for this tenant's restore history.")
  })

  it("refuses a tenant whose services have no such read yet, without asking Microsoft or naming Intune", async () => {
    reads.length = 0
    for (const services of [[], ["entra"], ["defender"], ["entra", "defender"]] as ModuleId[][]) {
      await expect(check(services, answer({ value: [] }))).rejects.toThrow("Turn on Intune or Entra Conditional Access for this tenant in Settings before opening this tenant's restore history.")
    }
    expect(reads).toEqual([])
  })
})
