import { isGraphId } from "../../shared/security"
import { restoreMatrixRow } from "../../shared/intune/restore-matrix"
import { requireRestoreActor } from "./restore-actor"
import { createHash } from "node:crypto"
import type { KeyValueStore } from "../storage/secure-store"
import { restoreCapability, type IntuneType, type Item } from "../../shared/intune/registry"
import { addsOnlyPayload, RestoreSafetyError, RestoreWriteRefusedError, guardRestoreItem, mergeConsentScopes, restoreOriginBlocker, writableSnapshot, type RestoreActor, type RestoreOrigin, type SafetyReferences } from "../../shared/intune/restore-guards"
import { dependencyOrder, mappedReference, rememberMapping, type ReferenceKind, type ReplacedReference, type RestoreMapping } from "../../shared/intune/restore-references"

export interface GuardedStep {
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
}
export interface GuardedEntry {
  step: GuardedStep
  state: "pending" | "captured" | "uncertain" | "applied" | "blocked" | "failed"
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
  entries: GuardedEntry[]
  mappings: RestoreMapping[]
  replacedReferences?: ReplacedReference[]
  referenceWarning?: string
}
export interface GuardedIO {
  token: string
  /** A complete scan of current Intune and Conditional Access references, after replacements. */
  replacedReferences?: (mappings: readonly RestoreMapping[]) => Promise<ReplacedReference[]>
  type: (folder: string) => IntuneType
  /** Reads through the descriptor's singleton, fixed key or object ID rule. */
  read: (step: GuardedStep, targetId?: string) => Promise<Item | null>
  /** Complete descriptor-based lookup. Must reject an incomplete list, never match a guessed name. */
  findCreated: (step: GuardedStep, sent: Item) => Promise<Item[]>
  references: (step: GuardedStep, current: Item | null, desired: Item) => Promise<SafetyReferences>
  write: (step: GuardedStep, body: Item, targetId?: string) => Promise<{ id?: string }>
}
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
  private runs(tenant: string): Record<string, GuardedRun> {
    const raw = this.store.get(tenantKey(tenant))
    if (raw === null) return {}
    let runs: Record<string, GuardedRun>
    try { runs = JSON.parse(raw) as Record<string, GuardedRun> } catch { throw new RestoreSafetyError("Restore history could not be verified. Nothing was written.") }
    if (!runs || typeof runs !== "object" || Array.isArray(runs) || Object.entries(runs).some(([id, run]) => !run || run.version !== 1 || run.tenant.toLowerCase() !== tenant.toLowerCase() || run.id !== id || !Array.isArray(run.entries) || !Array.isArray(run.mappings))) throw new RestoreSafetyError("Restore history could not be verified. Nothing was written.")
    return runs
  }
  load(tenant: string, id: string): GuardedRun | undefined {
    const runs = this.runs(tenant)
    return Object.hasOwn(runs, id) ? runs[id] : undefined
  }
  save(run: GuardedRun): void {
    assertNoSecrets(run)
    const runs = this.runs(run.tenant)
    if (!Object.hasOwn(runs, run.id) && Object.keys(runs).length >= 1000) throw new RestoreSafetyError("Restore history is full. Review earlier runs before continuing.")
    this.store.set(tenantKey(run.tenant), JSON.stringify({ ...runs, [run.id]: run }))
  }
  mappings(tenant: string): RestoreMapping[] {
    const mappings: RestoreMapping[] = []
    for (const run of Object.values(this.runs(tenant))) for (const mapping of run.mappings) rememberMapping(mappings, mapping)
    return mappings
  }
  hasEarlierUnanswered(run: GuardedRun, step: GuardedStep): boolean {
    return Object.values(this.runs(run.tenant)).some(previous => previous.id !== run.id && previous.entries.some(entry => entry.state === "uncertain" && entry.step.folder === step.folder &&
      (entry.step.sourceId.toLowerCase() === step.sourceId.toLowerCase() || (!!step.targetId && entry.targetId?.toLowerCase() === step.targetId.toLowerCase()) || restoreFingerprint(entry.sent ?? entry.step.desired) === restoreFingerprint(step.desired))))
  }
}
const active = new Set<string>()

/**
 * The only writer for new services. Later layers supply verified request builders and live safety
 * resolution. Legacy writers cannot bypass this by merely enabling a registry capability.
 */
