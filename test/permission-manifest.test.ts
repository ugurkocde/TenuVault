import { describe, expect, it } from "vitest"
import {
  areaPermissions, checkedChoice, DEFAULT_READER_CHOICE, DEFAULT_SETUP_CHOICE, graphPermissions, knownPermissions, missingForChoice, READER_ALLOWED_ROLES, readerChoice,
  readerExcludedFolders, readerRequiredRoles, readerRoles, readerScriptArguments, readerSetupArguments, requestedPermissions, setupScriptArguments, showsApproval, type PermissionChoice,
} from "../src/shared/services/manifest"
import { areaNeed, backupNeed, canBackUp, checkModules, DEFAULT_SELECTION, MODULES, MODULE_BY_ID, restorePermissionBlocker, type AccessLevel, type GrantedPermissions, type ModuleId } from "../src/shared/services/modules"
import { OPTIONAL_PERMISSIONS } from "../src/shared/services/optional-permissions"

const delegated = (...scopes: string[]): GrantedPermissions => ({ kind: "delegated", permissions: new Set(scopes) })
const application = (...roles: string[]): GrantedPermissions => ({ kind: "application", permissions: new Set(roles) })
const IDS = MODULES.map((module) => module.id)
const WRITE = /ReadWrite|\.Create|\.Manage|Write/

/** Every combination of services, each with one access level for all of them and every opt-in area on or off. */
function choices(): PermissionChoice[] {
  const result: PermissionChoice[] = []
  for (let mask = 1; mask < 1 << IDS.length; mask++) {
    const on = IDS.filter((_, position) => mask & (1 << position))
    for (const access of ["backup", "restore"] as const) for (const everyArea of [false, true]) {
      result.push(Object.fromEntries(on.map((id) => [id, { access, ...(everyArea ? { areas: MODULE_BY_ID.get(id)!.areas.filter((area) => area.optIn || area.appOnlyOptIn).map((area) => area.id) } : {}) }])))
    }
  }
  return result
}

describe("What a setup asks for by default", () => {
  it("is today's exact list per API, with the managed devices permission read only", () => {
    expect(requestedPermissions(DEFAULT_SETUP_CHOICE, "delegated")).toEqual([
      {
        api: "Microsoft Graph",
        appId: "00000003-0000-0000-c000-000000000000",
        permissions: [
          "User.Read", "Organization.Read.All", "Policy.Read.All",
          "DeviceManagementConfiguration.ReadWrite.All", "DeviceManagementApps.ReadWrite.All", "DeviceManagementServiceConfig.ReadWrite.All",
          "DeviceManagementScripts.ReadWrite.All", "DeviceManagementRBAC.ReadWrite.All", "DeviceManagementManagedDevices.Read.All",
        ],
      },
      { api: "Azure Service Management", appId: "797f4846-ba00-4fd7-ba43-dac1f8f63013", permissions: ["user_impersonation"] },
      { api: "Azure Storage", appId: "e406a681-f3d4-42a8-90b6-c2b029497af1", permissions: ["user_impersonation"] },
    ])
  })

  it("follows the access each service has for a tenant that made no choice: Intune restores, Conditional Access is read", () => {
    expect(DEFAULT_SETUP_CHOICE).toEqual({ intune: { access: MODULE_BY_ID.get("intune")!.defaultAccess }, conditionalAccess: { access: MODULE_BY_ID.get("conditionalAccess")!.defaultAccess } })
    expect(MODULES.map((module) => module.defaultAccess)).toEqual(["restore", "backup", "backup", "backup"])
  })

  it("is the five Intune read permissions for a Backup Reader, and nothing but Microsoft Graph", () => {
    expect(requestedPermissions(DEFAULT_READER_CHOICE, "application")).toEqual([{
      api: "Microsoft Graph",
      appId: "00000003-0000-0000-c000-000000000000",
      permissions: ["DeviceManagementApps.Read.All", "DeviceManagementConfiguration.Read.All", "DeviceManagementRBAC.Read.All", "DeviceManagementScripts.Read.All", "DeviceManagementServiceConfig.Read.All"],
    }])
    expect(readerRoles()).toEqual(readerRequiredRoles(DEFAULT_SELECTION))
  })
})

