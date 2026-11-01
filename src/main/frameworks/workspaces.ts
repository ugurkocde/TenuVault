import type { KeyValueStore } from '../storage/secure-store'
import { parsePolicies, record, type Assessment, type BaselinePolicy } from '../../shared/frameworks/policies'
import { validateRecommendationList, type RecommendationList } from '../../shared/frameworks/cis-manual'
import { validateExceptions, type CisException } from '../../shared/frameworks/cis-exceptions'
import { packLevels } from '../../shared/frameworks/cis-readiness'
import { HISTORY_FULL_MESSAGE, KEEP_NEWEST_ASSESSMENTS, MAX_WORKSPACE_BYTES, MAX_WORKSPACE_HISTORY, WORKSPACE_UNREADABLE_MESSAGE, type WorkspaceCapacity } from '../../shared/frameworks/workspace-history'

export interface AssessmentRecord {
  assessment: Assessment
  policies: BaselinePolicy[]
  creation?: { success: boolean; results: { name: string; id?: string; error?: string }[] }
}
export interface FrameworkWorkspace {
  version: 1
  tenantId: string
  frameworkId: string
  policies: BaselinePolicy[]
  reference: string
  updatedAt: string
  history: AssessmentRecord[]
  recommendationList?: RecommendationList
  /** Lists downloaded with delivered packs, one per benchmark, version and Level, held once and never copied into history. */
  recommendationLists?: RecommendationList[]
  exceptions?: CisException[]
}
/** A workspace as the framework service returns it, with how full its history is. */
export type WorkspaceView = FrameworkWorkspace & { capacity: WorkspaceCapacity }
const memory = new Map<string, string>()
let store: KeyValueStore = { get: key => memory.get(key) ?? null, set: (key, value) => { memory.set(key, value) }, delete: key => { memory.delete(key) } }
export function setFrameworkStore(value: KeyValueStore): void { store = value }
function key(tenant: string, framework: string): string {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(tenant) || !/^[a-z0-9-]+$/.test(framework)) throw new Error('Invalid workspace identity')
  return `framework.workspace.${tenant.toLowerCase()}.${framework}`
}
export function loadWorkspace(tenant: string, framework: string): FrameworkWorkspace {
  const data = store.get(key(tenant, framework))
  if (!data) return { version: 1, tenantId: tenant.toLowerCase(), frameworkId: framework, policies: [], reference: '', updatedAt: '', history: [] }
  let workspace: FrameworkWorkspace
  try {
    const value: unknown = JSON.parse(data)
    if (!record(value) || value.version !== 1 || value.tenantId !== tenant.toLowerCase() || value.frameworkId !== framework || typeof value.reference !== "string" || typeof value.updatedAt !== "string" || !Array.isArray(value.policies) || !Array.isArray(value.history) || value.history.length > MAX_WORKSPACE_HISTORY) throw new Error()
    const storedList = value.recommendationList !== undefined ? validateRecommendationList(value.recommendationList) : undefined
    if (value.recommendationLists !== undefined && !Array.isArray(value.recommendationLists)) throw new Error()
    const storedLists = Array.isArray(value.recommendationLists) ? value.recommendationLists.map(list => validateRecommendationList(list)) : undefined
    const storedExceptions = value.exceptions !== undefined ? validateExceptions(value.exceptions) : undefined
    // Stored policies reparse under the workspace limit saveWorkspace enforced, not the
    // smaller import limit, so a saved workspace can never become unreadable by size.
    const policies = value.policies.length ? parsePolicies(value.policies, { maxBytes: MAX_WORKSPACE_BYTES }) : []
    for (const entry of value.history) {
      if (!record(entry) || !Array.isArray(entry.policies) || !record(entry.assessment)) throw new Error()
      const pack = entry.policies.length ? parsePolicies(entry.policies, { maxBytes: MAX_WORKSPACE_BYTES }) : []
      const assessment = entry.assessment
      if (assessment.tenantId !== tenant.toLowerCase() || assessment.frameworkId !== framework || typeof assessment.runId !== "string" || typeof assessment.reference !== "string" || typeof assessment.assessedAt !== "string" || !Number.isFinite(Date.parse(assessment.assessedAt)) || typeof assessment.policyCount !== "number" || !Array.isArray(assessment.findings)) throw new Error()
      for (const finding of assessment.findings) {
        if (!record(finding) || typeof finding.key !== "string" || typeof finding.policyName !== "string" || typeof finding.settingId !== "string" || typeof finding.policyIndex !== "number" || typeof finding.settingIndex !== "number" || !Number.isInteger(finding.policyIndex) || !Number.isInteger(finding.settingIndex) || !pack[finding.policyIndex]?.settings[finding.settingIndex] || !["Present", "Missing", "Different", "Review"].includes(String(finding.status)) || !("recommended" in finding) || !Array.isArray(finding.observed) || finding.observed.some(item => !record(item) || typeof item.policyId !== "string" || typeof item.policyName !== "string" || !("value" in item))) throw new Error()
      }
      if (entry.creation !== undefined && (!record(entry.creation) || typeof entry.creation.success !== "boolean" || !Array.isArray(entry.creation.results) || entry.creation.results.some(item => !record(item) || typeof item.name !== "string" || (item.id !== undefined && typeof item.id !== "string") || (item.error !== undefined && typeof item.error !== "string")))) throw new Error()
    }
    workspace = { ...value, policies, ...(storedList ? { recommendationList: storedList } : {}), ...(storedLists?.length ? { recommendationLists: storedLists } : {}), ...(storedExceptions ? { exceptions: storedExceptions } : {}) } as unknown as FrameworkWorkspace
  } catch { throw new Error(WORKSPACE_UNREADABLE_MESSAGE) }

  return workspace
}
/** Delivered recommendation lists a workspace keeps at most, newest last. */
export const MAX_DELIVERED_LISTS = 12

