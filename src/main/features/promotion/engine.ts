import { comparableSnapshot } from "../../../shared/intune/compare"
import { typeForFolder } from "../../../shared/intune/registry"
import { isGraphId } from "../../../shared/security"
import type { ListedRecord } from "../contracts"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import { FeatureError } from "../route"
import { applyChangeSet, approveChangeSet, createChangeSet, getChangeSet, previewChangeSet, type ChangeSetPreview, type OperationInput } from "../change-sets/engine"
import { createListingMemo, readCurrent } from "../change-sets/graph"
import { hashOf, sanitizeSnapshot, type ChangeSetRecord } from "../change-sets/model"
import type { DependencyFinding, Mapping, ReferenceResolution, TargetReads } from "./mapping"
import { resolveTarget, staleTargets } from "./targets"

/**
 * Dev to Prod promotion (#145): a deliberate, one-way, administrator-started copy of selected
 * Settings Catalog policies from a source tenant into a destination tenant.
 *
 * Planning resolves every tenant-specific reference of each policy against the destination
 * through confirmed mappings and, when nothing blocks, freezes one change set in the
 * destination. Approval, the production pre-change backup, the freshness re-check, journaled
 * writes, read-back and rollback are the change-set engine's; the destination objects each
 * plan relied on are re-checked before approval and again right before writing. Nothing
 * synchronizes continuously: later source edits are never propagated.
 */

export const PROMOTION_FOLDER = "ConfigurationPolicies"
export const MAX_PROMOTION_ITEMS = 25

export interface PromotionItem {
  sourceId: string
  sourceName: string
  sourceVersion: string | null
  /** sha256 of the sanitized source configuration that was reviewed. */
  sourceHash: string
  /** Destination object chosen explicitly for an update; null creates a new policy. */
  destinationId: string | null
  action: "create" | "update"
  blocked: boolean
  findings: DependencyFinding[]
  /** How each tenant-specific reference resolved in the destination. */
  references: ReferenceResolution[]
  /** The destination objects the plan relied on, and their hash at planning time. */
  targetReads: TargetReads
  targetStateHash: string
}

export interface PromotionRecord extends ListedRecord {
  status: "blocked" | ChangeSetRecord["status"]
  sourceTenantId: string
  destinationTenantId: string
  ticket: string | null
  includeAssignments: boolean
  acknowledgeRedacted?: boolean
  items: PromotionItem[]
  changeSetId: string | null
  rollbackChangeSetId: string | null
}

export interface PlanInput {
  sourceTenantId: string
  title: string
  ticket: string | null
  includeAssignments: boolean
  dropUnsupportedExclusions: boolean
  acknowledgeRedacted?: boolean
  items: Array<{ sourceId: string; destinationId: string | null }>
  mappings: Mapping[]
}

export function getPromotion(deps: FeatureDeps, tenantId: string, id: string): Stored<PromotionRecord> {
  const record = deps.records.get<PromotionRecord>(DOMAINS.promotions, tenantId, id)
  if (!record) throw new FeatureError("This promotion does not exist for this destination tenant.", 404)
  return record
}

/** The promotion with its status taken from its change set, which owns the outcome. */
export function syncPromotion(deps: FeatureDeps, tenantId: string, id: string): Stored<PromotionRecord> {
  const record = getPromotion(deps, tenantId, id)
  if (!record.changeSetId) return record
  const changeSet = deps.records.get<ChangeSetRecord>(DOMAINS.changeSets, tenantId, record.changeSetId)
  if (!changeSet || (changeSet.status === record.status && changeSet.summary === record.summary)) return record
  return deps.records.update<PromotionRecord>(DOMAINS.promotions, tenantId, id, (current) => ({ ...current, status: changeSet.status, summary: changeSet.summary }), { actor: null, reason: `Change set is ${changeSet.status}` })!
}

/**
 * Plans a promotion: reads each selected source policy, reviews its dependencies and
 * targeting against the destination, and when nothing blocks freezes one change set in the
 * destination for review. Blocked plans are stored with their findings and no change set.
 */
