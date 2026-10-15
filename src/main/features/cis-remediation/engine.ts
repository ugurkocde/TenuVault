import { hasChildInstances, parsePolicies, remediationPayload, rootMatches, type Assessment, type BaselinePolicy, type Finding, type Json } from "../../../shared/frameworks/policies"
import { typeForFolder, type Item } from "../../../shared/intune/registry"
import { isGraphId } from "../../../shared/security"
import type { ListedRecord } from "../contracts"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import { FeatureError } from "../route"
import { applyChangeSet, approveChangeSet, createChangeSet, getChangeSet, previewChangeSet, previewRollback, createRollbackChangeSet, type ChangeSetPreview, type OperationInput, type RollbackPreview } from "../change-sets/engine"
import { readCurrent } from "../change-sets/graph"
import { MAX_OPERATIONS, type ChangeSetRecord } from "../change-sets/model"
import { internalCisBenchmarksEnabled } from "../../frameworks/service"
import type { GraphCall } from "../../../portal/lib/policies/graph-restore"

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

/** A listed deployment with the status of its rollback change set, so a list can tell rolled back from pending. */
export type ListedCisRemediation = Omit<Stored<CisRemediationRecord>, "history"> & { rollbackStatus: ChangeSetRecord["status"] | null }

/** Every deployment of a tenant, newest first, without record history. */
export function listCisRemediations(deps: FeatureDeps, tenantId: string): ListedCisRemediation[] {
  requireCisBenchmarksEnabled()
  return deps.records.list<CisRemediationRecord>(DOMAINS.cisRemediations, tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ history: _history, ...record }) => ({
    ...record,
    rollbackStatus: record.rollbackChangeSetId ? deps.records.get<ChangeSetRecord>(DOMAINS.changeSets, tenantId, record.rollbackChangeSetId)?.status ?? null : null,
  }))
}

export function getCisRemediation(deps: FeatureDeps, tenantId: string, id: string): Stored<CisRemediationRecord> {
  requireCisBenchmarksEnabled()
  return loadCisRemediation(deps, tenantId, id)
}

/**
 * Local status bookkeeping after a completed approve, reject, or apply outcome.
 * It performs no tenant or CIS content operation, so it deliberately does not
 * recheck current authorization: revocation after the local outcome must not mask
 * what was already recorded. Public reads use syncCisRemediation below, gated.
 */
export function syncCisRemediationOutcome(deps: FeatureDeps, tenantId: string, id: string): Stored<CisRemediationRecord> {
  const record = loadCisRemediation(deps, tenantId, id)
  if (!record.changeSetId) return record
  const changeSet = deps.records.get<ChangeSetRecord>(DOMAINS.changeSets, tenantId, record.changeSetId)
  if (!changeSet || (changeSet.status === record.status && changeSet.summary === record.summary)) return record
  return deps.records.update<CisRemediationRecord>(DOMAINS.cisRemediations, tenantId, id, (current) => ({ ...current, status: changeSet.status, summary: changeSet.summary }), { actor: null, reason: `Change set is ${changeSet.status}` })!
}

export function syncCisRemediation(deps: FeatureDeps, tenantId: string, id: string): Stored<CisRemediationRecord> {
  requireCisBenchmarksEnabled()
  return syncCisRemediationOutcome(deps, tenantId, id)
}

function settingIdOf(setting: unknown): string | null {
  const instance = (setting as Item | null)?.settingInstance as Item | undefined
  return typeof instance?.settingDefinitionId === "string" ? instance.settingDefinitionId : null
}

const isRecord = (value: unknown): value is Item => value !== null && typeof value === "object" && !Array.isArray(value)
const definitionOf = (value: unknown): string | null => isRecord(value) && typeof value.settingDefinitionId === "string" ? value.settingDefinitionId : null

/**
 * A pack setting instance written over the live instance of the same definition. Template
 * references of the live instance and its values are kept, because Graph rejects a
 * template-based policy whose settings lose them. With `keepExtra`, used for grouped roots,
 * live child instances the pack does not name are kept too, so a tenant hardened beyond the
 * pack keeps its extra payload keys.
 */
