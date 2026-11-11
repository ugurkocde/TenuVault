import { CONSENT_ROLES, DESKTOP_APP_PERMISSIONS } from "../../shared/app-registration"
import type { RegistrationResult, SetupProgress } from "../../shared/ipc"

interface Application {
  id: string
  appId: string
  displayName: string
  notes?: string
  signInAudience?: string
  publicClient?: { redirectUris?: string[] }
  createdDateTime?: string
}
interface Principal {
  id: string
  /** False when an administrator turned sign-in to the enterprise application off. */
  accountEnabled?: boolean
  oauth2PermissionScopes?: { id: string; value: string; isEnabled?: boolean }[]
  publishedPermissionScopes?: { id: string; value: string; isEnabled?: boolean }[]
}
interface Grant { id: string; resourceId: string; consentType: string; scope: string }
export interface ProvisioningOptions {
  fetch: typeof fetch
  token: string
  tenantId: string
  username: string
  progress: (progress: SetupProgress) => void
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
}
// Use the tenant setup Graph endpoint.
const ROOT = "https://graph.microsoft.com/beta"
const NOTES = "Used by the TenuVault desktop app. Delegated permissions only, no credentials."
const REQUEST_TIMEOUT_MS = 30_000

/** Graph provisioning is independent of Electron and MSAL. The caller owns the ephemeral token. */
export async function provisionRegistration(options: ProvisioningOptions): Promise<RegistrationResult> {
  const { fetch: request, tenantId, username, progress, signal } = options
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const checkCancelled = () => { if (signal?.aborted) throw new Error("Sign-in cancelled.") }
  // One request to Microsoft Graph. A request that gets no answer within half a minute counts as
  // failed, so a stalled connection cannot keep the setup, and the token it holds, alive.
  async function graph<T>(method: string, path: string, body?: object, replication = false, cleanup = false): Promise<T> {
    const url = new URL(path.startsWith("https:") ? path : `${ROOT}${path}`)
    if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.hash || !url.pathname.startsWith("/beta/")) throw new Error("Unexpected Graph paging address.")
    const attempts = replication ? 12 : 4
    // A write that may have been carried out is never sent twice: only a throttled request (which
    // was not carried out) and a replication delay repeat a POST.
    const repeatable = method !== "POST"
    for (let attempt = 1; ; attempt++) {
      if (!cleanup) checkCancelled()
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      let response: Response
      try {
        response = await request(url.href, {
          method, redirect: "error", signal: !cleanup && signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      } catch (error) {
        if (!cleanup) checkCancelled()
        if (repeatable && attempt < attempts) { await sleep(3000); continue }
        throw new Error(`Graph ${method} failed: Microsoft Graph did not answer${timeout.aborted ? " in time" : ""}. ${error instanceof Error ? error.message : String(error)}`)
      }
      if (response.ok) return (response.status === 204 ? undefined : await response.json()) as T
      const data = await response.json().catch(() => ({})) as { error?: { message?: string } }
      const message = data.error?.message ?? `HTTP ${response.status}`
      const replicating = replication && (response.status === 404 || response.status === 400 && /valid application object|does not exist|not found|not present/i.test(message))
      const transient = response.status === 429 || response.status >= 500 && repeatable
      if (attempt < attempts && (replicating || transient)) {
        const header = response.headers.get("Retry-After")
        const delay = header ? (/^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 3000
        await sleep(Math.min(60_000, Math.max(3000, Number.isFinite(delay) ? delay : 3000)))
        continue
      }
      if (response.status === 403) throw new Error(`The signed-in account ${username} lacks a role that can create app registrations and grant admin consent. Use a ${CONSENT_ROLES.join(", ")} (with consent rights). ${message}`)
      throw new Error(`Graph ${method} failed: ${message}`)
    }
  }
  async function list<T>(path: string): Promise<T[]> {
    const items: T[] = []
    let next: string | undefined = path
    const seen = new Set<string>()
    while (next) {
      if (seen.has(next)) throw new Error("Unexpected Graph paging address.")
      seen.add(next)
      const page: { value: T[]; "@odata.nextLink"?: string } = await graph("GET", next)
      items.push(...page.value)
      next = page["@odata.nextLink"]
    }
    return items
  }
  // The plan is checked when the admin signs in to the tenant, as with a registration the script
  // made. Checking it here would start licensing for a tenant that is not signed in yet.
  checkCancelled()
  // The sign-in is done; from here on the browser wait can no longer be cancelled.
  progress({ phase: "registration" })
  const principalFields = "$select=id,appId,accountEnabled,publishedPermissionScopes"
  const resources = []
  for (const resource of DESKTOP_APP_PERMISSIONS) {
    // A Microsoft API the tenant has not used yet is added to it, as the setup script does. These
    // are Microsoft's own enterprise applications and stay when a later step fails.
    const path = `/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${resource.appId}'`)}&${principalFields}`
    let principal = (await list<Principal>(path))[0]
    if (!principal) principal = await graph<Principal>("POST", "/servicePrincipals", { appId: resource.appId }, true)
    // Accept either permission scope field returned by Graph.
    const scopes = principal.oauth2PermissionScopes ?? principal.publishedPermissionScopes ?? []
    const resourceAccess = resource.permissions.map(value => {
      const scope = scopes.find(scope => scope.value === value && scope.isEnabled !== false)
      if (!scope) throw new Error(`Delegated permission ${value} was not found on ${resource.api}.`)
      return { id: scope.id, type: "Scope" }
    })
    resources.push({ ...resource, principal, resourceAccess })
  }
  const candidates = (await list<Application>(`/applications?$filter=${encodeURIComponent("startswith(displayName,'TenuVault')")}&$select=id,appId,displayName,notes,signInAudience,publicClient,createdDateTime`))
    .filter(app => app.displayName?.startsWith("TenuVault") && app.notes?.startsWith("Used by the TenuVault desktop app") && app.signInAudience === "AzureADMyOrg" && app.publicClient?.redirectUris?.includes("http://localhost"))
  const principals = new Map<string, Principal | undefined>()
  const consent = new Map<string, Grant[]>()
  let existing = candidates[0]
  if (candidates.length > 1) {
    const ranked = []
    for (const candidate of candidates) {
      const principal = (await list<Principal>(`/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${candidate.appId}'`)}&${principalFields}`))[0]
      principals.set(candidate.appId, principal)
      const grants = principal && principal.accountEnabled !== false
        ? await list<Grant>(`/oauth2PermissionGrants?$filter=${encodeURIComponent(`clientId eq '${principal.id}'`)}`) : []
      consent.set(candidate.appId, grants)
      const permissions = new Set(grants.filter(g => g.consentType === "AllPrincipals").flatMap(g => g.scope.split(/\s+/).filter(Boolean).map(scope => `${g.resourceId}:${scope}`)))
      ranked.push({ candidate, disabled: principal?.accountEnabled === false, score: permissions.size })
    }
    ranked.sort((a, b) => Number(a.disabled) - Number(b.disabled) || b.score - a.score || (a.candidate.createdDateTime ?? "9999").localeCompare(b.candidate.createdDateTime ?? "9999") || a.candidate.id.localeCompare(b.candidate.id))
    existing = ranked[0]!.candidate
  }
  let created: Application | undefined
  let app = existing
  progress({ phase: "registration", reused: Boolean(existing) })
  try {
    if (!app) {
      created = await graph<Application>("POST", "/applications", {
        displayName: "TenuVault Desktop", signInAudience: "AzureADMyOrg", notes: NOTES,
        publicClient: { redirectUris: ["http://localhost"] },
        requiredResourceAccess: resources.map(resource => ({ resourceAppId: resource.appId, resourceAccess: resource.resourceAccess })),
      })
      app = created
    }
    let principal = principals.has(app.appId) ? principals.get(app.appId) : (await list<Principal>(`/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${app.appId}'`)}&${principalFields}`))[0]
    // An administrator who turned sign-in off revoked access on purpose: do not add consent to it.
    if (principal?.accountEnabled === false) {
      throw new Error(`This tenant already has a TenuVault app registration (client id ${app.appId}), but sign-in to its enterprise application is turned off. Turn it on under Entra admin center > Enterprise applications > TenuVault Desktop > Properties, or delete the app registration, then try again. Nothing was changed.`)
    }
    if (!principal) principal = await graph<Principal>("POST", "/servicePrincipals", { appId: app.appId, tags: ["HideApp", "WindowsAzureActiveDirectoryIntegratedApp"] }, true)
    progress({ phase: "consent", reused: Boolean(existing) })
    const grants = consent.get(app.appId) ?? await list<Grant>(`/oauth2PermissionGrants?$filter=${encodeURIComponent(`clientId eq '${principal.id}'`)}`)
    for (const resource of resources) {
      const grant = grants.find(grant => grant.consentType === "AllPrincipals" && grant.resourceId === resource.principal.id)
      const scopes = new Set(grant?.scope.split(/\s+/).filter(Boolean) ?? [])
      const missing = resource.permissions.some(scope => !scopes.has(scope))
      resource.permissions.forEach(scope => scopes.add(scope))
      if (grant && missing) await graph("PATCH", `/oauth2PermissionGrants/${encodeURIComponent(grant.id)}`, { scope: [...scopes].join(" ") }, true)
      if (!grant) await graph("POST", "/oauth2PermissionGrants", { clientId: principal.id, consentType: "AllPrincipals", resourceId: resource.principal.id, scope: [...scopes].join(" ") }, true)
    }
  } catch (error) {
    if (!created) throw error
    let removed = false
    try { await graph("DELETE", `/applications/${created.id}`, undefined, true, true); removed = true } catch { /* Best effort cleanup. */ }
    throw new Error(`Setup did not finish. ${removed ? "The half-created app registration was removed again." : `Cleanup failed. Delete app registration TenuVault Desktop (client id ${created.appId}) in the Entra admin center.`} ${error instanceof Error ? error.message : String(error)}`)
  }
  progress({ phase: "publishing", reused: Boolean(existing) })
  // Provisioning has committed. Publication failures must preserve the IDs for manual sign-in.
  let ready = false
  const deadline = Date.now() + 90_000
  for (let attempt = 0; attempt < 45 && Date.now() < deadline; attempt++) {
    try {
      const response = await request(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/devicecode`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: app!.appId, scope: "https://graph.microsoft.com/User.Read" }).toString(),
      })
      const data = await response.json() as { error?: string; error_codes?: number[]; device_code?: string }
      if ((response.ok && data.device_code) || (response.status === 400 && data.error && !(data.error === "unauthorized_client" && data.error_codes?.includes(700016)))) { ready = true; break }
    } catch { /* Return IDs even when the publication service cannot be reached. */ }
    await sleep(Math.max(0, Math.min(2000, deadline - Date.now())))
  }
  // The probe answers as soon as the sign-in service knows the application. Its service principal
  // and consent follow moments later, so leave them a little time before the browser opens.
  if (ready) await sleep(5000)
  return { tenantId, clientId: app!.appId, username, reused: Boolean(existing), ready, displayName: app!.displayName, candidateCount: candidates.length }
}
