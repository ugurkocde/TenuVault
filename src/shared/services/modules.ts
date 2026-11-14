/**
 * The services TenuVault backs up and restores, each with the Microsoft Graph permissions it needs.
 *
 * A module groups registry folders under one service (Intune, Entra Conditional Access, Entra ID
 * and Defender). Backup and restore have separate permission sets, so an app
 * registration can be consented for reading a service without being able to change it. The
 * permission check compares these requirements with the permissions in the token TenuVault already
 * holds; it never asks for consent or calls Graph itself.
 *
 * Pure, so the main process, the API routes and tests evaluate the same rules.
 */

import { area, part, type FolderPermissions, type Need, type PermissionArea, type Requirement, type SignInMode } from "./areas"
import { DEFENDER_AREAS } from "./defender"
import { ENTRA_AREAS } from "./entra"

export type { AnyOf, FolderPermissions, Need, PermissionArea, Requirement, SignInMode } from "./areas"

export type ModuleId = "intune" | "conditionalAccess" | "entra" | "defender"

/**
 * What TenuVault asks for when a service is set up for a tenant: read access for backups, or read and
 * write access so it can also restore. It only shapes the permissions requested at setup. It never
 * decides whether a backup or a restore runs: the permissions in the token do.
 */
export type AccessLevel = "backup" | "restore"

/**
 * The app registration a module uses. Every tenant has one today ("default", the app the admin signs
 * in with); modules carry the reference so a later version can map a service to its own app
 * registration, for example one owned by the identity team for Entra.
 */
export type ConnectionId = "default"

export interface ServiceModule {
  id: ModuleId
  label: string
  description: string
  /** The admin can turn the service on or off for a tenant. */
  switchable: boolean
  /**
   * On for a tenant that has made no choice. Intune is, as it always was backed up; the other services
   * start off, so an update never adds a service to backups unasked.
   */
  defaultOn: boolean
  /**
   * The permissions in the token are checked before a folder of the service is read or written, so a
   * missing permission is named up front. Off for Intune: its backups and restores keep relying on
   * Microsoft Graph to refuse a request, so a folder mapped to the wrong permission here can never
   * block a restore that works.
   */
  precheck: boolean
  /** The access level a tenant has for the service until the admin chooses another. */
  defaultAccess: AccessLevel
  areas: readonly PermissionArea[]
  /** Admin roles that can use the module. Shown as guidance: tokens do not reliably list roles. */
  roles: string
  /**
   * The delegated Microsoft Graph permissions to add for restores when the setup script does not grant
   * them by default, with their IDs (verified against the Microsoft Graph service principal), and the
   * setup script switch that adds them to a new app registration. Re-running the script always creates
   * a new app registration, so an existing one is changed in Entra or with the Azure CLI instead.
   */
  restoreAccess?: { permissions: ReadonlyArray<{ name: string; id: string }>; newSetupSwitch: string }
  /** Backup Reader (app-only) application permission that lets scheduled backups read the module. */
  readerRole?: string
  /**
   * A Microsoft Graph beta path of one small read that only an account with access to the service can
   * make. Restore history opens after it succeeds, so a stored sign-in alone does not show it.
   */
  accessProbe?: string
  /**
   * A Microsoft Graph beta path of one small read that shows a Backup Reader's token works for the
   * service, with the application permission the read needs.
   */
  readerProbe?: { path: string; role: string }
}

/**
 * Folders of Intune that one permission family covers: Read.All or ReadWrite.All backs them up,
 * ReadWrite.All restores them, and the Backup Reader gets Read.All.
 */
const intune = (family: string, folders: readonly string[], options: Pick<FolderPermissions, "restoreNotRequested"> = {}) =>
  part(folders, [[`${family}.Read.All`, `${family}.ReadWrite.All`]], [[`${family}.Read.All`]], [[`${family}.ReadWrite.All`]], options)

