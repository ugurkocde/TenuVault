import { mkdtempSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { BackupEngine } from "../src/main/backup/engine"
import { ModuleSettings } from "../src/main/services/settings"
import { servicesStatus } from "../src/main/services/status"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { POST as restorePreview } from "../src/portal/app/api/restore-preview/route"
import { Restorer, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import { localStorageAccountName } from "../src/shared/constants"
import type { Item } from "../src/shared/intune/registry"
import { EVERYTHING } from "../src/shared/intune/scope"
import { MODULE_BY_ID, MODULES, restorePermissionBlocker, type GrantedPermissions, type ModuleId, type ServiceModule } from "../src/shared/services/modules"
import { memoryStore } from "./helpers"

/**
 * `optIn` used to mean three things. Each place that read it now reads one named fact. These tests
 * change one fact of a real service at a time and show that exactly the behaviour tied to it follows,
 * so a call site cannot quietly depend on another fact that happens to have the same value today.
 */

type Facts = Pick<ServiceModule, "switchable" | "defaultOn" | "precheck">

const ORIGINAL = new Map(MODULES.map((module) => [module.id, { switchable: module.switchable, defaultOn: module.defaultOn, precheck: module.precheck }]))
const withFacts = (id: ModuleId, facts: Partial<Facts>) => Object.assign(MODULE_BY_ID.get(id)!, facts)

afterEach(() => {
  for (const module of MODULES) Object.assign(module, ORIGINAL.get(module.id))
  vi.unstubAllGlobals()
})

const TENANT = "11111111-1111-1111-1111-111111111111"
const jwt = (scp: string) => `e30.${Buffer.from(JSON.stringify({ scp })).toString("base64url")}.sig`
const delegated = (...scopes: string[]): GrantedPermissions => ({ kind: "delegated", permissions: new Set(scopes) })

const INTUNE_WRITE = "DeviceManagementConfiguration.ReadWrite.All DeviceManagementApps.ReadWrite.All DeviceManagementServiceConfig.ReadWrite.All DeviceManagementScripts.ReadWrite.All DeviceManagementRBAC.ReadWrite.All DeviceManagementManagedDevices.ReadWrite.All"

describe("The four services and their facts", () => {
  it("keeps today's behaviour for Intune and Conditional Access, and starts the new services off", () => {
    expect(MODULES.map((module) => [module.id, module.switchable, module.defaultOn, module.precheck, module.defaultAccess])).toEqual([
      ["intune", true, true, false, "restore"],
      ["conditionalAccess", true, false, true, "backup"],
      ["entra", true, false, true, "backup"],
      ["defender", true, false, true, "backup"],
    ])
    // The combined flag is gone from every service.
    expect(MODULES.some((module) => "optIn" in module)).toBe(false)
  })

  it("marks the Entra areas that are opt-in and the ones that hold personal data", () => {
    const entra = MODULE_BY_ID.get("entra")!
    expect(entra.areas.filter((area) => area.optIn).map((area) => area.id)).toEqual(["groups", "usersAndDevices", "applications"])
    expect(entra.areas.filter((area) => area.personalData).map((area) => area.id)).toEqual(["groups", "usersAndDevices"])
    // No area of Intune, Conditional Access or Defender is opt-in: turning the service on backs all of it up.
    for (const id of ["intune", "conditionalAccess", "defender"] as const) expect(MODULE_BY_ID.get(id)!.areas.some((area) => area.optIn)).toBe(false)
  })
})

describe("Settings read switchable and defaultOn", () => {
  it("lets the admin switch a switchable service, and keeps one that is not switchable on", () => {
    const settings = new ModuleSettings(memoryStore())
    expect(settings.set(TENANT, "conditionalAccess", true).conditionalAccess.enabled).toBe(true)
    expect(settings.set(TENANT, "conditionalAccess", false).conditionalAccess.enabled).toBe(false)

    withFacts("conditionalAccess", { switchable: false })
    expect(() => settings.set(TENANT, "conditionalAccess", true)).toThrow("Choose a service that can be turned on or off.")
    // The stored "off" no longer applies: a service that cannot be switched is always on.
    expect(settings.get(TENANT).conditionalAccess.enabled).toBe(true)
  })

  it("does not tie switching to the other two facts", () => {
    const settings = new ModuleSettings(memoryStore())
    withFacts("conditionalAccess", { defaultOn: true, precheck: false })
    expect(settings.set(TENANT, "conditionalAccess", false).conditionalAccess.enabled).toBe(false)
    withFacts("intune", { defaultOn: false, precheck: true })
    expect(settings.set(TENANT, "intune", true).intune.enabled).toBe(true)
  })

  it("turns a service on for a tenant without a stored choice only when it is on by default", () => {
    const settings = new ModuleSettings(memoryStore())
    expect(settings.selection(TENANT).services).toEqual(["intune"])

    withFacts("conditionalAccess", { defaultOn: true })
    withFacts("intune", { defaultOn: false })
    expect(settings.selection(TENANT).services).toEqual(["conditionalAccess"])

    // A stored choice wins over the default in both directions.
    settings.set(TENANT, "intune", true)
    settings.set(TENANT, "conditionalAccess", false)
    expect(settings.selection(TENANT).services).toEqual(["intune"])
  })

  it("does not read the pre-check fact when it decides what is on", () => {
    const settings = new ModuleSettings(memoryStore())
    withFacts("intune", { precheck: true })
    withFacts("conditionalAccess", { precheck: false })
    expect(settings.selection(TENANT).services).toEqual(["intune"])
  })
})

describe("The services status reports switchable", () => {
  const status = () => servicesStatus(TENANT, new ModuleSettings(memoryStore()), async () => ({ accessToken: jwt("Policy.Read.All") }))

  it("tells the Settings card which services the admin can switch", async () => {
    expect((await status()).modules.map((module) => [module.id, module.switchable])).toEqual([["intune", true], ["conditionalAccess", true], ["entra", true]])
    withFacts("intune", { switchable: false })
    expect((await status()).modules.map((module) => [module.id, module.switchable])).toEqual([["intune", false], ["conditionalAccess", true], ["entra", true]])
  })

  it("does not follow the other two facts", async () => {
    withFacts("intune", { defaultOn: false, precheck: true })
    withFacts("conditionalAccess", { defaultOn: true, precheck: false })
    expect((await status()).modules.map((module) => module.switchable)).toEqual([true, true, true])
  })

  it("leaves out a service that has no types to back up yet, so it is never shown as ready", async () => {
    const answer = await status()
    expect(answer.modules.map((module) => module.id)).toEqual(["intune", "conditionalAccess", "entra"])
    expect(answer.modules.every((module) => module.check !== null)).toBe(true)
  })
})

describe("The restore permission check reads precheck", () => {
  it("blocks Conditional Access up front and never Intune", () => {
    expect(restorePermissionBlocker("ConditionalAccessPolicies", delegated("Policy.Read.All"))).toMatch(/needs the Policy\.ReadWrite\.ConditionalAccess permission/)
    expect(restorePermissionBlocker("DeviceConfigurations", delegated())).toBeUndefined()
    expect(restorePermissionBlocker("DeviceCategories", delegated("DeviceManagementManagedDevices.Read.All"))).toBeUndefined()
  })

  it("follows the fact when it changes, and no other fact", () => {
    withFacts("intune", { precheck: true })
    expect(restorePermissionBlocker("DeviceConfigurations", delegated())).toMatch(/Restoring Intune configuration and compliance needs the DeviceManagementConfiguration\.ReadWrite\.All permission/)
    withFacts("conditionalAccess", { precheck: false })
    expect(restorePermissionBlocker("ConditionalAccessPolicies", delegated())).toBeUndefined()

    withFacts("intune", { precheck: false, defaultOn: false, switchable: false })
    withFacts("conditionalAccess", { precheck: true, defaultOn: true, switchable: false })
    expect(restorePermissionBlocker("DeviceConfigurations", delegated())).toBeUndefined()
    expect(restorePermissionBlocker("ConditionalAccessPolicies", delegated("Policy.Read.All"))).toMatch(/Policy\.ReadWrite\.ConditionalAccess/)
  })
})

describe("The backup engine reads precheck", () => {
  const ACCOUNT = localStorageAccountName(TENANT)

  async function backup(options: { scopes: string; denied?: string[] }) {
    const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-facts-")), [randomBytes(32)])
    const graphPaths: string[] = []
    const engine = new BackupEngine({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
        const graphPath = decodeURIComponent(url.pathname)
        graphPaths.push(graphPath)
        if (options.denied?.includes(graphPath)) return Response.json({ error: { code: "Forbidden", message: "Access denied." } }, { status: 403 })
        return Response.json({ value: [] })
      }) as typeof fetch,
      getToken: async () => jwt(options.scopes),
      services: () => ({ services: ["intune", "conditionalAccess"] }),
      now: () => new Date("2026-11-14T02:00:00Z"),
    })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: "22222222-2222-2222-2222-222222222222", storageAccountName: ACCOUNT, scope: EVERYTHING, trigger: "manual" }))
    const metadata = JSON.parse((await store.get(ACCOUNT, "intune-backups", `${job.backupFolder}/metadata.json`)).data.toString()) as { SkippedTypes: string[]; Scope: { Included: string[] } }
    const reason = (folder: string) => job.results?.types.find((type) => type.folder === folder)?.reason
    return { job, metadata, graphPaths, reason }
  }
  const intuneRead = (paths: string[]) => paths.some((path) => path.startsWith("/beta/deviceManagement/") || path.startsWith("/beta/deviceAppManagement/"))
  const conditionalAccessRead = (paths: string[]) => paths.some((path) => path.startsWith("/beta/identity/conditionalAccess/"))

  it("reads Intune without looking at the token, and leaves Conditional Access out up front when its permission is missing", async () => {
    const { metadata, graphPaths, reason } = await backup({ scopes: "User.Read" })
    expect(intuneRead(graphPaths)).toBe(true)
    expect(metadata.Scope.Included).toContain("DeviceConfigurations")
    expect(conditionalAccessRead(graphPaths)).toBe(false)
    expect(metadata.SkippedTypes).toEqual(["NamedLocations", "AuthenticationStrengths", "ConditionalAccessPolicies"])
    expect(reason("ConditionalAccessPolicies")).toBe("The TenuVault app registration has no Policy.Read.All permission for Entra Conditional Access. Services and permissions in Settings shows how to add it.")
  })

  it("checks a service up front once it has the fact, and stops checking one that loses it", async () => {
    withFacts("intune", { precheck: true })
    withFacts("conditionalAccess", { precheck: false })
    const { metadata, graphPaths, reason } = await backup({ scopes: "User.Read" })
    expect(intuneRead(graphPaths)).toBe(false)
    expect(metadata.Scope.Included).toEqual(["NamedLocations", "AuthenticationStrengths", "ConditionalAccessPolicies"])
    expect(reason("DeviceConfigurations")).toBe("The TenuVault app registration has no DeviceManagementConfiguration.Read.All or DeviceManagementConfiguration.ReadWrite.All permission for Intune. Services and permissions in Settings shows how to add it.")
    expect(conditionalAccessRead(graphPaths)).toBe(true)
  })

  it("does not take the up-front check from the default or from switching", async () => {
    withFacts("intune", { defaultOn: false, switchable: false })
    withFacts("conditionalAccess", { defaultOn: true, switchable: false })
    const { metadata, graphPaths } = await backup({ scopes: "User.Read" })
    expect(intuneRead(graphPaths)).toBe(true)
    expect(conditionalAccessRead(graphPaths)).toBe(false)
    expect(metadata.SkippedTypes).toEqual(["NamedLocations", "AuthenticationStrengths", "ConditionalAccessPolicies"])
  })

  it("words a refused read by the same fact: the Intune role, or the roles of a pre-checked service", async () => {
    const denied = ["/beta/deviceAppManagement/mobileApps", "/beta/identity/conditionalAccess/policies"]
    const real = await backup({ scopes: `Policy.Read.All ${INTUNE_WRITE}`, denied })
    expect(real.reason("Apps")).toBe("Access was denied. The app registration may lack the permission or admin consent, or your Intune role may not allow it.")
    expect(real.reason("ConditionalAccessPolicies")).toBe("Access was denied. The app registration may lack the permission or admin consent, or your account may not have a role that can read Entra Conditional Access (Security Reader or Global Reader to back up).")

    withFacts("intune", { precheck: true })
    withFacts("conditionalAccess", { precheck: false })
    const flipped = await backup({ scopes: `Policy.Read.All ${INTUNE_WRITE}`, denied })
    expect(flipped.reason("Apps")).toBe("Access was denied. The app registration may lack the permission or admin consent, or your account may not have a role that can read Intune (Intune Administrator, or an Intune role that covers the policies you back up and restore.).")
    expect(flipped.reason("ConditionalAccessPolicies")).toBe("Access was denied. The app registration may lack the permission or admin consent, or your Entra Conditional Access role may not allow it.")
  })
})

