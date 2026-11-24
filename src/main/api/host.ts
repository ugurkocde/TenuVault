import { executionMetadata, type ExecutionMetadata } from "./execution-metadata"
import { assertStorageAccountName } from "../../shared/storage-account"
import type { ApiRequest, ApiResponse } from "../../shared/ipc"
import { INTERNAL_API_ORIGIN } from "../../shared/constants"
import { NextRequest } from "./next-server-shim"
import { withRouteTenant } from "../storage/blob-emulator"
import { isFeatureRoute } from "../../shared/feature-routes"
import { isGuid } from "../../shared/security"

/** Largest request body accepted over IPC, matching the 8 MB policies limit the routes enforce. */
export const MAX_IPC_BODY_BYTES = 8 * 1024 * 1024
export { DOWNLOAD_CANCELLED_HEADER } from "../../shared/constants"

const BULK_TENANT_ROUTES = new Set(["/api/restore-backup", "/api/backup/start", "/api/detect-drifts"])

type RouteHandler = (request: NextRequest) => Promise<Response> | Response
export type RouteModule = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS", RouteHandler>>

export interface ApiHostOptions {
  routes: Record<string, RouteModule>
  /** Returns a Response to short-circuit the request (for example when the license is not active). */
  guard?: (request: Request) => Response | null | Promise<Response | null>
  /** Called after every handled request, for example to write audit log entries. */
  onHandled?: (request: Request, requestBody: string, response: Response, metadata?: ExecutionMetadata) => void
  /** Streams large downloads to a native save destination before IPC can buffer them. */
  saveDownload?: (response: Response) => Promise<Response>
  bindConnections?: (tenantIds: readonly string[]) => ExecutionMetadata["connections"]
  /** Captures who started a request before its route runs, for audits recorded after a long save. */
  beforeRoute?: (request: Request, body: string, metadata: ExecutionMetadata) => void
  /** Adjusts responses before they reach the caller. */
  transform?: (response: Response) => Promise<Response>
}

/**
 * Runs the portal's API route handlers in-process.
 *
 * The renderer's `fetch("/api/...")` calls arrive over IPC and route code that calls
 * its own API (INTERNAL_API_ORIGIN) arrives through the fetch bridge; both end up here.
 */
export class ApiHost {
  constructor(private readonly options: ApiHostOptions) {}