describe("What a choice of services, areas and access levels asks for", () => {
  it("never asks for a write permission to back up, whatever is chosen", () => {
    for (const choice of choices().filter((candidate) => Object.values(candidate).every((picked) => picked.access === "backup"))) {
      for (const mode of ["delegated", "application"] as const) expect(graphPermissions(choice, mode).filter((permission) => WRITE.test(permission)), JSON.stringify(choice)).toEqual([])
    }
  })

  it("never gives app-only access a write permission, even for restore", () => {
    for (const choice of choices()) expect(graphPermissions(choice, "application").filter((permission) => WRITE.test(permission)), JSON.stringify(choice)).toEqual([])
    for (const role of READER_ALLOWED_ROLES) expect(role).not.toMatch(WRITE)
    for (const module of MODULES) for (const area of module.areas) for (const part of area.parts) expect(part.restore.application, part.folders[0]).toBe("unsupported")
  })

  it("asks for nothing of a service that was not chosen", () => {
    const families: Record<ModuleId, RegExp> = { intune: /^DeviceManagement/, conditionalAccess: /^Policy\.ReadWrite\.ConditionalAccess$/, entra: /^(RoleManagement\.Read\.Directory|Domain\.|EntitlementManagement|IdentityProvider)/, defender: /^(CustomDetection|AttackSimulation|SecurityEvents|RoleManagement\.Read\.Defender)/ }
    for (const choice of choices()) for (const id of IDS) {
      const asked = graphPermissions(choice, "delegated").some((permission) => families[id].test(permission))
      // Reading Conditional Access shares Policy.Read.All with Entra ID; its write permission is its own.
      if (id === "conditionalAccess") expect(asked, JSON.stringify(choice)).toBe(choice.conditionalAccess?.access === "restore")
      else expect(asked, `${id} in ${JSON.stringify(choice)}`).toBe(Boolean(choice[id]))
    }
  })

  it("gives each service exactly its permissions", () => {
    const graph = (choice: PermissionChoice) => graphPermissions(choice, "delegated").slice(2)
    expect(graphPermissions({ intune: { access: "backup" } }, "delegated").slice(0, 2)).toEqual(["User.Read", "Organization.Read.All"])
    expect(graph({ intune: { access: "backup" } })).toEqual(["Configuration", "Apps", "ServiceConfig", "Scripts", "RBAC", "ManagedDevices"].map((family) => `DeviceManagement${family}.Read.All`))
    expect(graph({ conditionalAccess: { access: "backup" } })).toEqual(["Policy.Read.All"])
    // Conditional Access writes also need Policy.Read.All, so restore asks for both.
    expect(graph({ conditionalAccess: { access: "restore" } })).toEqual(["Policy.Read.All", "Policy.ReadWrite.ConditionalAccess"])
    expect(graph({ defender: { access: "backup" } })).toEqual([
      "CustomDetection.Read.All", "CaseManagement.Read.All", "AttackSimulation.Read.All", "ThreatSubmission.Read.All",
      "SecurityIdentitiesSensors.Read.All", "SecurityIdentitiesAutoConfig.Read.All", "SecurityEvents.Read.All", "RoleManagement.Read.Defender",
    ])
    // The write permission of the user reported settings also reads them, so its read permission is not asked for as well.
    expect(graph({ defender: { access: "restore" } })).toEqual([
      "CustomDetection.ReadWrite.All", "CaseManagement.Read.All", "ThreatSubmissionPolicy.ReadWrite.All", "AttackSimulation.Read.All",
      "SecurityIdentitiesSensors.ReadWrite.All", "SecurityIdentitiesAutoConfig.ReadWrite.All", "SecurityEvents.ReadWrite.All", "RoleManagement.ReadWrite.Defender",
    ])
    // Entra ID without its opt-in areas reads no users, groups or applications.
    const entra = graph({ entra: { access: "backup" } })
    expect(entra).toContain("Policy.Read.All")
    for (const directory of ["Directory.Read.All", "User.Read.All", "Group.Read.All", "Device.Read.All", "Application.Read.All", "GroupMember.Read.All"]) expect(entra, directory).not.toContain(directory)
    expect(graph({ entra: { access: "backup", areas: ["groups"] } }).filter((permission) => !entra.includes(permission))).toEqual(["Group.Read.All", "Directory.Read.All"])
    expect(graph({ entra: { access: "backup", areas: ["usersAndDevices"] } }).filter((permission) => !entra.includes(permission))).toEqual(["User.Read.All", "Device.Read.All", "OrgContact.Read.All"])
    expect(graph({ entra: { access: "backup", areas: ["applications"] } }).filter((permission) => !entra.includes(permission))).toEqual(["Application.Read.All", "Synchronization.Read.All", "Directory.Read.All"])
  })

  it("lets a ReadWrite permission stand in for its Read one, and asks for a shared permission once", () => {
    const restore = graphPermissions({ intune: { access: "restore" } }, "delegated")
    expect(restore).toContain("DeviceManagementApps.ReadWrite.All")
    expect(restore).not.toContain("DeviceManagementApps.Read.All")
    for (const choice of choices()) for (const mode of ["delegated", "application"] as const) {
      const permissions = graphPermissions(choice, mode)
      expect(new Set(permissions).size, JSON.stringify(choice)).toBe(permissions.length)
    }
  })

  it("is not widened because an access level is called restore: two write permissions are declared and never asked for", () => {
    for (const choice of choices()) {
      const permissions = graphPermissions(choice, "delegated")
      expect(permissions).not.toContain("DeviceManagementManagedDevices.ReadWrite.All")
      expect(permissions).not.toContain("Directory.ReadWrite.All")
      if (choice.intune) expect(permissions).toContain("DeviceManagementManagedDevices.Read.All")
    }
    // Both stay named, so Settings can say what restoring those types needs and a consented one counts as TenuVault's.
    expect(knownPermissions("delegated")[0]!.permissions).toEqual(expect.arrayContaining(["DeviceManagementManagedDevices.ReadWrite.All", "Directory.ReadWrite.All"]))
    expect(MODULES.flatMap((module) => module.areas.flatMap((area) => area.parts.filter((part) => part.restoreNotRequested).flatMap((part) => part.folders)))).toEqual(["DeviceCategories", "DeviceCleanupRules", "ContinuousAccessEvaluationPolicy", "GroupLifecyclePolicies"])
    // Restoring Entra ID never brings the permission that changes Conditional Access policies.
    expect(graphPermissions({ entra: { access: "restore", areas: ["groups", "usersAndDevices", "applications"] } }, "delegated")).not.toContain("Policy.ReadWrite.ConditionalAccess")
  })

  it("stays within the length Microsoft allows for one consent grant, even with everything chosen", () => {
    // Microsoft Graph refuses a delegated permission grant whose scope is longer than 3,850 characters.
    const everything: PermissionChoice = Object.fromEntries(MODULES.map((module) => [module.id, { access: "restore", areas: module.areas.filter((area) => area.optIn).map((area) => area.id) }]))
    expect(graphPermissions(everything, "delegated", OPTIONAL_PERMISSIONS.map((entry) => entry.id)).join(" ").length).toBeLessThan(3850)
  })

  it("adds the optional permissions of single features only when asked, after the services", () => {
    expect(graphPermissions(DEFAULT_SETUP_CHOICE, "delegated", ["groupRead", "notificationEmail"]).slice(9)).toEqual(["Mail.Send", "Group.Read.All"])
    const all = graphPermissions(DEFAULT_SETUP_CHOICE, "delegated", OPTIONAL_PERMISSIONS.map((entry) => entry.id))
    expect(all.slice(9)).toEqual(["Mail.Send", "GroupMember.Read.All", "User.Read.All", "AuditLog.Read.All", "Group.Read.All"])
    // A permission a chosen area already brings is not listed twice.
    expect(graphPermissions({ entra: { access: "backup", areas: ["usersAndDevices"] } }, "delegated", ["groupRecipients"]).filter((permission) => permission === "User.Read.All")).toHaveLength(1)
    // App-only access has no optional permissions.
    expect(graphPermissions(DEFAULT_READER_CHOICE, "application", ["notificationEmail"])).toEqual(readerRoles())
  })

  it("covers what it asks for: the permissions of a choice let every chosen folder be backed up, and restored where setup asks for it", () => {
    for (const choice of choices()) {
      const granted = delegated(...graphPermissions(choice, "delegated"))
      expect(missingForChoice(choice, granted), JSON.stringify(choice)).toEqual([])
      for (const [id, picked] of Object.entries(choice)) for (const area of MODULE_BY_ID.get(id as ModuleId)!.areas) {
        if (area.optIn && !picked.areas?.includes(area.id)) continue
        for (const folder of area.folders) expect(canBackUp(folder, granted), folder).toBe(true)
        if (picked.access === "restore") for (const part of area.parts.filter((candidate) => !candidate.restoreNotRequested && candidate.restore.delegated !== "unsupported")) {
          for (const group of part.restore.delegated as readonly (readonly string[])[]) expect(group.some((permission) => granted.permissions.has(permission)), part.folders[0]).toBe(true)
        }
      }
    }
  })

  it("says what a set of granted permissions lacks for a choice, and nothing more", () => {
    expect(missingForChoice(DEFAULT_SETUP_CHOICE, delegated())).toEqual(graphPermissions(DEFAULT_SETUP_CHOICE, "delegated"))
    expect(missingForChoice(DEFAULT_SETUP_CHOICE, delegated(...graphPermissions(DEFAULT_SETUP_CHOICE, "delegated")))).toEqual([])
    // An existing default registration that should also back up Defender.
    const today = delegated(...graphPermissions(DEFAULT_SETUP_CHOICE, "delegated"))
    expect(missingForChoice({ ...DEFAULT_SETUP_CHOICE, defender: { access: "backup" } }, today)).toEqual(graphPermissions({ defender: { access: "backup" } }, "delegated").slice(2))
    // Another permission that also satisfies a requirement counts: Directory.Read.All reads the directory settings and the administrative units.
    const entra = missingForChoice({ entra: { access: "backup" } }, delegated("User.Read", "Organization.Read.All", "Policy.Read.All", "Directory.Read.All"))
    expect(entra).not.toContain("GroupSettings.Read.All")
    expect(entra).not.toContain("AdministrativeUnit.Read.All")
    expect(entra).not.toContain("Policy.Read.All")
    // It does not read the domains' federation settings or the PIM schedules, so those are still named.
    expect(entra).toEqual(expect.arrayContaining(["Domain.Read.All", "RoleManagement.Read.Directory"]))
    // Adding restore to Conditional Access needs the write permission only.
    expect(missingForChoice({ conditionalAccess: { access: "restore" } }, delegated("User.Read", "Organization.Read.All", "Policy.Read.All"))).toEqual(["Policy.ReadWrite.ConditionalAccess"])
    expect(missingForChoice(DEFAULT_READER_CHOICE, application("DeviceManagementApps.Read.All"))).toEqual(readerRoles().filter((role) => role !== "DeviceManagementApps.Read.All"))
  })

  it("accepts a choice from outside only when the manifest knows every part of it", () => {
    expect(checkedChoice({ intune: { access: "restore" }, entra: { access: "backup", areas: ["groups"] } })).toEqual({ intune: { access: "restore" }, entra: { access: "backup", areas: ["groups"] } })
    for (const invalid of [undefined, null, "intune", [], {}, { sharepoint: { access: "backup" } }, { intune: {} }, { intune: { access: "admin" } }, { intune: "restore" }, { intune: { access: "backup", areas: ["groups"] } }, { entra: { access: "backup", areas: ["tenantSettings"] } }, { entra: { access: "backup", areas: "groups" } }, { __proto__: { access: "backup" } }]) {
      expect(() => checkedChoice(invalid), JSON.stringify(invalid)).toThrow("Choose the services to set up, each with backup or restore as its access.")
    }
  })

  it("names the script parameters for a choice, and none for the default", () => {
    expect(setupScriptArguments(DEFAULT_SETUP_CHOICE)).toBe("")
    expect(setupScriptArguments({ conditionalAccess: { access: "backup" }, intune: { access: "restore" } })).toBe("")
    expect(setupScriptArguments({ intune: { access: "backup" } })).toBe(" -Services Intune -RestoreAccess None")
    expect(setupScriptArguments({ intune: { access: "restore" }, conditionalAccess: { access: "restore" } })).toBe(" -Services Intune,ConditionalAccess -RestoreAccess Intune,ConditionalAccess")
    expect(setupScriptArguments({ entra: { access: "backup", areas: ["usersAndDevices", "groups"] }, defender: { access: "restore" } })).toBe(" -Services Entra,Defender -RestoreAccess Defender -Areas Groups,UsersAndDevices")
  })

  it("keeps the opt-in areas of all services apart by name, so one -Areas parameter can name them", () => {
    const optIn = MODULES.flatMap((module) => module.areas.filter((area) => area.optIn).map((area) => area.id))
    expect(new Set(optIn).size).toBe(optIn.length)
    expect(optIn).toEqual(["groups", "usersAndDevices", "applications"])
    expect(MODULES.flatMap((module) => module.areas.filter((area) => area.personalData).map((area) => area.id))).toEqual(["groups", "usersAndDevices"])
  })
})

