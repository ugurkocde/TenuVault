import { createHash } from "node:crypto"
import { comparableSnapshot } from "../../../shared/intune/compare"
import { buildRestorePlan } from "../../../shared/intune/restore-plan"
import { cleanAssignment, typeForFolder, type IntuneType, type Item, type Json } from "../../../shared/intune/registry"
import type { ListedRecord } from "../contracts"

/**
 * Pure model of the internal change-set write engine: record shapes, hashing, diffing, sanitizing,
 * read-back comparison and the explanations shown before confirmation. No Electron, no
 * network, so every rule here is unit tested directly. The engine (engine.ts) adds Graph,
 * storage and the backup.
 */

export type OperationAction = "create" | "update" | "delete"

/**
 * Operation types the engine can apply, by registry folder. A new type is added here only
 * after its create, update and delete requests and its read-back were verified.
 */
export const SUPPORTED_OPERATIONS: Readonly<Record<string, readonly OperationAction[]>> = {
  ConfigurationPolicies: ["create", "update", "delete"],
  CompliancePolicies: ["create", "update", "delete"],
  DeviceConfigurations: ["create", "update", "delete"],
  EndpointSecurityIntents: ["create", "update", "delete"],
}

/** Most operations in one change set; keeps review, capture and storage bounded. */
export const MAX_OPERATIONS = 25
/** Diff entries kept per operation; the full content stays in the frozen proposal. */
export const MAX_DIFF_ENTRIES = 150
const MAX_DIFF_VALUE = 160

export const REDACTED = "[redacted by TenuVault]"

/** Where a proposed configuration came from, for the record. Never a token or secret. */
export interface OperationSource {
  tenantId: string | null
  objectId: string | null
  /** Version of the source, such as the object's lastModifiedDateTime or a backup folder. */
  version: string | null
  /** Plain label, such as "Backup backup-2026-09-30-101500" or "Development tenant". */
  label: string
}

export interface DiffEntry {
  path: string
  change: "added" | "removed" | "changed"
  before?: string
  after?: string
}

/** One frozen operation of a change set, without its (possibly large) content. */
export interface ChangeOperation {
  /** Stable key within the change set, "op-1", "op-2" and so on. */
  key: string
  folder: string
  action: OperationAction
  /** The existing object in the target tenant for update and delete; null for create. */
  targetId: string | null
  name: string
  source: OperationSource | null
  /** sha256 of the frozen proposed body (canonical JSON), null for delete. */
  proposedHash: string | null
  /**
   * Whether the operation sets assignments. False leaves assignments untouched on update and
   * creates the object unassigned; assignments are only set after a separate targeting review.
   */
  setsAssignments: boolean
  /** sha256 of the reviewed, target-resolved assignments, null when not set. */
  assignmentsHash: string | null
  /** Proposed diff against the target state seen when the change set was created. */
  diff: DiffEntry[]
  diffTruncated: boolean
}

/** A reference to a dependency the operations rely on, already resolved in the target. */
export interface DependencyRef {
  kind: "group" | "filter" | "scopeTag" | "reusableSetting" | "other"
  sourceId: string | null
  targetId: string | null
  name: string | null
  /** "verified" read in the target; "unknown" could not be read (for example groups without Group.Read.All). */
  state: "verified" | "unknown"
}

export type OperationStatus = "pending" | "writing" | "verified" | "failed" | "uncertain"

export interface OperationResult {
  status: OperationStatus
  /** The object written (created ID, or the updated or deleted ID). */
  objectId: string | null
  message: string | null
  readBack: "match" | "differs" | "denied" | "missing" | null
  attempts: number
  at: string | null
}

export interface ChangeSetReview {
  decision: "approved" | "rejected"
  /** The exact content the reviewer saw. */
  contentHash: string
  /** Target state the reviewer saw: combined fingerprint and one per operation. */
  targetFingerprint: string
  operationFingerprints: Record<string, string>
  observedAt: string
  reviewer: string | null
  actor: string | null
  note: string | null
  decidedAt: string
}

export type ChangeSetStatus =
  | "in-review"
  | "approved"
  | "rejected"
  | "stale"
  | "applying"
  | "applied"
  | "partial"
  | "failed"
  | "uncertain"

/**
 * A change set as stored in DOMAINS.changeSets under its target tenant. Content (proposed
 * bodies, assignments, pre-change snapshots) lives in immutable content records referenced by
 * `proposalId` and `preChange.captureId`, so progress updates never copy it into history.
 */
