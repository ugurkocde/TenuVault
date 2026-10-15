import type { CisBenchmark } from "../../shared/frameworks/cis-content"

/**
 * The last CIS benchmark catalog loaded for each tenant, so the CIS page lists it
 * again on return without another click. It lives in renderer memory for this app
 * session only and is never written to disk; quitting the app or losing internal
 * CIS access clears it, and the page can always load it again to refresh.
 */
const catalogs = new Map<string, CisBenchmark[]>()

const keyOf = (tenantId: string) => tenantId.toLowerCase()

export function cachedCisCatalog(tenantId: string | undefined): CisBenchmark[] | null {
  return tenantId ? catalogs.get(keyOf(tenantId)) ?? null : null
}

export function rememberCisCatalog(tenantId: string, benchmarks: CisBenchmark[]): void {
  catalogs.set(keyOf(tenantId), benchmarks)
}

export function forgetCisCatalog(tenantId: string): void {
  catalogs.delete(keyOf(tenantId))
}

export function clearCisCatalogs(): void {
  catalogs.clear()
}
