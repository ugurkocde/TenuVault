import { packCoverage, UNSUPPORTED } from "../../shared/frameworks/coverage"
import type { FrameworkWorkspace } from "../../main/frameworks/workspaces"
import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { ArrowRight, Check, ChevronDown, Download, ExternalLink, Info, Search } from "lucide-react"
import { useSelectedTenant, useTenants } from "~/contexts/TenantContext"
import { cn } from "~/lib/utils"
import { NCSC_COMMIT, NCSC_REPOSITORY, type Framework } from "../../shared/frameworks/catalog"
import { CIS_BENCHMARKS_ID, effectiveFrameworks, internalKitImportEnabled, searchEffectiveFrameworks } from "../../shared/frameworks/cis-internal"
import { convertKit, readKitZip, suggestedKitBenchmark, type KitConversion, type KitFile, type KitLevel } from "../../shared/frameworks/cis-kit"
import { parseDenominatorList, type DenominatorEntry } from "../../shared/frameworks/cis-coverage"
import { cisReadiness } from "../../shared/frameworks/cis-readiness"
import { exceptionKey } from "../../shared/frameworks/cis-exceptions"
import { benchmarkDisplayName, groupFindingsByPolicy, groupObservationsByValue, humanSettingLabel, policyDisplayName, statusMixText, trendSummaryText } from "../../shared/frameworks/cis-display"
import { cisFlowSteps, cisStage, isKitPackReference, kitLevelForPolicy, packSettingCount } from "../../shared/frameworks/cis-flow"
import { cisDriftSignals, cisReadinessTrend, sparklineSegments, type CisTrendPoint } from "../../shared/frameworks/cis-trend"
import { cisPortfolioRows, type CisPortfolioEntry } from "../../shared/frameworks/cis-portfolio"
import { parseRecommendationList, type RecommendationList } from "../../shared/frameworks/cis-manual"
import { cisReadinessCsv, cisReadinessJson, governanceExportName } from "../features/shared/governance-export"
import { accumulateCisFindings, cisRunReceivedLabel, cisRunSteps, cisRunTallies, emptyCisRunAccumulation, resolveCisRunCompletion, type CisRunPack } from "../../shared/frameworks/cis-run"
import { refreshInternalCisBenchmarks, useInternalCisBenchmarks } from "../lib/internal-cis"
import { parsePolicies, remediationPayload, rootMatches, type Assessment, type BaselinePolicy, type Finding, type Observation } from "../../shared/frameworks/policies"
import { summarizeSetting } from "../../shared/frameworks/setting-summary"
import { CIS_FRAMEWORKS, type Plan } from "../../shared/plans"
import type { AssessJobSnapshot, ExportFile } from "../../main/frameworks/service"
import type { NcscPack } from "../../main/frameworks/ncsc"
import { tenantLicense, tenantPlan, useLicense, useTenantPlan } from "../lib/license"
import { CisRemediationPanel } from "../features/cis-remediation/CisRemediationPanel"
import { GatedButton } from "../components/PlanGate"
import { useConfirm } from "~/components/ConfirmDialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import type { CisBenchmark, CisCatalog } from "../../shared/frameworks/cis-content"

const button = "inline-flex h-10 items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-5 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
const primary = cn(button, "border-transparent bg-primary text-primary-foreground hover:bg-primary/90")
const NativeFrameworkPage = lazy(() => import('./NativeFrameworkPage'))

