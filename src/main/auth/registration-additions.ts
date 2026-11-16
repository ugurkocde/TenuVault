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
// Scopes come only from the connected access token's delegated claims, never MSAL's response scopes.
export interface AdditionConnection { tenantId: string; clientId: string; username: string; homeAccountId: string; scopes: string[]; allowed: readonly string[] }
export interface AdditionOptions { fetch: typeof fetch; token: string; connection: AdditionConnection; additions: readonly string[]; sleep?: (ms: number) => Promise<void> }
const ROOT = "https://graph.microsoft.com/v1.0"
const APP_FIELDS = "id,appId,displayName,signInAudience,publicClient,web,spa,passwordCredentials,keyCredentials,requiredResourceAccess"
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const scopes = (value: string) => value.split(/\s+/).filter(Boolean)
const scopeSet = (names: readonly string[]) => new Set(names.map(name => name.toLowerCase()))
function scopeUnion(names: readonly string[]): string[] {
  const seen = new Set<string>()
  return names.filter(name => {
    const key = name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
// The loopback listener accepts only the root path. Keep the textual host check strict so
// URL normalization cannot turn other IP spellings, credentials or paths into accepted redirects.
function localRedirect(uri: string): boolean {
  const match = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?\/?$/i.exec(uri)
  return !!match && (!match[1] || (Number(match[1]) > 0 && Number(match[1]) <= 65535))
}
const protocol = new Set(["openid", "profile", "email", "offline_access"])
const declaredIds = (app: Application) => app.requiredResourceAccess.filter(r => eq(r.resourceAppId, GRAPH_APP_ID)).flatMap(r => r.resourceAccess.filter(a => a.type === "Scope").map(a => a.id.toLowerCase()))
const consentedScopes = (snapshot: Snapshot) => snapshot.grants.filter(g => g.consentType === "AllPrincipals").flatMap(g => scopes(g.scope))
const sameSet = (a: readonly string[], b: readonly string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort())
// Property and array order are not meaningful to Graph's sets. The context annotation
// describes the response envelope and differs between an exact GET and a collection entry.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical).sort())
  if (value && typeof value === "object") return JSON.stringify(Object.entries(value).filter(([key]) => key !== "@odata.context").sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]))
  return JSON.stringify(value)
}
function signature(s: Snapshot): string {
  const principal = (p: Principal) => ({ ...p, id: p.id.toLowerCase(), appId: p.appId.toLowerCase(), oauth2PermissionScopes: p.oauth2PermissionScopes.map(scope => ({ ...scope, id: scope.id.toLowerCase() })) })
  return canonical({ app: { ...s.app, id: s.app.id.toLowerCase(), appId: s.app.appId.toLowerCase(), requiredResourceAccess: s.app.requiredResourceAccess.map(r => ({ ...r, resourceAppId: r.resourceAppId.toLowerCase(), resourceAccess: r.resourceAccess.map(a => ({ ...a, id: a.id.toLowerCase() })) })) }, client: principal(s.client), resource: principal(s.resource), grants: s.grants.map(g => ({ ...g, clientId: g.clientId.toLowerCase(), resourceId: g.resourceId.toLowerCase(), scope: [...scopeSet(scopes(g.scope))].sort() })) })
}

