/**
 * The services TenuVault backs up and restores, each with the Microsoft Graph permissions it needs.
 *
 * A module groups registry folders under one service (Intune, Entra Conditional Access, and later
 * Exchange, Teams or Outlook). Backup and restore have separate permission sets, so an app
 * registration can be consented for reading a service without being able to change it. The
 * permission check compares these requirements with the permissions in the token TenuVault already
 * holds; it never asks for consent or calls Graph itself.
 *
 * Pure, so the main process, the API routes and tests evaluate the same rules.
 */

export type ModuleId = "intune" | "conditionalAccess"

/** At least one of these permissions satisfies the requirement. ReadWrite always also covers Read. */
export type AnyOf = readonly string[]

/** A part of a module that needs its own permission, such as Intune apps or scripts. */
export interface PermissionArea {
  label: string
  folders: readonly string[]
  backup: AnyOf
  restore: AnyOf
}

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
  /**
   * Off until the admin turns it on for the tenant. Modules that were always backed up (Intune)
   * are on; new services start off so an update never adds a service to backups unasked.
   */
  optIn: boolean
  areas: readonly PermissionArea[]
  /** Admin roles that can use the module. Shown as guidance: tokens do not reliably list roles. */
  roles: string
  /** How to add the restore permissions with the setup script, when they are not added by default. */
  restoreSetup?: string
  /** Backup Reader (app-only) application permission that lets scheduled backups read the module. */
  readerRole?: string
}

const rw = (name: string): AnyOf => [`${name}.ReadWrite.All`]
const readOrWrite = (name: string): AnyOf => [`${name}.Read.All`, `${name}.ReadWrite.All`]

export const MODULES: readonly ServiceModule[] = [
  {
    id: "intune",
    label: "Intune",
    description: "Device configuration, compliance, endpoint security, apps, scripts, enrollment and tenant administration.",
    optIn: false,
    roles: "Intune Administrator, or an Intune role that covers the policies you back up and restore.",
    areas: [
      {
        label: "Configuration and compliance",
        folders: [
          "DeviceConfigurations", "ConfigurationPolicies", "GroupPolicyConfigurations", "ReusablePolicySettings", "HardwareConfigurations",
          "CompliancePolicies", "ComplianceSettingsPolicies", "CompliancePolicySettings", "EndpointSecurityIntents",
          "FeatureUpdateProfiles", "QualityUpdateProfiles", "QualityUpdatePolicies", "DriverUpdateProfiles",
          "AssignmentFilters", "NotificationTemplates",
        ],
        backup: readOrWrite("DeviceManagementConfiguration"),
        restore: rw("DeviceManagementConfiguration"),
      },
      {
        label: "Apps and app protection",
        folders: ["AppCategories", "Apps", "AppConfigurationPolicies", "ManagedAppConfigurations", "AppProtectionIOS", "AppProtectionAndroid", "AppProtectionWindows", "PolicySets"],
        backup: readOrWrite("DeviceManagementApps"),
        restore: rw("DeviceManagementApps"),
      },
      {
        label: "Enrollment and branding",
        folders: ["EnrollmentConfigurations", "AutopilotProfiles", "AppleEnrollmentProfiles", "AppleAutomatedEnrollment", "AndroidEnrollmentProfiles", "TermsAndConditions", "Branding"],
        backup: readOrWrite("DeviceManagementServiceConfig"),
        restore: rw("DeviceManagementServiceConfig"),
      },
      {
        label: "Scripts and remediations",
        folders: ["PowerShellScripts", "ShellScripts", "CustomAttributeScripts", "Remediations", "ComplianceScripts"],
        backup: readOrWrite("DeviceManagementScripts"),
        restore: rw("DeviceManagementScripts"),
      },
      {
        label: "Roles and scope tags",
        folders: ["ScopeTags", "RoleDefinitions", "MultiAdminApprovalPolicies"],
        backup: readOrWrite("DeviceManagementRBAC"),
        restore: rw("DeviceManagementRBAC"),
      },
      {
        label: "Device categories and clean-up rules",
        folders: ["DeviceCategories", "DeviceCleanupRules"],
        backup: readOrWrite("DeviceManagementManagedDevices"),
        restore: rw("DeviceManagementManagedDevices"),
      },
    ],
  },
]