export async function executeGuardedRun(journal: GuardedRunJournal, input: GuardedRun, io: GuardedIO, signal?: AbortSignal): Promise<{ status: "complete" | "partial"; run: GuardedRun }> {
  const key = input.tenant.toLowerCase()
  if (active.has(key)) throw new RestoreSafetyError("This restore is already running.")
  active.add(key)
  try {
    requireRestoreActor(io.token, input.actor)
    const previous = journal.load(input.tenant, input.id)
    if (previous && canonical([previous.actor, previous.origin, previous.entries.map(entry => entry.step)]) !== canonical([input.actor, input.origin, input.entries.map(entry => entry.step)])) throw new RestoreSafetyError("The restore identity or plan changed. Preview again with a new run ID.")
    const run = previous ?? structuredClone(input)
    if (!previous) for (const mapping of journal.mappings(run.tenant)) rememberMapping(run.mappings, mapping)
    if (run.actor.tenantId.toLowerCase() !== run.tenant.toLowerCase()) throw new RestoreSafetyError("The restore belongs to another tenant.")
    journal.save(run)
    const dependencies = (step: GuardedStep) => [...new Set([...step.requires, ...run.entries.filter(entry => restoreMatrixRow(step.folder)?.dependsOn.includes(entry.step.folder)).map(entry => entry.step.key)])]
    const { order, blocked } = dependencyOrder(run.entries.map(({ step }) => ({ key: step.key, requires: dependencies(step) })))
    for (const entry of run.entries) if (entry.state === "blocked" && entry.reason?.startsWith("Prerequisite ")) { entry.state = "pending"; delete entry.reason }
    for (const entry of run.entries) if (blocked[entry.step.key] && entry.state !== "applied") { entry.state = "blocked"; entry.reason = blocked[entry.step.key] }
    journal.save(run)
    for (const itemKey of order) {
      if (signal?.aborted) break
      const entry = run.entries.find(entry => entry.step.key === itemKey)!
      if (["applied", "blocked", "failed"].includes(entry.state)) continue
      const step = entry.step
      const prerequisite = dependencies(step).find(required => run.entries.find(entry => entry.step.key === required)?.state !== "applied")
      if (prerequisite) { entry.state = "blocked"; entry.reason = `Prerequisite ${prerequisite} did not complete.`; journal.save(run); continue }
      try {
        const type = io.type(step.folder)
        if (restoreCapability(type) === "none") throw new RestoreSafetyError(type.limitation ?? "This type cannot be restored.")
        const originBlock = restoreOriginBlocker(step.folder, run.origin)
        if (originBlock) throw new RestoreSafetyError(originBlock)
        if (entry.state === "uncertain") {
          // Absence after an unanswered create is not proof of failure: Graph may be eventually consistent.
          const matches = step.operation === "create" ? await io.findCreated(step, entry.sent!) : [await io.read(step, entry.targetId)].filter((item): item is Item => item !== null)
          if (matches.length !== 1 || restoreFingerprint(writableSnapshot(matches[0]!, Object.keys(entry.sent!))) !== restoreFingerprint(entry.sent!)) {
            entry.reason = "The unanswered write could not be uniquely reconciled. Review this item before continuing."
            journal.save(run); continue
          }
          const id = step.operation === "create" ? matches[0]!.id : entry.targetId
          if (!isGraphId(id)) throw new RestoreSafetyError("The reconciled object has no identity.")
          entry.targetId = id
          rememberMapping(run.mappings, { kind: "objectId", folder: step.folder, source: step.sourceId, target: id })
          entry.state = "applied"; delete entry.reason; journal.save(run); continue
        }
        if (journal.hasEarlierUnanswered(run, step)) throw new RestoreSafetyError("An earlier restore has an unanswered write for this object. Resume that run before starting another.")
        const mapped = mappedReference(run.mappings, "objectId", step.folder, step.sourceId)
        const current = await io.read(step, entry.targetId ?? step.targetId ?? mapped)
        if (restoreFingerprint(current) !== step.preview) throw new RestoreSafetyError("The tenant changed after this preview. Preview this item again.")
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
        const refs = await io.references(step, current, desired)
        guardRestoreItem(run.actor, step.folder, step.targetId, refs, step.allowRemoval === true)
        // Only touched objects are captured, never a whole service. A failed save prevents the write.
        entry.before = current; entry.sent = desired; entry.targetId = step.targetId; entry.state = "captured"; journal.save(run)
        if (signal?.aborted) break
        entry.state = "uncertain"; journal.save(run)
        let result: { id?: string }
        try { result = await io.write(step, desired, entry.targetId) } catch (error) { if (error instanceof RestoreSafetyError) { entry.state = error instanceof RestoreWriteRefusedError ? "failed" : "blocked"; throw error } entry.reason = "The write did not return a confirmed result. It must be read back before any retry."; journal.save(run); continue }
        const id = result.id ?? entry.targetId
        if (!isGraphId(id)) { entry.reason = "The write did not return an object ID. It must be read back before continuing."; journal.save(run); continue }
        entry.targetId = id
        rememberMapping(run.mappings, { kind: "objectId", folder: step.folder, source: step.sourceId, target: id })
        entry.state = "applied"; journal.save(run)
      } catch (error) {
        // Never persist service error bodies: they may contain credential values or submitted payloads.
        if (entry.state !== "uncertain") { if (entry.state !== "failed") entry.state = "blocked"; entry.reason = error instanceof RestoreSafetyError ? error.message : "This item failed a restore safety check. Preview and resolve its prerequisites before continuing." }
        journal.save(run)
      }
    }
    const replacements = run.mappings.filter(mapping => mapping.source.toLowerCase() !== mapping.target.toLowerCase())
    if (replacements.length) {
      try {
        if (!io.replacedReferences) throw new Error("Reference scan unavailable")
        run.replacedReferences = await io.replacedReferences(replacements)
        delete run.referenceWarning
      } catch { run.referenceWarning = "The Intune and Conditional Access reference scan did not complete. Review references to replaced IDs before activating restored policies." }
      journal.save(run)
    }
    return { status: run.entries.every(entry => entry.state === "applied") && !run.referenceWarning ? "complete" : "partial", run }
  } finally { active.delete(key) }
}