function mergeInstance(pack: Json, live: Json | undefined, keepExtra: boolean): Json {
  if (Array.isArray(pack)) {
    const merged = pack.map((entry, index) => mergeInstance(entry, Array.isArray(live) ? live[index] : undefined, keepExtra))
    // Group collection entries are matched by position, as the comparison does; later live entries stay, in order.
    if (keepExtra && Array.isArray(live) && live.length > pack.length && pack.every((entry) => isRecord(entry) && Array.isArray(entry.children))) merged.push(...live.slice(pack.length).map((entry) => structuredClone(entry)))
    return merged
  }
  if (!isRecord(pack)) return structuredClone(pack)
  const current = isRecord(live) ? live : {}
  const merged: Item = {}
  for (const [key, value] of Object.entries(pack)) {
    merged[key] = key === "children" && Array.isArray(value) ? mergeChildren(value, current.children, keepExtra) : mergeInstance(value, current[key], keepExtra)
  }
  for (const [key, value] of Object.entries(current)) if (key.endsWith("TemplateReference") && value !== null) merged[key] = structuredClone(value)
  return merged
}

function mergeChildren(pack: Json[], live: Json | undefined, keepExtra: boolean): Json[] {
  const current = Array.isArray(live) ? live : []
  const used = new Set<number>()
  const merged = pack.map((child) => {
    const id = definitionOf(child)
    const index = id ? current.findIndex((entry, position) => !used.has(position) && definitionOf(entry) === id) : -1
    if (index < 0) return structuredClone(child)
    used.add(index)
    return mergeInstance(child, current[index], keepExtra)
  })
  if (keepExtra) current.forEach((entry, position) => { if (!used.has(position) && definitionOf(entry)) merged.push(structuredClone(entry)) })
  return merged
}

