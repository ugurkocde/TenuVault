import type { ListedRecord } from "../contracts"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { StoredRecord } from "../records"
import { canonicalJson, hashOf, type ChangeSetRecord } from "../change-sets/model"
import type { Mapping } from "../promotion/mapping"
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
  /**
   * optionsFingerprint of the plan whose write was verified. A plan skips a policy as in sync
   * only with the same options; a link without it never skips.
   */
  optionsHash?: string
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

function linksRecord(deps: FeatureDeps, targetTenantId: string, sourceTenantId: string): (SyncLinksRecord & StoredRecord) | null {
  const source = sourceTenantId.toLowerCase()
  return deps.records.current<SyncLinksRecord>(DOMAINS.syncLinks, targetTenantId.toLowerCase(), (record) => record.sourceTenantId === source)[0] ?? null
}

/** The links from a source tenant into a target tenant. */
export function syncLinks(deps: FeatureDeps, targetTenantId: string, sourceTenantId: string): Record<string, SyncLink> {
  return linksRecord(deps, targetTenantId, sourceTenantId)?.links ?? {}
}

/**
 * What shapes the policy a Sync writes to one target besides its source: whether assignments are
 * included, whether unsupported exclusions are dropped, and the target's confirmed mappings,
 * normalized and sorted so the same choices always give the same fingerprint.
 */
export function optionsFingerprint(options: { includeAssignments: boolean; dropUnsupportedExclusions: boolean }, mappings: Mapping[]): string {
  const normalized = mappings.map((mapping) => ({ kind: mapping.kind, sourceId: mapping.sourceId.toLowerCase(), targetId: mapping.targetId.toLowerCase(), confirmed: mapping.confirmed }))
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
  return hashOf({ includeAssignments: options.includeAssignments, dropUnsupportedExclusions: options.dropUnsupportedExclusions, mappings: normalized })
}

/** The links a target's verified operations make, from the change set alone; no Graph call. */
function verifiedLinks(promotion: PromotionRecord & StoredRecord, changeSet: ChangeSetRecord & StoredRecord, linkedAt: string): Record<string, SyncLink> {
  const source = promotion.sourceTenantId.toLowerCase()
  const found: Record<string, SyncLink> = {}
  for (const operation of changeSet.operations) {
    const result = changeSet.results[operation.key]
    const origin = operation.source
    if (result?.status !== "verified" || !result.objectId || !result.at || !origin?.objectId || origin.tenantId?.toLowerCase() !== source) continue
    const item = promotion.items.find((entry) => entry.folder === operation.folder && entry.sourceId.toLowerCase() === origin.objectId!.toLowerCase())
    if (!item) continue
    found[linkKey(operation.folder, origin.objectId)] = { targetPolicyId: result.objectId, sourceName: item.sourceName, targetName: operation.name, sourceHash: item.sourceHash, targetHash: result.readBackHash ?? null, verifiedAt: result.at, linkedAt, promotionId: promotion.id, changeSetId: changeSet.id, ...(promotion.sync?.optionsHash ? { optionsHash: promotion.sync.optionsHash } : {}) }
  }
  return found
}

/** Only a write verified later replaces a link; on a tie the stored link stays, so a replay never changes it. */
function replaces(next: SyncLink, current: SyncLink | undefined): boolean {
  return !current || (next.verifiedAt ?? "") > (current.verifiedAt ?? "")
}

/** What a replay found: the links it wrote, and per link key the Sync targets whose create of it has an unconfirmed result. */
export interface SyncReplay {
  written: number
  unresolved: Record<string, { name: string; promotionIds: string[] }>
}

/**
 * Brings the links from a source into a target in line with the verified results of every Sync
 * target of that pair: a pure, idempotent replay of stored records, with no Graph call. Failed,
 * uncertain and pending operations make no link; the target hash is the one the verifying
 * read-back saw. It runs after every apply while the change-set engine still holds the tenant
 * write, and again before each plan and inside the apply's stale check, so a link whose write was
 * lost is repaired before anything acts on it. The same scan finds creates whose outcome is
 * unconfirmed (uncertain or writing), which may have created the policy without a link; a plan
 * warns about them, and an applied rollback of the run settles them. A link to an object a
 * verified rollback deleted is removed, so the policy reads as not synced again. It also runs
 * when a Sync rollback settles.
 * Reads current values only, and only the change sets the pair's Sync targets name.
 */
