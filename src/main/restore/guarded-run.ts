import { DirectoryRetryPersistenceError, persistDirectoryRetry, waitForDirectoryRetry } from "./directory-retry"
import { requireConfigurationApproval } from "./entra-configuration"
import { isGraphId } from "../../shared/security"
import { operationProtections, restoreMatrixRow } from "../../shared/intune/restore-matrix"
import { requireRestoreActor } from "./restore-actor"
import { createHash } from "node:crypto"
import type { KeyValueStore } from "../storage/secure-store"
import { restoreCapability, type IntuneType, type Item } from "../../shared/intune/registry"
import { addsOnlyPayload, RestoreSafetyError, RestoreWriteDeferredError, RestoreWriteRefusedError, guardRestoreItem, mergeConsentScopes, restoreOriginBlocker, writableSnapshot, type RestoreActor, type RestoreOrigin, type SafetyReferences } from "../../shared/intune/restore-guards"
import { dependencyOrder, mappedReference, rememberMapping, type ReferenceKind, type ReplacedReference, type RestoreMapping } from "../../shared/intune/restore-references"

export interface GuardedStep {
  directory?: import("./directory-9a").DirectoryIntent
  directoryApprovals?: Record<string, string>
  key: string
  folder: string
  sourceId: string
  operation: "create" | "update"
  targetId?: string
  properties: string[]
  desired: Item
  /** Hash of the exact live object used for preview, including its ETag. Null means absent. */
  preview: string
  requires: string[]
  references?: Array<{ property: string; kind: ReferenceKind; folder: string; source: string }>
  allowRemoval?: boolean
  confirmation?: { kind: string; fingerprint: string }
}
export interface GuardedEntry {
  step: GuardedStep
  state: "pending" | "captured" | "deferred" | "uncertain" | "applied" | "blocked" | "failed" | "failed-before-send"
  /** Earliest retry of a confirmed, unapplied throttle, preserved across cancellation/restart. */
  retryAt?: number
  before?: Item | null
  sent?: Item
  targetId?: string
  reason?: string
}
export interface GuardedRun {
  version: 1
  tenant: string
  id: string
  actor: RestoreActor
  origin: RestoreOrigin
  source?: { path: string; fingerprint: string }
  entries: GuardedEntry[]
  mappings: RestoreMapping[]
  replacedReferences?: ReplacedReference[]
  referenceWarning?: string
}
export interface GuardedIO {
  token: string
  /** Directory pages retain live object ownership across deferred and uncertain steps. */
  prepareStep?: (step: GuardedStep) => number | undefined
  defer?: (step: GuardedStep, retryAt: number) => void
  /** A complete scan of current Intune and Conditional Access references, after replacements. */
  replacedReferences?: (mappings: readonly RestoreMapping[], signal?: AbortSignal) => Promise<ReplacedReference[]>
  type: (folder: string) => IntuneType
  /** Reads through the descriptor's singleton, fixed key or object ID rule. */
  read: (step: GuardedStep, targetId?: string, signal?: AbortSignal) => Promise<Item | null>
  /** Complete descriptor-based lookup. Must reject an incomplete list, never match a guessed name. */
  findCreated: (step: GuardedStep, sent: Item) => Promise<Item[]>
  references: (step: GuardedStep, current: Item | null, desired: Item, signal?: AbortSignal) => Promise<SafetyReferences>
  write: (step: GuardedStep, body: Item, targetId: string | undefined, beforeSend: () => void, run?: GuardedRun, signal?: AbortSignal, onUnapplied?: (retryAt: number) => void) => Promise<{ id?: string }>
}
/** The closed directory adapter refuses privileged links and state changes at its final send boundary.
 * Other writers retain the full descriptor protections, including remaining administrators. */