  async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/$/, "")
    const route = this.options.routes[path]
    if (!route) {
      return Response.json({ error: `No desktop handler for ${url.pathname}` }, { status: 404 })
    }
    const handler = route[request.method.toUpperCase() as keyof RouteModule]
    if (!handler) {
      return Response.json({ error: `Method ${request.method} not allowed` }, { status: 405 })
    }

    // Every portal route shares this boundary, including internal API calls.
    let tenantId: unknown
    let storageAccountName: unknown
    const metadata: ExecutionMetadata = {}
    let participants: string[] = []
    if (request.method !== "GET" && request.method !== "HEAD") {
      const input: unknown = await request.clone().json().catch(() => null)
      if (input && typeof input === "object" && "tenantId" in input) tenantId = input.tenantId
      if (isGuid(tenantId) && input && typeof input === "object") {
        const source = tenantId.toLowerCase()
        const targets = "targetTenants" in input && Array.isArray(input.targetTenants)
          ? input.targetTenants.flatMap(target => isGuid(target?.tenantId) ? [target.tenantId.toLowerCase()] : [])
          : []
        // These routes validate the named tenants before using them. Capture their clients
        // before awaiting the guards so a mid-request switch cannot move the operation.
        if (isFeatureRoute(path) || BULK_TENANT_ROUTES.has(path)) participants = targets
        if (path === "/api/sync" && "action" in input && input.action === "target-objects" &&
          "targetTenantId" in input && isGuid(input.targetTenantId)) participants = [input.targetTenantId.toLowerCase()]
        if (path === "/api/restore-backup" && targets.length) metadata.copyTenants = { source, destinations: targets }
      }
      if (input && typeof input === "object" && "storageAccountName" in input) {
        try { assertStorageAccountName(input.storageAccountName) }
        catch { return Response.json({ error: "Invalid storage account name" }, { status: 400 }) }
        storageAccountName = input.storageAccountName
      }
    }

    const tenants = isGuid(tenantId) ? [...new Set([tenantId.toLowerCase(), ...participants])] : []
    const bind = this.options.bindConnections
    metadata.connections = bind?.(tenants)
    metadata.bindParticipants = bind && (ids => {
      const added = bind(ids.filter(id => !metadata.connections?.has(id)))
      if (added?.size) metadata.connections = new Map([...(metadata.connections ?? []), ...added])
    })
    const blocked = await this.options.guard?.(request)
    if (blocked) return blocked

    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text()
    // Bound before the route takes its token, so a sign-in that changes meanwhile never moves the audit.
    try { this.options.beforeRoute?.(request, body, metadata) } catch (error) { console.error(`[api] ${request.method} ${url.pathname} could not capture the audit binding:`, error) }
    // The archive stream keeps reading storage during the native save. Hold the route's tenant
    // context and local folder guard until the save settles.
    const response = await withRouteTenant(tenantId, () => executionMetadata.run(metadata, async () => {
      let response: Response
      try {
        response = await handler(new NextRequest(request))
      } catch (error) {
        console.error(`[api] ${request.method} ${url.pathname} failed:`, error)
        response = Response.json(
          { error: error instanceof Error ? error.message : "Unexpected error" },
          { status: 500 },
        )
      }
      if (this.options.transform) response = await this.options.transform(response)
      // A failed save is audited as a failed download. A cancelled save dialog is no download at all.
      if (response.ok && response.headers.get("content-type") === "application/x-tar" && this.options.saveDownload) {
        try {
          response = await this.options.saveDownload(response)
        } catch (error) {
          console.error(`[api] ${request.method} ${url.pathname} could not save the archive:`, error)
          response = Response.json({ error: "The archive could not be saved. No file was written." }, { status: 500 })
        }
      }
      return response
    }), storageAccountName)
    try {
      this.options.onHandled?.(request, body, response, metadata)
    } catch (error) {
      console.error(`[api] ${request.method} ${url.pathname} onHandled failed:`, error)
    }
    return response
  }

  /** IPC entry point: rebuilds a Request from the renderer and serializes the Response. */
  async handleIpc(input: ApiRequest): Promise<ApiResponse> {
    if (!input.path.startsWith("/api/")) {
      return { status: 400, statusText: "Bad Request", headers: {}, body: new Uint8Array() }
    }
    if (input.body !== undefined && !(input.body instanceof Uint8Array)) {
      return { status: 400, statusText: "Bad Request", headers: {}, body: new Uint8Array() }
    }
    if ((input.body?.byteLength ?? 0) > MAX_IPC_BODY_BYTES) {
      return {
        status: 413,
        statusText: "Payload Too Large",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ error: "The request is too large." })),
      }
    }
    const target = new URL(input.path, INTERNAL_API_ORIGIN)
    if (target.pathname.replace(/\/$/, "") === "/api/audit/log") {
      return { status: 403, statusText: "Forbidden", headers: {}, body: new TextEncoder().encode("Audit events are recorded by the main process.") }
    }
    const request = new Request(INTERNAL_API_ORIGIN + input.path, {
      method: input.method,
      headers: input.headers,
      body: input.body && input.body.byteLength > 0 ? new Uint8Array(input.body) : undefined,
    })
    const response = await this.dispatch(request)
    return {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: new Uint8Array(await response.arrayBuffer()),
    }
  }
}

/** Maps route module file paths from `import.meta.glob` to their `/api/...` paths. */
export function routesFromGlob(modules: Record<string, unknown>): Record<string, RouteModule> {
  const routes: Record<string, RouteModule> = {}
  for (const [file, module] of Object.entries(modules)) {
    const match = /\/app(\/api\/.*)\/route\.ts$/.exec(file)
    if (match?.[1]) routes[match[1]] = module as RouteModule
  }
  return routes
}