describe("Permissions per folder and sign-in mode", () => {
  it("lets a signed-in admin back up every folder, and names what only a signed-in admin can read", () => {
    for (const module of MODULES) for (const area of module.areas) for (const part of area.parts) expect(part.backup.delegated, part.folders[0]).not.toBe("unsupported")
    const signedInOnly = MODULES.flatMap((module) => module.areas.flatMap((area) => area.parts.filter((part) => part.backup.application === "unsupported").flatMap((part) => part.folders)))
    expect(signedInOnly).toEqual(["MdmEnrollmentPolicies", "MamEnrollmentPolicies", "OnPremisesSynchronization", "OwnerlessGroupPolicy"])
    for (const folder of signedInOnly) {
      expect(backupNeed(folder, "application")).toBe("unsupported")
      expect(canBackUp(folder, application(...READER_ALLOWED_ROLES))).toBe(false)
    }
  })

  it("checks a folder against its own permissions, not against everything its area needs", () => {
    // Every existing registration holds Policy.Read.All: it reads most Entra tenant settings and nothing of the domains.
    const existing = delegated("User.Read", "Organization.Read.All", "Policy.Read.All")
    expect(canBackUp("AuthorizationPolicy", existing)).toBe(true)
    expect(canBackUp("DeviceRegistrationPolicy", existing)).toBe(true)
    expect(canBackUp("Organization", existing)).toBe(true)
    expect(canBackUp("Domains", existing)).toBe(false)
    expect(canBackUp("PermissionGrantPolicies", existing)).toBe(false)
    // App-only, the device registration policy needs the permission Microsoft lists for it.
    expect(canBackUp("DeviceRegistrationPolicy", application("Policy.Read.All"))).toBe(false)
    expect(canBackUp("DeviceRegistrationPolicy", application("Policy.Read.DeviceConfiguration"))).toBe(true)
    // A folder that needs two permissions needs both.
    expect(canBackUp("AdministrativeUnits", delegated("AdministrativeUnit.Read.All"))).toBe(false)
    expect(canBackUp("AdministrativeUnits", delegated("AdministrativeUnit.Read.All", "RoleManagement.Read.Directory"))).toBe(true)
    expect(canBackUp("AdministrativeUnits", delegated("Directory.Read.All"))).toBe(true)
    expect(canBackUp("NotAFolder", delegated())).toBe(true)
  })

  it("shows an area as covered when every folder the sign-in mode can use is, and names the first permission of what is missing", () => {
    const entra = checkModules(delegated("Policy.Read.All", "Organization.Read.All"), [MODULE_BY_ID.get("entra")!])[0]!
    const settings = entra.areas.find((area) => area.label === "Tenant settings")!
    expect(settings.backup).toBe(false)
    expect(settings.missingBackup!.map((group) => group[0])).toEqual(["Policy.Read.PermissionGrant", "GroupSettings.Read.All", "Domain.Read.All", "OnPremDirectorySynchronization.Read.All"])
    expect(entra.backup).toBe("missing")
    const ready = checkModules(delegated(...graphPermissions({ entra: { access: "backup", areas: ["groups", "usersAndDevices", "applications"] } }, "delegated")), [MODULE_BY_ID.get("entra")!])[0]!
    expect(ready.backup).toBe("ready")
    expect(ready.restore).toBe("missing")
    // App-only, the folders only a signed-in admin can read do not count against the area.
    expect(areaNeed(MODULE_BY_ID.get("entra")!.areas[0]!, "backup", "application").flat()).not.toContain("OnPremDirectorySynchronization.Read.All")
    expect(checkModules(application(...readerRoles({ entra: { access: "backup" } })), [MODULE_BY_ID.get("entra")!])[0]!.areas.filter((area) => !area.backup).map((area) => area.label)).toEqual(["Groups", "Users and devices", "Applications"])
  })

  it("stops a restore up front for a service with a token pre-check, with the folder's own permission or the reason it cannot be restored", () => {
    expect(restorePermissionBlocker("AuthorizationPolicy", delegated("Policy.Read.All"))).toBe("Restoring Entra ID tenant settings needs the Policy.ReadWrite.Authorization permission, which the TenuVault app registration does not have. Services and permissions shows how to add it.")
    expect(restorePermissionBlocker("AuthorizationPolicy", delegated("Policy.ReadWrite.Authorization"))).toBeUndefined()
    expect(restorePermissionBlocker("HardwareOathDevices", delegated("Policy.ReadWrite.AuthenticationMethod"))).toBe("Entra ID authentication cannot be restored through Microsoft Graph.")
    expect(restorePermissionBlocker("DefenderCustomDetectionRules", application("CustomDetection.Read.All"))).toBe("Defender detection and response can only be restored by a signed-in admin.")
    // Conditional Access as before, and Intune never.
    expect(restorePermissionBlocker("ConditionalAccessPolicies", delegated("Policy.Read.All"))).toBe("Restoring Entra Conditional Access policies needs the Policy.ReadWrite.ConditionalAccess permission, which the TenuVault app registration does not have. Services and permissions shows how to add it.")
    expect(restorePermissionBlocker("DeviceCategories", delegated())).toBeUndefined()
  })

  it("asks for the first permission of each group and never a write permission to read", () => {
    for (const module of MODULES) for (const area of module.areas) for (const mode of ["delegated", "application"] as const) {
      for (const permission of areaPermissions(area, "backup", mode)) expect(permission, `${module.id}/${area.id}`).not.toMatch(WRITE)
      for (const access of ["backup", "restore"] as AccessLevel[]) expect(areaPermissions(area, access, mode, new Set(areaPermissions(area, access, mode))), area.id).toEqual([])
    }
  })
})

