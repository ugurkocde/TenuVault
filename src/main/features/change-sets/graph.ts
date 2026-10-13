import { readLive, type GraphCall } from "../../../portal/lib/policies/graph-restore"
import { buildRestorePlan, buildUpdatePlan, resolveStep } from "../../../shared/intune/restore-plan"
import type { IntuneType, Item, Json, Step } from "../../../shared/intune/registry"
import { isGraphId } from "../../../shared/security"
import { matchesProposed, operationFingerprint, sameAssignments, sanitizeSnapshot, type OperationAction } from "./model"

/**
 * Graph access of the change-set engine: reading target state, writing one operation through
 * the journaled caller, and reading it back. All paths are relative to the beta endpoint and
 * were verified with Microsoft Graph (see docs/roadmap/141-reviewed-change-sets.md).
 */

const GRAPH = "https://graph.microsoft.com/beta/"
const MAX_PAGES = 500

/** A Graph read that failed; `status` lets callers show 403 as unknown instead of failing. */
export class GraphReadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "GraphReadError"
  }
}

/** The error message Graph returned, without operation IDs. */
export function graphMessage(body: Item, status: number): string {
  const error = body.error as Item | undefined
  const message = typeof error?.message === "string" ? error.message : ""
  try {
    const inner = JSON.parse(message) as { Message?: string }
    if (inner.Message) return inner.Message.split(" - Operation ID")[0]!
  } catch {
    /* plain message */
  }
  return message || `Microsoft Graph returned ${status}`
}

/**
 * Listings reused within one read-only pass, keyed by request path. A caller creates one
 * memo for a single pass and drops it afterwards, so a later pass always lists again and
 * another tenant never shares an entry. A rejected listing is evicted, so a later call in
 * the same pass retries instead of replaying the failure.
 */
export type ListingMemo = Map<string, Promise<Item[]>>

/** A fresh, empty listing memo for one pass. */
export function createListingMemo(): ListingMemo {
  return new Map()
}

/** Every entry of a collection, following @odata.nextLink inside the Graph origin only. */
export function listAll(graph: GraphCall, path: string, memo?: ListingMemo): Promise<Item[]> {
  const cached = memo?.get(path)
  if (cached) return cached
  const listing = listAllFresh(graph, path)
  if (memo) {
    memo.set(path, listing)
    listing.catch(() => {
      if (memo.get(path) === listing) memo.delete(path)
    })
  }
  return listing
}

async function listAllFresh(graph: GraphCall, path: string): Promise<Item[]> {
  const items: Item[] = []
  const seen = new Set<string>()
  let next: string | undefined = path
  while (next) {
    if (seen.has(next) || seen.size >= MAX_PAGES) throw new GraphReadError("Microsoft Graph returned a repeated or endless listing", 502)
    seen.add(next)
    if (/^https?:/i.test(next) && !next.startsWith(GRAPH)) throw new GraphReadError("Invalid Graph continuation link", 502)
    const response = await graph("GET", next.startsWith(GRAPH) ? next.slice(GRAPH.length) : next)
    if (response.status !== 200) throw new GraphReadError(graphMessage(response.body, response.status), response.status)
    if (!Array.isArray(response.body.value)) throw new GraphReadError("Microsoft Graph returned an invalid collection", 502)
    items.push(...(response.body.value as Item[]))
    next = typeof response.body["@odata.nextLink"] === "string" ? response.body["@odata.nextLink"] : undefined
  }
  return items
}

/** Graph says the object does not exist: 404, or 400 ResourceNotFound as Settings Catalog answers reads and deletes. */
const notFound = (response: { status: number; body: Item }): boolean => response.status === 404 || (response.status === 400 && /ResourceNotFound/i.test(JSON.stringify(response.body)))

/** One GET; null on 404 (or the Settings Catalog 400 ResourceNotFound), GraphReadError otherwise. */
export async function getOne(graph: GraphCall, path: string): Promise<Item | null> {
  const response = await graph("GET", path)
  if (response.status === 200) return response.body
  if (notFound(response)) return null
  throw new GraphReadError(graphMessage(response.body, response.status), response.status)
}

/** The live object as a backup reads it, or null when it does not exist. */
export async function readCurrent(graph: GraphCall, type: IntuneType, id: string): Promise<Item | null> {
  let failedStatus = 0
  const tracking: GraphCall = async (method, path, body) => {
    const response = await graph(method, path, body)
    if (response.status >= 300) failedStatus = response.status
    return response
  }
  try {
    return (await readLive(tracking, type, id)) ?? null
  } catch (error) {
    throw new GraphReadError(error instanceof Error ? error.message : String(error), failedStatus || 502)
  }
}

/** IDs of objects of a type whose name equals `name` (case-insensitive). */
export async function sameNameIds(graph: GraphCall, type: IntuneType, name: string, memo?: ListingMemo): Promise<string[]> {
  const items = await listAll(graph, `${type.path}?$select=id,${type.nameKey}`, memo)
  const wanted = name.trim().toLowerCase()
  return items.filter((item) => typeof item[type.nameKey] === "string" && (item[type.nameKey] as string).trim().toLowerCase() === wanted && typeof item.id === "string").map((item) => item.id as string)
}

export interface Observation {
  /** Sanitized live object for update and delete; null when missing or for create. */
  snapshot: Item | null
  redacted: boolean
  sameNameIds: string[]
  fingerprint: string
}

