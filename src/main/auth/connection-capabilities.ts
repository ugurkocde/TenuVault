import { RESOURCE_SCOPES } from "../../shared/constants"
import { isGuid } from "../../shared/security"
import { tenantWriteTargets } from "../../shared/tenant-writes"
import { tokenIdentity } from "./token-identity"
import { grantedPermissions } from "../../shared/services/token"
import { isPackWriteScope, missingPackScopes, type PermissionPack } from "../../shared/services/permission-packs"
import { GRAPH_CLI_CLIENT_ID, TENUVAULT_CLIENT_ID } from "../../shared/tenant-connection"
import type { TenantConnection } from "../../shared/tenant-connection"
import { executionMetadata } from "../api/execution-metadata"

export const READ_ONLY = "Start now is read-only. Change sign-in method to restore, revert, deploy or copy policies."
const PACK_REQUIRED = "Approve the restore permission pack for this service in Sign-in and access."
const CONNECTION_CHANGED = "This tenant's sign-in method changed. Reload the tenant and try again."
const TOKEN_UNVERIFIED = "TenuVault could not verify the tenant and app in this access token. Sign in again."
const GRAPH_ONLY = "Start now only connects to Microsoft Graph. Change sign-in method to access other Microsoft services."

export class ConnectionCapabilities {
  constructor(
    private readonly connection: (tenantId: string) => TenantConnection | null,
    private readonly packs: (tenantId: string) => readonly PermissionPack[] = () => [],
    private readonly sharedEnabled: () => Promise<boolean> = async () => false,
  ) {}

  requireWrite(tenantIds: string[]): void {
    const blocker = this.writeBlocker(tenantIds)
    if (blocker) throw new Error(blocker)
  }

  requireResource(tenantId: string, scope: string): void {
    if (scope !== RESOURCE_SCOPES.graph && this.isGraphOnly(tenantId)) throw new Error(GRAPH_ONLY)
  }

  requireConnection(tenantId: string, clientId: string, scope: string): void {
    const record = isGuid(tenantId) ? this.connection(tenantId) : null
    if (record?.origin === "wizard" && record.clientId !== clientId.toLowerCase()) {
      throw new Error(CONNECTION_CHANGED)
    }
    const bound = executionMetadata.getStore()?.connections?.get(tenantId.toLowerCase())
    if (bound && bound !== clientId.toLowerCase()) throw new Error(CONNECTION_CHANGED)
    this.requireResource(tenantId, scope)
  }

  requireIssuedToken(tenantId: string, clientId: string, scope: string, token: string): void {
    this.requireConnection(tenantId, clientId, scope)
    const identity = tokenIdentity(token)
    if (identity.tenantId !== tenantId.toLowerCase() || identity.clientId !== clientId.toLowerCase()) throw new Error(TOKEN_UNVERIFIED)
  }

  requireInteractive(tenantId: string): void {
    const method = isGuid(tenantId) ? this.connection(tenantId)?.method : undefined
    if (method === "graphCli") throw new Error("Interactive sign-in with this method is unavailable in this version.")
  }

  async guard(request: Request): Promise<Response | null> {
    if (request.method !== "POST") return null
    const body: unknown = await request.clone().json().catch(() => null)
    if (!body || typeof body !== "object" || Array.isArray(body)) return null
    const path = new URL(request.url).pathname.replace(/\/$/, "")
    const input = body as Record<string, unknown>
    const targets = tenantWriteTargets(path, input)
    if (path === "/api/restore-directory" && input.action === "resume" && typeof input.tenantId === "string") targets.push(input.tenantId)
    // A read-only tenant also cannot initiate Copy to Tenants using its backup as the source.
    if (path === "/api/restore-backup" && "targetTenants" in body && targets.length &&
      "tenantId" in body && typeof body.tenantId === "string") targets.push(body.tenantId)
    const blocker = this.writeBlocker(targets)
    return blocker ? Response.json({ error: blocker }, { status: 403 }) : null
  }

  bindConnections(tenantIds: readonly string[]): ReadonlyMap<string, string | undefined> {
    const parent = executionMetadata.getStore()?.connections
    return new Map(tenantIds.map(id => {
      const record = this.record(id)
      return [id, parent?.has(id) ? parent.get(id) : record?.origin === "wizard" ? record.clientId : undefined]
    }))
  }