export const guardedProtections = (step: GuardedStep) => step.directory && ["Users", "Groups"].includes(step.folder) ? ["identity-references"] as const : operationProtections(step.folder, step.operation)
const secretKey = /^(?:passwordProfile|password|passwordCredentials|keyCredentials|clientSecret|privateKey|sharedSecret|secretKey|tokenSeed|seed|tunnelKey|secret|accessToken|refreshToken|clientAssertion|pfx|pkcs12|secretText|authenticationConfiguration|certificateData|deploymentAccessKey)$/i
function assertNoSecrets(value: unknown): void {
  if (typeof value === "string" && /-----BEGIN .*PRIVATE KEY-----|Bearer\s+[\w.-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/i.test(value)) throw new RestoreSafetyError("Credential values cannot be saved in restore history.")
  if (!value || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    if (secretKey.test(key)) throw new RestoreSafetyError("Credential properties cannot be saved in restore history.")
    assertNoSecrets(child)
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical))
  if (value && typeof value === "object") return JSON.stringify(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
  return JSON.stringify(value)
}
export const restoreFingerprint = (value: Item | null): string => createHash("sha256").update(canonical(value)).digest("hex")
const tenantKey = (tenant: string) => `restore.guarded.${encodeURIComponent(tenant.toLowerCase())}`

/** All runs for a tenant share one atomic encrypted value, including unresolved earlier writes. */
export class GuardedRunJournal {
  constructor(private readonly store: KeyValueStore) {}
  private history(tenant: string): { version: 2; runs: Record<string, GuardedRun>; mappings: RestoreMapping[] } {
    const raw = this.store.get(tenantKey(tenant))
    if (raw === null) return { version: 2, runs: {}, mappings: [] }
    let parsed
    try { parsed = JSON.parse(raw) } catch { throw new RestoreSafetyError("Restore history could not be verified. Nothing was written.") }
    const runs = parsed?.version === 2 ? parsed.runs : parsed
    const mappings: RestoreMapping[] = parsed?.version === 2 ? parsed.mappings : []
    if (!Array.isArray(mappings)) throw new RestoreSafetyError("Restore mappings could not be verified.")
    if (!runs || typeof runs !== "object" || Array.isArray(runs) || Object.entries(runs as Record<string, GuardedRun>).some(([id, run]) => !run || run.version !== 1 || run.tenant.toLowerCase() !== tenant.toLowerCase() || run.id !== id || !Array.isArray(run.entries) || !Array.isArray(run.mappings))) throw new RestoreSafetyError("Restore history could not be verified. Nothing was written.")
    return { version: 2, runs, mappings }
  }
  private runs(tenant: string): Record<string, GuardedRun> { return this.history(tenant).runs }
  load(tenant: string, id: string): GuardedRun | undefined {
    const runs = this.runs(tenant)
    return Object.hasOwn(runs, id) ? runs[id] : undefined
  }
  list(tenant: string): GuardedRun[] { return Object.values(this.runs(tenant)) }
  save(run: GuardedRun): void {
    assertNoSecrets(run)
    const history = this.history(run.tenant)
    history.runs[run.id] = run
    // Mappings and unresolved writes survive independently of the bounded settled history.
    for (const previous of Object.values(history.runs)) for (const mapping of previous.mappings) rememberMapping(history.mappings, mapping)
    const settled = Object.values(history.runs).filter(previous => previous.entries.every(entry => ["applied", "blocked", "failed", "failed-before-send"].includes(entry.state)))
    for (const previous of settled.filter(previous => previous.id !== run.id).slice(0, Math.max(0, settled.length - 1000))) delete history.runs[previous.id]
    this.store.set(tenantKey(run.tenant), JSON.stringify(history))
  }
  mappings(tenant: string): RestoreMapping[] {
    const history = this.history(tenant)
    const mappings: RestoreMapping[] = [...history.mappings]
    for (const run of Object.values(history.runs)) for (const mapping of run.mappings) rememberMapping(mappings, mapping)
    return mappings
  }
  hasEarlierUnanswered(run: GuardedRun, step: GuardedStep): boolean {
    return Object.values(this.runs(run.tenant)).some(previous => previous.id !== run.id && previous.entries.some(entry => entry.state === "uncertain" && entry.step.folder === step.folder &&
      (entry.step.sourceId.toLowerCase() === step.sourceId.toLowerCase() || (!!step.targetId && entry.targetId?.toLowerCase() === step.targetId.toLowerCase()) || restoreFingerprint(entry.sent ?? entry.step.desired) === restoreFingerprint(step.desired))))
  }
}
const active = new Set<string>()

/**
 * The only writer for new services. Later layers supply verified request builders. Production safety
 * resolution is provided by the signed-in desktop connection. Legacy writers cannot bypass this by merely enabling a registry capability.
 */
export async function executeGuardedRun(journal: GuardedRunJournal, input: GuardedRun, io: GuardedIO, signal?: AbortSignal, reconcileOnly = false): Promise<{ status: "complete" | "partial"; run: GuardedRun }> {
  const key = input.tenant.toLowerCase()
  if (active.has(key)) throw new RestoreSafetyError("This restore is already running.")
  active.add(key)
  try {
    requireRestoreActor(io.token, input.actor)
    const previous = journal.load(input.tenant, input.id)
    const identity = ({ recoveryAccountIds: _recovery, ...connection }: RestoreActor) => connection
    if (previous && canonical([identity(previous.actor), previous.origin, previous.source, previous.entries.map(entry => entry.step)]) !== canonical([identity(input.actor), input.origin, input.source, input.entries.map(entry => entry.step)])) throw new RestoreSafetyError("The restore identity or plan changed. Preview again with a new run ID.")
    const run = previous ?? structuredClone(input)
    run.actor = structuredClone(input.actor)
    for (const mapping of journal.mappings(run.tenant)) rememberMapping(run.mappings, mapping)
    if (run.actor.tenantId.toLowerCase() !== run.tenant.toLowerCase()) throw new RestoreSafetyError("The restore belongs to another tenant.")
    journal.save(run)
    // A confirmed result must never enter safety-failure handling. Retry its atomic
    // publication once; if storage stays unavailable the durable send marker remains.
    const saveConfirmed = () => {
      try { journal.save(run) }
      catch { journal.save(run) }
    }
    const dependencies = (step: GuardedStep) => [...new Set([...step.requires, ...run.entries.filter(entry => restoreMatrixRow(step.folder)?.dependsOn.includes(entry.step.folder)).map(entry => entry.step.key)])]
    const { order, blocked } = dependencyOrder(run.entries.map(({ step }) => ({ key: step.key, requires: dependencies(step) })))
    for (const entry of run.entries) if (entry.state === "blocked" && entry.reason?.startsWith("Prerequisite ")) { entry.state = "pending"; delete entry.reason }
    for (const entry of run.entries) if (blocked[entry.step.key] && !["applied", "uncertain"].includes(entry.state)) { entry.state = "blocked"; entry.reason = blocked[entry.step.key] }
    journal.save(run)
    for (const itemKey of order) {
      if (signal?.aborted) break
      const entry = run.entries.find(entry => entry.step.key === itemKey)!
      if (["applied", "blocked", "failed", "failed-before-send"].includes(entry.state)) continue
      const step = entry.step
      if (reconcileOnly && entry.state !== "uncertain") continue
      const prerequisite = dependencies(step).find(required => run.entries.find(entry => entry.step.key === required)?.state !== "applied")
      if (prerequisite && entry.state !== "uncertain") { entry.state = "blocked"; entry.reason = `Prerequisite ${prerequisite} did not complete.`; journal.save(run); continue }
      const defer = (retryAt: number) => {
        entry.retryAt = Math.max(entry.retryAt ?? 0, retryAt)
        persistDirectoryRetry(() => journal.save(run), () => io.defer?.(step, entry.retryAt!))
      }
      try {
        if (entry.state === "uncertain") {
          // Neither absence nor repeated old values prove an unanswered write failed: Graph may be eventually consistent.
          // Only a matching read-back can settle it. Confirmed throttles never enter this path.
          const matches = step.operation === "create" ? await io.findCreated(step, entry.sent!) : [await io.read(step, entry.targetId)].filter((item): item is Item => item !== null)
          if (matches.length !== 1 || restoreFingerprint(writableSnapshot(matches[0]!, Object.keys(entry.sent!))) !== restoreFingerprint(entry.sent!)) {
            entry.reason = "The unanswered write could not be uniquely reconciled. Review this item before continuing."
            journal.save(run); continue
          }
          const id = step.operation === "create" ? matches[0]!.id : entry.targetId
          if (!isGraphId(id)) throw new RestoreSafetyError("The reconciled object has no identity.")
          entry.targetId = id
          rememberMapping(run.mappings, { kind: "objectId", folder: step.folder, source: step.sourceId, target: id })
          entry.state = "applied"; delete entry.reason; saveConfirmed(); continue
        }
        const mapped = mappedReference(run.mappings, "objectId", step.folder, step.sourceId)
        if (mapped && step.targetId && mapped.toLowerCase() !== step.targetId.toLowerCase()) throw new RestoreSafetyError("The target mapping changed after this preview. Preview this item again.")
        if (step.directory && step.operation === "create" && mapped) throw new RestoreSafetyError("The object already has a target mapping. Preview it as an update.")
        const objectRetryAt = io.prepareStep?.(step)
        if (objectRetryAt !== undefined) { entry.retryAt = Math.max(entry.retryAt ?? 0, objectRetryAt); journal.save(run) }
        if (entry.retryAt !== undefined) await waitForDirectoryRetry(entry.retryAt, signal)
        const type = io.type(step.folder)
        if (["none", "metadata"].includes(restoreCapability(type)) || (restoreCapability(type) === "singleton" && step.operation === "create")) throw new RestoreSafetyError(type.limitation ?? "This type cannot be restored.")
        requireConfigurationApproval(step, run)
        const originBlock = restoreOriginBlocker(step.folder, run.origin)
        if (originBlock) throw new RestoreSafetyError(originBlock)
        if (journal.hasEarlierUnanswered(run, step)) throw new RestoreSafetyError("An earlier restore has an unanswered write for this object. Resume that run before starting another.")
        const current = await io.read(step, entry.targetId ?? step.targetId ?? mapped, signal)
        if (restoreFingerprint(current) !== step.preview) throw new RestoreSafetyError("The tenant changed after this preview. Preview this item again.")
        if (step.operation === "create" && mapped && current === null) throw new RestoreSafetyError("The previously mapped object is missing. Review its mapping before recreating it again.")
        if (step.operation === "create" && current !== null) throw new RestoreSafetyError("The object already exists. Preview it as an update.")
        if (step.operation === "update" && current === null) throw new RestoreSafetyError("The object no longer exists. Preview it again.")
        const desired = addsOnlyPayload(current, writableSnapshot(step.desired, step.properties), step.allowRemoval)
        if (Object.keys(desired).length !== Object.keys(step.desired).length) throw new RestoreSafetyError("The proposed write contains properties outside its allowlist.")
        for (const reference of step.references ?? []) {
          const target = mappedReference(run.mappings, reference.kind, reference.folder, reference.source)
          if (!target) throw new RestoreSafetyError("A required typed reference has no verified mapping.")
          const parts = reference.property.split(".")
          let parent: Item = desired
          for (const part of parts.slice(0, -1)) {
            const child = parent[part]
            if (!child || typeof child !== "object" || Array.isArray(child)) throw new RestoreSafetyError("A typed reference path could not be resolved.")
            parent = child
          }
          const field = parts.at(-1)!
          if (parent[field] !== reference.source) throw new RestoreSafetyError("A typed reference does not match the reviewed source ID.")
          parent[field] = target
        }
        if (step.folder === "OAuth2PermissionGrants" && "scope" in desired) {
          if (typeof desired.scope !== "string" || (current && typeof current.scope !== "string")) throw new RestoreSafetyError("Consent scopes could not be resolved.")
          desired.scope = mergeConsentScopes(current?.scope as string ?? "", desired.scope, step.allowRemoval)
        }
        const refs = await io.references(step, current, desired, signal)
        guardRestoreItem(run.actor, step.folder, entry.targetId ?? step.targetId ?? mapped, refs, step.allowRemoval === true, guardedProtections(step))
        // Only touched objects are captured, never a whole service. A failed save prevents the write.
        entry.before = current; entry.sent = desired; entry.targetId = entry.targetId ?? step.targetId ?? mapped; entry.state = "captured"; journal.save(run)
        if (signal?.aborted) { entry.state = step.directory ? "deferred" : "captured"; journal.save(run); break }
        let result: { id?: string }
        try {
          result = await io.write(step, desired, entry.targetId, () => {
            if (signal?.aborted) throw new RestoreWriteDeferredError("The directory write was cancelled before sending.")
            const retryAt = entry.retryAt
            entry.state = "uncertain"; delete entry.retryAt
            try { journal.save(run) }
            catch (error) {
              if (step.directory) { entry.state = "captured"; entry.retryAt = retryAt }
              throw error
            }
          }, run, signal, retryAt => {
            entry.state = step.directory ? "deferred" : "captured"; delete entry.reason; defer(retryAt)
          })
        } catch (error) {
          if (error instanceof DirectoryRetryPersistenceError) throw error
          if (error instanceof RestoreWriteDeferredError || (["captured", "deferred"].includes(entry.state) && signal?.aborted)) {
            entry.state = step.directory ? "deferred" : "captured"; delete entry.reason
            if (error instanceof RestoreWriteDeferredError && error.retryAt !== undefined) { defer(error.retryAt) }
          } else if (["captured", "deferred"].includes(entry.state)) {
            entry.state = "failed-before-send"
            entry.reason = "The write was not sent. Preview this item again."
          } else if (error instanceof RestoreWriteRefusedError) {
            entry.state = "failed"; entry.reason = error.message
          } else entry.reason = "The write did not return a confirmed result. It must be read back before any retry."
          journal.save(run); continue
        }
        const id = result.id ?? entry.targetId
        if (!isGraphId(id)) { entry.reason = "The write did not return an object ID. It must be read back before continuing."; journal.save(run); continue }
        entry.targetId = id
        rememberMapping(run.mappings, { kind: "objectId", folder: step.folder, source: step.sourceId, target: id })
        entry.state = "applied"; saveConfirmed()
      } catch (error) {
        if (entry.state === "applied" || error instanceof DirectoryRetryPersistenceError) throw error
        if (entry.state === "uncertain" && error instanceof RestoreWriteDeferredError && error.retryAt !== undefined) {
          defer(error.retryAt)
          entry.reason = "Microsoft Graph deferred confirmation of this unanswered write. Retry after the saved deadline."
        }
        if (entry.state !== "uncertain" && (error instanceof RestoreWriteDeferredError || signal?.aborted)) {
          entry.state = step.directory ? "deferred" : "captured"; delete entry.reason
          if (error instanceof RestoreWriteDeferredError && error.retryAt !== undefined) { defer(error.retryAt) }
          journal.save(run); continue
        }
        // Never persist service error bodies: they may contain credential values or submitted payloads.
        if (entry.state !== "uncertain") { if (entry.state !== "failed") entry.state = "blocked"; entry.reason = error instanceof RestoreSafetyError ? error.message : "This item failed a restore safety check. Preview and resolve its prerequisites before continuing." }
        journal.save(run)
      }
    }
    const replacements = run.mappings.filter(mapping => mapping.source.toLowerCase() !== mapping.target.toLowerCase())
    if (replacements.length) {
      try {
        if (!io.replacedReferences) throw new Error("Reference scan unavailable")
        run.replacedReferences = await io.replacedReferences(replacements, signal)
        delete run.referenceWarning
      } catch { run.referenceWarning = "The Intune and Conditional Access reference scan did not complete. Review references to replaced IDs before activating restored policies." }
      journal.save(run)
    }
    return { status: run.entries.every(entry => entry.state === "applied") && !run.referenceWarning ? "complete" : "partial", run }
  } finally { active.delete(key) }
}
