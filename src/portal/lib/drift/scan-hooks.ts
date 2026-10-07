import type { DriftScanProgress } from "../../../shared/intune/drift"

/** Set on the response of a scan the admin cancelled, which is not audited. */
export const CANCELLED_HEADER = "x-tenuvault-scan-cancelled"

/** How a background drift scan follows and stops the /api/detect-drifts request it runs. */
export interface DriftScanHooks {
  tenantId: string
  signal: AbortSignal
  onProgress: (progress: DriftScanProgress) => void
}

/**
 * The background scan (src/main/drift/jobs.ts) runs /api/detect-drifts through the API host, so the
 * request gets the tenant's storage context and is audited like any other. Its progress and its
 * cancel signal cannot travel in the JSON body, so the scan registers them here under its job ID
 * and names that ID in the body as scanId.
 */
const scans = new Map<string, DriftScanHooks>()

export function registerDriftScan(scanId: string, hooks: DriftScanHooks): () => void {
  scans.set(scanId, hooks)
  return () => void scans.delete(scanId)
}

/** The hooks of a registered scan of this tenant, or undefined for a plain request. */
export function driftScanHooks(scanId: unknown, tenantId: unknown): DriftScanHooks | undefined {
  if (typeof scanId !== "string" || typeof tenantId !== "string") return undefined
  const hooks = scans.get(scanId)
  return hooks && hooks.tenantId === tenantId.toLowerCase() ? hooks : undefined
}
