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

/** The catalog as shown for a given internal flag state. */
export function effectiveFrameworks(internalCisBenchmarks: boolean): Framework[] {
  if (!internalCisBenchmarks) return frameworks
  return frameworks.map(framework => framework.id === "cis-benchmarks" ? { ...framework, disabledReason: undefined } : framework)
}

export function searchEffectiveFrameworks(list: Framework[], query: string): Framework[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return list
  return list.filter(f => terms.every(term => `${f.name} ${f.publisher} ${f.kind} ${f.description}`.toLowerCase().includes(term)))
}
