import { isLargeBackup } from "./backup-storage"
import { isBackupName } from "./intune/backup-names"

export type RunManifest = Record<string, any>

/** Links are evidence only when both manifests identify the same run and tenant. */
export function matchingCompanions(id: string, metadata: RunManifest, otherId: unknown, other: RunManifest | null | undefined): boolean {
  return typeof otherId === "string" && isBackupName(id) && isBackupName(otherId) && isLargeBackup(id) !== isLargeBackup(otherId)
    && metadata.BackupFolder === id && other?.BackupFolder === otherId
    && metadata.CompanionBackup === otherId && other.CompanionBackup === id
    && typeof metadata.RunId === "string" && metadata.RunId.trim().length > 0 && metadata.RunId === other.RunId
    && typeof metadata.TenantId === "string" && metadata.TenantId.length > 0 && typeof other.TenantId === "string" && metadata.TenantId.toLowerCase() === other.TenantId.toLowerCase()
}

export function completeHalf(metadata: RunManifest | null | undefined): boolean {
  return !!metadata && ["success", "succeeded"].includes(String(metadata.Status).toLowerCase()) && metadata.Coverage === "Complete" && metadata.Failures === 0
    && Object.values(metadata.LargeItems ?? {}).every((index: any) => index.complete === true)
}

/** Outcomes recorded before a companion exists still explain each selected large type. */
export function largeRunProblems(metadata: RunManifest, cause?: string, companion?: RunManifest | null): Array<{ folder: string; reason: string }> {
  const recorded: any[] = Array.isArray(metadata.LargeBackupOutcomes) ? metadata.LargeBackupOutcomes : []
  const other: any[] = Array.isArray(companion?.Outcomes) ? companion.Outcomes : []
  const folders = new Set<string>([...recorded, ...other].flatMap(entry => typeof entry?.Folder === "string" ? [entry.Folder] : []))
  for (const folder of Object.keys(companion?.LargeItems ?? {})) folders.add(folder)
  if (!folders.size && cause) folders.add("Large types")
  return [...folders].flatMap(folder => {
    const entries = [...recorded, ...other].filter(entry => entry?.Folder === folder && ["failed", "skipped"].includes(entry.Outcome))
    const reasons = entries.map(entry => entry.Reason || entry.Error || "This type was not read in full.")
    if (cause) reasons.unshift(cause)
    return reasons.length ? [{ folder, reason: [...new Set(reasons)].join(" ") }] : []
  })
}

/** A portable ordinary subset must not retain a link that can no longer be verified. */
export function ordinaryOnlyManifest(metadata: RunManifest, reason: string): RunManifest {
  const { CompanionBackup: _companion, LargeBackupOutcomes: _outcomes, ...ordinary } = metadata
  return { ...ordinary, Export: { kind: "ordinary-only", reason, omittedLargeTypes: largeRunProblems(metadata, reason) } }
}

export const REMNANT_RECOVERY_DAYS = 7

/** A tenant label alone is not an app ownership claim. Conflicting records stay for manual review. */
export function ownedRemnant(id: string, tenantId: string, claim: RunManifest | null | undefined, metadata?: RunManifest | null): boolean {
  if (!claim || claim.Source !== "TenuVault Desktop" || typeof claim.TenantId !== "string" || claim.TenantId.toLowerCase() !== tenantId.toLowerCase()
    || typeof claim.RunId !== "string" || !claim.RunId.trim() || (claim.BackupFolder !== undefined && claim.BackupFolder !== id)) return false
  if (isLargeBackup(id) && claim.LargeInventory?.version !== 1) return false
  return !metadata || (metadata.BackupFolder === id && metadata.RunId === claim.RunId && typeof metadata.TenantId === "string" && metadata.TenantId.toLowerCase() === tenantId.toLowerCase()
    && (claim.CompanionBackup === undefined || claim.CompanionBackup === metadata.CompanionBackup))
}