describe("The restore preview reads precheck", () => {
  const backupId = "backup-2026-11-14-020000"
  const files: Record<string, Item> = {
    [`${backupId}/DeviceCategories/Kiosk.json`]: { id: "c1", displayName: "Kiosk" },
    [`${backupId}/NamedLocations/Office.json`]: { id: "l1", displayName: "Office", "@odata.type": "#microsoft.graph.ipNamedLocation", isTrusted: true, ipRanges: [] },
  }

  async function preview(folder: "DeviceCategories" | "NamedLocations", scopes: string) {
    const path = Object.keys(files).find((file) => file.includes(`/${folder}/`))!
    const tokenScopes: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") {
        tokenScopes.push(new URLSearchParams(String(init?.body)).get("scope") ?? "")
        return Response.json({ access_token: jwt(scopes) })
      }
      const file = decodeURIComponent(url.pathname).replace("/intune-backups/", "")
      if (files[file]) return Response.json(files[file])
      if (file === `${backupId}/metadata.json`) return Response.json({ TenantId: TENANT, Status: "Success" })
      return new Response("", { status: 404 })
    }))
    const body = { tenantId: TENANT, appId: "app", clientSecret: "test", storageAccountName: "store", backupId, paths: [path] }
    const response = await restorePreview(new NextRequest("http://tenuvault.internal/api/restore-preview", { method: "POST", body: JSON.stringify(body) }))
    expect(response.status).toBe(200)
    const item = (await response.json()).items[0] as { blocker?: string; replaceBlocker?: string }
    return { item, graphTokenRequested: tokenScopes.includes("https://graph.microsoft.com/.default") }
  }

  it("asks for the Graph token only for a pre-checked service, and never blocks an Intune item on its scopes", async () => {
    const intune = await preview("DeviceCategories", "User.Read")
    expect(intune.graphTokenRequested).toBe(false)
    expect(intune.item.blocker).toBeUndefined()
    expect(intune.item.replaceBlocker).toBeUndefined()

    const location = await preview("NamedLocations", "Policy.Read.All")
    expect(location.graphTokenRequested).toBe(true)
    expect(location.item.blocker).toMatch(/Restoring Entra Conditional Access named locations needs the Policy\.ReadWrite\.ConditionalAccess permission/)
  })

  it("follows the fact when it changes", async () => {
    withFacts("intune", { precheck: true })
    const intune = await preview("DeviceCategories", "DeviceManagementManagedDevices.Read.All")
    expect(intune.graphTokenRequested).toBe(true)
    expect(intune.item.blocker).toMatch(/needs the DeviceManagementManagedDevices\.ReadWrite\.All permission/)

    withFacts("conditionalAccess", { precheck: false })
    const location = await preview("NamedLocations", "Policy.Read.All")
    expect(location.graphTokenRequested).toBe(false)
    expect(location.item.blocker).toBeUndefined()
  })

  it("does not follow the default or switching", async () => {
    withFacts("intune", { defaultOn: false, switchable: false })
    withFacts("conditionalAccess", { defaultOn: true, switchable: false })
    expect((await preview("DeviceCategories", "User.Read")).graphTokenRequested).toBe(false)
    expect((await preview("NamedLocations", "Policy.Read.All")).item.blocker).toMatch(/Policy\.ReadWrite\.ConditionalAccess/)
  })
})

