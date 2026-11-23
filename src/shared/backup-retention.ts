import { allows, type Plan } from "./plans"

export const RETENTION_TIER_LIMITS = {
  retentionMonths: 120,
  retentionYears: 50,
} as const

export type RetentionTierKey = keyof typeof RETENTION_TIER_LIMITS
export type RetentionTiers = Partial<Record<RetentionTierKey, number>>
export type RetentionTier = "Monthly" | "Yearly" | "Monthly and yearly"

export function validRetentionTier(key: RetentionTierKey, value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= RETENTION_TIER_LIMITS[key]
}

export function effectiveRetentionTiers({ retentionMonths = 0, retentionYears = 0 }: RetentionTiers, plan: Plan | null): RetentionTiers {
  return plan !== null && allows(plan, "customRetention") ? { retentionMonths, retentionYears } : {}
}

export function retentionTierSummary(days: number, { retentionMonths = 0, retentionYears = 0 }: RetentionTiers): string | null {
  if (days <= 0 || (!retentionMonths && !retentionYears)) return null
  const periods = [
    retentionMonths && `one a month for ${retentionMonths} ${retentionMonths === 1 ? "month" : "months"}`,
    retentionYears && `one a year for ${retentionYears} ${retentionYears === 1 ? "year" : "years"}`,
  ].filter(Boolean)
  return `All backups for ${days} ${days === 1 ? "day" : "days"}, then ${periods.join(" and ")}`
}

export const retentionCutoff = (now: Date, days: number): number => now.getTime() - days * 24 * 60 * 60 * 1000

/** Only the timestamped folders that desktop retention can remove are eligible for tiers. */
export function retentionBackupTime(folder: string): number | null {
  const match = /^backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(folder)
  if (!match) return null
  const [, y, mo, d, h, mi, se] = match.map(Number)
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, se!)
}

export function completeForRetention(metadata: Record<string, unknown> | null): boolean {
  const status = String(metadata?.Status ?? "").toLowerCase()
  return metadata !== null && (status === "success" || status === "succeeded") && (metadata.Failures === undefined || metadata.Failures === 0)
}

interface RetentionBackup {
  id: string
  time: number
  complete: boolean
}

/** The newest successful backup wins each local calendar period, even while it is still in the
 * daily window. A period with no successful backup has no keeper.
 */
export function selectRetentionTiers(
  backups: readonly RetentionBackup[],
  now: Date,
  days: number,
  { retentionMonths = 0, retentionYears = 0 }: RetentionTiers,
): { newest: string | undefined; tiers: Map<string, RetentionTier> } {
  const tiers = new Map<string, RetentionTier>()
  if (days <= 0 || (!retentionMonths && !retentionYears)) return { newest: undefined, tiers }

  const sorted = [...backups].sort((a, b) => b.time - a.time)
  const cutoff = retentionCutoff(now, days)
  const currentYear = now.getFullYear()
  const currentMonth = currentYear * 12 + now.getMonth()
  const months = new Set<number>()
  const years = new Set<number>()
  for (const backup of sorted) {
    if (!backup.complete) continue
    const date = new Date(backup.time)
    const year = date.getFullYear()
    const month = year * 12 + date.getMonth()
    const monthly = currentMonth - month >= 0 && currentMonth - month < retentionMonths && !months.has(month)
    const yearly = currentYear - year >= 0 && currentYear - year < retentionYears && !years.has(year)
    if (monthly) months.add(month)
    if (yearly) years.add(year)
    if (backup.time < cutoff && (monthly || yearly)) {
      tiers.set(backup.id, monthly && yearly ? "Monthly and yearly" : monthly ? "Monthly" : "Yearly")
    }
  }
  return { newest: sorted[0]?.id, tiers }
}
