import { formatRate, headlineLabel } from "../../shared/frameworks/cis-readiness"
import { cisDriftSignals, cisReadinessTrend } from "../../shared/frameworks/cis-trend"
import type { WorkSignal } from "../features/contracts"
import { internalCisBenchmarksEnabled } from "./service"
import { loadWorkspace } from "./workspaces"

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned || "unknown"
}

/**
 * CIS readiness drift for one tenant, derived from the saved cis-benchmarks
 * workspace. Returns no signals when the internal CIS flag is off or when
 * there is no saved history. Throws when the workspace cannot be read, so
 * the health review marks the signals family as not evaluated instead of
 * reading missing drift as healthy. Drift follows the trend: a run is only
 * compared with the previous run of the same benchmark, version, Level and
 * pack, on the raw headline rate without exclusions.
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
    // The catalog display name of a delivered pack names the benchmark; Build Kit packs keep the id.
    const benchmark = drift.benchmarkName || drift.benchmark
    const drop = drift.previousRate - drift.currentRate
    const level = points.find(point => point.assessedAt === drift.assessedAt && point.benchmark === drift.benchmark && point.version === drift.version)?.levels.find(entry => entry.level === drift.level)
    const label = headlineLabel(level?.basis ?? "settings")
    return {
      key: `cis-readiness:${drift.level}:${slug(drift.benchmark)}:${slug(drift.version)}`,
      tenantId: tenant,
      source: "cis",
      severity: belowBar ? "high" : "medium",
      state: "open",
      title: belowBar
        ? `CIS Level ${drift.level} readiness fell below the benchmark bar (${benchmark} ${drift.version})`
        : `CIS Level ${drift.level} readiness declined (${benchmark} ${drift.version})`,
      reason: `Level ${drift.level} ${label.toLowerCase()} fell from ${formatRate(drift.previousRate)} on ${drift.previousAssessedAt} to ${formatRate(drift.currentRate)} on ${drift.assessedAt}, a drop of ${(drop * 100).toFixed(1)} percentage points for ${benchmark} ${drift.version}. Raw rates, exclusions not applied. Run a new comparison on the CIS Benchmarks page.`,
      observedAt: drift.assessedAt,
      link: "/portal/frameworks/cis-benchmarks",
      evidence: [],
    }
  })
}
