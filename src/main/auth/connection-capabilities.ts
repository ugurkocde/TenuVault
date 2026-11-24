import { RESOURCE_SCOPES } from "../../shared/constants"
import { isGuid } from "../../shared/security"
import { tenantWriteTargets } from "../../shared/tenant-writes"
import type { TenantConnection } from "../../shared/tenant-connection"
import { executionMetadata } from "../api/execution-metadata"

export const READ_ONLY = "Start now is read-only. Change sign-in method to restore, revert, deploy or copy policies."
const GRAPH_ONLY = "Start now only connects to Microsoft Graph. Change sign-in method to access other Microsoft services."

export class ConnectionCapabilities {
  constructor(private readonly connection: (tenantId: string) => TenantConnection | null) {}

  requireWrite(tenantIds: string[]): void {
    if (tenantIds.some(id => this.isGraphOnly(id))) throw new Error(READ_ONLY)
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
    if (method && method !== "ownApp") throw new Error("Interactive sign-in with this method is unavailable in this version.")
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
    return targets.some(id => this.isGraphOnly(id)) ? Response.json({ error: READ_ONLY }, { status: 403 }) : null
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
    if (!targets.some(id => this.isGraphOnly(id))) return
    if (method === "POST" && /^\/(?:beta|v1\.0)\/\$batch$/i.test(url.pathname)) {
      const batch = await new Request(input, init).clone().json().catch(() => null) as { requests?: Array<{ method?: unknown }> } | null
      if (Array.isArray(batch?.requests) && batch.requests.every(request => request?.method === "GET")) return
    }
    this.requireWrite(targets)
  }

  isGraphOnly(tenantId: string): boolean {
    return isGuid(tenantId) && this.connection(tenantId)?.method === "graphCli"
  }
}

function tokenTenant(authorization: string | null): string | null {
  if (!authorization?.startsWith("Bearer ")) return null
  try {
    const { tid } = JSON.parse(Buffer.from(authorization.split(".")[1] ?? "", "base64url").toString()) as { tid?: unknown }
    return isGuid(tid) ? tid : null
  } catch {
    return null
  }
}
