import type { GraphCall } from "../../../portal/lib/policies/graph-restore"
import { typeForFolder, type Item } from "../../../shared/intune/registry"
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
import { linkKey, recordSyncLinks, staleSyncLinks, syncLinks, unconfirmedCreate, type SyncReplay } from "./links"
import { linkState } from "./status"

/**
 * Sync: a one-way, administrator-started copy of selected policies from one source tenant to
 * one or more target tenants. Each target is planned, reviewed and applied as its own Dev to
 * Prod promotion (one promotion record and one change set in the target), so assignments,
 * secrets, scope tags and mappings follow the promotion rules, and a failure in one target
 * never stops or rolls back another.
 *
 * Unlike a promotion, Sync remembers which target object each source policy was written to
 * (links.ts), so the next run updates that object instead of creating another one, and leaves
 * out a linked policy neither side changed since (status.ts), so nothing is written for it.
 * Nothing runs on its own: later source edits are synced only by a new, reviewed run.
 */

export const MAX_SYNC_ITEMS = MAX_PROMOTION_ITEMS

export interface SyncRunRecord extends ListedRecord {
  sourceTenantId: string
  ticket: string | null
  options: { includeAssignments: boolean; dropUnsupportedExclusions: boolean; acknowledgeRedacted: boolean }
  /** sourceName is null until a target read the source policy. */
  items: Array<{ folder: string; sourceId: string; sourceName: string | null }>
  /**
   * One entry per target: its promotion record, or why it could not be planned, and the selected
   * policies left out because they are already in sync there. A target whose every policy is in
   * sync has no promotion and no error. Runs stored before skipping existed have no `skipped`.
   */
  targets: Array<{ targetTenantId: string; promotionId: string | null; error: string | null; skipped?: SyncSkip[] }>
}

/** A selected policy a target's plan left out; nothing is written for it. */
export interface SyncSkip { folder: string; sourceId: string; sourceName: string; reason: "already in sync" }

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
  targets: Array<{ targetTenantId: string; promotion: Stored<PromotionRecord> | null; error: string | null; skipped: SyncSkip[] }>
}

/** The live source policies of a run, each read once however many targets link it. */
type SourceReader = (folder: string, sourceId: string) => Promise<Item | null>

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
 * this target's plan, so a target that cannot be read never silently gets a duplicate. A linked
 * object that is in sync with its source (neither side moved since the verified write, by the
 * status rule) is left out and returned as skipped; when the source cannot be read it is planned
 * as an update instead. Also returns the link state the plan relies on, which approval and
 * apply re-check.
 */
