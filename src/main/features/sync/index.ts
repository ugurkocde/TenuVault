import type { RouteModule } from "../../api/host"
import { allows, type Plan } from "../../../shared/plans"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import { featureRoute, FeatureError, optionalText, text, type Body } from "../route"
import { tenantWriteLabel, withTenantWrite } from "../write-lock"
import type { ChangeSetRecord } from "../change-sets/model"
import { applyChangeSet, approveChangeSet, createRollbackChangeSet, previewChangeSet, previewRollback, rejectChangeSet } from "../change-sets/engine"
import { policies } from "../promotion"
import { approvePromotion, previewPromotion, promotionChangeSet, promotionRollback, PROMOTION_FOLDER, syncPromotion, type PromotionRecord } from "../promotion/engine"
import { parseMappings, type Mapping } from "../promotion/mapping"
import { mappableObjects } from "../promotion/targets"
import { applySync, planSync, syncCheck, type SyncRunRecord } from "./engine"
import { recordSyncLinks } from "./links"
import { syncStatus } from "./status"
import { requireSyncTenants, targetIds } from "./tenants"

const recordId = (body: Body, label: string): string => {
  const id = text(body, "id", 100)
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new FeatureError(`Invalid ${label}`)
  return id
}

const hashField = (body: Body, key: string): string => {
  const value = body[key]
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new FeatureError(`${key} is required`)
  return value
}

/**
 * "new" backs up first; "none" skips the backup of a Sync change. Left out, the change set's
 * stored choice applies, or "new" on its first apply.
 */
const backupOf = (body: Body): "new" | "none" | undefined => {
  const value = body.backup
  if (value === undefined || value === null) return undefined
  if (value === "new" || value === "none") return value
  throw new FeatureError("backup must be \"new\" or \"none\".")
}

/** A Sync target under its target tenant; a Dev to Prod promotion is not found here. */
function syncTarget(deps: FeatureDeps, tenantId: string, body: Body): Stored<PromotionRecord> {
  const record = deps.records.get<PromotionRecord>(DOMAINS.promotions, tenantId, recordId(body, "Sync target"))
  if (!record?.sync) throw new FeatureError("This Sync target does not exist for this tenant.", 404)
  return record
}

/** The backup choice a Sync approval must name; the target's apply and retries are bound to it. */
const approvedBackup = (body: Body): "new" | "none" => {
  const value = body.backup
  if (value !== "new" && value !== "none") throw new FeatureError("Choose whether to back up before this sync: backup must be \"new\" or \"none\".")
  return value
}

/**
 * The backup choice an apply already bound the target's change set to, as the change-set engine
 * decides it: the stored choice, else what the pre-change capture shows, else "new" once an apply
 * was claimed. Null while no apply claimed it, when an approval may still change the choice.
 */
function claimedBackup(deps: FeatureDeps, tenantId: string, target: Stored<PromotionRecord>): "new" | "none" | null {
  const changeSet = target.changeSetId ? deps.records.get<ChangeSetRecord>(DOMAINS.changeSets, tenantId, target.changeSetId) : null
  if (!changeSet) return null
  if (changeSet.backupChoice) return changeSet.backupChoice
  if (changeSet.preChange) return changeSet.preChange.backupFolder === null ? "none" : "new"
  return changeSet.attempts > 0 ? "new" : null
}

/**
 * The backup choice of an apply or retry: the one the target was approved with, which a request
 * naming the other one cannot change (409). Checked when the request arrives, and again inside
 * the tenant write right before the claim, where the approved choice cannot change any more. A target approved before choices were stored keeps
 * the request's choice, and the change set's first claimed apply binds it.
 */
function boundBackup(target: Stored<PromotionRecord>, body: Body): "new" | "none" | undefined {
  const requested = backupOf(body)
  const stored = target.sync?.backup
  if (stored && requested && requested !== stored) throw new FeatureError(`This sync was approved ${stored === "none" ? "without a backup" : "with a backup"}. Apply it with the same choice.`, 409)
  return stored ?? requested
}

function syncRun(deps: FeatureDeps, tenantId: string, body: Body): Stored<SyncRunRecord> {
  const run = deps.records.get<SyncRunRecord>(DOMAINS.syncRuns, tenantId, recordId(body, "Sync run"))
  if (!run) throw new FeatureError("This Sync run does not exist for this source tenant.", 404)
  return run
}

/**
 * Re-checks the plan rule for one target of a run against every target of that run, so acting
 * on the targets of a run to several tenants one by one stays an MSP action on all of them.
 */
