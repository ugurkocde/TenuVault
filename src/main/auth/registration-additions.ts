import { isGuid } from "../../shared/security"
import { randomUUID } from "node:crypto"
import { GRAPH_APP_ID } from "../../shared/services/manifest"
import { ADD_PERMISSION_ROLES, type PermissionAdditionPreview, type PermissionAdditionResult } from "../../shared/registration-additions"

interface ResourceAccess { resourceAppId: string; resourceAccess: { id: string; type: string; [key: string]: unknown }[]; [key: string]: unknown }
interface Application {
  id: string; appId: string; displayName: string; signInAudience: string
  publicClient: { redirectUris: string[] }; web: { redirectUris: string[] }; spa: { redirectUris: string[] }
  passwordCredentials: unknown[]; keyCredentials: unknown[]; requiredResourceAccess: ResourceAccess[]
}
interface Principal { id: string; appId: string; accountEnabled: boolean; passwordCredentials: unknown[]; keyCredentials: unknown[]; oauth2PermissionScopes: { id: string; value: string; isEnabled: boolean }[] }
interface Grant { id: string; clientId: string; resourceId: string; consentType: string; principalId: string | null; scope: string }
interface Snapshot { app: Application; client: Principal; resource: Principal; grants: Grant[] }
export interface AdditionConnection { tenantId: string; clientId: string; username: string; homeAccountId: string; scopes: string[]; allowed: readonly string[] }
export interface AdditionOptions { fetch: typeof fetch; token: string; connection: AdditionConnection; additions: readonly string[]; sleep?: (ms: number) => Promise<void> }
const ROOT = "https://graph.microsoft.com/v1.0"
const APP_FIELDS = "id,appId,displayName,signInAudience,publicClient,web,spa,passwordCredentials,keyCredentials,requiredResourceAccess"
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const scopes = (value: string) => value.split(/\s+/).filter(Boolean)
const protocol = new Set(["openid", "profile", "email", "offline_access"])
const declaredIds = (app: Application) => app.requiredResourceAccess.filter(r => eq(r.resourceAppId, GRAPH_APP_ID)).flatMap(r => r.resourceAccess.filter(a => a.type === "Scope").map(a => a.id.toLowerCase()))
const consentedScopes = (snapshot: Snapshot) => snapshot.grants.filter(g => g.consentType === "AllPrincipals").flatMap(g => scopes(g.scope))
const sameSet = (a: readonly string[], b: readonly string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort())
// Object property order and array order are not meaningful to Graph's declaration and consent sets.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical).sort())
  if (value && typeof value === "object") return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]))
  return JSON.stringify(value)
}
function signature(s: Snapshot): string {
  return canonical({ app: { ...s.app, requiredResourceAccess: s.app.requiredResourceAccess.map(r => ({ ...r, resourceAppId: r.resourceAppId.toLowerCase(), resourceAccess: r.resourceAccess.map(a => ({ ...a, id: a.id.toLowerCase() })) })) }, client: s.client, resource: s.resource, grants: s.grants.map(g => ({ ...g, scope: [...new Set(scopes(g.scope))].sort() })) })
}