export async function planPromotion(deps: FeatureDeps, destinationTenantId: string, input: PlanInput, actor: string | null): Promise<Stored<PromotionRecord>> {
  const destination = destinationTenantId.toLowerCase()
  const source = input.sourceTenantId.toLowerCase()
  if (source === destination) throw new FeatureError("Source and destination must be different tenants.")
  if (!input.items.length || input.items.length > MAX_PROMOTION_ITEMS) throw new FeatureError(`Select between 1 and ${MAX_PROMOTION_ITEMS} policies.`)
  const seen = new Set<string>()
  for (const item of input.items) {
    if (!isGraphId(item.sourceId) || (item.destinationId !== null && !isGraphId(item.destinationId))) throw new FeatureError("Invalid policy ID")
    if (seen.has(item.sourceId.toLowerCase())) throw new FeatureError("A policy is selected twice.")
    seen.add(item.sourceId.toLowerCase())
  }
  const type = typeForFolder(PROMOTION_FOLDER)!
  const sourceGraph = await deps.graph(source)
  const listings = { source: createListingMemo(), target: createListingMemo() }
  const items: PromotionItem[] = []
  const operations: OperationInput[] = []
  for (const item of input.items) {
    let raw
    try {
      raw = await readCurrent(sourceGraph, type, item.sourceId)
    } catch (error) {
      throw new FeatureError(`A source policy could not be read. ${error instanceof Error ? error.message : String(error)}`, 502)
    }
    if (!raw) throw new FeatureError("A selected source policy no longer exists.", 404)
    const sourceVersion = typeof raw.lastModifiedDateTime === "string" ? raw.lastModifiedDateTime : null
    const snapshot = sanitizeSnapshot(type, raw).snapshot
    const resolved = await resolveTarget(deps, destination, {
      sourceTenantId: source,
      folder: PROMOTION_FOLDER,
      sourceObjectId: item.sourceId,
      targetObjectId: item.destinationId,
      includeAssignments: input.includeAssignments,
      dropUnsupportedExclusions: input.dropUnsupportedExclusions,
      acknowledgeRedacted: input.acknowledgeRedacted,
      mappings: input.mappings,
      sourceSnapshot: snapshot,
    }, listings)
    const { blocked, proposed } = resolved
    items.push({ sourceId: item.sourceId, sourceName: resolved.sourceName, sourceVersion, sourceHash: hashOf(comparableSnapshot(snapshot)), destinationId: item.destinationId, action: item.destinationId ? "update" : "create", blocked, findings: resolved.findings, references: resolved.references, targetReads: resolved.targetReads, targetStateHash: resolved.targetStateHash })
    if (!blocked) operations.push({ folder: PROMOTION_FOLDER, action: item.destinationId ? "update" : "create", targetId: item.destinationId, proposed: proposed.body, assignments: input.includeAssignments ? proposed.assignments : null, source: { tenantId: source, objectId: item.sourceId, version: sourceVersion, label: resolved.sourceName } })
  }
  const blockedCount = items.filter((item) => item.blocked).length
  const promotion = deps.records.create<PromotionRecord>(DOMAINS.promotions, destination, {
    title: input.title,
    status: blockedCount ? "blocked" : "in-review",
    summary: blockedCount ? `${blockedCount} of ${items.length} policies are blocked; resolve findings and plan again.` : `${items.length} policies ready for review.`,
    sourceTenantId: source,
    destinationTenantId: destination,
    ticket: input.ticket,
    includeAssignments: input.includeAssignments,
    acknowledgeRedacted: input.acknowledgeRedacted === true,
    items,
    changeSetId: null,
    rollbackChangeSetId: null,
  }, { actor, reason: "Planned a promotion" })
  if (blockedCount) return promotion
  let changeSet: Stored<ChangeSetRecord>
  try {
    changeSet = await createChangeSet(deps, destination, {
    title: input.title,
    ticket: input.ticket,
    origin: { workflow: "promotion", recordId: promotion.id },
    sourceTenantId: source,
    sourceVersion: items.map((item) => `${item.sourceId}@${item.sourceVersion ?? "unknown"}`).join(",").slice(0, 2000),
    operations,
    // The resolved destination objects are part of the content hash an approval binds to.
    dependencies: items.flatMap((item) => item.references.filter((reference) => reference.targetId).map((reference) => ({ kind: reference.kind, sourceId: reference.sourceId, targetId: reference.targetId, name: reference.targetName, state: reference.state === "mapped" || reference.state === "portable" ? "verified" as const : "unknown" as const }))),
    }, actor)
  } catch (error) {
    // Keep the plan as evidence, but never as a promotion that looks ready.
    const message = error instanceof Error ? error.message : String(error)
    deps.records.update<PromotionRecord>(DOMAINS.promotions, destination, promotion.id, (current) => ({ ...current, status: "blocked", summary: `The change set could not be frozen: ${message}` }), { actor, reason: "Blocked: change set could not be created" })
    throw error
  }
  return deps.records.update<PromotionRecord>(DOMAINS.promotions, destination, promotion.id, (current) => ({ ...current, changeSetId: changeSet.id }), { actor, reason: "Froze the promotion into a change set" })!
}

export interface PromotionPreview {
  promotion: Stored<PromotionRecord>
  changeSet: ChangeSetPreview
  /** Source policies edited after planning. They are promoted as reviewed; later edits are not propagated. */
  sourceChanges: string[]
}

