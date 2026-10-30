import { useMemo } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Download } from "lucide-react"
import { BigValue, Chip, Tile, TileLabel } from "~/components/dashboard/tiles"
import { Button } from "~/components/ui/button"
import { Notice, saveText, useSaveNotice } from "../../components/oib/notices"
import { canUse } from "../../components/PlanGate"
import type { FeatureTabProps } from "../types"
import { formatDate, formatScore, loadSummary } from "../scores/api"
import { loadList } from "../hygiene/api"
import { listAdoptions, listCustomizations } from "../standards/api"
import { buildDeviations, summarizeGovernance } from "./model"
import { evidencePackJson, governanceExportName } from "../shared/governance-export"

const linkClass = "font-medium text-gray-900 underline underline-offset-2"

/**
 * Governance overview: are we compliant, where do we deviate on purpose, and what
 * needs attention first. It only reads what the other Governance screens already
 * show (saved comparisons, the latest hygiene scan, stored standards records), so
 * every figure names its source and age. Nothing here writes to the tenant; the
 * calls to action open the owning screen.
 */
export default function OverviewTab({ tenant, plan, allowed }: FeatureTabProps) {
  const tenantId = tenant.credentials?.tenantId
  const scores = useQuery({ queryKey: ["scores-summary", tenantId], queryFn: () => loadSummary(tenant), enabled: allowed })
  const hygiene = useQuery({ queryKey: ["hygiene", tenantId], queryFn: () => loadList(tenant), enabled: !!tenantId })
  const customizations = useQuery({ queryKey: ["customizations", tenantId], queryFn: () => listCustomizations(tenant), enabled: !!tenantId })
  const adoptions = useQuery({ queryKey: ["standards", "adoptions", tenantId], queryFn: () => listAdoptions(tenant), enabled: !!tenantId })
  const notice = useSaveNotice()

  const frameworks = scores.data?.frameworks ?? []
  const findings = hygiene.data?.findings ?? []
  const scans = hygiene.data?.scans ?? []
  const rules = hygiene.data?.rules ?? []
  const customizationRecords = customizations.data?.customizations ?? []
  const adoptionRecords = adoptions.data?.adoptions ?? []
  const deviations = useMemo(() => buildDeviations({ customizations: customizationRecords, findings, adoptions: adoptionRecords }), [customizationRecords, findings, adoptionRecords])
  const summary = useMemo(() => summarizeGovernance({ frameworks, findings, scans, customizations: customizationRecords, adoptions: adoptionRecords }), [frameworks, findings, scans, customizationRecords, adoptionRecords])
  const expired = deviations.filter((entry) => entry.expired)

  if (!allowed) return null
  const ruleName = (id: string) => rules.find((rule) => rule.id === id)?.name ?? id
  const exportPack = () => {
    const exportedAt = new Date().toISOString()
    const name = governanceExportName("evidence-pack", tenant.name, exportedAt)
    void notice.save(() => saveText(evidencePackJson({
      tenant: tenant.name,
      exportedAt,
      frameworks,
      findings,
      ruleName,
      adoptions: adoptionRecords.map((record) => record.state),
      customizations: customizationRecords,
      deviations,
      freshness: { scoresAssessedAt: summary.latestScore?.assessedAt ?? null, hygieneCollectedAt: summary.latestScanAt, standardsAssessedAt: summary.standardsAssessedAt },
    }), `${name}.json`))
  }
  const attention: Array<{ text: string; link: string; label: string }> = []
  if (expired.length) attention.push({ text: `${expired.length} accepted ${expired.length === 1 ? "deviation has" : "deviations have"} expired and ${expired.length === 1 ? "needs" : "need"} re-review.`, link: "/portal/governance/deviations", label: "Open accepted deviations" })
  if (summary.openDefinite) attention.push({ text: `${summary.openDefinite} open definite hygiene ${summary.openDefinite === 1 ? "finding" : "findings"} from ${summary.latestScanAt ? formatDate(summary.latestScanAt) : "the latest scan"}.`, link: "/portal/governance/hygiene", label: "Review findings" })
  if (summary.staleScores) attention.push({ text: `${summary.staleScores} baseline ${summary.staleScores === 1 ? "score is" : "scores are"} stale. Run a new framework comparison to refresh.`, link: "/portal/governance/scores", label: "Open baseline scores" })
  if (summary.pendingUpgrades) attention.push({ text: `${summary.pendingUpgrades} standard ${summary.pendingUpgrades === 1 ? "adoption has" : "adoptions have"} an upgrade available.`, link: "/portal/governance/standards", label: "Open golden standards" })
  if (summary.totalGaps) attention.push({ text: `${summary.totalGaps} counted ${summary.totalGaps === 1 ? "gap" : "gaps"} across saved comparisons.`, link: "/portal/governance/scores", label: "See top gaps" })

  return (
    <div className="space-y-6">
      <section aria-label="Where governance fits" className="rounded-3xl bg-card p-6 text-sm text-gray-600 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <ul className="max-w-3xl space-y-1.5">
            <li><span className="font-medium text-gray-900">Governance</span>: are we compliant, where do we deviate on purpose, who accepted it?</li>
            <li><Link to="/portal/changes" className={linkClass}>Changes</Link>: what will we change, and who reviewed and approved it?</li>
            <li><Link to="/portal/audit" className={linkClass}>Audit Log</Link>: what did TenuVault actually do, when, and did it work?</li>
          </ul>
          <span className="inline-flex flex-col items-start gap-2">
            <Button type="button" size="sm" onClick={exportPack} disabled={notice.saving}>
              <Download className="h-4 w-4" aria-hidden="true" />
              Export evidence pack
            </Button>
            <Notice result={notice.result} onDismiss={notice.clear} />
          </span>
        </div>
      </section>

      {(scores.isLoading || hygiene.isLoading) && <div className="h-40 animate-pulse rounded-3xl bg-card" aria-hidden="true" />}
      {scores.error && <p role="alert" className="rounded-3xl bg-card p-6 text-sm text-red-700">{scores.error instanceof Error ? scores.error.message : "Scores could not be loaded."}</p>}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Tile>
          <TileLabel>Latest baseline score</TileLabel>
          <BigValue className="text-2xl">{summary.latestScore ? formatScore({ score: summary.latestScore.score, coverage: summary.latestScore.coverage }) : "Not scored"}</BigValue>
          <p className="mt-2 text-sm text-gray-600">
            {summary.latestScore ? `${summary.latestScore.frameworkName}, assessed ${formatDate(summary.latestScore.assessedAt)}. ${summary.latestScore.gapCount} gaps.` : "No saved comparison yet. Scores come from saved comparisons, never from a live read."}
          </p>
          {summary.latestScore?.stale && <div className="mt-2"><Chip tone="warning">Stale</Chip></div>}
          <p className="mt-3 text-sm"><Link to="/portal/governance/scores" className={linkClass}>Open baseline scores</Link></p>
        </Tile>
        <Tile>
          <TileLabel>Open hygiene findings</TileLabel>
          <BigValue>{hygiene.data ? summary.openDefinite + summary.openPossible : "Unknown"}</BigValue>
          <p className="mt-2 text-sm text-gray-600">{summary.openDefinite} definite, {summary.openPossible} possible overlaps. Source: {summary.latestScanBackup ? `backup ${summary.latestScanBackup}, collected ${formatDate(summary.latestScanAt)}` : "no scan yet"}.</p>
          <p className="mt-3 text-sm"><Link to="/portal/governance/hygiene" className={linkClass}>Open conflicts and hygiene</Link></p>
        </Tile>
        <Tile>
          <TileLabel>Accepted deviations</TileLabel>
          <BigValue>{deviations.length}</BigValue>
          <p className="mt-2 text-sm text-gray-600">Customizations, reviewed findings and standard exceptions in one register.</p>
          {expired.length > 0 && <div className="mt-2"><Chip tone="danger">{expired.length} expired</Chip></div>}
          <p className="mt-3 text-sm"><Link to="/portal/governance/deviations" className={linkClass}>Open accepted deviations</Link></p>
        </Tile>
        <Tile>
          <TileLabel>Standards</TileLabel>
          <BigValue>{summary.standardDeviations ? `${summary.standardDeviations} deviations` : adoptionRecords.length ? "No deviations" : "None adopted"}</BigValue>
          <p className="mt-2 text-sm text-gray-600">
            {canUse(plan, "goldenStandards") ? `${adoptionRecords.length} adoption(s), ${summary.pendingUpgrades} upgrade(s) pending${summary.standardsAssessedAt ? `, assessed ${formatDate(summary.standardsAssessedAt)}` : ", not assessed yet"}.` : `${summary.activeCustomizations} active customization(s). Golden standards are an MSP feature.`}
          </p>
          <p className="mt-3 text-sm"><Link to={canUse(plan, "goldenStandards") ? "/portal/governance/standards" : "/portal/governance/customizations"} className={linkClass}>{canUse(plan, "goldenStandards") ? "Open golden standards" : "Open customizations"}</Link></p>
        </Tile>
      </div>

      <section aria-label="Needs attention" className="space-y-3 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        <h3 className="text-lg font-medium text-gray-900">Needs attention</h3>
        {attention.length === 0 ? (
          <p className="text-sm text-gray-600">Nothing is waiting from the evidence loaded above. That is only as current as each source named on its tile. Scheduled checks and notifications stay in <Link to="/portal/operations/health-review" className={linkClass}>Operations: Health review</Link>.</p>
        ) : (
          <ul className="space-y-2 text-sm text-gray-700">
            {attention.map((item) => <li key={item.text} className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="min-w-0 flex-1">{item.text}</span><Link to={item.link} className={linkClass}>{item.label}</Link></li>)}
          </ul>
        )}
        <p className="text-sm text-gray-600">Decisions made here (reviews, customizations, approvals) are recorded in the <Link to="/portal/audit?event=GOVERNANCE_FINDING_REVIEWED" className={linkClass}>Audit Log</Link> with the admin who made them.</p>
      </section>
    </div>
  )
}