/** Reads what one operation would change in the target and fingerprints it. */
export async function observe(graph: GraphCall, type: IntuneType, operation: { action: OperationAction; targetId: string | null; name: string }, memo?: ListingMemo): Promise<Observation> {
  if (operation.action === "create") {
    const ids = await sameNameIds(graph, type, operation.name, memo)
    return { snapshot: null, redacted: false, sameNameIds: ids, fingerprint: operationFingerprint("create", { snapshot: null, sameNameIds: ids }) }
  }
  const live = await readCurrent(graph, type, operation.targetId!)
  if (!live) return { snapshot: null, redacted: false, sameNameIds: [], fingerprint: "missing" }
  const { snapshot, redacted } = sanitizeSnapshot(type, live)
  return { snapshot, redacted, sameNameIds: [], fingerprint: operationFingerprint(operation.action, { snapshot, sameNameIds: [] }) }
}

export type WriteOutcome =
  /** Every request succeeded; read back next. */
  | { state: "written"; objectId: string }
  /** Graph rejected the first request, so nothing was written; safe to fix and retry. */
  | { state: "rejected"; objectId: string | null; message: string }
  /** A request may or may not have completed, or a follow-up step failed after a write. */
  | { state: "unknown"; objectId: string | null; message: string }

type Sent = { ok: true; body: Item } | { ok: false; rejected: boolean; message: string }

async function send(graph: GraphCall, method: Step["method"], path: string, body?: Item): Promise<Sent> {
  try {
    const response = await graph(method, path, body)
    if (response.status < 300) return { ok: true, body: response.body }
    // Already gone; the read-back confirms it.
    if (method === "DELETE" && notFound(response)) return { ok: true, body: {} }
    const rejected = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
    return { ok: false, rejected, message: graphMessage(response.body, response.status) }
  } catch (error) {
    return { ok: false, rejected: false, message: `Write outcome unknown: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Writes one operation with the journaled caller. `onCreated` runs as soon as Graph returns
 * a created ID, before any follow-up step, so an interruption still leaves the ID on record.
 */
export async function writeOperation(
  graph: GraphCall,
  type: IntuneType,
  input: { action: OperationAction; targetId: string | null; proposed: Item | null; assignments: Item[] | null; current: Item | null },
  onCreated: (id: string) => void,
): Promise<WriteOutcome> {
  const assign = async (id: string): Promise<Sent> => {
    if (!input.assignments) return { ok: true, body: {} }
    if (!type.assign || type.assign === "post") return { ok: false, rejected: true, message: `Assignments cannot be set for ${type.label} by a change set.` }
    return send(graph, "POST", `${type.path}/${encodeURIComponent(id)}/assign`, { [type.assign.key]: input.assignments as Json })
  }
  if (input.action === "delete") {
    const sent = await send(graph, "DELETE", `${type.path}/${encodeURIComponent(input.targetId!)}`)
    if (!sent.ok) return sent.rejected ? { state: "rejected", objectId: input.targetId, message: sent.message } : { state: "unknown", objectId: input.targetId, message: sent.message }
    return { state: "written", objectId: input.targetId! }
  }
  const { assignments: _ignored, ...proposed } = input.proposed ?? {}
  if (input.action === "create") {
    const plan = buildRestorePlan(type, proposed as Item, { includeAssignments: false })
    const created = await send(graph, "POST", plan.create.path, plan.create.body)
    if (!created.ok) return created.rejected ? { state: "rejected", objectId: null, message: created.message } : { state: "unknown", objectId: null, message: created.message }
    const id = created.body.id
    if (!isGraphId(id)) return { state: "unknown", objectId: null, message: "Microsoft Graph did not return a valid ID for the created object. Check Intune before retrying." }
    onCreated(id)
    for (const step of plan.steps.map((entry) => resolveStep(entry, id))) {
      const sent = await send(graph, step.method, step.path, step.body)
      if (!sent.ok) return { state: "unknown", objectId: id, message: `The object was created but a follow-up step failed: ${sent.message}` }
    }
    const assigned = await assign(id)
    if (!assigned.ok) return { state: "unknown", objectId: id, message: `The object was created but its reviewed assignments failed: ${assigned.message}` }
    return { state: "written", objectId: id }
  }
  const steps = buildUpdatePlan(type, proposed as Item, input.targetId!, { includeAssignments: false, current: input.current ?? {} })
  for (const [index, step] of steps.entries()) {
    const sent = await send(graph, step.method, step.path, step.body)
    if (!sent.ok) {
      if (index === 0 && sent.rejected) return { state: "rejected", objectId: input.targetId, message: sent.message }
      return { state: "unknown", objectId: input.targetId, message: index === 0 ? sent.message : `Part of the update was written before a step failed: ${sent.message}` }
    }
  }
  const assigned = await assign(input.targetId!)
  if (!assigned.ok) return { state: "unknown", objectId: input.targetId, message: `The configuration was written but the reviewed assignments failed: ${assigned.message}` }
  return { state: "written", objectId: input.targetId! }
}

export type ReadBack = { state: "match" | "differs" | "missing"; live: Item | null } | { state: "denied"; live: null; message: string }

/** Reads the object after a write and compares it with what was intended. */
export async function readBack(graph: GraphCall, type: IntuneType, input: { action: OperationAction; objectId: string; proposed: Item | null; assignments: Item[] | null }): Promise<ReadBack> {
  let live: Item | null
  try {
    live = await readCurrent(graph, type, input.objectId)
  } catch (error) {
    return { state: "denied", live: null, message: error instanceof Error ? error.message : String(error) }
  }
  if (input.action === "delete") return { state: live ? "differs" : "match", live }
  if (!live) return { state: "missing", live: null }
  const content = matchesProposed(type, input.proposed ?? {}, live)
  const assignments = input.assignments === null || sameAssignments(input.assignments, live.assignments)
  return { state: content && assignments ? "match" : "differs", live }
}