/** Benchmark settings replaced or inserted into a live policy body, by definition. */
function mergedBody(live: Item, settings: BaselinePolicy["settings"]): Item {
  const body = structuredClone(live)
  const existing = Array.isArray(body.settings) ? [...(body.settings as Item[])] : []
  for (const setting of settings) {
    const id = settingIdOf(setting)
    const index = id ? existing.findIndex((entry) => settingIdOf(entry) === id) : -1
    if (index >= 0) existing[index] = { settingInstance: mergeInstance(setting.settingInstance as Json, existing[index]!.settingInstance as Json, hasChildInstances(setting.settingInstance as Json)) } as Item
    else existing.push(structuredClone(setting) as Item)
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

  // The limit counts change-set operations, which is what MAX_OPERATIONS protects: one create
  // per whole or Missing pack policy, and one in-place update per tenant policy that still
  // differs. Updates are known only after reading the tenant, so the final count is checked
  // again once they are planned.
  const tooMany = (count: number) => new FeatureError(`This selection needs ${count} changes and one deployment holds at most ${MAX_OPERATIONS}. Select fewer findings or policies.`)
  const creates = new Map<number, Finding[]>()
  const updates = new Map<string, Finding[]>()
  const policyIndexes = new Set<number>()
  if (whole) {
    for (const index of input.selectedPolicyIndexes!) {
      if (!Number.isInteger(index) || !policies[index]) throw new FeatureError("A selected benchmark policy does not exist in the imported pack.")
      policyIndexes.add(index)
    }
    if (policyIndexes.size > MAX_OPERATIONS) throw tooMany(policyIndexes.size)
  } else {
    const byKey = new Map(findings.map((finding) => [finding.key, finding]))
    for (const key of findingKeys) {
      const finding = byKey.get(key)
      if (!finding) throw new FeatureError("A selected finding is not part of this assessment.")
      if (finding.status !== "Different" && finding.status !== "Missing") throw new FeatureError("Only deviating findings (Different or Missing) can be remediated. Present findings need no change and Review findings need a profile choice first.")
      if (!policies[finding.policyIndex]?.settings[finding.settingIndex]) throw new FeatureError("A selected finding does not match the imported pack.")
      const observed = finding.status === "Different" ? [...new Set(finding.observed.map((observation) => observation.policyId))] : []
      // Missing settings, and a Different finding with no observation, go into the new policy of their pack policy.
      if (!observed.length) creates.set(finding.policyIndex, [...(creates.get(finding.policyIndex) ?? []), finding])
      for (const policyId of observed) {
        if (!isGraphId(policyId)) throw new FeatureError("A selected finding names an invalid tenant policy.")
        updates.set(policyId, [...(updates.get(policyId) ?? []), finding])
      }
    }
    if (creates.size > MAX_OPERATIONS) throw tooMany(creates.size)
  }

  const rawGraph = await deps.graph(tenant)
  requireCisBenchmarksEnabled()
  const graph: GraphCall = async (method, path, body, callOptions) => {
    requireCisBenchmarksEnabled()
    return rawGraph(method, path, body, {
      ...callOptions,
      beforeAttempt: () => {
        callOptions?.beforeAttempt?.()
        requireCisBenchmarksEnabled()
      },
    })
  }
  const planned: Array<{ item: CisRemediationItem; operation: OperationInput }> = []
  const create = (policyIndex: number, selected: Finding[]) => {
    const policy = policies[policyIndex]!
    const body = createdBody(policy, whole ? policy.settings : selected.map((finding) => policy.settings[finding.settingIndex]!), input.reference)
    planned.push({
      item: { policyIndex, policyName: policy.name, action: "create", targetId: null, targetName: null, findingKeys: selected.map((finding) => finding.key), assignedExposure: false, assignmentCount: 0 },
      operation: { folder: type.folder, action: "create", proposed: body, assignments: null, source: { tenantId: null, objectId: null, version: input.reference, label: policy.name } },
    })
  }
  if (whole) for (const policyIndex of policyIndexes) create(policyIndex, [])
  for (const [policyIndex, selected] of creates) create(policyIndex, selected)
  // Every tenant policy holding a selected Different setting with another value is updated,
  // so conflicting policies converge. A policy already holding the recommended value is left alone.
  for (const [targetId, candidates] of updates) {
    requireCisBenchmarksEnabled()
    let live: Item | null
    try { live = await readCurrent(graph, type, targetId) } catch (error) { requireCisBenchmarksEnabled(); throw new FeatureError(`A tenant policy could not be read. ${error instanceof Error ? error.message : String(error)}`, 502) }
    requireCisBenchmarksEnabled()
    if (!live) throw new FeatureError(`The tenant policy of a selected finding no longer exists. Compare again.`, 409)
    const liveSettings = Array.isArray(live.settings) ? (live.settings as Item[]) : []
    const selected = candidates.filter((finding) => {
      const recommended = policies[finding.policyIndex]!.settings[finding.settingIndex]!
      const current = liveSettings.find((entry) => settingIdOf(entry) === settingIdOf(recommended))
      if (!current) throw new FeatureError(`The tenant policy ${String(live![type.nameKey] ?? targetId)} no longer holds a selected setting. Compare again.`, 409)
      return !rootMatches(recommended.settingInstance as Json, current.settingInstance as Json)
    })
    if (!selected.length) continue
    const names = [...new Set(selected.map((finding) => policies[finding.policyIndex]!.name))]
    const assignments = Array.isArray(live.assignments) ? (live.assignments as Item[]) : []
    const observedName = selected[0]!.observed.find((observation) => observation.policyId === targetId)?.policyName ?? targetId
    planned.push({
      item: { policyIndex: Math.min(...selected.map((finding) => finding.policyIndex)), policyName: names.join(", "), action: "update", targetId, targetName: String(live[type.nameKey] ?? observedName), findingKeys: selected.map((finding) => finding.key), assignedExposure: assignments.length > 0, assignmentCount: assignments.length },
      operation: { folder: type.folder, action: "update", targetId, proposed: mergedBody(live, selected.map((finding) => policies[finding.policyIndex]!.settings[finding.settingIndex]!)), assignments: null, source: { tenantId: tenant, objectId: targetId, version: typeof live.lastModifiedDateTime === "string" ? live.lastModifiedDateTime : null, label: names.join(", ").slice(0, 200) } },
    })
  }
  if (!planned.length) throw new FeatureError("The selected findings already match the benchmark in the tenant. Compare again to refresh the results.", 409)
  if (planned.length > MAX_OPERATIONS) throw tooMany(planned.length)
  planned.sort((a, b) => a.item.policyIndex - b.item.policyIndex || (a.item.action === b.item.action ? 0 : a.item.action === "update" ? -1 : 1))
  const items = planned.map((entry) => entry.item)
  const operations = planned.map((entry) => entry.operation)

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
    return { deployment: syncCisRemediationOutcome(deps, tenantId, id), changeSet: applied }
  } catch (error) { syncCisRemediationOutcome(deps, tenantId, id); throw error }
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