async function request<T>(body: unknown): Promise<T> {
  const response = await fetch("/api/frameworks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const result = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`)
  return result
}

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url; link.download = filename; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function exportJson(value: unknown, filename: string) {
  save(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }), filename)
}
function formatLocaleDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { dateStyle: "medium" })
}
function formatExpiryDate(value: string): string {
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { dateStyle: "medium" })
}
function formatTrendPercent(rate: number | null): string {
  return rate === null ? "Not available" : `${(rate * 100).toFixed(1)}%`
}
function formatTrendChange(change: number | null, isFirst: boolean): string {
  if (isFirst) return "first"
  if (change === null) return "Not available"
  const points = change * 100
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pp`
}
function TrendSparkline({ points, level }: { points: CisTrendPoint[]; level: KitLevel }) {
  const width = 120
  const height = 28
  const pad = 3
  const segments = sparklineSegments(points, level)
  const valid = segments.flat()
  if (!valid.length) return <span className="text-xs text-gray-500">Not available</span>
  const maxIndex = Math.max(points.length - 1, 1)
  const coordFor = (index: number) => {
    const value = points[index]!.levels.find(entry => entry.level === level)!.passRate!
    const x = pad + (index / maxIndex) * (width - pad * 2)
    const y = pad + (1 - value) * (height - pad * 2)
    return { x, y }
  }
  return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Pass rate trend sparkline" className="inline-block align-middle">
    {segments.filter(segment => segment.length > 1).map((segment, segmentIndex) => <polyline key={segmentIndex} fill="none" stroke="currentColor" strokeWidth="1.5" points={segment.map(index => { const coord = coordFor(index); return `${coord.x},${coord.y}` }).join(" ")} />)}
    {valid.map(index => { const coord = coordFor(index); return <circle key={index} cx={coord.x} cy={coord.y} r="2" fill="currentColor" /> })}
  </svg>
}
/** An export button: ordinary for every framework, gated for licensed CIS content. */
function ExportButton({ framework, plan, disabled, onClick, children }: { framework: Framework; plan: Plan | null; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return CIS_FRAMEWORKS.has(framework.id)
    ? <GatedButton feature="baselineAllPlatforms" plan={plan} variant="outline" disabled={disabled} onClick={onClick}>{children}</GatedButton>
    : <button type="button" className={button} disabled={disabled} onClick={onClick}>{children}</button>
}

/** Saves a framework export built by the main process from a saved assessment. */
function saveExport(file: ExportFile) {
  const data = file.encoding === "base64" ? Uint8Array.from(atob(file.data), c => c.charCodeAt(0)) : file.data
  save(new Blob([data], { type: file.type }), file.name)
}

export default function FrameworksPage() {
  const internalCis = useInternalCisBenchmarks()
  const catalog = effectiveFrameworks(internalCis)
  const { frameworkId } = useParams()
  const { selectedTenant, setSelectedTenantId } = useSelectedTenant()
  const tenants = useTenants()
  // Links from comparison notifications name the tenant the comparison ran for.
  const [params, setParams] = useSearchParams()
  const requestedTenant = params.get("tenant")?.toLowerCase()
  useEffect(() => {
    if (!requestedTenant || !tenants.length) return
    const match = tenants.find(t => t.credentials?.tenantId.toLowerCase() === requestedTenant)
    if (match && match.id !== selectedTenant?.id) setSelectedTenantId(match.id)
    setParams({}, { replace: true })
  }, [requestedTenant, tenants])
  const [query, setQuery] = useState("")
  const framework = catalog.find(f => f.id === frameworkId)
  if (frameworkId && !framework) return <div className="p-8"><h1 className="text-2xl font-semibold">Framework not found</h1><Link className="mt-4 inline-block text-blue-700" to="/portal/frameworks">Browse frameworks</Link></div>
  if (framework?.disabledReason) return <div className="mx-auto max-w-6xl p-6 lg:p-8">
    <Link to="/portal/frameworks" className="text-sm text-blue-700 hover:underline">Frameworks</Link>
    <h1 className="mt-4 text-3xl font-semibold tracking-tight text-gray-950">{framework.name}</h1>
    <p role="status" className="mt-5 rounded-3xl bg-secondary px-6 py-5 text-sm text-foreground"><strong className="block">Coming soon</strong>{framework.disabledReason}</p>
  </div>
  if (framework?.nativeId) return <Suspense fallback={<p role="status" className="p-8">Loading framework…</p>}><NativeFrameworkPage key={`${framework.id}:${selectedTenant?.credentials?.tenantId ?? "none"}`} framework={framework} /></Suspense>
  if (framework) return <FrameworkDetail key={`${framework.id}:${selectedTenant?.credentials?.tenantId ?? "none"}`} framework={framework} standalone={framework.id === CIS_BENCHMARKS_ID} kitImport={internalKitImportEnabled(internalCis)} />
  const matches = searchEffectiveFrameworks(catalog, query)
  return <div className="mx-auto max-w-6xl p-6 lg:p-8">
    <div className="mb-8">
      <p className="mb-3 text-xs font-medium text-gray-500">Baselines & gap analysis</p>
      <h1 className="text-4xl font-medium tracking-tight text-gray-900">Frameworks</h1>
      <p className="mt-3 max-w-2xl text-lg text-gray-500">Compare selected Intune settings with versioned framework mappings. Inspect configuration evidence and export independent comparison reports.</p>
    </div>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-gray-500">{catalog.length} frameworks · One assessment workspace</p>
      <div className="relative w-full sm:w-80"><Search className="absolute left-4 top-3 h-4 w-4 text-gray-400" aria-hidden="true" /><input aria-label="Search framework catalog" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, publisher, or type…" className="h-10 w-full rounded-full border border-gray-200 bg-white pl-10 pr-4 text-sm" /></div>
    </div>
    {([
      ["Framework comparisons", "Read-only comparisons with independent mappings, included in Community with PDF, CSV and JSON reports.", matches.filter(f => f.nativeId && !f.disabledReason)],
      ["Baselines and policy packs", "Compare a policy pack with your tenant and, where the pack allows it, create missing settings as unassigned policies.", matches.filter(f => !f.nativeId && !f.disabledReason)],
      ["Coming soon", "", matches.filter(f => f.disabledReason)],
    ] as const).map(([title, hint, items]) => items.length > 0 && <section key={title} className="mb-8" aria-labelledby={`catalog-${title}`}>
      <h2 id={`catalog-${title}`} className="text-lg font-medium tracking-tight text-gray-900">{title}</h2>
      {hint && <p className="mt-1 text-sm text-gray-500">{hint}</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{items.map(f => <FrameworkCatalogItem key={f.id} framework={f} />)}</div>
    </section>)}
    {!matches.length && <p role="status" className="rounded-3xl bg-white p-8 text-center text-gray-500">No frameworks match “{query}”.</p>}
    <p className="mt-5 text-sm text-gray-500">Coverage is shown per framework. A configuration match is evidence for review; assignments, device enforcement and organizational controls require separate assessment. OpenIntuneBaseline has its own section in the sidebar: <Link to="/portal/oib" className="text-blue-700 hover:underline">OpenIntuneBaseline</Link>.</p>
  </div>
}

/** Publisher initials stand in for logos: publisher marks are not bundled and imply no endorsement. */
const PUBLISHER_MONOGRAMS: Record<string, string> = {
  "SkipToTheEndpoint": "OIB", "Microsoft": "MS", "Center for Internet Security": "CIS", "NIST": "NIST", "DISA": "DISA",
  "Australian Signals Directorate": "ASD", "BSI": "BSI", "International Organization for Standardization / IEC": "ISO",
  "AICPA": "AICPA", "UK Ministry of Defence": "MOD", "NCSC": "NCSC", "UK National Cyber Security Centre": "NCSC", "Your organization": "You",
}

function FrameworkCatalogItem({ framework: f }: { framework: Framework }) {
  const monogram = PUBLISHER_MONOGRAMS[f.publisher] ?? f.publisher.slice(0, 3).toUpperCase()
  const content = <>
    <div className="flex items-start justify-between gap-3">
      <span className={cn("flex h-11 min-w-11 items-center justify-center rounded-2xl px-2.5 text-xs font-semibold tracking-wide", f.disabledReason ? "bg-secondary text-muted-foreground" : "bg-blue-50 text-blue-700")} aria-hidden="true">{monogram}</span>
      {f.disabledReason
        ? <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground">Coming soon</span>
        : <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground" aria-hidden="true"><ArrowRight className="h-4 w-4" /></span>}
    </div>
    <h3 className="mt-4 text-base font-medium text-gray-900">{f.name}</h3>
    <p className="mt-0.5 text-xs text-gray-500">{f.publisher}</p>
    <p className="mt-3 flex-1 text-sm text-gray-600">{f.description}</p>
    <p className="mt-4 text-xs text-gray-500">{f.disabledReason ? f.kind : f.nativeId ? "Community · PDF, CSV and JSON reports" : f.id === "ncsc-dsg" ? "Windows pack included · PDF, CSV and JSON reports" : "Bring your reviewed policy mappings"}</p>
  </>
  const shell = "flex h-full flex-col rounded-3xl bg-white p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]"
  return f.disabledReason
    ? <div aria-disabled="true" title={f.disabledReason} className={cn(shell, "cursor-not-allowed opacity-70")}>{content}</div>
    : <Link to={`/portal/frameworks/${f.id}`} className={cn(shell, "group border border-transparent transition-[border-color,box-shadow] hover:border-gray-200 hover:shadow-[0_6px_20px_-8px_rgba(22,21,20,0.25)]")}>{content}</Link>
}

function CisPortfolio({ plan }: { plan: Plan | null }) {
  const tenants = useTenants()
  const { status } = useLicense()
  const [rows, setRows] = useState<ReturnType<typeof cisPortfolioRows> | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState("")
  const generation = useRef(0)
  const seenTenantIds = new Set<string>()
  const signedIn = tenants.filter(candidate => {
    const tenantId = candidate.credentials?.tenantId
    if (!tenantId) return false
    const key = tenantId.toLowerCase()
    if (seenTenantIds.has(key)) return false
    seenTenantIds.add(key)
    return true
  })
  const notSignedIn = tenants.filter(candidate => !candidate.credentials?.tenantId)
  const licensed = (candidate: (typeof signedIn)[number]) => tenantPlan(tenantLicense(status, candidate.credentials?.tenantId)) === "msp"
  const included = signedIn.filter(licensed)
  const notIncluded = signedIn.filter(candidate => !licensed(candidate))
  const tenantSignature = tenants.map(candidate => `${candidate.credentials?.tenantId?.toLowerCase() ?? ""}:${candidate.name}`).join("|")
  useEffect(() => {
    generation.current += 1
    setRows(null)
    setLoadError("")
    setBusy(false)
  }, [tenantSignature])
  async function load() {
    const current = ++generation.current
    setBusy(true)
    setLoadError("")
    try {
      const entries: CisPortfolioEntry[] = []
      for (const candidate of included) {
        const tenantId = candidate.credentials!.tenantId!
        try {
          const workspace = await request<FrameworkWorkspace>({ action: "workspace-load", tenantId, frameworkId: CIS_BENCHMARKS_ID })
          entries.push({ tenantId, tenantName: candidate.name, workspace })
        } catch (e) {
          entries.push({ tenantId, tenantName: candidate.name, error: e instanceof Error ? e.message : "The saved workspace could not be loaded." })
        }
      }
      if (generation.current !== current) return
      setRows(cisPortfolioRows(entries))
    } catch (e) {
      if (generation.current !== current) return
      setLoadError(e instanceof Error ? e.message : "The portfolio could not be loaded.")
    } finally {
      if (generation.current === current) setBusy(false)
    }
  }
  return <section aria-label="CIS portfolio" className="mb-5 rounded-3xl bg-white p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-medium text-gray-900">Portfolio</h2>
        <p className="mt-1 text-sm text-gray-500">Customer tenants ranked by CIS readiness from each tenant latest saved assessment. Tenants with no saved assessment are shown as not assessed.</p>
      </div>
      <GatedButton feature="portfolio" plan={plan} variant="outline" size="sm" disabled={busy || !included.length} onClick={() => void load()}>{busy ? "Loading" : rows ? "Refresh portfolio" : "Load portfolio"}</GatedButton>
    </div>
    {notIncluded.length > 0 && <p className="mt-3 text-xs text-gray-500">Not included (no MSP license): {notIncluded.map(candidate => candidate.name).join(", ")}. These tenants are not loaded.</p>}
    {notSignedIn.length > 0 && <p className="mt-3 text-xs text-gray-500">Not signed in: {notSignedIn.map(candidate => candidate.name).join(", ")}. These tenants are not loaded.</p>}
    {!signedIn.length && <p className="mt-3 text-sm text-gray-500">No connected tenant is signed in.</p>}
    {loadError && <p role="alert" className="mt-3 text-sm text-red-700">{loadError}</p>}
    {rows && <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm">
      <thead className="text-xs text-gray-500"><tr><th scope="col" className="py-2 pr-4 font-medium">Tenant</th><th scope="col" className="py-2 pr-4 font-medium">Benchmark</th><th scope="col" className="py-2 pr-4 font-medium">Assessed</th><th scope="col" className="py-2 pr-4 font-medium">Level 1</th><th scope="col" className="py-2 pr-4 font-medium">Level 2</th><th scope="col" className="py-2 pr-4 font-medium">Assessed settings (Level 1 / Level 2)</th><th scope="col" className="py-2 font-medium">Excluded</th></tr></thead>
      <tbody className="divide-y divide-gray-100">{rows.map(row => {
        const level1 = row.levels.find(level => level.level === 1)
        const level2 = row.levels.find(level => level.level === 2)
        const rate = (level: typeof level1) => level ? formatTrendPercent(level.adjustedPassRate ?? level.passRate) : "Not available"
        const excepted = row.levels.reduce((sum, level) => sum + level.excepted, 0)
        return <tr key={row.tenantId}>
          <td className="py-2 pr-4 text-gray-800">{row.tenantName ?? row.tenantId}</td>
          {row.error ? <td colSpan={6} className="py-2 text-gray-500">{row.error}</td> : row.assessedAt === null ? <td colSpan={6} className="py-2 text-gray-500">Not assessed</td> : <>
            <td className="py-2 pr-4 text-gray-700">{row.benchmark}{row.version ? <span className="block text-xs text-gray-500">{row.version}</span> : null}</td>
            <td className="py-2 pr-4 text-gray-700">{new Date(row.assessedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}</td>
            <td className="py-2 pr-4 tabular-nums text-gray-900">{rate(level1)}</td>
            <td className="py-2 pr-4 tabular-nums text-gray-900">{rate(level2)}</td>
            <td className="py-2 pr-4 tabular-nums text-gray-700">{level1?.assessedSettings ?? 0} / {level2?.assessedSettings ?? 0}</td>
            <td className="py-2 tabular-nums text-gray-700">{excepted}</td>
          </>}
        </tr>
      })}</tbody>
    </table></div>}
  </section>
}

function CisRunView({ run }: { run: AssessJobSnapshot }) {
  const steps = cisRunSteps(run.phase)
  const tallies = cisRunTallies(run.findings)
  const running = run.phase !== "done" && run.phase !== "failed"
  return <div className="mt-5 rounded-3xl bg-gray-50 p-6">
    <div role="status">
      <h3 className="text-lg font-medium text-gray-900">Assessment in progress</h3>
    </div>
    <ol className="mt-4 space-y-3">
      {steps.map((step, index) => <li key={step.label} {...(step.state === "current" ? { "aria-current": "step" as const } : {})} className="flex items-start gap-3 text-sm">
        <span aria-hidden="true" className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", step.state === "done" ? "bg-green-100 text-green-800" : step.state === "current" ? "bg-primary text-primary-foreground" : "bg-gray-200 text-gray-500")}>{step.state === "done" ? <Check className="h-3.5 w-3.5" /> : index + 1}</span>
        <span className="min-w-0 flex-1">
          <span className={cn("font-medium", step.state === "waiting" ? "text-gray-500" : "text-gray-900")}>{step.label}</span>
          <span className="ml-2 text-xs text-gray-500">{step.state === "done" ? "Done" : step.state === "current" ? "In progress" : "Waiting"}</span>
          {index === 1 && step.state !== "waiting" && <>
            <span className="mt-1 block text-xs text-gray-600">{run.read} of {run.total} policies read{run.currentPolicy ? `, current: ${run.currentPolicy}` : ""}</span>
            <span role="progressbar" aria-label="Reading tenant policies" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.read} aria-valuetext={`${run.read} of ${run.total} policies read`} className="mt-2 block h-2 overflow-hidden rounded-full bg-gray-200"><span className="block h-full rounded-full bg-primary transition-all" style={{ width: run.total ? `${(run.read / run.total) * 100}%` : "0%" }} /></span>
          </>}
          {index === 2 && step.state !== "waiting" && <>
            <span className="mt-1 block text-xs text-gray-600">{run.comparedPolicies} of {run.packPolicies} pack policies compared{run.currentPackPolicy ? `, current: ${run.currentPackPolicy}` : ""}</span>
            <span role="progressbar" aria-label="Comparing with the benchmark" aria-valuemin={0} aria-valuemax={run.packPolicies} aria-valuenow={run.comparedPolicies} aria-valuetext={`${run.comparedPolicies} of ${run.packPolicies} pack policies compared`} className="mt-2 block h-2 overflow-hidden rounded-full bg-gray-200"><span className="block h-full rounded-full bg-primary transition-all" style={{ width: run.packPolicies ? `${(run.comparedPolicies / run.packPolicies) * 100}%` : "0%" }} /></span>
          </>}
        </span>
      </li>)}
    </ol>
    <div className="mt-5 flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-gray-500">Partial tallies:</span>
      {(["Present", "Different", "Missing", "Review"] as const).map(status => <span key={status} className="rounded-full bg-white px-3 py-1 text-xs font-medium text-gray-700">{status} {tallies[status]}</span>)}
    </div>
    {running && <p className="mt-3 text-xs text-gray-500">{cisRunReceivedLabel(run.findings.length)}</p>}
    {run.findings.length > 0 && <div className="mt-3 space-y-2">{run.findings.map(finding => <FindingRow key={finding.key} finding={finding} disabled checked={false} onChange={() => undefined} remediable />)}</div>}
  </div>
}

function CisExportMenu({ plan, disabled, readinessDisabled, onPdf, onFindingsCsv, onFindingsJson, onReadinessCsv, onReadinessJson }: {
  plan: Plan | null
  disabled: boolean
  readinessDisabled: boolean
  onPdf: () => void
  onFindingsCsv: () => void
  onFindingsJson: () => void
  onReadinessCsv: () => void
  onReadinessJson: () => void
}) {
  const close = (event: React.SyntheticEvent) => { event.currentTarget.closest("details")?.removeAttribute("open") }
  const itemClass = "flex w-full items-center justify-start gap-2 rounded-xl px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
  return <details className="relative">
    <summary className={cn(button, "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>Export <ChevronDown className="h-4 w-4" aria-hidden="true" /></summary>
    <div className="absolute right-0 z-10 mt-2 w-56 rounded-2xl border border-gray-200 bg-white p-2 shadow-lg">
      <GatedButton feature="baselineAllPlatforms" plan={plan} variant="ghost" size="sm" disabled={disabled} className="w-full justify-start" onClick={event => { close(event); onPdf() }}>PDF report</GatedButton>
      <GatedButton feature="baselineAllPlatforms" plan={plan} variant="ghost" size="sm" disabled={disabled} className="w-full justify-start" onClick={event => { close(event); onFindingsCsv() }}>Findings CSV</GatedButton>
      <GatedButton feature="baselineAllPlatforms" plan={plan} variant="ghost" size="sm" disabled={disabled} className="w-full justify-start" onClick={event => { close(event); onFindingsJson() }}>Findings JSON</GatedButton>
      <button type="button" className={itemClass} disabled={disabled || readinessDisabled} onClick={event => { close(event); onReadinessCsv() }}>Readiness CSV</button>
      <button type="button" className={itemClass} disabled={disabled || readinessDisabled} onClick={event => { close(event); onReadinessJson() }}>Readiness JSON</button>
    </div>
  </details>
}

function FrameworkDetail({ framework, standalone = false, kitImport = false }: { framework: Framework; standalone?: boolean; kitImport?: boolean }) {
  const { selectedTenant } = useSelectedTenant()
  const [policies, setPolicies] = useState<BaselinePolicy[]>([])
  const [reference, setReference] = useState("")
  const [assessment, setAssessment] = useState<Assessment | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [filter, setFilter] = useState("All")
  const [page, setPage] = useState(0)
  const [preview, setPreview] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [creation, setCreation] = useState<{ success: boolean; results: { name: string; id?: string; error?: string }[] } | null>(null)
  const [workspace, setWorkspace] = useState<FrameworkWorkspace | null>(null)
  const [historical, setHistorical] = useState(false)
  const [kitBenchmark, setKitBenchmark] = useState("")
  const [kitVersion, setKitVersion] = useState("")
  const [kitDetected, setKitDetected] = useState<{ id: string; version?: string }>({ id: "" })
  const [kitFiles, setKitFiles] = useState<KitFile[]>([])
  const [kitConversion, setKitConversion] = useState<KitConversion | null>(null)
  const [loadedKitLevel, setLoadedKitLevel] = useState<KitLevel | null>(null)
  const [denominator, setDenominator] = useState<DenominatorEntry[] | undefined>(undefined)
  const [recommendationList, setRecommendationList] = useState<RecommendationList | undefined>(undefined)
  const [exclusion, setExclusion] = useState<{ owner: string; reason: string; expiresOn: string; count: number; error: string } | null>(null)
  const excludeButton = useRef<HTMLButtonElement>(null)
  const [cisExceptionsOpen, setCisExceptionsOpen] = useState(false)
  const [cisRun, setCisRun] = useState<AssessJobSnapshot | null>(null)
  const [cisCatalog, setCisCatalog] = useState<CisBenchmark[] | null>(null)
  const [cisCatalogMessage, setCisCatalogMessage] = useState("")
  const [setupRequested, setSetupRequested] = useState(false)
  const cisRunGeneration = useRef(0)
  const isCis = framework.id === CIS_BENCHMARKS_ID
  const stage = isCis ? cisStage({ hasRun: !!cisRun, hasAssessment: !!assessment, setupRequested }) : null
  const fromKit = isCis && isKitPackReference(reference, (kitConversion?.packs ?? []).map(pack => pack.reference), policies)
  const credentials = selectedTenant?.credentials
  // Reports of licensed CIS content are Pro and MSP; the main process checks the same plan.
  const plan = useTenantPlan(credentials?.tenantId)
  const { confirm, confirmDialog } = useConfirm()
  const exportSaved = (format: "pdf" | "csv" | "json", runId?: string) => void perform(`Exporting ${format.toUpperCase()}…`, async () => {
    const { file } = await request<{ file: ExportFile }>({ action: `workspace-${format}`, tenantId: credentials?.tenantId, tenantName: selectedTenant?.name, frameworkId: framework.id, ...(runId ? { runId } : {}) })
    saveExport(file)
  })
  const workspaceQueue = useRef<Promise<unknown>>(Promise.resolve())
  const suppressedDraft = useRef<string | null>(null)
  const workspaceRequest = (action: string, extra: object = {}) => {
    const task = workspaceQueue.current.catch(() => undefined).then(() => request<FrameworkWorkspace>({ action, tenantId: credentials?.tenantId, frameworkId: framework.id, ...extra }))
    workspaceQueue.current = task
    return task
  }
  useEffect(() => {
    if (!credentials?.tenantId) return
    let active = true
    void workspaceRequest("workspace-load").then(saved => {
      if (!active) return
      setWorkspace(saved); setPolicies(saved.policies); setReference(saved.reference); setRecommendationList(saved.recommendationList)
    }).catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [credentials?.tenantId, framework.id])
  useEffect(() => {
    if (!workspace || historical || JSON.stringify({ policies, reference }) === suppressedDraft.current) return
    suppressedDraft.current = null
    let active = true
    void workspaceRequest("workspace-save", { policies, reference }).then(saved => { if (active) setWorkspace(saved) }).catch(e => { if (active) setError(`Workspace was not saved: ${String(e)}`) })
    return () => { active = false }
  }, [policies, reference, !!workspace, historical])
  const chosen = assessment?.findings.filter(f => selected.has(f.key)) ?? []
  const payloads = [...new Set(chosen.map(f => f.policyIndex))].map(index => remediationPayload(policies[index]!, chosen.filter(f => f.policyIndex === index).map(f => policies[index]!.settings[f.settingIndex]!), reference))
  function reset() { setHistorical(false); setAssessment(null); setSelected(new Set()); setPreview(false); setConfirmed(false); setCreation(null); setPage(0) }
  async function perform(label: string, action: () => Promise<void>) {
    setBusy(label); setError("")
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : "The request failed.") } finally { setBusy("") }
  }
  useEffect(() => () => { cisRunGeneration.current += 1 }, [])
  async function startCisAssessment() {
    if (!isCis || cisRun || !credentials) return
    const generation = ++cisRunGeneration.current
    const tenantId = credentials.tenantId
    const appId = credentials.appId
    const capturedPack: CisRunPack = { policies, reference }
    setError("")
    setBusy("Reading tenant policies and comparing settings…")
    setCisRun({ jobId: "", phase: "connecting", status: "running", state: "running", tenantId, frameworkId: framework.id, read: 0, total: 0, currentPolicy: "", comparedPolicies: 0, packPolicies: capturedPack.policies.length, currentPackPolicy: "", findings: [], nextSince: 0, error: null, assessment: null })
    try {
      const { jobId } = await request<{ jobId: string }>({ action: "assess-start", tenantId, appId, frameworkId: framework.id, reference: capturedPack.reference, policies: capturedPack.policies })
      if (cisRunGeneration.current !== generation) return
      let accumulation = emptyCisRunAccumulation()
      for (;;) {
        if (cisRunGeneration.current !== generation) return
        const snapshot = await request<AssessJobSnapshot>({ action: "assess-status", jobId, tenantId, frameworkId: framework.id, since: accumulation.since })
        if (cisRunGeneration.current !== generation) return
        accumulation = accumulateCisFindings(accumulation, snapshot.findings, snapshot.nextSince)
        if (snapshot.phase === "failed") {
          setError(snapshot.error || "Assessment failed.")
          setCisRun(null)
          return
        }
        if (snapshot.phase === "done") {
          const completed = snapshot.assessment
          if (!completed) {
            setError("Assessment finished without results.")
            setCisRun(null)
            return
          }
          const installPack = resolveCisRunCompletion(capturedPack, { reference: completed.reference, packPolicies: snapshot.packPolicies })
          if (!installPack) {
            setError("Assessment finished for a different policy pack than the one loaded. Its results were not applied. Load the pack you want to assess and run the assessment again.")
            setCisRun(null)
            return
          }
          setCisRun({ ...snapshot, findings: accumulation.findings })
          setPolicies(installPack.policies); setReference(installPack.reference)
          setHistorical(false); setSelected(new Set()); setPreview(false); setConfirmed(false); setCreation(null); setPage(0); setFilter("All")
          setSetupRequested(false)
          setAssessment(completed)
          const saved = await workspaceRequest("workspace-load")
          if (cisRunGeneration.current !== generation) return
          setWorkspace(saved)
          setCisRun(null)
          return
        }
        setCisRun({ ...snapshot, findings: accumulation.findings })
        await new Promise(resolve => setTimeout(resolve, 600))
      }
    } catch (e) {
      if (cisRunGeneration.current !== generation) return
      setError(e instanceof Error ? e.message : "The request failed.")
      setCisRun(null)
    } finally {
      if (cisRunGeneration.current === generation) setBusy("")
    }
  }
  async function loadCisCatalog() {
    setBusy("Loading available benchmarks…"); setCisCatalogMessage(""); setError("")
    try {
      const catalog = await request<CisCatalog>({ action: "cis-catalog", tenantId: credentials?.tenantId, frameworkId: framework.id })
      setCisCatalog(catalog.benchmarks)
      if (!catalog.benchmarks.length) setCisCatalogMessage("No benchmarks are available from the delivery service.")
    } catch (e) {
      setCisCatalog(null)
      setCisCatalogMessage(e instanceof Error ? e.message : "The available benchmarks could not be loaded.")
    } finally { setBusy("") }
  }
  async function loadDeliveredPack(benchmark: CisBenchmark, level: 1 | 2) {
    await perform("Loading benchmark pack…", async () => {
      const result = await request<{ benchmark: string; version: string; level: number; reference: string; policyCount: number; settingCount: number }>({ action: "cis-fetch-pack", tenantId: credentials?.tenantId, frameworkId: framework.id, benchmark: benchmark.id, version: benchmark.version, level })
      reset()
      setLoadedKitLevel(null)
      const saved = await workspaceRequest("workspace-load")
      setWorkspace(saved); setPolicies(saved.policies); setReference(saved.reference || result.reference)
    })
  }
  async function requireCurrentCisAccess(): Promise<void> {
    if (!(await refreshInternalCisBenchmarks())) throw new Error("CIS comparisons are coming soon.")
  }
  async function requireCurrentKitImport(): Promise<void> {
    if (!kitImport) throw new Error("CIS comparisons are coming soon.")
    await requireCurrentCisAccess()
  }
  function clearKit() { setKitConversion(null); setKitDetected({ id: "" }); setKitFiles([]); setKitBenchmark(""); setKitVersion(""); setLoadedKitLevel(null); setPolicies([]); setReference(""); reset() }
  function applyKitConversion(files: KitFile[], id: string, version?: string) {
    const conversion = convertKit(files, { id, ...(version ? { version } : {}) })
    setLoadedKitLevel(null)
    setKitConversion(conversion); setKitDetected({ id: conversion.summary.benchmark, version: conversion.summary.version }); setKitBenchmark(conversion.summary.benchmark); setKitVersion(conversion.summary.version)
  }
  useEffect(() => {
    if (!workspace || !recommendationList) return
    let active = true
    void workspaceRequest("workspace-save", { policies, reference, recommendationList }).then(saved => { if (active) setWorkspace(saved) }).catch(e => { if (active) setError(`Workspace was not saved: ${String(e)}`) })
    return () => { active = false }
  }, [recommendationList])
  const findings = assessment?.findings.filter(f => filter === "All" || f.status === filter) ?? []
  const readiness = assessment && framework.id === "cis-benchmarks" ? cisReadiness(assessment, policies, denominator, recommendationList, workspace?.exceptions) : null
  const trend = framework.id === "cis-benchmarks" && workspace ? cisReadinessTrend(workspace.history, recommendationList, workspace.exceptions) : []
  const drift = cisDriftSignals(trend)
  const trendLevels = [...new Set(trend.flatMap(point => point.levels.map(level => level.level)))].sort((a, b) => a - b)
  // Selected findings that do not already have an active exception at their level, one per exception identity:
  // policies with the same name can repeat a setting, and the server accepts one active exception per identity.
  const excludable = readiness ? [...new Map(chosen.filter(finding => finding.status !== "Present" && !readiness.levels.some(level =>
    level.level === kitLevelForPolicy(policies[finding.policyIndex]) && level.exceptions.some(exception => exception.policyName === finding.policyName && exception.settingId === finding.settingId)))
    .map(finding => [exceptionKey(readiness.benchmark, readiness.version, kitLevelForPolicy(policies[finding.policyIndex]), finding.policyName, finding.settingId), finding])).values()] : []
  const excludeSelected = async ({ owner, reason, expiresOn }: { owner: string; reason: string; expiresOn: string }) => {
    if (!readiness || busy) return
    const form = { owner, reason, expiresOn }
    setBusy("Excluding findings from the score...")
    setExclusion(old => old && { ...old, error: "" })
    let saved: FrameworkWorkspace | null = null
    let added = 0
    try {
      for (const finding of excludable) {
        saved = await workspaceRequest("workspace-cis-exception-add", { benchmark: readiness.benchmark, version: readiness.version, level: kitLevelForPolicy(policies[finding.policyIndex]), policyName: finding.policyName, settingId: finding.settingId, ...form })
        added++
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The request failed."
      setExclusion(old => old && { ...old, error: added ? `Excluded ${added} of ${excludable.length} findings, then stopped: ${message}` : message })
      return
    } finally {
      if (saved) setWorkspace(saved)
      setBusy("")
    }
    setExclusion(null); setSelected(new Set()); setPreview(false); setConfirmed(false); setCisExceptionsOpen(true)
  }
  const savedWorkspaceActions = <div className="mt-3 flex flex-wrap gap-3">
    <ExportButton framework={framework} plan={plan} disabled={!!busy || !workspace?.history.length} onClick={() => exportSaved("json")}>{isCis ? "Export saved assessments JSON" : "Export saved assessments"}</ExportButton>
    <button className={button} disabled={!!busy} onClick={async () => { if (await confirm({ title: "Delete saved workspace?", description: "Delete this saved workspace and all assessment history?", confirmLabel: "Delete workspace", destructive: true })) void perform("Deleting workspace…", async () => { suppressedDraft.current = JSON.stringify({ policies, reference }); const saved = await workspaceRequest("workspace-delete"); suppressedDraft.current = JSON.stringify({ policies: [], reference: "" }); setWorkspace(saved); setKitConversion(null); setKitFiles([]); setKitDetected({ id: "" }); setKitBenchmark(""); setKitVersion(""); setLoadedKitLevel(null); setPolicies([]); setReference(""); setRecommendationList(undefined); reset() }) }}>Delete workspace</button>
  </div>
  const savedHistoryRows = workspace?.history.map(entry => <div key={entry.assessment.runId} className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3 text-sm">
    <span>{isCis ? formatLocaleDate(entry.assessment.assessedAt) : entry.assessment.assessedAt} · {entry.assessment.reference} · {entry.assessment.findings.length} findings{entry.creation ? ` · ${entry.creation.results.length} creation outcomes` : ""}</span>
    <button className={button} disabled={!!busy} onClick={() => { reset(); setSetupRequested(false); setLoadedKitLevel(null); setPolicies(entry.policies); setReference(entry.assessment.reference); setAssessment(entry.assessment); setCreation(entry.creation ?? null); setHistorical(true) }}>View read-only</button>
    {!isCis && <ExportButton framework={framework} plan={plan} disabled={!!busy} onClick={() => exportSaved("json", entry.assessment.runId)}>Export JSON</ExportButton>}
    <button className={button} disabled={!!busy} onClick={async () => { if (await confirm({ title: "Delete saved assessment?", description: "Delete this saved assessment?", confirmLabel: "Delete", destructive: true })) void perform("Deleting assessment…", async () => { const saved = await workspaceRequest("workspace-delete-assessment", { runId: entry.assessment.runId }); setWorkspace(saved); setPolicies(saved.policies); setReference(saved.reference); reset() }) }}>Delete</button>
  </div>)
  const exportCisPdf = () => {
    if (!assessment) return
    void perform("Exporting PDF…", async () => {
      const { file } = await request<{ file: ExportFile }>({ action: "workspace-cis-pdf", tenantId: credentials?.tenantId, tenantName: selectedTenant?.name, frameworkId: framework.id, runId: assessment.runId, ...(denominator ? { denominator } : {}) })
      saveExport(file)
    })
  }
  const exportReadinessCsv = () => {
    if (!readiness) return
    const current = readiness
    void perform("Checking CIS access…", async () => {
      await requireCurrentCisAccess()
      const exportedAt = new Date().toISOString()
      const name = governanceExportName("cis-readiness", selectedTenant?.name ?? null, exportedAt)
      save(new Blob([`\uFEFF${cisReadinessCsv(current)}`], { type: "text/csv;charset=utf-8" }), `${name}.csv`)
    })
  }
  const exportReadinessJson = () => {
    if (!readiness) return
    const current = readiness
    void perform("Checking CIS access…", async () => {
      await requireCurrentCisAccess()
      const exportedAt = new Date().toISOString()
      const name = governanceExportName("cis-readiness", selectedTenant?.name ?? null, exportedAt)
      save(new Blob([cisReadinessJson(current, selectedTenant?.name ?? null, exportedAt)], { type: "application/json" }), `${name}.json`)
    })
  }
  const exportCoverage = () => {
    if (!isCis) {
      exportJson({ reference, ...packCoverage(policies) }, `${framework.id}-coverage.json`)
      return
    }
    void perform("Checking CIS access…", async () => {
      await requireCurrentCisAccess()
      exportJson({ reference, ...packCoverage(policies) }, `${framework.id}-coverage.json`)
    })
  }
  const savedBlock = workspace ? (isCis ? <details className="mb-5 rounded-3xl bg-white p-6" aria-label="Saved assessment history">
    <summary className="cursor-pointer text-lg font-medium">Saved assessments</summary>
    <p className="mt-2 text-sm text-gray-600">Packs, source versions and results are saved in encrypted storage on this device. Historical assessments are read-only. Run a fresh comparison before remediation.</p>
    {savedHistoryRows}
    {historical && <p role="status" className="mt-3 text-sm text-amber-800">Viewing a saved assessment. Compare again to obtain current evidence and enable remediation.</p>}
    {savedWorkspaceActions}
  </details> : <section className="mb-5 rounded-3xl bg-white p-6" aria-label="Saved assessment history">
    <h2 className="text-lg font-medium">Saved workspace and history</h2>
    <p className="mt-2 text-sm text-gray-600">Packs, source versions and results are saved in encrypted storage on this device. Historical assessments are read-only. Run a fresh comparison before remediation.</p>
    {savedWorkspaceActions}
    {savedHistoryRows}
    {historical && <p role="status" className="mt-3 text-sm text-amber-800">Viewing a saved assessment. Compare again to obtain current evidence and enable remediation.</p>}
  </section>) : null
  return <div className="mx-auto max-w-6xl space-y-5 p-6 lg:p-8">
    {confirmDialog}
    {!standalone && <Link to="/portal/frameworks" className="text-sm text-blue-700 hover:underline">Frameworks</Link>}
    <div className={`${standalone ? "" : "mt-4 "}flex flex-wrap items-start justify-between gap-4`}>
      <div><p className="text-xs uppercase tracking-widest text-gray-500">{framework.publisher} · {framework.kind}</p><h1 className={standalone ? "mt-2 text-4xl font-light tracking-tight text-gray-900" : "mt-2 text-3xl font-semibold tracking-tight text-gray-950"}>{framework.name}</h1><p className="mt-2 text-gray-600">{framework.description}</p></div>
      {framework.source && <a href={framework.source} target="_blank" rel="noreferrer" className={button}>Source <ExternalLink className="h-4 w-4" aria-hidden="true" /></a>}
    </div>
    {isCis && <nav aria-label="CIS Benchmarks progress" className="mt-6">
      <ol className="flex flex-wrap gap-2">
        {cisFlowSteps(!!kitConversion, !!assessment, !!cisRun).map(item => <li key={item.step} {...(item.state === "current" ? { "aria-current": "step" as const } : {})} className={cn("inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm font-medium", item.state === "complete" ? "border-transparent bg-green-50 text-green-800" : item.state === "current" ? "border-transparent bg-primary text-primary-foreground" : "border-gray-200 bg-white text-gray-500")}>
          {item.state === "complete" ? <Check className="h-4 w-4" aria-hidden="true" /> : <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-xs font-semibold">{item.step}</span>}
          <span>{item.step} {item.label}</span>
        </li>)}
      </ol>
    </nav>}
    {isCis && stage === "results" && assessment && <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-3xl bg-white px-5 py-4 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div className="min-w-0">
        <p title={assessment.reference} className="truncate text-base font-medium text-gray-900">{benchmarkDisplayName(readiness?.benchmark ?? assessment.reference.split(/\s+/)[0] ?? "")}{(readiness?.benchmark ?? assessment.reference.split(/\s+/)[0]) && assessment.reference.startsWith(readiness?.benchmark ?? assessment.reference.split(/\s+/)[0]!) ? ` ${assessment.reference.slice((readiness?.benchmark ?? assessment.reference.split(/\s+/)[0]!).length).trim()}` : ""}</p>
        <p className="mt-0.5 text-sm text-gray-500">{assessment.policyCount} tenant policies read · {new Date(assessment.assessedAt).toLocaleString()}</p>
        {historical && <p role="status" className="mt-1 text-sm text-amber-800">Viewing a saved assessment. Compare again to obtain current evidence and enable remediation.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primary} disabled={!!busy || !!cisRun || !credentials || !policies.length || !reference.trim()} onClick={() => void startCisAssessment()}>Run again</button>
        <button type="button" className={button} onClick={() => setSetupRequested(true)}>New assessment</button>
        <CisExportMenu plan={plan} disabled={!!busy} readinessDisabled={!readiness} onPdf={exportCisPdf} onFindingsCsv={() => exportSaved("csv", assessment.runId)} onFindingsJson={() => exportSaved("json", assessment.runId)} onReadinessCsv={exportReadinessCsv} onReadinessJson={exportReadinessJson} />
      </div>
    </div>}
    {isCis && stage === "running" && cisRun && <>{error && <p role="alert" className="mt-6 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}<CisRunView run={cisRun} /></>}
    {isCis && stage === "setup" && assessment && <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-3xl bg-white p-5 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div>
        <p className="text-base font-medium text-gray-900">{assessment.reference}</p>
        <p className="mt-1 text-sm text-gray-500">{assessment.policyCount} tenant policies read · {new Date(assessment.assessedAt).toLocaleString()}</p>
      </div>
      <button type="button" className={button} onClick={() => setSetupRequested(false)}>Back to results</button>
    </div>}
    {(!isCis || stage === "setup") && <details className="group my-6 rounded-3xl bg-blue-50/60 px-6 py-4 shadow-[0_1px_2px_rgba(22,21,20,0.04)] lg:px-7 [&[open]_.chevron]:rotate-180">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-3 text-sm"><Info className="size-4 shrink-0 text-blue-700" aria-hidden="true" /><span><strong className="font-medium text-gray-900">Assessment coverage</strong><span className="text-gray-600"> · What is compared, content sources and limits.</span></span></span>
        <ChevronDown className="chevron size-4 shrink-0 text-gray-500 transition-transform" aria-hidden="true" />
      </summary>
      <div className="mt-4 space-y-2 border-t border-blue-100 pt-4 text-sm leading-6 text-gray-700"><p>Mapping format v1. Automatic content: NCSC Device Security Guidance 2025 Windows Settings Catalog only. Other frameworks use administrator-supplied mappings. No certification or complete framework assessment is implied.</p><p>{framework.coverage}</p>{framework.licenseNotice && <p>{framework.licenseNotice}</p>}<p>Comparison covers Settings Catalog root settings and their nested values. Assignment targets, exclusions and filter references are reported separately from configuration. Group membership, device applicability, enforcement and other policy families remain unavailable. “Present” means a matching configuration exists; it does not mean the setting is assigned or enforced.</p></div>
    </details>}
    {(!isCis || stage === "setup") && savedBlock}
    {framework.id === CIS_BENCHMARKS_ID && stage === "setup" && <details className="mb-5"><summary className="inline-flex h-10 cursor-pointer list-none items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-5 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 [&::-webkit-details-marker]:hidden">Portfolio</summary><div className="mt-3"><CisPortfolio plan={plan} /></div></details>}
    {isCis && stage === "setup" && <section aria-labelledby="cis-delivered-title" className="mb-5 rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="cis-delivered-title" className="text-xl font-medium tracking-tight">Benchmarks from TenuVault</h2><span className="text-sm text-gray-500">{cisCatalog ? `${cisCatalog.length} benchmarks available` : "Delivery service"}</span></div>
      <p className="mt-2 text-sm text-gray-600">Load a benchmark pack from the TenuVault delivery service. The pack is saved in encrypted storage on this device for the selected tenant.</p>
      <div className="mt-4"><button type="button" className={primary} disabled={!!busy || !credentials} onClick={() => void loadCisCatalog()}>Load available benchmarks</button></div>
      {busy && <p role="status" className="mt-4 text-sm text-blue-700">{busy}</p>}
      {busy && <div role="progressbar" aria-label={busy} className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100"><div className="h-full w-1/3 animate-pulse rounded-full bg-primary" /></div>}
      {cisCatalogMessage && <p role="alert" className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">{cisCatalogMessage}</p>}
      {cisCatalog && cisCatalog.length > 0 && <div className="mt-4 grid gap-3 sm:grid-cols-2" role="group" aria-label="Available benchmarks">{cisCatalog.map(benchmark => <div key={`${benchmark.id}-${benchmark.version}`} className="rounded-2xl border border-gray-200 bg-white p-4">
        <p className="text-sm font-medium text-gray-900">{benchmark.name}</p>
        <p className="mt-1 text-sm text-gray-600">{benchmark.id} {benchmark.version}</p>
        <div className="mt-3 flex flex-wrap gap-2">{benchmark.levels.map(level => <button key={level} type="button" className={button} disabled={!!busy || !credentials} onClick={() => void loadDeliveredPack(benchmark, level)}>Level {level}</button>)}</div>
      </div>)}</div>}
    </section>}
    {(!isCis || stage === "setup") && <section aria-labelledby="pack-title" className="rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="pack-title" className="text-xl font-medium tracking-tight">{isCis && kitImport ? "1. Import a CIS Build Kit" : "1. Choose your policy pack"}</h2><span className="text-sm text-gray-500">{policies.length ? `${policies.length} policies loaded` : "No pack loaded"}</span></div>
      {!isCis && <p className="mt-2 text-sm text-gray-600">Import one or more Settings Catalog JSON exports. Review the source, version and intended profile before comparison. Loading a pack does not change your tenant.</p>}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {framework.id === "ncsc-dsg" && <button className={button} disabled={!!busy} onClick={() => void perform("Loading NCSC pack…", async () => {
          const pack = await request<NcscPack>({ action: "load-ncsc" }); reset(); setPolicies(pack.policies); setReference(pack.reference)
        })}>Load NCSC Windows 2025</button>}
        {!isCis && <label className="text-sm font-medium text-gray-700">Import policy JSON<input type="file" multiple accept=".json,application/json" disabled={!!busy} className="ml-3 max-w-full text-sm" onChange={e => {
          const files = Array.from(e.target.files ?? []); e.target.value = ""
          if (!files.length) return
          void perform("Reading policy pack…", async () => {
            if (files.reduce((sum, f) => sum + f.size, 0) > 8_000_000) throw new Error("The policy pack exceeds 8 MB.")
            const values: unknown[] = []
            for (const file of files) { const json: unknown = JSON.parse(await file.text()); values.push(...(Array.isArray(json) ? json : [json])) }
            const parsed = parsePolicies(values); reset(); setPolicies(parsed); setReference("")
          })
        }} /></label>}
      </div>
      {framework.id === "ncsc-dsg" && <p className="mt-3 text-xs text-gray-500">Source content: UK National Cyber Security Centre, Crown Copyright, <a href={`${NCSC_REPOSITORY}/blob/${NCSC_COMMIT}/LICENSE`} target="_blank" rel="noreferrer" className="underline">Apache License 2.0</a>. Pinned commit {NCSC_COMMIT.slice(0, 7)}, each file checked against its reviewed SHA-256. Modified for comparison: decoded from UTF-16, export metadata, IDs and assignments removed. No endorsement by NCSC. Comparison and reports only; policies cannot be created from this pack.</p>}
      {framework.id === "cis-benchmarks" && kitImport && <details className="mt-5"><summary className="cursor-pointer text-sm font-medium text-gray-700">Internal kit import</summary><div className="mt-4">
        <p className="text-sm text-gray-600">The kit stays on this device, is converted locally, and nothing is created in the tenant from the import.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className={cn(primary, "focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2")}>Select Build Kit zip<input type="file" accept=".zip,application/zip" disabled={!!busy} className="sr-only" onChange={e => {
            const file = e.target.files?.[0]; e.target.value = ""
            if (!file) return
            void perform("Converting Build Kit…", async () => {
              await requireCurrentKitImport()
              clearKit()
              const files = await readKitZip(await file.arrayBuffer())
              setKitFiles(files)
              const suggested = suggestedKitBenchmark(files.map(item => item.path), file.name)
              setKitDetected(suggested); setKitBenchmark(suggested.id); setKitVersion(suggested.version ?? "")
              if (suggested.id) applyKitConversion(files, suggested.id, suggested.version)
            })
          }} /></label>
          <label className={cn(button, "focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2")}>Select extracted kit folder<input type="file" disabled={!!busy} className="sr-only" {...{ webkitdirectory: "" }} onChange={e => {
            const files = Array.from(e.target.files ?? []); e.target.value = ""
            if (!files.length) return
            void perform("Converting Build Kit…", async () => {
              await requireCurrentKitImport()
              clearKit()
              if (files.length > 2000) throw new Error("The kit contains too many files. Split the kit or remove extra files before importing.")
              const kitFiles: KitFile[] = []
              let total = 0
              for (const file of files) {
                const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
                if (!/\.json$/i.test(path)) { kitFiles.push({ path, content: "" }); continue }
                if (file.size > 8 * 1024 * 1024) throw new Error("A file in the kit is larger than 8 MB. Remove it before importing.")
                total += file.size
                if (total > 32 * 1024 * 1024) throw new Error("The kit files total more than 32 MB. Split the kit before importing.")
                kitFiles.push({ path, content: await file.text() })
              }
              setKitFiles(kitFiles)
              const suggested = suggestedKitBenchmark(kitFiles.map(item => item.path))
              setKitDetected(suggested); setKitBenchmark(suggested.id); setKitVersion(suggested.version ?? "")
              if (suggested.id) applyKitConversion(kitFiles, suggested.id, suggested.version)
            })
          }} /></label>
        </div>
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-gray-700">Optional coverage and manual files</summary>
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap items-center gap-3"><label className={cn(button, "focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2")}>Select denominator JSON<input type="file" accept=".json,application/json" disabled={!!busy} className="sr-only" onChange={e => {
              const file = e.target.files?.[0]; e.target.value = ""
              if (!file) return
              void perform("Reading denominator list…", async () => { await requireCurrentKitImport(); setDenominator(parseDenominatorList(await file.text())) })
            }} /></label><p className="text-sm text-gray-600">Adds the full count of automated recommendations so coverage can be shown.</p></div>
            <div className="flex flex-wrap items-center gap-3"><label className={cn(button, "focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2")}>Select recommendation list JSON<input type="file" accept=".json,application/json" disabled={!!busy} className="sr-only" onChange={e => {
              const file = e.target.files?.[0]; e.target.value = ""
              if (!file) return
              void perform("Reading recommendation list…", async () => { await requireCurrentKitImport(); setRecommendationList(parseRecommendationList(await file.text())) })
            }} /></label><p className="text-sm text-gray-600">Adds manual recommendations that appear in the readiness Manual section.</p></div>
            {recommendationList && <p className="text-sm text-gray-600">{recommendationList.benchmark} {recommendationList.version}: {recommendationList.items.length} recommendations loaded, {recommendationList.items.filter(item => !item.automated).length} manual. Manual items appear in the readiness Manual section after a comparison.</p>}
            {denominator && <p className="text-sm text-gray-600">{denominator.length} denominator entries loaded. Coverage uses the automated entries per Level.</p>}
          </div>
        </details>
        {kitFiles.length > 0 && !kitConversion && <div className="mt-4 text-sm text-gray-700">
          <p>Enter a benchmark id to convert this kit.</p>
          {kitDetected.id && <p className="mt-2 text-gray-600">Detected benchmark: {kitDetected.id}{kitDetected.version ? `, version ${kitDetected.version}` : ""}</p>}
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block text-sm font-medium text-gray-700">Benchmark id<input value={kitBenchmark} disabled={!!busy} onChange={e => setKitBenchmark(e.target.value)} placeholder="For example: synthetic-os" className="mt-2 w-56 rounded-full border border-gray-300 px-4 py-2 font-normal" /></label>
            <label className="block text-sm font-medium text-gray-700">Version<input value={kitVersion} disabled={!!busy} onChange={e => setKitVersion(e.target.value)} placeholder="For example: 1.0.0" className="mt-2 w-48 rounded-full border border-gray-300 px-4 py-2 font-normal" /></label>
            <button type="button" className={button} disabled={!!busy || !kitBenchmark.trim()} onClick={() => void perform("Converting Build Kit…", async () => { await requireCurrentKitImport(); setKitConversion(null); applyKitConversion(kitFiles, kitBenchmark.trim(), kitVersion.trim() || undefined) })}>Reconvert</button>
          </div>
        </div>}
        {kitConversion && <div className="mt-4 text-sm text-gray-700">
          <p>{kitConversion.summary.benchmark} {kitConversion.summary.version}: {kitConversion.summary.levels.map(level => `Level ${level.level}: ${level.policies} policies, ${level.settings} settings`).join("; ") || "no converted policies"}</p>
          <p className="mt-2 text-gray-600">Detected benchmark: {kitConversion.summary.benchmark}, version {kitConversion.summary.version}</p>
          {kitConversion.skipped.length > 0 && <p className="mt-2 text-gray-600">Skipped for coverage only: {kitConversion.skipped.map(item => item.path).join("; ")}</p>}
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block text-sm font-medium text-gray-700">Benchmark id<input value={kitBenchmark} disabled={!!busy} onChange={e => setKitBenchmark(e.target.value)} className="mt-2 w-56 rounded-full border border-gray-300 px-4 py-2 font-normal" /></label>
            <label className="block text-sm font-medium text-gray-700">Version<input value={kitVersion} disabled={!!busy} onChange={e => setKitVersion(e.target.value)} placeholder="For example: 1.0.0" className="mt-2 w-48 rounded-full border border-gray-300 px-4 py-2 font-normal" /></label>
            <button type="button" className={button} disabled={!!busy || !kitBenchmark.trim() || !kitFiles.length} onClick={() => void perform("Converting Build Kit…", async () => { await requireCurrentKitImport(); setKitConversion(null); applyKitConversion(kitFiles, kitBenchmark.trim(), kitVersion.trim() || undefined) })}>Reconvert</button>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2" role="group" aria-label="Choose a level">
            {kitConversion.packs.map(pack => {
              const selectedPack = loadedKitLevel === pack.level
              return <button key={pack.level} type="button" aria-pressed={selectedPack} disabled={!!busy} onClick={() => void perform("Checking CIS access…", async () => { await requireCurrentKitImport(); reset(); setLoadedKitLevel(pack.level); setPolicies(pack.policies); setReference(pack.reference) })} className={cn("rounded-2xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50", selectedPack ? "border-primary bg-blue-50 ring-1 ring-primary" : "border-gray-200 bg-white hover:bg-gray-50")}>
                <span className="flex items-center justify-between gap-3"><span className="text-sm font-medium text-gray-900">Level {pack.level}</span>{selectedPack && <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700"><Check className="h-4 w-4" aria-hidden="true" />Selected</span>}</span>
                <span className="mt-2 block text-sm text-gray-600">{pack.policies.length} {pack.policies.length === 1 ? "policy" : "policies"}</span>
                <span className="block text-sm text-gray-600">{packSettingCount(pack)} {packSettingCount(pack) === 1 ? "setting" : "settings"}</span>
                <span className="mt-2 block text-xs text-gray-500">{selectedPack ? "Loaded. Compare it with the tenant in step 2." : "Load this level"}</span>
              </button>
            })}
          </div>
          <p className="mt-2 text-xs text-gray-500">Loading a pack saves it in the workspace for the selected tenant. Compare it with the tenant in step 2.</p>
        </div>}
      </div></details>}
      {policies.length > 0 && <>
        {!fromKit && <>
          <button className={button} onClick={exportCoverage}>Export coverage and source mappings</button>
          <p className="mt-3 text-xs text-gray-600">Unsupported: {UNSUPPORTED.join('; ')}. Retained source declarations are not signatures. Organizational evidence and profile approval remain manual.</p>
          <label className="mt-5 block text-sm font-medium text-gray-700">Source version / profile<input value={reference} maxLength={200} disabled={!!busy} onChange={e => { setReference(e.target.value); reset() }} placeholder="For example: approved workstation baseline, revision 3, standard profile" className="mt-2 w-full rounded-full border border-gray-300 px-4 py-2 font-normal" /></label>
        </>}
        <details className="mt-4 text-sm"><summary className="cursor-pointer text-gray-700">Review {policies.length} loaded policies and remove alternative profiles</summary><ul className="mt-3 max-h-64 divide-y divide-gray-100 overflow-auto rounded-2xl bg-gray-50">{policies.map((p, i) => <li key={`${p.name}:${i}`} className="flex items-center justify-between gap-3 p-3"><span>{p.name}<span className="ml-2 text-xs text-gray-500">{p.settings.length} root settings</span></span><button disabled={!!busy} className="text-blue-700 hover:underline disabled:opacity-50" aria-label={`Remove ${p.name}`} onClick={() => { setLoadedKitLevel(null); setPolicies(policies.filter((_, index) => index !== i)); reset() }}>Remove</button></li>)}</ul></details>
      </>}
    </section>}
    {(!isCis || stage !== "running") && <section {...(isCis && stage === "results" ? { "aria-label": "Assessment results" } : { "aria-labelledby": "compare-title" })} className="mt-5 rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      {(!isCis || stage !== "results") && <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="compare-title" className="text-xl font-medium tracking-tight">2. Compare with your tenant</h2><p className="mt-1 text-sm text-gray-600">{selectedTenant ? `Selected tenant: ${selectedTenant.name}` : "Choose a connected tenant using the sidebar."}</p></div>
        {isCis ? <button className={primary} disabled={!!busy || !!cisRun || !credentials || !policies.length || !reference.trim()} onClick={() => void startCisAssessment()}>{cisRun ? "Assessment running" : assessment ? "Run again" : "Start Assessment"}</button> : <button className={primary} disabled={!!busy || !credentials || !policies.length || !reference.trim()} onClick={() => void perform("Reading tenant policies and comparing settings…", async () => {
          reset(); const result = await request<Assessment>({ action: "assess", tenantId: credentials!.tenantId, appId: credentials!.appId, frameworkId: framework.id, reference, policies }); setAssessment(result); setWorkspace(await workspaceRequest("workspace-load"))
        })}>{assessment ? "Compare again" : "Run comparison"}</button>}</div>}
      {busy && <p role="status" className="mt-4 text-sm text-blue-700">{busy}</p>}
      {busy && isCis && <div role="progressbar" aria-label={busy} className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100"><div className="h-full w-1/3 animate-pulse rounded-full bg-primary" /></div>}
      {error && <p role="alert" className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
      {assessment && (!isCis || stage === "results") && <>
        {!isCis && <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-gray-500"><p>{assessment.policyCount} tenant policies read · {new Date(assessment.assessedAt).toLocaleString()}</p><div className="flex flex-wrap gap-2">{(["pdf", "csv", "json"] as ("pdf" | "csv" | "json")[]).map(format => <ExportButton key={format} framework={framework} plan={plan} disabled={!!busy} onClick={() => exportSaved(format, assessment.runId)}><Download className="h-4 w-4" aria-hidden="true" />{format === "pdf" ? "PDF report" : format.toUpperCase()}</ExportButton>)}</div></div>}
        {readiness && <section aria-label="CIS readiness" className="mb-6 border-b border-gray-100 pb-6 text-sm text-gray-700">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-medium text-gray-900">CIS readiness</h3>
            <p className="text-xs text-gray-500">{readiness.manualNote} This view covers the automated settings in the imported pack only.</p>
          </div>
          <div className="mt-4 divide-y divide-gray-100">
            {readiness.levels.map(level => {
              const total = level.assessedSettings
              const segments = [
                { label: "Present", count: level.present, className: "bg-green-500", dot: "bg-green-500", text: "text-green-700" },
                { label: "Different", count: level.different, className: "bg-red-500", dot: "bg-red-500", text: "text-red-700" },
                { label: "Missing", count: level.missing, className: "bg-amber-400", dot: "bg-amber-400", text: "text-amber-800" },
                { label: "Review", count: level.review, className: "bg-gray-300", dot: "bg-gray-300", text: "text-gray-600" },
              ]
              const visible = segments.filter(segment => segment.count > 0)
              const stats: [string, string][] = [
                ["Assessed settings", String(level.assessedSettings)],
                ["Assessed automated", String(level.assessedAutomated)],
                ["Coverage", level.coverage === null ? "Not available" : `${Math.round(level.coverage * 1000) / 10}% (${level.assessedAutomated} of ${level.denominator})`],
                ["Not assessed", level.notAssessed.length ? level.notAssessed.join(", ") : "None listed"],
                ["Excluded from score", String(level.excepted)],
              ]
              return <article key={`card-${level.level}`} aria-label={`Level ${level.level} summary`} className="grid gap-5 py-5 first:pt-1 sm:grid-cols-[11rem_minmax(0,1fr)] lg:grid-cols-[11rem_minmax(0,1fr)_16rem]">
                <div>
                  <p className="text-xs font-medium text-gray-500">{benchmarkDisplayName(level.benchmark)} · Level {level.level}{level.version ? ` · ${level.version}` : ""}</p>
                  <p className={`mt-1 font-light tabular-nums tracking-tight text-gray-900 ${level.passRate === null ? "text-2xl" : "text-5xl"}`}>{level.passRate === null ? "Not available" : `${Math.round(level.passRate * 1000) / 10}%`}</p>
                  <p className="mt-1 text-xs text-gray-500">Pass rate</p>
                  {level.adjustedPassRate !== null && level.adjustedPassRate !== level.passRate && <p className="mt-1 text-xs font-medium text-gray-700">Adjusted pass rate {Math.round(level.adjustedPassRate * 1000) / 10}%</p>}
                </div>
                <div className="min-w-0 self-center">
                  <div role="img" aria-label={`Level ${level.level} status proportions`} className="flex h-2.5 w-full overflow-hidden rounded-full bg-gray-100">{visible.map(segment => <span key={segment.label} className={segment.className} style={{ width: total ? `${(segment.count / total) * 100}%` : "0%" }} />)}</div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                    {segments.map(segment => <div key={`legend-${segment.label}`}>
                      <dt className="flex items-center gap-1.5 text-xs text-gray-500"><span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${segment.dot}`} />{segment.label}</dt>
                      <dd className={`mt-0.5 text-lg font-medium tabular-nums ${segment.count ? segment.text : "text-gray-400"}`}>{segment.count}</dd>
                    </div>)}
                  </dl>
                  {!visible.length && <p className="mt-2 text-xs text-gray-500">No assessed settings</p>}
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 self-center lg:grid-cols-1 lg:gap-y-2">
                  {stats.map(([label, value]) => <div key={label} className="flex items-baseline justify-between gap-3 lg:border-b lg:border-gray-100 lg:pb-1.5">
                    <dt className="text-xs text-gray-500">{label}</dt>
                    <dd className="text-right text-xs font-medium tabular-nums text-gray-800">{value}</dd>
                  </div>)}
                </dl>
              </article>
            })}
          </div>
          {readiness.levels.some(level => level.coverage === null) && <p className="text-xs text-gray-500">{denominator || recommendationList ? "Coverage needs a denominator list: none was imported for every level, so coverage is not shown where it is missing." : "No denominator list was imported, so coverage is not shown."}</p>}
          {readiness.levels.map(level => level.manual.length > 0 && <div key={`manual-${level.level}`} className="mt-4">
            <h4 className="font-medium text-gray-900">Manual, Level {level.level}</h4>
            <p className="mt-1 text-xs text-gray-500">{benchmarkDisplayName(readiness.benchmark)} {readiness.version}, Level {level.level}. These items are not assessed automatically.</p>
            <div className="mt-2 divide-y divide-gray-100 border-y border-gray-100">{level.manual.map(item => <details key={item.identifier} className="py-3">
              <summary className="cursor-pointer text-sm"><span className="font-medium text-gray-800">{item.identifier}</span>{item.title && <span className="ml-2 text-gray-700">{item.title}</span>}<span className="ml-2 inline-block rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-700">Manual</span></summary>
              <div className="mt-3 space-y-2 text-sm text-gray-700">
                {item.hasText ? <>
                  {item.description && <p><strong className="font-medium text-gray-900">Description:</strong> {item.description}</p>}
                  {item.impact && <p><strong className="font-medium text-gray-900">Impact:</strong> {item.impact}</p>}
                  {item.audit && <p><strong className="font-medium text-gray-900">Audit:</strong> {item.audit}</p>}
                  {item.remediation && <p><strong className="font-medium text-gray-900">Remediation:</strong> {item.remediation}</p>}
                </> : <p><a href={readiness.manualFallbackUrl} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">{readiness.manualFallback}</a></p>}
              </div>
            </details>)}</div>
          </div>)}
          <details open={cisExceptionsOpen} onToggle={e => setCisExceptionsOpen((e.target as HTMLDetailsElement).open)} className="mt-2 border-t border-gray-100">
            <summary id="cis-exclusions" className="cursor-pointer py-3 text-sm font-medium text-gray-800">Excluded from score: {readiness.levels.reduce((sum, level) => sum + level.exceptions.length, 0)} active</summary>
            <div className="border-t border-gray-100 pb-4">
          {readiness.levels.map(level => {
            return <div key={`exceptions-${level.level}`} className="mt-4">
              <h4 className="font-medium text-gray-900">Level {level.level}: {level.excepted} excluded</h4>
              <p className="mt-1 text-xs text-gray-500">Adjusted pass rate: {level.adjustedPassRate === null ? "Not available" : `${Math.round(level.adjustedPassRate * 1000) / 10}%`}. Raw counts above are unchanged.</p>
              {level.exceptions.length ? <ul className="mt-2 space-y-2">{level.exceptions.map(exception => <li key={exception.id} className="flex flex-wrap items-start justify-between gap-3 rounded-2xl bg-gray-50 p-3">
                <span><span className="font-medium text-gray-800">{exception.policyName}</span><span className="block break-all font-mono text-xs text-gray-500">{exception.settingId}</span><span className="block text-xs text-gray-600">Owner: {exception.owner} · Expires: {formatExpiryDate(exception.expiresOn)}</span><span className="block text-xs text-gray-600">{exception.reason}</span></span>
                <button type="button" className={button} disabled={!!busy} onClick={() => void perform("Removing exception...", async () => { const saved = await workspaceRequest("workspace-cis-exception-remove", { exceptionId: exception.id }); setWorkspace(saved) })}>Remove</button>
              </li>)}</ul> : <p className="mt-2 text-xs text-gray-500">Nothing is excluded for this level. Select findings and choose Exclude from score.</p>}
            </div>
          })}
            </div>
          </details>
          <details className="border-t border-gray-100">
            <summary className="cursor-pointer py-3 text-sm font-medium text-gray-800">{trendSummaryText(trend[trend.length - 1], trend.length, formatLocaleDate)}</summary>
            <div className="border-t border-gray-100 pb-4 pt-2">
            {drift.map(entry => <p key={`drift-${entry.level}-${entry.benchmark}-${entry.version}`} role="alert" className="mt-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">Level {entry.level} readiness dropped {((entry.previousRate - entry.currentRate) * 100).toFixed(1)} percentage points to {formatTrendPercent(entry.currentRate)} for {benchmarkDisplayName(entry.benchmark)} {entry.version}.</p>)}
            <p className="mt-1 text-xs text-gray-500">Pass rate across saved assessments for this tenant. Change is in percentage points from the previous saved assessment. Adjusted rates use exceptions accepted by then.</p>
            {trend.length ? <>
            <div className="mt-3 overflow-auto"><table className="w-full text-left text-sm"><thead><tr className="text-gray-500"><th className="py-1 pr-3 font-medium">Date</th><th className="py-1 pr-3 font-medium">Benchmark</th><th className="py-1 pr-3 font-medium">Version</th>{trendLevels.map(level => <th key={`trend-head-${level}`} className="py-1 pr-3 font-medium">Level {level} pass rate</th>)}{trendLevels.map(level => <th key={`trend-change-head-${level}`} className="py-1 pr-3 font-medium">Level {level} change</th>)}</tr></thead><tbody>{trend.map((point, pointIndex) => <tr key={point.runId} className="border-t border-gray-200"><td className="py-2 pr-3">{formatLocaleDate(point.assessedAt)}</td><td className="py-2 pr-3">{benchmarkDisplayName(point.benchmark)}</td><td className="py-2 pr-3">{point.version}</td>{trendLevels.map(level => { const item = point.levels.find(entry => entry.level === level); return <td key={`trend-rate-${point.runId}-${level}`} className="py-2 pr-3">{item ? formatTrendPercent(item.passRate) : "Not available"}{item && item.adjustedPassRate !== null && item.adjustedPassRate !== item.passRate ? ` (adjusted ${formatTrendPercent(item.adjustedPassRate)})` : ""}</td> })}{trendLevels.map(level => { const item = point.levels.find(entry => entry.level === level); return <td key={`trend-change-${point.runId}-${level}`} className="py-2 pr-3">{item ? formatTrendChange(item.changeFromPrevious, pointIndex === 0) : "Not available"}</td> })}</tr>)}</tbody></table></div>
            <div className="mt-3 flex flex-wrap gap-4">{trendLevels.map(level => <div key={`trend-spark-${level}`} className="flex items-center gap-2 text-gray-700"><span className="text-xs font-medium text-gray-500">Level {level}</span><TrendSparkline points={trend} level={level} /></div>)}</div>
            </> : <p className="mt-2 text-xs text-gray-500">No saved assessments yet for a trend.</p>}
            </div>
          </details>
        </section>}
        <div className="mb-2 flex flex-wrap items-center gap-2" aria-label="Filter assessment findings">{["All", "Present", "Missing", "Different", "Review"].map(status => <button key={status} aria-pressed={filter === status} onClick={() => { setFilter(status); setPage(0) }} className={`rounded-full border px-3.5 py-1.5 text-sm transition-colors ${filter === status ? "border-transparent bg-primary text-primary-foreground" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>{status} <span className="ml-1 tabular-nums font-semibold">{assessment.findings.filter(f => status === "All" || f.status === status).length}</span></button>)}
          {isCis && <span className="ml-auto text-sm text-gray-500">{findings.length} of {assessment.findings.length} findings</span>}
        </div>
        <p className="mb-4 text-xs leading-5 text-gray-500">Different: at least one existing configuration differs. Review: the pack contains alternative values for this setting. Select a single profile or resolve differences manually. Unassigned configurations can appear as Present. Expand a finding to inspect assignment evidence, including exclusions, filter references and unavailable reads.</p>
        {isCis ? <div>{groupFindingsByPolicy(findings).map(group => <section key={group.policyIndex} aria-label={group.policyName} className="border-t border-gray-100 py-4 first:border-t-0 first:pt-1">
          <h4 title={group.policyName} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
            <span className="min-w-0 truncate font-medium text-gray-900">{policyDisplayName(group.policyName, reference)}</span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs tabular-nums text-gray-600">{group.total} {group.total === 1 ? "finding" : "findings"}</span>
            <span className="text-xs text-gray-500">{statusMixText(group.counts)}</span>
          </h4>
          <div className="mt-1 divide-y divide-gray-100">{group.findings.map(f => <CisFindingRow key={f.key} finding={f} disabled={!!busy || !!creation || historical} checked={selected.has(f.key)} onChange={() => { setSelected(old => { const next = new Set(old); next.has(f.key) ? next.delete(f.key) : next.add(f.key); return next }); setPreview(false); setConfirmed(false) }} />)}</div>
        </section>)}</div> : <>
        <div className="space-y-2">{findings.slice(page * 50, (page + 1) * 50).map(f => <FindingRow key={f.key} finding={f} disabled={!!busy || !!creation || historical || (!!framework.comparisonOnly && framework.id !== "cis-benchmarks")} remediable={framework.id === "cis-benchmarks"} checked={selected.has(f.key)} onChange={() => { setSelected(old => { const next = new Set(old); next.has(f.key) ? next.delete(f.key) : next.add(f.key); return next }); setPreview(false); setConfirmed(false) }} />)}</div>
        {findings.length > 50 && <div className="mt-4 flex items-center justify-between gap-3"><button className={button} disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span className="text-sm text-gray-500">Page {page + 1} of {Math.ceil(findings.length / 50)}</span><button className={button} disabled={(page + 1) * 50 >= findings.length} onClick={() => setPage(page + 1)}>Next</button></div>}
        </>}
        {!findings.length && <p role="status" className="py-6 text-center text-sm text-gray-500">No findings in this category.</p>}
        {readiness && selected.size > 0 && <div role="region" aria-label="Selected findings" className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center gap-3 rounded-3xl border border-gray-200 bg-white px-5 py-3 shadow-lg">
          <span className="text-sm font-medium text-gray-800">{selected.size} selected</span>
          <span className="text-xs text-gray-500">Remediate them in step 3 below, or exclude them from the score if you do not apply them on purpose.</span>
          <span className="ml-auto flex gap-2">
            <button type="button" className={button} disabled={!!busy || historical} onClick={() => { setSelected(new Set()); setPreview(false); setConfirmed(false) }}>Clear</button>
            <button ref={excludeButton} type="button" className={button} disabled={!!busy || historical || !excludable.length} title={excludable.length ? undefined : "The selected findings are already excluded."} onClick={() => setExclusion({ owner: "", reason: "", expiresOn: "", count: excludable.length, error: "" })}>Exclude from score ({excludable.length})</button>
          </span>
        </div>}
        <Dialog open={exclusion !== null} onOpenChange={open => { if (!open && !busy) setExclusion(null) }}>
          <DialogContent onCloseAutoFocus={e => { e.preventDefault(); (excludeButton.current?.isConnected ? excludeButton.current : document.getElementById("cis-exclusions"))?.focus() }}>
            <DialogHeader>
              <DialogTitle>Exclude {exclusion?.count} {exclusion?.count === 1 ? "finding" : "findings"} from the score</DialogTitle>
              <DialogDescription>Use this for settings you do not apply on purpose. They stay listed but stop counting against the adjusted pass rate until the expiry date, when they count again and need a new decision. Raw counts do not change.</DialogDescription>
            </DialogHeader>
            {exclusion && <form id="cis-exclusion" className="grid gap-3 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); void excludeSelected(exclusion) }}>
              <label className="block text-xs font-medium text-gray-700">Owner<input required value={exclusion.owner} disabled={!!busy} onChange={e => setExclusion({ ...exclusion, owner: e.target.value })} className="mt-1 w-full rounded-full border border-gray-300 px-3 py-1.5 text-sm font-normal" /></label>
              <label className="block text-xs font-medium text-gray-700">Expiry date<input required type="date" value={exclusion.expiresOn} disabled={!!busy} onChange={e => setExclusion({ ...exclusion, expiresOn: e.target.value })} className="mt-1 w-full rounded-full border border-gray-300 px-3 py-1.5 text-sm font-normal" /></label>
              <label className="block text-xs font-medium text-gray-700 sm:col-span-2">Reason<input required value={exclusion.reason} disabled={!!busy} onChange={e => setExclusion({ ...exclusion, reason: e.target.value })} className="mt-1 w-full rounded-full border border-gray-300 px-3 py-1.5 text-sm font-normal" /></label>
              {exclusion.error && <p role="alert" className="text-sm text-red-700 sm:col-span-2">{exclusion.error}</p>}
            </form>}
            <DialogFooter>
              <button type="button" className={button} disabled={!!busy} onClick={() => setExclusion(null)}>Cancel</button>
              <button type="submit" form="cis-exclusion" className={primary} disabled={!!busy || !excludable.length}>{busy ? busy : "Exclude from score"}</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {framework.id === "cis-benchmarks" ? <CisRemediationPanel tenant={selectedTenant ?? undefined} assessment={assessment} policies={policies} reference={reference} selectedKeys={selected} onRecompare={() => void perform("Reading tenant policies and comparing settings...", async () => { reset(); const result = await request<Assessment>({ action: "assess", tenantId: credentials!.tenantId, appId: credentials!.appId, frameworkId: framework.id, reference, policies }); setAssessment(result); setWorkspace(await workspaceRequest("workspace-load")) })} /> : framework.comparisonOnly ? <p className="mt-5 border-t pt-4 text-sm text-gray-600">This pack is available for comparison and reports only. Review missing settings and configure them through your own change process.</p>
        : <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-sm text-gray-600">{chosen.length} missing root settings selected · {payloads.length} new {payloads.length === 1 ? "policy" : "policies"}</p><button className={primary} disabled={!chosen.length || !!busy || !!creation || historical} onClick={() => { setPreview(true); setConfirmed(false) }}>Preview recommended policies</button></div>}
      </>}
    </section>}
    {isCis && stage === "results" && savedBlock}
    {framework.id === CIS_BENCHMARKS_ID && stage === "results" && <details className="mb-5"><summary className="inline-flex h-10 cursor-pointer list-none items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-5 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 [&::-webkit-details-marker]:hidden">Portfolio</summary><div className="mt-3"><CisPortfolio plan={plan} /></div></details>}
    {preview && !framework.comparisonOnly && <section aria-labelledby="preview-title" className="mt-5 rounded-3xl border-2 border-blue-200 bg-white p-7"><h2 id="preview-title" className="text-xl font-medium tracking-tight">3. Review unassigned policies</h2><p className="mt-2 text-sm text-gray-600">Create {payloads.length} new {payloads.length === 1 ? "policy" : "policies"} in <strong>{selectedTenant?.name}</strong> using the selected missing settings and their nested dependencies. Existing policies stay unchanged. Review target groups and conflicts in Intune before assigning these policies.</p><details className="mt-4"><summary className="cursor-pointer text-sm font-medium">Inspect the exact policy payloads</summary><pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-gray-950 p-4 text-xs text-gray-100">{JSON.stringify(payloads, null, 2)}</pre></details><label className="mt-5 flex items-start gap-3 text-sm"><input type="checkbox" checked={confirmed} disabled={!!busy || !!creation} onChange={e => setConfirmed(e.target.checked)} className="mt-1 h-4 min-h-0 w-4 shrink-0" /><span>I reviewed these recommendations and want to create unassigned policies in {selectedTenant?.name}.</span></label><button className={`${primary} mt-4`} disabled={!confirmed || !!busy || !!creation} onClick={() => void perform("Rechecking tenant policies and creating unassigned policies…", async () => {
      const result = await request<NonNullable<typeof creation>>({ action: "create", tenantId: credentials!.tenantId, appId: credentials!.appId, runId: assessment!.runId, keys: [...selected], confirmUnassigned: true }); setCreation(result); setWorkspace(await workspaceRequest("workspace-load"))
    })}>Create {payloads.length} unassigned {payloads.length === 1 ? "policy" : "policies"}</button>
    {creation && <div role="status" className={`mt-4 rounded-3xl p-5 text-sm ${creation.success ? "bg-green-50 text-green-900" : "bg-amber-50 text-amber-950"}`}><strong>{creation.success ? "Unassigned policies created. Assignment and device verification are still required." : "Some policies could not be created. Review each result before comparing again."}</strong><ul className="mt-3 space-y-2">{creation.results.map((r, i) => <li key={i}>{r.name}: {r.error || `Created (${r.id})`}</li>)}</ul></div>}</section>}
  </div>
}


function targetingText(observation: Observation): string {
  if (!observation.targeting || observation.targeting.state === "unavailable") return "Targeting unavailable"
  if (observation.targeting.state === "unassigned") return "Targeting: Unassigned"
  if (observation.targeting.state === "review") return "Targeting: Assigned, needs review"
  return "Targeting: Assigned"
}

function CisFindingRow({ finding, checked, disabled, onChange }: { finding: Finding; checked: boolean; disabled: boolean; onChange: () => void }) {
  const colors = { Present: "bg-green-50 text-green-800", Missing: "bg-amber-50 text-amber-900", Different: "bg-red-50 text-red-800", Review: "bg-gray-100 text-gray-700" }
  const recommendedLines = summarizeSetting(finding.recommended)
  const groups = groupObservationsByValue(finding.observed, finding.recommended)
  return <div className="flex items-start gap-3 py-2.5">
    <input type="checkbox" aria-label={`Select finding ${finding.settingId} from ${finding.policyName}`} checked={checked} disabled={disabled || finding.status === "Present"} onChange={onChange} className="mt-1 h-4 min-h-0 w-4 shrink-0" />
    <details className="group min-w-0 flex-1"><summary className="flex cursor-pointer list-none items-center gap-2.5 text-sm [&::-webkit-details-marker]:hidden">
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${colors[finding.status]}`}>{finding.status}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-gray-800">{humanSettingLabel(finding.settingId)}</span>
          <span title={finding.settingId} className="block truncate font-mono text-[11px] leading-4 text-gray-400">{finding.settingId}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-gray-400 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="mt-3 grid gap-x-6 gap-y-4 pb-2 lg:grid-cols-2">
        <div><p className="mb-1.5 text-xs font-semibold text-gray-600">Recommended configuration</p><ul className="space-y-1 border-l-2 border-gray-200 pl-3 text-xs leading-5 text-gray-700">{recommendedLines.map((line, index) => <li key={index} className="whitespace-pre-wrap break-words">{line}</li>)}</ul></div>
        <div><p className="mb-1.5 text-xs font-semibold text-gray-600">Observed policies and configuration</p>{groups.length ? <div className="divide-y divide-gray-100">{groups.map(group => <div key={group.key} className="py-2 text-xs first:pt-0 last:pb-0"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 truncate font-medium text-gray-800" title={group.policyNames.join(", ")}>{group.policyNames.join(", ")}</span>{group.observations.length > 1 && <span className="text-gray-500">{group.observations.length} policies with this value</span>}<span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${group.matchesRecommended ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>{group.matchesRecommended ? "Matches recommended" : "Differs"}</span></div><ul className="mt-1.5 space-y-0.5 leading-5 text-gray-700">{summarizeSetting(group.value).map((line, index) => <li key={index} className="whitespace-pre-wrap break-words">{line}</li>)}</ul><p className="mt-1 text-gray-500">{targetingText(group.observations[0]!)}</p></div>)}</div> : <p className="text-xs leading-5 text-gray-600">No matching root setting found in the assessed policy family.</p>}</div>
      </div>
      <details className="mt-3"><summary className="cursor-pointer text-xs font-medium text-gray-600">Raw Graph values</summary><div className="mt-3 grid gap-3 xl:grid-cols-2"><div><p className="mb-2 text-xs font-semibold text-gray-600">Recommended configuration</p><pre className="max-h-72 overflow-auto rounded-2xl bg-gray-50 p-3 text-xs">{JSON.stringify(finding.recommended, null, 2)}</pre></div><div><p className="mb-2 text-xs font-semibold text-gray-600">Observed policies and configuration</p><pre className="max-h-72 overflow-auto rounded-2xl bg-gray-50 p-3 text-xs">{finding.observed.length ? JSON.stringify(finding.observed, null, 2) : "No matching root setting found in the assessed policy family."}</pre></div></div></details>
      
    </details>
  </div>
}

function FindingRow({ finding, checked, disabled, onChange, remediable = false }: { finding: Finding; checked: boolean; disabled: boolean; onChange: () => void; remediable?: boolean }) {
  const colors = { Present: "bg-green-50 text-green-800", Missing: "bg-amber-50 text-amber-900", Different: "bg-red-50 text-red-800", Review: "bg-gray-100 text-gray-700" }
  const recommendedLines = summarizeSetting(finding.recommended)
  return <div className="flex items-start gap-3 rounded-2xl bg-gray-50 p-4">
    <input type="checkbox" aria-label={`Select missing setting ${finding.settingId} from ${finding.policyName}`} checked={checked} disabled={disabled || (finding.status !== "Missing" && !(remediable && finding.status === "Different"))} onChange={onChange} className="mt-1 h-4 min-h-0 w-4 shrink-0" />
    <details className="min-w-0 flex-1"><summary className="cursor-pointer text-sm"><span className="font-medium text-gray-800">{finding.policyName}</span><span className={`ml-2 inline-block rounded-full px-2.5 py-0.5 text-xs ${colors[finding.status]}`}>Configuration: {finding.status}</span><span className="mt-1 block break-all font-mono text-xs leading-5 text-gray-500">{finding.settingId}</span></summary><div className="mt-3 grid gap-3 xl:grid-cols-2"><div><p className="mb-2 text-xs font-semibold text-gray-600">Recommended configuration</p><ul className="space-y-1 rounded-2xl bg-white p-3 text-xs leading-5 text-gray-700">{recommendedLines.map((line, index) => <li key={index} className="whitespace-pre-wrap break-words">{line}</li>)}</ul></div><div><p className="mb-2 text-xs font-semibold text-gray-600">Observed policies and configuration</p>{finding.observed.length ? <div className="space-y-3">{finding.observed.map((observation, observationIndex) => { const matches = rootMatches(finding.recommended, observation.value); return <div key={`${observation.policyId}:${observationIndex}`} className="rounded-2xl bg-white p-3 text-xs"><div className="flex flex-wrap items-center gap-2"><span className="font-medium text-gray-800">{observation.policyName}</span><span className={`inline-block rounded-full px-2.5 py-0.5 text-xs ${matches ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>{matches ? "Matches recommended" : "Differs"}</span></div><ul className="mt-2 space-y-1 leading-5 text-gray-700">{summarizeSetting(observation.value).map((line, index) => <li key={index} className="whitespace-pre-wrap break-words">{line}</li>)}</ul><p className="mt-2 text-gray-500">{targetingText(observation)}</p></div> })}</div> : <p className="rounded-2xl bg-white p-3 text-xs text-gray-700">No matching root setting found in the assessed policy family.</p>}</div></div><details className="mt-3"><summary className="cursor-pointer text-xs font-medium text-gray-600">Raw Graph values</summary><div className="mt-3 grid gap-3 xl:grid-cols-2"><div><p className="mb-2 text-xs font-semibold text-gray-600">Recommended configuration</p><pre className="max-h-72 overflow-auto rounded-2xl bg-white p-3 text-xs">{JSON.stringify(finding.recommended, null, 2)}</pre></div><div><p className="mb-2 text-xs font-semibold text-gray-600">Observed policies and configuration</p><pre className="max-h-72 overflow-auto rounded-2xl bg-white p-3 text-xs">{finding.observed.length ? JSON.stringify(finding.observed, null, 2) : "No matching root setting found in the assessed policy family."}</pre></div></div></details></details>
  </div>
}
