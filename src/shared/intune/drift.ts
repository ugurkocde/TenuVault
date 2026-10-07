/**
 * Drift detection: the result of comparing two backups of one tenant, shared by the
 * /api/detect-drifts route, the background scan in the main process and the drift page.
 */

export interface DriftChange {
  /** Path of the changed property, such as settings[<definition ID>].settingInstance.choiceSettingValue.value. */
  field: string
  oldValue: any
  newValue: any
  /** The setting's own name, when the backup records one (OMA-URI settings). */
  displayName?: string
}

export interface Drift {
  id: string
  tenant: string
  tenantId: string
  severity: "critical" | "warning" | "info"
  type: string
  configName: string
  /** The item's name in the baseline, when it was renamed. */
  previousName?: string
  configId: string
  changeType: "added" | "modified" | "deleted"
  detectedAt: string
  /** Backup folder of the baseline, such as backup-2026-10-01-020000. */
  fromBackup: string
  /** Backup folder of the comparison. */
  toBackup: string
  fromBackupTimestamp?: string
  toBackupTimestamp?: string
  description: string
  impact: string
  affectedPolicies: number
  affectedDevices: number
  comparisonIndex?: number
  revertHistory?: Array<{ timestamp: string; action: "revert" | "restore" }>
  lastRevertedAt?: string
  /** True when this drift is the result of a revert made between the two backups. */
  isRevertDrift?: boolean
  revertTimestamp?: string
  /**
   * The item's path inside a backup folder, such as DeviceConfigurations/Name.json: in the baseline
   * for modified and deleted items (what a revert restores), in the comparison for added items.
   */
  backupFile?: string
  changes?: DriftChange[]
}

export interface DriftSummary {
  total: number
  critical: number
  warning: number
  info: number
  added: number
  modified: number
  deleted: number
  affectedTenants: number
}

/** One of the two compared backups. */
export interface DriftBackupRef {
  id: string
  timestamp: string
  /** How the backup started; null for backups made before this was recorded. */
  trigger: string | null
  status: string
}

/** A policy file that could not be read; it is left out of the comparison. */
export interface DriftWarning {
  file: string
  backup: string
  message: string
}

/** What /api/detect-drifts answers, and what the background scan saves per tenant. */
export interface DriftResult {
  drifts: Drift[]
  summary: DriftSummary
  /** When the comparison ran. */
  lastScan: string
  backupsAnalyzed: number
  baseline: DriftBackupRef
  comparison: DriftBackupRef
  warnings: DriftWarning[]
  /** Items read and compared, and items skipped because their stored fingerprints match. */
  stats: { compared: number; unchanged: number }
}

export type DriftScanPhase = "checking" | "listing" | "comparing" | "history"

export interface DriftScanProgress {
  phase: DriftScanPhase
  detail: string
  /**
   * Steps done so far and in total: steps taken while checking (total 0, not known in advance),
   * backups listed while listing, items compared while comparing.
   */
  done: number
  total: number
}

export function summarizeDrifts(drifts: Drift[]): DriftSummary {
  const count = (test: (drift: Drift) => boolean) => drifts.filter(test).length
  return {
    total: drifts.length,
    critical: count((d) => d.severity === "critical"),
    warning: count((d) => d.severity === "warning"),
    info: count((d) => d.severity === "info"),
    added: count((d) => d.changeType === "added"),
    modified: count((d) => d.changeType === "modified"),
    deleted: count((d) => d.changeType === "deleted"),
    affectedTenants: 1,
  }
}

export type BackupCompleteness = "complete" | "warnings" | "incomplete"

/**
 * Success and Completed backups hold every item of the types they cover. CompletedWithWarnings
 * backups lost some items, which would show up as deleted; they can be picked explicitly (and
 * are marked), but are never chosen by default.
 */
export function backupCompleteness(status: unknown): BackupCompleteness {
  const value = String(status ?? "").toLowerCase()
  if (value === "success" || value === "completed") return "complete"
  if (value === "completedwithwarnings") return "warnings"
  return "incomplete"
}

export interface BackupMetadata {
  Status?: unknown
  status?: unknown
  TenantId?: unknown
  Trigger?: unknown
  [key: string]: unknown
}

export interface BackupFolder {
  name: string
  timestamp: string
}

export interface SelectedBackup extends BackupFolder {
  metadata: BackupMetadata
}

/** A pair that cannot be compared, with the status the route answers with. */
export class DriftPairError extends Error {
  constructor(
    message: string,
    readonly code: "INSUFFICIENT_BACKUPS" | "INVALID_PAIR" | "BACKUP_NOT_FOUND" | "BACKUP_INCOMPLETE" | "BACKUP_OTHER_TENANT",
    readonly status: number,
  ) {
    super(message)
    this.name = "DriftPairError"
  }
}

