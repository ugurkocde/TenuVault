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
  /** When the write was verified; links are ordered by it, never by when they were stored. Missing counts as oldest. */
  verifiedAt?: string
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
function verifiedLinks(promotion: PromotionRecord & { id: string }, changeSet: ChangeSetRecord & { id: string }, linkedAt: string): Record<string, SyncLink> {
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

/** Only a write verified later replaces a link; on a tie the stored link stays, so a replay never changes it. */
function replaces(next: SyncLink, current: SyncLink | undefined): boolean {
  return !current || (next.verifiedAt ?? "") > (current.verifiedAt ?? "")
}

/**
 * Brings the links from a source into a target in line with the verified results of every Sync
 * target of that pair: a pure, idempotent replay of stored records, with no Graph call. Failed,
 * uncertain and pending operations make no link; the target hash is the one the verifying
 * read-back saw. It runs after every apply while the change-set engine still holds the tenant
 * write, and again before each plan and inside the apply's stale check, so a link whose write was
 * lost is repaired before anything acts on it. Returns the links written.
 */
export function recordSyncLinks(deps: FeatureDeps, targetTenantId: string, sourceTenantId: string): number {
  const target = targetTenantId.toLowerCase()
  const source = sourceTenantId.toLowerCase()
  const promotions = deps.records.list<PromotionRecord>(DOMAINS.promotions, target).filter((promotion) => promotion.sync && promotion.changeSetId && promotion.sourceTenantId.toLowerCase() === source)
  if (!promotions.length) return 0
  const changeSets = new Map(deps.records.list<ChangeSetRecord>(DOMAINS.changeSets, target).map((record) => [record.id, record]))
  const linkedAt = deps.now().toISOString()
  const verified: Record<string, SyncLink> = {}
  for (const promotion of promotions) {
    const changeSet = changeSets.get(promotion.changeSetId!)
    if (!changeSet || changeSet.kind !== "change") continue
    for (const [key, link] of Object.entries(verifiedLinks(promotion, changeSet, linkedAt))) if (replaces(link, verified[key])) verified[key] = link
  }
  const stored = linksRecord(deps, target, source)
  const changed = Object.entries(verified).filter(([key, link]) => replaces(link, stored?.links[key]))
  if (!changed.length) return 0
  const linked = (total: number) => `${total} linked polic${total === 1 ? "y" : "ies"}`
  const reason = `Linked ${changed.length} synced polic${changed.length === 1 ? "y" : "ies"}`
  if (!stored) {
    deps.records.create<SyncLinksRecord>(DOMAINS.syncLinks, target, { title: `Sync links from ${source}`, status: "active", summary: `${linked(changed.length)}.`, sourceTenantId: source, links: Object.fromEntries(changed) }, { actor: null, reason })
    return changed.length
  }
  deps.records.update<SyncLinksRecord>(DOMAINS.syncLinks, target, stored.id, (latest) => {
    const links = { ...latest.links }
    for (const [key, link] of changed) if (replaces(link, links[key])) links[key] = link
    return { ...latest, links, summary: `${linked(Object.keys(links).length)}.` }
  }, { actor: null, reason })
  return changed.length
}

/**
 * Reasons the links a Sync target's plan was built from changed: another Sync linked a policy
 * the plan creates, or relinked one it updates. A link to an object this change set's own
 * verified writes made is not a change. A plan without a complete link snapshot is stale too.
 * Any reason makes the change set stale, so nothing is written and the admin plans again.
 */
export function staleSyncLinks(deps: FeatureDeps, targetTenantId: string, promotionId: string): string[] {
  const target = targetTenantId.toLowerCase()
  const promotion = deps.records.get<PromotionRecord>(DOMAINS.promotions, target, promotionId)
  if (!promotion?.sync) return []
  const planned = promotion.sync.links ?? {}
  const current = syncLinks(deps, target, promotion.sourceTenantId)
  const changeSet = promotion.changeSetId ? deps.records.get<ChangeSetRecord>(DOMAINS.changeSets, target, promotion.changeSetId) : null
  const own = new Set(Object.values(changeSet?.results ?? {}).filter((result) => result.status === "verified" && result.objectId).map((result) => result.objectId!.toLowerCase()))
  const reasons: string[] = []
  for (const item of promotion.items.filter((entry) => !entry.blocked)) {
    const key = linkKey(item.folder, item.sourceId)
    if (!(key in planned)) {
      reasons.push(`The Sync links this plan relied on for "${item.sourceName}" were not recorded. Plan again.`)
      continue
    }
    const linked = current[key]?.targetPolicyId.toLowerCase() ?? null
    if (linked !== null && own.has(linked)) continue
    if (linked === (planned[key]?.toLowerCase() ?? null)) continue
    reasons.push(item.action === "create"
      ? `Another Sync wrote "${item.sourceName}" to this tenant after this plan, so applying it would create a second policy. Plan again.`
      : `Another Sync linked "${item.sourceName}" to a different policy in this tenant after this plan. Plan again.`)
  }
  return reasons
}
