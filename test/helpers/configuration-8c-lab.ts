import { configurationPayload } from "../../src/main/restore/entra-configuration"
import { restoreMatrixRow } from "../../src/shared/intune/restore-matrix"
import type { Item } from "../../src/shared/intune/registry"
import { graphContinuation } from "../../src/shared/graph-continuation"

export const LAB_8C_TENANT = "ffc10f05-e837-4803-81b1-7c4dee678c2a"
export const LAB_8C_APP = "5c61d8c7-4fbf-4779-bbf8-68e37573bdcb"
const prefix = "TV06-TEST-"
const collections = ["UserFlowAttributes", "AccessPackageCatalogs", "DefenderCustomDetectionRules"]
const singletons = ["CrossTenantAccessPolicy", "ExternalIdentitiesPolicy", "AccessReviewPolicy", "LifecycleWorkflowSettings"]
// Guest access and scheduling probes are identical-value-only. Metadata never changes relationships.
const identicalOnly = new Set(["ExternalIdentitiesPolicy", "LifecycleWorkflowSettings"])
const selected: Record<string, string[]> = {
  CrossTenantAccessPolicy: ["displayName"], ExternalIdentitiesPolicy: ["allowExternalIdentitiesToLeave"],
  AccessReviewPolicy: ["isGroupOwnerManagementEnabled"], LifecycleWorkflowSettings: ["workflowScheduleIntervalInHours"],
}
export const LAB_8C_FOLDERS = [...collections, ...singletons]
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const project = (value: Item, keys: string[]): Item => Object.fromEntries(keys.map(key => {
  if (!(key in value)) throw new Error("The live singleton is missing a required property. Nothing will be written.")
  return [key, structuredClone(value[key]!)]
}))
const safe = (value: unknown): void => {
  if (typeof value === "string" && /-----BEGIN .*PRIVATE KEY-----|Bearer\s+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/i.test(value)) throw new Error("Credential value refused")
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    if (/^(password|clientSecret|privateKey|sharedSecret|secret|secretText|tokenSeed|seed|keyCredentials|passwordCredentials|accessToken|refreshToken)$/i.test(key)) throw new Error("Credential property refused")
    safe(child)
  }
}

