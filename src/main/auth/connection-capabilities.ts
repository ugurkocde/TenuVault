import type { TokenGrant } from "./network-client"
import { graphCliScopes } from "./connection-coverage"
import { localStorageAccountName, RESOURCE_SCOPES } from "../../shared/constants"
import { isGuid, normalizeGuid } from "../../shared/security"
import { privilegedRestoreEnabled, DEFERRED_RESTORE_MESSAGE } from "../../shared/intune/directory-review-folders"
import { admittedDirectoryPermissions } from "../../shared/intune/restore-matrix"
import { tenantWriteTargets } from "../../shared/tenant-writes"
import { accessTokenDigest, observedTokenGrant, sharedTokenScopes, tokenIdentity } from "./token-identity"
import { APPLICATION_METADATA_RESTORE_PACK, GRANT_REMOVAL_SCOPE, isPackWriteScope, missingPackScopes, type PermissionPack } from "../../shared/services/permission-packs"
import { CONNECTION_WRITE_REFUSED, GRAPH_CLI_CLIENT_ID, GRAPH_CLI_DISABLED, GRAPH_CLI_NEXT_STEP, GRAPH_CLI_READ_ONLY, sharedSignInMethod as sharedMethod } from "../../shared/tenant-connection"
import type { TenantConnection } from "../../shared/tenant-connection"
import { executionMetadata } from "../api/execution-metadata"
import type { RequestAuthorization } from "../api/fetch-bridge"

export const READ_ONLY = GRAPH_CLI_READ_ONLY
const PACK_REQUIRED = "Approve the restore permission pack for this service in Sign-in and access."
const CONNECTION_CHANGED = "This tenant's sign-in method changed. Reload the tenant and try again."
const TOKEN_UNVERIFIED = "TenuVault could not verify the tenant and app in this access token. Sign in again."
type SharedMethod = NonNullable<ReturnType<typeof sharedMethod>>
type IssuedToken = TokenGrant & { tenantId: string; clientId: string; scope: string; expiresAt: number; reader?: true }
const GRAPH_ONLY = `Start now only connects to Microsoft Graph and uses local backup storage. ${GRAPH_CLI_NEXT_STEP}`

export interface AppRestoreAuthorization {
  connections: ReadonlyMap<string, string | undefined>
  authorize: () => Promise<void>
}

export class ConnectionCapabilities {
  // Retain the acquisition context in memory, keyed by a digest so opaque bearers stay untouched.
  private readonly issued = new Map<string, IssuedToken>()

  constructor(
    private readonly connection: (tenantId: string) => TenantConnection | null,
    private readonly packs: (tenantId: string) => readonly PermissionPack[] = () => [],
    private readonly sharedEnabled: (method: SharedMethod, fresh?: boolean) => Promise<boolean> = async () => false,
    private readonly sharedEnabledNow?: (method: SharedMethod) => boolean,
  ) {}

  requireWrite(tenantIds: string[]): void {
    const blocker = this.writeBlocker(tenantIds)
    if (blocker) throw new Error(blocker)
  }

  requireResource(tenantId: string, scope: string): void {
    if (scope !== RESOURCE_SCOPES.graph && this.isGraphOnly(tenantId)) throw new Error(GRAPH_ONLY)
  }

  requireConnection(tenantId: string, clientId: string, scope: string): void {
    const record = this.record(tenantId)
    if (record?.origin === "wizard" && normalizeGuid(record.clientId) !== normalizeGuid(clientId)) {
      throw new Error(CONNECTION_CHANGED)
    }
    const bound = executionMetadata.getStore()?.connections?.get(normalizeGuid(tenantId))
    if (bound && (sharedMethod(bound) || sharedMethod(clientId)) && normalizeGuid(bound) !== normalizeGuid(clientId)) {
      throw new Error(CONNECTION_CHANGED)
    }
    this.requireResource(tenantId, scope)
  }

