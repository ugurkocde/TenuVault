import { describe, expect, it } from "vitest"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { checkModules, disabledFolders, missingPermissions, MODULES, moduleForFolder, restorePermissionBlocker, type GrantedPermissions } from "../src/shared/services/modules"
import { grantedPermissions } from "../src/shared/services/token"
import { ModuleSettings } from "../src/main/services/settings"
import { servicesStatus } from "../src/main/services/status"
import { memoryStore } from "./helpers"

const token = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
const delegated = (...scopes: string[]): GrantedPermissions => ({ kind: "delegated", permissions: new Set(scopes) })

/** The delegated permissions New-TenuVaultDesktopApp.ps1 grants by default. */
const SETUP_DEFAULT = [
  "User.Read", "Organization.Read.All", "Policy.Read.All",
  "DeviceManagementConfiguration.ReadWrite.All", "DeviceManagementApps.ReadWrite.All", "DeviceManagementServiceConfig.ReadWrite.All",
  "DeviceManagementScripts.ReadWrite.All", "DeviceManagementRBAC.ReadWrite.All", "DeviceManagementManagedDevices.Read.All",
]

describe("Service modules", () => {
  it("puts every registry type in exactly one module area", () => {
    const owners = new Map<string, number>()
    for (const module of MODULES) for (const area of module.areas) for (const folder of area.folders) owners.set(folder, (owners.get(folder) ?? 0) + 1)
    for (const type of INTUNE_TYPES) expect(owners.get(type.folder), type.folder).toBe(1)
    expect([...owners.keys()].sort()).toEqual(INTUNE_TYPES.map((type) => type.folder).sort())
  })

  it("reads delegated scopes and application roles from a token without verifying it", () => {
    expect(grantedPermissions(token({ scp: "User.Read Policy.Read.All" }))).toEqual({ kind: "delegated", permissions: new Set(["User.Read", "Policy.Read.All"]) })
    expect(grantedPermissions(token({ roles: ["Policy.Read.All", 7] }))).toEqual({ kind: "application", permissions: new Set(["Policy.Read.All"]) })
    for (const unreadable of [undefined, "", "opaque", "a.!!!.b", token({ aud: "x" })]) expect(grantedPermissions(unreadable)).toBeUndefined()
  })

  it("covers Intune backup and restore with the default setup, except restoring device categories", () => {
    const [intune] = checkModules(delegated(...SETUP_DEFAULT))
    expect(intune!.backup).toBe("ready")
    expect(intune!.restore).toBe("partial")
    const devices = intune!.areas.find((area) => area.folders.includes("DeviceCategories"))!
    expect(devices).toMatchObject({ backup: true, restore: false, missingRestore: [["DeviceManagementManagedDevices.ReadWrite.All"]] })
  })

  it("treats read-only consent as backup without restore, and names what is missing", () => {
    const [intune] = checkModules(delegated("DeviceManagementConfiguration.Read.All"))
    expect(intune!.backup).toBe("partial")
    expect(intune!.restore).toBe("missing")
    const apps = intune!.areas.find((area) => area.label === "Apps and app protection")!
    expect(apps.missingBackup).toEqual([["DeviceManagementApps.Read.All", "DeviceManagementApps.ReadWrite.All"]])
  })

  it("never blocks an Intune restore on the mapping: Graph stays the judge for always-on modules", () => {
    expect(moduleForFolder("deviceconfigurations")?.module.id).toBe("intune")
    expect(restorePermissionBlocker("DeviceConfigurations", delegated())).toBeUndefined()
    expect(restorePermissionBlocker("DeviceConfigurations", undefined)).toBeUndefined()
  })

  it("leaves no Intune type out of backups", () => {
    expect(disabledFolders([])).toEqual(MODULES.filter((module) => module.optIn).flatMap((module) => module.areas.flatMap((area) => area.folders)))
    for (const type of INTUNE_TYPES) if (moduleForFolder(type.folder)?.module.id === "intune") expect(disabledFolders([])).not.toContain(type.folder)
  })
})

describe("Module settings", () => {
  it("keeps always-on modules on and refuses to turn them off", () => {
    const settings = new ModuleSettings(memoryStore())
    expect(settings.get("Tenant").intune).toEqual({ enabled: true, connection: "default" })
    expect(() => settings.set("tenant", "intune", false)).toThrow(/turned on or off/)
    expect(() => settings.set("tenant", "unknown", true)).toThrow(/turned on or off/)
  })

  it("survives an unreadable saved value", () => {
    const store = memoryStore()
    store.set("services.modules", "{not json")
    expect(new ModuleSettings(store).enabled("tenant")).toEqual([])
  })
})

describe("Services status", () => {
  it("checks the token TenuVault holds and only refreshes it when asked", async () => {
    const calls: boolean[] = []
    const graph = async (force: boolean) => {
      calls.push(force)
      return { accessToken: token({ scp: SETUP_DEFAULT.join(" "), iat: 1_800_000_000 }) }
    }
    const status = await servicesStatus("tenant", new ModuleSettings(memoryStore()), graph)
    expect(status.checkedAt).toBe(new Date(1_800_000_000_000).toISOString())
    expect(status.modules.find((module) => module.id === "intune")).toMatchObject({ enabled: true, check: { backup: "ready" } })
    await servicesStatus("tenant", new ModuleSettings(memoryStore()), graph, true)
    expect(calls).toEqual([false, true])
  })

  it("reports a sign-in problem instead of failing", async () => {
    const status = await servicesStatus("tenant", new ModuleSettings(memoryStore()), async () => { throw new Error("Sign in again to continue.") })
    expect(status.error).toBe("Sign in again to continue.")
    expect(status.modules.every((module) => module.check === null)).toBe(true)
  })
})

describe("Messages that lead to Services and permissions", () => {
  it("links the card's name and leaves other messages as text", async () => {
    const { createElement } = await import("react")
    const { renderToStaticMarkup } = await import("react-dom/server")
    const { MemoryRouter } = await import("react-router-dom")
    const { LinkedMessage } = await import("../src/portal/components/linked-message")
    const render = (text: string) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(LinkedMessage, { text })))
    expect(render("Restoring needs a permission. Services and permissions shows how to add it.")).toBe(
      'Restoring needs a permission. <a class="font-medium underline underline-offset-2" href="/portal/settings?section=services" data-discover="true">Services and permissions</a> shows how to add it.',
    )
    expect(render("Created a [Restored] copy")).toBe("Created a [Restored] copy")
  })
})

describe("The fix offered on Services and permissions", () => {
  it("names the read permission too when backup is not ready, as the fewest permissions that close every gap", async () => {
    const [, conditionalAccess] = checkModules({ kind: "delegated", permissions: new Set(["Policy.ReadWrite.ConditionalAccess"]) })
    expect(missingPermissions({ check: conditionalAccess! })).toEqual([["Policy.Read.All"]])
    const [, readOnly] = checkModules({ kind: "delegated", permissions: new Set() })
    // Every other group contains one of these two, so granting both closes every gap.
    expect(missingPermissions({ check: readOnly! })).toEqual([["Policy.Read.All"], ["Policy.ReadWrite.ConditionalAccess"]])
    // Alternatives that no smaller group covers are kept as they are.
    const [, strengthsOnly] = checkModules({ kind: "delegated", permissions: new Set(["Policy.Read.All"]) })
    expect(missingPermissions({ check: strengthsOnly! })).toEqual([["Policy.ReadWrite.ConditionalAccess"]])
  })
})
