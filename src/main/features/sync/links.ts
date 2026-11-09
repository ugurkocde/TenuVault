import type { ListedRecord } from "../contracts"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import type { ChangeSetRecord } from "../change-sets/model"
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
  /** snapshotHash of the target the verifying read-back saw; null when none was kept. */
  targetHash: string | null
  /** When the write was verified; links are ordered by it, never by when they were stored. */
  verifiedAt: string
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

/** The links a target's verified operations make, from the change set alone; no Graph call. */
function verifiedLinks(promotion: Stored<PromotionRecord>, changeSet: ChangeSetRecord & { id: string }, linkedAt: string): Record<string, SyncLink> {
  const source = promotion.sourceTenantId.toLowerCase()
  const found: Record<string, SyncLink> = {}
  for (const operation of changeSet.operations) {
    const result = changeSet.results[operation.key]
    const origin = operation.source
    if (result?.status !== "verified" || !result.objectId || !result.at || !origin?.objectId || origin.tenantId?.toLowerCase() !== source) continue
    const item = promotion.items.find((entry) => entry.folder === operation.folder && entry.sourceId.toLowerCase() === origin.objectId!.toLowerCase())
    if (!item) continue
    found[linkKey(operation.folder, origin.objectId)] = { targetPolicyId: result.objectId, sourceName: item.sourceName, targetName: operation.name, sourceHash: item.sourceHash, targetHash: result.readBackHash ?? null, verifiedAt: result.at, linkedAt, promotionId: promotion.id, changeSetId: changeSet.id }
  }
  return found
}

/** Whether a link replaces the current one: a retry keeps its first link, and only a later verified write wins. */
function replaces(next: SyncLink, current: SyncLink | undefined): boolean {
  if (!current) return true
  if (current.changeSetId === next.changeSetId) return current.targetPolicyId.toLowerCase() !== next.targetPolicyId.toLowerCase()
  return next.verifiedAt >= current.verifiedAt
}

/**
 * Records a link for every operation of the Sync target's change set whose write was verified,
 * after an apply or a retry. Failed, uncertain and pending operations write none. The target
 * hash is the one the verifying read-back saw, and links are ordered by verification time.
 * Synchronous: the change-set engine calls it while it still holds the tenant write, and the
 * comparison with the stored links runs inside the record update. Returns the links written.
 */
export function recordSyncLinks(deps: FeatureDeps, targetTenantId: string, promotionId: string, changeSet?: Stored<ChangeSetRecord>): number {
  const target = targetTenantId.toLowerCase()
  const promotion = deps.records.get<PromotionRecord>(DOMAINS.promotions, target, promotionId)
  if (!promotion?.sync || !promotion.changeSetId) return 0
  const record = changeSet?.id === promotion.changeSetId ? changeSet : deps.records.get<ChangeSetRecord>(DOMAINS.changeSets, target, promotion.changeSetId)
  if (!record || record.kind !== "change") return 0
  const source = promotion.sourceTenantId.toLowerCase()
  const found = verifiedLinks(promotion, record, deps.now().toISOString())
  if (!Object.keys(found).length) return 0
  const linked = (total: number) => `${total} linked polic${total === 1 ? "y" : "ies"}`
  const stored = linksRecord(deps, target, source)
  if (!stored) {
    deps.records.create<SyncLinksRecord>(DOMAINS.syncLinks, target, { title: `Sync links from ${source}`, status: "active", summary: `${linked(Object.keys(found).length)}.`, sourceTenantId: source, links: found }, { actor: null, reason: `Linked ${Object.keys(found).length} synced polic${Object.keys(found).length === 1 ? "y" : "ies"}` })
    return Object.keys(found).length
  }
  let count = 0
  deps.records.update<SyncLinksRecord>(DOMAINS.syncLinks, target, stored.id, (latest) => {
    const links = { ...latest.links }
    for (const [key, link] of Object.entries(found)) {
      if (!replaces(link, links[key])) continue
      links[key] = link
      count += 1
    }
    return { ...latest, links, summary: `${linked(Object.keys(links).length)}.` }
  }, { actor: null, reason: "Linked synced policies" })
  return count
}

/**
 * Reasons the links a Sync target's plan was built from changed: another Sync linked a policy
 * the plan creates, or relinked one it updates. Links its own verified writes made are not a
 * change. Any reason makes the change set stale, so nothing is written and the admin plans again.
 */
export function staleSyncLinks(deps: FeatureDeps, targetTenantId: string, promotionId: string): string[] {
  const promotion = deps.records.get<PromotionRecord>(DOMAINS.promotions, targetTenantId.toLowerCase(), promotionId)
  const planned = promotion?.sync?.links
  if (!promotion || !planned) return []
  const current = syncLinks(deps, targetTenantId, promotion.sourceTenantId)
  const reasons: string[] = []
  for (const item of promotion.items.filter((entry) => !entry.blocked)) {
    const key = linkKey(item.folder, item.sourceId)
    if (!(key in planned)) continue
    const link = current[key]
    if (link && link.promotionId === promotion.id) continue
    if ((link?.targetPolicyId.toLowerCase() ?? null) === (planned[key]?.toLowerCase() ?? null)) continue
    reasons.push(item.action === "create"
      ? `Another Sync wrote "${item.sourceName}" to this tenant after this plan, so applying it would create a second policy. Plan again.`
      : `Another Sync linked "${item.sourceName}" to a different policy in this tenant after this plan. Plan again.`)
  }
  return reasons
}
