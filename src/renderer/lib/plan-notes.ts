import { COMMUNITY_RETENTION_DAYS, type Plan } from "../../shared/plans"
import { driftActionBlockers, type Drift } from "../../shared/intune/drift"

/** Changed or deleted policies a Revert or Recreate click can actually run on; an item Intune cannot recreate, such as a deleted app that needs its installer, is not promised to any plan. */
export function revertibleDriftCount(drifts: readonly Pick<Drift, "changeType" | "lastRevertedAt" | "isRevertDrift" | "createBlocker" | "replaceBlocker">[]): number {
  return drifts.filter((drift) => !drift.lastRevertedAt && !drift.isRevertDrift && (drift.changeType === "modified" || drift.changeType === "deleted") && !driftActionBlockers(drift).revert).length
}

export function shouldShowDriftNote(plan: Plan | null, count: number): boolean {
  return plan === "community" && count > 0
}

export function retentionNote(plan: Plan | null, backups: readonly { timestamp: string }[], now: Date): string | null {
  if (plan !== "community") return null
  const dates = backups.map((backup) => new Date(backup.timestamp).getTime()).filter(Number.isFinite)
  if (!dates.length || !Number.isFinite(now.getTime())) return null
  const oldest = Math.min(...dates)
  const ageDays = (now.getTime() - oldest) / (24 * 60 * 60 * 1000)
  if (ageDays < COMMUNITY_RETENTION_DAYS - 7) return null
  const date = new Date(oldest).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
  return `Backups older than 30 days are removed on Community after the next complete backup. The oldest here is from ${date}. Pro keeps 7 to 365 days, or forever.`
}

export function weeklyScheduleNote(plan: Plan | null, weeklyEnabled: boolean): string | null {
  return plan === "community" && weeklyEnabled ? "A weekly schedule can leave up to six days of changes unprotected. Daily backups are included in Pro." : null
}

export function firstBackupNote(plan: Plan | null, firstBackupNoteSeen: boolean | null): string | null {
  return plan === "community" && firstBackupNoteSeen === false
    ? "Backed up on this device. Pro can also store encrypted copies in your own Azure storage account and keep them longer."
    : null
}
