import type { GraphCall } from "../../../portal/lib/policies/graph-restore"
import { comparableSnapshot } from "../../../shared/intune/compare"
import { typeForFolder } from "../../../shared/intune/registry"
import type { ListedRecord } from "../contracts"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import { readCurrent } from "../change-sets/graph"
import { hashOf, sanitizeSnapshot, type ChangeSetRecord } from "../change-sets/model"
import type { PromotionRecord } from "../promotion/engine"

/**
 * Sync links: which target object a source policy was synced to. Stored under the target
 * tenant, one record per source tenant, keyed `${folder}:${sourceId}`. Only an operation whose
 * write was verified by read-back writes a link; the next plan of the pair updates the linked
 * object instead of creating another one.
 */

export interface SyncLink {
  targetPolicyId: string
  sourceName: string
  targetName: string
  /** sha256 of the sanitized source configuration that was written. */
  sourceHash: string
  /** sha256 of the sanitized target read back after the write; null when that read failed. */
  targetHash: string | null
  linkedAt: string
  promotionId: string
  changeSetId: string
}

export interface SyncLinksRecord extends ListedRecord {
  sourceTenantId: string
  links: Record<string, SyncLink>
}

export function linkKey(folder: string, sourceId: string): string {
  return `${folder}:${sourceId.toLowerCase()}`
}

/** The folder and source policy ID of a link key. */
export function parseLinkKey(key: string): { folder: string; sourceId: string } {
  const at = key.indexOf(":")
  return { folder: key.slice(0, at), sourceId: key.slice(at + 1) }
}

function linksRecord(deps: FeatureDeps, targetTenantId: string, sourceTenantId: string): Stored<SyncLinksRecord> | null {
  const source = sourceTenantId.toLowerCase()
  return deps.records.list<SyncLinksRecord>(DOMAINS.syncLinks, targetTenantId.toLowerCase()).find((record) => record.sourceTenantId === source) ?? null
}

/** The links from a source tenant into a target tenant. */
export function syncLinks(deps: FeatureDeps, targetTenantId: string, sourceTenantId: string): Record<string, SyncLink> {
  return linksRecord(deps, targetTenantId, sourceTenantId)?.links ?? {}
}

/**
 * Records a link for every operation of the Sync target's change set whose write was verified,
 * after an apply or a retry. Failed, uncertain and pending operations write none. The target
 * is read back once more for the hash that status compares against. Returns the links written.
 */
export async function recordSyncLinks(deps: FeatureDeps, targetTenantId: string, promotionId: string): Promise<number> {
  const target = targetTenantId.toLowerCase()
  const promotion = deps.records.get<PromotionRecord>(DOMAINS.promotions, target, promotionId)
  if (!promotion?.sync || !promotion.changeSetId) return 0
  const changeSet = deps.records.get<ChangeSetRecord>(DOMAINS.changeSets, target, promotion.changeSetId)
  if (!changeSet || changeSet.kind !== "change") return 0
  const source = promotion.sourceTenantId.toLowerCase()
  const existing = syncLinks(deps, target, source)
  const found: Record<string, SyncLink> = {}
  let graph: GraphCall | null = null
  for (const operation of changeSet.operations) {
    const result = changeSet.results[operation.key]
    const origin = operation.source
    if (result?.status !== "verified" || !result.objectId || !origin?.objectId || origin.tenantId?.toLowerCase() !== source) continue
    const key = linkKey(operation.folder, origin.objectId)
    const current = existing[key]
    // A retry keeps the link its first verified write recorded, and an older verified write
    // never replaces the link a later Sync recorded.
    if (current && current.changeSetId === changeSet.id && current.targetPolicyId.toLowerCase() === result.objectId.toLowerCase()) continue
    if (current && current.changeSetId !== changeSet.id && result.at && result.at < current.linkedAt) continue
    const item = promotion.items.find((entry) => entry.folder === operation.folder && entry.sourceId.toLowerCase() === origin.objectId!.toLowerCase())
    const type = typeForFolder(operation.folder)
    if (!item || !type) continue
    let targetHash: string | null = null
    try {
      graph ??= await deps.graph(target)
      const live = await readCurrent(graph, type, result.objectId)
      targetHash = live ? hashOf(comparableSnapshot(sanitizeSnapshot(type, live).snapshot)) : null
    } catch {
      targetHash = null
    }
    found[key] = { targetPolicyId: result.objectId, sourceName: item.sourceName, targetName: operation.name, sourceHash: item.sourceHash, targetHash, linkedAt: deps.now().toISOString(), promotionId: promotion.id, changeSetId: changeSet.id }
  }
  const count = Object.keys(found).length
  if (!count) return 0
  const linked = (total: number) => `${total} linked polic${total === 1 ? "y" : "ies"}`
  const record = linksRecord(deps, target, source)
  const reason = `Linked ${count} synced polic${count === 1 ? "y" : "ies"}`
  if (record) deps.records.update<SyncLinksRecord>(DOMAINS.syncLinks, target, record.id, (latest) => ({ ...latest, links: { ...latest.links, ...found }, summary: `${linked(Object.keys({ ...latest.links, ...found }).length)}.` }), { actor: null, reason })
  else deps.records.create<SyncLinksRecord>(DOMAINS.syncLinks, target, { title: `Sync links from ${source}`, status: "active", summary: `${linked(count)}.`, sourceTenantId: source, links: found }, { actor: null, reason })
  return count
}