async function requireRunTenants(deps: FeatureDeps, tenantId: string, target: Stored<PromotionRecord>): Promise<void> {
  const run = deps.records.current<SyncRunRecord>(DOMAINS.syncRuns, target.sourceTenantId, (record) => record.id === target.sync!.runId)[0]
  const targets = run?.targets.map((entry) => entry.targetTenantId) ?? []
  if (!targets.includes(tenantId)) throw new FeatureError("The Sync run of this target no longer exists. Plan again.", 409)
  requireNotDiscarded(run!)
  await requireSyncTenants(deps, target.sourceTenantId, targets)
}

const DISCARDED = "discarded"

/** A discarded run is kept as a record only: none of its targets can be reviewed, approved or applied. */
function requireNotDiscarded(run: SyncRunRecord): void {
  if (run.status === DISCARDED) throw new FeatureError("This sync was discarded. Start a new sync.", 409)
}

/** The Sync run of a target, read again; null when it no longer exists. */
const runOf = (deps: FeatureDeps, target: Stored<PromotionRecord>) => deps.records.current<SyncRunRecord>(DOMAINS.syncRuns, target.sourceTenantId, (record) => record.id === target.sync!.runId)[0] ?? null

/**
 * Whether a target of a run was ever approved or applied: its approval stored a backup choice,
 * its change set holds an approval, or an apply was claimed. Reads only.
 */
function everApproved(deps: FeatureDeps, target: SyncRunRecord["targets"][number]): boolean {
  const promotion = target.promotionId ? deps.records.get<PromotionRecord>(DOMAINS.promotions, target.targetTenantId, target.promotionId) : null
  if (!promotion) return false
  if (promotion.sync?.backup) return true
  const changeSet = promotion.changeSetId ? deps.records.get<ChangeSetRecord>(DOMAINS.changeSets, target.targetTenantId, promotion.changeSetId) : null
  return !!changeSet && (changeSet.review?.decision === "approved" || changeSet.attempts > 0 || !["in-review", "rejected", "stale"].includes(changeSet.status))
}

type RunOutcome = "applied" | "partial" | "failed" | "applying" | "rolled-back" | "not-applied" | "in-sync"

/**
 * The outcome of a run for its row in Recent syncs, from the change sets of the targets an apply
 * was claimed for: still applying, every one rolled back by an applied rollback, every one
 * applied, every one failed with nothing verified, or partly applied. A run never applied is not
 * applied, or already in sync when every target was.
 */
function runOutcome(deps: FeatureDeps, run: SyncRunRecord, inSync: boolean): RunOutcome {
  const records = run.targets.flatMap((target) => {
    const { changeSet, rollbackChangeSet } = targetRecords(deps, target.targetTenantId, target.promotionId)
    const record = changeSet as Stored<ChangeSetRecord> | null
    return record && record.attempts > 0 ? [{ record, rollback: rollbackChangeSet as Stored<ChangeSetRecord> | null }] : []
  })
  const tried = records.map((entry) => entry.record)
  if (!tried.length) return inSync ? "in-sync" : "not-applied"
  if (tried.some((changeSet) => changeSet.status === "applying")) return "applying"
  if (records.every((entry) => entry.rollback?.status === "applied")) return "rolled-back"
  if (tried.every((changeSet) => changeSet.status === "applied")) return "applied"
  if (tried.every(nothingWritten)) return "failed"
  return "partial"
}

/**
 * An applied change set that wrote nothing: it failed with no verified write, or it stopped
 * before writing (a pre-change backup or capture that failed leaves no capture and no written,
 * verified or unconfirmed result).
 */
function nothingWritten(changeSet: ChangeSetRecord): boolean {
  const results = Object.values(changeSet.results)
  if (changeSet.status === "failed") return !results.some((result) => result.status === "verified")
  return !changeSet.preChange && !results.some((result) => result.status === "verified" || result.status === "uncertain" || result.status === "writing")
}

/** The stored promotion, change set and rollback of a target; reads only. */
function targetRecords(deps: FeatureDeps, tenantId: string, promotionId: string | null) {
  const promotion = promotionId ? deps.records.get<PromotionRecord>(DOMAINS.promotions, tenantId, promotionId) : null
  const changeSet = promotion?.changeSetId ? deps.records.get(DOMAINS.changeSets, tenantId, promotion.changeSetId) : null
  const rollbackChangeSet = promotion?.rollbackChangeSetId ? deps.records.get(DOMAINS.changeSets, tenantId, promotion.rollbackChangeSetId) : null
  return { promotion, changeSet, rollbackChangeSet }
}