  async requireConnectionEnabled(tenantId: string, clientId: string, scope: string = RESOURCE_SCOPES.graph, fresh = false): Promise<void> {
    const method = sharedMethod(clientId)
    if (method && !await this.sharedEnabled(method, fresh)) {
      throw sharedUnavailable(method)
    }
    this.requireConnection(tenantId, clientId, scope)
  }

  requireIssuedToken(tenantId: string, clientId: string, scope: string, token: string, result?: TokenGrant & { expiresOn?: Date | null }): void {
    if (sharedMethod(clientId) || sharedMethod(this.record(tenantId)?.clientId ?? null)) {
      this.requireConnection(tenantId, clientId, scope)
    }
    tenantId = normalizeGuid(tenantId)
    clientId = normalizeGuid(clientId)
    if (sharedMethod(clientId)) {
      const identity = tokenIdentity(token)
      if (identity.decoded && (identity.tenantId !== tenantId || identity.clientId !== clientId)) throw new Error(TOKEN_UNVERIFIED)
    }
    this.rememberToken(token, { tenantId, clientId, scope, expiresAt: result?.expiresOn?.getTime() ?? Date.now() + 3600_000, grantedScopes: result?.grantedScopes })
  }

  bindOwnClientCredentials(tenantId: string, clientId: string, scope: string, token: string, expiresIn?: number): void {
    if (!isGuid(tenantId) || !isGuid(clientId) || sharedMethod(clientId)) return
    this.requireIssuedToken(tenantId, clientId, scope, token, {
      expiresOn: new Date(Date.now() + (expiresIn ?? 3600) * 1000),
    })
  }

  /** Called by the Backup Reader only after its credential and resource checks passed. */
  bindReaderToken(tenantId: string, clientId: string, scope: string, token: string, expiresOn?: Date | null): void {
    this.rememberToken(token, { tenantId: normalizeGuid(tenantId), clientId: normalizeGuid(clientId), scope, expiresAt: expiresOn?.getTime() ?? Date.now() + 3600_000, reader: true })
  }

  private rememberToken(token: string, binding: IssuedToken): void {
    const now = Date.now()
    for (const [key, value] of this.issued) if (value.expiresAt <= now) this.issued.delete(key)
    this.issued.set(accessTokenDigest(token), binding)
  }

  appRestoreAuthorization(source: string, destination: string): AppRestoreAuthorization {
    const connections = this.bindConnections([source, destination])
    const sourceClient = connections.get(normalizeGuid(source)) ?? null
    const destinationClient = connections.get(normalizeGuid(destination)) ?? null
    this.requireNonGraphCli(source)
    this.requireNonGraphCli(destination)
    return {
      connections,
      authorize: async () => {
        this.requireNonGraphCli(source)
        await this.requireAppRestoreWrite(destination, destinationClient)
        this.requireNonGraphCli(source)
        this.requireBoundParticipant(source, sourceClient)
      },
    }
  }

  async requireAppRestoreWrite(tenantId: string, admittedClientId: string | null): Promise<void> {
    this.requireWrite([tenantId])
    const currentClientId = this.record(tenantId)?.clientId ?? null
    if (!sharedMethod(admittedClientId) && !sharedMethod(currentClientId)) return
    if (!admittedClientId || !currentClientId || normalizeGuid(admittedClientId) !== normalizeGuid(currentClientId)) {
      throw new Error(CONNECTION_CHANGED)
    }
    await this.requireConnectionEnabled(tenantId, admittedClientId, RESOURCE_SCOPES.graph, true)
    this.requireWrite([tenantId])
    if (sharedMethod(admittedClientId) === "tenuvaultApp" && !this.restorePacks(tenantId).some(pack => pack.id === "intune-restore")) {
      throw new Error(PACK_REQUIRED)
    }
  }

  requireInteractive(tenantId: string): void {
    const method = this.record(tenantId)?.method
    if (method === "graphCli") throw new Error(GRAPH_CLI_NEXT_STEP)
  }

  requireNonGraphCli(tenantId: string): void {
    if (this.isGraphOnly(tenantId)) throw new Error(READ_ONLY)
  }