export const MODULES: readonly ServiceModule[] = [
  {
    id: "intune",
    label: "Intune",
    description: "Device configuration, compliance, endpoint security, apps, scripts, enrollment and tenant administration.",
    switchable: true,
    defaultOn: true,
    precheck: false,
    defaultAccess: "restore",
    roles: "Intune Administrator, or an Intune role that covers the policies you back up and restore.",
    accessProbe: "deviceManagement/deviceCategories?$top=1&$select=id",
    readerProbe: { path: "deviceManagement/deviceCompliancePolicies?$top=1&$select=id", role: "DeviceManagementConfiguration.Read.All" },
    areas: [
      area({ id: "configuration", label: "Configuration and compliance" }, [
        intune("DeviceManagementConfiguration", [
          "DeviceConfigurations", "ConfigurationPolicies", "GroupPolicyConfigurations", "ReusablePolicySettings", "HardwareConfigurations",
          "CompliancePolicies", "ComplianceSettingsPolicies", "CompliancePolicySettings", "EndpointSecurityIntents",
          "FeatureUpdateProfiles", "QualityUpdateProfiles", "QualityUpdatePolicies", "DriverUpdateProfiles",
          "AssignmentFilters", "NotificationTemplates",
        ]),
      ]),
      area({ id: "apps", label: "Apps and app protection" }, [
        intune("DeviceManagementApps", ["AppCategories", "Apps", "AppConfigurationPolicies", "ManagedAppConfigurations", "AppProtectionIOS", "AppProtectionAndroid", "AppProtectionWindows", "PolicySets"]),
      ]),
      area({ id: "enrollment", label: "Enrollment and branding" }, [
        intune("DeviceManagementServiceConfig", ["EnrollmentConfigurations", "AutopilotProfiles", "AutopilotDevices", "AppleEnrollmentProfiles", "AppleAutomatedEnrollment", "AndroidEnrollmentProfiles", "TermsAndConditions", "Branding"]),
      ]),
      area({ id: "scripts", label: "Scripts and remediations" }, [
        intune("DeviceManagementScripts", ["PowerShellScripts", "ShellScripts", "CustomAttributeScripts", "Remediations", "ComplianceScripts"]),
      ]),
      area({ id: "roles", label: "Roles and scope tags" }, [
        intune("DeviceManagementRBAC", ["ScopeTags", "RoleDefinitions", "MultiAdminApprovalPolicies"]),
      ]),
      // DeviceManagementManagedDevices.ReadWrite.All can also wipe and retire devices, so setup only ever asks to read.
      // The application permission shows the managed device inventory, so the Backup Reader gets it only on request.
      area({ id: "devices", label: "Device categories and clean-up rules", appOnlyOptIn: true }, [
        intune("DeviceManagementManagedDevices", ["DeviceCategories", "DeviceCleanupRules"], { restoreNotRequested: true }),
      ]),
    ],
  },
  {
    id: "conditionalAccess",
    label: "Entra Conditional Access",
    description: "Conditional Access policies, named locations and authentication strengths. Restored policies start in report-only mode.",
    switchable: true,
    defaultOn: false,
    precheck: true,
    defaultAccess: "backup",
    roles: "Security Reader or Global Reader to back up; Conditional Access Administrator or Security Administrator to restore.",
    restoreAccess: { permissions: [{ name: "Policy.ReadWrite.ConditionalAccess", id: "ad902697-1014-4ef5-81ef-2b4301988e8c" }], newSetupSwitch: "-IncludeConditionalAccessRestore" },
    readerRole: "Policy.Read.All",
    accessProbe: "identity/conditionalAccess/policies?$top=1&$select=id",
    readerProbe: { path: "identity/conditionalAccess/policies?$top=1&$select=id", role: "Policy.Read.All" },
    // Writes also need Policy.Read.All (a documented Microsoft Graph requirement for POST and PATCH of policies).
    areas: [
      area({ id: "namedLocations", label: "Named locations" }, [
        part(["NamedLocations"], [["Policy.Read.All", "Policy.ReadWrite.ConditionalAccess"]], [["Policy.Read.All"]], [["Policy.Read.All"], ["Policy.ReadWrite.ConditionalAccess"]]),
      ]),
      area({ id: "authenticationStrengths", label: "Authentication strengths" }, [
        part(
          ["AuthenticationStrengths"],
          [["Policy.Read.All", "Policy.Read.AuthenticationMethod", "Policy.ReadWrite.AuthenticationMethod", "Policy.ReadWrite.ConditionalAccess"]],
          [["Policy.Read.All"]],
          [["Policy.ReadWrite.ConditionalAccess", "Policy.ReadWrite.AuthenticationMethod"]],
        ),
      ]),
      area({ id: "policies", label: "Policies" }, [
        part(["ConditionalAccessPolicies"], [["Policy.Read.All"]], [["Policy.Read.All"]], [["Policy.Read.All"], ["Policy.ReadWrite.ConditionalAccess"]]),
      ]),
    ],
  },
  {
    id: "entra",
    label: "Entra ID",
    description: "Tenant settings, authentication, external identities, roles and governance. Groups, users, devices and applications are backed up only when you turn them on.",
    switchable: true,
    defaultOn: false,
    precheck: true,
    defaultAccess: "backup",
    roles: "Global Reader to back up; to restore, the administrator role of the setting, such as Security Administrator or Privileged Role Administrator.",
    readerProbe: { path: "policies/authorizationPolicy?$select=id", role: "Policy.Read.All" },
    areas: ENTRA_AREAS,
  },
  {
    id: "defender",
    label: "Defender",
    description: "Detection and response, email and collaboration, identity, and posture and access settings.",
    switchable: true,
    defaultOn: false,
    precheck: true,
    defaultAccess: "backup",
    roles: "Security Reader or Global Reader to back up; Security Administrator to restore.",
    readerProbe: { path: "security/secureScoreControlProfiles?$top=1&$select=id", role: "SecurityEvents.Read.All" },
    areas: DEFENDER_AREAS,
  },
]

