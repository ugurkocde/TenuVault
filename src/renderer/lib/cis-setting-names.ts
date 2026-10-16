import type { SettingNames } from "../../shared/intune/drift"
import { definitionIds } from "../../shared/frameworks/cis-recommendations"
import type { Json } from "../../shared/frameworks/policies"

/**
 * Display names of Settings Catalog settings and their choice options for the CIS views, read
 * by the main process from Microsoft's public setting definitions. They are the same in every
 * tenant, so one renderer memory cache serves all of them for this app session. Names only make
 * the views easier to read: a failed read leaves the raw values in place.
 */
const names: SettingNames = { settings: {}, options: {} }
/** Lookups in flight by definition id, so a second caller waits for the first instead of giving up. */
const pending = new Map<string, Promise<void>>()
/** Lookups per definition id that came back without a name; bounded so unknown ids are not asked forever. */
const attempts = new Map<string, number>()

/** At most this many definitions are asked for per request, as the main process reads them. */
export const MAX_NAMED_DEFINITIONS = 500
/** An id that still has no name after this many answered lookups is not asked again this session. */
export const MAX_NAME_ATTEMPTS = 3

/** The setting definition IDs held by setting instances, including nested children. */
export function settingDefinitionIdsIn(values: readonly unknown[]): string[] {
  return [...new Set(values.flatMap(value => definitionIds(value as Json)))]
}

/** A copy of the names read so far. */
export function cachedCisSettingNames(): SettingNames {
  return { settings: { ...names.settings }, options: { ...names.options } }
}

async function lookup(tenant: { tenantId: string; appId: string }, ids: string[]): Promise<void> {
  try {
    const response = await fetch("/api/frameworks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cis-setting-names", frameworkId: "cis-benchmarks", tenantId: tenant.tenantId, appId: tenant.appId, ids }) })
    const result = await response.json() as Partial<SettingNames> & { error?: string }
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`)
    Object.assign(names.settings, result.settings ?? {})
    Object.assign(names.options, result.options ?? {})
    // An id without a name (unknown to Graph, or a partly failed batch) may be asked again later, a bounded number of times.
    for (const id of ids) if (!Object.hasOwn(names.settings, id)) attempts.set(id, (attempts.get(id) ?? 0) + 1)
  } finally {
    for (const id of ids) pending.delete(id)
  }
}

/**
 * Reads the names of the given definitions that have none yet, in requests of at most
 * MAX_NAMED_DEFINITIONS, and waits for lookups other callers already started. Resolves with every
 * name read so far; rejects only when nothing could be asked or awaited successfully.
 */
export async function loadCisSettingNames(tenant: { tenantId: string; appId: string }, ids: readonly string[]): Promise<SettingNames> {
  const wanted = [...new Set(ids)].filter(id => !Object.hasOwn(names.settings, id))
  const waiting = [...new Set(wanted.map(id => pending.get(id)).filter((lookup): lookup is Promise<void> => !!lookup))]
  const fresh = wanted.filter(id => !pending.has(id) && (attempts.get(id) ?? 0) < MAX_NAME_ATTEMPTS)
  const started: Promise<void>[] = []
  for (let start = 0; start < fresh.length; start += MAX_NAMED_DEFINITIONS) {
    const chunk = fresh.slice(start, start + MAX_NAMED_DEFINITIONS)
    const request = lookup(tenant, chunk)
    for (const id of chunk) pending.set(id, request)
    started.push(request)
  }
  const outcomes = await Promise.allSettled([...waiting, ...started])
  const failed = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
  if (outcomes.length && failed.length === outcomes.length) throw failed[0]!.reason
  return cachedCisSettingNames()
}

/** For tests. */
export function clearCisSettingNames(): void {
  names.settings = {}
  names.options = {}
  pending.clear()
  attempts.clear()
}
