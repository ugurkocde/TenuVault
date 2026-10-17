import { packCoverage, UNSUPPORTED } from "../../shared/frameworks/coverage"
import type { FrameworkWorkspace, WorkspaceView } from "../../main/frameworks/workspaces"
import { isHistoryFullError, isWorkspaceUnreadableError, KEEP_NEWEST_ASSESSMENTS } from "../../shared/frameworks/workspace-history"
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { ArrowRight, Check, ChevronDown, Download, ExternalLink, Info } from "lucide-react"
import { useSelectedTenant, useTenants } from "~/contexts/TenantContext"
import { cn } from "~/lib/utils"
import { NCSC_COMMIT, NCSC_REPOSITORY, type Framework } from "../../shared/frameworks/catalog"
import { CIS_BENCHMARKS_ID, effectiveFrameworks, internalKitImportEnabled, searchEffectiveFrameworks } from "../../shared/frameworks/cis-internal"
import { convertKit, readKitZip, suggestedKitBenchmark, type KitConversion, type KitFile, type KitLevel } from "../../shared/frameworks/cis-kit"
import { parseDenominatorList, type DenominatorEntry } from "../../shared/frameworks/cis-coverage"
import { coverageStatement, distinctExclusions, excludedFindingKeys, exceptionsByHeadline, exclusionsText, formatRate, headlineBasisNote, headlineLabel, levelCheckSummary, levelHeadline, listedExceptions, readinessFor, unassignedText } from "../../shared/frameworks/cis-readiness"
import { recommendationLabel, recommendationsForFinding, recommendationTotals, type PackRecommendation, type RecommendationResult } from "../../shared/frameworks/cis-recommendations"
import { filterManualItems, recommendationResultView, type RecommendationResultFilter } from "../../shared/frameworks/recommendation-filter"
import { exceptionKey, isActive, localDate } from "../../shared/frameworks/cis-exceptions"
import { benchmarkTitle, cisExportFileName, deviatingFindingKeys, isSelectableFinding, knownSettingName, packBenchmarkName, referenceDisplayName, groupFindingsByPolicy, groupObservationsByValue, policyDisplayName, settingDisplayName, statusMixText, trendSummaryText } from "../../shared/frameworks/cis-display"
import { cisFlowSteps, cisStage, isKitPackReference, kitLevelForPolicy, packSettingCount } from "../../shared/frameworks/cis-flow"
import { cisDriftSignals, cisReadinessTrend, exclusionUse, sparklineSegments, trendChangeText, trendExclusionsText, trendGroups, trendRate, type CisTrendPoint } from "../../shared/frameworks/cis-trend"
import { cisPortfolioRows, portfolioBenchmarks, portfolioMembers, portfolioRate, type CisPortfolioEntry } from "../../shared/frameworks/cis-portfolio"
import { parseRecommendationList, type ManualItemView, type RecommendationList } from "../../shared/frameworks/cis-manual"
import { cisReadinessCsv, cisReadinessJson } from "../features/shared/governance-export"
import { Notice, saveFile, useSaveNotice } from "../components/oib/notices"
import { cachedCisSettingNames, loadCisSettingNames, settingDefinitionIdsIn } from "../lib/cis-setting-names"
import type { SettingNames } from "../../shared/intune/drift"
import { accumulateCisFindings, CIS_OPEN_PARAMS, cisOpenRequest, cisRunDisplayPhase, cisRunHeading, cisRunReceivedLabel, cisRunSteps, cisRunTallies, currentSavedAssessment, emptyCisRunAccumulation, pollCisStatus, resolveCisRunCompletion, type CisRunPack } from "../../shared/frameworks/cis-run"
import { refreshInternalCisBenchmarks, useInternalCisBenchmarks, useInternalCisBenchmarksAnswer } from "../lib/internal-cis"
import { bridge } from "../lib/bridge"
import { startBackgroundTask, useBackgroundTask } from "../lib/background-tasks"
import { refreshCisJobs } from "../lib/cis-jobs"
import { cachedCisCatalog, rememberCisCatalog } from "../lib/cis-catalog-cache"
import { parsePolicies, remediationPayload, rootMatches, type Assessment, type BaselinePolicy, type Finding, type Observation } from "../../shared/frameworks/policies"
import { summarizeSetting } from "../../shared/frameworks/setting-summary"
import { CIS_FRAMEWORKS, type Plan } from "../../shared/plans"
import type { AssessJobSnapshot, ExportFile } from "../../main/frameworks/service"
import type { NcscPack } from "../../main/frameworks/ncsc"
import { tenantLicense, tenantPlan, useLicense, useTenantPlan } from "../lib/license"
import { CisRemediationPanel } from "../features/cis-remediation/CisRemediationPanel"
import { CisRemediationHistory } from "../features/cis-remediation/CisRemediationHistory"
import { GatedButton } from "../components/PlanGate"
import { FilterChips, FilterSelect, SearchInput } from "../components/FilterControls"
import { filterFindings, findingLevels, findingSearchText, hiddenSelectedKeys, NO_FINDING_FILTER, type FindingFilter } from "../../shared/frameworks/finding-filter"
import { useConfirm } from "~/components/ConfirmDialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import type { CisBenchmark, CisCatalog } from "../../shared/frameworks/cis-content"

const button = "inline-flex h-10 items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-5 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
const primary = cn(button, "border-transparent bg-primary text-primary-foreground hover:bg-primary/90")
const NativeFrameworkPage = lazy(() => import('./NativeFrameworkPage'))
/** The part of the CIS page an action belongs to: loading a benchmark, comparing, or exporting results. */
/**
 * The run a background pack comparison produced, kept per tenant and framework for this window
 * session. The activity panel entry is temporary, so the page reads this marker on open to show
 * that exact result even when the admin returns long after the panel entry is gone.
 */
const compareMarkerKey = (tenantId: string, frameworkId: string) => `bg-compare:${tenantId.toLowerCase()}:${frameworkId}`
function rememberBackgroundCompare(tenantId: string, frameworkId: string, runId: string): void {
  try { sessionStorage.setItem(compareMarkerKey(tenantId, frameworkId), runId) } catch { /* storage unavailable */ }
}
function peekBackgroundCompare(tenantId: string | undefined, frameworkId: string): string | null {
  if (!tenantId) return null
  try { return sessionStorage.getItem(compareMarkerKey(tenantId, frameworkId)) } catch { return null }
}
/** Clears the marker once its run is on screen; a newer run's marker is left alone. */
function clearBackgroundCompare(tenantId: string | undefined, frameworkId: string, runId: string): void {
  if (!tenantId) return
  try {
    const key = compareMarkerKey(tenantId, frameworkId)
    if (sessionStorage.getItem(key) === runId) sessionStorage.removeItem(key)
  } catch { /* storage unavailable */ }
}

type ActionArea = "load" | "compare" | "export"
/** Where a CIS export was started: the results header, the saved assessments block, the full history alert or the pack coverage button. */
type ExportOrigin = "header" | "saved" | "alert" | "coverage"

async function request<T>(body: unknown): Promise<T> {
  const response = await fetch("/api/frameworks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const result = await response.json() as T & { error?: string }
  if (!response.ok) throw Object.assign(new Error(result.error || `Request failed (${response.status}).`), { status: response.status })
  return result
}
/** The saved workspace and the assessment still running for it, as main reads them together. */
type OpenedWorkspace = { workspace: WorkspaceView; activeJob: { jobId: string; reference: string; policies: BaselinePolicy[] } | null }
/** A status poll is retried unless the service answered that it will not change its mind, such as a job that no longer exists. */
function retryableStatusPoll(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status !== "number" || status >= 500 || status === 408 || status === 429
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
/** The message of a failed request, without an "Error: " prefix such as String(error) adds. */
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, "")
}
function formatLocaleDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { dateStyle: "medium" })
}
function formatExpiryDate(value: string): string {
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { dateStyle: "medium" })
}
function formatLocaleDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
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
    const value = trendRate(points[index]!.levels.find(entry => entry.level === level)!)!
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
  const internalCisAnswer = useInternalCisBenchmarksAnswer()
  const { frameworkId } = useParams()
  // Once the CIS page is open, a later revocation does not swap it for the Coming soon card and
  // lose a run in progress: the main process refuses CIS requests on its own. Leaving the page ends this.
  const [cisOpen, setCisOpen] = useState(false)
  const onCis = frameworkId === CIS_BENCHMARKS_ID
  if (cisOpen !== (onCis && (internalCis || cisOpen))) setCisOpen(onCis && (internalCis || cisOpen))
  const catalog = effectiveFrameworks(internalCis || (onCis && cisOpen))
  const { selectedTenant, setSelectedTenantId } = useSelectedTenant()
  const tenants = useTenants()
  // Links from comparison notifications name the tenant the comparison ran for.
  const [params, setParams] = useSearchParams()
  const requestedTenant = params.get("tenant")?.toLowerCase()
  useEffect(() => {
    if (!requestedTenant || !tenants.length) return
    const match = tenants.find(t => t.credentials?.tenantId.toLowerCase() === requestedTenant)
    if (match && match.id !== selectedTenant?.id) setSelectedTenantId(match.id)
    // A saved run named next to the tenant stays for that tenant's CIS page, which reads it once its
    // workspace is open; without the tenant it has nothing to open.
    setParams(old => { const next = new URLSearchParams(old); next.delete("tenant"); if (!match) for (const key of CIS_OPEN_PARAMS) next.delete(key); return next }, { replace: true })
  }, [requestedTenant, tenants])
  const [query, setQuery] = useState("")
  const framework = catalog.find(f => f.id === frameworkId)
  if (frameworkId && !framework) return <div className="p-8"><h1 className="text-2xl font-semibold">Framework not found</h1><Link className="mt-4 inline-block text-blue-700" to="/portal/frameworks">Browse frameworks</Link></div>
  // Right after a reload the CIS gate has not answered yet: wait for it instead of showing Coming soon.
  if (framework?.disabledReason && onCis && internalCisAnswer !== "answered") return <div role="status" className="p-8 text-sm text-gray-500">
    {internalCisAnswer === "failed" ? <>CIS Benchmarks access could not be checked. <button type="button" className="font-medium text-blue-700 hover:underline" onClick={() => void refreshInternalCisBenchmarks()}>Retry</button></> : "Checking access…"}
  </div>
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
      <SearchInput label="Search framework catalog" value={query} onChange={setQuery} placeholder="Search name, publisher, or type…" />
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

