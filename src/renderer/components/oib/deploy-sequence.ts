import { oibScope, type OibScope } from "../../../shared/oib/assignments"
import type { DeployItem, OibBackupChoice, OibCatalog, OibPlatform, OibRun } from "../../../shared/oib/types"

/** A policy to deploy, with the names and registry folder the review shows. */
export interface DeployEntry extends DeployItem {
  name?: string
  /** Registry folder the policy is written to; used to scope and check the backup. */
  folder?: string
  /** The tenant policy an update replaces, by name. */
  targetName?: string
  /** Device or user targeted, as OIB marks the policy; undefined when it is not marked. */
  scope?: OibScope
}

/** The policies of one platform pack to deploy. */
export interface DeployBatch {
  platform: OibPlatform
  commit: string
  /** The published release tag the pack was loaded as; absent for main. */
  tag?: string
  reference: string
  items: DeployEntry[]
}

/** How a run is backed up: a new backup of the folders it writes, a recent complete backup, or none. */
export type BackupRequest = OibBackupChoice

export interface BatchOutcome {
  platform: OibPlatform
  run?: OibRun | null
  error?: string
  /** The backup asked for with this batch; absent when the batch was not sent. */
  backup?: BackupRequest
}

/** A batch from a loaded pack, with policy names and folders filled in from the catalog. */
export function batchFor(catalog: OibCatalog, items: Array<DeployItem & { targetName?: string }>): DeployBatch {
  const policies = new Map(catalog.policies.map(p => [p.source, p]))
  return {
    platform: catalog.platform, commit: catalog.commit, tag: catalog.tag, reference: catalog.reference,
    items: items.map(item => {
      const policy = policies.get(item.source)
      return { ...item, name: policy?.name, folder: policy?.folder, ...(policy && oibScope(policy) ? { scope: oibScope(policy) } : {}) }
    }),
  }
}

/** The registry folders the batches write, sorted; empty when a folder is unknown. */
export function batchFolders(batches: DeployBatch[]): string[] {
  const items = batches.flatMap(b => b.items)
  if (items.some(item => !item.folder)) return []
  return [...new Set(items.map(item => item.folder!))].sort()
}

/** The item as the main process takes it. */
export const deployItem = ({ source, mode, targetId }: DeployEntry): DeployItem => mode === "update" ? { source, mode, targetId } : { source, mode }

/**
 * Deploys the batches (one per platform) to one tenant, in order. With "reuse" every batch uses
 * the chosen backup. With "new" the first batch backs up the folders it writes; a later batch reuses
 * a backup made by an earlier batch when that covered all of its folders, else backs up its own.
 * With "none" nothing is backed up.
 * When a backup is missing, fails or is not confirmed by the run, the remaining batches of this
 * tenant are skipped: nothing deploys without the backup that was asked for.
 */
export async function deployToTenant(
  batches: DeployBatch[],
  options: { backup: BackupRequest; storage: boolean },
  send: (batch: DeployBatch, backup: BackupRequest) => Promise<OibRun>,
): Promise<BatchOutcome[]> {
  const outcomes: BatchOutcome[] = []
  const made: Array<{ folder: string; covers: Set<string> }> = []
  let stopped: string | null = null
  for (const batch of batches) {
    if (stopped) {
      outcomes.push({ platform: batch.platform, error: stopped })
      continue
    }
    if (options.backup.mode !== "none" && !options.storage) {
      stopped = "Skipped: no backup storage is chosen for this tenant in Settings."
      outcomes.push({ platform: batch.platform, error: stopped })
      continue
    }
    const folders = batchFolders([batch])
    const covering = folders.length ? made.find(m => folders.every(f => m.covers.has(f))) : undefined
    const backup: BackupRequest = options.backup.mode === "new" && covering ? { mode: "reuse", folder: covering.folder } : options.backup
    try {
      const run = await send(batch, backup)
      outcomes.push({ platform: batch.platform, run, backup })
      if (backup.mode === "new") {
        if (run.backupFolder) made.push({ folder: run.backupFolder, covers: new Set(folders) })
        else stopped = "Skipped: the backup before the first deployment was not confirmed."
      }
    } catch (error) {
      outcomes.push({ platform: batch.platform, error: error instanceof Error ? error.message : "The request failed.", backup })
      if (backup.mode !== "none") stopped = "Skipped: the backup of this tenant could not be used, so nothing else was deployed."
    }
  }
  return outcomes
}
