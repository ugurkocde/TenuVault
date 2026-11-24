import { PRIVILEGED_WRITES } from "../services/privileged-writes"
import { deferredPrivilegedRestore, privilegedRestoreEnabled } from "./directory-review-folders"
import { includesEntraFolder } from "./entra-scope"
import rows from "./restore-matrix.json"
import type { GraphVersion } from "./registry"

export type RestoreProtection = "identity-references" | "remaining-administrators"
export const ALL_RESTORE_PROTECTIONS: RestoreProtection[] = ["identity-references", "remaining-administrators"]
export const operationProtections = (folder: string, operation: "create" | "update"): readonly RestoreProtection[] => restoreMatrixRow(folder)?.[operation]?.protections ?? ALL_RESTORE_PROTECTIONS

export interface WriteContract {
  /** Missing declarations retain every protection. Empty means the closed payload cannot affect identities. */
  protections?: RestoreProtection[]
  protectionReason?: string
  method: "POST" | "PATCH" | "PUT"
  path: string
  version: GraphVersion
  properties: string[]
  permissions: string[]
  documentation: string
  index: string
  /** Explicit admission when the local index is absent but Microsoft documentation and a live lifecycle agree. */
  liveVerification?: { date: string; result: "round-trip-matched" }
  blockedReason?: string
  propertyAudit?: { date: string; sources: string[]; result: string; excluded?: Record<string, string>; constraints?: string }
  propertyEvidence?: string
  propertyCoverage?: string
  schemaDocumentation?: string[]
  permissionDocumentation?: string[]
}
export interface RestoreMatrixRow {
  folder: string
  directoryRestore?: { phase: string; blocker: string; actions: string[]; builder: string; evidence?: Record<string, { date: string; result: "round-trip-matched" }>; contracts?: Array<{ action: string; method: string; path: string; delegated: string[]; application: string[]; documentation: string; blocker: string }> }
  configurationRestore?: { capability?: "create" | "singleton"; phase: string; confirmation: string; blockedReason: string; builder: string; lab: string }
  disposition: "configuration" | "directory-deferred" | "never" | "unverified"
  resource: string
  readPath: string
  create: WriteContract | null
  update: WriteContract | null
  supplementalWrites: Array<{ method: string; path: string; properties: string[]; permissions: string[]; documentation: string; permissionDocumentation: string[]; index: string; indexPath?: string; blockedReason: string }>
  detection: { kind: string; property?: string; properties?: string[]; reason?: string }
  builtIn: string
  dependsOn: string[]
  reason: string
  verification: { date: string; method: string; resourceFound: boolean; resourceDocumentation: string; live: string; notes: string }
}
/** Research is deliberately separate from registry capability. A documented API never enables restore. */
const hasPrivilegedWrite = (permissions: readonly string[]) => permissions.some(scope => PRIVILEGED_WRITES.includes(scope))
export const RESTORE_MATRIX = (rows as RestoreMatrixRow[]).filter(row => !deferredPrivilegedRestore(row.folder) && (row.readPath.startsWith("deviceManagement/") || row.readPath.startsWith("deviceAppManagement/") || ["NamedLocations", "ConditionalAccessPolicies", "AuthenticationStrengths"].includes(row.folder) || includesEntraFolder(row.folder))).map(row => {
  if (privilegedRestoreEnabled) return row
  const contract = (write: WriteContract | null) => write && !hasPrivilegedWrite(write.permissions) ? write : null
  const directory = row.directoryRestore
  return {
    ...row,
    ...(directory?.contracts && { directoryRestore: {
      ...directory,
      contracts: directory.contracts.filter(write => !hasPrivilegedWrite([...write.delegated, ...write.application])),
    } }),
    create: contract(row.create),
    update: contract(row.update),
    supplementalWrites: row.supplementalWrites.filter(write => !hasPrivilegedWrite(write.permissions)),
  }
})
export const restoreMatrixRow = (folder: string): RestoreMatrixRow | undefined => RESTORE_MATRIX.find(row => row.folder === folder)

export const verifiedWriteContract = (write: WriteContract): boolean => write.index === "matched" || (write.index === "not-matched" && write.liveVerification?.result === "round-trip-matched" && !!write.documentation && !!write.permissionDocumentation?.length)

/** Only admitted directory operations contribute their delegated scopes to consent. */
export function admittedDirectoryPermissions(folder: string, action: string): string[] {
  const restore = restoreMatrixRow(folder)?.directoryRestore
  if (restore?.phase !== "enabled" || restore.evidence?.[action]?.result !== "round-trip-matched") return []
  return restore.contracts?.find(contract => contract.action === action)?.delegated ?? []
}