  async authorizeRequest(url: URL, input: RequestInfo | URL, init: RequestInit | undefined, routeTenant: string | null): Promise<void> {
    const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization")
    const token = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]
    const { tenantId, clientId } = tokenIdentity(token ?? "")
    const graph = url.origin === "https://graph.microsoft.com"
    const metadata = executionMetadata.getStore()
    const copy = metadata?.copyTenants
    const bound = metadata?.connections ?? (isGuid(routeTenant) ? this.bindConnections([routeTenant.toLowerCase()]) : undefined)
    const shared = clientId === TENUVAULT_CLIENT_ID
    const granted = grantedPermissions(token)
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    let writes = graph && method !== "GET" && method !== "HEAD" ? [url.pathname] : []
    if (graph && method === "POST" && /^\/(?:beta|v1\.0)\/\$batch$/i.test(url.pathname)) {
      // Inspect a copy so the real request keeps its body. Treat an uncopyable body as a write.
      const batch = init?.body instanceof ReadableStream ? null
        : await new Request(input instanceof Request ? input.clone() : input, init).json().catch(() => null) as { requests?: Array<{ method?: unknown; url?: unknown }> } | null
      writes = Array.isArray(batch?.requests) && batch.requests.length
        ? batch.requests.filter(step => step?.method !== "GET" && step?.method !== "HEAD").map(step =>
          typeof step?.url === "string" && step.url.startsWith("/") && !step.url.startsWith("//") ? step.url : "")
        : [""]
    }

    const microsoftResource = graph || url.hostname === "management.azure.com" || url.hostname === "api.securitycenter.microsoft.com" || url.hostname.endsWith(".blob.core.windows.net")
    if (token && (microsoftResource || shared || bound?.size) && (!tenantId || !clientId)) throw new Error(TOKEN_UNVERIFIED)
    if (shared && !await this.sharedEnabled()) throw new Error("TenuVault app sign-in is currently unavailable.")

    if (tenantId && clientId) {
      const current = this.record(tenantId)
      const admitted = bound?.get(tenantId)
      // Setup has its own temporary Graph CLI sign-in. Unattended backup uses a separate app-only reader.
      const alternate = !bound?.size && (clientId === GRAPH_CLI_CLIENT_ID || granted?.kind === "application")
      if ((bound?.size && !bound.has(tenantId)) || (admitted && admitted !== clientId) ||
        ((shared || (!alternate && current?.origin === "wizard")) && current?.clientId !== clientId)) throw new Error(CONNECTION_CHANGED)
    }

    if (!writes.length) return
    const targets = copy
      ? [copy.source, ...(tenantId && copy.destinations.includes(tenantId) ? [tenantId] : copy.destinations)]
      : [tenantId ?? routeTenant].filter((id): id is string => id !== null)
    this.requireWrite(targets)
    if (!shared) {
      const destination = tenantId ?? routeTenant
      if (destination && this.record(destination)?.method === "tenuvaultApp") throw new Error(PACK_REQUIRED)
      return
    }

    if (granted?.kind !== "delegated" || !tenantId) throw new Error(PACK_REQUIRED)
    const allowed = this.restorePacks(tenantId)
    if (writes.some(path => {
      const recycle = metadata?.directoryRecycle
      const type = method === "POST" && url.pathname === path && recycle?.path === path && /^\/beta\/directory\/deletedItems\/[0-9a-f-]+\/restore$/i.test(path) ? recycle.type : undefined
      const pack = allowed.find(pack => pack.id === (type ? "entra-restore" : restorePackForPath(path)))
      const scopes = type ? [type === "user" ? "User.DeleteRestore.All" : "Group.ReadWrite.All"] : []
      return !pack || missingPackScopes([...pack.scopes, ...scopes], granted.permissions).length > 0
    })) throw new Error(PACK_REQUIRED)
  }

  private record(tenant: string) {
    return isGuid(tenant) ? this.connection(tenant) : null
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
    return isGuid(tenantId) && this.connection(tenantId)?.method === "graphCli"
  }
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
