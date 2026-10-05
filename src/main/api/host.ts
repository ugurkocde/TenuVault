import { assertStorageAccountName } from "../../shared/storage-account"
import type { ApiRequest, ApiResponse } from "../../shared/ipc"
import { INTERNAL_API_ORIGIN } from "../../shared/constants"
import { NextRequest } from "./next-server-shim"
import { withRouteTenant } from "../storage/blob-emulator"

type RouteHandler = (request: NextRequest) => Promise<Response> | Response
export type RouteModule = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS", RouteHandler>>

export interface ApiHostOptions {
  routes: Record<string, RouteModule>
  /** Returns a Response to short-circuit the request (for example when the license is not active). */
  guard?: (request: Request) => Response | null | Promise<Response | null>
  /** Called after every handled request, for example to write audit log entries. */
  onHandled?: (request: Request, requestBody: string, response: Response) => void
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
    const route = this.options.routes[url.pathname.replace(/\/$/, "")]
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
    if (request.method !== "GET" && request.method !== "HEAD") {
      const input: unknown = await request.clone().json().catch(() => null)
      if (input && typeof input === "object" && "tenantId" in input) tenantId = input.tenantId
      if (input && typeof input === "object" && "storageAccountName" in input) {
        try { assertStorageAccountName(input.storageAccountName) }
        catch { return Response.json({ error: "Invalid storage account name" }, { status: 400 }) }
        storageAccountName = input.storageAccountName
      }
    }

    const blocked = await this.options.guard?.(request)
    if (blocked) return blocked

    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text()
    let response: Response
    try {
      response = await withRouteTenant(tenantId, () => handler(new NextRequest(request)), storageAccountName)
    } catch (error) {
      console.error(`[api] ${request.method} ${url.pathname} failed:`, error)
      response = Response.json(
        { error: error instanceof Error ? error.message : "Unexpected error" },
        { status: 500 },
      )
    }
    if (this.options.transform) response = await this.options.transform(response)
    this.options.onHandled?.(request, body, response)
    return response
  }

  /** IPC entry point: rebuilds a Request from the renderer and serializes the Response. */
  async handleIpc(input: ApiRequest): Promise<ApiResponse> {
    if (!input.path.startsWith("/api/")) {
      return { status: 400, statusText: "Bad Request", headers: {}, body: new Uint8Array() }
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