const statusOf = (metadata: BackupMetadata) => metadata.Status ?? metadata.status

/** Backups recorded as another tenant's are never compared; older ones that record no tenant are. */
export function belongsTo(metadata: BackupMetadata, tenantId: string): boolean {
  return typeof metadata.TenantId !== "string" || metadata.TenantId.toLowerCase() === tenantId.toLowerCase()
}

export function backupRef(backup: SelectedBackup): DriftBackupRef {
  const trigger = backup.metadata.Trigger ?? backup.metadata.trigger
  return { id: backup.name, timestamp: backup.timestamp, trigger: typeof trigger === "string" ? trigger : null, status: String(statusOf(backup.metadata) ?? "unknown") }
}

/**
 * The baseline (older) and comparison (newer) backup. Without an explicit pair, the two newest
 * complete backups of the tenant (among the newest `limit` when given, otherwise among all of
 * them, as the drift page picks them); metadata is read newest first and only until two are found. An explicit pair must name two different existing backups of this
 * tenant that finished, the baseline older than the comparison.
 *
 * `folders` must be sorted newest first. `load` returns a backup's metadata.json, or null when it
 * has none (still running, or stopped).
 */
export async function selectBackupPair(options: {
  folders: BackupFolder[]
  tenantId: string
  baseline?: unknown
  comparison?: unknown
  limit?: number
  load: (name: string) => Promise<BackupMetadata | null>
  signal?: AbortSignal
}): Promise<{ baseline: SelectedBackup; comparison: SelectedBackup }> {
  const { folders, tenantId, load, signal } = options
  const explicit = options.baseline !== undefined && options.baseline !== null && options.baseline !== ""
  const explicitComparison = options.comparison !== undefined && options.comparison !== null && options.comparison !== ""

  if (!explicit && !explicitComparison) {
    const candidates = options.limit === undefined ? folders : folders.slice(0, options.limit)
    const complete: SelectedBackup[] = []
    // With fewer than two backups there is nothing to compare, so no metadata is read.
    for (const folder of candidates.length < 2 ? [] : candidates) {
      signal?.throwIfAborted()
      const metadata = await load(folder.name)
      if (metadata && backupCompleteness(statusOf(metadata)) === "complete" && belongsTo(metadata, tenantId)) complete.push({ ...folder, metadata })
      if (complete.length === 2) break
    }
    if (complete.length < 2) {
      throw new DriftPairError(
        `Drift comparison needs two complete backups, and the latest ${candidates.length} include fewer than two. Incomplete backups are skipped. Create a successful backup and try again.`,
        "INSUFFICIENT_BACKUPS",
        409,
      )
    }
    return { comparison: complete[0]!, baseline: complete[1]! }
  }

  if (typeof options.baseline !== "string" || typeof options.comparison !== "string") {
    throw new DriftPairError("Choose both a baseline and a comparison backup.", "INVALID_PAIR", 400)
  }
  if (options.baseline === options.comparison) throw new DriftPairError("Choose two different backups to compare.", "INVALID_PAIR", 400)

  const find = (name: string) => {
    const folder = folders.find((entry) => entry.name === name)
    if (!folder) throw new DriftPairError(`Backup ${name} was not found. It may have been removed by retention.`, "BACKUP_NOT_FOUND", 404)
    return folder
  }
  const baselineFolder = find(options.baseline)
  const comparisonFolder = find(options.comparison)

  const read = async (folder: BackupFolder): Promise<SelectedBackup> => {
    signal?.throwIfAborted()
    const metadata = await load(folder.name)
    if (!metadata || backupCompleteness(statusOf(metadata)) === "incomplete") {
      throw new DriftPairError(`Backup ${folder.name} did not complete, so it cannot be compared. Choose a complete backup.`, "BACKUP_INCOMPLETE", 409)
    }
    if (!belongsTo(metadata, tenantId)) throw new DriftPairError(`Backup ${folder.name} belongs to another tenant.`, "BACKUP_OTHER_TENANT", 403)
    return { ...folder, metadata }
  }
  const baseline = await read(baselineFolder)
  const comparison = await read(comparisonFolder)
  if (Date.parse(baseline.timestamp) >= Date.parse(comparison.timestamp)) {
    throw new DriftPairError("The baseline must be older than the comparison backup. Swap them and try again.", "INVALID_PAIR", 400)
  }
  return { baseline, comparison }
}
