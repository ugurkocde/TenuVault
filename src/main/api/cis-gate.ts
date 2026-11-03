import { CIS_CONTENT_ENTITLEMENT_REQUIRED_MESSAGE } from "../frameworks/cis-content"

/**
 * Host-boundary refusal for CIS routes. It runs before plan resolution: CIS Controls is
 * not offered and always answers 403, and CIS content delivery needs a currently valid
 * cached entitlement for the selected tenant, so without one it answers 401 here, before
 * plan resolution can trigger a licensing refresh. CIS Benchmarks itself is a Pro and MSP
 * feature that the plan guard checks next; the delivery service decides which content a
 * license receives. Route handlers repeat their checks as defense in depth.
 */
export function cisGuard(entitlementToken?: (tenantId: string) => string | null) {
  return async (request: Request): Promise<Response | null> => {
    if (request.method !== "POST") return null
    const pathname = new URL(request.url).pathname.replace(/\/$/, "")
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