describe("Permissions TenuVault knows", () => {
  it("are everything a choice can ask for, the two declared write permissions and the optional ones", () => {
    const everything: PermissionChoice = Object.fromEntries(MODULES.map((module) => [module.id, { access: "restore", areas: module.areas.filter((area) => area.optIn).map((area) => area.id) }]))
    const known = knownPermissions("delegated")
    expect(known.map((api) => api.api)).toEqual(["Microsoft Graph", "Azure Service Management", "Azure Storage"])
    for (const access of ["backup", "restore"] as const) {
      const choice = Object.fromEntries(Object.entries(everything).map(([id, picked]) => [id, { ...picked, access }]))
      for (const permission of graphPermissions(choice, "delegated", OPTIONAL_PERMISSIONS.map((entry) => entry.id))) expect(known[0]!.permissions, permission).toContain(permission)
    }
    expect(known[0]!.permissions).toContain("Policy.ReadWrite.ConditionalAccess")
    expect(known[0]!.permissions).not.toContain("Mail.Read")
    expect(knownPermissions("application").map((api) => api.api)).toEqual(["Microsoft Graph"])
  })

  describe("as proof that an administrator approved a registration", () => {
    const approved = (...permissions: string[]) => showsApproval(new Set(permissions))
    const backup = (id: ModuleId) => graphPermissions({ [id]: { access: "backup" } }, "delegated").slice(2)

    it("take one Intune permission, as before, whether it reads or writes", () => {
      for (const permission of ["DeviceManagementApps.ReadWrite.All", "DeviceManagementApps.Read.All", "DeviceManagementManagedDevices.Read.All", "DeviceManagementRBAC.ReadWrite.All"]) expect(approved(permission), permission).toBe(true)
      expect(approved("User.Read", "Organization.Read.All", "DeviceManagementScripts.Read.All")).toBe(true)
    })

    it("take most of what backing up Entra ID or Defender asks for, and not a part of it that many apps hold", () => {
      const entra = backup("entra")
      const defender = backup("defender")
      expect(approved(...entra)).toBe(true)
      expect(approved(...defender)).toBe(true)
      // A registration made by an earlier version that lacks a few newer permissions still counts.
      expect(approved(...entra.slice(0, Math.floor(entra.length / 2) + 1))).toBe(true)
      expect(approved(...entra.slice(0, Math.floor(entra.length / 2)))).toBe(false)
      expect(approved(...defender.slice(0, 5))).toBe(true)
      expect(approved(...defender.slice(0, 4))).toBe(false)
      // A write permission that also reads counts for the read it stands in for.
      expect(approved(...graphPermissions({ defender: { access: "restore" } }, "delegated").slice(2))).toBe(true)
      for (const few of [["Policy.Read.All"], ["Domain.Read.All"], ["SecurityEvents.Read.All", "CustomDetection.Read.All"], ["Policy.Read.All", "Domain.Read.All", "RoleManagement.Read.Directory"]]) expect(approved(...few), few.join(" ")).toBe(false)
    })

    it("never take the permissions every sign-in has, the broad directory reads, an optional permission or Conditional Access alone", () => {
      expect(approved()).toBe(false)
      expect(approved("User.Read", "Organization.Read.All")).toBe(false)
      // The opt-in areas of Entra ID are made of permissions many apps are given.
      expect(approved("User.Read.All", "Group.Read.All", "GroupMember.Read.All", "Directory.Read.All", "Application.Read.All", "Device.Read.All", "Policy.Read.All")).toBe(false)
      expect(approved(...OPTIONAL_PERMISSIONS.flatMap((entry) => entry.permissions))).toBe(false)
      expect(approved("User.Read", "Organization.Read.All", "Policy.Read.All", "Policy.ReadWrite.ConditionalAccess")).toBe(false)
      expect(approved("Mail.Read", "Sites.Read.All", "Files.Read.All")).toBe(false)
    })
  })
})