  async guard(request: Request): Promise<Response | null> {
    if (request.method !== "POST") return null
    const body: unknown = await request.clone().json().catch(() => null)
    if (!body || typeof body !== "object" || Array.isArray(body)) return null
    const path = new URL(request.url).pathname.replace(/\/$/, "")
    const input = body as Record<string, unknown>
    if (path === "/api/backup/start" && typeof input.tenantId === "string" && this.isGraphOnly(input.tenantId) &&
      input.storageAccountName !== localStorageAccountName(input.tenantId)) {
      return Response.json({ error: GRAPH_ONLY }, { status: 403 })
    }
    const targets = tenantWriteTargets(path, input)
    if (path === "/api/restore-directory" && input.action === "resume" && typeof input.tenantId === "string") targets.push(input.tenantId)
    // A read-only tenant also cannot initiate Copy to Tenants using its backup as the source.
    if (path === "/api/restore-backup" && "targetTenants" in body && targets.length &&
      "tenantId" in body && typeof body.tenantId === "string") targets.push(body.tenantId)
    const blocker = this.writeBlocker(targets)
    return blocker ? Response.json({ error: blocker, ...(path === "/api/restore-backup" && { code: CONNECTION_WRITE_REFUSED }) }, { status: 403 }) : null
  }

  bindConnections(tenantIds: readonly string[]): ReadonlyMap<string, string | undefined> {
    const parent = executionMetadata.getStore()?.connections
    return new Map(tenantIds.map(tenant => {
      const id = normalizeGuid(tenant)
      const record = this.record(id)
      return [id, parent?.has(id) ? parent.get(id) : record?.clientId]
    }))
  }

  withTenantConnection<T>(tenantId: string, run: () => T): T {
    const parent = executionMetadata.getStore()
    if (parent?.connections?.has(normalizeGuid(tenantId))) return run()
    const connections = new Map([...parent?.connections ?? [], ...this.bindConnections([tenantId])])
    return executionMetadata.run({ ...parent, connections }, run)
  }

  graphCliGrant(token: string): ReadonlySet<string> | undefined {
    const acquisition = this.issued.get(accessTokenDigest(token))
    const explicit = acquisition?.clientId === GRAPH_CLI_CLIENT_ID && acquisition.expiresAt > Date.now() ? acquisition.grantedScopes : undefined
    return graphCliScopes(token, explicit)
  }

  graphGrant(token: string): ReturnType<typeof observedTokenGrant> {
    const acquisition = this.issued.get(accessTokenDigest(token))
    const scopes = acquisition?.scope === RESOURCE_SCOPES.graph && !acquisition.reader && acquisition.expiresAt > Date.now()
      ? acquisition.grantedScopes : undefined
    return observedTokenGrant(token, scopes)
  }

