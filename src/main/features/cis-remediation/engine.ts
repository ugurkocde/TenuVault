import { parsePolicies, remediationPayload, type Assessment, type BaselinePolicy, type Finding } from "../../../shared/frameworks/policies"
import { typeForFolder, type Item } from "../../../shared/intune/registry"
import { isGraphId } from "../../../shared/security"
import type { ListedRecord } from "../contracts"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import { FeatureError } from "../route"
import { applyChangeSet, approveChangeSet, createChangeSet, getChangeSet, previewChangeSet, previewRollback, createRollbackChangeSet, type ChangeSetPreview, type OperationInput, type RollbackPreview } from "../change-sets/engine"
import { readCurrent } from "../change-sets/graph"
import type { ChangeSetRecord } from "../change-sets/model"
import { internalCisBenchmarksEnabled } from "../../frameworks/service"

/**
 * Deploy and remediation from an imported benchmark pack. Planning freezes one
 * change set through the change-set engine, so review binding, the pre-change
 * backup, stale checks, journaled writes, read-back, rollback and audit are the
 * change-set engine's. New policies are always created unassigned. A finding
 * that differs in an existing tenant policy updates that policy in place and
 * leaves its assignments untouched; the preview states that exposure per policy.
 * A name collision never selects an existing policy for overwriting: creates
 * keep the change-set behaviour of warning and creating another object, bound
 * to the same-name fingerprint an approval checks again before writing.
 */

export const OFFLINE_PREVIEW_NOTICE = "This preview is an offline comparison against the last assessment. It is not a tenant dry run: approval and apply read the tenant again, and a changed tenant stops the apply before anything is written."
export const UNASSIGNED_NOTICE = "New benchmark policies are created with no assignments. Nothing takes effect until an administrator assigns them deliberately in Intune. Assignments are never copied in this flow."
export const RECOMPARE_NOTICE = "Run the comparison again from this screen after an apply or rollback to verify which findings closed or recovered."

export interface CisRemediationItem {
  policyIndex: number
  policyName: string
  action: "create" | "update"
  targetId: string | null
  targetName: string | null
  findingKeys: string[]
  /** True when an in-place update keeps the existing policy assignments and exposure. */
  assignedExposure: boolean
  assignmentCount: number
}

export interface CisRemediationRecord extends ListedRecord {
  status: "blocked" | ChangeSetRecord["status"]
  tenantId: string
  reference: string
  runId: string | null
  items: CisRemediationItem[]
  changeSetId: string | null
  rollbackChangeSetId: string | null
}

export interface PlanCisInput {
  title: string
  reference: string
  runId?: string | null
  policies: unknown
  findings: Finding[]
  selectedFindingKeys?: string[]
  selectedPolicyIndexes?: number[]
}

export function requireCisBenchmarksEnabled(): void {
  if (!internalCisBenchmarksEnabled()) throw new FeatureError("CIS comparisons are coming soon.", 403)
}

function loadCisRemediation(deps: FeatureDeps, tenantId: string, id: string): Stored<CisRemediationRecord> {
  const record = deps.records.get<CisRemediationRecord>(DOMAINS.cisRemediations, tenantId, id)
  if (!record) throw new FeatureError("This benchmark deployment does not exist for this tenant.", 404)
  return record
}

export function getCisRemediation(deps: FeatureDeps, tenantId: string, id: string): Stored<CisRemediationRecord> {
  requireCisBenchmarksEnabled()
  return loadCisRemediation(deps, tenantId, id)
}

/**
 * Local status bookkeeping after an apply attempt. It performs no tenant or CIS
 * content operation, so it deliberately does not recheck current authorization:
 * revocation during an apply must not mask the recorded outcome of writes that
 * already happened. Public reads use syncCisRemediation below, which is gated.
 */
function syncCisRemediationRecord(deps: FeatureDeps, tenantId: string, id: string): Stored<CisRemediationRecord> {
  const record = loadCisRemediation(deps, tenantId, id)
  if (!record.changeSetId) return record
  const changeSet = deps.records.get<ChangeSetRecord>(DOMAINS.changeSets, tenantId, record.changeSetId)
  if (!changeSet || (changeSet.status === record.status && changeSet.summary === record.summary)) return record
  return deps.records.update<CisRemediationRecord>(DOMAINS.cisRemediations, tenantId, id, (current) => ({ ...current, status: changeSet.status, summary: changeSet.summary }), { actor: null, reason: `Change set is ${changeSet.status}` })!
}

export function syncCisRemediation(deps: FeatureDeps, tenantId: string, id: string): Stored<CisRemediationRecord> {
  requireCisBenchmarksEnabled()
  return syncCisRemediationRecord(deps, tenantId, id)
}