/** Whether a pack reads a delivered list: same benchmark and version, and a Level the pack measures. */
function readsList(policies: BaselinePolicy[], list: RecommendationList): boolean {
  const provenance = (key: string) => policies.map(policy => policy.provenance?.[key]).find(value => typeof value === 'string' && value)
  const levels = packLevels(policies)
  return provenance('benchmark') === list.benchmark && provenance('version') === list.version && list.items.every(item => levels.has(item.level))
}

/**
 * Drops delivered lists that neither the current pack nor a saved assessment reads, then keeps the newest
 * MAX_DELIVERED_LISTS, so lists of benchmarks and versions no longer used never fill the workspace. Called
 * when a delivered pack is saved, the one moment the current pack is known to be the one the list came
 * with; an ordinary save (a draft of other policies) never drops a list.
 */
export function keepReadLists(workspace: FrameworkWorkspace): void {
  if (!workspace.recommendationLists) return
  const packs = [workspace.policies, ...workspace.history.map(entry => entry.policies)]
  const lists = workspace.recommendationLists.filter(list => packs.some(policies => readsList(policies, list))).slice(-MAX_DELIVERED_LISTS)
  if (lists.length) workspace.recommendationLists = lists
  else delete workspace.recommendationLists
}

export function saveWorkspace(workspace: FrameworkWorkspace): void {
  const json = JSON.stringify({ ...workspace, updatedAt: new Date().toISOString() })
  if (json.length > MAX_WORKSPACE_BYTES || workspace.history.length > MAX_WORKSPACE_HISTORY) throw new Error(HISTORY_FULL_MESSAGE)
  store.set(key(workspace.tenantId, workspace.frameworkId), json)
}
/** Whether the next assessment can be saved. The newest saved assessment stands in for its size. */
export function workspaceCapacity(workspace: FrameworkWorkspace): WorkspaceCapacity {
  const count = workspace.history.length
  const base = { count, limit: MAX_WORKSPACE_HISTORY }
  if (count >= MAX_WORKSPACE_HISTORY) return { ...base, full: true, reason: 'count' }
  const next = workspace.history[0] ? JSON.stringify(workspace.history[0]).length + 1 : 0
  if (JSON.stringify(workspace).length + next > MAX_WORKSPACE_BYTES) return { ...base, full: true, reason: 'size' }
  return { ...base, full: false, reason: null }
}
export function workspaceView(workspace: FrameworkWorkspace): WorkspaceView { return { ...workspace, capacity: workspaceCapacity(workspace) } }
/**
 * Removes every saved assessment except the newest `keep`, by assessment date, in one save.
 * Returns the run IDs that were removed.
 */
export function pruneHistory(workspace: FrameworkWorkspace, requestedKeep: number): string[] {
  // The newest assessments are never removed, whatever the caller asks for.
  const keep = Math.max(requestedKeep, KEEP_NEWEST_ASSESSMENTS)
  const newest = new Set(workspace.history.map((entry, index) => ({ index, at: Date.parse(entry.assessment.assessedAt) }))
    .sort((a, b) => b.at - a.at || a.index - b.index).slice(0, keep).map(item => item.index))
  const removed = workspace.history.filter((_, index) => !newest.has(index)).map(entry => entry.assessment.runId)
  if (!removed.length) return []
  workspace.history = workspace.history.filter((_, index) => newest.has(index))
  saveWorkspace(workspace)
  return removed
}
export function deleteWorkspace(tenant: string, framework: string): void { store.delete(key(tenant, framework)) }
export function recordAssessment(assessment: Assessment, policies: BaselinePolicy[]): void {
  const workspace = loadWorkspace(assessment.tenantId, assessment.frameworkId)
  workspace.policies = policies; workspace.reference = assessment.reference
  workspace.history.unshift({ assessment, policies })
  saveWorkspace(workspace)
}
export function recordCreation(assessment: Assessment, creation: NonNullable<AssessmentRecord['creation']>): void {
  const workspace = loadWorkspace(assessment.tenantId, assessment.frameworkId)
  const record = workspace.history.find(item => item.assessment.runId === assessment.runId)
  if (!record) throw new Error('The saved assessment is unavailable')
  record.creation = creation
  saveWorkspace(workspace)
}
