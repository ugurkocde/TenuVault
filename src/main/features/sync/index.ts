import type { RouteModule } from "../../api/host"
import { allows, type Plan } from "../../../shared/plans"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import { featureRoute, FeatureError, optionalText, text, type Body } from "../route"
import type { ChangeSetRecord } from "../change-sets/model"
import { applyChangeSet, approveChangeSet, createRollbackChangeSet, previewChangeSet, previewRollback, rejectChangeSet } from "../change-sets/engine"
import { policies } from "../promotion"
import { approvePromotion, previewPromotion, promotionChangeSet, promotionRollback, PROMOTION_FOLDER, syncPromotion, type PromotionRecord } from "../promotion/engine"
import { parseMappings, type Mapping } from "../promotion/mapping"
import { mappableObjects } from "../promotion/targets"
import { applySync, planSync, syncCheck, type SyncRunRecord } from "./engine"
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
  await requireSyncTenants(deps, target.sourceTenantId, targets)
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
    "list-runs": ({ tenantId }) => ({ runs: deps.records.list<SyncRunRecord>(DOMAINS.syncRuns, tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ history: _history, ...run }) => ({ ...run, applied: run.targets.some((target) => attempted(deps, target.targetTenantId, target.promotionId)) })) }),
    "get-run": ({ tenantId, body }) => {
      const run = syncRun(deps, tenantId, body)
      return { run, targets: run.targets.map((target) => ({ ...target, ...targetRecords(deps, target.targetTenantId, target.promotionId) })) }
    },
    "get-target": ({ tenantId, body }) => targetRecords(deps, tenantId, syncTarget(deps, tenantId, body).id),
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
      const changeSet = await approvePromotion(deps, tenantId, target.id, { contentHash: hashField(body, "contentHash"), targetFingerprint: hashField(body, "targetFingerprint"), reviewer: null, note: null, check: syncCheck(deps, tenantId, target.id) }, actor)
      return { promotion: syncPromotion(deps, tenantId, target.id), changeSet }
    },
    reject: async ({ tenantId, body, actor }) => {
      const target = syncTarget(deps, tenantId, body)
      await requireRunTenants(deps, tenantId, target)
      await rejectChangeSet(deps, tenantId, promotionChangeSet(deps, tenantId, target.id).id, { reviewer: null, note: null }, actor)
      return { promotion: syncPromotion(deps, tenantId, target.id) }
    },
    apply: async ({ tenantId, body, actor }) => {
      const target = syncTarget(deps, tenantId, body)
      const backup = backupOf(body)
      await requireRunTenants(deps, tenantId, target)
      return applySync(deps, tenantId, target.id, { contentHash: hashField(body, "contentHash"), confirmed: body.confirm === true, backup }, actor)
    },
    retry: async ({ tenantId, body, actor }) => {
      const target = syncTarget(deps, tenantId, body)
      const backup = backupOf(body)
      await requireRunTenants(deps, tenantId, target)
      return applySync(deps, tenantId, target.id, { contentHash: hashField(body, "contentHash"), confirmed: body.confirm === true, backup }, actor)
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
    "rollback-apply": async ({ tenantId, body, actor }) => ({ changeSet: await applyChangeSet(deps, tenantId, promotionRollback(deps, tenantId, syncTarget(deps, tenantId, body).id).id, { contentHash: hashField(body, "contentHash"), confirmed: body.confirm === true, backup: backupOf(body) }, actor) }),
  })
}

/** Background work while the app runs; returns a function that stops it. Sync never runs on its own. */
export function start(_deps: FeatureDeps): () => void {
  return () => undefined
}