function settingIdOf(setting: unknown): string | null {
  const instance = (setting as Item | null)?.settingInstance as Item | undefined
  return typeof instance?.settingDefinitionId === "string" ? instance.settingDefinitionId : null
}

/** Benchmark settings of one policy replaced or inserted into a live policy body, by definition. */
function mergedBody(live: Item, policy: BaselinePolicy, settings: BaselinePolicy["settings"]): Item {
  const body = structuredClone(live)
  const existing = Array.isArray(body.settings) ? [...(body.settings as Item[])] : []
  for (const setting of settings) {
    const id = settingIdOf(setting)
    const index = id ? existing.findIndex((entry) => settingIdOf(entry) === id) : -1
    const replacement = structuredClone(setting) as Item
    if (index >= 0) existing[index] = replacement
    else existing.push(replacement)
  }
  body.settings = existing
  return body
}

function createdBody(policy: BaselinePolicy, settings: BaselinePolicy["settings"], reference: string): Item {
  const payload = remediationPayload(policy, settings, reference)
  return { name: payload.name, platforms: payload.platforms, technologies: payload.technologies, description: payload.description, roleScopeTagIds: ["0"], settings: structuredClone(settings) } as Item
}

export async function planCisRemediation(deps: FeatureDeps, tenantId: string, input: PlanCisInput, actor: string | null): Promise<Stored<CisRemediationRecord>> {
  requireCisBenchmarksEnabled()
  const tenant = tenantId.toLowerCase()
  if (!input.title.trim() || input.title.length > 200) throw new FeatureError("A title of at most 200 characters is required.")
  if (!input.reference.trim() || input.reference.length > 200) throw new FeatureError("Provide a source version up to 200 characters.")
  const policies = parsePolicies(input.policies)
  const findings = Array.isArray(input.findings) ? input.findings : []
  const whole = Array.isArray(input.selectedPolicyIndexes) && input.selectedPolicyIndexes.length > 0
  const findingKeys = new Set(input.selectedFindingKeys ?? [])
  if (whole && findingKeys.size) throw new FeatureError("Select either findings or whole benchmark policies, not both.")
  if (!whole && !findingKeys.size) throw new FeatureError("Select deviating findings or whole benchmark policies.")
  const type = typeForFolder("ConfigurationPolicies")!

  const groups = new Map<number, Finding[]>()
  const policyIndexes = new Set<number>()
  if (whole) {
    for (const index of input.selectedPolicyIndexes!) {
      if (!Number.isInteger(index) || !policies[index]) throw new FeatureError("A selected benchmark policy does not exist in the imported pack.")
      policyIndexes.add(index)
    }
  } else {
    const byKey = new Map(findings.map((finding) => [finding.key, finding]))
    for (const key of findingKeys) {
      const finding = byKey.get(key)
      if (!finding) throw new FeatureError("A selected finding is not part of this assessment.")
      if (finding.status !== "Different" && finding.status !== "Missing") throw new FeatureError("Only deviating findings (Different or Missing) can be remediated. Present findings need no change and Review findings need a profile choice first.")
      if (!policies[finding.policyIndex]?.settings[finding.settingIndex]) throw new FeatureError("A selected finding does not match the imported pack.")
      groups.set(finding.policyIndex, [...(groups.get(finding.policyIndex) ?? []), finding])
      policyIndexes.add(finding.policyIndex)
    }
  }
  if (!policyIndexes.size || policyIndexes.size > 25) throw new FeatureError("Select between 1 and 25 benchmark policies.")

  const graph = await deps.graph(tenant)
  requireCisBenchmarksEnabled()
  const items: CisRemediationItem[] = []
  const operations: OperationInput[] = []
  for (const policyIndex of [...policyIndexes].sort((a, b) => a - b)) {
    const policy = policies[policyIndex]!
    if (whole) {
      const body = createdBody(policy, policy.settings, input.reference)
      items.push({ policyIndex, policyName: policy.name, action: "create", targetId: null, targetName: null, findingKeys: [], assignedExposure: false, assignmentCount: 0 })
      operations.push({ folder: type.folder, action: "create", proposed: body, assignments: null, source: { tenantId: null, objectId: null, version: input.reference, label: policy.name } })
      continue
    }
    const selected = groups.get(policyIndex)!
    const settings = selected.map((finding) => policy.settings[finding.settingIndex]!)
    const different = selected.find((finding) => finding.status === "Different" && finding.observed.length)
    const targetId = different?.observed[0]?.policyId ?? null
    if (targetId) {
      if (!isGraphId(targetId)) throw new FeatureError("A selected finding names an invalid tenant policy.")
      requireCisBenchmarksEnabled()
      let live: Item | null
      try { live = await readCurrent(graph, type, targetId) } catch (error) { throw new FeatureError(`A tenant policy could not be read. ${error instanceof Error ? error.message : String(error)}`, 502) }
      if (!live) throw new FeatureError(`The tenant policy of a selected finding no longer exists. Compare again.`, 409)
      const assignments = Array.isArray(live.assignments) ? (live.assignments as Item[]) : []
      items.push({ policyIndex, policyName: policy.name, action: "update", targetId, targetName: String(live[type.nameKey] ?? different!.observed[0]!.policyName), findingKeys: selected.map((finding) => finding.key), assignedExposure: assignments.length > 0, assignmentCount: assignments.length })
      operations.push({ folder: type.folder, action: "update", targetId, proposed: mergedBody(live, policy, settings), assignments: null, source: { tenantId: tenant, objectId: targetId, version: typeof live.lastModifiedDateTime === "string" ? live.lastModifiedDateTime : null, label: policy.name } })
    } else {
      const body = createdBody(policy, settings, input.reference)
      items.push({ policyIndex, policyName: policy.name, action: "create", targetId: null, targetName: null, findingKeys: selected.map((finding) => finding.key), assignedExposure: false, assignmentCount: 0 })
      operations.push({ folder: type.folder, action: "create", proposed: body, assignments: null, source: { tenantId: null, objectId: null, version: input.reference, label: policy.name } })
    }
  }

  const record = deps.records.create<CisRemediationRecord>(DOMAINS.cisRemediations, tenant, {
    title: input.title.trim(), status: "in-review",
    summary: `${items.length} benchmark ${items.length === 1 ? "policy" : "policies"} ready for review. New policies are created unassigned.`,
    tenantId: tenant, reference: input.reference, runId: input.runId ?? null, items, changeSetId: null, rollbackChangeSetId: null,
  }, { actor, reason: "Planned a benchmark deployment" })
  let changeSet: Stored<ChangeSetRecord>
  try {
    requireCisBenchmarksEnabled()
    changeSet = await createChangeSet(deps, tenant, { title: input.title, origin: { workflow: "cis-remediation", recordId: record.id }, sourceVersion: input.reference.slice(0, 2000), operations }, actor)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.records.update<CisRemediationRecord>(DOMAINS.cisRemediations, tenant, record.id, (current) => ({ ...current, status: "blocked", summary: `The change set could not be frozen: ${message}` }), { actor, reason: "Blocked: change set could not be created" })
    throw error
  }
  return deps.records.update<CisRemediationRecord>(DOMAINS.cisRemediations, tenant, record.id, (current) => ({ ...current, changeSetId: changeSet.id }), { actor, reason: "Froze the benchmark deployment into a change set" })!
}