export interface ChangeSetRecord extends ListedRecord {
  status: ChangeSetStatus
  kind: "change" | "rollback"
  /** The workflow that created it and its record, for example { workflow: "promotion", recordId }. */
  origin: { workflow: string; recordId: string | null }
  targetTenantId: string
  sourceTenantId: string | null
  sourceVersion: string | null
  ticket: string | null
  operations: ChangeOperation[]
  dependencies: DependencyRef[]
  proposalId: string
  contentHash: string
  review: ChangeSetReview | null
  preChange: {
    capturedAt: string
    /** Backup folder of the successful pre-change backup. */
    backupFolder: string
    captureId: string
    /** Per operation: whether the object existed and whether values were redacted. */
    objects: Array<{ key: string; objectId: string | null; name: string; state: "present" | "absent"; redacted: boolean; sameNameIds: string[] }>
  } | null
  results: Record<string, OperationResult>
  rollbackOf: string | null
  attempts: number
  lastError: string | null
}

/** Immutable content of a change set (domain CONTENT_DOMAIN). */
export interface ChangeSetContent {
  title: string
  status: "frozen"
  summary: string
  kind: "proposal" | "capture"
  changeSetId: string | null
  /** Per operation key. Proposal: proposed body and assignments. Capture: pre-change snapshot. */
  entries: Record<string, { body: Item | null; assignments: Item[] | null }>
}

// ---------------------------------------------------------------------------------------------
// Hashing

/** JSON with object keys sorted and undefined members left out, so equal content hashes equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export function hashOf(value: unknown): string {
  return sha256(canonicalJson(value))
}

/**
 * The hash approval binds to: everything that decides what is written where. Titles, tickets,
 * reviewer and progress are metadata and left out; changing any operation, its content hash,
 * the target, the source version or dependencies changes the hash.
 */
export function contentHashOf(record: Pick<ChangeSetRecord, "kind" | "targetTenantId" | "sourceTenantId" | "sourceVersion" | "operations" | "dependencies" | "rollbackOf">): string {
  return hashOf({
    kind: record.kind,
    targetTenantId: record.targetTenantId.toLowerCase(),
    sourceTenantId: record.sourceTenantId?.toLowerCase() ?? null,
    sourceVersion: record.sourceVersion,
    operations: record.operations.map(({ key, folder, action, targetId, name, proposedHash, setsAssignments, assignmentsHash }) => ({ key, folder, action, targetId, name, proposedHash, setsAssignments, assignmentsHash })),
    dependencies: record.dependencies,
    rollbackOf: record.rollbackOf,
  })
}

/** The combined target fingerprint of per-operation fingerprints. */
export function combinedFingerprint(perOperation: Record<string, string>): string {
  return hashOf(perOperation)
}

/**
 * Fingerprint of one operation's target state. Update and delete: the sanitized live object
 * (configuration and assignments) or "missing". Create: the IDs of objects of that type with
 * the same name, so a concurrent creation of the same name invalidates the review.
 */
export function operationFingerprint(action: OperationAction, observed: { snapshot: Item | null; sameNameIds: string[] }): string {
  if (action === "create") return hashOf({ sameName: [...observed.sameNameIds].map((id) => id.toLowerCase()).sort() })
  return observed.snapshot ? hashOf(comparableSnapshot(observed.snapshot)) : "missing"
}

// ---------------------------------------------------------------------------------------------
// Sanitizing

/**
 * A copy safe to store in local records: values the registry marks as secrets and Settings
 * Catalog secret values are replaced, and `redacted` says so. A redacted snapshot cannot be
 * written back as is; rollback of that object is reported as unsupported.
 */
export function sanitizeSnapshot(type: IntuneType, snapshot: Item): { snapshot: Item; redacted: boolean } {
  const copy = structuredClone(snapshot)
  let redacted = false
  for (const secret of type.secrets?.(copy) ?? []) {
    secret.apply(REDACTED)
    redacted = true
  }
  const walk = (value: Json): void => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (!value || typeof value !== "object") return
    const kind = value["@odata.type"]
    if (typeof kind === "string" && /SecretSettingValue$/i.test(kind) && "value" in value) {
      value.value = REDACTED
      redacted = true
    }
    for (const key of Object.keys(value)) walk(value[key] ?? null)
  }
  walk(copy)
  return { snapshot: copy, redacted }
}

