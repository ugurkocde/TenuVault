/**
 * Backup folder names in the intune-backups container, shared by the backup list, drift detection
 * and the drift scan job so every listed backup can be compared and every comparable one is listed:
 * - backup-2026-09-25-120000: every current backup (UTC, to the second)
 * - 2026-09-25_12-00-00 or 2026-09-25_12-00-00_1727265600000: earlier runbook backups
 * - 2026-09-25: the oldest runbook backups, which record only the day
 */
export interface BackupName {
  name: string
  /** ISO time to the second, or only the date (YYYY-MM-DD) for day-only names. */
  timestamp: string
  precision: "second" | "day"
}

const CURRENT = /^backup-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})$/
const UNDERSCORE = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})(?:_\d+)?$/
const DAY = /^(\d{4}-\d{2}-\d{2})$/

export function parseBackupName(name: string): BackupName | null {
  const timed = CURRENT.exec(name) ?? UNDERSCORE.exec(name)
  if (timed) {
    const timestamp = `${timed[1]}T${timed[2]}:${timed[3]}:${timed[4]}.000Z`
    return Number.isFinite(Date.parse(timestamp)) ? { name, timestamp, precision: "second" } : null
  }
  const day = DAY.exec(name)
  return day && Number.isFinite(Date.parse(day[1]!)) ? { name, timestamp: day[1]!, precision: "day" } : null
}

export function isBackupName(name: unknown): name is string {
  return typeof name === "string" && parseBackupName(name) !== null
}

/** The backup folders of a container listing made with delimiter=/, each once. */
export function backupFoldersIn(xmlText: string): BackupName[] {
  const seen = new Set<string>()
  const folders: BackupName[] = []
  for (const match of xmlText.matchAll(/<Name>([^<]+)<\/Name>/g)) {
    const parsed = parseBackupName(match[1]!.replace(/\/$/, ""))
    if (parsed && !seen.has(parsed.name)) {
      seen.add(parsed.name)
      folders.push(parsed)
    }
  }
  return folders
}
