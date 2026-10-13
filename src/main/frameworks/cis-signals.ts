import { cisDriftSignals, cisReadinessTrend } from "../../shared/frameworks/cis-trend"
import type { WorkSignal } from "../features/contracts"
import { internalCisBenchmarksEnabled } from "./service"
import { loadWorkspace } from "./workspaces"

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned || "unknown"
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

/**
 * CIS readiness drift for one tenant, derived from the saved cis-benchmarks
 * workspace. Returns no signals when the internal CIS flag is off or when
 * there is no saved history. Throws when the workspace cannot be read, so
 * the health review marks the signals family as not evaluated instead of
 * reading missing drift as healthy.
 */
export function cisSignals(tenantId: string): WorkSignal[] {
  if (!internalCisBenchmarksEnabled()) return []
  const tenant = tenantId.toLowerCase()
  const workspace = loadWorkspace(tenant, "cis-benchmarks")
  if (!workspace.history.length) return []
  const points = cisReadinessTrend(workspace.history, workspace.recommendationList, workspace.exceptions)
  const drifts = cisDriftSignals(points)
  return drifts.map((drift): WorkSignal => {
    const belowBar = drift.kind === "below-bar"
    const drop = drift.previousRate - drift.currentRate
    return {
      key: `cis-readiness:${drift.level}:${slug(drift.benchmark)}:${slug(drift.version)}`,
      tenantId: tenant,
      source: "cis",
      severity: belowBar ? "high" : "medium",
      state: "open",
      title: belowBar
        ? `CIS Level ${drift.level} readiness fell below the benchmark bar (${drift.benchmark} ${drift.version})`
        : `CIS Level ${drift.level} readiness declined (${drift.benchmark} ${drift.version})`,
      reason: `Level ${drift.level} pass rate fell from ${percent(drift.previousRate)} on ${drift.previousAssessedAt} to ${percent(drift.currentRate)} on ${drift.assessedAt}, a drop of ${(drop * 100).toFixed(1)} percentage points for ${drift.benchmark} ${drift.version}. Run a new comparison on the CIS Benchmarks page.`,
      observedAt: drift.assessedAt,
      link: "/portal/frameworks/cis-benchmarks",
      evidence: [],
    }
  })
}
