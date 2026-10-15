import type { RouteModule } from "../../api/host"
import type { FeatureDeps } from "../deps"
import { featureRoute, FeatureError, optionalText, text, type Body } from "../route"
import { changeSetActions } from "../baseline-upgrades/change-actions"
import { listChangeSets } from "../change-sets/engine"
import type { Choice } from "../baseline-upgrades/merge"
import { OIB_PLATFORMS, type OibPlatform } from "../../../shared/oib/types"
import { validateAssessmentScope } from "../../frameworks/native"
import { EditError, type Edit } from "./model"
import { listSnapshots } from "./snapshot"
import {
  applyRebase,
  checkReleases,
  compareRebase,
  compareWithFramework,
  compareWithTenant,
  customizeOib,
  defaultSources,
  deployVersion,
  discardRebase,
  fromSnapshot,
  getBaseline,
  getComparison,
  getDeployment,
  getRebase,
  getVersion,
  listBaselines,
  listComparisons,
  listDeployments,
  listRebases,
  plainOf,
  resolveRebase,
  saveVersion,
  syncDeployment,
  versionView,
  WORKFLOW,
  type CustomBaselineSources,
  type FrameworkTarget,
  type RebaseEntry,
} from "./service"

const PLATFORMS = Object.keys(OIB_PLATFORMS) as OibPlatform[]

const idOf = (body: Body, key = "id"): string => {
  const id = text(body, key, 100)
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new FeatureError(`Invalid ${key}`)
  return id
}

const commitOf = (body: Body): string => {
  const commit = text(body, "commit", 40)
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new FeatureError("The OpenIntuneBaseline version is missing. Reload the latest version and try again.")
  return commit
}

const platformOf = (value: unknown): OibPlatform => {
  if (!PLATFORMS.includes(value as OibPlatform)) throw new FeatureError("Choose a supported OpenIntuneBaseline platform.")
  return value as OibPlatform
}

const versionOf = (body: Body): number | null => {
  if (body.version === undefined || body.version === null) return null
  if (typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version < 1) throw new FeatureError("Invalid version")
  return body.version
}

const list = (value: unknown, max: number, what: string): Record<string, unknown>[] => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > max) throw new FeatureError(`Invalid ${what}`)
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new FeatureError(`Invalid ${what}`)
    return entry as Record<string, unknown>
  })
}

const key = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !value || value.length > 500) throw new FeatureError(`Invalid ${what}`)
  return value
}

/** Edits from the renderer, validated in shape here and in content by applyEdits. */
function editsOf(value: unknown): Edit[] {
  return list(value, 2000, "edits").map((entry) => {
    const policyKey = key(entry.policyKey, "policy")
    if (entry.type === "remove-policy") return { type: "remove-policy", policyKey }
    const settingKey = key(entry.settingKey, "setting")
    if (entry.type === "remove-setting") return { type: "remove-setting", policyKey, settingKey }
    if (entry.type === "set") {
      if (typeof entry.path !== "string" || entry.path.length > 500) throw new FeatureError("Invalid edit path")
      if (typeof entry.value !== "string" && typeof entry.value !== "number") throw new FeatureError("An edited value is text or a number.")
      return { type: "set", policyKey, settingKey, path: entry.path, value: entry.value }
    }
    throw new FeatureError("Invalid edit")
  })
}

function frameworkOf(value: unknown): FrameworkTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FeatureError("Choose a framework.")
  const target = value as Record<string, unknown>
  if (target.kind === "oib") return { kind: "oib", platform: platformOf(target.platform), commit: commitOf(target) }
  if (target.kind === "ncsc") return { kind: "ncsc" }
  const frameworkId = typeof target.frameworkId === "string" && /^[a-z0-9-]{1,60}$/.test(target.frameworkId) ? target.frameworkId : null
  if (!frameworkId) throw new FeatureError("Choose a framework.")
  if (target.kind === "workspace") return { kind: "workspace", frameworkId }
  if (target.kind === "native") {
    let scope
    try {
      scope = validateAssessmentScope(target.scope)
    } catch (error) {
      throw new FeatureError(error instanceof Error ? error.message : "Invalid scope")
    }
    return { kind: "native", frameworkId, scope }
  }
  throw new FeatureError("Choose a framework.")
}