/** Whether the change set of a Sync target was ever applied; reads only. */
function attempted(deps: FeatureDeps, tenantId: string, promotionId: string | null): boolean {
  const promotion = promotionId ? deps.records.get<PromotionRecord>(DOMAINS.promotions, tenantId, promotionId) : null
  return !!promotion?.changeSetId && (deps.records.get<ChangeSetRecord>(DOMAINS.changeSets, tenantId, promotion.changeSetId)?.attempts ?? 0) > 0
}

function parseItems(value: unknown): Array<{ folder: string; sourceId: string }> {
  if (!Array.isArray(value)) throw new FeatureError("Select policies to sync.")
  return value.map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>
    if (typeof entry.sourceId !== "string") throw new FeatureError("Invalid policy selection")
    if (entry.folder !== undefined && entry.folder !== null && typeof entry.folder !== "string") throw new FeatureError("Invalid policy type")
    return { sourceId: entry.sourceId, folder: typeof entry.folder === "string" && entry.folder ? entry.folder : PROMOTION_FOLDER }
  })
}

/** Confirmed mappings per target: `{ [targetTenantId]: Mapping[] }`. */
function parseTargetMappings(value: unknown, targets: string[]): Record<string, Mapping[]> {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) throw new FeatureError("mappings must list the mappings of each target tenant by its tenant ID.")
  const mappings: Record<string, Mapping[]> = {}
  for (const [tenantId, list] of Object.entries(value as Record<string, unknown>)) {
    const target = tenantId.toLowerCase()
    if (!targets.includes(target)) throw new FeatureError("mappings name a tenant that is not a target of this Sync.")
    try {
      mappings[target] = parseMappings(list)
    } catch (error) {
      throw new FeatureError(error instanceof Error ? error.message : String(error))
    }
  }
  return mappings
}

/**
 * /api/sync. Run-level actions (policies, target-objects, plan, status) are sent for the source
 * tenant and name every target in `targetTenants`. Actions on one target (preview, approve,
 * reject, apply, retry and the rollback steps) are sent for that target with the ID of its
 * Sync target record. The route checks the Sync plan of the tenant; requireSyncTenants checks
 * every involved tenant again, including the MSP rule for more than one target.
 */
