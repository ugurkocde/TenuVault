import { INTUNE_TYPES, type Area, type IntuneType } from "./registry"

/**
 * What a backup covers. Stored as the types left out, so types added in later versions are
 * backed up without the admin having to opt in to each one.
 */
export interface BackupScope {
  /** Registry folders not backed up. */
  excluded: string[]
}

export type ScopePreset = "everything" | "policies" | "custom"

export const EVERYTHING: BackupScope = { excluded: [] }

/**
 * Apps are metadata only (installers are never downloaded) and most of them cannot be restored from a
 * backup, yet they take the longest to read. Tenants without a saved scope leave them out.
 */
export const POLICIES_ONLY: BackupScope = { excluded: ["Apps"] }

export const DEFAULT_SCOPE = POLICIES_ONLY

const FOLDERS = new Set(INTUNE_TYPES.map((type) => type.folder))

/** Drops unknown folders and duplicates; the order follows the registry. */
export function normalizeScope(scope: Partial<BackupScope> | null | undefined): BackupScope {
  const excluded = new Set(Array.isArray(scope?.excluded) ? scope.excluded.filter((folder) => typeof folder === "string") : [])
  return { excluded: INTUNE_TYPES.map((type) => type.folder).filter((folder) => excluded.has(folder) && FOLDERS.has(folder)) }
}

export function includedTypes(scope: BackupScope): IntuneType[] {
  const excluded = new Set(scope.excluded)
  return INTUNE_TYPES.filter((type) => !excluded.has(type.folder))
}

export function presetOf(scope: BackupScope): ScopePreset {
  const key = normalizeScope(scope).excluded.join(",")
  if (key === "") return "everything"
  if (key === POLICIES_ONLY.excluded.join(",")) return "policies"
  return "custom"
}

export function scopeForPreset(preset: Exclude<ScopePreset, "custom">): BackupScope {
  return preset === "everything" ? EVERYTHING : POLICIES_ONLY
}

/** Areas in registry order, each with its types. */
export const AREAS: Array<{ area: Area; types: IntuneType[] }> = INTUNE_TYPES.reduce<Array<{ area: Area; types: IntuneType[] }>>((areas, type) => {
  const group = areas.find((entry) => entry.area === type.area)
  if (group) group.types.push(type)
  else areas.push({ area: type.area, types: [type] })
  return areas
}, [])

/** A short description such as "Everything", "Everything except apps" or "12 of 40 types". */
export function describeScope(scope: BackupScope): string {
  const preset = presetOf(scope)
  if (preset === "everything") return "Everything"
  if (preset === "policies") return "Everything except apps"
  return `${INTUNE_TYPES.length - scope.excluded.length} of ${INTUNE_TYPES.length} types`
}

export interface ScopeMetadata {
  /** Included lists the type folders the backup attempted; absent on backups made before it was recorded. */
  Scope?: { Excluded?: unknown; Included?: unknown }
  SkippedTypes?: unknown
  FailedTypes?: unknown
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [])

/**
 * Every type folder the app knew about before backups recorded Scope.Included. A backup without that
 * list never held a type added to the registry later, so this list must not grow with the registry.
 */
export const LEGACY_FOLDERS: readonly string[] = [
  "DeviceConfigurations", "ConfigurationPolicies", "GroupPolicyConfigurations", "ReusablePolicySettings", "HardwareConfigurations",
  "CompliancePolicies", "ComplianceSettingsPolicies", "ComplianceScripts", "EndpointSecurityIntents", "PowerShellScripts", "ShellScripts",
  "CustomAttributeScripts", "Remediations", "FeatureUpdateProfiles", "QualityUpdateProfiles", "QualityUpdatePolicies", "DriverUpdateProfiles",
  "AppCategories", "Apps", "AppConfigurationPolicies", "ManagedAppConfigurations", "AppProtectionIOS", "AppProtectionAndroid",
  "AppProtectionWindows", "PolicySets", "EnrollmentConfigurations", "AutopilotProfiles", "AppleEnrollmentProfiles", "AppleAutomatedEnrollment",
  "AndroidEnrollmentProfiles", "DeviceCategories", "TermsAndConditions", "AssignmentFilters", "ScopeTags", "RoleDefinitions",
  "NotificationTemplates", "Branding", "DeviceCleanupRules", "MultiAdminApprovalPolicies",
]

/**
 * The folders a backup holds a complete copy of, from its metadata: the types it recorded as attempted,
 * minus those left out or that it could not read. Backups that did not record the attempted types
 * covered the types the app knew about then (LEGACY_FOLDERS), so a type added later is never counted
 * as covered by them.
 */
export function coveredFolders(metadata: ScopeMetadata | null | undefined): Set<string> {
  const recorded = metadata?.Scope?.Included
  const attempted = new Set(Array.isArray(recorded) ? strings(recorded) : LEGACY_FOLDERS)
  const missing = new Set([...strings(metadata?.Scope?.Excluded), ...strings(metadata?.SkippedTypes), ...strings(metadata?.FailedTypes)])
  return new Set(INTUNE_TYPES.map((type) => type.folder).filter((folder) => attempted.has(folder) && !missing.has(folder)))
}
