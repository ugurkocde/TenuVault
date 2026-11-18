import { configurationPayload } from "../../src/main/restore/entra-configuration"
import { restoreMatrixRow } from "../../src/shared/intune/restore-matrix"
import type { Item } from "../../src/shared/intune/registry"
import { graphContinuation } from "../../src/shared/graph-continuation"

export const LAB_8B_TENANT = "ffc10f05-e837-4803-81b1-7c4dee678c2a"
export const LAB_8B_APP = "5c61d8c7-4fbf-4779-bbf8-68e37573bdcb"
const prefix = "TV06-TEST-"
const collections = ["PermissionGrantPolicies", "TokenLifetimePolicies", "ActivityBasedTimeoutPolicies"]
const singletons = ["AuthorizationPolicy", "SecurityDefaults", "AuthenticationMethodsPolicy", "AdminConsentRequestPolicy", "AuthenticationFlowsPolicy", "EntraCompanyBranding"]
const identicalOnly = new Set(["AuthorizationPolicy", "SecurityDefaults", "AuthenticationMethodsPolicy"])
const selected: Record<string, string[]> = {
  AuthorizationPolicy: ["displayName"], SecurityDefaults: ["isEnabled"], AuthenticationMethodsPolicy: ["registrationEnforcement"],
  AdminConsentRequestPolicy: ["isEnabled", "notifyReviewers", "remindersEnabled", "requestDurationInDays", "reviewers"],
  AuthenticationFlowsPolicy: ["selfServiceSignUp"], EntraCompanyBranding: ["usernameHintText"],
}
export const LAB_8B_FOLDERS = [...collections, ...singletons]
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
export function configurationLab(token: string, tenant: string, app: string, fetchImpl: typeof fetch = fetch, recovery?: { save: (folder: string, original: Item) => void; clear: (folder: string) => void }) {
  if (tenant !== LAB_8B_TENANT || app !== LAB_8B_APP) throw new Error("This harness is restricted to the approved lab app and tenant.")
  let claims: { tid?: string; appid?: string; azp?: string; roles?: string[] }
  try { claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) } catch { throw new Error("Invalid lab token") }
  if (claims.tid !== tenant || (claims.appid ?? claims.azp) !== app) throw new Error("The token does not belong to the approved lab tenant and app")
  const originals = new Map<string, Item>()
  const root = "https://graph.microsoft.com/v1.0/"
  const urlFor = (folder: string) => {
    if (!LAB_8B_FOLDERS.includes(folder)) throw new Error("Outside the 8b lab allowlist")
    const row = restoreMatrixRow(folder)!
    return root + row.readPath.replace("{organizationId}", tenant)
  }
  const requestOnce = async (url: string, method = "GET", body?: Item): Promise<Item> => {
    const parsed = new URL(url)
    const allowed = LAB_8B_FOLDERS.some(folder => parsed.pathname === new URL(urlFor(folder)).pathname || (collections.includes(folder) && parsed.pathname.startsWith(new URL(urlFor(folder)).pathname + "/") && /^[A-Za-z0-9_-]+$/.test(parsed.pathname.slice(new URL(urlFor(folder)).pathname.length + 1))))
    if (parsed.origin !== "https://graph.microsoft.com" || parsed.hash || parsed.username || parsed.password || !allowed || (method !== "GET" && parsed.search)) throw new Error("Outside the 8b lab path allowlist")
    if (body) safe(body)
    const response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Accept-Language": "0" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) })
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
  const prefixed = (folder: string, item: Item) => String(folder === "PermissionGrantPolicies" ? item.id : item.displayName).startsWith(prefix)
  const pause = () => fetchImpl === fetch ? new Promise(resolve => setTimeout(resolve, 1000)) : Promise.resolve()
  const cleanup = async () => {
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
  const verify = async (folder: string, url: string, expected: Item) => {
    let different: string[] = []
    for (let attempt = 0; attempt < 60; attempt++) {
      let current: Item
      try { current = project(await request(url), Object.keys(expected)) } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("HTTP 404")) throw error
        await pause(); continue
      }
      different = Object.keys(expected).filter(key => !(folder === "EntraCompanyBranding" && key === "usernameHintText" && expected[key] === null && current[key] === "") && !equal(current[key], expected[key]))
      if (!different.length) return
      await pause()
    }
    throw new Error(`${folder}: read-back did not match properties ${different.join(", ")}`)
  }
  return {
    cleanup,
    async captureOriginals() {
      for (const folder of singletons) originals.set(folder, project(await request(urlFor(folder)), selected[folder]!))
    },
    async verifyEndState() {
      await cleanup()
      for (const [folder, original] of originals) { await verify(folder, urlFor(folder), original); console.log(`${folder}: original verified at end of run`) }
      console.log("All three policy collections contain no TV06-TEST- objects.")
    },
    brandingAllowed: claims.roles?.includes("OrganizationalBranding.ReadWrite.All") === true && !claims.roles?.includes("Organization.ReadWrite.All"),
    async run(folder: string): Promise<{ folder: string; operations: string; productPath: string }> {
      if (folder === "EntraCompanyBranding" && (!claims.roles?.includes("OrganizationalBranding.ReadWrite.All") || claims.roles?.includes("Organization.ReadWrite.All"))) throw new Error("Branding requires the narrow role and absence of Organization.ReadWrite.All")
      const url = urlFor(folder)
      if (collections.includes(folder)) {
        const name = prefix + crypto.randomUUID()
        const fixture: Item = folder === "PermissionGrantPolicies" ? { id: name, displayName: name, description: "Lab original" } : { displayName: name, isOrganizationDefault: false, definition: [JSON.stringify(folder === "TokenLifetimePolicies" ? { TokenLifetimePolicy: { Version: 1, AccessTokenLifetime: "01:00:00" } } : { ActivityBasedTimeoutPolicy: { Version: 1, ApplicationPolicies: [{ ApplicationId: "default", WebSessionIdleTimeout: "00:05:00" }] } })] }
        const body = configurationPayload(folder, "create", fixture)
        try {
          const created = await request(url, restoreMatrixRow(folder)!.create!.method, body)
          if (typeof created.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(created.id)) throw new Error("The created identity was not confirmed. Cleanup will discover it by prefix.")
          const target = `${url}/${encodeURIComponent(created.id)}`
          await verify(folder, target, body)
          const changed = configurationPayload(folder, "update", { displayName: name + "-changed" })
          await request(target, "PATCH", changed); await verify(folder, target, changed)
          const restored = configurationPayload(folder, "update", Object.fromEntries(Object.entries(body).filter(([key]) => key !== "id")))
          await request(target, "PATCH", restored); await verify(folder, target, restored)
          console.log(`${folder}: create/read/change/restore verified`)
        } catch (error) { console.log(`${folder}: lifecycle failed: ${error instanceof Error ? error.message : "unknown failure"}`); throw error } finally { await cleanup() }
      } else {
        const live = await request(url), original = project(live, selected[folder]!)
        safe(original)
        if (folder === "AdminConsentRequestPolicy" && original.requestDurationInDays === 0) return { folder, operations: "read-only: zero-day original has no verified restore-original builder; no write", productPath: "Blocked in production" }
        // The methods parent only has an identical registration-enforcement probe. Its method
        // configurations are not inferred writable from the parent or altered by this harness.
        const build = (body: Item) => folder === "AuthenticationMethodsPolicy" ? body : configurationPayload(folder, "update", body)
        const body = build(original), changed = structuredClone(body)
        if (!identicalOnly.has(folder)) {
          if (folder === "AuthenticationFlowsPolicy") (changed.selfServiceSignUp as Item).isEnabled = !(body.selfServiceSignUp as Item).isEnabled
          if (folder === "AdminConsentRequestPolicy") changed.requestDurationInDays = body.requestDurationInDays === 30 ? 31 : 30
          if (folder === "EntraCompanyBranding") changed.usernameHintText = prefix + "verification"
        }
        if (identicalOnly.has(folder) && !equal(body, changed)) throw new Error("Lock-out-risk singleton must be identical")
        // A durable, outside-repository original is required by the real launcher.
        // Injected tests may use memory only. A failed restore leaves the recovery file intact.
        if (!identicalOnly.has(folder)) recovery?.save(folder, body)
        let sent = false
        try {
          const prepared = build(changed)
          // Recheck the preimage before the first mutation. The flag precedes fetch to include lost answers.
          if (!equal(project(await request(url), selected[folder]!), original)) throw new Error("Singleton changed before the lab write")
          sent = true
          await request(url, restoreMatrixRow(folder)!.update!.method, prepared)
          await verify(folder, url, prepared)
        } finally {
          if (sent) {
            if (!identicalOnly.has(folder)) await request(url, restoreMatrixRow(folder)!.update!.method, folder === "EntraCompanyBranding" && body.usernameHintText === "" ? { usernameHintText: null } : body)
            await verify(folder, url, body)
            recovery?.clear(folder)
          }
        }
      }
      return { folder, operations: collections.includes(folder) ? "create/read/change/restore/delete" : identicalOnly.has(folder) ? "read/identical-write/read" : "save/change/verify/restore-original/verify", productPath: "Matrix method/path and candidate payload builder only. Signed-in actor, confirmations, journal and guards use injected-fetch verification, not this app-only adapter." }
    },
  }
}
