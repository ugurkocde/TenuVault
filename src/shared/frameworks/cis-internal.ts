import { frameworks, type Framework } from "./catalog"

/**
 * Internal gate for CIS Benchmarks assessment before certification. Access comes
 * only from the server-issued CIS claim in a verified license entitlement for an
 * allowlisted internal installation. There is no local switch in any shipped
 * build, so a customer build cannot enable CIS Benchmarks before the award.
 * CIS Controls is never enabled by this gate.
 */

/**
 * Local Build Kit import is development and certification tooling only. It stays
 * bound to the internal claim and is never part of customer enablement: when CIS
 * Benchmarks opens to licensed customers after certification, packs arrive from
 * the delivery service and this returns false for them.
 */
export function internalKitImportEnabled(internalCisBenchmarks: boolean): boolean {
  return internalCisBenchmarks
}

export const CIS_BENCHMARKS_ID = "cis-benchmarks"
export const CIS_BENCHMARKS_ROUTE = "/portal/frameworks/cis-benchmarks"

/** The catalog as shown for a given internal flag state. */
export function effectiveFrameworks(internalCisBenchmarks: boolean): Framework[] {
  if (!internalCisBenchmarks) return frameworks
  return frameworks.map(framework => framework.id === CIS_BENCHMARKS_ID ? { ...framework, disabledReason: undefined } : framework)
}

/** The frameworks sub-navigation list: CIS Benchmarks has its own top-level entry and is not listed here. */
export function navigationFrameworks(internalCisBenchmarks: boolean): Framework[] {
  return effectiveFrameworks(internalCisBenchmarks).filter(framework => framework.id !== CIS_BENCHMARKS_ID)
}

/** Whether a pathname is the standalone CIS Benchmarks page. */
export function isCisBenchmarksPath(pathname: string): boolean {
  return pathname === CIS_BENCHMARKS_ROUTE || pathname.startsWith(`${CIS_BENCHMARKS_ROUTE}/`)
}

export function searchEffectiveFrameworks(list: Framework[], query: string): Framework[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return list
  return list.filter(f => terms.every(term => `${f.name} ${f.publisher} ${f.kind} ${f.description}`.toLowerCase().includes(term)))
}