export function routes(deps: FeatureDeps): Record<string, RouteModule> {
  return featureRoute("/api/sync", deps, {
    // `applied`: whether any target's change set was ever applied, so a draft that was only planned can be told apart.
    // `inSync`: every target was already in sync, so nothing needed applying.
    // `outcome`: the run's result for Recent syncs (runOutcome). Discarded runs are kept as records and not listed.
    "list-runs": ({ tenantId }) => ({
      runs: deps.records.list<SyncRunRecord>(DOMAINS.syncRuns, tenantId).filter((run) => run.status !== DISCARDED).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ history: _history, ...run }) => {
        const inSync = run.targets.length > 0 && run.targets.every((target) => !target.promotionId && !target.error && (target.skipped?.length ?? 0) > 0)
        return { ...run, applied: run.targets.some((target) => attempted(deps, target.targetTenantId, target.promotionId)), inSync, outcome: runOutcome(deps, run, inSync) }
      }),
    }),
    "get-run": ({ tenantId, body }) => {
      const run = syncRun(deps, tenantId, body)
      return { run, targets: run.targets.map((target) => ({ ...target, ...targetRecords(deps, target.targetTenantId, target.promotionId) })) }
    },
    "get-target": ({ tenantId, body }) => targetRecords(deps, tenantId, syncTarget(deps, tenantId, body).id),
    /**
     * Discards a run that was planned and never approved: the record is kept and marked discarded,
     * it leaves Recent syncs, and none of its targets can be approved any more. Refused (409) once
     * any target was approved or applied, and while a target tenant is being changed, so an
     * approval running now cannot complete on a discarded run.
     */
    "discard-run": ({ tenantId, body, actor }) => {
      const run = syncRun(deps, tenantId, body)
      if (run.status === DISCARDED) return { run }
      // The planner still writes the run's targets; a discard would race it.
      if (run.status === "planning") throw new FeatureError("This sync is still being planned. Discard it once planning finished.", 409)
      if (run.targets.some((target) => everApproved(deps, target))) throw new FeatureError("A target of this sync was approved, so it cannot be discarded. Open it to see its result.", 409)
      const busy = run.targets.find((target) => tenantWriteLabel(target.targetTenantId) !== undefined)
      if (busy) throw new FeatureError("A target tenant of this sync is being changed. Try again when it finishes.", 409)
      return { run: deps.records.update<SyncRunRecord>(DOMAINS.syncRuns, tenantId, run.id, (current) => ({ ...current, status: DISCARDED, summary: "Discarded before any target was approved." }), { actor, reason: "Discarded before any target was approved" }) }
    },
    /** Source policies to select; the selected tenant is the source. */
    policies: async ({ tenantId, body }) => ({ source: await policies(deps, tenantId, typeof body.folder === "string" && body.folder ? body.folder : PROMOTION_FOLDER) }),
    /**
     * Every other connected tenant and whether it can be a target of a Sync from the selected
     * tenant, by the rule requireSyncTenants applies: both plans need Sync; one target outside
     * MSP must share the source's license. `multiple` is false when a run may name only one
     * target. Reads plans only; a tenant whose plan cannot be read is not eligible.
     */
    targets: async ({ tenantId, plan }) => {
      const multiple = allows(plan, "bulkActions")
      const others = [...new Set(deps.tenants().map((id) => id.toLowerCase()))].filter((id) => id !== tenantId)
      const targets = await Promise.all(others.map(async (id) => {
        const targetPlan: Plan | null = await deps.plan(id).catch(() => null)
        if (!targetPlan) return { tenantId: id, eligible: false, multiple: false, reason: "unavailable" as const }
        if (!allows(targetPlan, "sync")) return { tenantId: id, eligible: false, multiple: false, reason: "plan" as const }
        if (multiple && allows(targetPlan, "bulkActions")) return { tenantId: id, eligible: true, multiple: true, reason: null }
        if (deps.sameLicense(tenantId, id)) return { tenantId: id, eligible: true, multiple: false, reason: null }
        return { tenantId: id, eligible: false, multiple: false, reason: "msp" as const }
      }))
      return { multiple, targets }
    },
    /** Objects of one target a dependency mapping can point to. */
    "target-objects": async ({ tenantId, body }) => {
      const { targets } = await requireSyncTenants(deps, tenantId, [body.targetTenantId])
      return mappableObjects(deps, targets[0]!, body.kind)
    },
    plan: async ({ tenantId, body, actor }) => {
      const { source, targets } = await requireSyncTenants(deps, tenantId, targetIds(body.targetTenants))
      return planSync(deps, source, {
        title: text(body, "title", 200),
        ticket: optionalText(body, "ticket", 200),
        options: { includeAssignments: body.includeAssignments === true, dropUnsupportedExclusions: body.dropUnsupportedExclusions === true, acknowledgeRedacted: body.acknowledgeRedacted === true },
        items: parseItems(body.items),
        targets,
        mappings: parseTargetMappings(body.mappings, targets),
      }, actor)
    },
    status: async ({ tenantId, body }) => {
      const { source, targets } = await requireSyncTenants(deps, tenantId, targetIds(body.targetTenants))
      return syncStatus(deps, source, targets)
    },
    preview: async ({ tenantId, body }) => {
      const target = syncTarget(deps, tenantId, body)
      await requireRunTenants(deps, tenantId, target)
      return previewPromotion(deps, tenantId, target.id, syncCheck(deps, tenantId, target.id))
    },
    approve: async ({ tenantId, body, actor }) => {
      const target = syncTarget(deps, tenantId, body)
      await requireRunTenants(deps, tenantId, target)
      const backup = approvedBackup(body)
      // Under the tenant write that an apply claims under, so an apply never claims a choice in
      // between this check and the store below: an overlapping apply is refused instead.
      return withTenantWrite(tenantId, "Sync approval", async () => {
        // Once an apply started, the approval keeps the choice it bound, so the target stays retryable.
        const latest = syncTarget(deps, tenantId, body)
        // A discard that completed while this request waited for the tenant write is final.
        const run = runOf(deps, latest)
        if (run) requireNotDiscarded(run)
        const claimed = claimedBackup(deps, tenantId, latest)
        if (claimed && claimed !== backup) throw new FeatureError(`This sync was already started ${claimed === "none" ? "without a backup" : "with a backup"}. Approve it with the same choice.`, 409)
        const changeSet = await approvePromotion(deps, tenantId, target.id, { contentHash: hashField(body, "contentHash"), targetFingerprint: hashField(body, "targetFingerprint"), reviewer: null, note: null, check: syncCheck(deps, tenantId, target.id) }, actor)
        // Stored with the approval, so the apply and every retry use it whoever sends them later.
        deps.records.update<PromotionRecord>(DOMAINS.promotions, tenantId, target.id, (current) => ({ ...current, sync: { ...current.sync!, backup } }), { actor, reason: backup === "none" ? "Approved to apply without a pre-change backup" : "Approved to apply after a pre-change backup" })
        return { promotion: syncPromotion(deps, tenantId, target.id), changeSet }
      })
    },
    reject: async ({ tenantId, body, actor }) => {
      const target = syncTarget(deps, tenantId, body)
      await requireRunTenants(deps, tenantId, target)
      await rejectChangeSet(deps, tenantId, promotionChangeSet(deps, tenantId, target.id).id, { reviewer: null, note: null }, actor)
      return { promotion: syncPromotion(deps, tenantId, target.id) }
    },
    apply: async ({ tenantId, body, actor }) => {
      const target = syncTarget(deps, tenantId, body)
      boundBackup(target, body)
      await requireRunTenants(deps, tenantId, target)
      return applySync(deps, tenantId, target.id, { contentHash: hashField(body, "contentHash"), confirmed: body.confirm === true, resolveBackup: () => boundBackup(syncTarget(deps, tenantId, body), body) }, actor)
    },
    retry: async ({ tenantId, body, actor }) => {
      const target = syncTarget(deps, tenantId, body)
      boundBackup(target, body)
      await requireRunTenants(deps, tenantId, target)
      return applySync(deps, tenantId, target.id, { contentHash: hashField(body, "contentHash"), confirmed: body.confirm === true, resolveBackup: () => boundBackup(syncTarget(deps, tenantId, body), body) }, actor)
    },
    // The rollback steps write only to this target, so the source is not re-checked: an undo
    // must keep working after the source license lapses, as for Dev to Prod.
    "rollback-preview": ({ tenantId, body }) => previewRollback(deps, tenantId, promotionChangeSet(deps, tenantId, syncTarget(deps, tenantId, body).id).id),
    "rollback-create": async ({ tenantId, body, actor }) => {
      const target = syncTarget(deps, tenantId, body)
      const rollback = await createRollbackChangeSet(deps, tenantId, promotionChangeSet(deps, tenantId, target.id).id, { title: optionalText(body, "title", 200), ticket: optionalText(body, "ticket", 200) }, actor)
      const promotion = deps.records.update<PromotionRecord>(DOMAINS.promotions, tenantId, target.id, (current) => ({ ...current, rollbackChangeSetId: rollback.id }), { actor, reason: "Created a rollback change set" })
      return { promotion, changeSet: rollback }
    },
    "rollback-review": ({ tenantId, body }) => previewChangeSet(deps, tenantId, promotionRollback(deps, tenantId, syncTarget(deps, tenantId, body).id).id),
    "rollback-approve": async ({ tenantId, body, actor }) => ({ changeSet: await approveChangeSet(deps, tenantId, promotionRollback(deps, tenantId, syncTarget(deps, tenantId, body).id).id, { contentHash: hashField(body, "contentHash"), targetFingerprint: hashField(body, "targetFingerprint"), reviewer: null, note: null }, actor) }),
    "rollback-reject": async ({ tenantId, body, actor }) => ({ changeSet: await rejectChangeSet(deps, tenantId, promotionRollback(deps, tenantId, syncTarget(deps, tenantId, body).id).id, { reviewer: null, note: null }, actor) }),
    // A rollback always backs up first: the engine refuses backup "none" for it.
    // Once it settles, the links are replayed under the tenant write, so a link to a policy the
    // rollback deleted is removed and that policy reads as not synced again.
    "rollback-apply": async ({ tenantId, body, actor }) => {
      const target = syncTarget(deps, tenantId, body)
      return { changeSet: await applyChangeSet(deps, tenantId, promotionRollback(deps, tenantId, target.id).id, { contentHash: hashField(body, "contentHash"), confirmed: body.confirm === true, backup: backupOf(body), onSettled: () => { recordSyncLinks(deps, tenantId, target.sourceTenantId) } }, actor) }
    },
  })
}

/** Background work while the app runs; returns a function that stops it. Sync never runs on its own. */
export function start(_deps: FeatureDeps): () => void {
  return () => undefined
}
