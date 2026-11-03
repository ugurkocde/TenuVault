import { Link } from "react-router-dom"
import { Check, ExternalLink, FileText, KeyRound, ListChecks } from "lucide-react"
import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"
import { CIS_CERTIFICATION_HEADLINE, CIS_CERTIFICATION_SCOPE_INTRO, CIS_CERTIFIED_LABEL, CIS_CERTIFIED_SEGMENTS, CIS_NOT_CERTIFIED_NOTE, CIS_TENANT_NOT_CERTIFIED_NOTE, cisCheckCount, cisCheckCountText } from "../../../shared/frameworks/cis-certification"
import { featureName } from "../../../shared/plans"
import { Notice, useSaveNotice } from "../../components/oib/notices"
import { PlanBadge } from "../../components/UpgradeNote"
import { bridge } from "../../lib/bridge"
import { isUnlicensed, useLicense } from "../../lib/license"

/**
 * What Pro and MSP add to the CIS Benchmarks page, each as the app does it: delivered packs per
 * Level (cis-content, saved encrypted), readiness and coverage (cis-readiness), manual and Not
 * assessed items with their list text (cis-manual), remediation through the change-set engine
 * (cis-remediation/engine.ts: backup, read-back, rollback, new policies unassigned), the CIS export
 * menu, and the MSP portfolio (cis-portfolio).
 */
export const CIS_PLAN_ADDITIONS: readonly string[] = [
  "Assessment of the tenant against the delivered benchmark pack, per Level. Packs are delivered to licensed tenants and stored encrypted on this device.",
  "Readiness per Level with the pass rate and the coverage of the benchmark.",
  "Manual recommendations and recommendations marked Not covered by the benchmark pack, listed with their CIS text for a manual check.",
  "Remediation per recommendation through a reviewed deployment, with a backup before the change, read-back after it and rollback. New policies are created with no assignments; settings that differ are updated in the policies that hold them, which keep their assignments.",
  "PDF, CSV and JSON exports of findings and readiness.",
  "On MSP, CIS scores across the tenants in your portfolio.",
]

/** Asks main to build the sample report from synthetic data and save it through the Save dialog. */
async function saveSampleReport(): Promise<{ name: string; saved: boolean; path?: string }> {
  const response = await fetch("/api/frameworks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cis-sample-pdf", save: "dialog" }) })
  const result = await response.json() as { name: string; saved: boolean; path?: string; error?: string }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`)
  return result
}

/**
 * The CIS Benchmarks page for a tenant whose plan does not include it: the certified scope with how
 * many recommendations of each certified Level are checked automatically, what Pro and MSP add, and
 * ways to get them, plus a sample report built from synthetic data. It sends no request for CIS
 * content (catalog, pack or list) and shows none: only numbers and the certified benchmark names.
 */
export function CisBenchmarksPreview({ className }: { className?: string }) {
  const { status } = useLicense()
  const sample = useSaveNotice()
  // The trial is offered where the License page offers it: no key on this machine and no organization license.
  const trial = !!status && isUnlicensed(status)
  const feature = "baselineAllPlatforms" as const
  return (
    <section aria-label={`${featureName(feature)} preview`} className={cn("rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-coral-100 text-coral-700" aria-hidden="true">
          <ListChecks className="h-4 w-4" />
        </span>
        <h2 className="text-xl font-medium tracking-tight text-gray-900">{featureName(feature)}</h2>
        <PlanBadge feature={feature} />
      </div>
      <p className="mt-3 max-w-3xl text-sm text-gray-600">
        CIS Benchmarks is included in TenuVault Pro and MSP. Benchmark packs and recommendation lists are delivered only to tenants on those plans, so this page shows what the plans add.
      </p>

      <div aria-label="CIS certification" className="mt-5 rounded-2xl bg-secondary/40 p-5 text-sm text-gray-700">
        <p className="font-medium text-gray-900">{CIS_CERTIFICATION_HEADLINE}</p>
        <p className="mt-1">{CIS_CERTIFICATION_SCOPE_INTRO}</p>
        <ul aria-label="Certified benchmarks" className="mt-3 space-y-3">
          {CIS_CERTIFIED_SEGMENTS.map(segment => (
            <li key={`${segment.benchmark}-${segment.version}`}>
              <p className="font-medium text-gray-900">{segment.name}</p>
              <ul className="mt-1 space-y-1">
                {segment.levels.map(level => {
                  const count = cisCheckCount(segment.benchmark, segment.version, level)
                  return (
                    <li key={level} className="flex flex-wrap items-baseline gap-2">
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-800"><Check className="h-3 w-3" aria-hidden="true" />Level {level}: {CIS_CERTIFIED_LABEL}</span>
                      {count && <span>{cisCheckCountText(count)}</span>}
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-gray-600">{CIS_NOT_CERTIFIED_NOTE} {CIS_TENANT_NOT_CERTIFIED_NOTE}</p>
      </div>

      <h3 className="mt-6 text-base font-medium text-gray-900">What Pro and MSP add</h3>
      <ul aria-label="What Pro and MSP add" className="mt-2 max-w-3xl space-y-1.5 text-sm text-gray-600">
        {CIS_PLAN_ADDITIONS.map(line => (
          <li key={line} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-green-700" aria-hidden="true" /><span>{line}</span></li>
        ))}
      </ul>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => void bridge.license.open("buy", { source: "cis-preview" })}>
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
          {trial ? "Start 30 day free trial" : "See plans"}
        </Button>
        <Button asChild variant="outline">
          <Link to="/license">
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            Add a license key
          </Link>
        </Button>
        <Button type="button" variant="outline" disabled={sample.saving} onClick={() => void sample.save(async () => {
          const outcome = await saveSampleReport()
          return outcome.saved ? { saved: true, fileName: outcome.path?.split(/[\\/]/).pop() ?? outcome.name, ...(outcome.path ? { path: outcome.path } : {}) } : { saved: false, fileName: outcome.name }
        })}>
          <FileText className="h-4 w-4" aria-hidden="true" />
          {sample.saving ? "Preparing sample report" : "View sample report"}
        </Button>
      </div>
      <p className="mt-3 text-sm text-gray-500">The sample report is a PDF with a fictional tenant, fictional results and placeholder recommendations, saved where you choose. No license is needed to open it.</p>
      <Notice result={sample.result} onDismiss={sample.clear} className="mt-3" />
    </section>
  )
}