/** A read-preview-confirm transaction, independent of MSAL and Electron and tested with injected fetch. */
export class RegistrationAdditions {
  readonly preview: PermissionAdditionPreview
  private snapshot!: Snapshot
  private ids = new Map<string, string>()
  private used = false
  private constructor(private options: AdditionOptions) {
    this.preview = { id: randomUUID(), tenantId: options.connection.tenantId, clientId: options.connection.clientId, displayName: "", declare: [], consent: [], declared: [], consented: [] }
  }
  static async prepare(options: AdditionOptions): Promise<RegistrationAdditions> {
    if (!isGuid(options.connection.clientId) || !isGuid(options.connection.tenantId)) throw new Error("Choose a connected tenant and registration.")
    if (!options.additions.length || options.additions.length > 200 || options.additions.some(name => !options.connection.allowed.includes(name))) throw new Error("Choose permissions from the tenant's current services and access levels.")
    const run = new RegistrationAdditions({ ...options, additions: [...new Set(options.additions)] })
    run.snapshot = await run.read()
    run.guard(run.snapshot)
    for (const name of run.options.additions) {
      const permission = run.snapshot.resource.oauth2PermissionScopes.find(p => p.value === name && p.isEnabled)
      if (!permission) throw new Error(`Microsoft Graph does not publish the enabled delegated permission ${name}. Nothing was changed.`)
      run.ids.set(name, permission.id)
    }
    Object.assign(run.preview, run.difference(run.snapshot))
    return run
  }
  private async graph<T>(method: string, path: string, body?: object): Promise<T> {
    const response = await this.options.fetch(`${ROOT}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${this.options.token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) {
      if (response.status === 403) throw new Error(`The account lacks permission or an administrator role for this action. Use an ${ADD_PERMISSION_ROLES}. Azure CLI, Entra and the text for your administrator remain available.`)
      throw new Error(`Microsoft Graph refused ${method} (HTTP ${response.status}).`)
    }
    return response.status === 204 ? undefined as T : await response.json() as T
  }
  private async list<T>(path: string): Promise<T[]> {
    const values: T[] = []
    let next: string | undefined = path
    const seen = new Set<string>()
    const collection = path.split("?", 1)[0]
    while (next) {
      if (seen.size >= 50 || seen.has(next)) throw new Error("Microsoft Graph returned unexpected paging.")
      seen.add(next)
      const page: { value: T[]; "@odata.nextLink"?: string } = await this.graph("GET", next)
      if (!Array.isArray(page.value)) throw new Error("Microsoft Graph returned an incomplete answer.")
      values.push(...page.value)
      next = undefined
      if (page["@odata.nextLink"]) {
        const url = new URL(page["@odata.nextLink"]!)
        if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.hash || url.pathname !== `/v1.0${collection}`) throw new Error("Microsoft Graph returned unexpected paging.")
        next = `${url.pathname.slice(5)}${url.search}`
      }
    }
    return values
  }
  private async read(): Promise<Snapshot> {
    const app = await this.graph<Application>("GET", `/applications(appId='${this.options.connection.clientId}')?$select=${APP_FIELDS}`)
    const federated = await this.list<{ id: string }>(`/applications/${encodeURIComponent(app.id)}/federatedIdentityCredentials?$select=id`)
    if (federated.length) throw new Error("This registration has federated credentials. Use the other permission routes. Nothing was changed by this check.")
    const principal = async (appId: string) => {
      const found = await this.list<Principal>(`/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${appId}'`)}&$select=id,appId,accountEnabled,passwordCredentials,keyCredentials,oauth2PermissionScopes`)
      if (found.length !== 1 || !eq(found[0]!.appId, appId)) throw new Error("The exact enterprise application could not be identified. Nothing was changed by this check.")
      return found[0]!
    }
    const client = await principal(this.options.connection.clientId)
    const resource = await principal(GRAPH_APP_ID)
    const grants = (await this.list<Grant>(`/oauth2PermissionGrants?$filter=${encodeURIComponent(`clientId eq '${client.id}'`)}`)).filter(g => eq(g.resourceId, resource.id))
    return { app, client, resource, grants }
  }
  private guard(s: Snapshot): void {
    const { app, client, grants } = s
    if (!eq(app.appId, this.options.connection.clientId) || app.signInAudience !== "AzureADMyOrg" || !Array.isArray(app.publicClient?.redirectUris) || !app.publicClient.redirectUris.some(uri => /^http:\/\/localhost\/?$/i.test(uri)) || !app.publicClient.redirectUris.every(uri => /^http:\/\/localhost(?::\d+)?\/?$/i.test(uri)) || app.web?.redirectUris?.length !== 0 || app.spa?.redirectUris?.length !== 0) throw new Error("This registration is not a single-tenant public client with only local redirects. Use the other permission routes. Nothing was changed by this check.")
    if (![app.passwordCredentials, app.keyCredentials, client.passwordCredentials, client.keyCredentials].every(value => Array.isArray(value) && value.length === 0)) throw new Error("This registration or enterprise application has credentials, or their absence could not be verified. Use the other permission routes. Nothing was changed by this check.")
    if (!client.accountEnabled || !Array.isArray(app.requiredResourceAccess)) throw new Error("The registration is disabled or its declarations could not be read. Nothing was changed by this check.")
    if (grants.some(g => !eq(g.clientId, client.id) || g.consentType !== "AllPrincipals" || g.principalId !== null)) throw new Error("Individual Graph consent exists. An administrator must review these grants separately using the other routes. Nothing was changed by this check.")
    if (grants.length > 1) throw new Error("Multiple tenant-wide Graph grants need separate administrator review. Nothing was changed by this check.")
    const connected = this.options.connection.scopes.filter(name => !protocol.has(name))
    if (!connected.length || connected.some(name => !consentedScopes(s).includes(name))) throw new Error("This registration lacks tenant-wide consent for the Graph scopes of the connected account. Use the other permission routes. Nothing was changed by this check.")
  }
  private difference(s: Snapshot): Omit<PermissionAdditionPreview, "id" | "tenantId" | "clientId"> {
    const held = declaredIds(s.app)
    const consented = consentedScopes(s)
    return { displayName: s.app.displayName, declare: this.options.additions.filter(n => !held.includes(this.ids.get(n)!.toLowerCase())), consent: this.options.additions.filter(n => !consented.includes(n)), declared: s.app.requiredResourceAccess.flatMap(r => r.resourceAccess.map(a => `${r.resourceAppId}/${a.type}/${a.id}`)), consented }
  }
  private async verify(test: (s: Snapshot) => boolean): Promise<Snapshot> {
    let latest!: Snapshot
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))([500, 1500, 3000][attempt - 1]!)
      latest = await this.read()
      if (test(latest)) break
    }
    return latest
  }
  /** Called once for the exact stored preview. There is deliberately no automatic write retry. */
  async apply(assertConnection: () => Promise<void> = async () => {}): Promise<PermissionAdditionResult> {
    if (this.used) throw new Error("This preview was already used. Start a new preview.")
    this.used = true
    let latest = await this.read()
    await assertConnection()
    if (signature(latest) !== signature(this.snapshot)) return { state: "changed", preview: { ...this.preview, ...this.difference(latest) }, declared: [], consented: [], missingDeclarations: [], missingConsent: [], message: "The registration or consent changed since the preview. Nothing was written. Review the current state below and start a new preview." }
    this.guard(latest)
    let issue = ""
    let uncertain = false
    const declarationDone = (s: Snapshot) => this.options.additions.every(n => declaredIds(s.app).includes(this.ids.get(n)!.toLowerCase()))
    const consentDone = (s: Snapshot) => this.options.additions.every(n => consentedScopes(s).includes(n))
    try {
      if (this.preview.declare.length) {
        const requiredResourceAccess = structuredClone(latest.app.requiredResourceAccess)
        let resource = requiredResourceAccess.find(r => eq(r.resourceAppId, GRAPH_APP_ID))
        if (!resource) requiredResourceAccess.push(resource = { resourceAppId: GRAPH_APP_ID, resourceAccess: [] })
        resource.resourceAccess.push(...this.preview.declare.map(n => ({ id: this.ids.get(n)!, type: "Scope" })))
        try { await this.graph("PATCH", `/applications/${encodeURIComponent(latest.app.id)}`, { requiredResourceAccess }) }
        catch (error) { uncertain = true; issue = error instanceof Error ? error.message : String(error) }
        latest = await this.verify(declarationDone)
        // No further write after a refused or unanswered write, even when read-back found it applied.
        if (issue || !declarationDone(latest)) throw new Error(issue || "The permission declarations could not all be verified yet.")
        const expected = { ...this.snapshot, app: { ...this.snapshot.app, requiredResourceAccess } }
        if (signature(latest) !== signature(expected)) throw new Error("The registration or consent changed during verification. Consent was not written. Start a new preview.")
      }
      if (this.preview.consent.length) {
        this.guard(latest)
        await assertConnection()
        const grant = latest.grants[0]!
        const scope = [...new Set([...scopes(grant.scope), ...this.preview.consent])].join(" ")
        try {
          // Existing tenant-wide consent is a prerequisite. No grant is ever replaced or created.
          await this.graph("PATCH", `/oauth2PermissionGrants/${encodeURIComponent(grant.id)}`, { scope })
        } catch (error) { uncertain = true; issue = error instanceof Error ? error.message : String(error) }
        latest = await this.verify(s => declarationDone(s) && consentDone(s))
      }
    } catch (error) { issue = error instanceof Error ? error.message : String(error) }
    const declared = this.preview.declare.filter(n => declaredIds(latest.app).includes(this.ids.get(n)!.toLowerCase()))
    const consented = this.preview.consent.filter(n => consentedScopes(latest).includes(n))
    const missingDeclarations = this.options.additions.filter(n => !declaredIds(latest.app).includes(this.ids.get(n)!.toLowerCase()))
    const missingConsent = this.options.additions.filter(n => !consentedScopes(latest).includes(n))
    const complete = !missingDeclarations.length && !missingConsent.length
    return { state: complete ? "complete" : "partial", preview: this.preview, declared, consented, missingDeclarations, missingConsent, message: `${complete ? "The approved permissions are declared and consented." : "Only part of the approved change could be verified. No rollback was attempted."}${uncertain ? " A write did not return a successful answer and may have been applied. Read-back was attempted before reporting; start a new preview before retrying." : ""}${issue ? ` ${issue}` : ""}` }
  }
}

export function sameAdditionConnection(a: AdditionConnection, b: AdditionConnection): boolean {
  return eq(a.tenantId, b.tenantId) && eq(a.clientId, b.clientId) && eq(a.username, b.username) && a.homeAccountId === b.homeAccountId && sameSet(a.scopes, b.scopes) && sameSet(a.allowed, b.allowed)
}