/** Reasons the destination objects a promotion's plan relied on changed; empty when unchanged. */
function staleDependencies(deps: FeatureDeps, tenantId: string, promotion: PromotionRecord): Promise<string[]> {
  return staleTargets(deps, tenantId, promotion.items.filter((item) => !item.blocked))
}

/**
 * The change-set preview plus a note on source edits made after planning. Changed destination
 * dependencies are listed as blockers, so the plan cannot be approved against them. Never writes.
 */
export async function previewPromotion(deps: FeatureDeps, tenantId: string, id: string): Promise<PromotionPreview> {
  const promotion = syncPromotion(deps, tenantId, id)
  if (!promotion.changeSetId) throw new FeatureError("This promotion is blocked. Resolve its findings and plan again.", 409)
  const preview = await previewChangeSet(deps, tenantId, promotion.changeSetId)
  const changeSet = { ...preview, blockers: [...(await staleDependencies(deps, tenantId, promotion)), ...preview.blockers] }
  const type = typeForFolder(PROMOTION_FOLDER)!
  const sourceChanges: string[] = []
  try {
    const graph = await deps.graph(promotion.sourceTenantId)
    for (const item of promotion.items) {
      const live = await readCurrent(graph, type, item.sourceId)
      if (!live) sourceChanges.push(`"${item.sourceName}" was deleted in the source after planning. The reviewed version is still promoted.`)
      else if (hashOf(comparableSnapshot(sanitizeSnapshot(type, live).snapshot)) !== item.sourceHash) sourceChanges.push(`"${item.sourceName}" changed in the source after planning. Only the reviewed version is promoted; plan again to include later edits.`)
    }
  } catch (error) {
    sourceChanges.push(`The source tenant could not be re-read: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { promotion, changeSet, sourceChanges }
}

/** Approves the promotion's change set after re-checking the destination dependencies it relies on. */
export async function approvePromotion(deps: FeatureDeps, tenantId: string, id: string, input: { contentHash: string; targetFingerprint: string; reviewer?: string | null; note?: string | null }, actor: string | null): Promise<Stored<ChangeSetRecord>> {
  const promotion = getPromotion(deps, tenantId, id)
  if (!promotion.changeSetId) throw new FeatureError("This promotion is blocked. Resolve its findings and plan again.", 409)
  const stale = await staleDependencies(deps, tenantId, promotion)
  if (stale.length) throw new FeatureError(`This promotion cannot be approved: ${stale.join(" ")}`, 409)
  return approveChangeSet(deps, tenantId, promotion.changeSetId, input, actor)
}

/**
 * Applies the promotion's approved change set into the destination: freshness re-check of the
 * target and of the mapped dependencies, production pre-change backup (fail closed), a second
 * dependency re-check, capture, journaled writes with read-back.
 */
export async function applyPromotion(deps: FeatureDeps, tenantId: string, id: string, input: { contentHash: string; confirmed: boolean }, actor: string | null): Promise<{ promotion: Stored<PromotionRecord>; changeSet: Stored<ChangeSetRecord> }> {
  const promotion = getPromotion(deps, tenantId, id)
  if (!promotion.changeSetId) throw new FeatureError("This promotion is blocked. Resolve its findings and plan again.", 409)
  try {
    const changeSet = await applyChangeSet(deps, tenantId, promotion.changeSetId, { ...input, dependencyCheck: () => staleDependencies(deps, tenantId, promotion) }, actor)
    return { promotion: syncPromotion(deps, tenantId, id), changeSet }
  } catch (error) {
    syncPromotion(deps, tenantId, id)
    throw error
  }
}

/** The promotion's change set, for approval and rollback calls. */
export function promotionChangeSet(deps: FeatureDeps, tenantId: string, id: string): Stored<ChangeSetRecord> {
  const promotion = getPromotion(deps, tenantId, id)
  if (!promotion.changeSetId) throw new FeatureError("This promotion is blocked and has no change set.", 409)
  return getChangeSet(deps, tenantId, promotion.changeSetId)
}

/** The rollback change set created for the promotion; it only writes to the destination. */
export function promotionRollback(deps: FeatureDeps, tenantId: string, id: string): Stored<ChangeSetRecord> {
  const promotion = getPromotion(deps, tenantId, id)
  if (!promotion.rollbackChangeSetId) throw new FeatureError("No rollback was created for this promotion. Preview and create one first.", 409)
  const rollback = getChangeSet(deps, tenantId, promotion.rollbackChangeSetId)
  if (rollback.kind !== "rollback" || rollback.rollbackOf !== promotion.changeSetId) throw new FeatureError("The rollback of this promotion does not match its change set.", 409)
  return rollback
}
