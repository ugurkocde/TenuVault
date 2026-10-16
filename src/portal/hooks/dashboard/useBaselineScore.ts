import { useQuery } from "@tanstack/react-query"
import type { Tenant } from "~/contexts/TenantContext"
import { featureCall } from "@desktop/lib/feature-api"
import type { ScoreSummary } from "@desktop/features/scores/api"
import { allows, type Plan } from "../../../shared/plans"

/**
 * The newest framework score of a tenant for the dashboard tile. Only requested when the
 * tenant's plan includes baseline scores, so Community never computes a paid result; the
 * tile then shows its teaser instead.
 */
export function useBaselineScore(tenant: Tenant | undefined, plan: Plan | null) {
  const tenantId = tenant?.credentials?.tenantId?.toLowerCase()
  const enabled = !!tenantId && plan !== null && allows(plan, "baselineScores")
  const query = useQuery({
    queryKey: ["dashboard-baseline-score", tenantId],
    queryFn: () => featureCall<ScoreSummary>("/api/scores", tenant, "summary"),
    enabled,
    staleTime: 5 * 60_000,
  })
  const latest = (query.data?.frameworks ?? [])
    .filter((framework) => framework.latest)
    .sort((a, b) => Date.parse(b.latest!.freshness.assessedAt) - Date.parse(a.latest!.freshness.assessedAt))[0]
  const assessed = (query.data?.frameworks ?? []).filter((framework) => framework.latest).length
  const unavailable = (query.data?.frameworks ?? []).filter((framework) => framework.state === "unavailable").length
  // Saved results that set no score (older rules, OIB single-policy checks only), so the tile never calls them missing.
  const historyOnly = (query.data?.frameworks ?? []).find((framework) => framework.state === "history-only") ?? null
  return { enabled, isLoading: enabled && query.isLoading, error: query.error, latest: latest ?? null, assessed, unavailable, historyOnly }
}
