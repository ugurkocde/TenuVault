import type { RouteModule } from "../../api/host"
import { typeForFolder } from "../../../shared/intune/registry"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import { featureRoute, FeatureError, optionalText, text, type ActionContext, type Body } from "../route"
import { applyChangeSet, approveChangeSet, createRollbackChangeSet, previewChangeSet, previewRollback, rejectChangeSet } from "../change-sets/engine"
import { listAll } from "../change-sets/graph"
import { applyPromotion, approvePromotion, getPromotion, planPromotion, previewPromotion, promotionChangeSet, promotionRollback, PROMOTION_FOLDER, PROMOTION_FOLDERS, syncPromotion, type PromotionRecord } from "./engine"
import { parseMappings } from "./mapping"
import { mappableObjects, requireSourceTenant } from "./targets"

const idOf = (body: Body): string => {
  const id = text(body, "id", 100)
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new FeatureError("Invalid promotion")
  return id
}

const hashField = (body: Body, key: string): string => {
  const value = body[key]
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new FeatureError(`${key} is required`)
  return value
}

/** Re-checks the two-tenant rule on every paid action of an existing promotion. */
function checkTenants(context: ActionContext, promotion: PromotionRecord): void {
  requireSourceTenant(context, promotion.sourceTenantId, { distinct: true })
}

async function policies(deps: FeatureDeps, tenantId: string, folder: string) {
  const type = typeForFolder(folder)
  if (!type || !(PROMOTION_FOLDERS as readonly string[]).includes(type.folder)) throw new FeatureError("Choose a policy type that promotion supports.")
  try {
    const select = type.folder === "ConfigurationPolicies" ? `id,${type.nameKey},platforms,technologies,lastModifiedDateTime` : `id,${type.nameKey},lastModifiedDateTime`
    const items = await listAll(await deps.graph(tenantId), `${type.path}?$select=${select}`)
    return items.map((item) => ({ id: String(item.id ?? ""), name: String(item[type.nameKey] ?? ""), folder: type.folder, platforms: typeof item.platforms === "string" ? item.platforms : null, lastModifiedDateTime: item.lastModifiedDateTime ?? null }))
  } catch (error) {
    if (error instanceof FeatureError) throw error
    throw new FeatureError(`${type.label} could not be read. ${error instanceof Error ? error.message : String(error)}`, 502)
  }
}

/**
 * /api/promotion (#145). The selected tenant is the destination (its plan is checked by the
 * route); the source is named in `sourceTenantId` and in `targetTenants`, so its plan is
 * checked too. On Pro both must be the two tenants of the same license. No MSP bulk or
 * portfolio endpoint is used or unlocked.
 */