  async authorizeRequest(url: URL, input: RequestInfo | URL, init: RequestInit | undefined, routeTenant: string | null): Promise<void | RequestAuthorization> {
    const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization")
    const token = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]
    const digest = token ? accessTokenDigest(token) : undefined
    const metadata = executionMetadata.getStore()
    const graph = url.origin === "https://graph.microsoft.com"
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const mutation = method !== "GET" && method !== "HEAD"
    const graphWrite = graph && mutation
    const resource = graph ? RESOURCE_SCOPES.graph
      : url.hostname === "management.azure.com" ? RESOURCE_SCOPES.management
      : url.hostname.endsWith(".blob.core.windows.net") ? RESOURCE_SCOPES.storage
      : url.hostname === "api.securitycenter.microsoft.com" ? "https://api.securitycenter.microsoft.com/.default" : undefined
    const azureWrite = mutation && (resource === RESOURCE_SCOPES.management || resource === RESOURCE_SCOPES.storage)
    const registration = metadata?.registrationSetup ?? metadata?.registrationAddition
    if (registration && graph) {
      const { tenantId, clientId, tokenDigest } = registration
      const setup = Boolean(metadata?.registrationSetup)
      if ((setup ? clientId !== GRAPH_CLI_CLIENT_ID : !isGuid(clientId) || sharedMethod(clientId)) ||
        !isGuid(tenantId) || tokenDigest !== digest ||
        (routeTenant && normalizeGuid(routeTenant) !== tenantId)) throw new Error(TOKEN_UNVERIFIED)
      if (!graphWrite) return
      // The temporary consent bearer is separate from the tenant's persisted connection.
      const connections = setup ? this.bindConnections([tenantId]) : new Map([[tenantId, clientId]])
      return { beforeDispatch: () => this.requireWriteDispatch(connections) }
    }
    const acquisition = digest ? this.issued.get(digest) : undefined
    const identity = token && !acquisition ? tokenIdentity(token) : undefined
    const tenantId = acquisition?.tenantId ?? identity?.tenantId
    const clientId = acquisition?.clientId ?? identity?.clientId ?? null
    const copy = metadata?.copyTenants
    const bound = metadata?.connections ?? (isGuid(routeTenant) ? this.bindConnections([routeTenant]) : undefined)
    const shared = sharedMethod(clientId)
    // Own registrations keep the original transport. Their acquisition context is used
    // only when a shared connection participates or a tenant switches to one in flight.
    const usesSharedConnection = () => shared || (bound && [...bound].some(([id, admitted]) =>
      sharedMethod(admitted ?? null) || sharedMethod(this.record(id)?.clientId ?? null))) ||
      (tenantId && sharedMethod(this.record(tenantId)?.clientId ?? null))
    const appRestoreDestination = metadata?.appRestoreDestination
    if (!graphWrite && !azureWrite && !appRestoreDestination && !(graph && (bound?.size ?? 0) > 1) && !usesSharedConnection()) return
    if (!graph && shared === "graphCli") throw new Error(GRAPH_ONLY)
    let writes = graphWrite ? [url.pathname] : []
    if (graph && method === "POST" && /^\/(?:beta|v1\.0)\/\$batch$/i.test(url.pathname)) {
      // Inspect a copy so the real request keeps its body. Treat an uncopyable body as a write.
      const batch = init?.body instanceof ReadableStream ? null
        : await new Request(input instanceof Request ? input.clone() : input, init).json().catch(() => null) as { requests?: Array<{ method?: unknown; url?: unknown }> } | null
      writes = Array.isArray(batch?.requests) && batch.requests.length
        ? batch.requests.filter(step => typeof step?.method !== "string" || !["GET", "HEAD"].includes(step.method.toUpperCase())).map(step =>
          typeof step?.url === "string" && step.url.startsWith("/") && !step.url.startsWith("//") ? step.url : "")
        : [""]
    }

    const tenantWrite = writes.length > 0 || azureWrite
    const checkAtDispatch = tenantWrite || Boolean(shared) || Boolean(appRestoreDestination) || (graph && (bound?.size ?? 0) > 1)
    const writeConnections = new Map(bound)
    if (tenantWrite && tenantId && !writeConnections.has(tenantId)) {
      // A Backup Reader token names an unattended app, so bind the tenant's sign-in instead.
      writeConnections.set(tenantId, azureWrite && acquisition?.reader ? this.record(tenantId)?.clientId : clientId ?? undefined)
    }

