import type { KeyValueStore, SecureStore } from "../../../main/storage/secure-store"
import { WRITE_APPROVAL_LIFETIME, type WriteApprovalTarget } from "../../../shared/write-approvals"
import { withWriteCheckpoint, sameObservation } from "../../../main/write-approvals/dispatch"
import { hasWriteApproval, WriteApprovalError } from "../../../main/write-approvals/service"
import { canonicalJson } from "../../../main/features/change-sets/model"
import { FetchPreconditionError } from "../../../main/api/network-error"
import { approvalSignal, approvalMessage, type ApprovalSignal } from "../../../shared/intune/approval"
import { restoreApprovals, saveRestoreApproval, removeRestoreApproval, type RestoreApproval, type ApprovalStep } from "../../../main/storage/restore-approvals"
import { parseDependencyMappings } from "../../../shared/intune/recovery"
import { dependencyReferences, type DependencyReference } from "../../../shared/intune/dependencies"
import { createHash, randomUUID } from "node:crypto"
import { cleanAssignment, COMMON_READ_ONLY, typeForFolder, type IntuneType, type Item, type Json, type Step } from "../../../shared/intune/registry"

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
import { buildRestorePlan, buildUpdatePlan, NotRestorableError, resolveStep, restoreBlocker, type RestorePlan } from "../../../shared/intune/restore-plan"
import { assignmentsUnread, locateObject, readObject, type GraphReader } from "../../../shared/intune/read"
import { comparableSnapshot, sameSnapshot } from "../../../shared/intune/compare"
import { saveWrite, removeWrite, writeKey, writeRecords } from "../../../main/storage/restore-journal"
import { moduleForFolder, restorePermissionBlocker, SERVICES_PAGE, type GrantedPermissions } from "../../../shared/services/modules"
import { TENANT_ADMIN, adminCenterLink, type AdminLink } from "../../../shared/intune/admin-links"
import { policyReferences, referenceLabel, referencePath, TENANT_KINDS, uncheckedReferencesWarning, type PolicyReference } from "../../../shared/intune/conditional-access"

/** A read that failed because the object no longer exists. */
class Gone extends Error {}

/**
 * Sends restore plans to Microsoft Graph.
 *
 * "copy" creates a [Restored] copy next to the current object. "replace" updates the object when it
 * still exists, or recreates it under its original name. Objects recreated with a new ID are
 * remembered, so later snapshots in the same restore that reference them point to the new ID.
 */

export type RestoreMode = "copy" | "replace"

export interface RestoreOptions {
  approvalContext?: { tenantId: string; requesterId: string; requesterName?: string; justification?: string }
  writeApprovalTenant?: string
  mode: RestoreMode
  /** Stable tenant/source binding for repair requests across API calls. */
  repairScope?: string
  assignments: boolean
  /** Name prefix for copies; "[Restored]" unless given. An empty string keeps the original name. */
  prefix?: string
  /**
   * The snapshot comes from another tenant: scope tags go back to Default and assignments are
   * never copied, because those IDs only exist in the source tenant.
   */
  crossTenant?: boolean
  /**
   * Replace mode only: false leaves an object that no longer exists live deleted and reports it as
   * missing instead of creating a new object from the snapshot. Defaults to true.
   */
  recreateMissing?: boolean
  /**
   * The permissions in the token the writes use (see shared/services/token). A service module whose
   * restore permission is missing is reported before any write. Unknown permissions block nothing.
   */
  granted?: GrantedPermissions
}

export interface RestoreOutcome {
  approval?: ApprovalSignal
  approvalId?: string
  approvalState?: "required" | "submitted"
  success: boolean
  path: string
  policyId?: string
  policyName?: string
  /** unchanged: replace in place found the object already matching the backup and left it alone. */
  action?: "created" | "updated" | "skipped" | "unchanged"
  error?: string
  warnings?: string[]
  /** False when a write may have completed and blindly repeating it could duplicate data. */
  retryable?: boolean
  partial?: boolean
  repairToken?: string
  intuneApprover?: RestoreApproval["approver"]
  /** Replace with recreateMissing false found the object deleted and left it so. */
  missing?: boolean
  /** Where the admin opens the object that is now in the tenant (Intune or Entra admin center). */
  adminLink?: AdminLink
}

/** Adds the admin center link of the object a restore wrote or found, never of one it refused or left deleted. */
function withAdminLink(path: string, outcome: RestoreOutcome, item: Item): RestoreOutcome {
  if (outcome.approval) return { ...outcome, adminLink: TENANT_ADMIN("multiAdminApproval") }
  if (!outcome.policyId || outcome.action === "skipped" || outcome.missing) return outcome
  const folder = path.split("/")[1] ?? ""
  const named = outcome.policyName ? { ...item, displayName: outcome.policyName, name: outcome.policyName } : item
  const adminLink = adminCenterLink(folder, outcome.policyId, named)
  return adminLink ? { ...outcome, adminLink } : outcome
}

export interface GraphCallOptions {
  /** Checked immediately before every network attempt, including retries and token refresh. */
  beforeAttempt?: () => void
  exactBody?: string
  approvalCode?: string
  justification?: string
  /** Snapshot object ID a creation restores. Recorded in the write journal for later replace runs. */
  sourceId?: string
}

export type GraphCall = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: Item, options?: GraphCallOptions) => Promise<{ status: number; body: Item; approval?: ApprovalSignal }>

const GRAPH = "https://graph.microsoft.com/beta/"
/** Far above any real collection; stops a listing whose continuation links never end. */
const MAX_LIST_PAGES = 5_000