export function routes(deps: FeatureDeps): Record<string, RouteModule> {
  return featureRoute("/api/promotion", deps, {
    list: ({ tenantId }) => ({ promotions: deps.records.list<PromotionRecord>(DOMAINS.promotions, tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ history: _history, ...record }) => record) }),
    get: ({ tenantId, body }) => {
      const promotion = getPromotion(deps, tenantId, idOf(body))
      const changeSet = promotion.changeSetId ? deps.records.get(DOMAINS.changeSets, tenantId, promotion.changeSetId) : null
      const rollbackChangeSet = promotion.rollbackChangeSetId ? deps.records.get(DOMAINS.changeSets, tenantId, promotion.rollbackChangeSetId) : null
      return { promotion, changeSet, rollbackChangeSet }
    },
    /** Source policies to select and destination policies an update may target explicitly. */
    policies: async (context) => {
      const source = requireSourceTenant(context, context.body.sourceTenantId, { distinct: true })
      const folder = typeof context.body.folder === "string" && context.body.folder ? context.body.folder : PROMOTION_FOLDER
      const [sourcePolicies, destinationPolicies] = await Promise.all([policies(deps, source, folder), policies(deps, context.tenantId, folder)])
      return { source: sourcePolicies, destination: destinationPolicies }
    },
    /**
     * Objects of the destination a dependency mapping can point to. Groups are not listed:
     * without Group.Read.All they cannot be read, so the admin enters a group object ID.
     */
    "target-objects": ({ tenantId, body }) => mappableObjects(deps, tenantId, body.kind),
    plan: async (context) => {
      const { tenantId, body, actor } = context
      const source = requireSourceTenant(context, body.sourceTenantId, { distinct: true })
      const items = body.items
      if (!Array.isArray(items)) throw new FeatureError("Select policies to promote.")
      let mappings
      try {
        mappings = parseMappings(body.mappings)
      } catch (error) {
        throw new FeatureError(error instanceof Error ? error.message : String(error))
      }
      const promotion = await planPromotion(deps, tenantId, {
        sourceTenantId: source,
        title: text(body, "title", 200),
        ticket: optionalText(body, "ticket", 200),
        includeAssignments: body.includeAssignments === true,
        dropUnsupportedExclusions: body.dropUnsupportedExclusions === true,
        acknowledgeRedacted: body.acknowledgeRedacted === true,
        items: items.map((item) => {
          const entry = (item ?? {}) as Record<string, unknown>
          if (typeof entry.sourceId !== "string") throw new FeatureError("Invalid policy selection")
          if (entry.destinationId !== null && entry.destinationId !== undefined && typeof entry.destinationId !== "string") throw new FeatureError("Invalid destination policy")
          if (entry.folder !== undefined && entry.folder !== null && typeof entry.folder !== "string") throw new FeatureError("Invalid policy type")
          // An update target is only ever the one the admin chose; never matched by name here.
          return { sourceId: entry.sourceId, destinationId: typeof entry.destinationId === "string" && entry.destinationId ? entry.destinationId : null, folder: typeof entry.folder === "string" && entry.folder ? entry.folder : PROMOTION_FOLDER }
        }),
        mappings,
      }, actor)
      return { promotion }
    },
    preview: async (context) => {
      const promotion = getPromotion(deps, context.tenantId, idOf(context.body))
      checkTenants(context, promotion)
      return previewPromotion(deps, context.tenantId, promotion.id)
    },
    approve: async (context) => {
      const promotion = getPromotion(deps, context.tenantId, idOf(context.body))
      checkTenants(context, promotion)
      const changeSet = await approvePromotion(deps, context.tenantId, promotion.id, { contentHash: hashField(context.body, "contentHash"), targetFingerprint: hashField(context.body, "targetFingerprint"), reviewer: optionalText(context.body, "reviewer", 200), note: optionalText(context.body, "note", 2000) }, context.actor)
      return { promotion: syncPromotion(deps, context.tenantId, promotion.id), changeSet }
    },
    reject: async (context) => {
      const promotion = getPromotion(deps, context.tenantId, idOf(context.body))
      const changeSet = promotionChangeSet(deps, context.tenantId, promotion.id)
      rejectChangeSet(deps, context.tenantId, changeSet.id, { reviewer: optionalText(context.body, "reviewer", 200), note: optionalText(context.body, "note", 2000) }, context.actor)
      return { promotion: syncPromotion(deps, context.tenantId, promotion.id) }
    },
    apply: async (context) => {
      const promotion = getPromotion(deps, context.tenantId, idOf(context.body))
      checkTenants(context, promotion)
      return applyPromotion(deps, context.tenantId, promotion.id, { contentHash: hashField(context.body, "contentHash"), confirmed: context.body.confirm === true }, context.actor)
    },
    retry: async (context) => {
      const promotion = getPromotion(deps, context.tenantId, idOf(context.body))
      checkTenants(context, promotion)
      return applyPromotion(deps, context.tenantId, promotion.id, { contentHash: hashField(context.body, "contentHash"), confirmed: context.body.confirm === true }, context.actor)
    },
    "rollback-preview": async (context) => {
      const changeSet = promotionChangeSet(deps, context.tenantId, idOf(context.body))
      return previewRollback(deps, context.tenantId, changeSet.id)
    },
    /** Creates the rollback change set; it is reviewed and applied with the rollback actions below. */
    "rollback-create": async (context) => {
      const id = idOf(context.body)
      const changeSet = promotionChangeSet(deps, context.tenantId, id)
      const rollback = await createRollbackChangeSet(deps, context.tenantId, changeSet.id, { title: optionalText(context.body, "title", 200), ticket: optionalText(context.body, "ticket", 200) }, context.actor)
      const promotion = deps.records.update<PromotionRecord>(DOMAINS.promotions, context.tenantId, id, (current) => ({ ...current, rollbackChangeSetId: rollback.id }), { actor: context.actor, reason: "Created a rollback change set" })
      return { promotion, changeSet: rollback }
    },
    // The rollback writes only to this destination, so the source license is not re-checked:
    // a lapsed development tenant never blocks undoing a promotion in production.
    "rollback-review": ({ tenantId, body }) => previewChangeSet(deps, tenantId, promotionRollback(deps, tenantId, idOf(body)).id),
    "rollback-approve": async ({ tenantId, body, actor }) => ({ changeSet: await approveChangeSet(deps, tenantId, promotionRollback(deps, tenantId, idOf(body)).id, { contentHash: hashField(body, "contentHash"), targetFingerprint: hashField(body, "targetFingerprint"), reviewer: optionalText(body, "reviewer", 200), note: optionalText(body, "note", 2000) }, actor) }),
    "rollback-reject": ({ tenantId, body, actor }) => ({ changeSet: rejectChangeSet(deps, tenantId, promotionRollback(deps, tenantId, idOf(body)).id, { reviewer: optionalText(body, "reviewer", 200), note: optionalText(body, "note", 2000) }, actor) }),
    "rollback-apply": async ({ tenantId, body, actor }) => ({ changeSet: await applyChangeSet(deps, tenantId, promotionRollback(deps, tenantId, idOf(body)).id, { contentHash: hashField(body, "contentHash"), confirmed: body.confirm === true }, actor) }),
  })
}

/** Background work while the app runs; returns a function that stops it. Promotion never synchronizes on its own. */
export function start(_deps: FeatureDeps): () => void {
  return () => undefined
}
