import type { GraphCall } from "../../../portal/lib/policies/graph-restore"
import { typeForFolder } from "../../../shared/intune/registry"
import { isGraphId } from "../../../shared/security"
import type { ListedRecord } from "../contracts"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import { FeatureError } from "../route"
import { readCurrent } from "../change-sets/graph"
import type { ChangeSetRecord } from "../change-sets/model"
import { applyPromotion, MAX_PROMOTION_ITEMS, planPromotion, PROMOTION_FOLDERS, type PlanCheck, type PlanInput, type PromotionRecord } from "../promotion/engine"
import type { DependencyFinding, Mapping } from "../promotion/mapping"
import { linkKey, recordSyncLinks, staleSyncLinks, syncLinks } from "./links"

/**
 * Sync: a one-way, administrator-started copy of selected policies from one source tenant to
 * one or more target tenants. Each target is planned, reviewed and applied as its own Dev to
 * Prod promotion (one promotion record and one change set in the target), so assignments,
 * secrets, scope tags and mappings follow the promotion rules, and a failure in one target
 * never stops or rolls back another.
 *
 * Unlike a promotion, Sync remembers which target object each source policy was written to
 * (links.ts), so the next run updates that object instead of creating another one. Nothing
 * runs on its own: later source edits are synced only by a new, reviewed run.
 */

export const MAX_SYNC_ITEMS = MAX_PROMOTION_ITEMS

export interface SyncRunRecord extends ListedRecord {
  sourceTenantId: string
  ticket: string | null
  options: { includeAssignments: boolean; dropUnsupportedExclusions: boolean; acknowledgeRedacted: boolean }
  /** sourceName is null until a target read the source policy. */
  items: Array<{ folder: string; sourceId: string; sourceName: string | null }>
  /** One entry per target: its promotion record, or why it could not be planned. */
  targets: Array<{ targetTenantId: string; promotionId: string | null; error: string | null }>
}

export interface SyncPlanInput {
  title: string
  ticket: string | null
  options: SyncRunRecord["options"]
  items: Array<{ folder: string; sourceId: string }>
  /** Checked by requireSyncTenants. */
  targets: string[]
  /** Confirmed mappings per target tenant ID; references resolve against that target. */
  mappings: Record<string, Mapping[]>
}

export interface SyncPlanResult {
  run: Stored<SyncRunRecord>
  targets: Array<{ targetTenantId: string; promotion: Stored<PromotionRecord> | null; error: string | null }>
}

/** Validates the selected policies before anything is stored; the type is the registry folder. */
function selectedItems(items: SyncPlanInput["items"]): SyncPlanInput["items"] {
  if (!items.length || items.length > MAX_SYNC_ITEMS) throw new FeatureError(`Select between 1 and ${MAX_SYNC_ITEMS} policies.`)
  const seen = new Set<string>()
  return items.map((item) => {
    if (!isGraphId(item.sourceId)) throw new FeatureError("Invalid policy ID")
    const type = typeForFolder(item.folder)
    if (!type || !(PROMOTION_FOLDERS as readonly string[]).includes(type.folder)) throw new FeatureError("Choose a policy type that Sync supports.")
    const key = linkKey(type.folder, item.sourceId)
    if (seen.has(key)) throw new FeatureError("A policy is selected twice.")
    seen.add(key)
    return { folder: type.folder, sourceId: item.sourceId }
  })
}

/**
 * The promotion items for one target: a linked object that still exists is updated; a linked
 * object that is gone is created again with a warning. Any other read error of the target fails
 * this target's plan, so a target that cannot be read never silently gets a duplicate. Also
 * returns the link state the plan relies on, which approval and apply re-check.
 */
async function linkedItems(deps: FeatureDeps, sourceTenantId: string, targetTenantId: string, items: SyncPlanInput["items"]): Promise<{ items: PlanInput["items"]; links: Record<string, string | null> }> {
  const links = syncLinks(deps, targetTenantId, sourceTenantId)
  const relied = Object.fromEntries(items.map((item) => [linkKey(item.folder, item.sourceId), links[linkKey(item.folder, item.sourceId)]?.targetPolicyId ?? null]))
  let graph: GraphCall | null = null
  const planned: PlanInput["items"] = []
  for (const item of items) {
    const link = links[linkKey(item.folder, item.sourceId)]
    if (!link) {
      planned.push({ ...item, destinationId: null })
      continue
    }
    graph ??= await deps.graph(targetTenantId)
    const live = await readCurrent(graph, typeForFolder(item.folder)!, link.targetPolicyId)
    if (live) {
      planned.push({ ...item, destinationId: link.targetPolicyId })
      continue
    }
    const note: DependencyFinding = { code: "sync-link-missing", severity: "warning", message: `"${link.targetName}", which an earlier Sync wrote "${link.sourceName}" to, no longer exists in this tenant. This Sync creates a new policy.` }
    planned.push({ ...item, destinationId: null, notes: [note] })
  }
  return { items: planned, links: relied }
}