async function linkedItems(deps: FeatureDeps, sourceTenantId: string, targetTenantId: string, items: SyncPlanInput["items"], unresolved: SyncReplay["unresolved"], readSource: SourceReader): Promise<{ items: PlanInput["items"]; links: Record<string, string | null>; skipped: SyncSkip[] }> {
  const links = syncLinks(deps, targetTenantId, sourceTenantId)
  const relied = Object.fromEntries(items.map((item) => [linkKey(item.folder, item.sourceId), links[linkKey(item.folder, item.sourceId)]?.targetPolicyId ?? null]))
  let graph: GraphCall | null = null
  const planned: PlanInput["items"] = []
  const skipped: SyncSkip[] = []
  for (const item of items) {
    const key = linkKey(item.folder, item.sourceId)
    const link = links[key]
    // A create whose earlier outcome is unconfirmed may have made the policy without a link, so a
    // new create of that policy carries a warning. It never blocks: retrying that sync settles it.
    const unconfirmed = unresolved[key]
    const warnings: DependencyFinding[] = unconfirmed ? [{ code: "sync-unconfirmed", severity: "warning", message: unconfirmedCreate(unconfirmed.name) }] : []
    if (!link) {
      planned.push({ ...item, destinationId: null, ...(warnings.length ? { notes: warnings } : {}) })
      continue
    }
    graph ??= await deps.graph(targetTenantId)
    const live = await readCurrent(graph, typeForFolder(item.folder)!, link.targetPolicyId)
    if (live) {
      if (!unconfirmed) {
        const source = await readSource(item.folder, item.sourceId).catch(() => null)
        if (source && linkState(typeForFolder(item.folder)!, link, source, live).state === "in-sync") {
          skipped.push({ ...item, sourceName: link.sourceName, reason: "already in sync" })
          continue
        }
      }
      planned.push({ ...item, destinationId: link.targetPolicyId })
      continue
    }
    const note: DependencyFinding = { code: "sync-link-missing", severity: "warning", message: `"${link.targetName}", which an earlier Sync wrote "${link.sourceName}" to, no longer exists in this tenant. This Sync creates a new policy.` }
    planned.push({ ...item, destinationId: null, notes: [note, ...warnings] })
  }
  return { items: planned, links: relied, skipped }
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
    targets: input.targets.map((targetTenantId) => ({ targetTenantId, promotionId: null, error: null, skipped: [] })),
  }, { actor, reason: "Started a Sync run" })
  const results: SyncPlanResult["targets"] = []
  let sourceGraph: Promise<GraphCall> | null = null
  const sourceReads = new Map<string, Promise<Item | null>>()
  const readSource: SourceReader = (folder, sourceId) => {
    const key = linkKey(folder, sourceId)
    if (!sourceReads.has(key)) {
      sourceGraph ??= deps.graph(source)
      sourceReads.set(key, sourceGraph.then((graph) => readCurrent(graph, typeForFolder(folder)!, sourceId)))
    }
    return sourceReads.get(key)!
  }
  for (const target of input.targets) {
    let promotion: Stored<PromotionRecord> | null = null
    let error: string | null = null
    let skipped: SyncSkip[] = []
    try {
      // Repairs links whose write was lost before the plan relies on them.
      const replay = recordSyncLinks(deps, target, source)
      const linked = await linkedItems(deps, source, target, items, replay.unresolved, readSource)
      skipped = linked.skipped
      // Every selected policy is in sync here: nothing to plan, review or write.
      if (linked.items.length) promotion = await planPromotion(deps, target, {
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
    results.push({ targetTenantId: target, promotion, error, skipped })
    const names = new Map([...skipped, ...(promotion?.items ?? [])].map((item) => [linkKey(item.folder, item.sourceId), item.sourceName]))
    run = deps.records.update<SyncRunRecord>(DOMAINS.syncRuns, source, run.id, (current) => ({
      ...current,
      items: current.items.map((item) => ({ ...item, sourceName: item.sourceName ?? names.get(linkKey(item.folder, item.sourceId)) ?? null })),
      targets: current.targets.map((entry) => (entry.targetTenantId === target ? { targetTenantId: target, promotionId: promotion?.id ?? null, error, skipped } : entry)),
    }), { actor, reason: error ? `Target ${target} could not be planned` : promotion ? `Planned target ${target}` : `Target ${target} is already in sync` })!
  }
  const failed = results.filter((result) => result.error).length
  const planned = results.length - failed
  const blocked = results.filter((result) => !result.error && result.promotion?.status === "blocked").length
  const inSync = results.filter((result) => !result.error && !result.promotion).length
  run = deps.records.update<SyncRunRecord>(DOMAINS.syncRuns, source, run.id, (current) => ({
    ...current,
    status: failed === 0 ? "planned" : planned === 0 ? "failed" : "partial",
    summary: `${planned} of ${results.length} target${results.length === 1 ? "" : "s"} planned${inSync ? `, ${inSync} already in sync` : ""}${blocked ? `, ${blocked} blocked by findings` : ""}${failed ? `; ${failed} could not be planned` : ""}.`,
  }), { actor, reason: "Planned every target" })!
  return { run, targets: results }
}

/**
 * The re-check of the links a Sync target's plan relied on, for preview, approval and apply
 * (where it runs under the tenant write). Lost link writes are repaired first.
 */
export function syncCheck(deps: FeatureDeps, targetTenantId: string, promotionId: string): PlanCheck {
  return () => {
    const promotion = deps.records.get<PromotionRecord>(DOMAINS.promotions, targetTenantId, promotionId)
    if (!promotion) return []
    recordSyncLinks(deps, targetTenantId, promotion.sourceTenantId)
    return staleSyncLinks(deps, targetTenantId, promotionId)
  }
}

/**
 * Applies or retries one target's approved change set. The links the plan relied on are
 * re-checked before anything is written; a link written by another Sync since makes the change
 * set stale. Once an attempt is claimed, a link is recorded for every operation whose write was
 * verified, also when the apply failed part way, while the tenant write is still held.
 */
export async function applySync(deps: FeatureDeps, targetTenantId: string, promotionId: string, input: { contentHash: string; confirmed: boolean; backup: "new" | "none" }, actor: string | null): Promise<{ promotion: Stored<PromotionRecord>; changeSet: Stored<ChangeSetRecord> }> {
  const source = deps.records.get<PromotionRecord>(DOMAINS.promotions, targetTenantId, promotionId)?.sourceTenantId
  return applyPromotion(deps, targetTenantId, promotionId, { ...input, check: syncCheck(deps, targetTenantId, promotionId), onSettled: () => { if (source) recordSyncLinks(deps, targetTenantId, source) } }, actor)
}
