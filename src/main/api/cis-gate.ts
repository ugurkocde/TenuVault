/**
 * Host-boundary refusal for CIS routes. It runs before plan resolution so a disabled
 * CIS feature performs no licensing or tenant work and returns its own 403 instead
 * of an upgrade response. Route handlers repeat their checks as defense in depth.
 */
export function cisInternalGuard(internalEnabled: () => boolean) {
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
    const frameworkId = body && typeof body === "object" && "frameworkId" in body ? body.frameworkId : undefined
    if (frameworkId === "cis-controls") {
      return Response.json({ error: "CIS Controls are coming soon." }, { status: 403 })
    }
    if (frameworkId === "cis-benchmarks" && !internalEnabled()) {
      return Response.json({ error: "CIS comparisons are coming soon." }, { status: 403 })
    }
    return null
  }
}