    const temporary = metadata?.directoryTemporaryWrite
    if (graph && temporary && graphWrite) {
      if (!privilegedRestoreEnabled) throw new Error(DEFERRED_RESTORE_MESSAGE)
      const scopes = temporary.kind === "metadata" ? APPLICATION_METADATA_RESTORE_PACK.scopes : [GRANT_REMOVAL_SCOPE]
      const pathAllowed = temporary.kind === "metadata"
        ? method === "PATCH" && isGuid(url.pathname.split("/")[3]) && /^\/beta\/applications\/[^/]+$/.test(url.pathname)
        : ["PATCH", "DELETE"].includes(method) && /^\/beta\/oauth2PermissionGrants\/[A-Za-z0-9_-]+$/.test(url.pathname)
      if (!token || !acquisition || !tenantId || shared !== "tenuvaultApp" || temporary.tenantId !== tenantId ||
        temporary.tokenDigest !== digest || temporary.method !== method || temporary.path !== url.pathname ||
        url.search || !pathAllowed || (routeTenant && normalizeGuid(routeTenant) !== tenantId) ||
        acquisition.scope !== RESOURCE_SCOPES.graph || missingPackScopes(scopes, sharedTokenScopes(token, acquisition.grantedScopes)).length) throw new Error(TOKEN_UNVERIFIED)
      return { url, beforeDispatch: () => {
        this.requireBoundParticipant(tenantId, clientId)
        if (acquisition.expiresAt <= Date.now()) throw new Error(TOKEN_UNVERIFIED)
        if (temporary.kind === "metadata") {
          this.requireWrite([tenantId])
          this.requireSharedEnabledNow(shared)
        }
      } }
    }

    const check = () => {
      if (tenantWrite || appRestoreDestination) this.requireWriteDispatch(writeConnections)
      if (shared) this.requireSharedEnabledNow(shared)
      if (!usesSharedConnection()) return
      if (appRestoreDestination && bound) {
        if (this.record(appRestoreDestination)?.method === "tenuvaultApp" &&
          !this.restorePacks(appRestoreDestination).some(pack => pack.id === "intune-restore")) throw new Error(PACK_REQUIRED)
      }
      if (!graph && (shared === "graphCli" || (resource && bound && [...bound.keys()].some(id => this.isGraphOnly(id))))) throw new Error(GRAPH_ONLY)
      if (acquisition?.reader && tenantId && this.isGraphOnly(tenantId)) throw new Error(READ_ONLY)
      if (token && (resource || shared || bound?.size) && (!tenantId || !clientId)) throw new Error(TOKEN_UNVERIFIED)
      if (acquisition && (acquisition.expiresAt <= Date.now() || (resource && acquisition.scope !== resource))) throw new Error(TOKEN_UNVERIFIED)

      if (tenantId && clientId) {
        const current = this.record(tenantId)
        const admitted = bound?.get(tenantId)
        if (bound?.size && !bound.has(tenantId)) throw new Error(CONNECTION_CHANGED)
        // An unrelated shared participant does not pin two own registrations to one client ID.
        if (!acquisition?.reader && (shared || sharedMethod(admitted ?? null) || sharedMethod(current?.clientId ?? null))) {
          if (admitted && normalizeGuid(admitted) !== clientId) throw new Error(CONNECTION_CHANGED)
          if ((shared || current?.origin === "wizard" || (acquisition && current)) && (!current || normalizeGuid(current.clientId) !== clientId)) {
            throw new Error(CONNECTION_CHANGED)
          }
        }
      }

      if (!writes.length) return
      const targets = copy
        ? [copy.source, ...(tenantId && copy.destinations.some(id => normalizeGuid(id) === tenantId) ? [tenantId] : copy.destinations)]
        : [tenantId ?? routeTenant].filter((id): id is string => id != null)
      this.requireWrite(targets)
      if (acquisition?.reader || shared === "graphCli") throw new Error(READ_ONLY)
      if (shared !== "tenuvaultApp") {
        if (!token && targets.some(id => this.record(id)?.method === "tenuvaultApp")) throw new Error(PACK_REQUIRED)
        return
      }

      if (!token || !tenantId) throw new Error(PACK_REQUIRED)
      const permissions = sharedTokenScopes(token, acquisition?.grantedScopes)
      const allowed = this.restorePacks(tenantId)
      if (writes.some(path => {
        const recycle = metadata?.directoryRecycle
        const type = method === "POST" && url.pathname === path && recycle?.path === path && /^\/beta\/directory\/deletedItems\/[0-9a-f-]+\/restore$/i.test(path) ? recycle.type : undefined
        const pack = allowed.find(pack => pack.id === (type ? "entra-restore" : restorePackForPath(path)))
        const scopes = type === "user" ? admittedDirectoryPermissions("Users", "recycle") : type === "group" ? ["Group.ReadWrite.All"] : []
        if (type === "user" && !scopes.length) return true
        return !pack || missingPackScopes([...pack.scopes, ...scopes], permissions).length > 0
      })) throw new Error(PACK_REQUIRED)
    }
    if (shared && tenantId && clientId) await this.requireConnectionEnabled(tenantId, clientId, RESOURCE_SCOPES.graph, true)
    // The bridge calls the dispatch check after its last await, in the same turn as fetch.
    if (!checkAtDispatch) check()
    const beforeDispatch = checkAtDispatch ? check : undefined
    if (writes.length || shared !== "graphCli") return beforeDispatch ? { beforeDispatch } : undefined