export const MODULE_BY_ID = new Map(MODULES.map((module) => [module.id, module]))

const MODULE_BY_FOLDER = new Map(
  MODULES.flatMap((module) => module.areas.flatMap((area) => area.parts.flatMap((part) => part.folders.map((folder) => [folder.toLowerCase(), { module, area, part }] as const)))),
)

/** The service and area a folder belongs to, with the part of the area that names its permissions. */
export function moduleForFolder(folder: string): { module: ServiceModule; area: PermissionArea; part: FolderPermissions } | undefined {
  return MODULE_BY_FOLDER.get(folder.toLowerCase())
}

/** What a tenant backs up: the services that are on and, for each, its opt-in areas that are on. */
export interface ServiceSelection {
  services: readonly ModuleId[]
  areas?: Partial<Record<ModuleId, readonly string[]>>
}

/** The selection of a tenant that has made no choice: the services that are on by default, without opt-in areas. */
export const DEFAULT_SELECTION: ServiceSelection = { services: MODULES.filter((module) => module.defaultOn).map((module) => module.id) }

/** Folders a backup leaves out because their service, or their opt-in area, is off for the tenant. */
export function disabledFolders(selection: ServiceSelection): string[] {
  return MODULES.flatMap((module) =>
    module.areas
      .filter((area) => !selection.services.includes(module.id) || (area.optIn && !selection.areas?.[module.id]?.includes(area.id)))
      .flatMap((area) => area.folders),
  )
}

/** The permissions a token grants: delegated scopes (scp) and application roles (roles). */
export interface GrantedPermissions {
  kind: SignInMode
  permissions: ReadonlySet<string>
}

const satisfied = (needed: Requirement, granted: ReadonlySet<string>) => needed.every((group) => group.some((permission) => granted.has(permission)))

/** Whether the granted permissions meet a need; never when no permission lets the sign-in mode do it. */
export const meets = (needed: Need, granted: ReadonlySet<string>) => needed !== "unsupported" && satisfied(needed, granted)

/**
 * What an area needs as a whole for the sign-in mode: every group of every part the mode can use.
 * Parts the mode cannot use at all are left out, because no permission would change that.
 */
export function areaNeed(area: PermissionArea, access: "backup" | "restore", mode: SignInMode): Requirement {
  const groups = area.parts.flatMap((part) => (part[access][mode] === "unsupported" ? [] : part[access][mode]))
  return [...new Map(groups.map((group) => [group.join("|"), group])).values()]
}

export type Readiness = "ready" | "partial" | "missing"

export interface AreaCheck {
  label: string
  folders: readonly string[]
  backup: boolean
  restore: boolean
  /** What is missing: every group must be granted, any one permission of a group does. */
  missingBackup?: Requirement
  missingRestore?: Requirement
}

export interface ModuleCheck {
  id: ModuleId
  label: string
  backup: Readiness
  restore: Readiness
  areas: AreaCheck[]
}

const missingGroups = (needed: Requirement, granted: ReadonlySet<string>): Requirement => needed.filter((group) => !group.some((permission) => granted.has(permission)))

/** "A or B", and groups joined with "and": what to grant for the requirement, missing groups only. */
export const describeRequirement = (needed: Requirement, granted: ReadonlySet<string> = new Set()) =>
  missingGroups(needed, granted).map((group) => group.join(" or ")).join(" and ")