export interface GraphRetryOptions {
  refreshToken?: () => Promise<string>
  tenant?: string
  sleep?: (milliseconds: number) => Promise<void>
  /** Default per-attempt check for calls made through this caller. */
  beforeAttempt?: () => void
}
function matchesCreationFields(expected: Json, actual: Json | undefined): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((entry, index) => matchesCreationFields(entry, actual[index]))
  if (expected && typeof expected === "object") return !!actual && typeof actual === "object" && !Array.isArray(actual) && Object.entries(expected).every(([key, value]) => matchesCreationFields(value, actual[key]))
  return expected === actual
}
export function graphCaller(token: string, fetchImpl: typeof fetch = fetch, options: GraphRetryOptions = {}): GraphCall {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  return async (method, path, body, callOptions = {}) => {
    const beforeAttempt = callOptions.beforeAttempt ?? options.beforeAttempt
    beforeAttempt?.()
    const createsObject = method === "POST" && (path.split("/").length === 2 || path.endsWith("/createInstance"))
    const name = body?.displayName ?? body?.name
    const label = typeof name === "string" ? name.replace(/[\r\n\t]/g, " ").slice(0, 240) : undefined
    const key = options.tenant && method !== "GET" ? writeKey(options.tenant, method, path, body) : undefined
    if (key) {
      const previous = writeRecords().find(entry => entry.key === key)
      if (previous?.state === "uncertain") throw new Error("A previous write has an uncertain outcome. Reconcile it in Settings before retrying.")
      if (previous?.state === "reconciled") {
        if (createsObject) {
          if (!previous.objectId || !label || !/^[a-zA-Z0-9_-]{1,200}$/.test(previous.objectId)) throw new Error("This reconciled creation has no verifiable identity. Complete recovery manually in Intune.")
          const reader = graphCaller(token, fetchImpl, { ...options, tenant: undefined, beforeAttempt })
          let current: { status: number; body: Item }
          if (path.endsWith("/createInstance")) {
            const intent = await readLive(reader, typeForFolder("EndpointSecurityIntents")!, previous.objectId)
            const templateId = path.split("/")[2]
            if (!intent || typeof intent.templateId !== "string" || intent.templateId.toLowerCase() !== templateId?.toLowerCase() || !Array.isArray(intent.settings)) throw new Error("The reconciled intent or its settings could not be verified. No follow-up writes were sent.")
            current = { status: 200, body: { ...intent, settingsDelta: intent.settings } }
          } else current = await reader("GET", `${path}/${encodeURIComponent(previous.objectId)}`)
          const sameId = current.body.id === previous.objectId || (GUID.test(previous.objectId) && typeof current.body.id === "string" && current.body.id.toLowerCase() === previous.objectId.toLowerCase())
          if (current.status !== 200 || !sameId || !matchesCreationFields(body!, current.body)) throw new Error("The reconciled object does not match the original creation request, or its fields cannot be verified. No follow-up writes were sent. Review the ID and complete recovery manually in Intune.")
        }
        // Keep a resumed repair protected from capacity eviction for its full window.
        saveWrite({ ...previous, at: new Date().toISOString() })
        return { status: 200, body: previous.objectId ? { id: previous.objectId } : {} }
      }
    }
    let refreshed = false
    for (let attempt = 0; attempt < 4; attempt++) {
      beforeAttempt?.()
      if (key) saveWrite({ key, tenant: options.tenant!, method, path, at: new Date().toISOString(), state: "uncertain", label, ...(callOptions.sourceId ? { sourceId: callOptions.sourceId } : {}) })
      let response: Response
      try {
        response = await fetchImpl(`${GRAPH}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...(callOptions.approvalCode ? { "x-msft-approval-code": callOptions.approvalCode } : callOptions.justification ? { "x-msft-approval-justification": Buffer.from(callOptions.justification, "utf8").toString("base64") } : {}) },
          body: callOptions.exactBody ?? (body && method !== "DELETE" ? JSON.stringify(body) : undefined),
          signal: AbortSignal.timeout(60_000),
        })
      } catch (error) {
        if (error instanceof FetchPreconditionError) { if (key) removeWrite(key); throw error }
        if (method === "GET" && attempt < 3) { await sleep(1000 * 2 ** attempt); continue }
        throw error
      }
      const text = await response.text()
      let parsed: Item = {}
      try { parsed = text ? JSON.parse(text) as Item : {} } catch { /* An unreadable success remains uncertain. */ }
      const rejected = response.status >= 400 && response.status < 500 && response.status !== 408
      if (key && rejected) removeWrite(key)
      if (response.status === 401 && options.refreshToken && !refreshed && attempt < 3) {
        beforeAttempt?.()
        refreshed = true; token = await options.refreshToken(); continue
      }
      const retry = response.status === 429 || (method === "GET" && [408, 500, 502, 503, 504].includes(response.status))
      if (retry && attempt < 3) {
        const header = response.headers.get("retry-after")
        const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN
        const requested = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : NaN
        const delay = Number.isFinite(requested) ? Math.max(0, requested) : 1000 * 2 ** attempt
        // Do not retry earlier than a server delay that exceeds our bounded retry window.
        if (delay <= 30_000) { await sleep(delay); continue }
      }
      if (key && response.ok && (!createsObject || typeof parsed.id === "string")) saveWrite({ key, tenant: options.tenant!, method, path, at: new Date().toISOString(), state: "complete", label, ...(callOptions.sourceId ? { sourceId: callOptions.sourceId } : {}), ...(typeof parsed.id === "string" ? { objectId: parsed.id } : {}) })
      const approval = approvalSignal(response.status, parsed, response.headers)
      return { status: response.status, body: parsed, ...(approval ? { approval } : {}) }
    }
    throw new Error("Microsoft Graph retry limit reached")
  }
}

const errorMessage = (body: Item, status: number) => {
  const error = body.error as Item | undefined
  const message = typeof error?.message === "string" ? error.message : ""
  // Intune wraps some errors in a JSON string with a Message property.
  try {
    const inner = JSON.parse(message) as { Message?: string }
    if (inner.Message) return inner.Message.split(" - Operation ID")[0]!
  } catch {
    /* plain message */
  }
  return message || `Microsoft Graph returned ${status}`
}

/**
 * The error of a refused write. Entra puts the useful part in innerError.message (for example "1007:
 * Incoming ConditionalAccessPolicy object ... does not match the schema"), and a 403 on an opt-in
 * service usually means the app registration or the admin's role does not cover it.
 */
const writeError = (type: IntuneType, body: Item, status: number) => {
  const entry = moduleForFolder(type.folder)
  let message = errorMessage(body, status)
  if (!entry?.module.optIn) return message
  const inner = ((body.error as Item | undefined)?.innerError as Item | undefined)?.message
  if (typeof inner === "string" && inner && !message.includes(inner)) message = `${message} ${inner}`
  if (status !== 403) return message
  return `Microsoft refused to change ${entry.module.label} (${message}). The TenuVault app registration needs the ${entry.area.restore.map((group) => group.join(" or ")).join(" and ")} permission with admin consent, and your account an admin role that may change it: ${entry.module.roles} ${SERVICES_PAGE} in Settings shows what is missing.`
}

function forOtherTenant(snapshot: Item): Item {
  const copy = structuredClone(snapshot)
  delete copy.assignments
  delete copy.roleAssignments
  if (Array.isArray(copy.roleScopeTagIds)) copy.roleScopeTagIds = ["0"]
  return copy
}

interface Repair {
  expectedCurrent?: Item
  scope: string
  path: string
  type: IntuneType
  id: string
  body: Item
  action: "created" | "updated"
  steps: Step[]
  expires: number
}
const repairs = new Map<string, Repair>()
const repairPrefix = "write-approval.restore-repair."
type RepairStore = KeyValueStore & Pick<SecureStore, "keys">
let repairStore: RepairStore | undefined

export function setApprovedRestoreRepairStore(store: RepairStore | undefined): void { repairStore = store }

function repairFor(id: string): Repair | undefined {
  const memory = repairs.get(id)
  if (memory) return memory
  if (!GUID.test(id)) return undefined
  const raw = repairStore?.get(repairPrefix + id)
  if (!raw) return undefined
  const { folder, ...entry } = JSON.parse(raw) as Omit<Repair, "type"> & { folder: string }
  const type = typeForFolder(folder)
  if (type && entry.expires > Date.now()) return { ...entry, type }
  repairStore?.delete(repairPrefix + id)
  return undefined
}

function saveRepair(id: string, entry: Repair, persist: boolean): void {
  if (persist && repairStore) {
    for (const key of repairStore.keys()) {
      if (key.startsWith(repairPrefix)) repairFor(key.slice(repairPrefix.length))
    }
    const { type, ...record } = entry
    repairStore.set(repairPrefix + id, JSON.stringify({ ...record, folder: type.folder }))
  } else repairs.set(id, entry)
}
function consumeRepair(id: string): void {
  repairs.delete(id)
  if (repairStore?.get(repairPrefix + id)) repairStore.delete(repairPrefix + id)
}

export class DependencyMappingError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

type RestorePlanForItem =
  | { kind: "blocked"; error: string; missing?: boolean }
  | { kind: "unchanged"; id: string; live: Item; recreated?: boolean }
  | { kind: "update"; id: string; live: Item; recreated?: boolean; steps: Step[] }
  | { kind: "create"; plan: RestorePlan }
type PlannedDependency = { creation: string; sourceId: string }
export type RestoreObservation = {
  content: unknown
  target: unknown
  review: WriteApprovalTarget
  creates?: { graphPath: string; sourceId: string }
  usesCreations?: string[]
  verifyCreation?: boolean
  failure?: RestoreOutcome
}

export const LEGACY_CONTINUATION = "This Intune request predates tenant write approval. Withdraw it and submit the restore again."

export class Restorer {
  /** Old object ID to new object ID, for objects recreated during this restore. */
  private readonly remapped = new Map<string, string>()
  private readonly verifiedCreates = new Map<string, { id: string; fingerprint: string }>()
  private readonly reviewed = new Map<string, string>()
  /** Live dependency checks by Graph path, so a shared dependency is read once per restore. */
  private readonly liveDependencies = new Map<string, boolean>()
  private readonly instanceScope = randomUUID()
  private readonly options: Readonly<RestoreOptions>

  constructor(
    private readonly graph: GraphCall,
    options: RestoreOptions,
  ) {
    this.options = { ...options }
    if (options.crossTenant && options.mode !== "copy") throw new Error("Cross-tenant recovery supports copies only")
  }

  async mapDependencies(input: unknown): Promise<void> {
    if (!this.options.crossTenant) throw new Error("Dependency mappings require a cross-tenant copy")
    const mappings = parseDependencyMappings(input)
    for (const mapping of mappings) {
      const type = typeForFolder(mapping.folder)!
      const response = await this.graph("GET", `${type.path}/${encodeURIComponent(mapping.targetId)}`)
      if (response.status !== 200 || typeof response.body.id !== "string" || response.body.id.toLowerCase() !== mapping.targetId.toLowerCase()) throw new DependencyMappingError("A mapped dependency is missing or unreadable in the target tenant", response.status)
    }
    for (const mapping of mappings) this.reviewed.set(mapping.sourceId.toLowerCase(), mapping.targetId)
  }

  async restore(path: string, snapshot: Item, check?: () => Promise<void>, reviewed?: RestoreObservation): Promise<RestoreOutcome> {
    return withAdminLink(path, await this.restoreOnce(path, snapshot, check, reviewed), snapshot)
  }

  private async restoreOnce(path: string, snapshot: Item, check?: () => Promise<void>, reviewed?: RestoreObservation): Promise<RestoreOutcome> {
    const folder = path.split("/")[1] ?? ""
    const type = typeForFolder(folder === "DeviceCompliancePolicies" ? "CompliancePolicies" : folder)
    if (!type) return { success: false, path, error: "This backup file is not an Intune type TenuVault can restore." }
    const unpermitted = restorePermissionBlocker(type.folder, this.options.granted)
    if (unpermitted) return { success: false, path, action: "skipped", retryable: false, error: unpermitted }
    try {
      await check?.()
      const resolveReview = async () => {
        const remaps = new Map<string, string>()
        const [target, dependencies] = reviewed?.target as [unknown, Array<[string, string | null | PlannedDependency]>] ?? [null, []]
        const resolved = await Promise.all(dependencies.map(async ([graphPath, expected]) => {
          if (!expected || typeof expected !== "object") return [graphPath, expected]
          const created = this.verifiedCreates.get(expected.creation)
          if (!created) throw new WriteApprovalError("The approved dependency creation did not finish. Restore that dependency before retrying.")
          const destination = graphPath.slice(0, graphPath.lastIndexOf("/") + 1) + encodeURIComponent(created.id)
          const { status, body } = await this.graph("GET", destination)
          if (status !== 200 || body.id !== created.id || approvalFingerprint(body) !== created.fingerprint) {
            throw new WriteApprovalError("The created dependency changed. Request a new approval.")
          }
          remaps.set(expected.sourceId, created.id)
          return [destination, created.fingerprint]
        }))
        return { remaps, target: [target, resolved.sort(([a], [b]) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)] }
      }
      const bound = reviewed ? await resolveReview() : undefined
      const { source, assignments, unread } = this.restoreSource(type, snapshot, bound?.remaps)
      const withNote = (outcome: RestoreOutcome): RestoreOutcome => unread && outcome.success
        ? { ...outcome, warnings: [...(outcome.warnings ?? []), "Assignments were not restored: this backup was made by an earlier TenuVault version that could not read them. Assign the policy in Intune."] }
        : outcome
      const plan = await this.planRestore(type, snapshot, source, assignments)
      const beforeDispatch = reviewed ? async () => {
        await check?.()
        const latest = await resolveReview()
        const current = await this.approvalObservation(path, snapshot, undefined, undefined, latest.remaps)
        const expected = reviewed.content as [string, Item, RestorePlanForItem, boolean]
        const original = expected[2]
        const remapStep = <T extends { body: Item }>(step: T): T => ({ ...step, body: this.remap(step.body, latest.remaps, false, true) })
        const shape = original.kind === "create" ? { ...original, plan: { ...original.plan, create: remapStep(original.plan.create), steps: original.plan.steps.map(remapStep), assignments: original.plan.assignments.map(remapStep) } }
          : original.kind === "update" ? { ...original, steps: original.steps.map(remapStep) } : original
        const content = [expected[0], expected[1], shape, expected[3]]
        if (canonicalJson(this.approvalContent(path, snapshot, plan, assignments)) !== canonicalJson(content)
          || canonicalJson(current.content) !== canonicalJson(content)
          || canonicalJson(current.target) !== canonicalJson(latest.target)) {
          throw new WriteApprovalError("The destination or restore steps changed after review. Request a new approval.")
        }
      } : check
      const resolvedReview = reviewed && bound ? { ...reviewed, target: bound.target } : undefined
      switch (plan.kind) {
        case "blocked": return { success: false, path, action: "skipped", ...(plan.missing ? { missing: true, retryable: false, policyId: typeof snapshot.id === "string" ? snapshot.id : undefined } : {}), error: plan.error }
        case "unchanged":
        case "update": {
          const { id, live, recreated } = plan
          if (recreated && !reviewed && typeof snapshot.id === "string" && !this.reviewed.has(snapshot.id.toLowerCase())) this.remapped.set(snapshot.id, id)
          if (plan.kind === "unchanged") {
            if (recreated && typeof snapshot.id === "string" && !this.reviewed.has(snapshot.id.toLowerCase())) this.remapped.set(snapshot.id, id)
            const name = type.singleton?.name ?? live[type.nameKey] ?? live.displayName ?? live.name
            return withNote({ success: true, path, policyId: id, policyName: typeof name === "string" ? name : undefined, action: "unchanged" })
          }
          const outcome = await this.update(type, path, source, id, live, plan.steps, beforeDispatch, resolvedReview)
          if (recreated && typeof snapshot.id === "string" && !this.reviewed.has(snapshot.id.toLowerCase())) this.remapped.set(snapshot.id, id)
          return withNote(outcome)
        }
        case "create": return withNote(await this.create(type, path, source, snapshot, plan.plan, beforeDispatch, resolvedReview))
      }
    } catch (error) {
      return { success: false, path, retryable: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private restoreSource(type: IntuneType, snapshot: Item, remaps?: Map<string, string>) {
    const source = this.remap(this.options.crossTenant ? forOtherTenant(snapshot) : snapshot, remaps, true, remaps !== undefined)
    // A backup that could not read the assignments must not clear them.
    const unread = this.options.assignments && !this.options.crossTenant && assignmentsUnread(type, snapshot)
    return { source, unread, assignments: this.options.assignments && !this.options.crossTenant && !unread }
  }

  private async planRestore(type: IntuneType, snapshot: Item, source: Item, assignments: boolean): Promise<RestorePlanForItem> {
    const permission = restorePermissionBlocker(type.folder, this.options.granted)
    if (permission) return { kind: "blocked", error: permission }
    const resolved = await this.resolveTarget(type, snapshot)
    if (resolved) {
      if (this.matches({ ...snapshot, id: resolved.id }, resolved.live, assignments)) return { ...resolved, kind: "unchanged" }
      return { ...resolved, kind: "update", steps: buildUpdatePlan(type, source, resolved.id, { includeAssignments: assignments, current: resolved.live }) }
    }
    if (this.options.mode === "replace" && this.options.recreateMissing === false) return { kind: "blocked", missing: true, error: "The object no longer exists in Intune, so it was not recreated." }
    const blocker = restoreBlocker(type, source)
    if (blocker) return { kind: "blocked", error: blocker }
    return { kind: "create", plan: buildRestorePlan(type, source, {
      prefix: this.options.mode === "copy" ? (this.options.prefix ?? "[Restored]") : undefined, includeAssignments: assignments,
    }) }
  }

  private async resolveTarget(type: IntuneType, snapshot: Item): Promise<{ id: string; live: Item; recreated?: boolean } | undefined> {
    if (this.options.mode !== "replace") return undefined
    if (typeof snapshot.id === "string") {
      const live = await this.current(type, snapshot.id)
      if (live) return { id: snapshot.id, live }
    }
    const located = !this.options.crossTenant && type.locateBy ? await locateLive(this.graph, type, snapshot) : undefined
    if (located && typeof located.id === "string") return { id: located.id, live: located }
    const recreated = typeof snapshot.id === "string" ? await this.recreated(type, snapshot) : undefined
    if (recreated) return { id: recreated.id, live: recreated.object, recreated: true }
    return undefined
  }

  /** Resolve the same destination and verify the write plan that a restore will use. */
  async approvalObservation(path: string, snapshot: Item, repairToken?: string, planned?: Map<string, PlannedDependency>, remaps?: Map<string, string>): Promise<RestoreObservation> {
    if (repairToken) {
      const entry = repairFor(repairToken)
      const failed = (error: string, missing = false): RestoreObservation => ({
        content: [path, repairToken, entry?.id, "unavailable"], target: null,
        review: { name: path, id: entry?.id, verb: "Repair", assignments: [], fields: [], sensitiveFields: [] },
        failure: { success: false, path, policyId: entry?.id, missing, retryable: false, error },
      })
      if (!entry || entry.expires < Date.now() || entry.path !== path || entry.scope !== (this.options.repairScope ?? this.instanceScope)) return failed("The restore repair is unavailable or has expired.")
      try {
        const live = await this.current(entry.type, entry.id)
        if (!live) return failed("The object to repair is missing.", true)
        return { content: [entry.id, entry.steps, entry.expectedCurrent], target: [approvalFingerprint(live), await this.approvalDependencies(entry.type, entry.steps.map(step => step.body))], review: this.reviewTarget(entry.type, live, entry.steps, entry.id) }
      } catch (error) {
        return failed(`The object to repair could not be verified: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const folder = path.split("/")[1] ?? ""
    const type = typeForFolder(folder === "DeviceCompliancePolicies" ? "CompliancePolicies" : folder)
    if (!type) throw new WriteApprovalError("This restore policy type cannot be verified.")
    const { source, assignments } = this.restoreSource(type, snapshot, remaps)
    const plan = await this.planRestore(type, snapshot, source, assignments)
    const steps: Step[] = plan.kind === "create" ? [{ ...plan.plan.create, kind: "content" }, ...plan.plan.steps, ...plan.plan.assignments]
      : plan.kind === "update" ? plan.steps : []
    const dependencies = await this.approvalDependencies(type, steps.map(step => step.body ?? {}), planned)
    const target = plan.kind === "update" || plan.kind === "unchanged" ? [plan.id, approvalFingerprint(plan.live)]
      : plan.kind === "create" ? await this.approvalCreateTarget(type, plan.plan.create.body) : null
    const item = plan.kind === "create" ? plan.plan.create.body : "live" in plan ? plan.live : snapshot
    const sourceId = snapshot.id
    const creates = plan.kind === "create" && typeof sourceId === "string" && GUID.test(sourceId) && !this.reviewed.has(sourceId.toLowerCase())
      ? { graphPath: `${type.path}/${encodeURIComponent(sourceId)}`, sourceId } : undefined
    const usesCreations = dependencies.flatMap(([, dependency]) => dependency && typeof dependency === "object" ? [dependency.creation] : [])
    return { content: this.approvalContent(path, snapshot, plan, assignments), target: [target, dependencies], creates, usesCreations, review: this.reviewTarget(type, item, steps, "id" in plan ? plan.id : undefined) }
  }

  private approvalContent(path: string, snapshot: Item, plan: RestorePlanForItem, assignments: boolean) {
    const shape = "live" in plan ? { ...plan, live: undefined } : plan
    return [path, snapshot, shape, assignments]
  }

  private reviewTarget(type: IntuneType, item: Item, steps: Step[], id?: string): WriteApprovalTarget {
    const name = type.singleton?.name ?? item[type.nameKey] ?? item.displayName ?? item.name
    const fields = new Set<string>()
    const sensitiveFields = new Set<string>()
    const collect = (value: Json) => {
      if (Array.isArray(value)) { value.forEach(collect); return }
      if (!value || typeof value !== "object") return
      for (const [key, child] of Object.entries(value)) {
        if (!key.startsWith("@")) fields.add(key)
        if (/password|secret|token|privatekey|certificate|scriptcontent/i.test(key)
          || (key === "value" && (value.isEncrypted === true || /SecretSettingValue/i.test(String(value["@odata.type"] ?? ""))))) sensitiveFields.add(key)
        collect(child)
      }
    }
    steps.forEach(step => collect(step.body))
    const assignments = steps.filter(step => step.kind === "assignments").map(step => {
      const targets = dependencyReferences(step.body)
        .filter(reference => /groupId|AssignmentFilterId/.test(reference.key)).map(reference => reference.id)
      return `${step.replacesAll ? "Replace assignments" : "Write assignments"}${targets.length ? ` (${[...new Set(targets)].join(", ")})` : ""}`
    })
    return { name: typeof name === "string" ? name : type.label, id, assignments, fields: [...fields].sort(), sensitiveFields: [...sensitiveFields].sort() }
  }

  async pendingApprovalObservation(record: RestoreApproval, action: "submit" | "complete"): Promise<RestoreObservation> {
    if (record.continuationPending && !record.continuationFingerprint) throw new WriteApprovalError(LEGACY_CONTINUATION)
    const type = typeForFolder(record.folder)!
    const { status: _status, approverNote: _note, expiresAt: _expiry, requesterName: _name, approver: _approver, ...step } = record
    let intuneApproval: unknown
    if (action === "complete" && !record.continuationPending) {
      const result = await this.graph("GET", `deviceManagement/operationApprovalRequests/${encodeURIComponent(record.id)}`)
      if (result.status !== 200 || result.body.status !== "approved") throw new WriteApprovalError("Intune must approve this saved step before it can be completed.")
      intuneApproval = [result.body.status, result.body.expirationDateTime, result.body.approver]
    }
    const body = record.step.body ? JSON.parse(record.step.body) as Item : {}
    const target = record.objectId ? await this.current(type, record.objectId) : null
    if (record.objectId && !target) throw new WriteApprovalError("The object for this Intune request is missing.")
    if (record.continuationPending && (!target || record.continuationFingerprint !== approvalFingerprint(target))) {
      throw new WriteApprovalError("The live object no longer matches the verified result of the completed Intune step.")
    }
    if (!record.continuationPending && record.objectId && (!target || record.fingerprint !== approvalFingerprint(target, record.assignments))) {
      throw new WriteApprovalError("The live object changed after the Intune request was saved.")
    }
    const remaining = record.remaining.map(step => ({ ...step, body: step.body ? JSON.parse(step.body) as Item : {} }))
    const steps = record.continuationPending ? remaining : [{ ...record.step, body }, ...remaining]
    const dependencies = await this.approvalDependencies(type, steps.map(step => step.body))
    return {
      content: step, target: [target ? approvalFingerprint(target) : await this.approvalCreateTarget(type, body), dependencies, intuneApproval],
      review: this.reviewTarget(type, target ?? { ...record.source, [type.nameKey]: record.label }, steps, record.objectId),
    }
  }

  private async approvalCreateTarget(type: IntuneType, body: Item): Promise<unknown> {
    const name = body[type.nameKey] ?? body.displayName ?? body.name
    if (type.singleton) throw new WriteApprovalError("The destination singleton could not be verified.")
    const filter = typeof name === "string" ? `?$filter=${encodeURIComponent(`${type.nameKey} eq '${name.replaceAll("'", "''")}'`)}` : ""
    const rows = await liveReader(this.graph).list(type.path + filter)
    return rows.filter(row => {
      const label = row[type.nameKey] ?? row.displayName ?? row.name
      return typeof name !== "string" || typeof label !== "string" || name.toLowerCase() === label.toLowerCase()
    }).map(row => [row.id, approvalFingerprint(row)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  }

  private async approvalDependencies(type: IntuneType, bodies: Item[], planned?: Map<string, PlannedDependency>): Promise<Array<[string, string | null | PlannedDependency]>> {
    const paths = new Set<string>()
    for (const body of bodies) {
      for (const reference of dependencyReferences(body)) {
        const path = this.dependencyPath(reference)
        if (path && !path.includes("{id}")) paths.add(path)
      }
      if (type.folder === "ConditionalAccessPolicies") {
        for (const reference of policyReferences(body)) {
          const path = referencePath(reference)
          if (path) paths.add(path)
        }
      }
    }
    return Promise.all([...paths].sort().map(async path => {
      const prior = planned?.get(path.toLowerCase())
      if (prior) return [path, prior]
      const { status, body } = await this.graph("GET", path)
      if (status === 404) return [path, null]
      if (status !== 200 || typeof body.id !== "string") throw new WriteApprovalError("A destination dependency could not be verified.")
      return [path, approvalFingerprint(body)]
    }))
  }

  /**
   * The object an earlier replace run created for this snapshot after the original was deleted,
   * found through the write journal and verified live by name. Journal entries from other
   * tenants name IDs that do not read back in this tenant, so they fall away on the live read.
   */
  private async recreated(type: IntuneType, snapshot: Item): Promise<{ id: string; object: Item } | undefined> {
    const name = snapshot[type.nameKey] ?? snapshot.displayName ?? snapshot.name
    if (typeof name !== "string" || !name) return undefined
    const label = name.replace(/[\r\n\t]/g, " ").slice(0, 240)
    let records: ReturnType<typeof writeRecords>
    try { records = writeRecords() } catch { return undefined }
    // Only creations recorded for this exact snapshot qualify. A name match alone could bind
    // two different policies that share a display name, and legacy records have no source ID.
    const candidates = records.filter(record =>
      (record.state === "complete" || record.state === "reconciled") && record.method === "POST" &&
      record.sourceId === snapshot.id &&
      typeof record.objectId === "string" && record.objectId && record.objectId !== snapshot.id &&
      (record.path === type.path || record.path.startsWith(`${type.path}/`)) &&
      (!record.label || record.label === label))
    for (const record of candidates.reverse()) {
      // An inconclusive read (anything other than a confirmed deletion, which reads back as
      // undefined) must stop the restore instead of falling through to a duplicate create.
      const object = await this.current(type, record.objectId!)
      if (!object) continue
      const liveName = object[type.nameKey] ?? object.displayName ?? object.name
      if (liveName === name) return { id: record.objectId!, object }
    }
    return undefined
  }

  private async create(type: IntuneType, path: string, source: Item, snapshot: Item, plan: RestorePlan, check?: () => Promise<void>, reviewed?: RestoreObservation): Promise<RestoreOutcome> {
    const bodies = [plan.create, ...plan.steps, ...plan.assignments]
    const unresolved = await this.unresolved(bodies.flatMap(step => dependencyReferences(step.body)))
    if (unresolved.length) return { success: false, path, retryable: false, error: this.options.crossTenant
      ? `Unresolved target dependencies (${unresolved.join(", ")}). Copy the dependencies first or reconcile this object in the target tenant.`
      : `Unresolved dependencies (${unresolved.join(", ")}). Restore the dependencies first or reconcile this object in Intune.` }
    const references = await this.policyReferences(type, plan.create.body)
    if (references.blocking.length) return { success: false, path, action: "skipped", retryable: false, error: references.blocking.join(" ") }
    const send = () => this.graph("POST", plan.create.path, plan.create.body, { sourceId: typeof snapshot.id === "string" ? snapshot.id : undefined })
    const created = check ? await withWriteCheckpoint(check, send) : await send()
    if (created.approval) return this.pauseApproval(type, path, { ...plan.create, kind: "content" }, [...plan.steps, ...plan.assignments], source, "created", created.approval, undefined, undefined, typeof snapshot.id === "string" ? snapshot.id : undefined)
    if (created.status >= 300) return { success: false, path, retryable: created.status < 500 && created.status !== 408, error: writeError(type, created.body, created.status) }
    const id = String(created.body.id ?? "")
    if (!id) return { success: false, path, retryable: false, error: "Microsoft Graph did not return an ID. Check Intune before retrying." }
    const protectedWrite = this.options.writeApprovalTenant && hasWriteApproval(this.options.writeApprovalTenant)
    // Graph may answer with only the ID, so the body sent (with the [Restored] name) fills the gaps.
    const remaining = [...plan.steps, ...plan.assignments]
    let baseline: Item | undefined
    if (protectedWrite && (remaining.length || reviewed?.verifyCreation)) {
      try {
        baseline = await this.verifiedState(type, id, { ...plan.create, kind: "content" }, created.body)
      } catch (error) {
        return { success: false, path, partial: true, policyId: id, action: "created", retryable: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    if (!protectedWrite && typeof snapshot.id === "string" && !this.reviewed.has(snapshot.id.toLowerCase())) this.remapped.set(snapshot.id, id)
    const finish = reviewed?.verifyCreation ? (live: Item) => this.verifiedCreates.set(path, { id, fingerprint: approvalFingerprint(live) }) : undefined
    const outcome = await this.complete(type, path, id, { ...plan.create.body, ...created.body }, "created", remaining, baseline, 1, undefined, reviewed?.target, finish)
    if (protectedWrite && outcome.success && reviewed?.verifyCreation && reviewed.creates) this.remapped.set(reviewed.creates.sourceId, id)
    if (plan.assignments.length && type.assignmentWarning) outcome.warnings = [...(outcome.warnings ?? []), type.assignmentWarning]
    return this.withWarnings(outcome, type, source, plan.create.body, references.warnings)
  }

  /**
   * The payload references that cannot be resolved before a create. A reference is resolved when it
   * points at an object recreated or reviewed in this run. In the same tenant it is also resolved
   * when the referenced object still exists live. References that cannot be read back by ID, such
   * as secret reference values and policy set payloads, and references whose live check could not
   * be completed, keep relying on Graph to validate them on the write.
   */
  private async unresolved(references: DependencyReference[]): Promise<string[]> {
    const resolvedIds = new Set([...this.remapped.values(), ...this.reviewed.values()].map(id => id.toLowerCase()))
    const unresolved = new Set<string>()
    for (const reference of references) {
      if (!reference.id) { unresolved.add(reference.path); continue }
      if (reference.id.includes("{id}") || reference.url?.includes("{id}")) continue
      if (resolvedIds.has(reference.id.toLowerCase())) continue
      if (this.options.crossTenant) { unresolved.add(reference.path); continue }
      const path = this.dependencyPath(reference)
      if (path && (await this.existsLive(path, reference.id)) === false) unresolved.add(reference.path)
    }
    return [...unresolved]
  }

  /** The Graph path that reads a referenced object back, or undefined when no single read can check it. */
  private dependencyPath(reference: DependencyReference): string | undefined {
    if (reference.url?.startsWith(GRAPH)) return reference.url.slice(GRAPH.length).replace(/\('([^']+)'\)/g, "/$1")
    const collection = reference.key === "roleScopeTagIds" ? typeForFolder("ScopeTags")?.path
      : reference.key === "targetId" && reference.path.includes(".relationships") ? typeForFolder("Apps")?.path
      : reference.key === "notificationTemplateId" || reference.key === "notificationMessageTemplateId" ? typeForFolder("NotificationTemplates")?.path
      : reference.key === "deviceAndAppManagementAssignmentFilterId" ? typeForFolder("AssignmentFilters")?.path
      : reference.key === "groupId" ? "groups"
      : undefined
    return collection ? `${collection}/${encodeURIComponent(reference.id)}` : undefined
  }

  /**
   * Whether the referenced object exists live: true or false only when the read answers that
   * clearly, "forbidden" when the app registration may not read it, and undefined for any other
   * unclear answer (such as a server error), so a failed check never masquerades as a missing dependency.
   */
  private async existsLive(path: string, id: string): Promise<boolean | "forbidden" | undefined> {
    const cached = this.liveDependencies.get(path)
    if (cached !== undefined) return cached
    let exists: boolean | "forbidden" | undefined
    try {
      const response = await this.graph("GET", path)
      const readId = response.body?.id
      if (response.status < 300) exists = readId === undefined ? undefined : String(readId).toLowerCase() === id.toLowerCase()
      else if (response.status === 404 || (response.status === 400 && /ResourceNotFound/i.test(JSON.stringify(response.body)))) exists = false
      else if (response.status === 403) exists = "forbidden"
    } catch {
      exists = undefined
    }
    if (typeof exists === "boolean") this.liveDependencies.set(path, exists)
    return exists
  }

  private async update(type: IntuneType, path: string, source: Item, id: string, current: Item, plan: Step[], check?: () => Promise<void>, reviewed?: RestoreObservation): Promise<RestoreOutcome> {
    // A type that writes only what differs may find nothing it can write, such as a value Intune would reject.
    if (!plan.length) return { success: true, path, policyId: id, policyName: type.singleton?.name, action: "unchanged", warnings: ["Nothing was written: what differs from the backup cannot be restored. Review it in Intune."] }
    const written = plan[0]!.body
    const references = await this.policyReferences(type, written)
    if (references.blocking.length) return { success: false, path, policyId: id, action: "skipped", retryable: false, error: references.blocking.join(" ") }
    return this.withWarnings(await this.complete(type, path, id, source, "updated", plan, current, 0, check, reviewed?.target), type, source, written, references.warnings)
  }

  /** Adds what the type says about the written object, and the reference warnings, to a successful outcome. */
  private withWarnings(outcome: RestoreOutcome, type: IntuneType, source: Item, written: Item, references: string[]): RestoreOutcome {
    if (!outcome.success) return outcome
    const warnings = [...(type.warnings?.(source, written) ?? []), ...references]
    return warnings.length ? { ...outcome, warnings: [...(outcome.warnings ?? []), ...warnings] } : outcome
  }

  /**
   * Checks the users, groups, workload identities, named locations and authentication strengths a
   * Conditional Access policy points to, because Graph stores IDs that no longer exist without a word.
   * Blocking: a referenced named location or authentication strength that is gone, and an excluded
   * account or group that is gone (the exclusion would protect nobody, such as an emergency access
   * account recreated with a new ID). A copy to another tenant blocks on every tenant-specific
   * reference that was not recreated in this run. What cannot be checked (for example without
   * permission to read users) only warns.
   */
  private async policyReferences(type: IntuneType, body: Item): Promise<{ blocking: string[]; warnings: string[] }> {
    if (type.folder !== "ConditionalAccessPolicies") return { blocking: [], warnings: [] }
    const resolved = new Set([...this.remapped.values(), ...this.reviewed.values()].map((value) => value.toLowerCase()))
    const missing: string[] = []
    const absentIncludes: string[] = []
    const forbidden: PolicyReference[] = []
    const unanswered: PolicyReference[] = []
    for (const reference of policyReferences(body)) {
      if (resolved.has(reference.id.toLowerCase())) continue
      if (this.options.crossTenant) {
        if (TENANT_KINDS.has(reference.kind)) missing.push(referenceLabel(reference))
        continue
      }
      const path = referencePath(reference)
      if (!path) continue
      const exists = await this.existsLive(path, reference.id)
      if (exists === "forbidden") forbidden.push(reference)
      else if (exists === undefined) unanswered.push(reference)
      else if (!exists && (reference.exclude || reference.kind === "namedLocation" || reference.kind === "authenticationStrength")) missing.push(referenceLabel(reference))
      else if (!exists) absentIncludes.push(referenceLabel(reference))
    }
    const blocking = missing.length
      ? [this.options.crossTenant
        ? `This policy points to objects that exist only in the source tenant (${missing.join(", ")}). Copy its named locations and authentication strengths in the same run and recreate the users and groups it names, or create the policy in Entra.`
        : `This policy points to objects that no longer exist (${missing.join(", ")}). Restore or recreate them first, or edit the policy in Entra: an exclusion of a deleted account protects nobody.`]
      : []
    const warnings = [
      ...(absentIncludes.length ? [`These included objects no longer exist, so the policy applies to fewer people than when it was backed up: ${absentIncludes.join(", ")}.`] : []),
      uncheckedReferencesWarning("forbidden", forbidden),
      uncheckedReferencesWarning("unanswered", unanswered),
    ].filter((warning): warning is string => Boolean(warning))
    return { blocking, warnings }
  }

  /** Whether the live object already holds the backed-up configuration (and assignments, when those are restored). */
  private matches(snapshot: Item, current: Item, assignments: boolean): boolean {
    if (assignments) return sameSnapshot(snapshot, current)
    const { assignments: _a, ...wanted } = snapshot
    const { assignments: _b, ...live } = current
    return sameSnapshot(wanted, live)
  }

  /** A repair replays only rejected/unattempted steps against the object already created. */
  async repair(path: string, token: string, check?: () => Promise<void>, reviewedTarget?: unknown): Promise<RestoreOutcome> {
    const body = repairFor(token)?.body ?? {}
    try {
      await check?.()
      return withAdminLink(path, await this.repairOnce(path, token, reviewedTarget), body)
    } catch (error) {
      return { success: false, path, partial: true, retryable: false, policyId: repairFor(token)?.id, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async repairOnce(path: string, token: string, reviewedTarget?: unknown): Promise<RestoreOutcome> {
    const entry = repairFor(token)
    if (!entry || entry.expires < Date.now() || entry.path !== path || entry.scope !== (this.options.repairScope ?? this.instanceScope)) {
      return { success: false, path, retryable: false, error: "Repair is unavailable or expired. Check the existing object in Intune; do not create another copy." }
    }
    // Consume before awaiting to prevent concurrent requests replaying additive steps.
    consumeRepair(token)
    // A deleted object, a copy or a replaced one, has nothing to repair or open: report it missing, without an admin link.
    const gone: RestoreOutcome = { success: false, path, policyId: entry.id, missing: true, retryable: false, error: "The object no longer exists, so it was not repaired. Start a fresh restore if you still need it." }
    if (entry.action === "updated" || this.options.writeApprovalTenant && hasWriteApproval(this.options.writeApprovalTenant)) {
      try {
        const current = await this.current(entry.type, entry.id)
        if (!current && await this.parentGone(entry.type, entry.id)) return gone
        if (!current || !entry.expectedCurrent || !sameSnapshot(current, entry.expectedCurrent)) throw new Error("The live object changed after the failed restore. Review it and start a fresh replacement.")
      } catch (error) {
        return { success: false, path, partial: true, policyId: entry.id, retryable: false, error: error instanceof Error ? error.message : String(error) }
      }
    } else if (await this.parentGone(entry.type, entry.id)) {
      return gone
    }
    return this.complete(entry.type, path, entry.id, entry.body, entry.action, entry.steps, entry.expectedCurrent, undefined, undefined, reviewedTarget)
  }

  /**
   * Whether a direct read of the object itself answers that it no longer exists. Only that answer
   * counts: a full read also reads child resources, and a child that is gone, or any other failure,
   * says nothing about the object.
   */
  private async parentGone(type: IntuneType, id: string): Promise<boolean> {
    if (type.singleton) return false
    try {
      const response = await this.graph("GET", `${type.path}/${encodeURIComponent(id)}`)
      return response.status === 404 || (response.status === 400 && /ResourceNotFound/i.test(JSON.stringify(response.body)))
    } catch {
      return false
    }
  }

  private async complete(type: IntuneType, path: string, id: string, body: Item, action: "created" | "updated", steps: Step[], baseline?: Item, priorSteps = action === "created" ? 1 : 0, firstCheck?: () => Promise<void>, reviewedTarget?: unknown, finish?: (live: Item) => void): Promise<RestoreOutcome> {
    const name = type.singleton?.name ?? body[type.nameKey] ?? body.displayName ?? body.name
    const base = { path, policyId: id, policyName: typeof name === "string" ? name : undefined, action }
    const resolved = steps.map((step) => resolveStep(step, id))
    const protectedWrite = resolved.length > 0 && this.options.writeApprovalTenant && hasWriteApproval(this.options.writeApprovalTenant)
    let expected = baseline
    if (protectedWrite && !expected) {
      throw new WriteApprovalError("The restored object changed before its remaining writes.")
    }
    for (const [index, step] of resolved.entries()) {
      let message: string | undefined
      let safeToRetry = false
      let response: Awaited<ReturnType<GraphCall>> | undefined
      try {
        const send = () => this.graph(step.method, step.path, step.body)
        const read = async () => {
          const live = await this.current(type, id)
          return live ? approvalFingerprint(live) : null
        }
        const dispatch = index === 0 && firstCheck ? () => withWriteCheckpoint(firstCheck, send) : send
        const dependencyCheck = async () => {
          const reviewed = Array.isArray(reviewedTarget) && Array.isArray(reviewedTarget[1]) ? new Map(reviewedTarget[1] as [string, unknown][]) : undefined
          for (const [path, value] of await this.approvalDependencies(type, [step.body]) as Array<[string, unknown]>) {
            if (reviewed && (!reviewed.has(path) || reviewed.get(path) !== value)) throw new WriteApprovalError("A destination dependency changed after review.")
          }
        }
        response = protectedWrite ? await withWriteCheckpoint(async () => {
          await dependencyCheck()
          await sameObservation(approvalFingerprint(expected!), read)()
        }, dispatch) : await dispatch()
        if (!response.approval) {
          if (response.status < 300) {
            if (protectedWrite && (index < resolved.length - 1 || finish)) {
              expected = await this.verifiedState(type, id, step, response.body, expected)
            }
            continue
          }
          message = `${step.kind === "assignments" ? "Assignments" : "Settings"} could not be restored: ${writeError(type, response.body, response.status)}`
          safeToRetry = response.status < 500 && response.status !== 408
        }
      } catch (error) {
        if (!response && error instanceof FetchPreconditionError) {
          return { ...base, success: false, partial: priorSteps > 0 || index > 0, retryable: false, error: `Write not sent: ${error.message}` }
        }
        message = `Write outcome unknown: ${error instanceof Error ? error.message : String(error)}. Check Intune before retrying.`
      }
      if (response?.approval) {
        let live = protectedWrite ? expected : index === 0 ? baseline : undefined
        if (action === "updated" && !live && this.options.approvalContext && response.approval.kind !== "locked-by-other") {
          try { live = await this.current(type, id) } catch { /* Retain the pending code even if the read fails. */ }
        }
        return this.pauseApproval(type, path, step, resolved.slice(index + 1), body, action, response.approval, id, live, undefined, priorSteps > 0 || index > 0, priorSteps + index + 1, priorSteps + resolved.length)
      }
      let repairToken: string | undefined
      let expectedCurrent: Item | undefined
      if (safeToRetry && protectedWrite) expectedCurrent = expected
      else if (safeToRetry && action === "updated") {
        try { expectedCurrent = await this.current(type, id) } catch { /* No repair token without a reliable baseline. */ }
        if (!expectedCurrent) { safeToRetry = false; message += " The live object could not be checked; review it in Intune before another replacement." }
      }
      if (safeToRetry) {
        for (const [key, entry] of repairs) if (entry.expires < Date.now()) repairs.delete(key)
        if (repairs.size >= 1000) repairs.delete(repairs.keys().next().value!)
        repairToken = randomUUID()
        saveRepair(repairToken, { scope: this.options.repairScope ?? this.instanceScope, path, type, id, body, action,
          steps: resolved.slice(index), expectedCurrent, expires: Date.now() + (protectedWrite ? WRITE_APPROVAL_LIFETIME : 60 * 60 * 1000) }, Boolean(protectedWrite))
      }
      return { ...base, success: false, partial: true, retryable: safeToRetry, repairToken, error: message, warnings: [message!] }
    }
    if (expected) finish?.(expected)
    return { ...base, success: true }
  }

  private async verifiedState(type: IntuneType, id: string, step: Step, response: Item, before?: Item): Promise<Item> {
    const live = await this.current(type, id)
    if (!live || !verifiedMutation(type, id, step.method, step.path, step.body, response, live, before)) {
      throw new WriteApprovalError("The preceding write could not be reconciled with the live object. Review it before continuing.")
    }
    const tenant = this.options.writeApprovalTenant
    if (tenant) {
      const key = writeKey(tenant, step.method, step.path, step.body)
      const entry = writeRecords().find(record => record.key === key)
      if (entry?.state === "complete" || entry?.state === "reconciled") {
        saveWrite({ ...entry, objectId: id, verifiedPostStep: approvalFingerprint(live) })
      }
    }
    return live
  }

  private async pauseApproval(type: IntuneType, path: string, step: Step, remaining: Step[], source: Item, action: "created" | "updated", signal: ApprovalSignal, objectId?: string, baseline?: Item, snapshotId?: string, partial = false, stepNumber = partial ? 2 : 1, totalSteps = stepNumber + remaining.length): Promise<RestoreOutcome> {
    const context = this.options.approvalContext
    const base: RestoreOutcome = { success: false, path, policyId: objectId, partial, retryable: false, approval: signal, error: approvalMessage(signal, type.label, partial ? `The ${action === "created" ? `object was created (${objectId})` : "earlier update steps were written"}.` : undefined) }
    if (!context || this.options.crossTenant || signal.kind === "locked-by-other") return base
    if (action === "updated" && !baseline && signal.kind !== "pending") return { ...base, error: `${base.error} The live object could not be fingerprinted. Review it before submitting.` }
    const exact = (entry: Step): ApprovalStep => ({ method: entry.method, path: entry.path, kind: entry.kind, body: entry.body ? JSON.stringify(entry.body) : undefined })
    const name = source[type.nameKey] ?? source.displayName ?? source.name
    const record: RestoreApproval = { id: signal.kind === "pending" ? signal.code : randomUUID(), tenantId: context.tenantId, requesterId: context.requesterId, requesterName: context.requesterName, origin: "restore", backupPath: path, snapshotId, repairScope: this.options.repairScope,
      label: typeof name === "string" ? name : type.label, folder: type.folder, operation: step.kind === "assignments" ? "assign" : action === "created" && !objectId ? "create" : "update",
      step: exact(step), remaining: remaining.map(exact), objectId, fingerprint: baseline ? approvalFingerprint(baseline, this.options.assignments) : undefined, submittedAt: new Date().toISOString(), status: signal.kind === "pending" ? "needsApproval" : "justification-required", justification: context.justification ?? "", stepNumber, totalSteps, action, source, assignments: this.options.assignments, mode: this.options.mode }
    if (signal.kind === "pending" && restoreApprovals(context.tenantId).some(entry => entry.id === signal.code)) return { ...base, approvalId: signal.code, approvalState: "submitted", error: "Already submitted for approval" }
    saveRestoreApproval(record)
    if (signal.kind === "justification-required" && record.justification.trim() && !hasWriteApproval(context.tenantId)) return this.submitApproval(record)
    if (signal.kind === "pending") { try { await this.refreshApproval(record) } catch { /* The pending record is already durable. */ } }
    return { ...base, approvalId: record.id, approvalState: signal.kind === "pending" ? "submitted" : "required", error: signal.kind === "pending" ? "Submitted for approval" : base.error }
  }

  async refreshApproval(record: RestoreApproval): Promise<RestoreApproval> {
    this.checkApprovalOwner(record, false)
    if (record.continuationPending || ["justification-required", "completed", "rejected", "cancelled", "expired"].includes(record.status)) return record
    const response = await this.graph("GET", `deviceManagement/operationApprovalRequests/${encodeURIComponent(record.id)}`)
    if (response.status === 404) { record = { ...record, status: "expired" }; saveRestoreApproval(record); return record }
    if (response.status !== 200) throw new Error(errorMessage(response.body, response.status))
    const latest = restoreApprovals(record.tenantId).find(entry => entry.id === record.id) ?? record
    if (["completed"].includes(latest.status)) return latest
    record = { ...latest, status: latest.status === "stale" && response.body.status === "approved" ? "stale" : typeof response.body.status === "string" ? response.body.status : record.status, expiresAt: typeof response.body.expirationDateTime === "string" ? response.body.expirationDateTime : record.expiresAt, approverNote: typeof response.body.approvalJustification === "string" ? response.body.approvalJustification : undefined, approver: intuneApprover(response.body.approver) }
    saveRestoreApproval(record)
    return record
  }

  private checkApprovalOwner(record: RestoreApproval, requester = true): void {
    const context = this.options.approvalContext
    if (!context || context.tenantId.toLowerCase() !== record.tenantId.toLowerCase()) throw new Error("Sign in to the request's tenant")
    if (requester && (!context.requesterId || context.requesterId.toLowerCase() !== record.requesterId.toLowerCase())) throw new Error("Only the original requester can complete or withdraw this request")
  }

  async submitApproval(record: RestoreApproval, justification = record.justification, check?: () => Promise<void>, reviewedTarget?: unknown): Promise<RestoreOutcome> {
    this.checkApprovalOwner(record)
    if (record.status !== "justification-required") throw new Error("This item was already submitted")
    if (!justification.trim() || justification.length > 700) throw new Error("Enter a justification of 1 to 700 characters")
    const baseline = check && record.objectId ? await this.current(typeForFolder(record.folder)!, record.objectId) : undefined
    const send = () => this.graph(record.step.method, record.step.path, record.step.body ? JSON.parse(record.step.body) as Item : undefined, { exactBody: record.step.body, justification })
    const response = check ? await withWriteCheckpoint(check, send) : await send()
    if (response.approval?.kind === "pending") {
      const draftId = record.id
      const code = response.approval.code
      const existing = restoreApprovals(record.tenantId).find(entry => entry.id === code)
      if (existing && existing.step.body !== record.step.body) return { success: false, path: record.backupPath, partial: record.stepNumber > 1, policyId: record.objectId, approvalId: record.id, approval: response.approval, retryable: false, error: "A different change to this object is already waiting for approval in Intune. Complete or withdraw it first." }
      record = existing ?? { ...record, id: response.approval.code, status: "needsApproval", requesterName: this.options.approvalContext?.requesterName ?? record.requesterName, justification }
      saveRestoreApproval(record)
      // The local draft is terminal once Intune has issued a code.
      const draft = restoreApprovals(record.tenantId).find(entry => entry.id === draftId && entry.status === "justification-required")
      if (draft && draft.id !== record.id) removeRestoreApproval(record.tenantId, draft.id)
      try { await this.refreshApproval(record) } catch { /* Keep the durable request when status is unavailable. */ }
      return { success: false, path: record.backupPath, policyId: record.objectId, partial: record.stepNumber > 1, retryable: false, approval: response.approval, approvalId: record.id, approvalState: "submitted", error: `${record.stepNumber > 1 ? "Earlier restore steps were written. " : ""}${existing ? "Already submitted for approval" : "Submitted for approval"}`, adminLink: TENANT_ADMIN("multiAdminApproval") }
    }
    if (response.status < 300) return this.resumeApproval(record, response.body, [], baseline, reviewedTarget)
    return { success: false, path: record.backupPath, policyId: record.objectId, retryable: false, approval: response.approval, error: response.approval ? approvalMessage(response.approval, typeForFolder(record.folder)!.label, record.stepNumber > 1 ? "Earlier restore steps were written." : undefined) : errorMessage(response.body, response.status) }
  }

  async completeApproval(record: RestoreApproval, check?: () => Promise<void>, reviewedTarget?: unknown): Promise<RestoreOutcome> {
    this.checkApprovalOwner(record)
    if (record.continuationPending) {
      if (hasWriteApproval(record.tenantId) && !record.continuationFingerprint) throw new WriteApprovalError(LEGACY_CONTINUATION)
      if (!record.objectId) throw new WriteApprovalError("The completed Intune step has no saved object ID. Check Intune before continuing.")
      await check?.()
      return this.resumeApproval(record, { id: record.objectId }, [], undefined, reviewedTarget)
    }
    record = await this.refreshApproval(record)
    if (record.status !== "approved") throw new Error("This request is not approved")
    const type = typeForFolder(record.folder)!
    // Without a baseline from submission time, a live read now cannot show whether someone changed the object meanwhile.
    if (record.action === "updated" && record.objectId && !record.fingerprint) throw new Error("TenuVault could not read this object when the request was sent, so it cannot check whether it changed since. Review it in Intune, then withdraw this request and restore again.")
    let baseline: Item | undefined
    if (record.fingerprint && record.objectId) {
      const live = baseline = await this.current(type, record.objectId)
      if (!live || approvalFingerprint(live, record.assignments) !== record.fingerprint) {
        saveRestoreApproval({ ...record, status: "stale" })
        throw new Error("The live object changed after submission. Review it and start a fresh restore.")
      }
    }
    const bodies = [record.step, ...record.remaining].flatMap(step => step.body ? [JSON.parse(step.body) as Item] : [])
    const unresolved = await this.unresolved(bodies.flatMap(body => dependencyReferences(body)))
    if (unresolved.length) throw new Error(`Unresolved dependencies (${unresolved.join(", ")}). Restore them before completing this request.`)
    const references = await this.policyReferences(type, record.step.body ? JSON.parse(record.step.body) as Item : {})
    if (references.blocking.length) throw new Error(references.blocking.join(" "))
    const send = () => this.graph(record.step.method, record.step.path, record.step.body ? JSON.parse(record.step.body) as Item : undefined, { exactBody: record.step.body, approvalCode: record.id, sourceId: record.snapshotId })
    const response = check ? await withWriteCheckpoint(check, send) : await send()
    if (response.status === 403) {
      try { await this.refreshApproval(record) } catch { /* Preserve the completion error. */ }
      throw new Error("Intune refused to complete this request. It may have expired, been changed, or been completed already. Check it in the Intune admin center.")
    }
    if (response.status >= 300) throw new Error(errorMessage(response.body, response.status))
    return this.resumeApproval(record, response.body, references.warnings, baseline, reviewedTarget)
  }

  private async resumeApproval(record: RestoreApproval, response: Item, warnings: string[] = [], before?: Item, reviewedTarget?: unknown): Promise<RestoreOutcome> {
    const type = typeForFolder(record.folder)!
    const id = record.objectId ?? (typeof response.id === "string" ? response.id : undefined)
    if (!id) throw new Error("Microsoft Graph did not return an object ID. Check Intune before continuing.")
    const protectedWrite = hasWriteApproval(record.tenantId)
    let baseline: Item | undefined
    if (protectedWrite && record.remaining.length) {
      if (record.continuationPending) {
        baseline = await this.current(type, id)
        if (!baseline || record.continuationFingerprint !== approvalFingerprint(baseline)) throw new WriteApprovalError("The live object changed since the Intune step completed.")
      } else {
        // Keep the completed step marked even if the result cannot be confirmed. It must never
        // be sent again, and an unverified result cannot authorize subsequent mutations.
        saveRestoreApproval({ ...record, objectId: id, status: "approved", continuationPending: true })
        baseline = await this.verifiedState(type, id, { ...record.step, body: record.step.body ? JSON.parse(record.step.body) as Item : {} }, response, before)
      }
    }
    saveRestoreApproval({ ...record, objectId: id, status: "approved", continuationPending: true, continuationFingerprint: protectedWrite && baseline ? approvalFingerprint(baseline) : undefined })
    const next = new Restorer(this.graph, { ...this.options, mode: record.mode, assignments: record.assignments, repairScope: record.repairScope, approvalContext: { ...this.options.approvalContext!, justification: `${record.justification.slice(0, 686)} (${record.remaining[0]?.kind ?? "content"})` } })
    const steps = record.remaining.map(step => ({ ...step, body: step.body ? JSON.parse(step.body) as Item : {} }))
    if (!protectedWrite && record.action === "updated") baseline = await this.current(type, id)
    const outcome = await next.complete(type, record.backupPath, id, record.source, record.action, steps, baseline, record.stepNumber, undefined, reviewedTarget)
    saveRestoreApproval({ ...record, objectId: id, status: "completed", continuationPending: false })
    if (record.assignments && type.assignmentWarning) outcome.warnings = [...(outcome.warnings ?? []), type.assignmentWarning]
    return withAdminLink(record.backupPath, next.withWarnings({ ...outcome, intuneApprover: record.approver ?? null }, type, record.source, record.step.body ? JSON.parse(record.step.body) as Item : {}, warnings), record.source)
  }

  /** The live object read like a backup, or undefined when it was deleted. */
  current(type: IntuneType, id: string): Promise<Item | undefined> {
    return readLive(this.graph, type, id)
  }

  /** Reviewed mappings only rewrite dependency references, never configuration text. */
  private remap(snapshot: Item, remapped = this.remapped, includeReviewed = true, strict = false): Item {
    const guids = [...remapped].filter(([from]) => GUID.test(from) && !this.reviewed.has(from.toLowerCase()))
    const walk = (value: Json, key = "", parent = ""): Json => {
      if (typeof value === "string") {
        const reference = /(?:Id|Ids)$/.test(key) || (key === "id" && parent === "categories")
        const binding = key === "@odata.id" || key.endsWith("@odata.bind")
        if (reference) {
          const reviewed = this.reviewed.get(value.toLowerCase())
          if (includeReviewed && reviewed) return reviewed
        }
        if (binding && value.startsWith("https://graph.microsoft.com/beta/")) {
          return value.replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi, id => (includeReviewed ? this.reviewed.get(id.toLowerCase()) : undefined) ?? remapped.get(id) ?? id)
        }
        const policyReference = /^(includeLocations|excludeLocations)$/.test(key) || key === "id" && parent === "authenticationStrength"
        if (strict && !reference && !policyReference) return value
        const exact = this.reviewed.has(value.toLowerCase()) ? undefined : remapped.get(value)
        if (exact) return exact
        if (strict) return guids.find(([from]) => from.toLowerCase() === value.toLowerCase())?.[1] ?? value
        return guids.reduce((text, [from, to]) => text.replace(new RegExp(from, "gi"), to), value)
      }
      if (Array.isArray(value)) return value.map(entry => walk(entry, key, parent))
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([child, entry]) => [child, walk(entry, child, key)]))
      return value
    }
    return walk(snapshot) as Item
  }


}

/**
 * The live object with the snapshot's locateBy value (see IntuneType.locateBy), read like a backup,
 * or undefined when the type has none or no single object matches.
 */
export function locateLive(graph: GraphCall, type: IntuneType, snapshot: Item): Promise<Item | undefined> {
  return locateObject(type, snapshot, liveReader(graph))
}

/** The live object read like a backup, or undefined when it was deleted. */
export async function readLive(graph: GraphCall, type: IntuneType, id: string): Promise<Item | undefined> {
  try {
    return await readObject(type, id, liveReader(graph))
  } catch (error) {
    if (error instanceof Gone) return undefined
    throw error
  }
}

/** Reads through the restore's Graph caller; a deleted object reads as Gone. */
function liveReader(graph: GraphCall): GraphReader {
  const reader: GraphReader = {
    get: async (path) => {
      const response = await graph("GET", path)
      // Settings Catalog answers 400 ResourceNotFound for deleted policies instead of 404.
      if (response.status === 404 || (response.status === 400 && /ResourceNotFound/i.test(JSON.stringify(response.body)))) throw new Gone()
      if (response.status >= 300) throw new Error(errorMessage(response.body, response.status))
      return response.body
    },
    list: async (start) => {
      const items: Item[] = []
      let next: string | undefined = start
      const seen = new Set<string>()
      while (next) {
        if (seen.has(next)) throw new Error("Microsoft Graph returned a repeated continuation link")
        if (seen.size >= MAX_LIST_PAGES) throw new Error(`Microsoft Graph listing did not finish after ${MAX_LIST_PAGES} pages`)
        seen.add(next)
        if (/^https?:/i.test(next) && !next.startsWith(GRAPH)) throw new Error("Invalid Graph continuation link")
        const page = await reader.get(next.startsWith(GRAPH) ? next.slice(GRAPH.length) : next)
        if (!Array.isArray(page.value)) throw new Error("Microsoft Graph returned an invalid collection")
        items.push(...(page.value as Item[]))
        next = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined
      }
      return items
    },
  }
  return reader
}

export { NotRestorableError }

/** Verify only known Graph write shapes before accepting a new baseline for a later mutation. */
export function verifiedMutation(type: IntuneType, id: string, method: string, path: string, body: Item | undefined, response: Item, live: Item, before?: Item): boolean {
  if (!type.singleton && live.id !== id) return false
  const root = `${type.path}/${encodeURIComponent(id)}`
  const revision = response["@odata.etag"] ?? response.lastModifiedDateTime
  const revisionMatches = typeof revision === "string" && revision === (live["@odata.etag"] ?? live.lastModifiedDateTime)
  const comparable = (item: Item) => {
    const normalized = comparableSnapshot(item) as Item
    delete normalized["@odata.etag"]
    return normalized
  }
  const desired = comparable(body ?? {})
  const actual = comparable(live)
  const unchanged = before ? comparable(before) : undefined
  if (method === "POST" && !before && (path === type.path || type.createPath)) {
    if (response.id !== id || (Array.isArray(live.assignments) && live.assignments.length)) return false
  } else if ((method === "PATCH" || method === "PUT") && (path === root || !!type.singleton && path === type.path)) {
    if (!unchanged) return false
  } else if (method === "POST" && unchanged && path.startsWith(`${root}/`)) {
    const action = path.slice(root.length + 1)
    if ((action === "assign" || action === "update") && Array.isArray(actual.assignments)) {
      const assignments = desired.assignments ?? desired.mobileAppAssignments ?? desired.deviceManagementConfigurationPolicyAssignments
      if (!Array.isArray(assignments)) return false
      for (const key of Object.keys(desired)) delete desired[key]
      desired.assignments = assignments.map(item => cleanAssignment(item as Item))
      actual.assignments = actual.assignments.map(item => cleanAssignment(item as Item))
    } else if (action === "scheduleActionsForRules" || action === "setScheduledActions") {
      const scheduled = desired.deviceComplianceScheduledActionForRules ?? desired.scheduledActions
      if (!Array.isArray(scheduled) || !Array.isArray(actual.scheduledActionsForRule)) return false
      const clean = (data: Json): Json => Array.isArray(data) ? data.map(clean) : data && typeof data === "object"
        ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== "id").map(([key, value]) => [key, clean(value)]))
        : data
      for (const key of Object.keys(desired)) delete desired[key]
      desired.scheduledActionsForRule = clean(scheduled)
      actual.scheduledActionsForRule = clean(actual.scheduledActionsForRule)
    } else if (action === "unassignUserFromDevice") {
      desired.userPrincipalName = ""
      desired.addressableUserName = ""
    } else if (!["setPriority", "updateAllowedCombinations", "updateDeviceProperties"].includes(action)) {
      return false
    }
  } else return false
  for (const [key, value] of Object.entries(desired)) {
    if (!(key in actual) && (key === "@odata.type" || revisionMatches)) continue
    if (!sameSnapshot(value, actual[key])) return false
  }
  const extras = new Set([...COMMON_READ_ONLY, ...(type.readOnly ?? [])])
  if (!unchanged) {
    const returned = comparable(response)
    return Object.entries(actual).every(([key, value]) =>
      key in desired || extras.has(key) || key === "assignments" && Array.isArray(value) && !value.length
      || (key in returned ? sameSnapshot(returned[key], value) : revisionMatches))
      && Object.entries(returned).every(([key, value]) => extras.has(key) || sameSnapshot(actual[key], value))
  }
  return Object.entries(unchanged).every(([key, value]) => key in desired || sameSnapshot(value, actual[key]))
    && Object.keys(actual).every(key => key in desired || key in unchanged || extras.has(key))
}

function intuneApprover(value: Json | undefined): RestoreApproval["approver"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const safe = (identity: Json | undefined) => {
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) return undefined
    const text = (key: string) => typeof identity[key] === "string" ? identity[key].slice(0, 200) : undefined
    return { id: text("id"), displayName: text("displayName"), upn: text("Upn") ?? text("upn") }
  }
  return { user: safe(value.user), application: safe(value.application) }
}

export function approvalFingerprint(value: Item, assignments = true): string {
  const snapshot = comparableSnapshot(value) as Item
  if (!assignments) delete snapshot.assignments
  return createHash("sha256").update(stableJson(snapshot)).digest("hex")
}

function stableJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`
  return JSON.stringify(value)
}
