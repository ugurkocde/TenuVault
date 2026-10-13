import { parseDependencyMappings } from "../../../shared/intune/recovery"
import { dependencyReferences, type DependencyReference } from "../../../shared/intune/dependencies"
import { randomUUID } from "node:crypto"
import { typeForFolder, type IntuneType, type Item, type Json, type Step } from "../../../shared/intune/registry"

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
import { buildRestorePlan, buildUpdatePlan, NotRestorableError, resolveStep, restoreBlocker } from "../../../shared/intune/restore-plan"
import { assignmentsUnread, readObject, type GraphReader } from "../../../shared/intune/read"
import { sameSnapshot } from "../../../shared/intune/compare"
import { saveWrite, removeWrite, writeKey, writeRecords } from "../../../main/storage/restore-journal"

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
}

export interface RestoreOutcome {
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
}

export type GraphCall = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: Item) => Promise<{ status: number; body: Item }>

const GRAPH = "https://graph.microsoft.com/beta/"
/** Far above any real collection; stops a listing whose continuation links never end. */
const MAX_LIST_PAGES = 5_000

export interface GraphRetryOptions {
  refreshToken?: () => Promise<string>
  tenant?: string
  sleep?: (milliseconds: number) => Promise<void>
}
function matchesCreationFields(expected: Json, actual: Json | undefined): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((entry, index) => matchesCreationFields(entry, actual[index]))
  if (expected && typeof expected === "object") return !!actual && typeof actual === "object" && !Array.isArray(actual) && Object.entries(expected).every(([key, value]) => matchesCreationFields(value, actual[key]))
  return expected === actual
}
export function graphCaller(token: string, fetchImpl: typeof fetch = fetch, options: GraphRetryOptions = {}): GraphCall {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  return async (method, path, body) => {
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
          const reader = graphCaller(token, fetchImpl, { ...options, tenant: undefined })
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
      if (key) saveWrite({ key, tenant: options.tenant!, method, path, at: new Date().toISOString(), state: "uncertain", label })
      let response: Response
      try {
        response = await fetchImpl(`${GRAPH}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body && method !== "DELETE" ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(60_000),
        })
      } catch (error) {
        if (method === "GET" && attempt < 3) { await sleep(1000 * 2 ** attempt); continue }
        throw error
      }
      const text = await response.text()
      let parsed: Item = {}
      try { parsed = text ? JSON.parse(text) as Item : {} } catch { /* An unreadable success remains uncertain. */ }
      const rejected = response.status >= 400 && response.status < 500 && response.status !== 408
      if (key && rejected) removeWrite(key)
      if (response.status === 401 && options.refreshToken && !refreshed && attempt < 3) {
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
      if (key && response.ok && (!createsObject || typeof parsed.id === "string")) saveWrite({ key, tenant: options.tenant!, method, path, at: new Date().toISOString(), state: "complete", label, ...(typeof parsed.id === "string" ? { objectId: parsed.id } : {}) })
      return { status: response.status, body: parsed }
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

export class DependencyMappingError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export class Restorer {
  /** Old object ID to new object ID, for objects recreated during this restore. */
  private readonly remapped = new Map<string, string>()
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

  async restore(path: string, snapshot: Item): Promise<RestoreOutcome> {
    const folder = path.split("/")[1] ?? ""
    const type = typeForFolder(folder === "DeviceCompliancePolicies" ? "CompliancePolicies" : folder)
    if (!type) return { success: false, path, error: "This backup file is not an Intune type TenuVault can restore." }
    const source = this.remap(this.options.crossTenant ? forOtherTenant(snapshot) : snapshot)
    // A backup that could not read the assignments must not replace the live ones with an empty list.
    const unread = this.options.assignments && !this.options.crossTenant && assignmentsUnread(type, snapshot)
    const assignments = this.options.assignments && !this.options.crossTenant && !unread
    const withNote = (outcome: RestoreOutcome): RestoreOutcome => unread && outcome.success
      ? { ...outcome, warnings: [...(outcome.warnings ?? []), "Assignments were not restored: this backup was made by an earlier TenuVault version that could not read them. Assign the policy in Intune."] }
      : outcome
    try {
      const current = this.options.mode === "replace" && typeof snapshot.id === "string" ? await this.current(type, snapshot.id) : undefined
      if (current && this.matches(snapshot, current, assignments)) {
        const name = current[type.nameKey] ?? current.displayName ?? current.name
        return withNote({ success: true, path, policyId: snapshot.id as string, policyName: typeof name === "string" ? name : undefined, action: "unchanged" })
      }
      if (current) return withNote(await this.update(type, path, source, snapshot.id as string, current, assignments))
      const blocker = restoreBlocker(type, source)
      if (blocker) return { success: false, path, action: "skipped", error: blocker }
      return withNote(await this.create(type, path, source, snapshot, assignments))
    } catch (error) {
      return { success: false, path, retryable: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async create(type: IntuneType, path: string, source: Item, snapshot: Item, assignments: boolean): Promise<RestoreOutcome> {
    const plan = buildRestorePlan(type, source, {
      prefix: this.options.mode === "copy" ? (this.options.prefix ?? "[Restored]") : undefined,
      includeAssignments: assignments,
    })
    const bodies = [plan.create, ...plan.steps, ...(this.options.crossTenant ? plan.assignments : [])]
    const unresolved = await this.unresolved(bodies.flatMap(step => dependencyReferences(step.body)))
    if (unresolved.length) return { success: false, path, retryable: false, error: this.options.crossTenant
      ? `Unresolved target dependencies (${unresolved.join(", ")}). Copy the dependencies first or reconcile this object in the target tenant.`
      : `Unresolved dependencies (${unresolved.join(", ")}). Restore the dependencies first or reconcile this object in Intune.` }
    const created = await this.graph("POST", plan.create.path, plan.create.body)
    if (created.status >= 300) return { success: false, path, retryable: created.status < 500 && created.status !== 408, error: errorMessage(created.body, created.status) }
    const id = String(created.body.id ?? "")
    if (!id) return { success: false, path, retryable: false, error: "Microsoft Graph did not return an ID. Check Intune before retrying." }
    if (typeof snapshot.id === "string" && !this.reviewed.has(snapshot.id.toLowerCase())) this.remapped.set(snapshot.id, id)
    const outcome = await this.complete(type, path, id, created.body, "created", [...plan.steps, ...plan.assignments])
    if (plan.assignments.length && type.assignmentWarning) outcome.warnings = [...(outcome.warnings ?? []), type.assignmentWarning]
    return outcome
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
   * clearly, and undefined when it does not (for example a permission or server error), so a
   * failed check never masquerades as a missing dependency.
   */
  private async existsLive(path: string, id: string): Promise<boolean | undefined> {
    const cached = this.liveDependencies.get(path)
    if (cached !== undefined) return cached
    let exists: boolean | undefined
    try {
      const response = await this.graph("GET", path)
      const readId = response.body?.id
      if (response.status < 300) exists = readId === undefined ? undefined : String(readId).toLowerCase() === id.toLowerCase()
      else if (response.status === 404 || (response.status === 400 && /ResourceNotFound/i.test(JSON.stringify(response.body)))) exists = false
    } catch {
      exists = undefined
    }
    if (exists !== undefined) this.liveDependencies.set(path, exists)
    return exists
  }

  private async update(type: IntuneType, path: string, source: Item, id: string, current: Item, assignments: boolean): Promise<RestoreOutcome> {
    const plan = buildUpdatePlan(type, source, id, { includeAssignments: assignments, current })
    return this.complete(type, path, id, source, "updated", plan)
  }

  /** Whether the live object already holds the backed-up configuration (and assignments, when those are restored). */
  private matches(snapshot: Item, current: Item, assignments: boolean): boolean {
    if (assignments) return sameSnapshot(snapshot, current)
    const { assignments: _a, ...wanted } = snapshot
    const { assignments: _b, ...live } = current
    return sameSnapshot(wanted, live)
  }

  /** A repair replays only rejected/unattempted steps against the object already created. */
  async repair(path: string, token: string): Promise<RestoreOutcome> {
    const entry = repairs.get(token)
    if (!entry || entry.expires < Date.now() || entry.path !== path || entry.scope !== (this.options.repairScope ?? this.instanceScope)) {
      return { success: false, path, retryable: false, error: "Repair is unavailable or expired. Check the existing object in Intune; do not create another copy." }
    }
    // Consume before awaiting to prevent concurrent requests replaying additive steps.
    repairs.delete(token)
    if (entry.action === "updated") {
      try {
        const current = await this.current(entry.type, entry.id)
        if (!current || !entry.expectedCurrent || !sameSnapshot(current, entry.expectedCurrent)) throw new Error("The live object changed after the failed restore. Review it and start a fresh replacement.")
      } catch (error) {
        return { success: false, path, partial: true, policyId: entry.id, retryable: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    return this.complete(entry.type, path, entry.id, entry.body, entry.action, entry.steps)
  }

  private async complete(type: IntuneType, path: string, id: string, body: Item, action: "created" | "updated", steps: Step[]): Promise<RestoreOutcome> {
    const name = body[type.nameKey] ?? body.displayName ?? body.name
    const base = { path, policyId: id, policyName: typeof name === "string" ? name : undefined, action }
    const resolved = steps.map((step) => resolveStep(step, id))
    for (const [index, step] of resolved.entries()) {
      let message: string | undefined
      let safeToRetry = false
      try {
        const response = await this.graph(step.method, step.path, step.body)
        if (response.status < 300) continue
        message = `${step.kind === "assignments" ? "Assignments" : "Settings"} could not be restored: ${errorMessage(response.body, response.status)}`
        safeToRetry = response.status < 500 && response.status !== 408
      } catch (error) {
        message = `Write outcome unknown: ${error instanceof Error ? error.message : String(error)}. Check Intune before retrying.`
      }
      let repairToken: string | undefined
      let expectedCurrent: Item | undefined
      if (safeToRetry && action === "updated") {
        try { expectedCurrent = await this.current(type, id) } catch { /* No repair token without a reliable baseline. */ }
        if (!expectedCurrent) { safeToRetry = false; message += " The live object could not be checked; review it in Intune before another replacement." }
      }
      if (safeToRetry) {
        for (const [key, entry] of repairs) if (entry.expires < Date.now()) repairs.delete(key)
        if (repairs.size >= 1000) repairs.delete(repairs.keys().next().value!)
        repairToken = randomUUID()
        repairs.set(repairToken, { scope: this.options.repairScope ?? this.instanceScope, path, type, id, body, action,
          steps: resolved.slice(index), expectedCurrent, expires: Date.now() + 60 * 60 * 1000 })
      }
      return { ...base, success: false, partial: true, retryable: safeToRetry, repairToken, error: message, warnings: [message!] }
    }
    return { ...base, success: true }
  }

  /** The live object read like a backup, or undefined when it was deleted. */
  current(type: IntuneType, id: string): Promise<Item | undefined> {
    return readLive(this.graph, type, id)
  }

  /** Reviewed mappings only rewrite dependency references, never configuration text. */
  private remap(snapshot: Item): Item {
    const guids = [...this.remapped].filter(([from]) => GUID.test(from) && !this.reviewed.has(from.toLowerCase()))
    const walk = (value: Json, key = "", parent = ""): Json => {
      if (typeof value === "string") {
        const reference = /(?:Id|Ids)$/.test(key) || (key === "id" && parent === "categories")
        const binding = key === "@odata.id" || key.endsWith("@odata.bind")
        if (reference) {
          const reviewed = this.reviewed.get(value.toLowerCase())
          if (reviewed) return reviewed
        }
        if (binding && value.startsWith("https://graph.microsoft.com/beta/")) {
          return value.replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi, id => this.reviewed.get(id.toLowerCase()) ?? this.remapped.get(id) ?? id)
        }
        const exact = this.reviewed.has(value.toLowerCase()) ? undefined : this.remapped.get(value)
        if (exact) return exact
        return guids.reduce((text, [from, to]) => text.replace(new RegExp(from, "gi"), to), value)
      }
      if (Array.isArray(value)) return value.map(entry => walk(entry, key, parent))
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([child, entry]) => [child, walk(entry, child, key)]))
      return value
    }
    return walk(snapshot) as Item
  }


}

/** The live object read like a backup, or undefined when it was deleted. */
export async function readLive(graph: GraphCall, type: IntuneType, id: string): Promise<Item | undefined> {
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
  try {
    return await readObject(type, id, reader)
  } catch (error) {
    if (error instanceof Gone) return undefined
    throw error
  }
}

export { NotRestorableError }