    // Some shared readers still construct a versioned URL for an own registration.
    const path = url.pathname.replace(/^\/v1\.0(?=\/)/i, "/beta")
    if (!path.startsWith("/beta/")) throw new Error(GRAPH_ONLY)
    const beta = new URL(url)
    beta.pathname = path
    return { url: beta, beforeDispatch }
  }

  private requireWriteDispatch(connections: ReadonlyMap<string, string | undefined>): void {
    for (const [tenant, admitted] of connections) {
      this.requireNonGraphCli(tenant)
      this.requireBoundParticipant(tenant, admitted ?? null)
      const method = sharedMethod(admitted ?? null)
      if (method) this.requireSharedEnabledNow(method)
    }
  }

  private requireSharedEnabledNow(method: SharedMethod): void {
    if (this.sharedEnabledNow?.(method) === false) throw sharedUnavailable(method)
  }

  private requireBoundParticipant(tenant: string, admitted: string | null): void {
    const current = this.record(tenant)?.clientId ?? null
    if ((sharedMethod(admitted) || sharedMethod(current)) && admitted !== current) throw new Error(CONNECTION_CHANGED)
  }

  private record(tenant: string) {
    return isGuid(tenant) ? this.connection(normalizeGuid(tenant)) : null
  }

  private restorePacks(tenant: string): PermissionPack[] {
    const verified = new Set(this.record(tenant)?.graphScopes ?? [])
    return this.packs(tenant).filter(pack => pack.id.endsWith("-restore") && pack.scopes.some(isPackWriteScope) &&
      missingPackScopes(pack.scopes, verified).length === 0)
  }

  private writeBlocker(tenants: string[]): string | undefined {
    if (tenants.some(id => this.isGraphOnly(id))) return READ_ONLY
    if (tenants.some(id => this.record(id)?.method === "tenuvaultApp" && !this.restorePacks(id).length)) return PACK_REQUIRED
  }

  isGraphOnly(tenantId: string): boolean {
    return this.record(tenantId)?.method === "graphCli"
  }
}

function sharedUnavailable(method: SharedMethod): Error {
  return new Error(method === "graphCli" ? `${GRAPH_CLI_DISABLED} ${GRAPH_CLI_NEXT_STEP}` : "TenuVault app sign-in is currently unavailable.")
}

function restorePackForPath(path: string): string | undefined {
  const graph = path.toLowerCase().split("?")[0]!.replace(/^\/(?:beta|v1\.0)\//, "/")
  if (!/^\/[a-z]/.test(graph) || graph.includes("%") || graph.includes("\\") || /\/(?:\.|\.\.)(?:\/|$)/.test(graph)) return
  if (/^\/(?:devicemanagement|deviceappmanagement)(?:\/|$)/.test(graph)) return "intune-restore"
  if (/^\/identity\/conditionalaccess(?:\/|$)/.test(graph)) return "conditionalAccess-restore"
  if (/^\/security(?:\/|$)/.test(graph) || /^\/rolemanagement\/defender(?:\/|$)/.test(graph)) return "defender-restore"
  if (/^\/(?:applications|serviceprincipals|oauth2permissiongrants|rolemanagement|directory\/(?:deleteditems|administrativeunits)|identitygovernance\/privilegedaccess)(?:\/|$)/.test(graph)) return
  return "entra-restore"
}