/** Whether the granted permissions cover each module's backup and restore, area by area. */
export function checkModules(granted: GrantedPermissions, modules: readonly ServiceModule[] = MODULES): ModuleCheck[] {
  return modules.map((module) => {
    const areas = module.areas.map((area): AreaCheck => {
      const needed = { backup: areaNeed(area, "backup", granted.kind), restore: areaNeed(area, "restore", granted.kind) }
      const backup = satisfied(needed.backup, granted.permissions)
      const restore = satisfied(needed.restore, granted.permissions)
      return {
        label: area.label,
        folders: area.folders,
        backup,
        restore,
        ...(backup ? {} : { missingBackup: missingGroups(needed.backup, granted.permissions) }),
        ...(restore ? {} : { missingRestore: missingGroups(needed.restore, granted.permissions) }),
      }
    })
    const readiness = (key: "backup" | "restore"): Readiness => (areas.every((area) => area[key]) ? "ready" : areas.some((area) => area[key]) ? "partial" : "missing")
    return { id: module.id, label: module.label, backup: readiness("backup"), restore: readiness("restore"), areas }
  })
}

/**
 * Why the granted permissions cannot write this folder, or undefined when they can. Restore asks before
 * the first write, so a missing permission is reported up front instead of as a refusal halfway through.
 *
 * Only services with a token pre-check are gated. Intune restores keep relying on Graph to refuse a
 * write, so a folder mapped to the wrong permission here can never block a restore that works; for
 * Intune the mapping only informs the permission check in Settings.
 */
export function restorePermissionBlocker(folder: string, granted: GrantedPermissions | undefined): string | undefined {
  const entry = moduleForFolder(folder)
  if (!entry || !granted || !entry.module.precheck) return undefined
  const needed = entry.part.restore[granted.kind]
  const what = `${entry.module.label} ${entry.area.label.toLowerCase()}`
  if (needed === "unsupported") return `${what} ${granted.kind === "application" ? "can only be restored by a signed-in admin" : "cannot be restored through Microsoft Graph"}.`
  if (satisfied(needed, granted.permissions)) return undefined
  return `Restoring ${what} needs the ${describeRequirement(needed, granted.permissions)} permission, which the TenuVault app registration does not have. ${SERVICES_PAGE} shows how to add it.`
}

/**
 * What the sign-in mode needs to read this folder: "unsupported" when only the other mode can read
 * it, and undefined for a folder that belongs to no module.
 */
export function backupNeed(folder: string, mode: SignInMode): Need | undefined {
  return moduleForFolder(folder)?.part.backup[mode]
}

/** Whether the granted permissions can read this folder; true for folders that belong to no module. */
export function canBackUp(folder: string, granted: GrantedPermissions): boolean {
  const needed = backupNeed(folder, granted.kind)
  return needed === undefined || meets(needed, granted.permissions)
}

/**
 * The name of the Settings card that shows and fixes permissions. Messages that mention it are shown
 * with the phrase linked to the card, so a skipped backup type or a blocked restore leads to the fix.
 */
export const SERVICES_PAGE = "Services and permissions"

/** Settings route and anchor of the card. */
export const SERVICES_HREF = "/portal/settings?section=services"

/**
 * Azure CLI commands that add a module's restore permissions to the tenant's existing app registration
 * and grant admin consent. The setup script cannot do this: it always creates a new app registration.
 */
export function restoreAccessCommands(module: Pick<ServiceModule, "restoreAccess">, tenantId: string, clientId: string): string | undefined {
  const access = module.restoreAccess
  if (!access) return undefined
  const permissions = access.permissions.map((permission) => `${permission.id}=Scope`).join(" ")
  return [
    `# Adds ${access.permissions.map((permission) => permission.name).join(", ")} (delegated) to the TenuVault app registration ${clientId}, then grants admin consent.`,
    `az login --tenant ${tenantId} --allow-no-subscriptions`,
    `az ad app permission add --id ${clientId} --api 00000003-0000-0000-c000-000000000000 --api-permissions ${permissions}`,
    `az ad app permission admin-consent --id ${clientId}`,
  ].join("\n")
}

/** The app registration's API permissions page in the Entra admin center. */
export function entraApiPermissionsUrl(clientId: string): string {
  return `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/${encodeURIComponent(clientId)}/isMSAApp~/false`
}

/**
 * The fewest permission groups that close every gap of a module, for backup and restore. A group is left
 * out when a smaller missing group lies within it, because granting that one satisfies both: with nothing
 * granted, Conditional Access needs exactly Policy.Read.All and Policy.ReadWrite.ConditionalAccess.
 */
export function missingPermissions(module: { check: Pick<ModuleCheck, "areas"> | null }): Requirement {
  const groups = module.check?.areas.flatMap((area) => [...(area.missingBackup ?? []), ...(area.missingRestore ?? [])]) ?? []
  const unique = [...new Map(groups.map((group) => [[...group].sort().join("|"), group])).values()]
  return unique.filter((group) => !unique.some((other) => other !== group && other.length < group.length && other.every((permission) => group.includes(permission))))
}
