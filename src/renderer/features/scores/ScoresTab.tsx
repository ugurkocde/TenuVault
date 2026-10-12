import { useState } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { Button } from "~/components/ui/button"
import type { FeatureTabProps } from "../types"
import { loadSummary } from "./api"
import { FrameworkCard } from "./FrameworkCard"
import { PortfolioScores } from "./PortfolioScores"
import { ComplianceScoringNotice } from "../../components/ComplianceScoringNotice"
import { ScoreDetail } from "./ScoreDetail"

/**
 * Baseline scores (#137), projected from the comparisons saved on the Frameworks page. Scores
 * are computed on request and never stored, so without the plan there are no stored records
 * to show and the hub's locked preview stands alone.
 */
export default function ScoresTab({ tenant, plan, allowed }: FeatureTabProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const query = useQuery({ queryKey: ["scores-summary", tenant.credentials?.tenantId], queryFn: () => loadSummary(tenant), enabled: allowed })
  if (!allowed) return null

  const frameworks = query.data?.frameworks ?? []
  const assessed = frameworks.filter((framework) => framework.latest).sort((a, b) => Date.parse(b.latest!.freshness.assessedAt) - Date.parse(a.latest!.freshness.assessedAt))
  const unavailable = frameworks.filter((framework) => framework.state === "unavailable")
  const notAssessed = frameworks.filter((framework) => framework.state === "not-assessed")

  return (
    <div className="space-y-6">
      <ComplianceScoringNotice key={tenant.credentials?.tenantId} changed={query.data?.scoringChanged === true} />
      <section aria-label="How scores work" className="flex flex-wrap items-start justify-between gap-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        <div className="max-w-3xl space-y-2 text-sm text-gray-600">
          <p>{query.data?.formula ?? "Scores come from saved native framework comparisons."}</p>
          <p>
            A score compares Intune and Conditional Access configuration with a technical mapping. It does not prove enforcement on devices or compliance with the full framework. Comparisons older than {query.data?.staleAfterDays ?? 30} days are marked stale.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCw className={query.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          Refresh
        </Button>
      </section>

      {query.isLoading && <div className="h-40 animate-pulse rounded-3xl bg-card" />}
      {query.error && <p className="rounded-3xl bg-card p-6 text-sm text-red-700">{query.error instanceof Error ? query.error.message : "Scores could not be loaded."}</p>}

      {query.data && assessed.length === 0 && unavailable.length === 0 && (
        <section className="rounded-3xl bg-card p-6 text-sm text-gray-600">
          No saved framework comparison or OIB validation for this tenant, so there is no score.{" "}
          <Link to="/portal/frameworks" className="font-medium text-gray-900 underline underline-offset-2">
            Compare a framework
          </Link>{" "}
          or{" "}
          <Link to="/portal/oib/validate" className="font-medium text-gray-900 underline underline-offset-2">
            validate OpenIntuneBaseline
          </Link>{" "}
          first; scores appear here from the saved result.
        </section>
      )}

      {assessed.length > 0 && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {assessed.map((framework) => (
            <FrameworkCard key={framework.frameworkId} score={framework} tenantName={query.data?.tenantName ?? tenant.name} selected={selected === framework.frameworkId} onDrillDown={() => setSelected((current) => (current === framework.frameworkId ? null : framework.frameworkId))} />
          ))}
        </div>
      )}

      {selected && <ScoreDetail key={selected} tenant={tenant} frameworkId={selected} onClose={() => setSelected(null)} />}

      {unavailable.length > 0 && (
        <section aria-label="Unavailable frameworks" className="rounded-3xl bg-amber-50 p-6 text-sm text-amber-900">
          <p className="font-medium">Some saved comparisons could not be read, so they have no score:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {unavailable.map((framework) => (
              <li key={framework.frameworkId}>
                {framework.frameworkName}: {framework.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {assessed.length > 0 && notAssessed.length > 0 && (
        <p className="text-sm text-gray-500">Not assessed yet (no score): {notAssessed.map((framework) => framework.frameworkName).join(", ")}.</p>
      )}

      <PortfolioScores tenant={tenant} plan={plan} />
    </div>
  )
}