function CisPortfolio({ plan, selectedTenantId }: { plan: Plan | null; selectedTenantId?: string }) {
  const tenants = useTenants()
  const { status } = useLicense()
  const [entries, setEntries] = useState<CisPortfolioEntry[] | null>(null)
  const [benchmarkChoice, setBenchmarkChoice] = useState("")
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
  // Customer tenants on MSP, and the selected tenant itself whenever its own plan includes CIS.
  const members = portfolioMembers(signedIn.map(candidate => candidate.credentials!.tenantId!), tenantId => tenantPlan(tenantLicense(status, tenantId)), selectedTenantId)
  const included = signedIn.filter(candidate => members.included.includes(candidate.credentials!.tenantId!))
  const notIncluded = signedIn.filter(candidate => !members.included.includes(candidate.credentials!.tenantId!))
  const portfolioPlan = members.plan ?? plan
  const benchmarks = useMemo(() => entries ? portfolioBenchmarks(entries) : [], [entries])
  const chosen = benchmarks.find(item => JSON.stringify([item.benchmark, item.version]) === benchmarkChoice) ?? benchmarks[0] ?? null
  const rows = useMemo(() => entries ? cisPortfolioRows(entries, chosen) : null, [entries, chosen])
  const tenantSignature = tenants.map(candidate => `${candidate.credentials?.tenantId?.toLowerCase() ?? ""}:${candidate.name}`).join("|")
  useEffect(() => {
    generation.current += 1
    setEntries(null)
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
      setEntries(entries)
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
        <p className="mt-1 text-sm text-gray-500">Tenants compared on one benchmark and version, ranked by the raw headline rate of each tenant's newest saved assessment of each Level, as the CIS page shows it. Tenants with no saved assessment of it are shown as not assessed.</p>
      </div>
      <GatedButton feature="portfolio" plan={portfolioPlan} variant="outline" size="sm" disabled={busy || !included.length} onClick={() => void load()}>{busy ? "Loading" : rows ? "Refresh portfolio" : "Load portfolio"}</GatedButton>
    </div>
    {benchmarks.length > 1 && <div className="mt-3"><FilterSelect label="Compare tenants on benchmark" value={chosen ? JSON.stringify([chosen.benchmark, chosen.version]) : ""} onChange={setBenchmarkChoice} options={benchmarks.map(item => ({ value: JSON.stringify([item.benchmark, item.version]), label: `${benchmarkTitle(item.benchmark, item.benchmarkName)} ${item.version}` }))} /></div>}
    {benchmarks.length === 1 && chosen && <p className="mt-3 text-sm text-gray-700">Benchmark: {benchmarkTitle(chosen.benchmark, chosen.benchmarkName)} {chosen.version}</p>}
    {notIncluded.length > 0 && <p className="mt-3 text-xs text-gray-500">Not included (no MSP license, or not the selected tenant on a plan with CIS): {notIncluded.map(candidate => candidate.name).join(", ")}. These tenants are not loaded.</p>}
    {notSignedIn.length > 0 && <p className="mt-3 text-xs text-gray-500">Not signed in: {notSignedIn.map(candidate => candidate.name).join(", ")}. These tenants are not loaded.</p>}
    {!signedIn.length && <p className="mt-3 text-sm text-gray-500">No connected tenant is signed in.</p>}
    {loadError && <p role="alert" className="mt-3 text-sm text-red-700">{loadError}</p>}
    {rows && <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm">
      <thead className="text-xs text-gray-500"><tr><th scope="col" className="py-2 pr-4 font-medium">Tenant</th><th scope="col" className="py-2 pr-4 font-medium">Benchmark</th><th scope="col" className="py-2 pr-4 font-medium">Assessed</th><th scope="col" className="py-2 pr-4 font-medium">Level 1</th><th scope="col" className="py-2 pr-4 font-medium">Level 2</th><th scope="col" className="py-2 pr-4 font-medium">Assessed settings (Level 1 / Level 2)</th><th scope="col" className="py-2 font-medium">Excluded</th></tr></thead>
      <tbody className="divide-y divide-gray-100">{rows.map(row => {
        const level1 = row.levels.find(level => level.level === 1)
        const level2 = row.levels.find(level => level.level === 2)
        const rate = (level: typeof level1) => level ? <>{formatRate(portfolioRate(level))}<span className="block text-xs font-normal text-gray-500">{level.headline.label}</span>{exclusionsText(level.headline) && <span className="block text-xs font-normal text-gray-700">{exclusionsText(level.headline)}</span>}{formatLocaleDateTime(level.assessedAt) !== formatLocaleDateTime(row.assessedAt!) && <span className="block text-xs font-normal text-gray-500">Assessed {formatLocaleDateTime(level.assessedAt)}</span>}</> : "Not available"
        const excepted = distinctExclusions(row.levels.map(level => level.headline))
        return <tr key={row.tenantId}>
          <td className="py-2 pr-4 text-gray-800">{row.tenantName ?? row.tenantId}</td>
          {row.error ? <td colSpan={6} className="py-2 text-gray-500">{row.error}</td> : row.assessedAt === null ? <td colSpan={6} className="py-2 text-gray-500">{row.otherBenchmark ? "Not assessed on this benchmark" : "Not assessed"}</td> : <>
            <td className="py-2 pr-4 text-gray-700">{row.benchmarkName ?? row.benchmark}{row.version ? <span className="block text-xs text-gray-500">{row.version}</span> : null}</td>
            <td className="py-2 pr-4 text-gray-700">{formatLocaleDateTime(row.assessedAt)}</td>
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

function CisRunView({ run, rerun = false, policies, reference, names }: { run: AssessJobSnapshot; rerun?: boolean; policies: BaselinePolicy[]; reference: string; names: SettingNames }) {
  const phase = cisRunDisplayPhase(run)
  const steps = cisRunSteps(phase)
  const tallies = cisRunTallies(run.findings)
  const running = phase !== "done" && phase !== "failed"
  return <div className="mt-5 rounded-3xl bg-gray-50 p-6">
    <div role="status">
      <h3 className="text-lg font-medium text-gray-900">{cisRunHeading(phase, rerun)}</h3>
      {rerun && <p className="mt-1 text-sm text-gray-600">The previous results stay below until the new results are ready.</p>}
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
    {/* Partial results read like the final ones: grouped by pack policy, by setting name, nothing to select yet. */}
    {!rerun && run.findings.length > 0 && <div aria-label="Partial results" className="mt-3 rounded-2xl bg-white px-4">{groupFindingsByPolicy(run.findings).map(group => <section key={group.policyIndex} aria-label={group.policyName} className="border-t border-gray-100 py-3 first:border-t-0">
      <h4 title={group.policyName} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm"><span className="min-w-0 truncate font-medium text-gray-900">{policyDisplayName(group.policyName, reference)}</span><span className="text-xs text-gray-500">{statusMixText(group.counts)}</span></h4>
      <div className="mt-1 divide-y divide-gray-100">{group.findings.map(finding => <CisFindingRow key={finding.key} finding={finding} recommendations={recommendationsForFinding(policies, finding)} names={names} selectable={false} checked={false} disabled onChange={() => undefined} />)}</div>
    </section>)}</div>}
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
  // A link can name the benchmark, version and Level to open on, such as a Governance CIS card.
  const [searchParams, setSearchParams] = useSearchParams()
  // A request for another tenant waits until that tenant is selected and its page mounts.
  const [openRequest] = useState(() => {
    const forTenant = searchParams.get("tenant")?.toLowerCase()
    return framework.id === CIS_BENCHMARKS_ID && (!forTenant || forTenant === selectedTenant?.credentials?.tenantId?.toLowerCase()) ? cisOpenRequest(searchParams) : null
  })
  const [openNote, setOpenNote] = useState("")
  // An assessment that was running when a requested saved run opened: shown as a notice, followed only on request.
  const [pendingJob, setPendingJob] = useState<OpenedWorkspace["activeJob"]>(null)
  const [policies, setPolicies] = useState<BaselinePolicy[]>([])
  const [reference, setReference] = useState("")
  const [assessment, setAssessment] = useState<Assessment | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [filter, setFilter] = useState("All")
  const [findingFilter, setFindingFilter] = useState<FindingFilter>(NO_FINDING_FILTER)
  const [page, setPage] = useState(0)
  const [preview, setPreview] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [creation, setCreation] = useState<{ success: boolean; results: { name: string; id?: string; error?: string }[] } | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null)
  const [unreadable, setUnreadable] = useState(false)
  const [historyNotice, setHistoryNotice] = useState("")
  const [activeLookupFailed, setActiveLookupFailed] = useState(false)
  // Until the saved workspace has loaded, the CIS page does not know whether it has results to show.
  const [workspaceLoading, setWorkspaceLoading] = useState(() => !!selectedTenant?.credentials?.tenantId)
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
  const [cisCatalog, setCisCatalog] = useState<CisBenchmark[] | null>(() => framework.id === CIS_BENCHMARKS_ID ? cachedCisCatalog(selectedTenant?.credentials?.tenantId) : null)
  const [cisCatalogMessage, setCisCatalogMessage] = useState("")
  const [cisCatalogLoading, setCisCatalogLoading] = useState(false)
  const catalogGeneration = useRef(0)
  // Where the running action and its error show: next to the step that started them.
  const [busyAt, setBusyAt] = useState<ActionArea>("compare")
  const [errorAt, setErrorAt] = useState<ActionArea>("compare")
  const [packRetry, setPackRetry] = useState<{ benchmark: CisBenchmark; level: 1 | 2 } | null>(null)
  const [setupRequested, setSetupRequested] = useState(false)
  const [remediationFocus, setRemediationFocus] = useState<{ id: string; at: number } | null>(null)
  // When a remediation or rollback was last applied: results assessed before it are out of date.
  const [appliedAt, setAppliedAt] = useState<string | null>(null)
  const [settingNames, setSettingNames] = useState<SettingNames>(() => cachedCisSettingNames())
  const [savedOpen, setSavedOpen] = useState(false)
  const [scrollTarget, setScrollTarget] = useState<{ target: "results" | "exclusions" | "saved"; at: number } | null>(null)
  const resultsHeader = useRef<HTMLDivElement>(null)
  const exclusionsPanel = useRef<HTMLDetailsElement>(null)
  const savedPanel = useRef<HTMLDetailsElement>(null)
  const exportNotice = useSaveNotice()
  const cisRunGeneration = useRef(0)
  const isCis = framework.id === CIS_BENCHMARKS_ID
  const outOfDate = !!appliedAt && !!assessment && Date.parse(assessment.assessedAt) < Date.parse(appliedAt)
  const stage = isCis ? (workspaceLoading ? "loading" : cisStage({ hasRun: !!cisRun, hasAssessment: !!assessment, setupRequested })) : null
  const fromKit = isCis && isKitPackReference(reference, (kitConversion?.packs ?? []).map(pack => pack.reference), policies)
  const credentials = selectedTenant?.credentials
  // A pack comparison outside CIS reads the tenant in one request; it runs as a background
  // task so it finishes, and is saved to the workspace, even after navigating away.
  const compareKey = credentials?.tenantId ? `assess:${credentials.tenantId.toLowerCase()}:${framework.id}` : undefined
  const compareTask = useBackgroundTask(isCis ? undefined : compareKey)
  const comparing = compareTask?.status === "running"
  // Reports of licensed CIS content are Pro and MSP; the main process checks the same plan.
  const plan = useTenantPlan(credentials?.tenantId)
  const { confirm, confirmDialog } = useConfirm()
  // CIS exports open the Save dialog like the Governance exports; the notice shows next to the button used.
  const [exportOrigin, setExportOrigin] = useState<ExportOrigin>("header")
  const saveCisFile = (data: string, name: string, encoding: "utf8" | "base64" = "utf8") => exportNotice.save(() => saveFile(data, name, encoding))
  /** A CIS export the main process builds and saves through the Save dialog itself, whatever its size; a failure shows as the page error. */
  const saveInMain = async (body: Record<string, unknown>) => {
    const outcome = await request<{ name: string; saved: boolean; path?: string }>({ ...body, save: "dialog" })
    await exportNotice.save(() => outcome.saved ? { saved: true, fileName: outcome.path?.split(/[\\/]/).pop() ?? outcome.name, ...(outcome.path ? { path: outcome.path } : {}) } : { saved: false, fileName: outcome.name })
  }
  /** The status, error and saved file of a CIS export, shown next to the buttons that started it. */
  const exportStatus = (origin: ExportOrigin) => isCis && exportOrigin === origin && <>
    {busy && busyAt === "export" && <p role="status" className="w-full text-sm text-blue-700">{busy}</p>}
    {error && errorAt === "export" && <p role="alert" className="w-full rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
    <Notice result={exportNotice.result} onDismiss={exportNotice.clear} className="w-full" />
  </>
  const exportSaved = (format: "pdf" | "csv" | "json", runId?: string, origin: ExportOrigin = "header") => {
    if (isCis) setExportOrigin(origin)
    void perform(`Exporting ${format.toUpperCase()}…`, async () => {
      const body = { action: `workspace-${format}`, tenantId: credentials?.tenantId, tenantName: selectedTenant?.name, frameworkId: framework.id, ...(runId ? { runId } : {}) }
      if (isCis) await saveInMain(body)
      else saveExport((await request<{ file: ExportFile }>(body)).file)
    }, isCis ? "export" : "compare")
  }
  const workspaceQueue = useRef<Promise<unknown>>(Promise.resolve())
  const suppressedDraft = useRef<string | null>(null)
  const workspaceRequest = <T = WorkspaceView,>(action: string, extra: object = {}) => {
    const task = workspaceQueue.current.catch(() => undefined).then(() => request<T>({ action, tenantId: credentials?.tenantId, frameworkId: framework.id, ...extra }))
    workspaceQueue.current = task
    return task
  }
  const shownAssessment = useRef<Assessment | null>(null)
  useEffect(() => { shownAssessment.current = assessment }, [assessment])
  const appliedCompareFinish = useRef<number | undefined>(undefined)
  useEffect(() => {
    const finishedAt = compareTask?.finishedAt
    if (isCis || compareTask?.status !== "completed" || !finishedAt) return
    if (appliedCompareFinish.current === finishedAt) return
    // A comparison started before this mount finished into setters that no longer exist, so
    // show its saved run from the workspace it was recorded in. The marker and the applied
    // stamp are only settled once that run is on screen, so leaving mid-load or a failed
    // read keeps the result restorable on the next open.
    let active = true
    void workspaceRequest("workspace-load").then((saved) => {
      if (!active) return
      setWorkspace(saved)
      const markerRunId = peekBackgroundCompare(credentials?.tenantId, framework.id)
      const marked = markerRunId ? saved.history.find((entry) => entry.assessment.runId === markerRunId) : undefined
      const latest = currentSavedAssessment(saved)
      const target = marked ? { assessment: marked.assessment, policies: marked.policies } : latest
      if (!target) return
      if (shownAssessment.current?.runId !== target.assessment.runId) showSavedResults(target.assessment, { policies: target.policies, reference: target.assessment.reference })
      appliedCompareFinish.current = finishedAt
      if (markerRunId) clearBackgroundCompare(credentials?.tenantId, framework.id, markerRunId)
    }).catch(() => undefined)
    return () => { active = false }
  }, [isCis, compareTask?.status, compareTask?.finishedAt, credentials?.tenantId, framework.id])
  /**
   * Shows a saved assessment as read-only results with its pack, and clears any selection made on
   * other results. It never replaces newer results already on screen, such as a fresh run.
   */
  function showSavedResults(saved: Assessment, pack: CisRunPack) {
    const shown = shownAssessment.current
    if (shown && (shown.runId === saved.runId || Date.parse(shown.assessedAt) >= Date.parse(saved.assessedAt))) return
    setPolicies(pack.policies); setReference(pack.reference)
    setAssessment(saved); setHistorical(true); setSelected(new Set()); setPreview(false); setConfirmed(false); setCreation(null); setPage(0)
  }
  /**
   * Opens the saved workspace. On the CIS page main answers with the workspace and the assessment
   * still running for it in one consistent call, retried like a status poll. The newest saved
   * assessment shows as read-only results, so nothing is selected, excluded or remediated from
   * older evidence, and a running assessment is followed with its own pack. When the call still
   * fails, the workspace is loaded on its own and a notice offers to check again.
   */
  async function openWorkspace(mounted: () => boolean, first: boolean) {
    // A run started or followed after this request was sent makes the whole answer stale: its
    // workspace and running job must not replace that run's progress or newer results. A tenant
    // change mounts a new page, which `mounted` covers.
    const runGeneration = cisRunGeneration.current
    const current = () => mounted() && cisRunGeneration.current === runGeneration
    let opened: OpenedWorkspace
    let lookupFailed = false
    if (isCis) {
      try { opened = await pollCisStatus(() => workspaceRequest<OpenedWorkspace>("workspace-open"), { retryable: retryableStatusPoll, current }) }
      catch (e) {
        if (!current()) return
        if (isWorkspaceUnreadableError(e instanceof Error ? e.message : String(e))) throw e
        lookupFailed = true
        // A failure of this fallback read is just as stale once a newer run started.
        try { opened = { workspace: await workspaceRequest("workspace-load"), activeJob: null } }
        catch (fallback) { if (!current()) return; throw fallback }
      }
    } else opened = { workspace: await workspaceRequest("workspace-load"), activeJob: null }
    if (!current()) return
    const saved = opened.workspace
    setWorkspace(saved)
    if (first) { setPolicies(saved.policies); setReference(saved.reference); setRecommendationList(saved.recommendationList) }
    if (!isCis) {
      // A comparison that finished in the background while this page was closed opens on its result.
      const backgroundRunId = first ? peekBackgroundCompare(credentials?.tenantId, framework.id) : null
      const backgroundRun = backgroundRunId ? saved.history.find((entry) => entry.assessment.runId === backgroundRunId) : undefined
      if (backgroundRun) {
        showSavedResults(backgroundRun.assessment, { policies: backgroundRun.policies, reference: backgroundRun.assessment.reference })
        clearBackgroundCompare(credentials?.tenantId, framework.id, backgroundRunId!)
      } else if (backgroundRunId) clearBackgroundCompare(credentials?.tenantId, framework.id, backgroundRunId)
      return
    }
    setActiveLookupFailed(lookupFailed)
    const latest = currentSavedAssessment(saved)
    // A requested saved run opens read-only, the exact run the link named; when it is gone the page
    // opens as it otherwise would and says so. A later check for a running assessment keeps it.
    const requested = openRequest ? saved.history.find(entry => entry.assessment.runId === openRequest.runId) ?? null : null
    if (first && openRequest) {
      if (!requested) setOpenNote(`The saved assessment${openRequest.benchmark ? ` of ${benchmarkTitle(openRequest.benchmark)}${openRequest.version ? ` ${openRequest.version}` : ""}${openRequest.level ? ` Level ${openRequest.level}` : ""}` : ""} was not found, so ${latest ? "the newest saved assessment is shown" : "the page opens on setup"}.`)
      setSearchParams(old => { const next = new URLSearchParams(old); for (const key of CIS_OPEN_PARAMS) next.delete(key); return next }, { replace: true })
    }
    if (requested) showSavedResults(requested.assessment, { policies: requested.policies, reference: requested.assessment.reference })
    else if (latest) showSavedResults(latest.assessment, { policies: saved.policies, reference: saved.reference })
    const job = opened.activeJob
    // A running assessment replaces the shown results when it finishes, so it is only followed
    // at once when no saved run was requested; otherwise a notice offers to view its progress.
    if (job && requested) setPendingJob(job)
    else if (job) void trackCisJob({ policies: job.policies, reference: job.reference }, async () => job.jobId)
  }
  function showOpenError(e: unknown) {
    const message = errorText(e)
    if (isWorkspaceUnreadableError(message)) setUnreadable(true)
    else { setError(message); setErrorAt("compare") }
  }
  useEffect(() => {
    if (!credentials?.tenantId) return
    let active = true
    void openWorkspace(() => active, true).catch(e => { if (active) showOpenError(e) }).finally(() => { if (active) setWorkspaceLoading(false) })
    return () => { active = false }
  }, [credentials?.tenantId, framework.id])
  function retryActiveLookup() {
    if (!credentials?.tenantId || cisRun) return
    setActiveLookupFailed(false)
    void openWorkspace(() => true, false).catch(showOpenError)
  }
  useEffect(() => {
    if (!workspace || historical || JSON.stringify({ policies, reference }) === suppressedDraft.current) return
    suppressedDraft.current = null
    let active = true
    void workspaceRequest("workspace-save", { policies, reference }).then(saved => { if (active) setWorkspace(saved) }).catch(e => { if (active) { setError(`Workspace was not saved: ${errorText(e)}`); setErrorAt("compare") } })
    return () => { active = false }
  }, [policies, reference, !!workspace, historical])
  const chosen = assessment?.findings.filter(f => selected.has(f.key)) ?? []
  const payloads = [...new Set(chosen.map(f => f.policyIndex))].map(index => remediationPayload(policies[index]!, chosen.filter(f => f.policyIndex === index).map(f => policies[index]!.settings[f.settingIndex]!), reference))
  function reset() { setOpenNote(""); setHistorical(false); setAssessment(null); setSelected(new Set()); setPreview(false); setConfirmed(false); setCreation(null); setPage(0) }
  /** Runs one page action; its status and any error show in `area`, next to the control that started it. */
  async function perform(label: string, action: () => Promise<void>, area: ActionArea = "compare") {
    setBusy(label); setBusyAt(area); setError(""); setErrorAt(area)
    try { await action() } catch (e) { const message = (e instanceof Error && errorText(e)) || "The request failed."; setError(message); if (isWorkspaceUnreadableError(message)) setUnreadable(true); refreshFullHistory(message) } finally { setBusy("") }
  }
  /** After a save was refused for a full history, reload the workspace so the alert shows the current count. */
  function refreshFullHistory(message: string, current: () => boolean = () => true) {
    if (!isHistoryFullError(message)) return
    void workspaceRequest("workspace-load").then(saved => { if (current()) setWorkspace(saved) }).catch(() => undefined)
  }
  useEffect(() => () => { cisRunGeneration.current += 1 }, [])
  // A full history blocks new assessments: the main process reports it on load and refuses to save more.
  const historyAlertId = useId()
  const historyCount = workspace?.history.length ?? 0
  const historyFull = !!workspace?.capacity?.full || isHistoryFullError(error)
  const removableHistory = Math.max(historyCount - KEEP_NEWEST_ASSESSMENTS, 0)
  const historyBlocked = historyFull ? { title: "Saved assessment history is full. Remove older assessments first.", "aria-describedby": historyAlertId } : undefined
  async function removeOlderAssessments() {
    if (!workspace || removableHistory <= 0 || busy) return
    const removing = removableHistory
    const noun = removing === 1 ? "assessment" : "assessments"
    if (!(await confirm({ title: "Remove older assessments?", description: `This keeps the newest ${KEEP_NEWEST_ASSESSMENTS} saved assessments and removes ${removing} older ${noun}. Removed assessments cannot be restored. Export saved assessments first if you need them.`, confirmLabel: `Remove ${removing} ${noun}`, destructive: true }))) return
    void perform("Removing older assessments…", async () => {
      const saved = await workspaceRequest("workspace-prune-history", { keep: KEEP_NEWEST_ASSESSMENTS })
      setWorkspace(saved)
      if (assessment && !saved.history.some(entry => entry.assessment.runId === assessment.runId)) { setPolicies(saved.policies); setReference(saved.reference); reset() }
    })
  }
  function startCisAssessment() {
    if (!isCis || cisRun || !credentials) return
    const tenantId = credentials.tenantId
    const appId = credentials.appId
    const capturedPack: CisRunPack = { policies, reference }
    void trackCisJob(capturedPack, async () => (await request<{ jobId: string }>({ action: "assess-start", tenantId, appId, frameworkId: framework.id, reference: capturedPack.reference, policies: capturedPack.policies })).jobId)
  }
  /**
   * Follows one assessment job until it finishes. A re-run leaves the shown results in place
   * until the new ones arrive, and a failed run leaves them unchanged.
   */
  async function trackCisJob(capturedPack: CisRunPack, jobFor: () => Promise<string>) {
    if (!isCis || !credentials) return
    const generation = ++cisRunGeneration.current
    const current = () => cisRunGeneration.current === generation
    const tenantId = credentials.tenantId
    // Starting or following a run answers the question a failed running-assessment check left open.
    setError(""); setErrorAt("compare"); setHistoryNotice(""); setActiveLookupFailed(false); setOpenNote(""); setPendingJob(null)
    setBusy("Reading tenant policies and comparing settings…"); setBusyAt("compare")
    setCisRun({ jobId: "", phase: "connecting", status: "running", state: "running", tenantId, frameworkId: framework.id, read: 0, total: 0, currentPolicy: "", comparedPolicies: 0, packPolicies: capturedPack.policies.length, currentPackPolicy: "", findings: [], nextSince: 0, error: null, assessment: null })
    try {
      const jobId = await jobFor()
      // The activity panel mirrors this run from assess-jobs, so it stays visible on other pages.
      void refreshCisJobs()
      if (!current()) return
      let accumulation = emptyCisRunAccumulation()
      for (;;) {
        if (!current()) return
        const since = accumulation.since
        const snapshot = await pollCisStatus(() => request<AssessJobSnapshot>({ action: "assess-status", jobId, tenantId, frameworkId: framework.id, since }), { retryable: retryableStatusPoll, current })
        if (!current()) return
        accumulation = accumulateCisFindings(accumulation, snapshot.findings, snapshot.nextSince)
        if (snapshot.phase === "failed") {
          setError(snapshot.error || "Assessment failed.")
          refreshFullHistory(snapshot.error ?? "", current)
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
          setPolicies(installPack.policies); setReference(installPack.reference)
          // A re-run over shown results keeps the finding filters; a first run starts unfiltered.
          if (!shownAssessment.current) { setFilter("All"); setFindingFilter(NO_FINDING_FILTER) }
          setHistorical(false); setSelected(new Set()); setPreview(false); setConfirmed(false); setCreation(null); setPage(0)
          setSetupRequested(false)
          setAssessment(completed)
          setCisRun(null)
          // The results show at once; the saved history and trend follow in the background.
          void workspaceRequest("workspace-load").then(saved => { if (current()) setWorkspace(saved) }).catch(() => { if (current()) setHistoryNotice("The new results are saved, but the saved assessment list and trend could not be refreshed. Open the page again to update them.") })
          return
        }
        setCisRun({ ...snapshot, findings: accumulation.findings })
        await new Promise(resolve => setTimeout(resolve, 600))
      }
    } catch (e) {
      if (!current()) return
      const message = e instanceof Error ? e.message : "The request failed."
      setError(message)
      if (isWorkspaceUnreadableError(message)) setUnreadable(true)
      refreshFullHistory(message, current)
      setCisRun(null)
    } finally {
      if (current()) setBusy("")
    }
  }
  /**
   * Loads the benchmark catalog, on open and on Refresh or Retry. Cached entries stay on screen
   * while it loads and when it fails. The answer, entries and error alike, is dropped when the
   * page closed, a newer catalog load was sent or a run started after it was sent.
   */
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  async function loadCisCatalog() {
    const tenantId = credentials?.tenantId
    if (!tenantId) return
    const runGeneration = cisRunGeneration.current
    const mine = ++catalogGeneration.current
    const current = () => mountedRef.current && cisRunGeneration.current === runGeneration && catalogGeneration.current === mine
    setCisCatalogLoading(true); setCisCatalogMessage("")
    try {
      const catalog = await request<CisCatalog>({ action: "cis-catalog", tenantId, frameworkId: framework.id })
      if (!current()) return
      setCisCatalog(catalog.benchmarks)
      rememberCisCatalog(tenantId, catalog.benchmarks)
      if (!catalog.benchmarks.length) setCisCatalogMessage("No benchmarks are available from the delivery service.")
    } catch (e) {
      if (!current()) return
      setCisCatalogMessage((e instanceof Error && errorText(e)) || "The available benchmarks could not be loaded.")
    } finally { if (catalogGeneration.current === mine && mountedRef.current) setCisCatalogLoading(false) }
  }
  // The catalog loads when the page opens, so a benchmark can be chosen without a click first,
  // and again on the way back to setup when a run made the first answer stale.
  useEffect(() => { if (isCis && credentials?.tenantId) void loadCisCatalog() }, [isCis, credentials?.tenantId])
  useEffect(() => { if (stage === "setup" && !cisCatalog && !cisCatalogLoading && !cisCatalogMessage) void loadCisCatalog() }, [stage])
  // Display names of the settings and choices on screen, read once per definition; the same
  // stale-response rule as a run applies, and without names the raw values stay.
  const shownFindings = cisRun?.findings.length ? cisRun.findings : assessment?.findings
  useEffect(() => {
    if (!isCis || !credentials?.tenantId || !credentials.appId || !shownFindings?.length) return
    const runGeneration = cisRunGeneration.current
    const ids = settingDefinitionIdsIn(shownFindings.flatMap(finding => [finding.recommended, ...finding.observed.map(observation => observation.value)]))
    void loadCisSettingNames({ tenantId: credentials.tenantId, appId: credentials.appId }, ids)
      .then(read => { if (mountedRef.current && cisRunGeneration.current === runGeneration) setSettingNames(read) })
      .catch(() => undefined)
  }, [isCis, credentials?.tenantId, assessment?.runId, cisRun?.findings.length])
  // Actions that open something further down the page bring it into view.
  useEffect(() => {
    if (!scrollTarget) return
    const element = scrollTarget.target === "results" ? resultsHeader.current : scrollTarget.target === "exclusions" ? exclusionsPanel.current : savedPanel.current
    element?.scrollIntoView?.({ behavior: "smooth", block: "start" })
  }, [scrollTarget])
  const scrollTo = (target: "results" | "exclusions" | "saved") => setScrollTarget({ target, at: Date.now() })
  async function loadDeliveredPack(benchmark: CisBenchmark, level: 1 | 2) {
    setPackRetry({ benchmark, level })
    await perform("Loading benchmark pack…", async () => {
      const result = await request<{ benchmark: string; version: string; level: number; reference: string; policyCount: number; settingCount: number }>({ action: "cis-fetch-pack", tenantId: credentials?.tenantId, frameworkId: framework.id, benchmark: benchmark.id, version: benchmark.version, level })
      reset()
      setLoadedKitLevel(null)
      const saved = await workspaceRequest("workspace-load")
      setWorkspace(saved); setPolicies(saved.policies); setReference(saved.reference || result.reference)
      setPackRetry(null)
    }, "load")
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
    void workspaceRequest("workspace-save", { policies, reference, recommendationList }).then(saved => { if (active) setWorkspace(saved) }).catch(e => { if (active) { setError(`Workspace was not saved: ${errorText(e)}`); setErrorAt("compare") } })
    return () => { active = false }
  }, [recommendationList])
  // Search and level narrow the findings first; the status chips count and filter within them.
  const findingText = useMemo(() => {
    const cache = new WeakMap<Finding, string>()
    return (finding: Finding) => {
      let text = cache.get(finding)
      if (text === undefined) cache.set(finding, text = findingSearchText(finding, policies, reference))
      return text
    }
  }, [policies, reference])
  const levels = isCis && assessment ? findingLevels(assessment.findings, policies) : []
  const shownFindingFilter: FindingFilter = { ...findingFilter, level: levels.includes(findingFilter.level as KitLevel) ? findingFilter.level : 0 }
  const searching = shownFindingFilter.query.trim() !== "" || shownFindingFilter.level !== 0
  const searched = assessment ? filterFindings(assessment.findings, policies, shownFindingFilter, findingText) : []
  const findings = searched.filter(f => filter === "All" || f.status === filter)
  const deviatingKeys = deviatingFindingKeys(findings)
  // Selections hidden by the search, level or status filter still count for bulk actions, so they are named there.
  const hiddenSelected = new Set(hiddenSelectedKeys(selected, findings))
  const hiddenSelectedText = hiddenSelected.size ? `${hiddenSelected.size} hidden by the filters` : ""
  function showAllFindings() { setFilter("All"); setFindingFilter(NO_FINDING_FILTER); setPage(0) }
  const allDeviatingSelected = deviatingKeys.every(key => selected.has(key))
  function selectAllDeviating() { setSelected(old => new Set([...old, ...deviatingKeys])); setPreview(false); setConfirmed(false) }
  const exceptions = workspace?.exceptions
  // Exception dates are local dates; today is read once per render.
  const today = localDate()
  // readinessFor holds the one exclusion rule that the trend, portfolio, Governance card, exports and PDF also use.
  const readiness = useMemo(() => assessment && isCis ? readinessFor({ assessment, policies }, { history: workspace?.history ?? [], ...(recommendationList ? { recommendationList } : {}), ...(exceptions ? { exceptions } : {}) }, today, denominator) : null, [assessment, isCis, policies, denominator, recommendationList, exceptions, workspace?.history, today])
  const excludedKeys = useMemo(() => readiness && assessment ? excludedFindingKeys(readiness, assessment, policies) : new Set<string>(), [readiness, assessment, policies])
  // Identifier coverage stays for Build Kit imports and for packs without a recommendation list.
  const coverageShown = (level: { recommendations: unknown[] }) => !!kitConversion || !level.recommendations.length
  const history = workspace?.history
  const trend = useMemo(() => isCis && history ? cisReadinessTrend(history, recommendationList, exceptions, today) : [], [isCis, history, recommendationList, exceptions, today])
  const drift = cisDriftSignals(trend)
  const groups = trendGroups(trend)
  // The trend summary follows the benchmark and version of the results on screen.
  const shownGroup = groups.find(group => readiness && group.benchmark === readiness.benchmark && group.version === readiness.version) ?? groups[0]
  const trendByRun = new Map(trend.map(point => [point.runId, point]))
  // Display names of the benchmarks saved in this workspace, for exceptions of other benchmarks.
  const benchmarkNames = new Map(trend.map(point => [point.benchmark, point.benchmarkName ?? null]))
  // The current headlines of every saved benchmark that count each exclusion, named in the panel and before removal.
  const usedElsewhere = useMemo(() => new Map([...exclusionUse(trend)].map(([id, uses]) => [id, [...new Set(uses.map(use => `${benchmarkTitle(use.benchmark, use.benchmarkName)} ${use.version} Level ${use.level}`))]])), [trend])
  const listed = useMemo(() => readiness && assessment ? listedExceptions(readiness, assessment, policies, exceptions, today, usedElsewhere) : [], [readiness, assessment, policies, exceptions, today, usedElsewhere])
  /** Removes a stored exclusion; when a headline counts it, the admin confirms the effect first. */
  async function removeException(item: (typeof listed)[number]["levels"][number]["items"][number]) {
    if (historical || !readiness) return
    const here = item.usedHere.map(level => `${benchmarkTitle(readiness.benchmark, readiness.benchmarkName)} ${readiness.version} Level ${level}`)
    const uses = [...new Set([...here, ...item.usedElsewhere])]
    if (uses.length && !(await confirm({ title: "Remove exclusion?", description: `This exclusion counts toward ${uses.join(", ")}. Removing it lowers the rate with exclusions there, and the setting counts against the score again. This cannot be undone.`, confirmLabel: "Remove exclusion", destructive: true }))) return
    void perform("Removing exception...", async () => { const saved = await workspaceRequest("workspace-cis-exception-remove", { exceptionId: item.exception.id }); setWorkspace(saved) })
  }
  // Selected findings that do not already have an active exception at their level, one per exception identity:
  // policies with the same name can repeat a setting, and the server accepts one active exception per identity.
  // The server refuses a second active exception for one identity, even one the headline does not count.
  const activeIdentities = new Set((exceptions ?? []).filter(exception => isActive(exception, today)).map(exception => exceptionKey(exception.benchmark, exception.version, exception.level, exception.policyName, exception.settingId)))
  const excludable = readiness ? [...new Map(chosen.filter(finding => isSelectableFinding(finding) && !excludedKeys.has(finding.key))
    .map(finding => [exceptionKey(readiness.benchmark, readiness.version, kitLevelForPolicy(policies[finding.policyIndex]), finding.policyName, finding.settingId), finding] as const)
    .filter(([key]) => !activeIdentities.has(key))).values()] : []
  const excludeSelected = async ({ owner, reason, expiresOn }: { owner: string; reason: string; expiresOn: string }) => {
    if (!readiness || busy) return
    const form = { owner, reason, expiresOn }
    setBusy("Excluding findings from the score..."); setBusyAt("compare")
    setExclusion(old => old && { ...old, error: "" })
    // One request and one encrypted save for every selected finding; each finding reports its own result.
    const items = excludable.map(finding => ({ benchmark: readiness.benchmark, version: readiness.version, level: kitLevelForPolicy(policies[finding.policyIndex]), policyName: finding.policyName, settingId: finding.settingId }))
    let answer: { workspace: WorkspaceView; results: ({ ok: true; exceptionId: string } | { ok: false; error: string })[] }
    try {
      answer = await workspaceRequest<typeof answer>("workspace-cis-exception-add-batch", { items, ...form })
    } catch (error) {
      setExclusion(old => old && { ...old, error: error instanceof Error ? error.message : "The request failed." })
      return
    } finally {
      setBusy("")
    }
    setWorkspace(answer.workspace)
    const failed = excludable.flatMap((finding, index) => { const result = answer.results[index]; return result && !result.ok ? [{ finding, error: result.error }] : [] })
    if (failed.length) {
      // The excluded findings leave the selection; the refused ones stay selected with their reasons.
      setSelected(new Set(failed.map(item => item.finding.key)))
      setExclusion(old => old && { ...old, count: failed.length, error: `Excluded ${excludable.length - failed.length} of ${excludable.length} findings. Not excluded: ${failed.map(item => `${settingDisplayName(item.finding.settingId, settingNames)} in ${item.finding.policyName}: ${item.error}`).join("; ")}` })
      return
    }
    setExclusion(null); setSelected(new Set()); setPreview(false); setConfirmed(false); setCisExceptionsOpen(true); scrollTo("exclusions")
  }
  const reviewLoadedPolicies = <details className="mt-4 text-sm"><summary className="cursor-pointer text-gray-700">Review {policies.length} loaded policies and remove alternative profiles</summary><ul className="mt-3 max-h-64 divide-y divide-gray-100 overflow-auto rounded-2xl bg-gray-50">{policies.map((p, i) => <li key={`${p.name}:${i}`} className="flex items-center justify-between gap-3 p-3"><span>{p.name}<span className="ml-2 text-xs text-gray-500">{p.settings.length} root settings</span></span><button disabled={!!busy} className="text-blue-700 hover:underline disabled:opacity-50" aria-label={`Remove ${p.name}`} onClick={() => { setLoadedKitLevel(null); setPolicies(policies.filter((_, index) => index !== i)); reset() }}>Remove</button></li>)}</ul></details>
  /** Deletes the saved workspace, or resets one that cannot be read, and starts again with an empty one. */
  const deleteSavedWorkspace = (label: string) => perform(label, async () => { suppressedDraft.current = JSON.stringify({ policies, reference }); const saved = await workspaceRequest("workspace-delete"); suppressedDraft.current = JSON.stringify({ policies: [], reference: "" }); setWorkspace(saved); setUnreadable(false); setError(""); setKitConversion(null); setKitFiles([]); setKitDetected({ id: "" }); setKitBenchmark(""); setKitVersion(""); setLoadedKitLevel(null); setPolicies([]); setReference(""); setRecommendationList(undefined); reset() })
  const savedWorkspaceActions = <div className="mt-3 flex flex-wrap gap-3">
    <ExportButton framework={framework} plan={plan} disabled={!!busy || !workspace?.history.length} onClick={() => exportSaved("json", undefined, "saved")}>{isCis ? "Export saved assessments JSON" : "Export saved assessments"}</ExportButton>
    <button className={button} disabled={!!busy} onClick={async () => { if (await confirm({ title: "Delete saved workspace?", description: "Delete this saved workspace and all assessment history?", confirmLabel: "Delete workspace", destructive: true })) void deleteSavedWorkspace("Deleting workspace…") }}>Delete workspace</button>
    {exportStatus("saved")}
  </div>
  const unreadableNotice = unreadable && <div role="alert" aria-label="Saved workspace cannot be read" className="mt-6 rounded-3xl bg-amber-50 px-6 py-5 text-sm text-amber-950">
    <p className="font-medium">The saved workspace cannot be read</p>
    <p className="mt-1">The pack and saved assessments stored on this device for this tenant are damaged or come from an unsupported version, so nothing can be loaded, compared or saved. Reset the workspace to start again with an empty one.</p>
    <button type="button" className={cn(button, "mt-3")} disabled={!!busy} onClick={async () => { if (await confirm({ title: "Reset workspace?", description: "This deletes the unreadable saved workspace, including its saved pack and assessment history, and starts an empty one. This cannot be undone.", confirmLabel: "Reset workspace", destructive: true })) void deleteSavedWorkspace("Resetting workspace…") }}>Reset workspace</button>
  </div>
  const savedHistoryRows = workspace?.history.map(entry => <div key={entry.assessment.runId} className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3 text-sm">
    <span>{isCis ? formatLocaleDateTime(entry.assessment.assessedAt) : entry.assessment.assessedAt} · {isCis ? referenceDisplayName(entry.assessment.reference, packBenchmarkName(entry.policies)) : entry.assessment.reference}{isCis && trendByRun.get(entry.assessment.runId)?.levels.length ? ` · ${(levels => levels.map(level => levels.length > 1 ? `Level ${level.level} ${formatRate(trendRate(level))}` : formatRate(trendRate(level))).join(", "))(trendByRun.get(entry.assessment.runId)!.levels)}` : ""} · {entry.assessment.findings.length} findings{entry.creation ? ` · ${entry.creation.results.length} creation outcomes` : ""}</span>
    <button className={button} disabled={!!busy} onClick={() => { reset(); setSetupRequested(false); setLoadedKitLevel(null); setPolicies(entry.policies); setReference(entry.assessment.reference); setAssessment(entry.assessment); setCreation(entry.creation ?? null); setHistorical(true); if (isCis) scrollTo("results") }}>View read-only</button>
    {!isCis && <ExportButton framework={framework} plan={plan} disabled={!!busy} onClick={() => exportSaved("json", entry.assessment.runId)}>Export JSON</ExportButton>}
    <button className={button} disabled={!!busy} onClick={async () => { if (await confirm({ title: "Delete saved assessment?", description: "Delete this saved assessment?", confirmLabel: "Delete", destructive: true })) void perform("Deleting assessment…", async () => { const saved = await workspaceRequest("workspace-delete-assessment", { runId: entry.assessment.runId }); setWorkspace(saved); setPolicies(saved.policies); setReference(saved.reference); reset() }) }}>Delete</button>
  </div>)
  const exportCisPdf = () => {
    if (!assessment) return
    setExportOrigin("header")
    void perform("Exporting PDF…", async () => {
      await saveInMain({ action: "workspace-cis-pdf", tenantId: credentials?.tenantId, tenantName: selectedTenant?.name, frameworkId: framework.id, runId: assessment.runId, ...(denominator ? { denominator } : {}) })
    }, "export")
  }
  /** Readiness CSV or JSON, built from the readiness on screen and saved through the Save dialog. */
  const exportReadiness = (format: "csv" | "json") => {
    if (!readiness || !assessment) return
    const current = readiness
    const shown = assessment
    setExportOrigin("header")
    void perform("Checking CIS access…", async () => {
      await requireCurrentCisAccess()
      const exportedAt = new Date().toISOString()
      const name = cisExportFileName({ reference: shown.reference, benchmarkName: current.benchmarkName, part: "readiness", tenantName: selectedTenant?.name ?? null, date: localDate(), extension: format })
      await saveCisFile(format === "csv" ? `\uFEFF${cisReadinessCsv(current)}` : cisReadinessJson(current, selectedTenant?.name ?? null, exportedAt), name)
    }, "export")
  }
  const exportCoverage = () => {
    if (!isCis) {
      exportJson({ reference, ...packCoverage(policies) }, `${framework.id}-coverage.json`)
      return
    }
    setExportOrigin("coverage")
    void perform("Checking CIS access…", async () => {
      await requireCurrentCisAccess()
      await saveCisFile(JSON.stringify({ reference, ...packCoverage(policies) }, null, 2), cisExportFileName({ reference, benchmarkName: packBenchmarkName(policies), part: "coverage", tenantName: selectedTenant?.name ?? null, date: localDate(), extension: "json" }))
    }, "export")
  }
  const savedBlock = workspace ? (isCis ? <details ref={savedPanel} open={savedOpen} onToggle={e => setSavedOpen((e.target as HTMLDetailsElement).open)} className="mb-5 scroll-mt-6 rounded-3xl bg-white p-6" aria-label="Saved assessment history">
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
        {cisFlowSteps(policies.length > 0, !!assessment, !!cisRun).map(item => {
          const content = <>
            {item.state === "complete" ? <Check className="h-4 w-4" aria-hidden="true" /> : <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-xs font-semibold">{item.step}</span>}
            <span><span className="sr-only">Step {item.step}: </span>{item.label}</span>
          </>
          // Review results opens the results whenever there are results to review.
          return <li key={item.step} {...(item.state === "current" ? { "aria-current": "step" as const } : {})} className={cn("inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm font-medium", item.state === "complete" ? "border-transparent bg-green-50 text-green-800" : item.state === "current" ? "border-transparent bg-primary text-primary-foreground" : "border-gray-200 bg-white text-gray-500")}>
            {item.step === 3 && assessment ? <button type="button" className="inline-flex items-center gap-2" onClick={() => setSetupRequested(false)}>{content}</button> : content}
          </li>
        })}
      </ol>
    </nav>}
    {unreadableNotice}
    {isCis && activeLookupFailed && !cisRun && <p role="alert" className="mt-6 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-950">Could not check for a running assessment. <button type="button" className="font-medium text-blue-700 hover:underline disabled:opacity-50" disabled={!!busy} onClick={retryActiveLookup}>Retry</button></p>}
    {isCis && openNote && <p role="status" className="mt-6 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-950">{openNote}</p>}
    {isCis && pendingJob && !cisRun && <p role="status" aria-label="Assessment running" className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl bg-blue-50 px-4 py-3 text-sm text-gray-900"><span>An assessment of {referenceDisplayName(pendingJob.reference, packBenchmarkName(pendingJob.policies))} is running.</span><button type="button" className="font-medium text-blue-700 hover:underline" onClick={() => { const job = pendingJob; void trackCisJob({ policies: job.policies, reference: job.reference }, async () => job.jobId) }}>View progress</button></p>}
    {stage === "loading" && <p role="status" className="mt-6 text-sm text-gray-500">Loading saved assessments…</p>}
    {isCis && stage === "results" && assessment && <div ref={resultsHeader} aria-label="Results header" className="mt-6 flex scroll-mt-6 flex-wrap items-center justify-between gap-3 rounded-3xl bg-white px-5 py-4 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div className="min-w-0">
        <p title={assessment.reference} className="truncate text-base font-medium text-gray-900">{(() => {
          const id = readiness?.benchmark && assessment.reference.startsWith(readiness.benchmark) ? readiness.benchmark : assessment.reference.split(/\s+/)[0] ?? ""
          const rest = assessment.reference.slice(id.length).trim()
          return `${benchmarkTitle(id, readiness?.benchmarkName ?? packBenchmarkName(policies))}${rest ? ` ${rest}` : ""}`
        })()}</p>
        <p className="mt-0.5 text-sm text-gray-500">{selectedTenant?.name ? `${selectedTenant.name} · ` : ""}{assessment.policyCount} tenant policies read · {new Date(assessment.assessedAt).toLocaleString()}</p>
        {historical && <p role="status" className="mt-1 text-sm text-amber-800">Showing a saved assessment. Run again to get current evidence and to select, exclude or remediate findings.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primary} disabled={!!busy || !!cisRun || !credentials || !policies.length || !reference.trim() || historyFull} {...historyBlocked} onClick={startCisAssessment}>{cisRun ? "Re-running" : "Run again"}</button>
        <button type="button" className={button} disabled={!!cisRun} onClick={() => setSetupRequested(true)}>New assessment</button>
        {workspace && workspace.history.length > 0 && <button type="button" className={button} onClick={() => { setSavedOpen(true); scrollTo("saved") }}>Saved assessments ({workspace.history.length})</button>}
        <CisExportMenu plan={plan} disabled={!!busy} readinessDisabled={!readiness} onPdf={exportCisPdf} onFindingsCsv={() => exportSaved("csv", assessment.runId)} onFindingsJson={() => exportSaved("json", assessment.runId)} onReadinessCsv={() => exportReadiness("csv")} onReadinessJson={() => exportReadiness("json")} />
      </div>
      {/* Why Run again is unavailable, in words, not only in a hover title. */}
      {!cisRun && (!credentials || historyFull) && <p className="w-full text-sm text-amber-800">{!credentials ? `Run again needs a signed-in tenant. Sign in to ${selectedTenant?.name ?? "the selected tenant"} from the sidebar.` : "Run again is unavailable while the saved assessment history is full. Remove older assessments below first."}</p>}
      {outOfDate && <div role="status" aria-label="Results out of date" className="flex w-full flex-wrap items-center justify-between gap-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <span>Out of date: changes were applied at {formatLocaleDateTime(appliedAt!)}. Run again to verify.</span>
        <button type="button" className={button} disabled={!!busy || !!cisRun || !credentials || !policies.length || !reference.trim() || historyFull} onClick={startCisAssessment}>Run again</button>
      </div>}
      {exportStatus("header")}
    </div>}
    {isCis && stage === "results" && cisRun && <CisRunView run={cisRun} rerun policies={policies} reference={reference} names={settingNames} />}
    {isCis && stage === "running" && cisRun && <>{error && errorAt === "compare" && <p role="alert" className="mt-6 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}<CisRunView run={cisRun} policies={policies} reference={reference} names={settingNames} /></>}
    {isCis && stage === "setup" && assessment && <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-3xl bg-white p-5 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div>
        <p className="text-base font-medium text-gray-900">{referenceDisplayName(assessment.reference, packBenchmarkName(policies))}</p>
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
    {framework.id === CIS_BENCHMARKS_ID && stage === "setup" && <details className="mb-5"><summary className="inline-flex h-10 cursor-pointer list-none items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-5 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 [&::-webkit-details-marker]:hidden">Portfolio</summary><div className="mt-3"><CisPortfolio plan={plan} selectedTenantId={credentials?.tenantId} /></div></details>}
    {isCis && stage === "setup" && <section aria-labelledby="cis-delivered-title" className="mb-5 rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="cis-delivered-title" className="text-xl font-medium tracking-tight">1. Load benchmark</h2><span className="text-sm text-gray-500">{cisCatalog ? `${cisCatalog.length} benchmarks available` : "Delivery service"}</span></div>
      <p className="mt-2 text-sm text-gray-600">Load a benchmark pack from the TenuVault delivery service. The pack is saved in encrypted storage on this device for the selected tenant.</p>
      {policies.length > 0 && reference && <p className="mt-2 text-sm text-gray-800">Loaded: {referenceDisplayName(reference, packBenchmarkName(policies))}, {policies.length} {policies.length === 1 ? "policy" : "policies"}. Compare it with the tenant in step 2.</p>}
      {!credentials && <p className="mt-3 text-sm text-amber-800">Sign in to {selectedTenant?.name ?? "a tenant"} from the sidebar to load benchmarks and run an assessment.</p>}
      <div className="mt-4 flex flex-wrap items-center gap-3"><button type="button" className={button} disabled={!!busy || cisCatalogLoading || !credentials} onClick={() => void loadCisCatalog()}>{cisCatalogLoading ? "Loading available benchmarks…" : "Refresh available benchmarks"}</button>
        {cisCatalogLoading && <span role="status" className="text-sm text-blue-700">{cisCatalog ? "Checking for updated benchmarks…" : "Loading available benchmarks…"}</span>}</div>
      {cisCatalogMessage && <p role="alert" className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900"><span>{cisCatalogMessage}{cisCatalog?.length ? " The benchmarks listed below were loaded earlier." : ""}</span><button type="button" className="font-medium text-blue-700 hover:underline disabled:opacity-50" disabled={cisCatalogLoading || !credentials} onClick={() => void loadCisCatalog()}>Retry</button></p>}
      {busy && busyAt === "load" && <p role="status" className="mt-4 text-sm text-blue-700">{busy}</p>}
      {busy && busyAt === "load" && <div role="progressbar" aria-label={busy} className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100"><div className="h-full w-1/3 animate-pulse rounded-full bg-primary" /></div>}
      {error && errorAt === "load" && <p role="alert" className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800"><span>{error}</span>{packRetry && <button type="button" className="font-medium text-blue-700 hover:underline disabled:opacity-50" disabled={!!busy || !credentials} onClick={() => void loadDeliveredPack(packRetry.benchmark, packRetry.level)}>Retry</button>}</p>}
      {cisCatalog && cisCatalog.length > 0 && <div className="mt-4 grid gap-3 sm:grid-cols-2" role="group" aria-label="Available benchmarks">{cisCatalog.map(benchmark => <div key={`${benchmark.id}-${benchmark.version}`} className="rounded-2xl border border-gray-200 bg-white p-4">
        <p className="text-sm font-medium text-gray-900">{benchmark.name}</p>
        <p className="mt-1 text-sm text-gray-600">Version {benchmark.version}<span className="ml-2 font-mono text-[11px] text-gray-400">{benchmark.id}</span></p>
        <div className="mt-3 flex flex-wrap gap-2">{benchmark.levels.map(level => { const loaded = reference === `${benchmark.id} ${benchmark.version} Level ${level}`; return <button key={level} type="button" aria-pressed={loaded} className={loaded ? primary : button} disabled={!!busy || !credentials} onClick={() => void loadDeliveredPack(benchmark, level)}>{loaded && <Check className="h-4 w-4" aria-hidden="true" />}Level {level}</button> })}</div>
      </div>)}</div>}
    </section>}
    {(!isCis || (stage === "setup" && (kitImport || (policies.length > 0 && !fromKit)))) && <section {...(isCis ? { "aria-label": "Other benchmark sources" } : { "aria-labelledby": "pack-title" })} className="rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      {!isCis && <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="pack-title" className="text-xl font-medium tracking-tight">1. Choose your policy pack</h2><span className="text-sm text-gray-500">{policies.length ? `${policies.length} policies loaded` : "No pack loaded"}</span></div>}
      {!isCis && <p className="mt-2 text-sm text-gray-600">Import one or more Settings Catalog JSON exports. Review the source, version and intended profile before comparison. Loading a pack does not change your tenant.</p>}
      {!isCis && <div className="mt-4 flex flex-wrap items-center gap-3">
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
      </div>}
      {framework.id === "ncsc-dsg" && <p className="mt-3 text-xs text-gray-500">Source content: UK National Cyber Security Centre, Crown Copyright, <a href={`${NCSC_REPOSITORY}/blob/${NCSC_COMMIT}/LICENSE`} target="_blank" rel="noreferrer" className="underline">Apache License 2.0</a>. Pinned commit {NCSC_COMMIT.slice(0, 7)}, each file checked against its reviewed SHA-256. Modified for comparison: decoded from UTF-16, export metadata, IDs and assignments removed. No endorsement by NCSC. Comparison and reports only; policies cannot be created from this pack.</p>}
      {framework.id === "cis-benchmarks" && kitImport && <details><summary className="cursor-pointer text-sm font-medium text-gray-700">Build Kit import (internal use)</summary><div className="mt-4">
        <p className="text-sm text-gray-600">For internal testing of benchmark content before it is delivered. The kit stays on this device, is converted locally, and nothing is created in the tenant from the import.</p>
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
        {policies.length > 0 && reviewLoadedPolicies}
      </div></details>}
      {policies.length > 0 && <>
        {!fromKit && <>
          <button className={cn(button, isCis && kitImport && "mt-4")} onClick={exportCoverage}>Export coverage and source mappings</button>
          {exportStatus("coverage")}
          <p className="mt-3 text-xs text-gray-600">Unsupported: {UNSUPPORTED.join('; ')}. Retained source declarations are not signatures. Organizational evidence and profile approval remain manual.</p>
          <label className="mt-5 block text-sm font-medium text-gray-700">Source version / profile<input value={reference} maxLength={200} disabled={!!busy} onChange={e => { setReference(e.target.value); reset() }} placeholder="For example: approved workstation baseline, revision 3, standard profile" className="mt-2 w-full rounded-full border border-gray-300 px-4 py-2 font-normal" /></label>
        </>}
        {(!isCis || (!fromKit && !kitImport)) && reviewLoadedPolicies}
      </>}
    </section>}
    {(!isCis || stage === "setup" || stage === "results") && <section {...(isCis && stage === "results" ? { "aria-label": "Assessment results" } : { "aria-labelledby": "compare-title" })} className="mt-5 rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      {(!isCis || stage !== "results") && <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="compare-title" className="text-xl font-medium tracking-tight">2. Compare with your tenant</h2><p className="mt-1 text-sm text-gray-600">{selectedTenant ? `Selected tenant: ${selectedTenant.name}` : "Choose a connected tenant using the sidebar."}</p>{isCis && selectedTenant && !credentials && <p className="mt-1 text-sm text-amber-800">The assessment needs a signed-in tenant. Sign in to {selectedTenant.name} from the sidebar.</p>}</div>
        {isCis ? <button className={primary} disabled={!!busy || !!cisRun || !credentials || !policies.length || !reference.trim() || historyFull} {...historyBlocked} onClick={startCisAssessment}>{cisRun ? "Assessment running" : assessment ? "Run again" : "Start Assessment"}</button> : <button className={primary} disabled={!!busy || comparing || !credentials || !policies.length || !reference.trim() || historyFull} {...historyBlocked} onClick={() => {
          if (!compareKey) return
          reset(); setError(""); setErrorAt("compare")
          const chosenReference = reference
          const chosenPolicies = policies
          startBackgroundTask(compareKey, { title: `${framework.name} comparison`, detail: "Reading tenant policies and comparing settings", href: `/portal/frameworks/${framework.id}`, tenantId: credentials!.tenantId }, async () => {
            try {
              const result = await request<Assessment>({ action: "assess", tenantId: credentials!.tenantId, appId: credentials!.appId, frameworkId: framework.id, reference: chosenReference, policies: chosenPolicies })
              // The result belongs to the captured pack: install both together, so a pack
              // changed while the comparison ran cannot pair its policies with these findings.
              rememberBackgroundCompare(credentials!.tenantId, framework.id, result.runId)
              setPolicies(chosenPolicies); setReference(chosenReference); setAssessment(result); setWorkspace(await workspaceRequest("workspace-load"))
              return `${framework.name} comparison is ready.`
            } catch (e) {
              // The page error still shows for an admin who stayed here; the panel carries it elsewhere.
              const message = (e instanceof Error && errorText(e)) || "The request failed."
              setError(message); setErrorAt("compare")
              if (isWorkspaceUnreadableError(message)) setUnreadable(true)
              refreshFullHistory(message)
              throw e
            }
          })
        }}>{comparing ? "Comparing in background" : assessment ? "Compare again" : "Run comparison"}</button>}</div>}
      {comparing && <p role="status" className="mt-4 text-sm text-blue-700">Reading tenant policies and comparing settings in the background. You can keep working elsewhere; the result is saved here.</p>}
      {busy && busyAt === "compare" && !(isCis && cisRun) && <p role="status" className="mt-4 text-sm text-blue-700">{busy}</p>}
      {busy && busyAt === "compare" && isCis && !cisRun && <div role="progressbar" aria-label={busy} className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100"><div className="h-full w-1/3 animate-pulse rounded-full bg-primary" /></div>}
      {historyFull && <div id={historyAlertId} role="alert" aria-label="Saved assessment history is full" className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <p className="font-medium">Saved assessment history is full</p>
        <p className="mt-1">{workspace?.capacity?.reason === "count" || historyCount >= (workspace?.capacity?.limit ?? Infinity)
          ? `This workspace holds ${historyCount} saved assessments, the most it can keep.`
          : `The ${historyCount} saved ${historyCount === 1 ? "assessment" : "assessments"} in this workspace have reached the storage limit on this device.`} New assessments cannot be run until older ones are removed.</p>
        <p className="mt-1">{removableHistory > 0
          ? `Remove older assessments keeps the newest ${KEEP_NEWEST_ASSESSMENTS} and permanently deletes the other ${removableHistory}. Export saved assessments first if you need them.`
          : `Delete saved assessments under ${isCis ? "Saved assessments" : "Saved workspace and history"} to make room. Export them first if you need them.`}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <ExportButton framework={framework} plan={plan} disabled={!!busy || !historyCount} onClick={() => exportSaved("json", undefined, "alert")}>{isCis ? "Export saved assessments JSON" : "Export saved assessments"}</ExportButton>
          {removableHistory > 0 && <button type="button" className={button} disabled={!!busy} onClick={() => void removeOlderAssessments()}>Remove older assessments</button>}
          {exportStatus("alert")}
        </div>
      </div>}
      {historyNotice && <p role="status" className="mt-4 text-sm text-amber-800">{historyNotice}</p>}
      {error && errorAt === "compare" && !isHistoryFullError(error) && !(unreadable && isWorkspaceUnreadableError(error)) && <p role="alert" className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
      {assessment && (!isCis || stage === "results") && <>
        {!isCis && <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-gray-500"><p>{assessment.policyCount} tenant policies read · {new Date(assessment.assessedAt).toLocaleString()}</p><div className="flex flex-wrap gap-2">{(["pdf", "csv", "json"] as ("pdf" | "csv" | "json")[]).map(format => <ExportButton key={format} framework={framework} plan={plan} disabled={!!busy} onClick={() => exportSaved(format, assessment.runId)}><Download className="h-4 w-4" aria-hidden="true" />{format === "pdf" ? "PDF report" : format.toUpperCase()}</ExportButton>)}</div></div>}
        {readiness && <section aria-label="CIS readiness" className="mb-6 border-b border-gray-100 pb-6 text-sm text-gray-700">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-medium text-gray-900">CIS readiness</h3>
            <p className="text-xs text-gray-500">{readiness.manualNote} This view covers the automated settings in the imported pack only.</p>
          </div>
          {readiness.levels.length > 0 && <div className="mt-3 space-y-1 text-sm text-gray-700">{readiness.levels.map(level => <p key={level.level}>{levelCheckSummary(level)}</p>)}</div>}
          <p role="note" aria-label="Manual recommendations" className="mt-3 flex items-start gap-2 rounded-2xl bg-blue-50 px-4 py-3 text-sm text-gray-800"><Info className="mt-0.5 size-4 shrink-0 text-blue-700" aria-hidden="true" /><span>{readiness.manualFallback} <a href={readiness.manualFallbackUrl} className="font-medium text-blue-700 underline underline-offset-2" onClick={event => { event.preventDefault(); void bridge.app.openExternal(readiness.manualFallbackUrl) }}>{readiness.manualFallbackUrl}</a></span></p>
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
              const head = levelHeadline(level)
              const withExclusions = exclusionsText(head)
              const unassigned = unassignedText(level)
              const percentText = formatRate
              // A delivered pack that lists recommendations reports them instead of coverage of the full benchmark.
              const stats: [string, string][] = [
                ["Assessed settings", String(level.assessedSettings)],
                ...(coverageShown(level) ? [
                  ["Coverage of the full benchmark", level.coverage !== null ? `${percentText(level.coverage)} (${level.assessedAutomated} of ${level.denominator})` : "Not available"],
                  ...(level.denominator !== null ? [["Automated recommendations not checked", level.notAssessed.length ? level.notAssessed.join(", ") : "None"]] : []),
                ] as [string, string][] : []),
                ["Excluded from score", String(head.exclusions)],
              ]
              if (level.recommendations.length) {
                const totals = recommendationTotals(level.recommendations)
                stats.unshift(["Recommendations passed", String(totals.passed)], ["Recommendations failed", String(totals.failed)], ...(totals.review ? [["Recommendations to review", String(totals.review)] as [string, string]] : []), ["Recommendations not assessed", String(totals.notAssessed)])
              }
              return <article key={`card-${level.level}`} aria-label={`Level ${level.level} summary`} className="grid gap-5 py-5 first:pt-1 sm:grid-cols-[11rem_minmax(0,1fr)] lg:grid-cols-[11rem_minmax(0,1fr)_16rem]">
                <div>
                  <p className="text-xs font-medium text-gray-500">{benchmarkTitle(level.benchmark, readiness.benchmarkName)} · Level {level.level}{level.version ? ` · ${level.version}` : ""}</p>
                  <p className={`mt-1 font-light tabular-nums tracking-tight text-gray-900 ${head.rate === null ? "text-2xl" : "text-5xl"}`}>{head.rate === null ? "Not available" : percentText(head.rate)}</p>
                  <p className="mt-1 text-xs text-gray-500">{head.label}</p>
                  {headlineBasisNote(head) && <p className="mt-1 text-xs text-gray-600">{headlineBasisNote(head)}</p>}
                  {head.basis === "recommendations" && head.rate === null && <p className="mt-1 text-xs text-gray-600">No recommendation of this Level could be assessed: the pack does not hold every setting they name.</p>}
                  {withExclusions && <p className="mt-1 text-xs font-medium text-gray-700">{withExclusions}<span className="block font-normal text-gray-500">Exclusions as of {formatExpiryDate(head.exclusionsAsOf)}</span></p>}
                  {head.basis === "recommendations" && <p className="mt-1 text-xs text-gray-600">Settings: {level.present} of {level.assessedSettings} present</p>}
                  {unassigned && <p className="mt-1 text-xs text-gray-600">{unassigned}</p>}
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
          {/* Coverage of the full benchmark in plain words; pass rates do not depend on it. */}
          {readiness.levels.filter(coverageShown).map(level => <p key={`coverage-${level.level}`} className="mt-1 text-xs text-gray-500">{readiness.levels.length > 1 ? `Level ${level.level}: ` : ""}{coverageStatement(level)} Pass rates do not depend on it.</p>)}
          {readiness.levels.map(level => level.recommendations.length > 0 && <details key={`recommendations-${level.level}`} className="mt-2 border-t border-gray-100">
            <summary className="cursor-pointer py-3 text-sm font-medium text-gray-800">Recommendation results, Level {level.level}: {(({ passed, failed, review, notAssessed }) => `${passed} passed, ${failed} failed${review ? `, ${review} to review` : ""}, ${notAssessed} not assessed`)(recommendationTotals(level.recommendations))}</summary>
            <p className="text-xs text-gray-500">Each mapped setting is judged on its own value across every tenant policy that holds it. A recommendation passes only when every setting it names is in the pack and Present, and fails when any is Different or Missing. Not assessed means the pack does not hold every setting it names.</p>
            <RecommendationResultList level={level.level} items={level.recommendations} names={settingNames} />
          </details>)}
          {readiness.levels.map(level => level.manual.length > 0 && <div key={`manual-${level.level}`} className="mt-4">
            <h4 className="font-medium text-gray-900">Manual, Level {level.level}</h4>
            <p className="mt-1 text-xs text-gray-500">{benchmarkTitle(readiness.benchmark, readiness.benchmarkName)} {readiness.version}, Level {level.level}. These items are not assessed automatically.</p>
            <ManualList level={level.level} items={level.manual} fallback={readiness.manualFallback} fallbackUrl={readiness.manualFallbackUrl} />
          </div>)}
          <details ref={exclusionsPanel} open={cisExceptionsOpen} onToggle={e => setCisExceptionsOpen((e.target as HTMLDetailsElement).open)} className="mt-2 scroll-mt-6 border-t border-gray-100">
            <summary id="cis-exclusions" className="cursor-pointer py-3 text-sm font-medium text-gray-800">{(() => {
              // One exclusion can count toward two Levels; the total counts it once.
              const inUse = distinctExclusions(readiness.levels.map(levelHeadline))
              const notInUse = listed.reduce((sum, group) => sum + group.levels.reduce((count, level) => count + level.items.filter(item => item.state !== "in-use").length, 0), 0)
              return `Excluded from score: ${inUse}${notInUse ? `, ${notInUse} stored but not in use` : ""}`
            })()}</summary>
            <div className="border-t border-gray-100 pb-4">
          {listed.map(benchmarkGroup => <div key={`exceptions-${benchmarkGroup.benchmark}`}>
            {!benchmarkGroup.current && <h4 className="mt-5 font-medium text-gray-900">Other benchmark: {benchmarkTitle(benchmarkGroup.benchmark, benchmarkNames.get(benchmarkGroup.benchmark))}</h4>}
            {/* The assessed benchmark lists each exclusion under the headline it affects, as the counts do. */}
            {(benchmarkGroup.current ? exceptionsByHeadline(benchmarkGroup) : benchmarkGroup.levels).map(group => {
            const level = benchmarkGroup.current ? readiness.levels.find(item => item.level === group.level) : undefined
            const head = level ? levelHeadline(level) : null
            const withExclusions = head ? exclusionsText(head) : null
            return <div key={`exceptions-${benchmarkGroup.benchmark}-${group.level}`} className="mt-4">
              <h4 className={benchmarkGroup.current ? "font-medium text-gray-900" : "text-sm text-gray-700"}>Level {group.level}{benchmarkGroup.current ? `: ${head?.exclusions ?? 0} excluded from score` : ""}</h4>
              {head && <p className="mt-1 text-xs text-gray-500">{head.label} {formatRate(head.rate)}{withExclusions ? `, ${withExclusions}` : ""}. Exclusions as of {formatExpiryDate(head.exclusionsAsOf)}. Raw counts above are unchanged.</p>}
              {group.items.length ? <ul className="mt-2 space-y-2">{group.items.map(listedItem => { const { exception, note } = listedItem; return <li key={`${group.level}-${exception.id}`} className="flex flex-wrap items-start justify-between gap-3 rounded-2xl bg-gray-50 p-3">
                <span><span className="font-medium text-gray-800">{exception.policyName}</span>{exception.level !== group.level && <span className="ml-2 inline-block rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-800">Policy Level {exception.level}</span>}{note && <span className="ml-2 inline-block rounded-full bg-gray-200 px-2.5 py-0.5 text-xs font-medium text-gray-700">{note}</span>}{knownSettingName(exception.settingId, settingNames) && <span className="block text-xs text-gray-700">{knownSettingName(exception.settingId, settingNames)}</span>}<span className="block break-all font-mono text-xs text-gray-500">{exception.version} · {exception.settingId}</span><span className="block text-xs text-gray-600">Owner: {exception.owner} · Expires: {formatExpiryDate(exception.expiresOn)}</span><span className="block text-xs text-gray-600">{exception.reason}</span></span>
                <button type="button" className={button} disabled={!!busy || historical} onClick={() => void removeException(listedItem)}>Remove</button>
              </li> })}</ul> : <p className="mt-2 text-xs text-gray-500">Nothing is excluded for this level. Select findings and choose Exclude from score.</p>}
            </div>
          })}
          </div>)}
            </div>
          </details>
          <details className="border-t border-gray-100">
            <summary className="cursor-pointer py-3 text-sm font-medium text-gray-800">{trendSummaryText(shownGroup?.points[0] ? { ...shownGroup.points[0], levels: shownGroup.points[0].levels.map(level => ({ level: level.level, passRate: trendRate(level) })) } : undefined, shownGroup?.points.length ?? 0, formatLocaleDate)}</summary>
            <div className="border-t border-gray-100 pb-4 pt-2">
            {drift.map(entry => <p key={`drift-${entry.level}-${entry.benchmark}-${entry.version}`} role="alert" className="mt-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">Level {entry.level} readiness dropped {((entry.previousRate - entry.currentRate) * 100).toFixed(1)} percentage points to {formatRate(entry.currentRate)} for {benchmarkTitle(entry.benchmark, entry.benchmarkName)} {entry.version}. Raw rate, exclusions not applied.</p>)}
            <p className="mt-1 text-xs text-gray-500">Raw headline rate of each saved assessment for this tenant, grouped by benchmark, newest first. Change is in percentage points from the previous assessment of the same benchmark, version and Level, and only when the same pack was assessed. Exclusions count as of today for the newest assessment of each Level and as of the assessment date for older ones.</p>
            {groups.map(group => {
              const groupLevels = [...new Set(group.points.flatMap(point => point.levels.map(level => level.level)))].sort((a, b) => a - b)
              const oldestFirst = [...group.points].reverse()
              // When runs of one Level differ in basis, each cell names its own basis.
              const mixedBasis = (level: KitLevel) => new Set(group.points.flatMap(point => point.levels.filter(entry => entry.level === level).map(entry => entry.basis ?? "settings"))).size > 1
              return <section key={group.key} aria-label={`Trend for ${benchmarkTitle(group.benchmark, group.benchmarkName)} ${group.version}`} className="mt-4">
                <h4 className="text-sm font-medium text-gray-900">{benchmarkTitle(group.benchmark, group.benchmarkName)} {group.version}<span className="ml-2 text-xs font-normal text-gray-500">{group.points.length} {group.points.length === 1 ? "assessment" : "assessments"}</span></h4>
                <div className="mt-2 overflow-auto"><table className="w-full text-left text-sm"><thead><tr className="text-gray-500"><th className="py-1 pr-3 font-medium">Assessed</th>{groupLevels.map(level => <th key={`trend-head-${level}`} className="py-1 pr-3 font-medium">Level {level} {mixedBasis(level) ? "pass rate" : headlineLabel(group.points.find(point => point.levels.some(entry => entry.level === level))?.levels.find(entry => entry.level === level)?.basis ?? "settings").toLowerCase()}</th>)}{groupLevels.map(level => <th key={`trend-change-head-${level}`} className="py-1 pr-3 font-medium">Level {level} change</th>)}</tr></thead><tbody>{group.points.map(point => <tr key={point.runId} className="border-t border-gray-200"><td className="py-2 pr-3">{formatLocaleDateTime(point.assessedAt)}</td>{groupLevels.map(level => { const item = point.levels.find(entry => entry.level === level); const withExclusions = item ? trendExclusionsText(item) : null; return <td key={`trend-rate-${point.runId}-${level}`} className="py-2 pr-3">{item ? formatRate(trendRate(item)) : "Not assessed"}{item && mixedBasis(level) && <span className="block text-xs text-gray-500">{headlineLabel(item.basis ?? "settings")}</span>}{withExclusions && <span className="block text-xs text-gray-600">{withExclusions}</span>}</td> })}{groupLevels.map(level => { const item = point.levels.find(entry => entry.level === level); return <td key={`trend-change-${point.runId}-${level}`} className="py-2 pr-3">{item ? trendChangeText(item) : ""}</td> })}</tr>)}</tbody></table></div>
                <div className="mt-2 flex flex-wrap gap-4">{groupLevels.map(level => <div key={`trend-spark-${level}`} className="flex items-center gap-2 text-gray-700"><span className="text-xs font-medium text-gray-500">Level {level}</span><TrendSparkline points={oldestFirst.filter(point => point.levels.some(entry => entry.level === level))} level={level} /></div>)}</div>
              </section>
            })}
            {!trend.length && <p className="mt-2 text-xs text-gray-500">No saved assessments yet for a trend.</p>}
            </div>
          </details>
        </section>}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <SearchInput label="Search findings" className="sm:w-96" value={findingFilter.query} onChange={query => { setFindingFilter(old => ({ ...old, query })); setPage(0) }} placeholder={isCis ? "Search setting, policy or recommendation" : "Search setting or policy"} />
          {levels.length > 1 && <FilterSelect label="Filter by level" value={String(shownFindingFilter.level)} onChange={level => { setFindingFilter(old => ({ ...old, level: Number(level) as FindingFilter["level"] })); setPage(0) }} options={[{ value: "0", label: "All levels" }, ...levels.map(level => ({ value: String(level), label: `Level ${level}` }))]} />}
          {searching && <button type="button" className="text-sm font-medium text-gray-700 underline" onClick={() => { setFindingFilter(NO_FINDING_FILTER); setPage(0) }}>Clear search</button>}
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-2"><FilterChips label="Filter assessment findings" value={filter} onChange={status => { setFilter(status); setPage(0) }} options={["All", "Present", "Missing", "Different", "Review"].map(status => ({ value: status, label: status, count: searched.filter(f => status === "All" || f.status === status).length }))} />
          <span aria-live="polite" className="ml-auto text-sm text-gray-500">{isCis || searching ? `${findings.length} of ${assessment.findings.length} findings` : ""}</span>
          {isCis && deviatingKeys.length > 0 && <button type="button" className={button} disabled={!!busy || !!creation || historical || allDeviatingSelected} onClick={selectAllDeviating}>Select all deviating ({deviatingKeys.length})</button>}
        </div>
        <p className="mb-4 text-xs leading-5 text-gray-500">Different: at least one existing configuration differs. Review: the pack contains alternative values for this setting. Select a single profile or resolve differences manually. Unassigned configurations can appear as Present. Expand a finding to inspect assignment evidence, including exclusions, filter references and unavailable reads.</p>
        {isCis ? <div>{groupFindingsByPolicy(findings).map(group => <section key={group.policyIndex} aria-label={group.policyName} className="border-t border-gray-100 py-4 first:border-t-0 first:pt-1">
          <h4 title={group.policyName} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
            <span className="min-w-0 truncate font-medium text-gray-900">{policyDisplayName(group.policyName, reference)}</span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs tabular-nums text-gray-600">{group.total} {group.total === 1 ? "finding" : "findings"}</span>
            <span className="text-xs text-gray-500">{statusMixText(group.counts)}</span>
          </h4>
          <div className="mt-1 divide-y divide-gray-100">{group.findings.map(f => <CisFindingRow key={f.key} finding={f} names={settingNames} excluded={excludedKeys.has(f.key)} recommendations={recommendationsForFinding(policies, f)} disabled={!!busy || !!creation || historical} checked={selected.has(f.key)} onChange={() => { setSelected(old => { const next = new Set(old); next.has(f.key) ? next.delete(f.key) : next.add(f.key); return next }); setPreview(false); setConfirmed(false) }} />)}</div>
        </section>)}</div> : <>
        <div className="space-y-2">{findings.slice(page * 50, (page + 1) * 50).map(f => <FindingRow key={f.key} finding={f} disabled={!!busy || !!creation || historical || (!!framework.comparisonOnly && framework.id !== "cis-benchmarks")} remediable={framework.id === "cis-benchmarks"} checked={selected.has(f.key)} onChange={() => { setSelected(old => { const next = new Set(old); next.has(f.key) ? next.delete(f.key) : next.add(f.key); return next }); setPreview(false); setConfirmed(false) }} />)}</div>
        {findings.length > 50 && <div className="mt-4 flex items-center justify-between gap-3"><button className={button} disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span className="text-sm text-gray-500">Page {page + 1} of {Math.ceil(findings.length / 50)}</span><button className={button} disabled={(page + 1) * 50 >= findings.length} onClick={() => setPage(page + 1)}>Next</button></div>}
        </>}
        {!findings.length && <p role="status" className="py-6 text-center text-sm text-gray-500">{searching ? "No findings match the search." : "No findings in this category."}</p>}
        {readiness && selected.size > 0 && <div role="region" aria-label="Selected findings" className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center gap-3 rounded-3xl border border-gray-200 bg-white px-5 py-3 shadow-lg">
          <span className="text-sm font-medium text-gray-800">{selected.size} selected{hiddenSelectedText && <span className="font-normal text-amber-800">, {hiddenSelectedText} <button type="button" className="font-medium underline" onClick={showAllFindings}>Show all findings</button></span>}</span>
          <span className="text-xs text-gray-500">Remediate them under Remediate or deploy below, or exclude them from the score if you do not apply them on purpose.</span>
          <span className="ml-auto flex gap-2">
            {!allDeviatingSelected && <button type="button" className={button} disabled={!!busy || historical} onClick={selectAllDeviating}>Select all deviating ({deviatingKeys.length})</button>}
            <button type="button" className={button} disabled={!!busy || historical} onClick={() => { setSelected(new Set()); setPreview(false); setConfirmed(false) }}>Clear</button>
            <button ref={excludeButton} type="button" className={button} disabled={!!busy || historical || !excludable.length} title={excludable.length ? undefined : "The selected findings are already excluded."} onClick={() => setExclusion({ owner: "", reason: "", expiresOn: "", count: excludable.length, error: "" })}>Exclude from score ({excludable.length})</button>
          </span>
          {!historical && !excludable.length && <span className="w-full text-xs text-amber-800">Exclude from score is unavailable: the selected findings are already excluded.</span>}
        </div>}
        <Dialog open={exclusion !== null} onOpenChange={open => { if (!open && !busy) setExclusion(null) }}>
          <DialogContent onCloseAutoFocus={e => { e.preventDefault(); (excludeButton.current?.isConnected ? excludeButton.current : document.getElementById("cis-exclusions"))?.focus() }}>
            <DialogHeader>
              <DialogTitle>Exclude {exclusion?.count} {exclusion?.count === 1 ? "finding" : "findings"} from the score</DialogTitle>
              <DialogDescription>Use this for settings you do not apply on purpose. They stay listed and count as passed in the rate with exclusions through the expiry date, then count again and need a new decision. The raw rate and counts do not change.{excludable.some(finding => hiddenSelected.has(finding.key)) && ` ${excludable.filter(finding => hiddenSelected.has(finding.key)).length} of them are hidden by the current filters.`}</DialogDescription>
            </DialogHeader>
            {exclusion && <form id="cis-exclusion" className="grid gap-3 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); void excludeSelected(exclusion) }}>
              <label className="block text-xs font-medium text-gray-700">Owner<input required value={exclusion.owner} disabled={!!busy} onChange={e => setExclusion({ ...exclusion, owner: e.target.value })} className="mt-1 w-full rounded-full border border-gray-300 px-3 py-1.5 text-sm font-normal" /></label>
              <label className="block text-xs font-medium text-gray-700">Expiry date<input required type="date" min={today} value={exclusion.expiresOn} disabled={!!busy} onChange={e => setExclusion({ ...exclusion, expiresOn: e.target.value })} className="mt-1 w-full rounded-full border border-gray-300 px-3 py-1.5 text-sm font-normal" /></label>
              <label className="block text-xs font-medium text-gray-700 sm:col-span-2">Reason<input required value={exclusion.reason} disabled={!!busy} onChange={e => setExclusion({ ...exclusion, reason: e.target.value })} className="mt-1 w-full rounded-full border border-gray-300 px-3 py-1.5 text-sm font-normal" /></label>
              {exclusion.error && <p role="alert" className="text-sm text-red-700 sm:col-span-2">{exclusion.error}</p>}
            </form>}
            <DialogFooter>
              <button type="button" className={button} disabled={!!busy} onClick={() => setExclusion(null)}>Cancel</button>
              <button type="submit" form="cis-exclusion" className={primary} disabled={!!busy || !excludable.length}>{busy ? busy : "Exclude from score"}</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {framework.id === "cis-benchmarks" ? <CisRemediationPanel tenant={selectedTenant ?? undefined} assessment={assessment} policies={policies} reference={reference} selectedKeys={selected} readOnly={historical} onPlanned={id => setRemediationFocus({ id, at: Date.now() })} /> : framework.comparisonOnly ? <p className="mt-5 border-t pt-4 text-sm text-gray-600">This pack is available for comparison and reports only. Review missing settings and configure them through your own change process.</p>
        : <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-sm text-gray-600">{chosen.length} missing root settings selected · {payloads.length} new {payloads.length === 1 ? "policy" : "policies"}{hiddenSelectedText && ` · ${hiddenSelectedText}`}</p><button className={primary} disabled={!chosen.length || !!busy || !!creation || historical} onClick={() => { setPreview(true); setConfirmed(false) }}>Preview recommended policies</button></div>}
      </>}
    </section>}
    {(stage === "setup" || stage === "results") && selectedTenant && credentials && <CisRemediationHistory tenant={selectedTenant} focus={remediationFocus} onApplied={setAppliedAt} />}
    {isCis && stage === "results" && savedBlock}
    {framework.id === CIS_BENCHMARKS_ID && stage === "results" && <details className="mb-5"><summary className="inline-flex h-10 cursor-pointer list-none items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-5 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 [&::-webkit-details-marker]:hidden">Portfolio</summary><div className="mt-3"><CisPortfolio plan={plan} selectedTenantId={credentials?.tenantId} /></div></details>}
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

/** One Level's recommendation results with search over ID, title, setting IDs and setting names, and result chips. */
function RecommendationResultList({ level, items, names }: { level: number; items: RecommendationResult[]; names: SettingNames }) {
  const [query, setQuery] = useState("")
  const [result, setResult] = useState<RecommendationResultFilter>("All")
  const view = recommendationResultView(items, query, result, names)
  return <>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <SearchInput label={`Search Level ${level} recommendations`} value={query} onChange={setQuery} placeholder="Search ID, title or setting" />
      <FilterChips label={`Filter Level ${level} recommendations by result`} value={view.result} onChange={setResult} options={view.options} />
      <span aria-live="polite" className="ml-auto text-xs text-gray-500">{view.filtering ? `${view.shown.length} of ${items.length} recommendations` : ""}</span>
    </div>
    <ul className="mt-2 max-h-80 divide-y divide-gray-100 overflow-auto border-y border-gray-100">{view.shown.map(item => <li key={item.id} className="flex items-start gap-3 py-2">
      <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${item.result === "Pass" ? "bg-green-50 text-green-800" : item.result === "Fail" ? "bg-red-50 text-red-800" : "bg-gray-100 text-gray-700"}`}>{item.result}</span>
      <span className="min-w-0 flex-1 text-sm text-gray-800"><span className="font-medium">{item.id}</span> {item.title}<span className="block text-xs leading-5 text-gray-600">{item.settings.map(setting => `${settingDisplayName(setting.id, names)}: ${setting.status}`).join("; ")}</span><span className="block break-all font-mono text-[11px] leading-4 text-gray-400">{item.settings.map(setting => setting.id).join("; ")}</span></span>
    </li>)}
      {!view.shown.length && <li className="py-3 text-center text-sm text-gray-500">No recommendations match the filters.</li>}</ul>
  </>
}

/** One Level's manual items with search over identifier, title and benchmark text. */
function ManualList({ level, items, fallback, fallbackUrl }: { level: number; items: ManualItemView[]; fallback: string; fallbackUrl: string }) {
  const [query, setQuery] = useState("")
  const shown = filterManualItems(items, query)
  return <>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <SearchInput label={`Search Level ${level} manual items`} value={query} onChange={setQuery} placeholder="Search ID, title or text" />
      <span aria-live="polite" className="ml-auto text-xs text-gray-500">{shown !== items ? `${shown.length} of ${items.length} manual items` : ""}</span>
    </div>
    <div className="mt-2 divide-y divide-gray-100 border-y border-gray-100">{shown.map(item => <details key={item.identifier} className="py-3">
      <summary className="cursor-pointer text-sm"><span className="font-medium text-gray-800">{item.identifier}</span>{item.title && <span className="ml-2 text-gray-700">{item.title}</span>}<span className="ml-2 inline-block rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-700">Manual</span></summary>
      <div className="mt-3 space-y-2 text-sm text-gray-700">
        {item.hasText ? <>
          {item.description && <p><strong className="font-medium text-gray-900">Description:</strong> {item.description}</p>}
          {item.impact && <p><strong className="font-medium text-gray-900">Impact:</strong> {item.impact}</p>}
          {item.audit && <p><strong className="font-medium text-gray-900">Audit:</strong> {item.audit}</p>}
          {item.remediation && <p><strong className="font-medium text-gray-900">Remediation:</strong> {item.remediation}</p>}
        </> : <p><a href={fallbackUrl} className="text-blue-700 hover:underline" onClick={event => { event.preventDefault(); void bridge.app.openExternal(fallbackUrl) }}>{fallback}</a></p>}
      </div>
    </details>)}
      {!shown.length && <p className="py-3 text-center text-sm text-gray-500">No manual items match the search.</p>}</div>
  </>
}

/**
 * One CIS finding. Settings and choices show their display names from `names` when they were read,
 * with the raw setting id as secondary text; without names the raw values stay as they are.
 * `selectable` is false while a run streams partial results, which cannot be selected yet.
 */
function CisFindingRow({ finding, recommendations, checked, disabled, onChange, excluded = false, names, selectable = true }: { finding: Finding; recommendations: PackRecommendation[]; checked: boolean; disabled: boolean; onChange: () => void; excluded?: boolean; names: SettingNames; selectable?: boolean }) {
  const recommendation = recommendations.length > 2 ? `${recommendationLabel(recommendations.slice(0, 1))} and ${recommendations.length - 1} more recommendations` : recommendationLabel(recommendations)
  const colors = { Present: "bg-green-50 text-green-800", Missing: "bg-amber-50 text-amber-900", Different: "bg-red-50 text-red-800", Review: "bg-gray-100 text-gray-700" }
  const recommendedLines = summarizeSetting(finding.recommended, names)
  const groups = groupObservationsByValue(finding.observed, finding.recommended)
  const settingName = settingDisplayName(finding.settingId, names)
  return <div className="flex items-start gap-3 py-2.5">
    {selectable && <input type="checkbox" aria-label={`Select finding ${settingName} from ${finding.policyName}`} checked={checked} disabled={disabled || !isSelectableFinding(finding)} onChange={onChange} className="mt-1 h-4 min-h-0 w-4 shrink-0" />}
    <details className="group min-w-0 flex-1"><summary className="flex cursor-pointer list-none items-center gap-2.5 text-sm [&::-webkit-details-marker]:hidden">
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${colors[finding.status]}`}>{finding.status}</span>
        {excluded && <span className="shrink-0 rounded-full bg-gray-200 px-2.5 py-0.5 text-xs font-medium text-gray-700">Excluded</span>}
        <span className="min-w-0 flex-1">
          {recommendation && <span title={recommendation} className="block truncate font-medium text-gray-900">{recommendation}</span>}
          <span className={recommendation ? "block truncate text-xs text-gray-600" : "block truncate font-medium text-gray-800"}>{settingName}</span>
          <span title={finding.settingId} className="block truncate font-mono text-[11px] leading-4 text-gray-400">{finding.settingId}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-gray-400 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      {recommendations.length > 0 && <div className="mt-3"><p className="mb-1.5 text-xs font-semibold text-gray-600">Recommendations</p><ul className="space-y-0.5 text-xs leading-5 text-gray-700">{recommendations.map(item => <li key={item.id}><span className="font-medium">{item.id}</span> {item.title}</li>)}</ul></div>}
      <div className="mt-3 grid gap-x-6 gap-y-4 pb-2 lg:grid-cols-2">
        <div><p className="mb-1.5 text-xs font-semibold text-gray-600">Recommended configuration</p><ul className="space-y-1 border-l-2 border-gray-200 pl-3 text-xs leading-5 text-gray-700">{recommendedLines.map((line, index) => <li key={index} className="whitespace-pre-wrap break-words">{line}</li>)}</ul></div>
        <div><p className="mb-1.5 text-xs font-semibold text-gray-600">Observed policies and configuration</p>{groups.length ? <div className="divide-y divide-gray-100">{groups.map(group => <div key={group.key} className="py-2 text-xs first:pt-0 last:pb-0"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 truncate font-medium text-gray-800" title={group.policyNames.join(", ")}>{group.policyNames.join(", ")}</span>{group.observations.length > 1 && <span className="text-gray-500">{group.observations.length} policies with this value</span>}<span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${group.matchesRecommended ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>{group.matchesRecommended ? "Matches recommended" : "Differs"}</span></div><ul className="mt-1.5 space-y-0.5 leading-5 text-gray-700">{summarizeSetting(group.value, names).map((line, index) => <li key={index} className="whitespace-pre-wrap break-words">{line}</li>)}</ul><p className="mt-1 text-gray-500">{targetingText(group.observations[0]!)}</p></div>)}</div> : <p className="text-xs leading-5 text-gray-600">No matching root setting found in the assessed policy family.</p>}</div>
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
