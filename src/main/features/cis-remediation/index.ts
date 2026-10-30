import type { RouteModule } from "../../api/host"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import { featureRoute, FeatureError, optionalText, text, type Body } from "../route"
import { applyChangeSet, approveChangeSet, previewChangeSet, rejectChangeSet } from "../change-sets/engine"
import { applyCisRemediation, approveCisRemediation, cisChangeSet, cisRollback, createCisRollback, getCisRemediation, listCisRemediations, planCisRemediation, previewCisRemediation, previewCisRollback, syncCisRemediationOutcome } from "./engine"
import type { Finding } from "../../../shared/frameworks/policies"

const idOf = (body: Body): string => {
  const id = text(body, "id", 100)
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new FeatureError("Invalid benchmark deployment")
  return id
}
const hashField = (body: Body, key: string): string => {
  const value = body[key]
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new FeatureError(`${key} is required`)
  return value
}

/** /api/cis-remediation. Every action refuses while the internal benchmark flag is off. */
export function routes(deps: FeatureDeps): Record<string, RouteModule> {
  return featureRoute("/api/cis-remediation", deps, {
    list: ({ tenantId }) => ({ deployments: listCisRemediations(deps, tenantId) }),
    get: ({ tenantId, body }) => {
      const deployment = getCisRemediation(deps, tenantId, idOf(body))
      const changeSet = deployment.changeSetId ? deps.records.get(DOMAINS.changeSets, tenantId, deployment.changeSetId) : null
      const rollbackChangeSet = deployment.rollbackChangeSetId ? deps.records.get(DOMAINS.changeSets, tenantId, deployment.rollbackChangeSetId) : null
      return { deployment, changeSet, rollbackChangeSet }
    },
    plan: async (context) => {
      const { tenantId, body, actor } = context
      if (!Array.isArray(body.findings) && body.selectedPolicyIndexes === undefined) throw new FeatureError("Assessment findings are required.")
      const deployment = await planCisRemediation(deps, tenantId, {
        title: text(body, "title", 200), reference: text(body, "reference", 200),
        benchmarkName: optionalText(body, "benchmarkName", 200),
        runId: optionalText(body, "runId", 100),
        policies: body.policies,
        findings: (Array.isArray(body.findings) ? body.findings : []) as Finding[],
        selectedFindingKeys: Array.isArray(body.selectedFindingKeys) ? body.selectedFindingKeys.filter((key): key is string => typeof key === "string") : undefined,
        selectedPolicyIndexes: Array.isArray(body.selectedPolicyIndexes) ? body.selectedPolicyIndexes.filter((index): index is number => typeof index === "number") : undefined,
      }, actor)
      return { deployment }
    },
    preview: async (context) => previewCisRemediation(deps, context.tenantId, idOf(context.body)),
    approve: async (context) => {
      const changeSet = await approveCisRemediation(deps, context.tenantId, idOf(context.body), { contentHash: hashField(context.body, "contentHash"), targetFingerprint: hashField(context.body, "targetFingerprint"), reviewer: optionalText(context.body, "reviewer", 200), note: optionalText(context.body, "note", 2000) }, context.actor)
      return { deployment: syncCisRemediationOutcome(deps, context.tenantId, idOf(context.body)), changeSet }
    },
    reject: async (context) => {
      const changeSet = cisChangeSet(deps, context.tenantId, idOf(context.body))
      await rejectChangeSet(deps, context.tenantId, changeSet.id, { reviewer: optionalText(context.body, "reviewer", 200), note: optionalText(context.body, "note", 2000) }, context.actor)
      return { deployment: syncCisRemediationOutcome(deps, context.tenantId, idOf(context.body)) }
    },
    apply: async (context) => applyCisRemediation(deps, context.tenantId, idOf(context.body), { contentHash: hashField(context.body, "contentHash"), confirmed: context.body.confirm === true }, context.actor),
    retry: async (context) => applyCisRemediation(deps, context.tenantId, idOf(context.body), { contentHash: hashField(context.body, "contentHash"), confirmed: context.body.confirm === true }, context.actor),
    "rollback-preview": async (context) => previewCisRollback(deps, context.tenantId, idOf(context.body)),
    "rollback-create": async (context) => {
      const id = idOf(context.body)
      const rollback = await createCisRollback(deps, context.tenantId, id, { title: optionalText(context.body, "title", 200), ticket: optionalText(context.body, "ticket", 200) }, context.actor)
      return { deployment: getCisRemediation(deps, context.tenantId, id), changeSet: rollback }
    },
    "rollback-review": ({ tenantId, body }) => previewChangeSet(deps, tenantId, cisRollback(deps, tenantId, idOf(body)).id),
    "rollback-approve": async ({ tenantId, body, actor }) => ({ changeSet: await approveChangeSet(deps, tenantId, cisRollback(deps, tenantId, idOf(body)).id, { contentHash: hashField(body, "contentHash"), targetFingerprint: hashField(body, "targetFingerprint"), reviewer: optionalText(body, "reviewer", 200), note: optionalText(body, "note", 2000) }, actor) }),
    "rollback-reject": async ({ tenantId, body, actor }) => ({ changeSet: await rejectChangeSet(deps, tenantId, cisRollback(deps, tenantId, idOf(body)).id, { reviewer: optionalText(body, "reviewer", 200), note: optionalText(body, "note", 2000) }, actor) }),
    "rollback-apply": async ({ tenantId, body, actor }) => ({ changeSet: await applyChangeSet(deps, tenantId, cisRollback(deps, tenantId, idOf(body)).id, { contentHash: hashField(body, "contentHash"), confirmed: body.confirm === true }, actor) }),
  })
}

export function start(_deps: FeatureDeps): () => void { return () => undefined }