/**
 * Plans a Sync run: stores the run under the source tenant, then plans each target in turn as
 * a promotion with workflow "sync". A target that cannot be planned is recorded with its error
 * and the others are still planned.
 */
export async function planSync(deps: FeatureDeps, sourceTenantId: string, input: SyncPlanInput, actor: string | null): Promise<SyncPlanResult> {
  const source = sourceTenantId.toLowerCase()
  const items = selectedItems(input.items)
  const title = input.title.trim()
  if (!title || title.length > 200) throw new FeatureError("A title of at most 200 characters is required.")
  let run = deps.records.create<SyncRunRecord>(DOMAINS.syncRuns, source, {
    title,
    status: "planning",
    summary: `Planning ${input.targets.length} target${input.targets.length === 1 ? "" : "s"}.`,
    sourceTenantId: source,
    ticket: input.ticket,
    options: input.options,
    items: items.map((item) => ({ ...item, sourceName: null })),
    targets: input.targets.map((targetTenantId) => ({ targetTenantId, promotionId: null, error: null })),
  }, { actor, reason: "Started a Sync run" })
  const results: SyncPlanResult["targets"] = []
  for (const target of input.targets) {
    let promotion: Stored<PromotionRecord> | null = null
    let error: string | null = null
    try {
      const linked = await linkedItems(deps, source, target, items)
      promotion = await planPromotion(deps, target, {
        sourceTenantId: source,
        title,
        ticket: input.ticket,
        includeAssignments: input.options.includeAssignments,
        dropUnsupportedExclusions: input.options.dropUnsupportedExclusions,
        acknowledgeRedacted: input.options.acknowledgeRedacted,
        items: linked.items,
        mappings: input.mappings[target] ?? [],
        workflow: "sync",
        sync: { runId: run.id, links: linked.links },
      }, actor)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
      // A plan whose change set could not be frozen is kept as blocked evidence; name it.
      promotion = deps.records.list<PromotionRecord>(DOMAINS.promotions, target).find((record) => record.sync?.runId === run.id) ?? null
    }
    results.push({ targetTenantId: target, promotion, error })
    const names = new Map((promotion?.items ?? []).map((item) => [linkKey(item.folder, item.sourceId), item.sourceName]))
    run = deps.records.update<SyncRunRecord>(DOMAINS.syncRuns, source, run.id, (current) => ({
      ...current,
      items: current.items.map((item) => ({ ...item, sourceName: item.sourceName ?? names.get(linkKey(item.folder, item.sourceId)) ?? null })),
      targets: current.targets.map((entry) => (entry.targetTenantId === target ? { targetTenantId: target, promotionId: promotion?.id ?? null, error } : entry)),
    }), { actor, reason: error ? `Target ${target} could not be planned` : `Planned target ${target}` })!
  }
  const failed = results.filter((result) => result.error).length
  const planned = results.length - failed
  const blocked = results.filter((result) => !result.error && result.promotion?.status === "blocked").length
  run = deps.records.update<SyncRunRecord>(DOMAINS.syncRuns, source, run.id, (current) => ({
    ...current,
    status: failed === 0 ? "planned" : planned === 0 ? "failed" : "partial",
    summary: `${planned} of ${results.length} target${results.length === 1 ? "" : "s"} planned${blocked ? `, ${blocked} blocked by findings` : ""}${failed ? `; ${failed} could not be planned` : ""}.`,
  }), { actor, reason: "Planned every target" })!
  return { run, targets: results }
}

/** The re-check of the links a Sync target's plan relied on, for preview, approval and apply. */
export function syncCheck(deps: FeatureDeps, targetTenantId: string, promotionId: string): PlanCheck {
  return () => staleSyncLinks(deps, targetTenantId, promotionId)
}

/**
 * Applies or retries one target's approved change set. The links the plan relied on are
 * re-checked before anything is written; a link written by another Sync since makes the change
 * set stale. Once an attempt is claimed, a link is recorded for every operation whose write was
 * verified, also when the apply failed part way, while the tenant write is still held.
 */
export async function applySync(deps: FeatureDeps, targetTenantId: string, promotionId: string, input: { contentHash: string; confirmed: boolean; backup: "new" | "none" }, actor: string | null): Promise<{ promotion: Stored<PromotionRecord>; changeSet: Stored<ChangeSetRecord> }> {
  return applyPromotion(deps, targetTenantId, promotionId, { ...input, check: syncCheck(deps, targetTenantId, promotionId), onSettled: (changeSet) => void recordSyncLinks(deps, targetTenantId, promotionId, changeSet) }, actor)
}