/** EditError is the admin's input; everything else passes through. */
function editing<T>(action: () => T): T {
  try {
    return action()
  } catch (error) {
    if (error instanceof EditError) throw new FeatureError(error.message)
    throw error
  }
}

/** List answers leave out frozen content and heavy comparison details. */
const comparisonSummary = (record: ReturnType<typeof listComparisons>[number]) => {
  const { history: _h, tenantPolicies: _t, findings: _f, native: _n, ...rest } = record
  return rest
}

/**
 * /api/custom-baselines (Pro and MSP, feature customBaselines). `list` and `get` return stored
 * records on every plan (after bookkeeping of change-set outcomes), so baselines, versions,
 * deployments and comparisons stay readable after a downgrade. Deployments are change sets with
 * origin "custom-baseline", reviewed, applied, retried and rolled back through this route's
 * `change-...` actions (named by the deployment `id`). Assignments are never written.
 *
 * Tenant isolation: a baseline belongs to the tenant it was created in. `deploy` into another
 * tenant runs with that tenant as `tenantId`, names the baseline's tenant in `sourceTenantId`
 * and in `targetTenants` (so its plan is checked); on Pro both tenants must share the license.
 */
export function routes(deps: FeatureDeps, sources: CustomBaselineSources = defaultSources): Record<string, RouteModule> {
  return featureRoute("/api/custom-baselines", deps, {
    ...changeSetActions(deps, { prefix: "", workflow: WORKFLOW, exists: (tenantId, id) => void getDeployment(deps, tenantId, id), sync: (tenantId, id) => syncDeployment(deps, tenantId, id) }),

    list: ({ tenantId }) => ({
      baselines: listBaselines(deps, tenantId).map(plainOf),
      deployments: listDeployments(deps, tenantId).map((entry) => plainOf(syncDeployment(deps, tenantId, entry.id))),
      comparisons: listComparisons(deps, tenantId).map(comparisonSummary),
    }),
    get: ({ tenantId, body }) => {
      const id = idOf(body)
      if (body.kind === "deployment") {
        const deployment = syncDeployment(deps, tenantId, id)
        return { deployment, changeSets: listChangeSets(deps, tenantId).filter((entry) => entry.origin.workflow === WORKFLOW && entry.origin.recordId === id) }
      }
      if (body.kind === "comparison") return { comparison: plainOf(getComparison(deps, tenantId, id)) }
      if (body.kind === "rebase") return { rebase: plainOf(getRebase(deps, tenantId, id)) }
      const baseline = getBaseline(deps, tenantId, id)
      return { baseline, version: versionView(getVersion(deps, tenantId, baseline, versionOf(body))), rebases: listRebases(deps, tenantId, id).map(plainOf) }
    },

    customize: async ({ tenantId, body, actor }) => ({ baseline: plainOf(await customizeOib(deps, sources, tenantId, { platform: platformOf(body.platform), commit: commitOf(body), name: optionalText(body, "name", 200), releaseTag: optionalText(body, "releaseTag", 100) ?? undefined }, actor)) }),
    snapshots: async ({ tenantId }) => ({ snapshots: await listSnapshots(deps, tenantId) }),
    "from-snapshot": async ({ tenantId, body, actor }) => {
      const backupId = text(body, "backupId", 200)
      if (!/^[A-Za-z0-9._-]+$/.test(backupId)) throw new FeatureError("Invalid backup")
      return { baseline: plainOf(await fromSnapshot(deps, tenantId, { backupId, name: optionalText(body, "name", 200) }, actor)) }
    },
    "save-version": ({ tenantId, body, actor }) => {
      if (typeof body.fromVersion !== "number" || !Number.isSafeInteger(body.fromVersion)) throw new FeatureError("fromVersion is required")
      const input = { fromVersion: body.fromVersion, name: optionalText(body, "name", 200), note: text(body, "note", 1000), edits: editsOf(body.edits) }
      return { baseline: plainOf(editing(() => saveVersion(deps, tenantId, idOf(body), input, actor))) }
    },

    releases: ({ tenantId, body, actor }) => checkReleases(deps, sources, tenantId, idOf(body), actor),
    "rebase-compare": async ({ tenantId, body, actor }) => ({ rebase: plainOf(await compareRebase(deps, sources, tenantId, idOf(body), commitOf(body), actor)) }),
    "rebase-resolve": ({ tenantId, body, actor }) => {
      const settings = list(body.settings, 5000, "resolutions").map((entry) => {
        if (entry.choice !== "local" && entry.choice !== "upstream") throw new FeatureError("A resolution is local or upstream.")
        return { policyKey: key(entry.policyKey, "policy"), settingKey: key(entry.settingKey, "setting"), choice: entry.choice as Choice }
      })
      const policies = list(body.policies, 500, "policy choices").map((entry) => {
        if (!["include", "skip", "keep", "drop", "local", "upstream"].includes(String(entry.choice))) throw new FeatureError("Invalid policy choice")
        return { policyKey: key(entry.policyKey, "policy"), choice: entry.choice as RebaseEntry["choice"] }
      })
      return { rebase: plainOf(resolveRebase(deps, tenantId, idOf(body, "rebaseId"), { settings, policies }, actor)) }
    },
    "rebase-apply": ({ tenantId, body, actor }) => ({ baseline: plainOf(applyRebase(deps, tenantId, idOf(body, "rebaseId"), optionalText(body, "note", 1000), actor)) }),
    "rebase-discard": ({ tenantId, body, actor }) => ({ rebase: plainOf(discardRebase(deps, tenantId, idOf(body, "rebaseId"), actor)) }),

    deploy: async ({ tenantId, body, plan, targetTenants, actor }) => {
      if (body.policyKeys !== undefined && body.policyKeys !== null && (!Array.isArray(body.policyKeys) || body.policyKeys.length > 200)) throw new FeatureError("Invalid policies")
      const policyKeys = Array.isArray(body.policyKeys) ? body.policyKeys.map((entry) => key(entry, "policy")) : null
      const sourceTenantId = body.sourceTenantId === undefined || body.sourceTenantId === null ? null : text(body, "sourceTenantId", 100)
      const result = await deployVersion(deps, { tenantId, plan, targetTenants }, { baselineId: idOf(body), sourceTenantId, version: versionOf(body), policyKeys, title: optionalText(body, "title", 200), ticket: optionalText(body, "ticket", 200) }, actor)
      return { deployment: plainOf(result.deployment), changeSet: result.changeSet }
    },

    "compare-tenant": async ({ tenantId, body, actor }) => {
      const source = body.source === "live" ? "live" : body.source === "backup" ? "backup" : null
      if (!source) throw new FeatureError("Compare with the latest complete backup or the live tenant.")
      const backupId = optionalText(body, "backupId", 200)
      if (backupId && !/^[A-Za-z0-9._-]+$/.test(backupId)) throw new FeatureError("Invalid backup")
      return { comparison: plainOf(await compareWithTenant(deps, tenantId, { baselineId: idOf(body), version: versionOf(body), source, backupId }, actor)) }
    },
    "compare-framework": async ({ tenantId, body, plan, actor }) => ({ comparison: plainOf(await compareWithFramework(deps, sources, { tenantId, plan }, { baselineId: idOf(body), version: versionOf(body), target: frameworkOf(body.framework) }, actor)) }),
  })
}

/** Nothing runs in the background; releases are checked when the admin asks. */
export function start(_deps: FeatureDeps): () => void {
  return () => undefined
}