describe("Backup Reader roles from the manifest", () => {
  it("requires the Intune permissions only while Intune is on, and those of no other service", () => {
    expect(readerRequiredRoles({ services: ["intune", "conditionalAccess", "entra", "defender"] })).toEqual(readerRoles())
    expect(readerRequiredRoles({ services: ["conditionalAccess", "entra", "defender"] })).toEqual([])
    expect(readerRequiredRoles({ services: [] })).toEqual([])
    // The device inventory permission is never required.
    expect(readerRequiredRoles(DEFAULT_SELECTION)).not.toContain("DeviceManagementManagedDevices.Read.All")
  })

  it("may hold the read permission of any area of any service, and nothing else", () => {
    const everything = readerRoles(Object.fromEntries(MODULES.map((module) => [module.id, { access: "backup" as const, areas: module.areas.filter((area) => area.optIn || area.appOnlyOptIn).map((area) => area.id) }])))
    expect([...READER_ALLOWED_ROLES].sort()).toEqual([...everything].sort())
    for (const role of ["DeviceManagementManagedDevices.Read.All", "Policy.Read.All", "Directory.Read.All", "SecurityEvents.Read.All"]) expect(READER_ALLOWED_ROLES.has(role), role).toBe(true)
    for (const role of ["Mail.Read", "Policy.ReadWrite.ConditionalAccess", "DeviceManagementApps.ReadWrite.All", "User.Read"]) expect(READER_ALLOWED_ROLES.has(role), role).toBe(false)
  })

  it("leaves out what the roles cannot read of the services and opt-in areas that are on, and nothing of the others", () => {
    const five = readerRoles()
    expect(readerExcludedFolders(five, DEFAULT_SELECTION)).toEqual(["DeviceCategories", "DeviceCleanupRules"])
    expect(readerExcludedFolders([...five, "DeviceManagementManagedDevices.Read.All"], DEFAULT_SELECTION)).toEqual([])
    expect(readerExcludedFolders(null, { services: ["conditionalAccess"] })).toEqual(["NamedLocations", "AuthenticationStrengths", "ConditionalAccessPolicies"])
    const entra = readerRoles({ entra: { access: "backup" } })
    expect(readerExcludedFolders(entra, { services: ["entra"] })).toEqual(["MdmEnrollmentPolicies", "MamEnrollmentPolicies", "OnPremisesSynchronization"])
    // An opt-in area that is on needs its own roles; one that is off is not the reader's to miss.
    expect(readerExcludedFolders(entra, { services: ["entra"], areas: { entra: ["groups"] } })).toEqual(["MdmEnrollmentPolicies", "MamEnrollmentPolicies", "OnPremisesSynchronization", "Groups", "GroupLifecyclePolicies", "OwnerlessGroupPolicy"])
    expect(readerExcludedFolders(readerRoles({ entra: { access: "backup", areas: ["groups"] } }), { services: ["entra"], areas: { entra: ["groups"] } })).toEqual(["MdmEnrollmentPolicies", "MamEnrollmentPolicies", "OnPremisesSynchronization", "OwnerlessGroupPolicy"])
  })

  it("reads a reader's roles back as the services and areas it was set up for, for every combination", () => {
    const combinations = choices().filter((choice) => Object.values(choice).every((picked) => picked.access === "backup"))
    expect(combinations.length).toBe(30)
    for (const choice of combinations) {
      const roles = readerRoles(choice)
      // The choice the roles amount to grants the same roles again, so a renewal changes nothing.
      expect([...readerRoles(readerChoice(roles))].sort(), JSON.stringify(choice)).toEqual([...roles].sort())
    }
    expect(readerChoice([])).toEqual({})
    // Roles that do not make up a whole service name none.
    expect(readerChoice(["DeviceManagementApps.Read.All", "Domain.Read.All"])).toEqual({})
  })

  it("keeps the switches of a reader for Intune and names the services of any other", () => {
    const five = readerRoles()
    expect(readerScriptArguments(five)).toBe("")
    expect(readerScriptArguments([...five, "DeviceManagementManagedDevices.Read.All"])).toBe(" -IncludeDeviceCategories")
    expect(readerScriptArguments([...five, "Policy.Read.All"])).toBe(" -IncludeConditionalAccess")
    expect(readerScriptArguments([...five, "DeviceManagementManagedDevices.Read.All", "Policy.Read.All"])).toBe(" -IncludeDeviceCategories -IncludeConditionalAccess")
    expect(readerScriptArguments(readerRoles({ defender: { access: "backup" } }))).toBe(" -Services Defender")
    expect(readerScriptArguments(readerRoles({ intune: { access: "backup" }, entra: { access: "backup", areas: ["usersAndDevices"] } }))).toBe(" -Services Intune,Entra -Areas UsersAndDevices")
    expect(readerScriptArguments([])).toBe("")
  })

  it("starts a tenant's first reader with the services it backs up, and a tenant with Intune as before", () => {
    expect(readerSetupArguments(DEFAULT_SELECTION)).toBe("")
    expect(readerSetupArguments({ services: ["intune", "conditionalAccess"] })).toBe("")
    expect(readerSetupArguments({ services: ["entra"] })).toBe(" -Services Entra")
    expect(readerSetupArguments({ services: ["conditionalAccess"] })).toBe(" -Services ConditionalAccess")
    expect(readerSetupArguments({ services: ["intune", "conditionalAccess", "entra", "defender"], areas: { entra: ["groups"] } })).toBe(" -Services Intune,ConditionalAccess,Entra,Defender")
    expect(readerSetupArguments({ services: [] })).toBe("")
  })
})
