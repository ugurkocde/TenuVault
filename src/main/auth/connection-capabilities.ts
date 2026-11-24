import { RESOURCE_SCOPES } from "../../shared/constants"
import { isGuid } from "../../shared/security"
import { tenantWriteTargets } from "../../shared/tenant-writes"
import { grantedPermissions } from "../../shared/services/token"
import { isPackWriteScope, missingPackScopes, type PermissionPack } from "../../shared/services/permission-packs"
import { TENUVAULT_CLIENT_ID } from "../../shared/tenant-connection"
import type { TenantConnection } from "../../shared/tenant-connection"
import { executionMetadata } from "../api/execution-metadata"

export const READ_ONLY = "Start now is read-only. Change sign-in method to restore, revert, deploy or copy policies."
const PACK_REQUIRED = "Approve the restore permission pack for this service in Sign-in and access."
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
      throw new Error("This tenant's sign-in method changed. Reload the tenant and try again.")
    }
    this.requireResource(tenantId, scope)
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

  /** Catch a write that acquired a token before the tenant switched methods. */
  async authorizeGraphRequest(url: URL, input: RequestInfo | URL, init: RequestInit | undefined, routeTenant: string | null): Promise<void> {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    if (method === "GET" || method === "HEAD") return
    const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization")
    const tokenId = tokenTenant(authorization)?.toLowerCase()
    const copy = executionMetadata.getStore()?.copyTenants
    // Copy writes belong to the source as well as the destination, even after tokens were issued.
    // If the token's tenant cannot identify a destination, recheck every bound destination.
    const targets = copy
      ? [copy.source, ...(tokenId && copy.destinations.includes(tokenId) ? [tokenId] : copy.destinations)]
      : [tokenId ?? routeTenant].filter((id): id is string => id !== null)
    const shared = targets.filter(id => this.record(id)?.method === "tenuvaultApp")
    if (!shared.length && !targets.some(id => this.isGraphOnly(id))) return
    let writes = [url.pathname]
    if (method === "POST" && /^\/(?:beta|v1\.0)\/\$batch$/i.test(url.pathname)) {
      const batch = await new Request(input, init).clone().json().catch(() => null) as { requests?: Array<{ method?: unknown; url?: unknown }> } | null
      if (Array.isArray(batch?.requests)) writes = batch.requests.filter(request => request?.method !== "GET").map(request =>
        typeof request?.url === "string" && request.url.startsWith("/") && !request.url.startsWith("//") ? request.url : "")
      else writes = [""]
      if (!writes.length) return
    }
    this.requireWrite(targets)
    if (!shared.length) return
    if (!await this.sharedEnabled()) throw new Error("TenuVault app sign-in is currently unavailable.")
    // The token for a copy belongs to its destination. The source only needs a verified restore pack.
    const destinations = shared.filter(tenant => !copy || tenant !== copy.source || copy.destinations.includes(tenant))
    if (!destinations.length) return
    const granted = grantedPermissions(authorization?.replace(/^Bearer /, ""))
    if (granted?.kind !== "delegated" || tokenClient(authorization) !== TENUVAULT_CLIENT_ID) throw new Error(PACK_REQUIRED)
    for (const tenant of destinations) {
      const allowed = this.restorePacks(tenant)
      if (tenant !== tokenId || writes.some(path => {
        const pack = allowed.find(pack => pack.id === restorePackForPath(path))
        return !pack || missingPackScopes(pack.scopes, granted.permissions).length > 0
      })) throw new Error(PACK_REQUIRED)
    }
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

function tokenClient(authorization: string | null): string | null {
  const claims = tokenClaims(authorization)
  const client = claims?.azp ?? claims?.appid
  return isGuid(client) ? client.toLowerCase() : null
}

function tokenTenant(authorization: string | null): string | null {
  const tid = tokenClaims(authorization)?.tid
  return isGuid(tid) ? tid : null
}

function tokenClaims(authorization: string | null): { tid?: unknown; azp?: unknown; appid?: unknown } | null {
  if (!authorization?.startsWith("Bearer ")) return null
  try {
    return JSON.parse(Buffer.from(authorization.split(".")[1] ?? "", "base64url").toString())
  } catch {
    return null
  }
}
