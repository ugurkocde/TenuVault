import { frameworks, type Framework } from "./catalog"

/**
 * Internal proof of concept gate for CIS Benchmarks assessment. The flag is
 * off by default in every build. It is enabled only by an explicit local
 * opt-in in the main process, which a shipped customer build does not set.
 * CIS Controls is never enabled by this flag.
 */
export const INTERNAL_CIS_BENCHMARKS_ENV = "TENUVAULT_INTERNAL_CIS_BENCHMARKS"

export function isInternalCisBenchmarksFlagValue(value: string | undefined): boolean {
  return value === "1"
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
