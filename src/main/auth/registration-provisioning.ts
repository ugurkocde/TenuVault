import { CONSENT_ROLES, DESKTOP_APP_PERMISSIONS } from "../../shared/app-registration"
import type { RegistrationResult, SetupProgress } from "../../shared/ipc"

interface Application {
  id: string
  appId: string
  notes?: string
  signInAudience?: string
  publicClient?: { redirectUris?: string[] }
  createdDateTime?: string
}
interface Principal {
  id: string
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
// The stable Graph version, as the setup script uses it.
const ROOT = "https://graph.microsoft.com/v1.0"
const NOTES = "Used by the TenuVault desktop app. Delegated permissions only, no credentials."

/** Graph provisioning is independent of Electron and MSAL. The caller owns the ephemeral token. */
export async function provisionRegistration(options: ProvisioningOptions): Promise<RegistrationResult> {
  const { fetch: request, tenantId, username, progress, signal } = options
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const checkCancelled = () => { if (signal?.aborted) throw new Error("Sign-in cancelled.") }
  async function graph<T>(method: string, path: string, body?: object, replication = false, cleanup = false): Promise<T> {
    const url = new URL(path.startsWith("https:") ? path : `${ROOT}${path}`)
    if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.hash || !url.pathname.startsWith("/v1.0/")) throw new Error("Unexpected Graph paging address.")
    const attempts = replication ? 12 : 4
    for (let attempt = 1; ; attempt++) {
      if (!cleanup) checkCancelled()
      const response = await request(url.href, {
        method, redirect: "error", signal: cleanup ? undefined : signal,
        headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (response.ok) return (response.status === 204 ? undefined : await response.json()) as T
      const data = await response.json().catch(() => ({})) as { error?: { message?: string } }
      const message = data.error?.message ?? `HTTP ${response.status}`
      const replicating = replication && (response.status === 404 || response.status === 400 && /valid application object|does not exist|not found|not present/i.test(message))
      const transient = response.status === 429 || response.status >= 500 && ["GET", "PATCH", "DELETE"].includes(method)
      if (attempt < attempts && (replicating || transient)) {
        const header = response.headers.get("Retry-After")
        const delay = header ? (/^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 3000
        await sleep(Math.min(60_000, Math.max(3000, Number.isFinite(delay) ? delay : 3000)))
        continue
      }
      if (response.status === 403) throw new Error(`The signed-in account ${username} lacks a role that can create app registrations and grant admin consent. Use a ${CONSENT_ROLES.join(", ")} (with consent rights).`)
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
  const resources = []
  for (const resource of DESKTOP_APP_PERMISSIONS) {
    const path = `/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${resource.appId}'`)}`
    let principal = (await list<Principal>(path))[0]
    if (!principal) principal = await graph<Principal>("POST", "/servicePrincipals", { appId: resource.appId }, true)
    // Graph v1.0 calls them oauth2PermissionScopes; the beta name is accepted as well.
    const scopes = principal.oauth2PermissionScopes ?? principal.publishedPermissionScopes ?? []
    const resourceAccess = resource.permissions.map(value => {
      const scope = scopes.find(scope => scope.value === value && scope.isEnabled !== false)
      if (!scope) throw new Error(`Delegated permission ${value} was not found on ${resource.api}.`)
      return { id: scope.id, type: "Scope" }
    })
    resources.push({ ...resource, principal, resourceAccess })
  }
  const existing = (await list<Application>(`/applications?$filter=${encodeURIComponent("displayName eq 'TenuVault Desktop'")}`))
    .filter(app => app.notes?.startsWith("Used by the TenuVault desktop app") && app.signInAudience === "AzureADMyOrg" && app.publicClient?.redirectUris?.includes("http://localhost"))
    .sort((a, b) => (b.createdDateTime ?? "").localeCompare(a.createdDateTime ?? ""))[0]
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
    let principal = (await list<Principal>(`/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${app.appId}'`)}`))[0]
    if (!principal) principal = await graph<Principal>("POST", "/servicePrincipals", { appId: app.appId, tags: ["HideApp", "WindowsAzureActiveDirectoryIntegratedApp"] }, true)
    progress({ phase: "consent", reused: Boolean(existing) })
    const grants = await list<Grant>(`/oauth2PermissionGrants?$filter=${encodeURIComponent(`clientId eq '${principal.id}'`)}`)
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
  return { tenantId, clientId: app!.appId, username, reused: Boolean(existing), ready }
}
