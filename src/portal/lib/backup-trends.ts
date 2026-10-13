/** The parts of a listed backup the trends are computed from (see /api/list-backups). */
export interface BackupTrendInput {
  timestamp: string
  counts?: Record<string, number>
  /** Stored bytes per registry folder, from the same listing as `counts`. */
  sizes?: Record<string, number>
  /** Seconds, a preformatted string from older backups, or null when unknown. */
  duration: number | string | null
}

export interface BackupTypePoint {
  timestamp: string
  count: number
  /** Stored bytes of this type in that backup; null when the listing did not say. */
  sizeBytes: number | null
  /** Duration of the whole backup that held this type; null when not recorded as seconds. */
  durationSeconds: number | null
}

export interface BackupTypeTrend {
  folder: string
  /** Backups holding this type, oldest first. */
  points: BackupTypePoint[]
  latestCount: number
  latestSizeBytes: number | null
  averageSizeBytes: number | null
  /** Newest known size minus oldest known size; null with fewer than two known sizes. */
  sizeChangeBytes: number | null
  latestDurationSeconds: number | null
  averageDurationSeconds: number | null
  /** Newest known duration minus oldest known duration; null with fewer than two known durations. */
  durationChangeSeconds: number | null
}

const known = (value: number | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)

function summarize(values: Array<number | null>): { latest: number | null; average: number | null; change: number | null } {
  const present = values.filter((value): value is number => value !== null)
  const latest = present[present.length - 1] ?? null
  const first = present[0] ?? null
  return {
    latest,
    average: present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null,
    change: present.length >= 2 && latest !== null && first !== null ? latest - first : null,
  }
}

/**
 * Duration and size trends per policy type, from the backup metadata and listings the backup
 * history screen already loaded. Backups record one duration per backup, so a type's duration
 * figures are the durations of the backups that held it, never a split of that duration.
 * Types a backup did not hold get no point for it, and unknown sizes or durations stay null.
 */
export function backupTypeTrends(backups: BackupTrendInput[]): BackupTypeTrend[] {
  const ordered = backups
    .filter((backup) => Number.isFinite(Date.parse(backup.timestamp)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  const folders = new Set<string>()
  for (const backup of ordered) {
    for (const folder of Object.keys(backup.counts ?? {})) folders.add(folder)
    for (const folder of Object.keys(backup.sizes ?? {})) folders.add(folder)
  }
  const trends: BackupTypeTrend[] = []
  for (const folder of folders) {
    const points: BackupTypePoint[] = []
    for (const backup of ordered) {
      const count = known(backup.counts?.[folder]) ?? 0
      const sizeBytes = known(backup.sizes?.[folder])
      if (count <= 0 && (sizeBytes ?? 0) <= 0) continue
      points.push({
        timestamp: backup.timestamp,
        count,
        sizeBytes,
        durationSeconds: typeof backup.duration === 'number' ? known(backup.duration) : null,
      })
    }
    if (!points.length) continue
    const sizes = summarize(points.map((point) => point.sizeBytes))
    const durations = summarize(points.map((point) => point.durationSeconds))
    trends.push({
      folder,
      points,
      latestCount: points[points.length - 1]!.count,
      latestSizeBytes: sizes.latest,
      averageSizeBytes: sizes.average,
      sizeChangeBytes: sizes.change,
      latestDurationSeconds: durations.latest,
      averageDurationSeconds: durations.average,
      durationChangeSeconds: durations.change,
    })
  }
  return trends.sort((a, b) => (b.latestSizeBytes ?? -1) - (a.latestSizeBytes ?? -1) || a.folder.localeCompare(b.folder))
}