/** App-only LAB adapter. Never used by the product. It cannot accept a caller's method or path. */
export function configuration8cLab(token: string, tenant: string, app: string, fetchImpl: typeof fetch = fetch, recovery?: { save: (folder: string, original: Item) => void; clear: (folder: string) => void; recordOriginal?: (folder: string, original: Item) => void; recordVerified?: (folder: string, current: Item) => void; recordEvidence?: (event: Item) => void }) {
  if (tenant !== LAB_8C_TENANT || app !== LAB_8C_APP) throw new Error("This harness is restricted to the approved lab app and tenant.")
  let claims: { tid?: string; appid?: string; azp?: string; roles?: string[] }
  try { claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) } catch { throw new Error("Invalid lab token") }
  if (claims.tid !== tenant || (claims.appid ?? claims.azp) !== app) throw new Error("The token does not belong to the approved lab tenant and app")
  for (const folder of [...collections, ...singletons]) {
    const permission = restoreMatrixRow(folder)!.update!.permissions[0]!
    if (!claims.roles?.includes(permission)) throw new Error(`Missing lab application permission: ${permission}`)
  }
  const originals = new Map<string, Item>()
  const pendingRecovery = new Map<string, Item>()
  const unavailable = new Map<string, Error>()

  const urlFor = (folder: string) => {
    if (!LAB_8C_FOLDERS.includes(folder)) throw new Error("Outside the 8c lab allowlist")
    const row = restoreMatrixRow(folder)!
    return `https://graph.microsoft.com/${row.update!.version}/` + row.readPath
  }
  const requestOnce = async (url: string, method = "GET", body?: Item): Promise<Item> => {
    const parsed = new URL(url)
    const allowed = LAB_8C_FOLDERS.some(folder => parsed.pathname === new URL(urlFor(folder)).pathname || (collections.includes(folder) && parsed.pathname.startsWith(new URL(urlFor(folder)).pathname + "/") && /^[A-Za-z0-9_-]+$/.test(parsed.pathname.slice(new URL(urlFor(folder)).pathname.length + 1))))
    if (parsed.origin !== "https://graph.microsoft.com" || parsed.hash || parsed.username || parsed.password || !allowed || (method !== "GET" && parsed.search)) throw new Error("Outside the 8c lab path allowlist")
    if (body) safe(body)
    const response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Accept-Language": "0" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) })
    recovery?.recordEvidence?.({ kind: "http", method, path: parsed.pathname, status: response.status })
    if (method === "DELETE" && response.status === 404) return {}
    if (!response.ok) {
      const code = (await response.json().catch(() => ({})))?.error?.code
      throw new Error(`Lab ${method} ${parsed.pathname} failed (HTTP ${response.status}, ${typeof code === "string" ? code : "unknown"}). Response bodies are not logged.`)
    }
    return response.status === 204 ? {} : response.json()
  }
  const request = async (url: string, method = "GET", body?: Item): Promise<Item> => {
    for (let attempt = 0; ; attempt++) {
      try { return await requestOnce(url, method, body) } catch (error) {
        // A 404 refusal on a newly created policy is safe to retry; a lost response is not.
        if (method !== "PATCH" || !collections.some(folder => url.startsWith(urlFor(folder) + "/")) || !(error instanceof Error) || !error.message.includes("HTTP 404") || attempt >= 59) throw error
        await pause()
      }
    }
  }
  const list = async (folder: string): Promise<Item[]> => {
    const start = urlFor(folder), seen = new Set<string>(), items: Item[] = []
    let next: string | undefined = start
    while (next) {
      if (seen.size > 100) throw new Error("Lab collection did not finish")
      const page = await request(graphContinuation(start, next, seen))
      if (!Array.isArray(page.value) || page.value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("Invalid lab collection")
      items.push(...page.value as Item[])
      if (page["@odata.nextLink"] !== undefined && typeof page["@odata.nextLink"] !== "string") throw new Error("Invalid lab continuation")
      next = page["@odata.nextLink"] as string | undefined
    }
    return items
  }
  const prefixed = (_folder: string, item: Item) => String(item.displayName).startsWith(prefix)
  const pause = () => fetchImpl === fetch ? new Promise(resolve => setTimeout(resolve, 1000)) : Promise.resolve()
  const cleanup = async () => {
    // Recover singletons before a collection delete or the next test can mutate anything.
    await recoverSingletons()
    const failures: string[] = []
    for (const folder of collections) {
      try {
        // Directory collections can briefly return a deleted policy. Re-read before judging cleanup.
        let empty = 0
        for (let attempt = 0; attempt < 60; attempt++) {
          const remaining = (await list(folder)).filter(item => prefixed(folder, item))
          empty = remaining.length ? 0 : empty + 1
          if (empty >= 3) break
          for (const item of remaining) {
            if (typeof item.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(item.id)) throw new Error("Invalid prefixed object identity")
            await request(`${urlFor(folder)}/${encodeURIComponent(item.id)}`, "DELETE")
          }
          await pause()
        }
        if (empty < 3) throw new Error("Prefixed object remains")
      } catch (error) { failures.push(`${folder}: ${error instanceof Error ? error.message : "cleanup failed"}`) }
    }
    if (failures.length) throw new Error(`Cleanup needs attention for: ${failures.join(", ")}. No non-prefixed object was deleted.`)
  }
  const verify = async (folder: string, url: string, expected: Item, attempts = 60) => {
    let different: string[] = []
    for (let attempt = 0; attempt < attempts; attempt++) {
      let current: Item
      try { current = project(await request(url), Object.keys(expected)) } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("HTTP 404")) throw error
        await pause(); continue
      }
      if (folder === "DefenderCustomDetectionRules" && current.status !== "disabled") throw new Error("Detection must stay disabled")
      different = Object.keys(expected).filter(key => !equal(current[key], expected[key]))
      if (!different.length) { recovery?.recordEvidence?.({ kind: "read-back", folder, expected, actual: current, matched: true }); return current }
      await pause()
    }
    throw new Error(`${folder}: read-back did not match properties ${different.join(", ")}`)
  }
  const recoverSingleton = async (folder: string, original: Item) => {
    const url = urlFor(folder)
    const body = original
    for (let attempt = 0; attempt < 5; attempt++) {
      // This retries only the known original, never the experimental write. A lost answer
      // is reconciled before resending, because the original may already be committed.
      try { await request(url, restoreMatrixRow(folder)!.update!.method, body) } catch { /* Read back refusals and lost answers alike. */ }
      try {
        await verify(folder, url, body, 12)
        recovery?.clear(folder)
        pendingRecovery.delete(folder)
        return
      } catch { await pause() }
    }
    throw new Error(`${folder}: original recovery remains unresolved after bounded retries. The recovery file is retained; no further mutation is allowed until recovery succeeds.`)
  }
  const recoverSingletons = async () => {
    for (const [folder, original] of pendingRecovery) await recoverSingleton(folder, original)
  }
  return {
    cleanup,
    async captureOriginals() {
      for (const folder of singletons) {
        try {
          const original = project(await request(urlFor(folder)), selected[folder]!)
          originals.set(folder, original); recovery?.recordOriginal?.(folder, original)
        } catch (error) {
          unavailable.set(folder, error instanceof Error ? error : new Error("Original unavailable"))
        }
      }
    },
    async verifyEndState() {
      await cleanup()
      for (const [folder, original] of originals) { const current = await verify(folder, urlFor(folder), original); recovery?.recordVerified?.(folder, current); console.log(`${folder}: original verified at end of run`) }
      console.log("All 8c collections contain no TV06-TEST- objects.")
    },
    async run(folder: string): Promise<{ folder: string; operations: string; productPath: string }> {
      await recoverSingletons()
      const url = urlFor(folder)
      if (unavailable.has(folder)) throw unavailable.get(folder)!
      if (collections.includes(folder)) {
        const name = prefix + crypto.randomUUID()
        const fixture: Item = folder === "UserFlowAttributes" ? { displayName: name, description: "Lab original", dataType: "string" }
          : folder === "AccessPackageCatalogs" ? { displayName: name, description: "Lab original", state: "unpublished", isExternallyVisible: false }
          : { id: name, displayName: name, description: "Lab original", status: "disabled", queryCondition: { queryText: "DeviceEvents | where false | project Timestamp, DeviceId, ReportId" }, schedule: { frequency: "P1D" }, detectionAction: { alertTemplate: { title: name, description: "Lab only", severity: "informational", recommendedActions: "None" } } }
        const body = configurationPayload(folder, "create", fixture)
        try {
          const created = await request(url, restoreMatrixRow(folder)!.create!.method, body)
          if (typeof created.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(created.id)) throw new Error("The created identity was not confirmed. Cleanup will discover it by prefix.")
          const target = `${url}/${encodeURIComponent(created.id)}`
          await verify(folder, target, body)
          const changed = configurationPayload(folder, "update", folder === "AccessPackageCatalogs" ? { description: "Lab changed", state: "unpublished", isExternallyVisible: false } : { description: "Lab changed" })
          await request(target, "PATCH", changed); await verify(folder, target, changed)
          const restored = configurationPayload(folder, "update", Object.fromEntries(Object.entries(body).filter(([key]) => restoreMatrixRow(folder)!.update!.properties.includes(key))))
          await request(target, "PATCH", restored); await verify(folder, target, restored)
          console.log(`${folder}: create/read/change/restore verified`)
        } catch (error) { console.log(`${folder}: lifecycle failed: ${error instanceof Error ? error.message : "unknown failure"}`); throw error } finally { await cleanup() }
      } else {
        const live = await request(url), original = project(live, selected[folder]!)
        safe(original)
        if (!originals.has(folder)) originals.set(folder, original)
        const build = (body: Item) => configurationPayload(folder, "update", body)
        const body = build(original), changed = structuredClone(body)
        if (folder === "CrossTenantAccessPolicy") changed.displayName = prefix + "metadata"
        if (folder === "AccessReviewPolicy") changed.isGroupOwnerManagementEnabled = !original.isGroupOwnerManagementEnabled
        if (identicalOnly.has(folder) && !equal(body, changed)) throw new Error("Lock-out-risk singleton must be identical")
        // A durable, outside-repository original is required by the real launcher.
        // Injected tests may use memory only. A failed restore leaves the recovery file intact.
        recovery?.recordOriginal?.(folder, original)
        if (!identicalOnly.has(folder)) recovery?.save(folder, original)
        let sent = false
        try {
          const prepared = build(changed)
          // Recheck the preimage before the first mutation. The flag precedes fetch to include lost answers.
          if (!equal(project(await request(url), selected[folder]!), original)) throw new Error("Singleton changed before the lab write")
          if (!identicalOnly.has(folder)) pendingRecovery.set(folder, original)
          sent = true
          await request(url, restoreMatrixRow(folder)!.update!.method, prepared)
          await verify(folder, url, prepared)
        } finally {
          if (sent) {
            if (!identicalOnly.has(folder)) await recoverSingleton(folder, original)
            else await verify(folder, url, body)
          } else if (!identicalOnly.has(folder)) recovery?.clear(folder)
        }
      }
      return { folder, operations: collections.includes(folder) ? "create/read/change/restore/delete" : identicalOnly.has(folder) ? "read/identical-write/read" : "save/change/verify/restore-original/verify", productPath: "Matrix method/path and candidate payload builder only. Signed-in actor, confirmations, journal and guards use injected-fetch verification, not this app-only adapter." }
    },
  }
}