/** A read-preview-confirm flow, independent of MSAL and Electron and tested with injected fetch. */
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
      const permission = run.snapshot.resource.oauth2PermissionScopes.find(p => eq(p.value, name) && p.isEnabled)
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
    if (!eq(app.appId, this.options.connection.clientId) || app.signInAudience !== "AzureADMyOrg" || !Array.isArray(app.publicClient?.redirectUris) || !app.publicClient.redirectUris.length || !app.publicClient.redirectUris.every(localRedirect) || app.web?.redirectUris?.length !== 0 || app.spa?.redirectUris?.length !== 0) throw new Error("This registration is not a single-tenant public client with only local redirects. Use the other permission routes. Nothing was changed by this check.")
    if (![app.passwordCredentials, app.keyCredentials, client.passwordCredentials, client.keyCredentials].every(value => Array.isArray(value) && value.length === 0)) throw new Error("This registration or enterprise application has credentials, or their absence could not be verified. Use the other permission routes. Nothing was changed by this check.")
    if (!client.accountEnabled || !Array.isArray(app.requiredResourceAccess)) throw new Error("The registration is disabled or its declarations could not be read. Nothing was changed by this check.")
    if (grants.some(g => !eq(g.clientId, client.id) || g.consentType !== "AllPrincipals" || g.principalId !== null)) throw new Error("Individual Graph consent exists. An administrator must review these grants separately using the other routes. Nothing was changed by this check.")
    if (grants.length > 1) throw new Error("Multiple tenant-wide Graph grants need separate administrator review. Nothing was changed by this check.")
    const connected = this.options.connection.scopes.filter(name => !protocol.has(name.toLowerCase()))
    const consented = scopeSet(consentedScopes(s))
    if (!connected.length || connected.some(name => !consented.has(name.toLowerCase()))) throw new Error("This registration lacks tenant-wide consent for the Graph scopes of the connected account. Use the other permission routes. Nothing was changed by this check.")
  }
  private difference(s: Snapshot): Omit<PermissionAdditionPreview, "id" | "tenantId" | "clientId"> {
    const held = declaredIds(s.app)
    const consented = consentedScopes(s)
    const consentedSet = scopeSet(consented)
    return { displayName: s.app.displayName, declare: this.options.additions.filter(n => !held.includes(this.ids.get(n)!.toLowerCase())), consent: this.options.additions.filter(n => !consentedSet.has(n.toLowerCase())), declared: s.app.requiredResourceAccess.flatMap(r => r.resourceAccess.map(a => `${r.resourceAppId}/${a.type}/${a.id}`)), consented }
  }
  private async verify(test: (s: Snapshot) => boolean, preserved: (s: Snapshot) => boolean): Promise<Snapshot> {
    let latest!: Snapshot
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))([500, 1500, 3000][attempt - 1]!)
      latest = await this.read()
      if (!preserved(latest) || test(latest)) break
    }
    return latest
  }
  // Replication can delay our additions, but must not excuse a change to any other entry.
  private preserved(before: Snapshot, after: Snapshot, declare: readonly string[], consent: readonly string[]): boolean {
    const additionIds = declare.map(n => this.ids.get(n)!.toLowerCase())
    const app = { ...after.app, requiredResourceAccess: after.app.requiredResourceAccess.map(r => eq(r.resourceAppId, GRAPH_APP_ID)
      ? { ...r, resourceAccess: r.resourceAccess.filter(a => a.type !== "Scope" || !additionIds.includes(a.id.toLowerCase())) } : r)
      .filter(r => !eq(r.resourceAppId, GRAPH_APP_ID) || r.resourceAccess.length || before.app.requiredResourceAccess.some(old => eq(old.resourceAppId, GRAPH_APP_ID))) }
    const consentSet = scopeSet(consent)
    const grants = after.grants.map(g => ({ ...g, scope: scopes(g.scope).filter(n => !consentSet.has(n.toLowerCase())).join(" ") }))
    return signature({ ...after, app, grants }) === signature(before)
  }
  /** Called once for the exact stored preview. There is deliberately no automatic write retry. */
  async apply(assertConnection: () => Promise<void> = async () => {}): Promise<PermissionAdditionResult> {
    if (this.used) throw new Error("This preview was already used. Start a new preview.")
    this.used = true
    let latest = this.snapshot
    let expected = this.snapshot
    let issue = ""
    let uncertain = false
    let changed = false
    let wroteDeclarations = false
    const declarationDone = (s: Snapshot) => this.options.additions.every(n => declaredIds(s.app).includes(this.ids.get(n)!.toLowerCase()))
    const consentDone = (s: Snapshot) => this.options.additions.every(n => scopeSet(consentedScopes(s)).has(n.toLowerCase()))
    const stopIfChanged = () => {
      if (signature(latest) === signature(expected)) return false
      changed = true
      issue = `The registration or consent changed since the preview. ${wroteDeclarations ? "Declarations were written, but consent was not written." : "Nothing was written."} Review the current state below and start a new preview.`
      return true
    }
    const concurrent = "Another change happened at the same time; check in Entra before retrying. No further write was attempted."
    try {
      await assertConnection()
      latest = await this.read()
      if (!stopIfChanged()) {
        this.guard(latest)
        if (this.preview.declare.length) {
          // All awaited checks finish first. Graph documents no conditional update here, so
          // read the exact value and trust fields last, then PATCH without another await.
          latest = { ...latest, app: await this.graph<Application>("GET", `/applications/${encodeURIComponent(latest.app.id)}?$select=${APP_FIELDS}`) }
          if (!stopIfChanged()) {
            this.guard(latest)
            const before = latest
            const requiredResourceAccess = structuredClone(before.app.requiredResourceAccess)
            let resource = requiredResourceAccess.find(r => eq(r.resourceAppId, GRAPH_APP_ID))
            if (!resource) requiredResourceAccess.push(resource = { resourceAppId: GRAPH_APP_ID, resourceAccess: [] })
            resource.resourceAccess.push(...this.preview.declare.map(n => ({ id: this.ids.get(n)!, type: "Scope" })))
            wroteDeclarations = true
            try { await this.graph("PATCH", `/applications/${encodeURIComponent(before.app.id)}`, { requiredResourceAccess }) }
            catch (error) { uncertain = true; issue = error instanceof Error ? error.message : String(error) }
            const preserved = (s: Snapshot) => this.preserved(before, s, this.preview.declare, [])
            latest = await this.verify(declarationDone, preserved)
            if (!preserved(latest)) throw new Error(concurrent)
            // No further write after a refused or unanswered write, even if it was applied.
            if (issue || !declarationDone(latest)) throw new Error(issue || "The permission declarations could not all be verified yet.")
            expected = { ...before, app: { ...before.app, requiredResourceAccess } }
          }
        }
        if (!changed && this.preview.consent.length) {
          await assertConnection()
          latest = await this.read()
          if (!stopIfChanged()) {
            this.guard(latest)
            // Read the exact approved tenant-wide grant last, not a value from the earlier list.
            const grant = await this.graph<Grant>("GET", `/oauth2PermissionGrants/${encodeURIComponent(latest.grants[0]!.id)}`)
            latest = { ...latest, grants: [grant] }
            if (!stopIfChanged()) {
              this.guard(latest)
              const before = latest
              const scope = scopeUnion([...scopes(grant.scope), ...this.preview.consent]).join(" ")
              try {
                // Existing tenant-wide consent is a prerequisite. No grant is created or deleted.
                await this.graph("PATCH", `/oauth2PermissionGrants/${encodeURIComponent(grant.id)}`, { scope })
              } catch (error) { uncertain = true; issue = error instanceof Error ? error.message : String(error) }
              const preserved = (s: Snapshot) => this.preserved(before, s, [], this.preview.consent)
              latest = await this.verify(s => declarationDone(s) && consentDone(s), preserved)
              if (!preserved(latest)) throw new Error(concurrent)
            }
          }
        }
      }
    } catch (error) { issue = error instanceof Error ? error.message : String(error) }
    const declared = this.preview.declare.filter(n => declaredIds(latest.app).includes(this.ids.get(n)!.toLowerCase()))
    const latestConsent = scopeSet(consentedScopes(latest))
    const consented = this.preview.consent.filter(n => latestConsent.has(n.toLowerCase()))
    const missingDeclarations = this.options.additions.filter(n => !declaredIds(latest.app).includes(this.ids.get(n)!.toLowerCase()))
    const missingConsent = this.options.additions.filter(n => !latestConsent.has(n.toLowerCase()))
    const complete = !issue && !missingDeclarations.length && !missingConsent.length
    return { state: changed ? "changed" : complete ? "complete" : "partial", preview: changed ? { ...this.preview, ...this.difference(latest) } : this.preview, declared, consented, missingDeclarations, missingConsent, message: changed ? issue : `${complete ? "The approved permissions are declared and consented." : "Only part of the approved change could be verified. No rollback was attempted."}${uncertain ? " A write did not return a successful answer and may have been applied. Read-back was attempted before reporting; start a new preview before retrying." : ""}${issue ? ` ${issue}` : ""}` }
  }
}

export function sameAdditionConnection(a: AdditionConnection, b: AdditionConnection): boolean {
  return eq(a.tenantId, b.tenantId) && eq(a.clientId, b.clientId) && eq(a.username, b.username) && a.homeAccountId === b.homeAccountId && sameSet([...scopeSet(a.scopes)], [...scopeSet(b.scopes)]) && sameSet(a.allowed, b.allowed)
}
