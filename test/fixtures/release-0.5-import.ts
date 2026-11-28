import { createHash } from "node:crypto"

/**
 * The rules release 0.5.x applies when it imports a backup archive, frozen from that release
 * (src/main/backup/archive.ts, src/shared/intune/compare.ts and the registry's folders at commit
 * 8b9f77c8). A backup written by a later version must keep passing them, so they are copied here
 * and do not follow the code as it changes. Only the ZIP directory checks are left out: they
 * concern the archive file, not what the engine writes.
 */

/** The type folders release 0.5.x knows. A backup that holds another folder is not one it can import. */
export const RELEASE_FOLDERS = [
  "DeviceConfigurations", "ConfigurationPolicies", "GroupPolicyConfigurations", "ReusablePolicySettings", "HardwareConfigurations", "CompliancePolicies",
  "ComplianceSettingsPolicies", "ComplianceScripts", "CompliancePolicySettings", "EndpointSecurityIntents", "PowerShellScripts", "ShellScripts",
  "CustomAttributeScripts", "Remediations", "FeatureUpdateProfiles", "QualityUpdateProfiles", "QualityUpdatePolicies", "DriverUpdateProfiles", "AppCategories",
  "Apps", "AppConfigurationPolicies", "ManagedAppConfigurations", "AppProtectionIOS", "AppProtectionAndroid", "AppProtectionWindows", "PolicySets",
  "EnrollmentConfigurations", "AutopilotProfiles", "AutopilotDevices", "AppleEnrollmentProfiles", "AppleAutomatedEnrollment", "AndroidEnrollmentProfiles",
  "DeviceCategories", "TermsAndConditions", "AssignmentFilters", "ScopeTags", "RoleDefinitions", "NotificationTemplates", "Branding", "DeviceCleanupRules",
  "MultiAdminApprovalPolicies", "NamedLocations", "AuthenticationStrengths", "ConditionalAccessPolicies",
]
const KNOWN = new Set(RELEASE_FOLDERS.map((folder) => folder.toLowerCase()))
const INVENTORY = new Set(["autopilotdevices"])

const VOLATILE = new Set(["lastModifiedDateTime", "createdDateTime", "modifiedDateTime", "version", "secretReferenceValueId"])
const volatile = (key: string) => VOLATILE.has(key) || key === "@odata.context" || key.endsWith("@odata.context") || key.endsWith("@odata.nextLink")
function comparableSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => comparableSnapshot(entry))
  if (value === null || typeof value !== "object") return value ?? null
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (volatile(key) || key === "__proto__") continue
    result[key] = comparableSnapshot((value as Record<string, unknown>)[key])
  }
  return result
}
const snapshotHash = (value: Record<string, any>) => createHash("sha256").update(JSON.stringify(comparableSnapshot(value))).digest("base64").slice(0, 22)

const guid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)
const policyTotal = (counts: Record<string, number>) => Object.entries(counts).reduce((sum, [folder, count]) => (INVENTORY.has(folder.toLowerCase()) ? sum : sum + count), 0)

/** reviewArchive of release 0.5.x over the files of an archive. Throws with the release's own message when it refuses. */
export function reviewAsRelease05(archive: Map<string, Buffer>): { tenantId: string; backupId: string; count: number } {
  const files = new Map(archive)
  for (const name of files.keys()) {
    if (name !== "metadata.json" && name !== "tenuvault-manifest.json" && !/^[A-Za-z0-9]+\/[^/]+\.json$/.test(name)) throw new Error("Archive contains an unsupported file")
  }
  const parse = (name: string): unknown => { try { return JSON.parse(files.get(name)?.toString("utf8") ?? "") } catch { throw new Error(`Missing or invalid ${name}`) } }
  const manifest = parse("tenuvault-manifest.json"), metadata = parse("metadata.json")
  if (!object(manifest) || manifest.version !== 1 || !guid.test(manifest.sourceTenantId) || !/^backup-\d{4}-\d{2}-\d{2}-\d{6}$/.test(manifest.backupId)) throw new Error("A TenuVault export manifest with source tenant identity is required")
  if (!object(metadata) || metadata.BackupFolder !== manifest.backupId || metadata.Status !== "Success" || metadata.Failures !== 0 || !object(metadata.Items) || !object(metadata.ItemCounts)) throw new Error("Only complete backups with item metadata can be imported")
  const expected = new Set<string>(); const counts: Record<string, number> = {}
  for (const [identity, item] of Object.entries(metadata.Items)) {
    const [folder, id, ...rest] = identity.split("/")
    if (!folder || !id || rest.length || !KNOWN.has(folder.toLowerCase()) || !object(item) || typeof item.file !== "string" || !/^[^/\\]+\.json$/.test(item.file)) throw new Error("Unsupported backup item")
    const path = `${folder}/${item.file}`, snapshot = parse(path)
    if (expected.has(path) || !object(snapshot) || snapshot.id !== id || snapshotHash(snapshot) !== item.hash) throw new Error("Backup contents do not match the export inventory")
    expected.add(path); counts[folder] = (counts[folder] ?? 0) + 1
  }
  if (files.size !== expected.size + 2 || metadata.ItemCounts.TotalPolicies !== policyTotal(counts) || Object.entries(metadata.ItemCounts).some(([folder, count]) => folder !== "TotalPolicies" && count !== (counts[folder] ?? 0))) throw new Error("Backup archive is incomplete or contains extra files")
  return { tenantId: manifest.sourceTenantId.toLowerCase(), backupId: manifest.backupId, count: expected.size }
}
