import type { Feature } from "../../shared/plans"
import type { FeatureRoutePath } from "../../shared/feature-routes"

/** An API error with the plan feature that would allow the request, when that is the reason. */
export class FeatureApiError extends Error {
  constructor(message: string, readonly status: number, readonly upgrade?: Feature) {
    super(message)
    this.name = "FeatureApiError"
  }
}

/**
 * Calls a roadmap workflow route for the selected tenant: `POST path { tenantId, action, ...body }`.
 * Throws FeatureApiError with the route's message on any non-2xx answer.
 */
export async function featureCall<T>(path: FeatureRoutePath, tenant: { credentials?: { tenantId: string } } | undefined, action: string, body: Record<string, unknown> = {}): Promise<T> {
  const tenantId = tenant?.credentials?.tenantId
  if (!tenantId) throw new FeatureApiError("Select a tenant first.", 400)
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, tenantId, action }),
  })
  const data = (await response.json().catch(() => ({}))) as { error?: string; upgrade?: Feature }
  if (!response.ok) throw new FeatureApiError(data.error ?? `Request failed (${response.status})`, response.status, data.upgrade)
  return data as T
}