/**
 * True when content holds a value as Intune returns it masked: a Settings Catalog secret (read back
 * as an encrypted value token) or a "****" mask. Writing either back would replace the real secret,
 * so the engine refuses it whatever workflow built the content.
 */
export function containsSecret(value: Json | undefined): boolean {
  if (Array.isArray(value)) return value.some(containsSecret)
  if (!value || typeof value !== "object") return false
  const kind = value["@odata.type"]
  if ((typeof kind === "string" && /SecretSettingValue$/i.test(kind)) || value.value === "****") return true
  return Object.values(value).some(containsSecret)
}

/** True when a snapshot still carries a redaction marker (it must not be written). */
export function containsRedaction(value: Json | undefined): boolean {
  return JSON.stringify(value ?? null).includes(REDACTED)
}

// ---------------------------------------------------------------------------------------------
// Bodies, diff and read-back

/** The body Graph receives for a snapshot: read-only fields and annotations removed. */
export function writableBody(type: IntuneType, snapshot: Item): Item {
  const { assignments: _assignments, ...rest } = snapshot
  return buildRestorePlan(type, rest as Item, { includeAssignments: false }).create.body
}

/** Arrays of settings are compared by their definition, not by position. */
function keyed(value: Json): Json {
  if (Array.isArray(value) && value.length && value.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as Item).settingInstance === "object")) {
    const result: Item = {}
    for (const entry of value as Item[]) {
      const instance = entry.settingInstance as Item | null
      const id = typeof instance?.settingDefinitionId === "string" ? instance.settingDefinitionId : `#${Object.keys(result).length}`
      result[id in result ? `${id}#${Object.keys(result).length}` : id] = keyed(entry)
    }
    return result
  }
  if (Array.isArray(value)) return value.map(keyed)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, keyed(entry)]))
  return value
}

const short = (value: Json | undefined): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null)
  return text.length > MAX_DIFF_VALUE ? `${text.slice(0, MAX_DIFF_VALUE)}...` : text
}

/**
 * Differences between two configurations, as a bounded list for review. Both sides go
 * through writableBody and comparableSnapshot, so server-managed fields never show up.
 */
export function diffConfigurations(type: IntuneType, before: Item | null, after: Item | null): { entries: DiffEntry[]; truncated: boolean } {
  const left = before ? keyed(comparableSnapshot(writableBody(type, before))) : null
  const right = after ? keyed(comparableSnapshot(writableBody(type, after))) : null
  const entries: DiffEntry[] = []
  let truncated = false
  const push = (entry: DiffEntry) => {
    if (entries.length >= MAX_DIFF_ENTRIES) truncated = true
    else entries.push(entry)
  }
  const walk = (a: Json | undefined, b: Json | undefined, path: string): void => {
    if (canonicalJson(a ?? null) === canonicalJson(b ?? null)) return
    const objectA = a && typeof a === "object" && !Array.isArray(a)
    const objectB = b && typeof b === "object" && !Array.isArray(b)
    if (objectA && objectB) {
      const keys = [...new Set([...Object.keys(a as Item), ...Object.keys(b as Item)])].sort()
      for (const key of keys) walk((a as Item)[key], (b as Item)[key], path ? `${path}.${key}` : key)
      return
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      a.forEach((entry, index) => walk(entry, b[index], `${path}[${index}]`))
      return
    }
    if (a === undefined || a === null) push({ path: path || "(object)", change: "added", after: short(b) })
    else if (b === undefined || b === null) push({ path: path || "(object)", change: "removed", before: short(a) })
    else push({ path: path || "(object)", change: "changed", before: short(a), after: short(b) })
  }
  walk(left ?? undefined, right ?? undefined, "")
  return { entries, truncated }
}

/**
 * Whether `actual` holds everything `expected` asks for. Graph adds null members and
 * server fields on read, so a member missing on one side and null on the other is equal.
 */
export function containsExpected(expected: Json | undefined, actual: Json | undefined): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined || (Array.isArray(actual) && actual.length === 0)
  if (Array.isArray(expected) && expected.length === 0) return actual === null || actual === undefined || (Array.isArray(actual) && actual.length === 0)
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((entry, index) => containsExpected(entry, actual[index]))
  if (typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false
    return Object.entries(expected).every(([key, value]) => containsExpected(value, actual[key]))
  }
  return expected === actual
}

