import { AuditEventType, AuditResult, AuditSeverity, type CreateAuditLogInput } from "../../../portal/lib/audit/types"
import type { GraphCall } from "../../../portal/lib/policies/graph-restore"
import { typeForFolder, type IntuneType, type Item } from "../../../shared/intune/registry"
import { isGraphId } from "../../../shared/security"
import { replaceTenantVariables } from "../../../shared/oib/variables"
import { PlanRequired } from "../../../shared/plans"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import { FeatureError } from "../route"
import { withTenantWrite } from "../write-lock"
import { requirePreChangeBackup } from "./backup"
import { createListingMemo, GraphReadError, observe, readBack, readCurrent, sameNameIds, writeOperation, type Observation } from "./graph"
import {
  assignmentTargets,
  combinedFingerprint,
  containsRedaction,
  containsSecret,
  contentHashOf,
  diffConfigurations,
  emptyResult,
  hashOf,
  irreversibleSteps,
  matchesProposed,
  MAX_OPERATIONS,
  operationFingerprint,
  resultSummary,
  sameAssignments,
  sanitizeSnapshot,
  statusFromResults,
  UNSUPPORTED_RECOVERY,
  unsupportedReason,
  type ChangeOperation,
  type ChangeSetContent,
  type ChangeSetRecord,
  type ChangeSetStatus,
  type DependencyRef,
  type DiffEntry,
  type OperationAction,
  type OperationResult,
  type OperationSource,
} from "./model"

/**
 * The internal change-set write engine. Workflows (promotion #145, baseline upgrades #144,
 * standards) create and apply their tenant writes through these functions, so every write
 * gets the same review binding, pre-change backup and capture, journaled writes, read-back
 * and rollback evidence. It has no route or screen of its own; each workflow exposes the
 * review and apply steps of its change sets.
 *
 * Lifecycle: createChangeSet (in-review) -> previewChangeSet -> approveChangeSet (approved,
 * bound to content hash and target fingerprint) -> applyChangeSet (applying -> applied,
 * partial, failed or uncertain; call again to retry) -> previewRollback ->
 * createRollbackChangeSet (a new change set that goes through the same review).
 *
 * Every function takes the target tenant; records live under that tenant, so another tenant's
 * change set is simply not found.
 */

/** Immutable proposal and capture records. Not a listed domain; see the final report. */
export const CONTENT_DOMAIN = DOMAINS.changeSetContent

export interface OperationInput {
  /** Registry folder, for example "ConfigurationPolicies". */
  folder: string
  action: OperationAction
  /** Existing target object for update and delete. */
  targetId?: string | null
  /** Needed for delete when the name should not be read from the tenant; otherwise from `proposed`. */
  name?: string
  /** Full desired configuration for create and update (a snapshot as readObject returns it). */
  proposed?: Item | null
  /**
   * Reviewed, target-resolved assignments to set; null or absent leaves assignments untouched
   * on update and creates the object unassigned.
   */
  assignments?: Item[] | null
  source?: OperationSource | null
}

export interface ApplyInput {
  contentHash: string
  confirmed: boolean
  /**
   * Reasons the dependencies the owning workflow resolved (mapped filters, scope tags,
   * reusable settings, groups) changed since planning; empty when unchanged. Called before the
   * apply is claimed and again after the pre-change backup, right before writing. Any reason
   * marks the change set stale and nothing is written.
   */
  dependencyCheck?: () => Promise<string[]>
}

export interface CreateChangeSetInput {
  title: string
  ticket?: string | null
  origin?: { workflow: string; recordId?: string | null }
  sourceTenantId?: string | null
  sourceVersion?: string | null
  operations: OperationInput[]
  dependencies?: DependencyRef[]
  kind?: "change" | "rollback"
  rollbackOf?: string | null
}

export interface OperationPreview {
  key: string
  folder: string
  action: OperationAction
  name: string
  targetId: string | null
  targetState: "present" | "missing" | "not-applicable"
  fingerprint: string
  diff: DiffEntry[]
  diffTruncated: boolean
  blockers: string[]
  warnings: string[]
  irreversible: string[]
  result: OperationResult
}

export interface ChangeSetPreview {
  id: string
  status: ChangeSetRecord["status"]
  contentHash: string
  targetFingerprint: string
  observedAt: string
  operations: OperationPreview[]
  affectedObjects: Array<{ name: string; id: string | null; action: OperationAction }>
  blockers: string[]
  irreversible: string[]
  unsupportedRecovery: string[]
  /** Whether the stored approval still matches this content and target state. */
  approval: { valid: boolean; reason: string | null }
  notice: string
}

export interface RollbackPreview {
  changeSetId: string
  operations: Array<{ key: string; action: OperationAction; name: string; targetId: string | null; blocked: string | null; warnings: string[]; diff: DiffEntry[] }>
  manual: string[]
  irreversible: string[]
  unsupportedRecovery: string[]
  notice: string
}

const NOTICE = "Applying writes operations one by one. There is no atomic tenant transaction and no guaranteed reversal: a failure leaves earlier operations in place, and rollback is a new reviewed change set."

type Actor = string | null
type Stored_ = Stored<ChangeSetRecord>

// ---------------------------------------------------------------------------------------------
// Reading