describe("The restore write error path reads precheck", () => {
  /** A Graph that refuses every write with 403 and finds nothing on a read. */
  function refusingGraph() {
    const writes: string[] = []
    const graph: GraphCall = async (method, path) => {
      if (method === "GET") return { status: 404, body: { error: { code: "ResourceNotFound", message: "not found" } } }
      writes.push(`${method} ${path}`)
      return { status: 403, body: { error: { code: "Forbidden", message: "Insufficient privileges to complete the operation." } } }
    }
    return { graph, writes }
  }
  const category = { id: "c1", displayName: "Kiosk" }
  const location = { id: "l1", displayName: "Office", "@odata.type": "#microsoft.graph.ipNamedLocation", isTrusted: true, ipRanges: [] }
  const restore = async (path: string, snapshot: Item) => {
    const { graph, writes } = refusingGraph()
    const outcome = await new Restorer(graph, { mode: "copy", assignments: false }).restore(path, snapshot)
    return { outcome, writes }
  }

  it("explains a refusal with the permission and roles for a pre-checked service, and passes Graph's own message on for Intune", async () => {
    const intune = await restore("backup/DeviceCategories/Kiosk.json", category)
    expect(intune.writes).toEqual(["POST deviceManagement/deviceCategories"])
    expect(intune.outcome.error).toBe("Insufficient privileges to complete the operation.")

    const entra = await restore("backup/NamedLocations/Office.json", location)
    expect(entra.outcome.error).toMatch(/^Microsoft refused to change Entra Conditional Access \(Insufficient privileges to complete the operation\.\)\. The TenuVault app registration needs the Policy\.Read\.All and Policy\.ReadWrite\.ConditionalAccess permission/)
  })

  it("follows the fact when it changes, and no other fact", async () => {
    withFacts("intune", { precheck: true })
    withFacts("conditionalAccess", { precheck: false })
    expect((await restore("backup/DeviceCategories/Kiosk.json", category)).outcome.error).toMatch(/^Microsoft refused to change Intune \(Insufficient privileges to complete the operation\.\)\. The TenuVault app registration needs the DeviceManagementManagedDevices\.ReadWrite\.All permission/)
    expect((await restore("backup/NamedLocations/Office.json", location)).outcome.error).toBe("Insufficient privileges to complete the operation.")

    withFacts("intune", { precheck: false, defaultOn: false, switchable: false })
    withFacts("conditionalAccess", { precheck: true, defaultOn: true, switchable: false })
    expect((await restore("backup/DeviceCategories/Kiosk.json", category)).outcome.error).toBe("Insufficient privileges to complete the operation.")
    expect((await restore("backup/NamedLocations/Office.json", location)).outcome.error).toMatch(/^Microsoft refused to change Entra Conditional Access/)
  })
})
