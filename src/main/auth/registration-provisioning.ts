import { CONSENT_ROLES, DESKTOP_APP_PERMISSIONS } from "../../shared/app-registration"
import { OPTIONAL_PERMISSIONS } from "../../shared/services/optional-permissions"
import type { RegistrationResult, SetupProgress } from "../../shared/ipc"

interface Application {
  id: string
  appId: string
  displayName: string
  notes?: string
  signInAudience?: string
  publicClient?: { redirectUris?: string[] }
  web?: { redirectUris?: string[] }
  spa?: { redirectUris?: string[] }
  passwordCredentials?: unknown[]
  keyCredentials?: unknown[]
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
// The stable Graph version, as the setup script uses it. The first real setups ran against it.
const ROOT = "https://graph.microsoft.com/v1.0"
const NOTES = "Used by the TenuVault desktop app. Delegated permissions only, no credentials."
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000"
const APPLICATION_FIELDS = "id,appId,displayName,notes,signInAudience,publicClient,web,spa,passwordCredentials,keyCredentials,createdDateTime"

/**
 * Whether an app registration still is what TenuVault makes: named and noted as TenuVault's, single
 * tenant, and a public client that can only answer on this computer. A secret, a certificate, or a
 * redirect to anywhere else means someone turned it into something else, and it is left alone.
 */
function looksLikeTenuVault(app: Application): boolean {
  const redirects = (app.publicClient?.redirectUris ?? []).map(uri => uri.toLowerCase())
  const local = new Set(["http://localhost", "https://login.microsoftonline.com/common/oauth2/nativeclient", `ms-appx-web://microsoft.aad.brokerplugin/${app.appId}`.toLowerCase()])
  return app.displayName?.startsWith("TenuVault") === true
    && app.notes?.startsWith("Used by the TenuVault desktop app") === true
    && app.signInAudience === "AzureADMyOrg"
    && redirects.includes("http://localhost") && redirects.every(uri => local.has(uri))
    && !app.web?.redirectUris?.length && !app.spa?.redirectUris?.length
    && !app.passwordCredentials?.length && !app.keyCredentials?.length
}
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
    if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.hash || !url.pathname.startsWith("/v1.0/")) throw new Error("Unexpected Graph paging address.")
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
  progress({ phase: "registration" })
  const principalFields = "$select=id,appId,accountEnabled,oauth2PermissionScopes"
  // Microsoft's own enterprise applications for the APIs TenuVault uses. One the tenant has not
  // used yet is only added when a registration is created: while an existing one is used, the
  // setup writes nothing at all.
  const resources: ((typeof DESKTOP_APP_PERMISSIONS)[number] & { principal?: Principal })[] = []
  for (const resource of DESKTOP_APP_PERMISSIONS) {
    resources.push({ ...resource, principal: (await list<Principal>(`/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${resource.appId}'`)}&${principalFields}`))[0] })
  }
  // An existing registration is used only when an administrator has already given it tenant-wide
  // consent for TenuVault's Intune permissions. Any member of a tenant may create app
  // registrations, with any name and note, and remains their owner. Granting consent to such a
  // registration would hand its owner an app that administrators sign in through. Tenant-wide
  // consent can only come from an administrator, so it is the proof that one trusted it before.
  // Even then the setup writes nothing to it: it only ever gives consent to the one it creates.
  const graphResource = resources.find(resource => resource.appId === GRAPH_APP_ID)!
  const graphPrincipalId = graphResource.principal?.id
  const intune = new Set(graphResource.permissions.filter(permission => permission.startsWith("DeviceManagement")))
  // For choosing among several, only permissions TenuVault knows count: the default set and the
  // ones its switches add. Consent for anything else says nothing about which one the admins use.
  const known = new Map(resources.flatMap(resource => resource.principal ? [[resource.principal.id, new Set<string>(
    resource.appId === GRAPH_APP_ID ? [...resource.permissions, ...OPTIONAL_PERMISSIONS.flatMap(entry => entry.permissions), "Policy.ReadWrite.ConditionalAccess"] : resource.permissions,
  )] as const] : []))
  const candidates = []
  for (const candidate of (await list<Application>(`/applications?$filter=${encodeURIComponent("startswith(displayName,'TenuVault')")}&$select=${APPLICATION_FIELDS}`)).filter(looksLikeTenuVault)) {
    const principal = (await list<Principal>(`/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${candidate.appId}'`)}&${principalFields}`))[0]
    if (!principal) continue
    const grants = await list<Grant>(`/oauth2PermissionGrants?$filter=${encodeURIComponent(`clientId eq '${principal.id}'`)}`)
    const tenantWide = grants.filter(grant => grant.consentType === "AllPrincipals")
    if (!tenantWide.some(grant => grant.resourceId === graphPrincipalId && grant.scope.split(/\s+/).some(scope => intune.has(scope)))) continue
    const score = new Set(tenantWide.flatMap(grant => grant.scope.split(/\s+/).filter(scope => known.get(grant.resourceId)?.has(scope)).map(scope => `${grant.resourceId}:${scope}`))).size
    candidates.push({ app: candidate, principal, grants, disabled: principal.accountEnabled === false, score })
  }
  // One whose enterprise application has sign-in turned off comes last, then the one whose consent
  // covers most of TenuVault's permissions, then the oldest.
  candidates.sort((a, b) => Number(a.disabled) - Number(b.disabled) || b.score - a.score || (a.app.createdDateTime ?? "9999").localeCompare(b.app.createdDateTime ?? "9999") || a.app.id.localeCompare(b.app.id))
  const chosen = candidates[0]
  const existing = chosen?.app
  // An administrator who turned sign-in off revoked access on purpose, and a second registration
  // next to it would work around that decision.
  if (chosen?.disabled) {
    throw new Error(`This tenant already has a TenuVault app registration, "${chosen.app.displayName}" (client id ${chosen.app.appId}), but sign-in to its enterprise application is turned off. Turn it on under Entra admin center > Enterprise applications > ${chosen.app.displayName} > Properties, or delete the app registration, then try again. Nothing was changed.`)
  }
  let created: Application | undefined
  let app = existing
  /** Default permissions the reused registration has no tenant-wide consent for. */
  const missingConsent: string[] = []
  progress({ phase: "registration", reused: Boolean(existing) })
  try {
    if (!app) {
      const requiredResourceAccess = []
      for (const resource of resources) {
        // A Microsoft API the tenant has not used yet is added to it, as the setup script does.
        // These are Microsoft's own enterprise applications and stay when a later step fails.
        resource.principal ??= await graph<Principal>("POST", "/servicePrincipals", { appId: resource.appId }, true)
        // Graph v1.0 calls them oauth2PermissionScopes; the beta name is accepted as well.
        const scopes = resource.principal.oauth2PermissionScopes ?? resource.principal.publishedPermissionScopes ?? []
        requiredResourceAccess.push({ resourceAppId: resource.appId, resourceAccess: resource.permissions.map(value => {
          const scope = scopes.find(scope => scope.value === value && scope.isEnabled !== false)
          if (!scope) throw new Error(`Delegated permission ${value} was not found on ${resource.api}.`)
          return { id: scope.id, type: "Scope" }
        }) })
      }
      created = await graph<Application>("POST", "/applications", {
        displayName: "TenuVault Desktop", signInAudience: "AzureADMyOrg", notes: NOTES,
        publicClient: { redirectUris: ["http://localhost"] }, requiredResourceAccess,
      })
      app = created
    }
    let principal: Principal | undefined = chosen?.principal ?? (await list<Principal>(`/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${app.appId}'`)}&${principalFields}`))[0]
    if (!principal) principal = await graph<Principal>("POST", "/servicePrincipals", { appId: app.appId, tags: ["HideApp", "WindowsAzureActiveDirectoryIntegratedApp"] }, true)
    progress({ phase: "consent", reused: Boolean(existing) })
    const grants = chosen?.grants ?? await list<Grant>(`/oauth2PermissionGrants?$filter=${encodeURIComponent(`clientId eq '${principal.id}'`)}`)
    for (const resource of resources) {
      const grant = grants.find(grant => grant.consentType === "AllPrincipals" && grant.resourceId === resource.principal?.id)
      const scopes = new Set(grant?.scope.split(/\s+/).filter(Boolean) ?? [])
      const lacking = resource.permissions.filter(scope => !scopes.has(scope))
      // A registration this run did not create is used as it is. What an administrator consented
      // to is their decision; widening it here would approve permissions nobody was asked about.
      if (existing) { missingConsent.push(...lacking.map(scope => resource.appId === GRAPH_APP_ID ? scope : `${scope} (${resource.api})`)); continue }
      resource.permissions.forEach(scope => scopes.add(scope))
      if (grant && lacking.length) await graph("PATCH", `/oauth2PermissionGrants/${encodeURIComponent(grant.id)}`, { scope: [...scopes].join(" ") }, true)
      if (!grant) await graph("POST", "/oauth2PermissionGrants", { clientId: principal.id, consentType: "AllPrincipals", resourceId: resource.principal!.id, scope: [...scopes].join(" ") }, true)
    }
  } catch (error) {
    if (!created) throw error
    let removed = false
    try { await graph("DELETE", `/applications/${created.id}`, undefined, true, true); removed = true } catch { /* Best effort cleanup. */ }
    throw new Error(`Setup did not finish. ${removed ? "The half-created app registration was removed again." : `Cleanup failed. Delete app registration TenuVault Desktop (client id ${created.appId}) in the Entra admin center.`} ${error instanceof Error ? error.message : String(error)}`)
  }
  checkCancelled()
  progress({ phase: "publishing", reused: Boolean(existing) })
  // Stop publication waits at once when the admin cancels.
  const waitPublishing = async (ms: number) => {
    checkCancelled()
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Sign-in cancelled."))
      signal?.addEventListener("abort", abort, { once: true })
    })
    try { await Promise.race([sleep(ms), cancelled]); checkCancelled() }
    finally { signal?.removeEventListener("abort", abort) }
  }
  // Provisioning has committed. Publication failures must preserve the IDs for manual sign-in.
  let ready = false
  const deadline = Date.now() + 90_000
  for (let attempt = 0; attempt < 45 && Date.now() < deadline; attempt++) {
    checkCancelled()
    try {
      const response = await request(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/devicecode`, {
        method: "POST", redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now())))]),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: app!.appId, scope: "https://graph.microsoft.com/User.Read" }).toString(),
      })
      checkCancelled()
      const data = await response.json() as { error?: string; error_codes?: number[]; device_code?: string }
      if ((response.ok && data.device_code) || (response.status === 400 && data.error && !(data.error === "unauthorized_client" && data.error_codes?.includes(700016)))) { ready = true; break }
    } catch { /* Return IDs even when the publication service cannot be reached. */ }
    await waitPublishing(Math.max(0, Math.min(2000, deadline - Date.now())))
  }
  // The probe answers as soon as the sign-in service knows the application. Its service principal
  // and consent follow moments later, so leave them a little time before the browser opens.
  if (ready) await waitPublishing(5000)
  checkCancelled()
  return { tenantId, clientId: app!.appId, username, reused: Boolean(existing), ready, displayName: app!.displayName, candidateCount: candidates.length, missingConsent }
}