export interface CisRemediationPreview {
  deployment: Stored<CisRemediationRecord>
  changeSet: ChangeSetPreview & { notice: string }
  offlineNotice: string
  unassignedNotice: string
  recompareNotice: string
  /** Per operation: in-place updates keep existing assignments; creates never overwrite a same-name policy. */
  policies: Array<{ key: string; policyName: string; action: "create" | "update"; inPlace: boolean; assignedExposure: boolean; assignmentCount: number; note: string }>
}

export async function previewCisRemediation(deps: FeatureDeps, tenantId: string, id: string): Promise<CisRemediationPreview> {
  requireCisBenchmarksEnabled()
  const deployment = syncCisRemediation(deps, tenantId, id)
  if (!deployment.changeSetId) throw new FeatureError("This benchmark deployment is blocked. Resolve its findings and plan again.", 409)
  const preview = await previewChangeSet(deps, tenantId, deployment.changeSetId)
  requireCisBenchmarksEnabled()
  const policies = preview.operations.map((operation) => {
    const item = deployment.items.find((entry) => entry.policyName && operation.name && (entry.action === operation.action))
    const inPlace = operation.action === "update"
    const matched = deployment.items[preview.operations.indexOf(operation)]
    const assignedExposure = matched?.assignedExposure ?? false
    const assignmentCount = matched?.assignmentCount ?? 0
    void item
    return {
      key: operation.key, policyName: operation.name, action: operation.action as "create" | "update", inPlace,
      assignedExposure, assignmentCount,
      note: inPlace
        ? (assignedExposure ? `Updated in place. This policy has ${assignmentCount} assignment(s); editing it in place keeps that broad exposure. Assignments are not changed by this flow.` : "Updated in place. Assignments are not changed by this flow.")
        : "Created new with no assignments. An existing policy with the same name is never overwritten; the change-set preview warns about same-name policies and approval binds to them.",
    }
  })
  return { deployment, changeSet: { ...preview, notice: `${OFFLINE_PREVIEW_NOTICE} ${preview.notice}` }, offlineNotice: OFFLINE_PREVIEW_NOTICE, unassignedNotice: UNASSIGNED_NOTICE, recompareNotice: RECOMPARE_NOTICE, policies }
}

