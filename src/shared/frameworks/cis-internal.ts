import { frameworks, type Framework } from "./catalog"
import { matchesTerms, searchTerms } from "../search"

/**
 * CIS Benchmarks access. Since certification, CIS Benchmarks is a Pro and MSP feature
 * (baselineAllPlatforms): the renderer shows it by plan and the main process enforces the
 * plan, while the TenuVault delivery service decides which benchmark content a license
 * receives and can stop delivery. CIS Controls stays unavailable.
 *
 * Local Build Kit import is development and certification tooling only. It is bound to
 * the server-issued internal CIS claim of a verified license entitlement, which only
 * allowlisted internal installations receive. Customers load packs from the delivery
 * service and never see it.
 */
export function internalKitImportEnabled(internalCisClaim: boolean): boolean {
  return internalCisClaim
}

export const CIS_BENCHMARKS_ID = "cis-benchmarks"
export const CIS_BENCHMARKS_ROUTE = "/portal/frameworks/cis-benchmarks"

/** The frameworks sub-navigation list: CIS Benchmarks has its own top-level entry and is not listed here. */
export function navigationFrameworks(): Framework[] {
  return frameworks.filter(framework => framework.id !== CIS_BENCHMARKS_ID)
}

/** Whether a pathname is the standalone CIS Benchmarks page. */
export function isCisBenchmarksPath(pathname: string): boolean {
  return pathname === CIS_BENCHMARKS_ROUTE || pathname.startsWith(`${CIS_BENCHMARKS_ROUTE}/`)
}

export function searchEffectiveFrameworks(list: Framework[], query: string): Framework[] {
  const terms = searchTerms(query)
  if (!terms.length) return list
  return list.filter(f => matchesTerms(`${f.name} ${f.publisher} ${f.kind} ${f.description}`.toLowerCase(), terms))
}