export const MODULE_BY_ID = new Map(MODULES.map((module) => [module.id, module]))

const MODULE_BY_FOLDER = new Map(MODULES.flatMap((module) => module.areas.flatMap((area) => area.folders.map((folder) => [folder.toLowerCase(), { module, area }] as const))))

export function moduleForFolder(folder: string): { module: ServiceModule; area: PermissionArea } | undefined {
  return MODULE_BY_FOLDER.get(folder.toLowerCase())
}

/** Folders of modules that are off until the admin turns them on. */
export function optInFolders(): string[] {
  return MODULES.filter((module) => module.optIn).flatMap((module) => module.areas.flatMap((area) => area.folders))
}

/**
 * Folders a backup leaves out because their module is off for the tenant. `enabled` lists the
 * opt-in modules the admin turned on.
 */
export function disabledFolders(enabled: readonly ModuleId[]): string[] {
  return MODULES.filter((module) => module.optIn && !enabled.includes(module.id)).flatMap((module) => module.areas.flatMap((area) => area.folders))
}

/** The permissions a token grants: delegated scopes (scp) and application roles (roles). */
export interface GrantedPermissions {
  kind: "delegated" | "application"
  permissions: ReadonlySet<string>
}

const satisfied = (needed: AnyOf, granted: ReadonlySet<string>) => needed.some((permission) => granted.has(permission))

export type Readiness = "ready" | "partial" | "missing"

export interface AreaCheck {
  label: string
  folders: readonly string[]
  backup: boolean
  restore: boolean
  /** What is missing, for example "DeviceManagementApps.Read.All or DeviceManagementApps.ReadWrite.All". */
  missingBackup?: string
  missingRestore?: string
}

export interface ModuleCheck {
  id: ModuleId
  label: string
  backup: Readiness
  restore: Readiness
  areas: AreaCheck[]
}

const describe = (needed: AnyOf) => needed.join(" or ")

/** Whether the granted permissions cover each module's backup and restore, area by area. */
export function checkModules(granted: GrantedPermissions, modules: readonly ServiceModule[] = MODULES): ModuleCheck[] {
  return modules.map((module) => {
    const areas = module.areas.map((area): AreaCheck => {
      const backup = satisfied(area.backup, granted.permissions)
      const restore = satisfied(area.restore, granted.permissions)
      return {
        label: area.label,
        folders: area.folders,
        backup,
        restore,
        ...(backup ? {} : { missingBackup: describe(area.backup) }),
        ...(restore ? {} : { missingRestore: describe(area.restore) }),
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
 * Only opt-in modules are gated. Intune restores keep relying on Graph to refuse a write, so a folder
 * mapped to the wrong permission here can never block a restore that works; for Intune the mapping
 * only informs the permission check in Settings.
 */
export function restorePermissionBlocker(folder: string, granted: GrantedPermissions | undefined): string | undefined {
  const entry = moduleForFolder(folder)
  if (!entry || !granted || !entry.module.optIn) return undefined
  if (satisfied(entry.area.restore, granted.permissions)) return undefined
  const setup = entry.module.restoreSetup ? ` ${entry.module.restoreSetup}` : " Add it to the TenuVault app registration and grant admin consent, then sign in again."
  return `Restoring ${entry.module.label} ${entry.area.label.toLowerCase()} needs the ${describe(entry.area.restore)} permission, which the TenuVault app registration does not have.${setup}`
}

/** Whether the granted permissions can read this folder; true for folders that belong to no module. */
export function canBackUp(folder: string, granted: GrantedPermissions): boolean {
  const entry = moduleForFolder(folder)
  return !entry || satisfied(entry.area.backup, granted.permissions)
}