export async function approveCisRemediation(deps: FeatureDeps, tenantId: string, id: string, input: { contentHash: string; targetFingerprint: string; reviewer?: string | null; note?: string | null }, actor: string | null): Promise<Stored<ChangeSetRecord>> {
  requireCisBenchmarksEnabled()
  const deployment = getCisRemediation(deps, tenantId, id)
  if (!deployment.changeSetId) throw new FeatureError("This benchmark deployment is blocked. Resolve its findings and plan again.", 409)
  return approveChangeSet(deps, tenantId, deployment.changeSetId, input, actor)
}

export async function applyCisRemediation(deps: FeatureDeps, tenantId: string, id: string, input: { contentHash: string; confirmed: boolean }, actor: string | null): Promise<{ deployment: Stored<CisRemediationRecord>; changeSet: Stored<ChangeSetRecord> }> {
  requireCisBenchmarksEnabled()
  const deployment = getCisRemediation(deps, tenantId, id)
  if (!deployment.changeSetId) throw new FeatureError("This benchmark deployment is blocked. Resolve its findings and plan again.", 409)
  // Assignments are never copied in this flow: refuse a frozen change set that would set any.
  const changeSet = getChangeSet(deps, tenantId, deployment.changeSetId)
  if (changeSet.operations.some((operation) => operation.setsAssignments)) throw new FeatureError("This benchmark deployment would set assignments. Plan it again; assignments are never copied in this flow.", 409)
  try {
    const applied = await applyChangeSet(deps, tenantId, deployment.changeSetId, input, actor)
    return { deployment: syncCisRemediationRecord(deps, tenantId, id), changeSet: applied }
  } catch (error) { syncCisRemediationRecord(deps, tenantId, id); throw error }
}

export function cisChangeSet(deps: FeatureDeps, tenantId: string, id: string): Stored<ChangeSetRecord> {
  requireCisBenchmarksEnabled()
  const deployment = getCisRemediation(deps, tenantId, id)
  if (!deployment.changeSetId) throw new FeatureError("This benchmark deployment is blocked and has no change set.", 409)
  return getChangeSet(deps, tenantId, deployment.changeSetId)
}

export function cisRollback(deps: FeatureDeps, tenantId: string, id: string): Stored<ChangeSetRecord> {
  requireCisBenchmarksEnabled()
  const deployment = getCisRemediation(deps, tenantId, id)
  if (!deployment.rollbackChangeSetId) throw new FeatureError("No rollback was created for this benchmark deployment. Preview and create one first.", 409)
  const rollback = getChangeSet(deps, tenantId, deployment.rollbackChangeSetId)
  if (rollback.kind !== "rollback" || rollback.rollbackOf !== deployment.changeSetId) throw new FeatureError("The rollback of this benchmark deployment does not match its change set.", 409)
  return rollback
}

export async function previewCisRollback(deps: FeatureDeps, tenantId: string, id: string): Promise<RollbackPreview & { recompareNotice: string }> {
  const changeSet = cisChangeSet(deps, tenantId, id)
  const preview = await previewRollback(deps, tenantId, changeSet.id)
  return { ...preview, recompareNotice: RECOMPARE_NOTICE }
}

export async function createCisRollback(deps: FeatureDeps, tenantId: string, id: string, input: { title?: string | null; ticket?: string | null }, actor: string | null): Promise<Stored<ChangeSetRecord>> {
  const changeSet = cisChangeSet(deps, tenantId, id)
  const rollback = await createRollbackChangeSet(deps, tenantId, changeSet.id, input, actor)
  deps.records.update<CisRemediationRecord>(DOMAINS.cisRemediations, tenantId, id, (current) => ({ ...current, rollbackChangeSetId: rollback.id }), { actor, reason: "Created a rollback change set" })
  return rollback
}

/** Findings that would close if the tenant now matched the benchmark for the selected keys. Pure helper for re-comparison display. */
export function remediatedKeys(assessment: Assessment, selectedKeys: string[]): string[] {
  const selected = new Set(selectedKeys)
  return assessment.findings.filter((finding) => selected.has(finding.key) && finding.status === "Present").map((finding) => finding.key)
}
