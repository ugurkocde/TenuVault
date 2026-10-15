import { CIS_CONTENT_ENTITLEMENT_REQUIRED_MESSAGE } from "../frameworks/cis-content"

/**
 * Host-boundary refusal for CIS routes. It runs before plan resolution so a disabled
 * CIS feature performs no licensing or tenant work and returns its own 403 instead
 * of an upgrade response. CIS content delivery additionally needs a currently valid
 * cached entitlement for the selected tenant; without one it returns 401 here, before
 * plan resolution can trigger a licensing refresh. Route handlers repeat their checks
 * as defense in depth.
 */
export function cisInternalGuard(
  internalEnabled: () => boolean,
  entitlementToken?: (tenantId: string) => string | null,
) {
  return async (request: Request): Promise<Response | null> => {
    if (request.method !== "POST") return null
    const pathname = new URL(request.url).pathname.replace(/\/$/, "")
    if (pathname === "/api/cis-remediation") {
      return internalEnabled()
        ? null
        : Response.json({ error: "CIS comparisons are coming soon." }, { status: 403 })
    }
    if (pathname !== "/api/frameworks") return null

    let body: unknown
    try {
      body = await request.clone().json()
    } catch {
      return null
    }
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null
    const frameworkId = record?.frameworkId
    if (frameworkId === "cis-controls") {
      return Response.json({ error: "CIS Controls are coming soon." }, { status: 403 })
    }
    if (frameworkId === "cis-benchmarks" && !internalEnabled()) {
      return Response.json({ error: "CIS comparisons are coming soon." }, { status: 403 })
    }
    const action = record?.action
    if (frameworkId === "cis-benchmarks" && (action === "cis-catalog" || action === "cis-fetch-pack")) {
      const tenantId = typeof record?.tenantId === "string" ? record.tenantId : ""
      let token: string | null = null
      try {
        token = tenantId ? (entitlementToken?.(tenantId) ?? null) : null
      } catch {
        token = null
      }
      if (!token) {
        return Response.json({ error: CIS_CONTENT_ENTITLEMENT_REQUIRED_MESSAGE }, { status: 401 })
      }
    }
    return null
  }
}
