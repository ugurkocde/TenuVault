import { COMMUNITY_RETENTION_DAYS, type Plan } from "../../shared/plans"

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

export function restoreCountNote(plan: Plan | null, count: number): string | null {
  return plan === "community" && count >= 2
    ? `Restore all ${count} at once with Pro. Community restores one item at a time as an unassigned copy.`
    : null
}

export function weeklyScheduleNote(plan: Plan | null): string | null {
  return plan === "community" ? "A weekly schedule can leave up to six days of changes unprotected." : null
}

export function firstBackupNote(plan: Plan | null, firstBackupNoteSeen: boolean | null): string | null {
  return plan === "community" && firstBackupNoteSeen === false
    ? "Backed up on this device. Pro can also store encrypted copies in your own Azure storage account and keep them longer."
    : null
}
