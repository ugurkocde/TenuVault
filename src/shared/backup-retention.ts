export const RETENTION_TIER_LIMITS = {
  retentionMonths: 120,
  retentionYears: 50,
} as const

export type RetentionTierKey = keyof typeof RETENTION_TIER_LIMITS
export type RetentionTiers = Partial<Record<RetentionTierKey, number>>
export type RetentionPolicy = RetentionTiers & { tierDays?: number }
export type RetentionTier = "Monthly" | "Yearly" | "Monthly and yearly"

export function validRetentionTier(key: RetentionTierKey, value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= RETENTION_TIER_LIMITS[key]
}

export function savedRetentionPolicy({ retentionDays, retentionMonths, retentionYears }: RetentionTiers & { retentionDays: number }): RetentionPolicy {
  return { retentionMonths, retentionYears, tierDays: retentionDays || undefined }
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
  const [, year, month, day, hour, minute, second] = match
  const timestamp = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`
  const time = Date.parse(timestamp)
  return Number.isFinite(time) && new Date(time).toISOString() === timestamp ? time : null
}

export function completeForRetention(metadata: Record<string, unknown> | null): boolean {
  const status = String(metadata?.Status ?? "").toLowerCase()
  return metadata !== null && (status === "success" || status === "succeeded") && (metadata.Failures === undefined || metadata.Failures === 0)
}

export type RetentionQuality = "full" | "partial"

export function retentionQuality(metadata: Record<string, unknown> | null): RetentionQuality | null {
  if (!metadata || !completeForRetention(metadata)) return null
  const scope = metadata.Scope as { Excluded?: unknown } | undefined
  return [metadata.MaskedSecretItems, metadata.AppOnlyExcludedTypes, metadata.SkippedTypes, scope?.Excluded]
    .some((items) => Array.isArray(items) && items.length > 0) ? "partial" : "full"
}

interface RetentionBackup {
  id: string
  time: number
  quality: RetentionQuality | null
}

/** Pick the newest full backup in each local period, or the newest partial backup as a fallback.
 * Only periods whose keeper is beyond the daily window use a tier slot.
 */
export function selectRetentionTiers(
  backups: readonly RetentionBackup[],
  now: Date,
  days: number,
  { retentionMonths = 0, retentionYears = 0, tierDays = days }: RetentionPolicy,
): { newest: string | undefined; tiers: Map<string, RetentionTier> } {
  const tiers = new Map<string, RetentionTier>()
  if (days <= 0 || (!retentionMonths && !retentionYears)) return { newest: undefined, tiers }

  const sorted = [...backups].sort((a, b) => b.time - a.time)
  const cutoff = retentionCutoff(now, days)
  const tierCutoff = retentionCutoff(now, Math.max(days, tierDays))

  function keepers(limit: number, periodOf: (date: Date) => number): RetentionBackup[] {
    if (!limit) return []
    const periods = new Map<number, RetentionBackup>()
    for (const backup of sorted) {
      if (!backup.quality) continue
      const period = periodOf(new Date(backup.time))
      const keeper = periods.get(period)
      if (!keeper || (keeper.quality === "partial" && backup.quality === "full")) periods.set(period, backup)
    }
    const eligible = [...periods.values()].filter((keeper) => keeper.time < tierCutoff).slice(0, limit)
    // If the plan clamps the daily window, preserve the keepers waiting to age out of the saved
    // window. They can still enter the tiers later, and cannot displace the existing tier copies.
    const pending = [...periods.values()].filter((keeper) => keeper.time >= tierCutoff && keeper.time < cutoff)
    return [...eligible, ...pending]
  }

  for (const backup of keepers(retentionMonths, (date) => date.getFullYear() * 12 + date.getMonth())) tiers.set(backup.id, "Monthly")
  for (const backup of keepers(retentionYears, (date) => date.getFullYear())) tiers.set(backup.id, tiers.has(backup.id) ? "Monthly and yearly" : "Yearly")
  return { newest: sorted[0]?.id, tiers }
}
