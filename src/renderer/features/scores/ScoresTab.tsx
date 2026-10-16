import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import type { FeatureTabProps } from "../types"
import { groupUnavailable, loadCisWorkspace, loadSummary, namesLabel } from "./api"
import { FrameworkCard } from "./FrameworkCard"
import { PortfolioScores } from "./PortfolioScores"
import { ComplianceScoringNotice } from "../../components/ComplianceScoringNotice"
import { ScoreDetail } from "./ScoreDetail"
import { GovernanceExportButtons } from "../shared/GovernanceExportButtons"
import { scoresCsv, scoresJson } from "../shared/governance-export"
import { useInternalCisBenchmarks } from "../../lib/internal-cis"
import { invalidateScores } from "./invalidate"
import { cisScoreCards } from "./cis"
import { CisCard } from "./CisCard"

/**
 * Baseline scores (#137), projected from the comparisons saved on the Frameworks page. Scores
 * are computed on request and never stored, so without the plan there are no stored records
 * to show and the hub's locked preview stands alone.
 */
export default function ScoresTab({ tenant, plan, allowed }: FeatureTabProps) {
  const client = useQueryClient()
  // One detail panel at a time, opened from a card or from the portfolio.
  const [drill, setDrill] = useState<{ tenant: Tenant; frameworkId: string } | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const tenantId = tenant.credentials?.tenantId
  const query = useQuery({ queryKey: ["scores-summary", tenantId], queryFn: () => loadSummary(tenant), enabled: allowed })
  const cisAccess = useInternalCisBenchmarks()
  // CIS assessments change on the CIS page, which does not notify this tab, so the workspace is
  // read fresh every time the tab opens and cards show only once that read is in.
  const cis = useQuery({ queryKey: ["scores-cis", tenantId], queryFn: () => loadCisWorkspace(tenantId!), enabled: allowed && cisAccess && !!tenantId, staleTime: 0, refetchOnMount: "always" })
  const cisFresh = cis.isFetchedAfterMount ? cis.data : undefined
  const cisCards = useMemo(() => (tenantId ? cisScoreCards(cisAccess, cisFresh, tenantId) : []), [cisAccess, cisFresh, tenantId])
  const drillKey = drill ? `${drill.tenant.credentials?.tenantId}:${drill.frameworkId}` : null
  useEffect(() => {
    if (drillKey) detailRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" })
  }, [drillKey])
  if (!allowed) return null

  const frameworks = query.data?.frameworks ?? []
  const assessed = frameworks.filter((framework) => framework.latest).sort((a, b) => Date.parse(b.latest!.freshness.assessedAt) - Date.parse(a.latest!.freshness.assessedAt))
  const unavailable = frameworks.filter((framework) => framework.state === "unavailable")
  const historyOnly = frameworks.filter((framework) => framework.state === "history-only")
  const notAssessed = frameworks.filter((framework) => framework.state === "not-assessed")
  const refresh = () => invalidateScores(client)
  const toggle = (frameworkId: string) => setDrill((current) => (current && current.frameworkId === frameworkId && current.tenant.credentials?.tenantId === tenantId ? null : { tenant, frameworkId }))

  return (
    <div className="space-y-6">
      <ComplianceScoringNotice key={tenantId} changed={query.data?.scoringChanged === true} />
      <section aria-label="How scores work" className="flex flex-wrap items-start justify-between gap-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        <div className="max-w-3xl space-y-2 text-sm text-gray-600">
          <p>{query.data?.formula ?? "Scores come from saved native framework comparisons."}</p>
          <p>
            The score is shown with its coverage, the share of counted capabilities that could be evaluated. Gaps are the capabilities counted different or missing. OpenIntuneBaseline scores count expected settings instead of capabilities, from full validations only.
          </p>
          <p>
            A score compares Intune and Conditional Access configuration with a technical mapping. It does not prove enforcement on devices or compliance with the full framework. Comparisons older than {query.data?.staleAfterDays ?? 30} days are marked stale.
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <GovernanceExportButtons kind="scores" tenantName={query.data?.tenantName ?? tenant.name} disabled={frameworks.length === 0} buildCsv={() => scoresCsv(frameworks)} buildJson={(exportedAt) => scoresJson(frameworks, query.data?.tenantName ?? tenant.name, exportedAt)} />
          <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={query.isFetching}>
            <RefreshCw className={query.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Refresh
          </Button>
        </div>
      </section>

      {query.isLoading && <div className="h-40 animate-pulse rounded-3xl bg-card" />}
      {query.error && <p className="rounded-3xl bg-card p-6 text-sm text-red-700">{query.error instanceof Error ? query.error.message : "Scores could not be loaded."}</p>}

      {query.data && assessed.length === 0 && unavailable.length === 0 && historyOnly.length === 0 && (
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
            <FrameworkCard key={framework.frameworkId} score={framework} tenantName={query.data?.tenantName ?? tenant.name} selected={!!drill && drill.frameworkId === framework.frameworkId && drill.tenant.credentials?.tenantId === tenantId} onDrillDown={() => toggle(framework.frameworkId)} />
          ))}
        </div>
      )}

      {drill && (
        <div ref={detailRef}>
          <ScoreDetail key={drillKey} tenant={drill.tenant} frameworkId={drill.frameworkId} onClose={() => setDrill(null)} />
        </div>
      )}

      {cisCards.length > 0 && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {cisCards.map((card) => <CisCard key={card.key} card={card} />)}
        </div>
      )}
      {cisAccess && cis.error && <p className="rounded-3xl bg-card p-6 text-sm text-red-700">{cis.error instanceof Error ? cis.error.message : "The saved CIS assessments could not be read."}</p>}

      {historyOnly.length > 0 && (
        <section aria-label="Saved results without a score" className="rounded-3xl bg-card p-6 text-sm text-gray-700">
          <p className="font-medium text-gray-900">Saved results without a score</p>
          <ul className="mt-2 space-y-1.5">
            {historyOnly.map((framework) => (
              <li key={framework.frameworkId}>
                <Link to={framework.frameworkId.startsWith("oib-") ? "/portal/oib/validate" : `/portal/frameworks/${framework.frameworkId}`} className="font-medium text-gray-900 underline underline-offset-2">
                  {framework.frameworkName}
                </Link>
                : {framework.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {unavailable.length > 0 && (
        <section aria-label="Unavailable frameworks" className="rounded-3xl bg-amber-50 p-6 text-sm text-amber-900">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="font-medium">Some saved results could not be read, so they have no score.</p>
              {groupUnavailable(unavailable).map((group) => (
                <p key={group.message}>
                  {namesLabel(group.names)}: {group.message}
                </p>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={query.isFetching}>
              Retry
            </Button>
          </div>
        </section>
      )}

      {assessed.length > 0 && notAssessed.length > 0 && (
        <p className="text-sm text-gray-500">Not assessed yet (no score): {notAssessed.map((framework) => framework.frameworkName).join(", ")}.</p>
      )}

      <PortfolioScores tenant={tenant} plan={plan} onDrill={(target, frameworkId) => setDrill({ tenant: target, frameworkId })} />
    </div>
  )
}