/** Every change set of a tenant, newest first. Free on every plan (stored records). */
export function listChangeSets(deps: FeatureDeps, tenantId: string): Stored_[] {
  return deps.records.list<ChangeSetRecord>(DOMAINS.changeSets, tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** One change set of a tenant, or a 404 FeatureError. */
export function getChangeSet(deps: FeatureDeps, tenantId: string, id: string): Stored_ {
  const record = deps.records.get<ChangeSetRecord>(DOMAINS.changeSets, tenantId, id)
  if (!record) throw new FeatureError("This change set does not exist for this tenant.", 404)
  return record
}

function content(deps: FeatureDeps, tenantId: string, id: string): ChangeSetContent {
  const record = deps.records.get<ChangeSetContent>(CONTENT_DOMAIN, tenantId, id)
  if (!record) throw new FeatureError("The frozen content of this change set is missing. Create a new change set.", 409)
  return record
}

function typeOf(folder: string): IntuneType {
  const type = typeForFolder(folder)
  if (!type) throw new FeatureError(`${folder} is not supported.`)
  return type
}

async function reader(deps: FeatureDeps, tenantId: string): Promise<GraphCall> {
  return deps.graph(tenantId)
}

/** Graph failures become plain 502 answers; plan and feature errors pass through. */
function asFeatureError(error: unknown, prefix: string): never {
  if (error instanceof FeatureError || error instanceof PlanRequired) throw error
  const status = error instanceof GraphReadError && error.status === 403 ? 403 : 502
  throw new FeatureError(`${prefix} ${error instanceof Error ? error.message : String(error)}`.trim(), status)
}

// ---------------------------------------------------------------------------------------------
// Creation

function validateAssignments(value: unknown): Item[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length > 200) throw new FeatureError("Assignments must be a list of at most 200 entries.")
  for (const entry of value) {
    const target = (entry as Item | null)?.target
    if (!entry || typeof entry !== "object" || !target || typeof target !== "object" || Array.isArray(target) || typeof (target as Item)["@odata.type"] !== "string") throw new FeatureError("Each assignment needs a target with an @odata.type.")
  }
  return structuredClone(value as Item[])
}

/**
 * Freezes operations into a new change set in review. Reads the target once to name delete
 * targets and to compute the proposed diff; refuses unsupported types and actions, missing
 * update targets and content that still carries redacted values.
 */
export async function createChangeSet(deps: FeatureDeps, tenantId: string, input: CreateChangeSetInput, actor: Actor): Promise<Stored_> {
  const tenant = tenantId.toLowerCase()
  const resolveVariables = input.kind !== "rollback" && ["custom-baseline", "baseline-upgrade", "standard-adoption"].includes(input.origin?.workflow ?? "")
  if (!input.title.trim() || input.title.length > 200) throw new FeatureError("A title of at most 200 characters is required.")
  if (!Array.isArray(input.operations) || !input.operations.length) throw new FeatureError("Select at least one operation.")
  if (input.operations.length > MAX_OPERATIONS) throw new FeatureError(`A change set holds at most ${MAX_OPERATIONS} operations. Split the change.`)
  const graph = await reader(deps, tenant)
  const listings = createListingMemo()
  const operations: ChangeOperation[] = []
  const entries: ChangeSetContent["entries"] = {}
  const seenTargets = new Set<string>()
  for (const [index, operation] of input.operations.entries()) {
    const unsupported = unsupportedReason(operation.folder, operation.action)
    if (unsupported) throw new FeatureError(unsupported)
    const type = typeOf(operation.folder)
    const key = `op-${index + 1}`
    const targetId = operation.action === "create" ? null : operation.targetId ?? null
    if (operation.action !== "create" && !isGraphId(targetId)) throw new FeatureError("Update and delete operations need the target object's ID.")
    if (targetId) {
      if (seenTargets.has(targetId.toLowerCase())) throw new FeatureError("An object appears in more than one operation. Keep one operation per object.")
      seenTargets.add(targetId.toLowerCase())
    }
    const proposed = operation.action === "delete" ? null : operation.proposed ?? null
    if (operation.action !== "delete") {
      if (!proposed || typeof proposed !== "object" || Array.isArray(proposed)) throw new FeatureError("Create and update operations need the proposed configuration.")
      if (containsRedaction(proposed)) throw new FeatureError("The proposed configuration contains redacted values and cannot be written.")
      if (containsSecret(proposed)) throw new FeatureError("The proposed configuration contains a secret value Intune masks. Secrets are never copied or written back; set them in Intune.")
    }
    const assignments = operation.action === "delete" ? null : validateAssignments(operation.assignments)
    // Freeze the target's values before review so writes, retries and read-back agree.
    const body = proposed ? (() => { const { assignments: _a, ...rest } = structuredClone(proposed); return resolveVariables ? replaceTenantVariables(rest as Item, tenant) : rest as Item })() : null
    let observed: Observation
    try {
      observed = await observe(graph, type, { action: operation.action, targetId, name: String(body?.[type.nameKey] ?? operation.name ?? "") }, listings)
    } catch (error) {
      asFeatureError(error, "The target tenant could not be read.")
    }
    if (operation.action !== "create" && !observed.snapshot) throw new FeatureError(`The target object of operation ${index + 1} does not exist in this tenant.`, 409)
    const name = String(body?.[type.nameKey] ?? observed.snapshot?.[type.nameKey] ?? operation.name ?? "").trim()
    if (!name) throw new FeatureError("Every operation needs an object name.")
    const diff = diffConfigurations(type, operation.action === "create" ? null : observed.snapshot, body)
    operations.push({
      key,
      folder: type.folder,
      action: operation.action,
      targetId,
      name: name.slice(0, 300),
      source: operation.source ?? null,
      proposedHash: body ? hashOf(body) : null,
      setsAssignments: assignments !== null,
      assignmentsHash: assignments ? hashOf(assignments) : null,
      diff: diff.entries,
      diffTruncated: diff.truncated,
    })
    entries[key] = { body, assignments }
  }
  const proposal = deps.records.create<ChangeSetContent>(CONTENT_DOMAIN, tenant, { title: input.title, status: "frozen", summary: "Frozen proposal of a change set.", kind: "proposal", changeSetId: null, entries }, { actor, reason: "Froze the proposed content" })
  const base: Omit<ChangeSetRecord, "contentHash"> = {
    title: input.title.trim(),
    status: "in-review",
    summary: `${operations.length} operation${operations.length === 1 ? "" : "s"} waiting for review.`,
    kind: input.kind ?? "change",
    origin: { workflow: input.origin?.workflow ?? "change-sets", recordId: input.origin?.recordId ?? null },
    targetTenantId: tenant,
    sourceTenantId: input.sourceTenantId?.toLowerCase() ?? null,
    sourceVersion: input.sourceVersion ?? null,
    ticket: input.ticket?.trim() || null,
    operations,
    dependencies: input.dependencies ?? [],
    proposalId: proposal.id,
    review: null,
    preChange: null,
    results: Object.fromEntries(operations.map((operation) => [operation.key, emptyResult()])),
    rollbackOf: input.rollbackOf ?? null,
    attempts: 0,
    lastError: null,
  }
  return deps.records.create<ChangeSetRecord>(DOMAINS.changeSets, tenant, { ...base, contentHash: contentHashOf(base) }, { actor, reason: input.kind === "rollback" ? "Created a rollback change set for review" : "Created a change set for review" })
}

/**
 * Removes operations before apply. The content changes, so the content hash changes and any
 * approval is dropped: a fresh review is required.
 */
export async function reviseChangeSet(deps: FeatureDeps, tenantId: string, id: string, removeKeys: string[], actor: Actor): Promise<Stored_> {
  const record = getChangeSet(deps, tenantId, id)
  if (!["in-review", "approved", "stale", "rejected"].includes(record.status)) throw new FeatureError("Only change sets that were not applied can be revised.", 409)
  const operations = record.operations.filter((operation) => !removeKeys.includes(operation.key))
  if (operations.length === record.operations.length) throw new FeatureError("Select operations to remove.")
  if (!operations.length) throw new FeatureError("A change set keeps at least one operation. Reject it instead.")
  const previous = content(deps, tenantId, record.proposalId)
  const entries = Object.fromEntries(operations.map((operation) => [operation.key, previous.entries[operation.key] ?? { body: null, assignments: null }]))
  const proposal = deps.records.create<ChangeSetContent>(CONTENT_DOMAIN, tenantId, { title: record.title, status: "frozen", summary: "Frozen proposal of a revised change set.", kind: "proposal", changeSetId: record.id, entries }, { actor, reason: "Froze the revised content" })
  return deps.records.update<ChangeSetRecord>(DOMAINS.changeSets, tenantId, id, (current) => {
    const next = { ...current, operations, proposalId: proposal.id, review: null, status: "in-review" as const, results: Object.fromEntries(operations.map((operation) => [operation.key, current.results[operation.key] ?? emptyResult()])), summary: "Revised; waiting for a fresh review." }
    return { ...next, contentHash: contentHashOf(next) }
  }, { actor, reason: `Removed ${removeKeys.length} operation(s); approval cleared` })!
}

// ---------------------------------------------------------------------------------------------
// Review

/** Checks that stored operations and content still hash to what was frozen. */
function integrity(deps: FeatureDeps, tenantId: string, record: ChangeSetRecord): { entries: ChangeSetContent["entries"]; problem: string | null } {
  let entries: ChangeSetContent["entries"]
  try {
    entries = content(deps, tenantId, record.proposalId).entries
  } catch (error) {
    return { entries: {}, problem: error instanceof Error ? error.message : String(error) }
  }
  if (contentHashOf(record) !== record.contentHash) return { entries, problem: "The stored operations no longer match their content hash." }
  for (const operation of record.operations) {
    const entry = entries[operation.key]
    if (!entry) return { entries, problem: `The frozen content of ${operation.name} is missing.` }
    if ((entry.body ? hashOf(entry.body) : null) !== operation.proposedHash) return { entries, problem: `The frozen content of ${operation.name} changed after it was reviewed.` }
    if ((entry.assignments ? hashOf(entry.assignments) : null) !== operation.assignmentsHash) return { entries, problem: `The reviewed assignments of ${operation.name} changed.` }
  }
  return { entries, problem: null }
}

/**
 * Reads the target now and explains what applying would do: affected objects, fresh diff,
 * blockers, irreversible steps and unsupported recovery areas, with the content hash and
 * target fingerprint an approval must bind to. Never writes.
 */
export async function previewChangeSet(deps: FeatureDeps, tenantId: string, id: string): Promise<ChangeSetPreview> {
  const record = getChangeSet(deps, tenantId, id)
  const { entries, problem } = integrity(deps, tenantId, record)
  const graph = await reader(deps, tenantId)
  const listings = createListingMemo()
  const operations: OperationPreview[] = []
  const fingerprints: Record<string, string> = {}
  for (const operation of record.operations) {
    const type = typeOf(operation.folder)
    const blockers: string[] = []
    const warnings: string[] = []
    let observed: Observation
    try {
      observed = await observe(graph, type, operation, listings)
    } catch (error) {
      asFeatureError(error, "The target tenant could not be read.")
    }
    fingerprints[operation.key] = observed.fingerprint
    if (operation.action !== "create" && !observed.snapshot) blockers.push(`${operation.name} no longer exists in the target tenant.`)
    if (operation.action === "create" && observed.sameNameIds.length) warnings.push(`${observed.sameNameIds.length} object(s) named "${operation.name}" already exist; this creates another one.`)
    if (observed.redacted && operation.action !== "create") warnings.push(`${operation.name} holds values Intune masks. They are not stored in the capture, so a rollback of this object is not supported.`)
    const body = entries[operation.key]?.body ?? null
    const diff = operation.action === "update" && observed.snapshot && body ? diffConfigurations(type, observed.snapshot, body) : { entries: operation.diff, truncated: operation.diffTruncated }
    operations.push({
      key: operation.key,
      folder: operation.folder,
      action: operation.action,
      name: operation.name,
      targetId: operation.targetId,
      targetState: operation.action === "create" ? "not-applicable" : observed.snapshot ? "present" : "missing",
      fingerprint: observed.fingerprint,
      diff: diff.entries,
      diffTruncated: diff.truncated,
      blockers,
      warnings,
      irreversible: irreversibleSteps(operation),
      result: record.results[operation.key] ?? emptyResult(),
    })
  }
  const blockers = [...(problem ? [problem] : []), ...operations.flatMap((operation) => operation.blockers)]
  const targetFingerprint = combinedFingerprint(fingerprints)
  const review = record.review
  let reason: string | null = null
  if (!review || review.decision !== "approved") reason = "Not approved."
  else if (review.contentHash !== record.contentHash) reason = "The content changed after approval."
  else if (review.targetFingerprint !== targetFingerprint) reason = "The target tenant changed after approval."
  return {
    id: record.id,
    status: record.status,
    contentHash: record.contentHash,
    targetFingerprint,
    observedAt: deps.now().toISOString(),
    operations,
    affectedObjects: record.operations.map((operation) => ({ name: operation.name, id: operation.targetId ?? record.results[operation.key]?.objectId ?? null, action: operation.action })),
    blockers,
    irreversible: operations.flatMap((operation) => operation.irreversible),
    unsupportedRecovery: UNSUPPORTED_RECOVERY,
    approval: { valid: reason === null, reason },
    notice: NOTICE,
  }
}

/**
 * Records an approval bound to the exact content hash and the target fingerprint the
 * reviewer saw in the preview. The target is read again; if it changed since that preview
 * the approval is refused (409) and a fresh preview is needed.
 */
export async function approveChangeSet(deps: FeatureDeps, tenantId: string, id: string, input: { contentHash: string; targetFingerprint: string; reviewer?: string | null; note?: string | null }, actor: Actor): Promise<Stored_> {
  const record = getChangeSet(deps, tenantId, id)
  if (!["in-review", "stale", "approved"].includes(record.status)) throw new FeatureError("Only change sets in review can be approved.", 409)
  const preview = await previewChangeSet(deps, tenantId, id)
  if (preview.blockers.length) throw new FeatureError(`This change set cannot be approved: ${preview.blockers.join(" ")}`, 409)
  if (input.contentHash !== record.contentHash) throw new FeatureError("The change set content differs from what you reviewed. Review it again.", 409)
  if (input.targetFingerprint !== preview.targetFingerprint) throw new FeatureError("The target tenant changed since your preview. Preview again before approving.", 409)
  const at = deps.now().toISOString()
  return deps.records.update<ChangeSetRecord>(DOMAINS.changeSets, tenantId, id, (current) => ({
    ...current,
    status: "approved",
    summary: `Approved by ${input.reviewer?.trim() || actor || "an administrator"}; not applied yet.`,
    review: {
      decision: "approved",
      contentHash: record.contentHash,
      targetFingerprint: preview.targetFingerprint,
      operationFingerprints: Object.fromEntries(preview.operations.map((operation) => [operation.key, operation.fingerprint])),
      observedAt: preview.observedAt,
      reviewer: input.reviewer?.trim() || actor,
      actor,
      note: input.note?.trim() || null,
      decidedAt: at,
    },
  }), { actor, reason: "Approved the reviewed content and target state" })!
}

/** Records a rejection. A rejected change set is never applied. */
export function rejectChangeSet(deps: FeatureDeps, tenantId: string, id: string, input: { reviewer?: string | null; note?: string | null }, actor: Actor): Stored_ {
  const record = getChangeSet(deps, tenantId, id)
  if (!["in-review", "stale", "approved"].includes(record.status)) throw new FeatureError("Only change sets that were not applied can be rejected.", 409)
  const at = deps.now().toISOString()
  return deps.records.update<ChangeSetRecord>(DOMAINS.changeSets, tenantId, id, (current) => ({
    ...current,
    status: "rejected",
    summary: `Rejected by ${input.reviewer?.trim() || actor || "an administrator"}.`,
    review: { decision: "rejected", contentHash: current.contentHash, targetFingerprint: "", operationFingerprints: {}, observedAt: at, reviewer: input.reviewer?.trim() || actor, actor, note: input.note?.trim() || null, decidedAt: at },
  }), { actor, reason: "Rejected" })!
}

// ---------------------------------------------------------------------------------------------
// Apply

function markStale(deps: FeatureDeps, tenantId: string, id: string, reason: string, actor: Actor): never {
  deps.records.update<ChangeSetRecord>(DOMAINS.changeSets, tenantId, id, (current) => ({ ...current, status: current.preChange ? current.status : "stale", review: current.preChange ? current.review : null, lastError: reason, summary: `${reason} A fresh review is required.` }), { actor, reason: `Approval invalidated: ${reason}` })
  throw new FeatureError(`${reason} A fresh review is required before anything is written.`, 409)
}

/**
 * One audit entry per claimed apply attempt, with the origin workflow and the operation
 * counts, like the OpenIntuneBaseline recorder. A rollback is a change set of its own, so
 * its apply is recorded as a rollback. Recording never changes the apply outcome: a failed
 * audit write is logged and the result stands (the audit route queues the event for retry).
 */
async function recordApplyAudit(deps: FeatureDeps, tenant: string, record: Stored_, status: ChangeSetStatus, actor: Actor, errorMessage?: string, attempt?: number): Promise<void> {
  try {
    const results = record.operations.map((operation) => ({ operation, result: record.results[operation.key] ?? emptyResult() }))
    const count = (statuses: OperationResult["status"][]) => results.filter((entry) => statuses.includes(entry.result.status)).length
    const verifiedBy = (action: OperationAction) => results.filter((entry) => entry.operation.action === action && entry.result.status === "verified").length
    const rollback = record.kind === "rollback"
    const account = deps.actor(tenant)
    const logEntry: CreateAuditLogInput = {
      eventType: rollback ? AuditEventType.CHANGE_SET_ROLLED_BACK : AuditEventType.CHANGE_SET_APPLIED,
      action: rollback ? "Roll back change set" : "Apply change set",
      resource: { type: "policy", id: record.id, name: record.title },
      result: status === "applied" ? AuditResult.SUCCESS : status === "failed" ? AuditResult.FAILURE : AuditResult.PARTIAL,
      severity: status === "applied" ? AuditSeverity.INFO : status === "failed" ? AuditSeverity.ERROR : AuditSeverity.WARNING,
      details: {
        source: "desktop-change-sets",
        workflow: record.origin.workflow,
        originRecordId: record.origin.recordId,
        changeSetId: record.id,
        kind: record.kind,
        rollbackOf: record.rollbackOf,
        status,
        attempt,
        operations: results.length,
        verified: count(["verified"]),
        failed: count(["failed"]),
        uncertain: count(["uncertain", "writing"]),
        pending: count(["pending"]),
        created: verifiedBy("create"),
        updated: verifiedBy("update"),
        deleted: verifiedBy("delete"),
        backupFolder: record.preChange?.backupFolder,
        error: errorMessage ? { code: "CHANGE_SET_APPLY_FAILED", message: errorMessage } : undefined,
      },
    }
    const logged = await deps.api("/api/audit/log", tenant, {
      user: { id: account?.id ?? "unknown", email: account?.id ?? "unknown", name: account?.name ?? actor ?? "Unknown user" },
      logEntry,
    })
    if (!logged.ok) throw new Error(`Audit write failed (${logged.status})`)
  } catch (error) {
    console.error("[audit] Failed to record change set apply:", error)
  }
}

function saveResult(deps: FeatureDeps, tenantId: string, id: string, key: string, result: OperationResult, actor: Actor, reason: string): void {
  deps.records.update<ChangeSetRecord>(DOMAINS.changeSets, tenantId, id, (current) => ({ ...current, results: { ...current.results, [key]: result } }), { actor, reason })
}

type Reconciled = { decision: "verified"; objectId: string; readBack: OperationResult["readBack"] } | { decision: "write" } | { decision: "stop"; status: "failed" | "uncertain"; message: string; objectId: string | null }

/**
 * Settles an operation whose previous write may or may not have happened, by reading live
 * state first. Verified results are recorded without writing again; only an operation whose
 * target still holds the captured pre-change state is written again.
 */
async function reconcile(graph: GraphCall, type: IntuneType, operation: ChangeOperation, result: OperationResult, entry: { body: Item | null; assignments: Item[] | null }, captured: { body: Item | null; sameNameIds: string[] }): Promise<Reconciled> {
  try {
    if (operation.action === "create") {
      let id = result.objectId
      if (!id) {
        const known = new Set(captured.sameNameIds.map((value) => value.toLowerCase()))
        const fresh = (await sameNameIds(graph, type, operation.name)).filter((value) => !known.has(value.toLowerCase()))
        if (!fresh.length) return { decision: "write" }
        if (fresh.length > 1) return { decision: "stop", status: "uncertain", message: `Several new objects named "${operation.name}" exist. Check Intune and remove duplicates before retrying.`, objectId: null }
        id = fresh[0]!
      }
      const live = await readCurrent(graph, type, id)
      if (!live) return { decision: "stop", status: "uncertain", message: "The created object no longer exists. Check Intune before retrying.", objectId: id }
      if (matchesProposed(type, entry.body ?? {}, live) && (entry.assignments === null || sameAssignments(entry.assignments, live.assignments))) return { decision: "verified", objectId: id, readBack: "match" }
      return { decision: "stop", status: "uncertain", message: "An object was created but it does not match the proposed configuration. Review it in Intune.", objectId: id }
    }
    const live = await readCurrent(graph, type, operation.targetId!)
    if (operation.action === "delete") {
      if (!live) return { decision: "verified", objectId: operation.targetId!, readBack: "missing" }
    } else {
      if (!live) return { decision: "stop", status: "failed", message: "The object was deleted after the review. Nothing was written.", objectId: operation.targetId }
      if (matchesProposed(type, entry.body ?? {}, live) && (entry.assignments === null || sameAssignments(entry.assignments, live.assignments))) return { decision: "verified", objectId: operation.targetId!, readBack: "match" }
    }
    const sanitized = sanitizeSnapshot(type, live!).snapshot
    const before = captured.body ? operationFingerprint(operation.action, { snapshot: captured.body, sameNameIds: [] }) : "missing"
    if (operationFingerprint(operation.action, { snapshot: sanitized, sameNameIds: [] }) === before) return { decision: "write" }
    return { decision: "stop", status: "failed", message: "The object changed after the review and holds neither the captured nor the proposed state. Create a fresh review.", objectId: operation.targetId }
  } catch (error) {
    return { decision: "stop", status: "uncertain", message: `Live state could not be read to reconcile: ${error instanceof Error ? error.message : String(error)}`, objectId: result.objectId }
  }
}

/**
 * Applies an approved change set, or retries one that ended partial, failed or uncertain.
 *
 * First attempt: re-reads the target and refuses when the content hash or target fingerprint
 * no longer match the approval; runs a full backup and fails closed; captures and stores the
 * sanitized pre-change state of every affected object; then writes each operation through the
 * journaled Graph caller and reads it back. Retry: never repeats a verified operation,
 * reconciles uncertain ones from live state first, and re-checks the fingerprint of the rest.
 */
export async function applyChangeSet(deps: FeatureDeps, tenantId: string, id: string, input: ApplyInput, actor: Actor): Promise<Stored_> {
  if (input.confirmed !== true) throw new FeatureError("Confirm the change, including its irreversible steps, before applying.")
  const tenant = tenantId.toLowerCase()
  // Set once the apply is claimed; from then on every exit records exactly one audit entry.
  let claimed: Stored_ | null = null
  let claimedAttempt: number | null = null
  let auditRecorded = false
  try {
    return await withTenantWrite(tenant, "Change set apply", async () => {
    const record = getChangeSet(deps, tenant, id)
    if (["in-review", "rejected", "stale"].includes(record.status)) throw new FeatureError("This change set needs an approval of its current content and target state.", 409)
    if (record.status === "applied") throw new FeatureError("This change set was already applied and verified.", 409)
    const review = record.review
    if (!review || review.decision !== "approved") throw new FeatureError("This change set is not approved.", 409)
    if (input.contentHash !== record.contentHash || review.contentHash !== record.contentHash) markStale(deps, tenant, id, "The content changed after approval.", actor)
    const { entries, problem } = integrity(deps, tenant, record)
    if (problem) markStale(deps, tenant, id, problem, actor)
    const staleBefore = (await input.dependencyCheck?.()) ?? []
    if (staleBefore.length) markStale(deps, tenant, id, staleBefore.join(" "), actor)

    // Claim the change set before anything slow, so approve, reject and revise refuse it
    // while the backup runs, and a change made in between is detected instead of overwritten.
    const claimedFrom = record.status
    const claimedRecord = deps.records.update<ChangeSetRecord>(DOMAINS.changeSets, tenant, id, (current) => {
      if (current.status !== claimedFrom || current.contentHash !== record.contentHash || current.review?.decidedAt !== review.decidedAt) throw new FeatureError("The change set changed while the apply started. Review it again.", 409)
      return { ...current, status: "applying", attempts: current.attempts + 1, lastError: null, summary: record.preChange ? "Retrying." : "Backing up before applying." }
    }, { actor, reason: record.preChange ? "Retry started" : "Apply started; running the pre-change backup" })
    claimed = claimedRecord!
    claimedAttempt = claimedRecord!.attempts

    let preChange = record.preChange
    let captured: ChangeSetContent["entries"] = {}
    const capturedNames: Record<string, string[]> = {}
    let graph: GraphCall
    let writer: GraphCall
    let listings = createListingMemo()
    try {
      graph = await reader(deps, tenant)
      // Acquired before anything is marked as applying: a sign-in or plan failure here hands
      // the change set back through the catch below instead of leaving it stuck in "applying".
      writer = await deps.graph(tenant, { journal: true })
      if (!preChange) {
        const check = async () => {
          const observations: Record<string, Observation> = {}
          for (const operation of record.operations) {
            try {
              observations[operation.key] = await observe(graph, typeOf(operation.folder), operation, listings)
            } catch (error) {
              asFeatureError(error, "The target tenant could not be read, so nothing was written.")
            }
            if (observations[operation.key]!.fingerprint !== review.operationFingerprints[operation.key]) markStale(deps, tenant, id, `${operation.name} changed in the target tenant after approval.`, actor)
          }
          return observations
        }
        await check()
        const backupFolder = await requirePreChangeBackup(deps, tenant, [...new Set(record.operations.map((operation) => operation.folder))])
        // The backup takes time: confirm the claim still holds, then re-check dependencies and
        // the target and read the capture that rollback relies on right before writing.
        const latest = getChangeSet(deps, tenant, id)
        if (latest.status !== "applying" || latest.contentHash !== record.contentHash || latest.review?.decidedAt !== review.decidedAt) throw new FeatureError("The change set changed during the backup. Nothing was written; review it again.", 409)
        const staleAfterBackup = (await input.dependencyCheck?.()) ?? []
        if (staleAfterBackup.length) markStale(deps, tenant, id, staleAfterBackup.join(" "), actor)
        listings = createListingMemo()
        const observations = await check()
        captured = Object.fromEntries(record.operations.map((operation) => {
          const observed = observations[operation.key]!
          return [operation.key, { body: observed.snapshot, assignments: observed.snapshot && Array.isArray(observed.snapshot.assignments) ? (observed.snapshot.assignments as Item[]) : null }]
        }))
        const capture = deps.records.create<ChangeSetContent>(CONTENT_DOMAIN, tenant, { title: record.title, status: "frozen", summary: "Pre-change capture of a change set.", kind: "capture", changeSetId: record.id, entries: captured }, { actor, reason: "Captured the pre-change state" })
        preChange = {
          capturedAt: deps.now().toISOString(),
          backupFolder,
          captureId: capture.id,
          objects: record.operations.map((operation) => {
            const observed = observations[operation.key]!
            return { key: operation.key, objectId: operation.targetId, name: operation.name, state: observed.snapshot ? "present" : "absent", redacted: observed.redacted, sameNameIds: observed.sameNameIds }
          }),
        }
      } else {
        captured = content(deps, tenant, preChange.captureId).entries
      }
    } catch (error) {
      // Nothing was written in this attempt: hand the change set back in its previous state.
      const message = error instanceof Error ? error.message : String(error)
      const previous: ChangeSetRecord["status"] = claimedFrom === "applying" ? (record.preChange ? "uncertain" : "approved") : claimedFrom
      deps.records.update<ChangeSetRecord>(DOMAINS.changeSets, tenant, id, (current) => ({ ...current, status: current.status === "applying" ? previous : current.status, lastError: message, summary: current.status === "applying" ? `Not applied: ${message}` : current.summary }), { actor, reason: `Apply stopped before writing: ${message}` })
      auditRecorded = true
      await recordApplyAudit(deps, tenant, record, "failed", actor, message, claimedAttempt!)
      throw error
    }
    for (const object of preChange.objects) capturedNames[object.key] = object.sameNameIds
    const firstAttempt = !record.preChange
    const change = preChange
    deps.records.update<ChangeSetRecord>(DOMAINS.changeSets, tenant, id, (current) => ({ ...current, status: "applying", preChange: change, lastError: null, summary: "Applying." }), { actor, reason: firstAttempt ? "Backup succeeded and pre-change state captured; applying" : "Retrying; reconciling earlier outcomes first" })

    for (const operation of record.operations) {
      const type = typeOf(operation.folder)
      const current = getChangeSet(deps, tenant, id).results[operation.key] ?? emptyResult()
      if (current.status === "verified") continue
      const entry = entries[operation.key]!
      const at = () => deps.now().toISOString()
      if (current.status === "uncertain" || current.status === "writing") {
        const settled = await reconcile(graph, type, operation, current, entry, { body: captured[operation.key]?.body ?? null, sameNameIds: capturedNames[operation.key] ?? [] })
        if (settled.decision === "verified") {
          saveResult(deps, tenant, id, operation.key, { ...current, status: "verified", objectId: settled.objectId, readBack: settled.readBack, message: "Reconciled from live state; not written again.", at: at() }, actor, `Reconciled ${operation.name}: verified without a repeat write`)
          continue
        }
        if (settled.decision === "stop") {
          saveResult(deps, tenant, id, operation.key, { ...current, status: settled.status, objectId: settled.objectId, message: settled.message, at: at() }, actor, `Reconciled ${operation.name}: ${settled.status}`)
          continue
        }
      } else if (!firstAttempt) {
        let observed: Observation | null = null
        try {
          observed = await observe(graph, type, operation)
        } catch (error) {
          saveResult(deps, tenant, id, operation.key, { ...current, status: current.status, message: `The target could not be read before retrying: ${error instanceof Error ? error.message : String(error)}`, at: at() }, actor, `Could not re-check ${operation.name}`)
          continue
        }
        if (observed.fingerprint !== review.operationFingerprints[operation.key]) {
          saveResult(deps, tenant, id, operation.key, { ...current, status: "failed", message: "The object changed after approval. Nothing was written; create a fresh review.", at: at() }, actor, `${operation.name} changed after approval`)
          continue
        }
      }
      const attempt: OperationResult = { ...current, status: "writing", attempts: current.attempts + 1, message: null, readBack: null, at: at() }
      saveResult(deps, tenant, id, operation.key, attempt, actor, `Writing ${operation.name}`)
      const outcome = await writeOperation(writer, type, { action: operation.action, targetId: operation.targetId, proposed: entry.body, assignments: entry.assignments, current: captured[operation.key]?.body ?? null }, (createdId) => {
        saveResult(deps, tenant, id, operation.key, { ...attempt, objectId: createdId }, actor, `Created ${operation.name}`)
      })
      if (outcome.state === "rejected") {
        saveResult(deps, tenant, id, operation.key, { ...attempt, status: "failed", objectId: outcome.objectId, message: `Microsoft Graph rejected the write; nothing was changed. ${outcome.message}`, at: at() }, actor, `${operation.name} was rejected`)
        continue
      }
      if (outcome.state === "unknown") {
        saveResult(deps, tenant, id, operation.key, { ...attempt, status: "uncertain", objectId: outcome.objectId, message: `${outcome.message} Retry reconciles from live state before writing again.`, at: at() }, actor, `${operation.name} has an uncertain outcome`)
        continue
      }
      const check = await readBack(graph, type, { action: operation.action, objectId: outcome.objectId, proposed: entry.body, assignments: entry.assignments })
      const status: OperationResult["status"] = check.state === "match" ? "verified" : "uncertain"
      const message = check.state === "match" ? "Written and verified by read-back." : check.state === "denied" ? `Written, but the read-back was denied or failed (${check.message}). The outcome is unverified.` : check.state === "missing" ? "Written, but the object could not be found on read-back." : "Written, but the read-back differs from the proposed configuration."
      saveResult(deps, tenant, id, operation.key, { ...attempt, status, objectId: outcome.objectId, readBack: check.state, message, at: at() }, actor, `${operation.name}: ${status}`)
    }
    const final = getChangeSet(deps, tenant, id)
    const results = final.operations.map((operation) => final.results[operation.key] ?? emptyResult())
    const status = statusFromResults(results)
    const updated = deps.records.update<ChangeSetRecord>(DOMAINS.changeSets, tenant, id, (current) => ({ ...current, status, summary: resultSummary(results) }), { actor, reason: `Apply finished: ${status}` })!
    auditRecorded = true
    await recordApplyAudit(deps, tenant, updated, status, actor, undefined, claimedAttempt!)
    return updated
    })
  } catch (error) {
    // A throw from the write loop or the final update: writes may have happened, so the
    // claimed attempt still gets its failure entry, with the results recorded so far.
    if (claimed && !auditRecorded) {
      let latest: Stored_ = claimed
      try { latest = getChangeSet(deps, tenant, id) } catch { /* keep the claimed snapshot */ }
      await recordApplyAudit(deps, tenant, latest, "failed", actor, error instanceof Error ? error.message : String(error), claimedAttempt!)
    }
    throw error
  }
}

// ---------------------------------------------------------------------------------------------
// Rollback

function inverseOperations(deps: FeatureDeps, tenantId: string, record: ChangeSetRecord): { inputs: Array<OperationInput & { key: string; blocked: string | null; warnings: string[] }>; manual: string[] } {
  if (!record.preChange) throw new FeatureError("This change set was never applied, so there is nothing to roll back.", 409)
  const captured = content(deps, tenantId, record.preChange.captureId).entries
  const inputs: Array<OperationInput & { key: string; blocked: string | null; warnings: string[] }> = []
  const manual: string[] = []
  for (const operation of record.operations) {
    const result = record.results[operation.key] ?? emptyResult()
    const object = record.preChange.objects.find((entry) => entry.key === operation.key)
    const snapshot = captured[operation.key]?.body ?? null
    if (result.status === "pending" || result.status === "failed") continue
    const warnings = result.status === "verified" ? [] : [`The outcome of "${operation.name}" was ${result.status}; the rollback is based on the captured state and live state is re-read at review.`]
    const source = { tenantId: record.targetTenantId, objectId: operation.targetId, version: record.preChange.capturedAt, label: `Pre-change capture of "${record.title}"` }
    if (operation.action === "create") {
      if (!result.objectId) {
        manual.push(`Check Intune for an object named "${operation.name}" created by this change set; its ID was never returned, so it cannot be removed automatically.`)
        continue
      }
      inputs.push({ key: operation.key, folder: operation.folder, action: "delete", targetId: result.objectId, name: operation.name, source, blocked: null, warnings })
      continue
    }
    const redacted = object?.redacted || containsRedaction(snapshot)
    if (!snapshot) {
      manual.push(`"${operation.name}" did not exist when the change set was applied; nothing was captured for it.`)
      continue
    }
    const blocked = redacted ? `"${operation.name}" holds values Intune masks; they were not stored, so it cannot be written back automatically.` : null
    if (operation.action === "update") {
      inputs.push({ key: operation.key, folder: operation.folder, action: "update", targetId: operation.targetId, proposed: snapshot, assignments: operation.setsAssignments ? assignmentTargets(snapshot.assignments) : null, source, blocked, warnings })
    } else {
      inputs.push({ key: operation.key, folder: operation.folder, action: "create", proposed: snapshot, assignments: null, source, blocked, warnings: [...warnings, `"${operation.name}" is recreated with a new ID and without assignments. Review targeting separately.`] })
      manual.push(`Recreate the assignments of "${operation.name}" after reviewing targeting; the recreated object is unassigned.`)
    }
  }
  return { inputs, manual }
}

/**
 * What rolling back an applied change set would do, based on its captured pre-change state
 * and the live target now. Read only. Rollback is always a new change set with its own
 * review, backup, capture and read-back.
 */
export async function previewRollback(deps: FeatureDeps, tenantId: string, id: string): Promise<RollbackPreview> {
  const record = getChangeSet(deps, tenantId, id)
  const { inputs, manual } = inverseOperations(deps, tenantId, record)
  const graph = await reader(deps, tenantId)
  const operations: RollbackPreview["operations"] = []
  for (const input of inputs) {
    const type = typeOf(input.folder)
    let live: Item | null = null
    const warnings = [...input.warnings]
    try {
      live = input.targetId ? await readCurrent(graph, type, input.targetId) : null
    } catch (error) {
      warnings.push(`The live object could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (input.action !== "create" && input.targetId && !live) warnings.push(`"${input.name}" no longer exists in the tenant.`)
    const diff = input.action === "update" && live && input.proposed ? diffConfigurations(type, sanitizeSnapshot(type, live).snapshot, input.proposed).entries : input.action === "create" && input.proposed ? diffConfigurations(type, null, input.proposed).entries : []
    operations.push({ key: input.key, action: input.action, name: input.name ?? String(input.proposed?.[type.nameKey] ?? ""), targetId: input.targetId ?? null, blocked: input.blocked, warnings, diff })
  }
  return {
    changeSetId: record.id,
    operations,
    manual,
    irreversible: operations.filter((operation) => !operation.blocked).flatMap((operation) => irreversibleSteps({ action: operation.action, name: operation.name, setsAssignments: false })),
    unsupportedRecovery: UNSUPPORTED_RECOVERY,
    notice: "Rollback writes the captured pre-change state back as a new reviewed change set. It is not an atomic transaction and does not guarantee the previous state on devices.",
  }
}

/** Creates the rollback change set (in review) from the captured state; blocked parts are left out and reported. */
export async function createRollbackChangeSet(deps: FeatureDeps, tenantId: string, id: string, input: { title?: string | null; ticket?: string | null }, actor: Actor): Promise<Stored_> {
  const record = getChangeSet(deps, tenantId, id)
  if (record.kind === "rollback") throw new FeatureError("A rollback is itself rolled back by a new reviewed change, not by a rollback of a rollback.", 409)
  if (record.status === "applying") throw new FeatureError("This change set is being applied. Wait for its results before planning a rollback.", 409)
  const open = listChangeSets(deps, tenantId).find((entry) => entry.rollbackOf === record.id && ["in-review", "approved", "stale", "applying"].includes(entry.status))
  if (open) throw new FeatureError(`A rollback of this change set is already open ("${open.title}"). Apply or reject it first.`, 409)
  const { inputs } = inverseOperations(deps, tenantId, record)
  const usable = inputs.filter((entry) => !entry.blocked).map(({ key: _key, blocked: _blocked, warnings: _warnings, ...operation }) => operation)
  if (!usable.length) throw new FeatureError("Nothing in this change set can be rolled back automatically. See the manual steps in the rollback preview.", 409)
  return createChangeSet(deps, tenantId, {
    title: input.title?.trim() || `Rollback of ${record.title}`.slice(0, 200),
    ticket: input.ticket ?? record.ticket,
    origin: { workflow: record.origin.workflow, recordId: record.origin.recordId },
    sourceTenantId: record.targetTenantId,
    sourceVersion: record.preChange?.capturedAt ?? null,
    operations: usable,
    kind: "rollback",
    rollbackOf: record.id,
  }, actor)
}