/** Whether the live object matches the proposed configuration (assignments compared separately). */
export function matchesProposed(type: IntuneType, proposed: Item, live: Item): boolean {
  return containsExpected(keyed(comparableSnapshot(writableBody(type, proposed))), keyed(comparableSnapshot(writableBody(type, live))))
}

/** Assignment targets only, comparable across reads (IDs Intune assigns are dropped). */
export function assignmentTargets(assignments: Json | undefined): Item[] {
  return (Array.isArray(assignments) ? (assignments as Item[]) : [])
    .filter((assignment) => typeof assignment.source !== "string" || assignment.source === "direct")
    .map((assignment) => cleanAssignment(assignment))
    .map((assignment) => comparableSnapshot(assignment) as Item)
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
}

/** Whether the live assignments are exactly the reviewed ones. */
export function sameAssignments(expected: Item[], actual: Json | undefined): boolean {
  const wanted = assignmentTargets(expected)
  const live = assignmentTargets(actual)
  if (wanted.length !== live.length) return false
  const remaining = [...live]
  return wanted.every((entry) => {
    const index = remaining.findIndex((candidate) => containsExpected(entry, candidate))
    if (index < 0) return false
    remaining.splice(index, 1)
    return true
  })
}

// ---------------------------------------------------------------------------------------------
// Validation and explanation

/** Why an operation is not supported, or undefined. */
export function unsupportedReason(folder: string, action: OperationAction): string | undefined {
  const type = typeForFolder(folder)
  if (!type) return `${folder} is not an Intune type TenuVault knows.`
  const actions = SUPPORTED_OPERATIONS[type.folder]
  if (!actions) return `Change sets do not support ${type.label} yet. Supported: ${Object.keys(SUPPORTED_OPERATIONS).map((folder) => typeForFolder(folder)?.label ?? folder).join(", ")}.`
  if (!actions.includes(action)) return `Change sets do not support ${action} for ${type.label}.`
  return undefined
}

/** What cannot be undone for one operation, in plain language. */
export function irreversibleSteps(operation: Pick<ChangeOperation, "action" | "name" | "setsAssignments">): string[] {
  const notes: string[] = []
  if (operation.action === "delete") notes.push(`Deleting "${operation.name}" is irreversible. A rollback recreates it with a new ID and without assignments; references to the old ID and its reporting history are lost.`)
  if (operation.action === "update") notes.push(`Devices that already received the new settings of "${operation.name}" are not guaranteed to return to the previous values when the captured configuration is written back.`)
  if (operation.action === "create") notes.push(`A rollback deletes "${operation.name}" again; anything added to it after creation is lost.`)
  if (operation.setsAssignments) notes.push(`Assignments of "${operation.name}" change which devices and users receive it as soon as Intune processes the write.`)
  return notes
}

/** Recovery areas no change set covers; shown before every confirmation. */
export const UNSUPPORTED_RECOVERY = [
  "There is no atomic tenant transaction: operations are written one by one and a failure leaves earlier operations in place.",
  "Device-side state, reporting history and per-device results are not captured and cannot be restored.",
  "Objects recreated by a rollback get new IDs and are recreated without assignments.",
  "Values Intune masks (secrets) are not stored; objects that contain them cannot be written back from the capture.",
]

/** The change set status after an apply attempt, from its per-operation results. */
export function statusFromResults(results: OperationResult[]): ChangeSetStatus {
  if (results.length && results.every((result) => result.status === "verified")) return "applied"
  if (results.some((result) => result.status === "uncertain" || result.status === "writing")) return "uncertain"
  if (results.some((result) => result.status === "verified")) return "partial"
  return "failed"
}

/** One plain sentence for the listed record. */
export function resultSummary(results: OperationResult[]): string {
  const count = (status: OperationStatus) => results.filter((result) => result.status === status).length
  const parts = [`${count("verified")} verified`, `${count("failed")} failed`, `${count("uncertain") + count("writing")} uncertain`, `${count("pending")} not attempted`]
  return `${parts.join(", ")} of ${results.length} operation${results.length === 1 ? "" : "s"}.`
}

export function emptyResult(): OperationResult {
  return { status: "pending", objectId: null, message: null, readBack: null, attempts: 0, at: null }
}