export function recordSyncLinks(deps: FeatureDeps, targetTenantId: string, sourceTenantId: string): SyncReplay {
  const target = targetTenantId.toLowerCase()
  const source = sourceTenantId.toLowerCase()
  const promotions = deps.records.current<PromotionRecord>(DOMAINS.promotions, target, (promotion) => !!promotion.sync && !!promotion.changeSetId && promotion.sourceTenantId.toLowerCase() === source)
  const unresolved: SyncReplay["unresolved"] = {}
  if (!promotions.length) return { written: 0, unresolved }
  const named = new Set(promotions.flatMap((promotion) => [promotion.changeSetId!, ...(promotion.rollbackChangeSetId ? [promotion.rollbackChangeSetId] : [])]))
  const changeSets = new Map(deps.records.current<ChangeSetRecord>(DOMAINS.changeSets, target, (record) => named.has(record.id)).map((record) => [record.id, record]))
  const linkedAt = deps.now().toISOString()
  // Objects a verified rollback deleted: a link to one of them points at nothing, so it is
  // removed and never replayed. Only that exact target object, and only a verified delete.
  const deleted = new Set<string>()
  for (const promotion of promotions) {
    const rollback = promotion.rollbackChangeSetId ? changeSets.get(promotion.rollbackChangeSetId) : undefined
    if (rollback?.kind !== "rollback") continue
    for (const operation of rollback.operations) {
      const result = rollback.results[operation.key]
      const id = operation.action === "delete" && result?.status === "verified" ? (result.objectId ?? operation.targetId) : null
      if (id) deleted.add(id.toLowerCase())
    }
  }
  const gone = (link: SyncLink | undefined) => !!link && deleted.has(link.targetPolicyId.toLowerCase())
  const verified: Record<string, SyncLink> = {}
  for (const promotion of promotions) {
    const changeSet = changeSets.get(promotion.changeSetId!)
    if (!changeSet || changeSet.kind !== "change") continue
    for (const [key, link] of Object.entries(verifiedLinks(promotion, changeSet, linkedAt))) if (replaces(link, verified[key])) verified[key] = link
    // An applied rollback settled what the run wrote, so its creates are no longer unconfirmed.
    if (promotion.rollbackChangeSetId && changeSets.get(promotion.rollbackChangeSetId)?.status === "applied") continue
    for (const operation of changeSet.operations) {
      const status = changeSet.results[operation.key]?.status
      if (operation.action !== "create" || (status !== "uncertain" && status !== "writing") || !operation.source?.objectId) continue
      const key = linkKey(operation.folder, operation.source.objectId)
      unresolved[key] = { name: operation.source.label || operation.name, promotionIds: [...(unresolved[key]?.promotionIds ?? []), promotion.id] }
    }
  }
  // The newest verified link of each policy is chosen first; when a rollback deleted that object,
  // the policy has no link at all. An older, superseded link is never brought back.
  for (const [key, link] of Object.entries(verified)) if (gone(link)) delete verified[key]
  const stored = linksRecord(deps, target, source)
  const changed = Object.entries(verified).filter(([key, link]) => replaces(link, stored?.links[key]))
  const removed = Object.entries(stored?.links ?? {}).filter(([, link]) => gone(link)).length
  if (!changed.length && !removed) return { written: 0, unresolved }
  const linked = (total: number) => `${total} linked polic${total === 1 ? "y" : "ies"}`
  const reason = [
    ...(changed.length ? [`Linked ${changed.length} synced polic${changed.length === 1 ? "y" : "ies"}`] : []),
    ...(removed ? [`Removed ${removed} link${removed === 1 ? "" : "s"} to policies a rollback deleted`] : []),
  ].join("; ")
  if (!stored) {
    deps.records.create<SyncLinksRecord>(DOMAINS.syncLinks, target, { title: `Sync links from ${source}`, status: "active", summary: `${linked(changed.length)}.`, sourceTenantId: source, links: Object.fromEntries(changed) }, { actor: null, reason })
    return { written: changed.length, unresolved }
  }
  deps.records.update<SyncLinksRecord>(DOMAINS.syncLinks, target, stored.id, (latest) => {
    const links = { ...latest.links }
    for (const [key, link] of Object.entries(links)) if (gone(link)) delete links[key]
    for (const [key, link] of changed) if (replaces(link, links[key])) links[key] = link
    return { ...latest, links, summary: `${linked(Object.keys(links).length)}.` }
  }, { actor: null, reason })
  return { written: changed.length, unresolved }
}

/** The warning for a policy whose earlier Sync to this tenant has an unconfirmed create. */
export function unconfirmedCreate(sourceName: string): string {
  return `An earlier sync of "${sourceName}" to this tenant has an unconfirmed result. Syncing again may create a second copy. Retry that sync first so TenuVault can check.`
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
