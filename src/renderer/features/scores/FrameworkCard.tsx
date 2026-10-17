import { Link } from "react-router-dom"
import { ArrowUpRight, ListTree } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import type { FrameworkScore } from "./api"
import { ageText, formatDate, formatPercent, formatScore, scopeLabel, unitLabel } from "./api"
import { Trend } from "./Trend"

const PRIORITY_TONE = { critical: "danger", high: "warning", medium: "neutral", low: "neutral" } as const

/** One framework's score from its newest saved comparison, with coverage and top gaps. */
export function FrameworkCard({ score, tenantName, onDrillDown, selected }: { score: FrameworkScore; tenantName: string; onDrillDown: () => void; selected: boolean }) {
  const latest = score.latest
  if (!latest) return null
  const { identity, freshness } = latest
  const scored = latest.score.state === "scored"
  const counts = latest.score.counts
  const total = counts.matching + counts.different + counts.missing + counts.unknown + counts.outsideScope
  return (
    <section aria-label={`${identity.frameworkName} score`} className="flex flex-col gap-5 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-medium text-gray-900">{identity.frameworkName}</h3>
          <p className="text-sm text-gray-500">
            Version {identity.frameworkVersion}, {identity.profile}, mapping {identity.rulesetVersion}
            {latest.versionDetail && <span className="block break-all font-mono text-xs">{latest.versionDetail}</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {freshness.stale && <Chip tone="warning" title={`Older than the stale limit`}>Stale</Chip>}
          {latest.incompleteCollection.length > 0 && <Chip tone="warning" title={latest.incompleteCollection.join("; ")}>Partial collection</Chip>}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <p className="text-sm text-gray-500">Technical score</p>
          {scored ? (
            <p className="text-gray-900 tabular-nums" aria-label={`Technical score ${formatScore(latest.score)}`}>
              <span className="text-4xl font-light tracking-tight">{formatPercent(latest.score.score)}</span>{" "}
              <span className="text-lg font-light text-gray-700">{latest.score.coverage === null ? "coverage unknown" : `on ${formatPercent(latest.score.coverage)} coverage`}</span>
            </p>
          ) : (
            <p className="text-4xl font-light tracking-tight text-gray-900">Not scored</p>
          )}
          {!scored && <p className="mt-1 max-w-xs text-sm text-gray-600">{latest.score.reason}</p>}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <div>
            <dt className="text-gray-500">Unknown</dt>
            <dd className="font-medium text-gray-900 tabular-nums">{counts.unknown}</dd>
          </div>
          <div>
            <dt className="text-gray-500" title={latest.unit === "setting" ? "Validated policies with a different or missing setting" : "Counted different plus counted missing"}>{latest.unit === "setting" ? "Policies with gaps" : "Gaps"}</dt>
            <dd className="font-medium text-gray-900 tabular-nums">{latest.gapCount}</dd>
          </div>
        </dl>
      </div>

      <p className="text-xs text-gray-500">
        {total} {unitLabel(latest.unit, total)} counted: {counts.matching} matching, {counts.different} different, {counts.missing} missing, {counts.unknown} unknown, {counts.outsideScope} outside scope.
        {latest.uncheckedReferences > 0 && ` ${latest.uncheckedReferences} of the unknown ${latest.uncheckedReferences === 1 ? "is a framework reference" : "are framework references"} without a configuration check.`} Tenant {tenantName}. Assessed {formatDate(freshness.assessedAt)}
        {ageText(freshness.assessedAt, freshness.ageDays) ? ` (${ageText(freshness.assessedAt, freshness.ageDays)})` : ""}. Scope: {scopeLabel(identity.platforms)}.
      </p>

      <Trend score={score} />
      {score.message && <p className="text-xs text-gray-500">{score.message}</p>}

      {latest.topGaps.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500">Top actionable gaps</p>
          <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-800">
            {latest.topGaps.map((gap) => (
              <li key={gap.key} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 text-gray-800">
                  {gap.capabilityName}
                  <span className="block text-xs text-gray-500">{gap.countedAs} {gap.controls.length} control{gap.controls.length === 1 ? "" : "s"}.</span>
                </span>
                <span className="flex gap-1.5">
                  {gap.mixed && <Chip tone="warning" title="An assigned policy matches part of this capability. Review targeting first.">Mixed evidence</Chip>}
                  <Chip tone={PRIORITY_TONE[gap.ranking.level]} title={gap.ranking.reasons.join(" ")}>{gap.ranking.level}</Chip>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-auto flex flex-wrap gap-2">
        <Button type="button" variant={selected ? "default" : "outline"} size="sm" onClick={onDrillDown} aria-pressed={selected}>
          <ListTree className="h-4 w-4" />
          How this score is counted
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link to={score.frameworkId.startsWith("oib-") ? "/portal/oib/validate" : `/portal/frameworks/${score.frameworkId}`}>
            Open comparison
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </section>
  )
}
