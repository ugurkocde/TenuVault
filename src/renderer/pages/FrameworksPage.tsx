import { packCoverage, UNSUPPORTED } from "../../shared/frameworks/coverage"
import type { FrameworkWorkspace } from "../../main/frameworks/workspaces"
import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { ArrowRight, ChevronDown, Download, ExternalLink, Info, Search } from "lucide-react"
import { useSelectedTenant, useTenants } from "~/contexts/TenantContext"
import { cn } from "~/lib/utils"
import { NCSC_COMMIT, NCSC_REPOSITORY, type Framework } from "../../shared/frameworks/catalog"
import { CIS_BENCHMARKS_ID, effectiveFrameworks, searchEffectiveFrameworks } from "../../shared/frameworks/cis-internal"
import { convertKit, type KitConversion, type KitFile, type KitLevel } from "../../shared/frameworks/cis-kit"
import { parseDenominatorList, type DenominatorEntry } from "../../shared/frameworks/cis-coverage"
import { cisReadiness } from "../../shared/frameworks/cis-readiness"
import { cisReadinessTrend, sparklineSegments, type CisTrendPoint } from "../../shared/frameworks/cis-trend"
import { cisPortfolioRows, type CisPortfolioEntry } from "../../shared/frameworks/cis-portfolio"
import { parseRecommendationList, type RecommendationList } from "../../shared/frameworks/cis-manual"
import { cisReadinessCsv, cisReadinessJson } from "../features/shared/governance-export"
import { GovernanceExportButtons } from "../features/shared/GovernanceExportButtons"
import { useInternalCisBenchmarks } from "../lib/internal-cis"
import { parsePolicies, remediationPayload, type Assessment, type BaselinePolicy, type Finding } from "../../shared/frameworks/policies"
import { CIS_FRAMEWORKS, type Plan } from "../../shared/plans"
import type { ExportFile } from "../../main/frameworks/service"
import type { NcscPack } from "../../main/frameworks/ncsc"
import { tenantLicense, tenantPlan, useLicense, useTenantPlan } from "../lib/license"
import { CisRemediationPanel } from "../features/cis-remediation/CisRemediationPanel"
import { GatedButton } from "../components/PlanGate"
import { useConfirm } from "~/components/ConfirmDialog"

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
  const catalog = effectiveFrameworks(useInternalCisBenchmarks())
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
  if (framework) return <FrameworkDetail key={`${framework.id}:${selectedTenant?.credentials?.tenantId ?? "none"}`} framework={framework} standalone={framework.id === CIS_BENCHMARKS_ID} />
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
      <thead className="text-xs text-gray-500"><tr><th scope="col" className="py-2 pr-4 font-medium">Tenant</th><th scope="col" className="py-2 pr-4 font-medium">Benchmark</th><th scope="col" className="py-2 pr-4 font-medium">Assessed</th><th scope="col" className="py-2 pr-4 font-medium">Level 1</th><th scope="col" className="py-2 pr-4 font-medium">Level 2</th><th scope="col" className="py-2 pr-4 font-medium">Assessed settings (Level 1 / Level 2)</th><th scope="col" className="py-2 font-medium">Excepted</th></tr></thead>
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

function FrameworkDetail({ framework, standalone = false }: { framework: Framework; standalone?: boolean }) {
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
  const [kitConversion, setKitConversion] = useState<KitConversion | null>(null)
  const [denominator, setDenominator] = useState<DenominatorEntry[] | undefined>(undefined)
  const [recommendationList, setRecommendationList] = useState<RecommendationList | undefined>(undefined)
  const [exceptionForms, setExceptionForms] = useState<Record<number, { policyName: string; settingId: string; owner: string; reason: string; expiresOn: string }>>({})
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
  useEffect(() => {
    if (!workspace || !recommendationList) return
    let active = true
    void workspaceRequest("workspace-save", { policies, reference, recommendationList }).then(saved => { if (active) setWorkspace(saved) }).catch(e => { if (active) setError(`Workspace was not saved: ${String(e)}`) })
    return () => { active = false }
  }, [recommendationList])
  const findings = assessment?.findings.filter(f => filter === "All" || f.status === filter) ?? []
  const readiness = assessment && framework.id === "cis-benchmarks" ? cisReadiness(assessment, policies, denominator, recommendationList, workspace?.exceptions) : null
  const trend = framework.id === "cis-benchmarks" && workspace ? cisReadinessTrend(workspace.history, recommendationList, workspace.exceptions) : []
  const trendLevels = [...new Set(trend.flatMap(point => point.levels.map(level => level.level)))].sort((a, b) => a - b)
  return <div className={standalone ? "mx-auto max-w-[1600px] space-y-6 p-6 lg:p-8" : "mx-auto max-w-6xl p-6 lg:p-8"}>
    {confirmDialog}
    {!standalone && <Link to="/portal/frameworks" className="text-sm text-blue-700 hover:underline">Frameworks</Link>}
    <div className={`${standalone ? "" : "mt-4 "}flex flex-wrap items-start justify-between gap-4`}>
      <div><p className="text-xs uppercase tracking-widest text-gray-500">{framework.publisher} · {framework.kind}</p><h1 className={standalone ? "mt-2 text-4xl font-light tracking-tight text-gray-900" : "mt-2 text-3xl font-semibold tracking-tight text-gray-950"}>{framework.name}</h1><p className="mt-2 text-gray-600">{framework.description}</p></div>
      {framework.source && <a href={framework.source} target="_blank" rel="noreferrer" className={button}>Source <ExternalLink className="h-4 w-4" aria-hidden="true" /></a>}
    </div>
    <details className="group my-6 rounded-3xl bg-blue-50/60 px-6 py-4 shadow-[0_1px_2px_rgba(22,21,20,0.04)] lg:px-7 [&[open]_.chevron]:rotate-180">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-3 text-sm"><Info className="size-4 shrink-0 text-blue-700" aria-hidden="true" /><span><strong className="font-medium text-gray-900">Assessment coverage</strong><span className="text-gray-600"> · What is compared, content sources and limits.</span></span></span>
        <ChevronDown className="chevron size-4 shrink-0 text-gray-500 transition-transform" aria-hidden="true" />
      </summary>
      <div className="mt-4 space-y-2 border-t border-blue-100 pt-4 text-sm leading-6 text-gray-700"><p>Mapping format v1. Automatic content: NCSC Device Security Guidance 2025 Windows Settings Catalog only. Other frameworks use administrator-supplied mappings. No certification or complete framework assessment is implied.</p><p>{framework.coverage}</p>{framework.licenseNotice && <p>{framework.licenseNotice}</p>}<p>Comparison covers Settings Catalog root settings and their nested values. Assignment targets, exclusions and filter references are reported separately from configuration. Group membership, device applicability, enforcement and other policy families remain unavailable. “Present” means a matching configuration exists; it does not mean the setting is assigned or enforced.</p></div>
    </details>
    {workspace && <section className="mb-5 rounded-3xl bg-white p-6" aria-label="Saved assessment history">
      <h2 className="text-lg font-medium">Saved workspace and history</h2>
      <p className="mt-2 text-sm text-gray-600">Packs, source versions and results are saved in encrypted storage on this device. Historical assessments are read-only. Run a fresh comparison before remediation.</p>
      <div className="mt-3 flex gap-3">
        <ExportButton framework={framework} plan={plan} disabled={!!busy || !workspace.history.length} onClick={() => exportSaved("json")}>Export saved assessments</ExportButton>
        <button className={button} disabled={!!busy} onClick={async () => { if (await confirm({ title: "Delete saved workspace?", description: "Delete this saved workspace and all assessment history?", confirmLabel: "Delete workspace", destructive: true })) void perform("Deleting workspace…", async () => { suppressedDraft.current = JSON.stringify({ policies, reference }); const saved = await workspaceRequest("workspace-delete"); suppressedDraft.current = JSON.stringify({ policies: [], reference: "" }); setWorkspace(saved); setPolicies([]); setReference(""); setRecommendationList(undefined); reset() }) }}>Delete workspace</button>
      </div>
      {workspace.history.map(entry => <div key={entry.assessment.runId} className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3 text-sm">
        <span>{entry.assessment.assessedAt} · {entry.assessment.reference} · {entry.assessment.findings.length} findings{entry.creation ? ` · ${entry.creation.results.length} creation outcomes` : ""}</span>
        <button className={button} disabled={!!busy} onClick={() => { reset(); setPolicies(entry.policies); setReference(entry.assessment.reference); setAssessment(entry.assessment); setCreation(entry.creation ?? null); setHistorical(true) }}>View read-only</button>
        <ExportButton framework={framework} plan={plan} disabled={!!busy} onClick={() => exportSaved("json", entry.assessment.runId)}>Export JSON</ExportButton>
        <button className={button} disabled={!!busy} onClick={async () => { if (await confirm({ title: "Delete saved assessment?", description: "Delete this saved assessment?", confirmLabel: "Delete", destructive: true })) void perform("Deleting assessment…", async () => { const saved = await workspaceRequest("workspace-delete-assessment", { runId: entry.assessment.runId }); setWorkspace(saved); setPolicies(saved.policies); setReference(saved.reference); reset() }) }}>Delete</button>
      </div>)}
      {historical && <p role="status" className="mt-3 text-sm text-amber-800">Viewing a saved assessment. Compare again to obtain current evidence and enable remediation.</p>}
    </section>}
    {framework.id === CIS_BENCHMARKS_ID && <CisPortfolio plan={plan} />}
    <section aria-labelledby="pack-title" className="rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="pack-title" className="text-xl font-medium tracking-tight">1. Choose your policy pack</h2><span className="text-sm text-gray-500">{policies.length ? `${policies.length} policies loaded` : "No pack loaded"}</span></div>
      <p className="mt-2 text-sm text-gray-600">Import one or more Settings Catalog JSON exports. Review the source, version and intended profile before comparison. Loading a pack does not change your tenant.</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {framework.id === "ncsc-dsg" && <button className={button} disabled={!!busy} onClick={() => void perform("Loading NCSC pack…", async () => {
          const pack = await request<NcscPack>({ action: "load-ncsc" }); reset(); setPolicies(pack.policies); setReference(pack.reference)
        })}>Load NCSC Windows 2025</button>}
        <label className="text-sm font-medium text-gray-700">Import policy JSON<input type="file" multiple accept=".json,application/json" disabled={!!busy} className="ml-3 max-w-full text-sm" onChange={e => {
          const files = Array.from(e.target.files ?? []); e.target.value = ""
          if (!files.length) return
          void perform("Reading policy pack…", async () => {
            if (files.reduce((sum, f) => sum + f.size, 0) > 8_000_000) throw new Error("The policy pack exceeds 8 MB.")
            const values: unknown[] = []
            for (const file of files) { const json: unknown = JSON.parse(await file.text()); values.push(...(Array.isArray(json) ? json : [json])) }
            const parsed = parsePolicies(values); reset(); setPolicies(parsed); setReference("")
          })
        }} /></label>
      </div>
      {framework.id === "ncsc-dsg" && <p className="mt-3 text-xs text-gray-500">Source content: UK National Cyber Security Centre, Crown Copyright, <a href={`${NCSC_REPOSITORY}/blob/${NCSC_COMMIT}/LICENSE`} target="_blank" rel="noreferrer" className="underline">Apache License 2.0</a>. Pinned commit {NCSC_COMMIT.slice(0, 7)}, each file checked against its reviewed SHA-256. Modified for comparison: decoded from UTF-16, export metadata, IDs and assignments removed. No endorsement by NCSC. Comparison and reports only; policies cannot be created from this pack.</p>}
      {framework.id === "cis-benchmarks" && <div className="mt-5 border-t border-gray-100 pt-5">
        <h3 className="text-base font-medium text-gray-900">Import a Build Kit</h3>
        <p className="mt-2 text-sm text-gray-600">Pick Build Kit files or a folder for one benchmark. The converted pack is saved through the workspace below, with its provenance, and is compared with the tenant like any other pack. Nothing is created in the tenant from this import.</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block text-sm font-medium text-gray-700">Benchmark id<input value={kitBenchmark} disabled={!!busy} onChange={e => setKitBenchmark(e.target.value)} placeholder="For example: synthetic-os" className="mt-2 w-56 rounded-full border border-gray-300 px-4 py-2 font-normal" /></label>
          <label className="block text-sm font-medium text-gray-700">Version (when file names carry none)<input value={kitVersion} disabled={!!busy} onChange={e => setKitVersion(e.target.value)} placeholder="For example: 1.0.0" className="mt-2 w-48 rounded-full border border-gray-300 px-4 py-2 font-normal" /></label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="text-sm font-medium text-gray-700">Build Kit files<input type="file" multiple accept=".json,.pdf,.xlsx,.xls,.csv,.ods,.ps1,.sh,.bat,.cmd,.txt,.md,.rtf,.xml" disabled={!!busy || !kitBenchmark.trim()} className="ml-3 max-w-full text-sm" onChange={e => {
            const files = Array.from(e.target.files ?? []); e.target.value = ""
            if (!files.length) return
            void perform("Converting Build Kit…", async () => {
              const kitFiles: KitFile[] = []
              for (const file of files) kitFiles.push({ path: file.name, content: await file.text() })
              setKitConversion(convertKit(kitFiles, { id: kitBenchmark.trim(), ...(kitVersion.trim() ? { version: kitVersion.trim() } : {}) }))
            })
          }} /></label>
          <label className="text-sm font-medium text-gray-700">Build Kit folder<input type="file" disabled={!!busy || !kitBenchmark.trim()} className="ml-3 max-w-full text-sm" {...{ webkitdirectory: "" }} onChange={e => {
            const files = Array.from(e.target.files ?? []); e.target.value = ""
            if (!files.length) return
            void perform("Converting Build Kit…", async () => {
              const kitFiles: KitFile[] = []
              for (const file of files) kitFiles.push({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, content: await file.text() })
              setKitConversion(convertKit(kitFiles, { id: kitBenchmark.trim(), ...(kitVersion.trim() ? { version: kitVersion.trim() } : {}) }))
            })
          }} /></label>
          <label className="text-sm font-medium text-gray-700">Denominator JSON (optional)<input type="file" accept=".json,application/json" disabled={!!busy} className="ml-3 max-w-full text-sm" onChange={e => {
            const file = e.target.files?.[0]; e.target.value = ""
            if (!file) return
            void perform("Reading denominator list…", async () => { setDenominator(parseDenominatorList(await file.text())) })
          }} /></label>
          <label className="text-sm font-medium text-gray-700">Recommendation list JSON (optional)<input type="file" accept=".json,application/json" disabled={!!busy} className="ml-3 max-w-full text-sm" onChange={e => {
            const file = e.target.files?.[0]; e.target.value = ""
            if (!file) return
            void perform("Reading recommendation list…", async () => { setRecommendationList(parseRecommendationList(await file.text())) })
          }} /></label>
        </div>
        <p className="mt-3 text-xs text-gray-500">Recommendation list shape: a JSON object with benchmark, version and items. Each item has identifier, level (1 or 2), automated (true or false), and optional title, description, impact, audit and remediation text. The file stays on this device and is saved with the imported pack in the workspace.</p>
        {recommendationList && <p className="mt-3 text-sm text-gray-600">{recommendationList.benchmark} {recommendationList.version}: {recommendationList.items.length} recommendations loaded, {recommendationList.items.filter(item => !item.automated).length} manual. Manual items appear in the readiness Manual section after a comparison.</p>}
        {denominator && <p className="mt-3 text-sm text-gray-600">{denominator.length} denominator entries loaded. Coverage uses the automated entries per Level.</p>}
        {kitConversion && <div className="mt-4 text-sm text-gray-700">
          <p>{kitConversion.summary.benchmark} {kitConversion.summary.version}: {kitConversion.summary.levels.map(level => `Level ${level.level}: ${level.policies} policies, ${level.settings} settings`).join("; ") || "no converted policies"}</p>
          {kitConversion.skipped.length > 0 && <p className="mt-2 text-gray-600">Skipped for coverage only: {kitConversion.skipped.map(item => item.path).join("; ")}</p>}
          <div className="mt-3 flex flex-wrap gap-2">{kitConversion.packs.map(pack => <button key={pack.level} type="button" className={button} disabled={!!busy} onClick={() => { reset(); setPolicies(pack.policies); setReference(pack.reference) }}>Load Level {pack.level} pack ({pack.policies.length} policies)</button>)}</div>
          <p className="mt-2 text-xs text-gray-500">Loading a pack saves it in the workspace for the selected tenant. Compare it with the tenant in step 2.</p>
        </div>}
      </div>}
      {policies.length > 0 && <>
        <button className={button} onClick={() => exportJson({ reference, ...packCoverage(policies) }, `${framework.id}-coverage.json`)}>Export coverage and source mappings</button>
        <p className="mt-3 text-xs text-gray-600">Unsupported: {UNSUPPORTED.join('; ')}. Retained source declarations are not signatures. Organizational evidence and profile approval remain manual.</p>
        <label className="mt-5 block text-sm font-medium text-gray-700">Source version / profile<input value={reference} maxLength={200} disabled={!!busy} onChange={e => { setReference(e.target.value); reset() }} placeholder="For example: approved workstation baseline, revision 3, standard profile" className="mt-2 w-full rounded-full border border-gray-300 px-4 py-2 font-normal" /></label>
        <details className="mt-4 text-sm"><summary className="cursor-pointer text-gray-700">Review {policies.length} loaded policies and remove alternative profiles</summary><ul className="mt-3 max-h-64 divide-y divide-gray-100 overflow-auto rounded-2xl bg-gray-50">{policies.map((p, i) => <li key={`${p.name}:${i}`} className="flex items-center justify-between gap-3 p-3"><span>{p.name}<span className="ml-2 text-xs text-gray-500">{p.settings.length} root settings</span></span><button disabled={!!busy} className="text-blue-700 hover:underline disabled:opacity-50" aria-label={`Remove ${p.name}`} onClick={() => { setPolicies(policies.filter((_, index) => index !== i)); reset() }}>Remove</button></li>)}</ul></details>
      </>}
    </section>
    <section aria-labelledby="compare-title" className="mt-5 rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="compare-title" className="text-xl font-medium tracking-tight">2. Compare with your tenant</h2><p className="mt-1 text-sm text-gray-600">{selectedTenant ? `Selected tenant: ${selectedTenant.name}` : "Choose a connected tenant using the sidebar."}</p></div>
        <button className={primary} disabled={!!busy || !credentials || !policies.length || !reference.trim()} onClick={() => void perform("Reading tenant policies and comparing settings…", async () => {
          reset(); const result = await request<Assessment>({ action: "assess", tenantId: credentials!.tenantId, appId: credentials!.appId, frameworkId: framework.id, reference, policies }); setAssessment(result); setWorkspace(await workspaceRequest("workspace-load"))
        })}>{assessment ? "Compare again" : "Run comparison"}</button></div>
      {busy && <p role="status" className="mt-4 text-sm text-blue-700">{busy}</p>}
      {error && <p role="alert" className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
      {assessment && <>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-gray-500"><p>{assessment.policyCount} tenant policies read · {new Date(assessment.assessedAt).toLocaleString()}</p><div className="flex flex-wrap gap-2">{(["pdf", "csv", "json"] as const).map(format => <ExportButton key={format} framework={framework} plan={plan} disabled={!!busy} onClick={() => exportSaved(format, assessment.runId)}><Download className="h-4 w-4" aria-hidden="true" />{format === "pdf" ? "PDF report" : format.toUpperCase()}</ExportButton>)}</div></div>
        {readiness && <section aria-label="CIS readiness" className="mb-5 rounded-2xl bg-gray-50 p-4 text-sm text-gray-700">
          <h3 className="font-medium text-gray-900">CIS readiness</h3>
          <p className="mt-2">{readiness.manualNote} This view covers the automated settings in the imported pack only.</p>
          {denominator || recommendationList ? <p className="mt-1">Coverage uses the imported denominator or recommendation list. Without it, coverage is not shown.</p> : <p className="mt-1">No denominator list was imported, so coverage is not shown.</p>}
          <div className="mt-3 overflow-auto"><table className="w-full text-left text-sm"><thead><tr className="text-gray-500"><th className="py-1 pr-3 font-medium">Benchmark</th><th className="py-1 pr-3 font-medium">Version</th><th className="py-1 pr-3 font-medium">Level</th><th className="py-1 pr-3 font-medium">Assessed settings</th><th className="py-1 pr-3 font-medium">Assessed automated</th><th className="py-1 pr-3 font-medium">Pass rate</th><th className="py-1 pr-3 font-medium">Coverage</th><th className="py-1 font-medium">Not assessed</th></tr></thead><tbody>{readiness.levels.map(level => <tr key={level.level} className="border-t border-gray-200"><td className="py-2 pr-3">{level.benchmark}</td><td className="py-2 pr-3">{level.version}</td><td className="py-2 pr-3">Level {level.level}</td><td className="py-2 pr-3">{level.assessedSettings} ({level.present} present, {level.different} different, {level.missing} missing, {level.review} review)</td><td className="py-2 pr-3">{level.assessedAutomated}</td><td className="py-2 pr-3">{level.passRate === null ? "Not available" : `${Math.round(level.passRate * 1000) / 10}%`}</td><td className="py-2 pr-3">{level.coverage === null ? "Not available" : `${Math.round(level.coverage * 1000) / 10}% (${level.assessedAutomated} of ${level.denominator})`}</td><td className="py-2">{level.notAssessed.length ? level.notAssessed.join(", ") : "None listed"}</td></tr>)}</tbody></table></div>
          {readiness.levels.map(level => level.manual.length > 0 && <div key={`manual-${level.level}`} className="mt-4">
            <h4 className="font-medium text-gray-900">Manual, Level {level.level}</h4>
            <p className="mt-1 text-xs text-gray-500">{readiness.benchmark} {readiness.version}, Level {level.level}. These items are not assessed automatically.</p>
            <div className="mt-2 space-y-2">{level.manual.map(item => <details key={item.identifier} className="rounded-2xl bg-white p-4">
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
          {readiness.levels.map(level => {
            const form = exceptionForms[level.level] ?? { policyName: "", settingId: "", owner: "", reason: "", expiresOn: "" }
            const updateForm = (patch: Partial<typeof form>) => setExceptionForms(old => ({ ...old, [level.level]: { ...(old[level.level] ?? form), ...patch } }))
            return <div key={`exceptions-${level.level}`} className="mt-4 border-t border-gray-200 pt-4">
              <h4 className="font-medium text-gray-900">Exceptions, Level {level.level} ({level.excepted} excepted)</h4>
              <p className="mt-1 text-xs text-gray-500">Adjusted pass rate: {level.adjustedPassRate === null ? "Not available" : `${Math.round(level.adjustedPassRate * 1000) / 10}%`}. Raw counts above are unchanged.</p>
              {level.exceptions.length ? <ul className="mt-2 space-y-2">{level.exceptions.map(exception => <li key={exception.id} className="flex flex-wrap items-start justify-between gap-3 rounded-2xl bg-white p-3">
                <span><span className="font-medium text-gray-800">{exception.policyName}</span><span className="block break-all font-mono text-xs text-gray-500">{exception.settingId}</span><span className="block text-xs text-gray-600">Owner: {exception.owner} · Expires: {exception.expiresOn}</span><span className="block text-xs text-gray-600">{exception.reason}</span></span>
                <button type="button" className={button} disabled={!!busy} onClick={() => void perform("Removing exception...", async () => { const saved = await workspaceRequest("workspace-cis-exception-remove", { exceptionId: exception.id }); setWorkspace(saved) })}>Remove</button>
              </li>)}</ul> : <p className="mt-2 text-xs text-gray-500">No active exceptions for this level.</p>}
              <form className="mt-3 grid gap-2 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); void perform("Saving exception...", async () => { const saved = await workspaceRequest("workspace-cis-exception-add", { benchmark: readiness.benchmark, version: readiness.version, level: level.level, policyName: form.policyName, settingId: form.settingId, owner: form.owner, reason: form.reason, expiresOn: form.expiresOn }); setWorkspace(saved); updateForm({ policyName: "", settingId: "", owner: "", reason: "", expiresOn: "" }) }) }}>
                <label className="block text-xs font-medium text-gray-700">Policy name<input value={form.policyName} disabled={!!busy} onChange={e => updateForm({ policyName: e.target.value })} className="mt-1 w-full rounded-full border border-gray-300 px-3 py-1.5 text-sm font-normal" /></label>
                <label className="block text-xs font-medium text-gray-700">Setting id<input value={form.settingId} disabled={!!busy} onChange={e => updateForm({ settingId: e.target.value })} className="mt-1 w-full rounded-full border border-gray-300 px-3 py-1.5 text-sm font-normal" /></label>
                <label className="block text-xs font-medium text-gray-700">Owner<input value={form.owner} disabled={!!busy} onChange={e => updateForm({ owner: e.target.value })} className="mt-1 w-full rounded-full border border-gray-300 px-3 py-1.5 text-sm font-normal" /></label>
                <label className="block text-xs font-medium text-gray-700">Expiry date<input type="date" value={form.expiresOn} disabled={!!busy} onChange={e => updateForm({ expiresOn: e.target.value })} className="mt-1 w-full rounded-full border border-gray-300 px-3 py-1.5 text-sm font-normal" /></label>
                <label className="block text-xs font-medium text-gray-700 sm:col-span-2">Reason<input value={form.reason} disabled={!!busy} onChange={e => updateForm({ reason: e.target.value })} className="mt-1 w-full rounded-full border border-gray-300 px-3 py-1.5 text-sm font-normal" /></label>
                <div className="sm:col-span-2"><button type="submit" className={button} disabled={!!busy}>Accept as exception</button></div>
              </form>
            </div>
          })}
          {trend.length >= 2 && <div className="mt-4 border-t border-gray-200 pt-4">
            <h4 className="font-medium text-gray-900">Trend</h4>
            <p className="mt-1 text-xs text-gray-500">Pass rate across saved assessments for this tenant. Change is in percentage points from the previous saved assessment. Adjusted rates use exceptions accepted by then.</p>
            <div className="mt-3 overflow-auto"><table className="w-full text-left text-sm"><thead><tr className="text-gray-500"><th className="py-1 pr-3 font-medium">Date</th><th className="py-1 pr-3 font-medium">Benchmark</th><th className="py-1 pr-3 font-medium">Version</th>{trendLevels.map(level => <th key={`trend-head-${level}`} className="py-1 pr-3 font-medium">Level {level} pass rate</th>)}{trendLevels.map(level => <th key={`trend-change-head-${level}`} className="py-1 pr-3 font-medium">Level {level} change</th>)}</tr></thead><tbody>{trend.map((point, pointIndex) => <tr key={point.runId} className="border-t border-gray-200"><td className="py-2 pr-3">{point.assessedAt}</td><td className="py-2 pr-3">{point.benchmark}</td><td className="py-2 pr-3">{point.version}</td>{trendLevels.map(level => { const item = point.levels.find(entry => entry.level === level); return <td key={`trend-rate-${point.runId}-${level}`} className="py-2 pr-3">{item ? formatTrendPercent(item.passRate) : "Not available"}{item && item.adjustedPassRate !== null && item.adjustedPassRate !== item.passRate ? ` (adjusted ${formatTrendPercent(item.adjustedPassRate)})` : ""}</td> })}{trendLevels.map(level => { const item = point.levels.find(entry => entry.level === level); return <td key={`trend-change-${point.runId}-${level}`} className="py-2 pr-3">{item ? formatTrendChange(item.changeFromPrevious, pointIndex === 0) : "Not available"}</td> })}</tr>)}</tbody></table></div>
            <div className="mt-3 flex flex-wrap gap-4">{trendLevels.map(level => <div key={`trend-spark-${level}`} className="flex items-center gap-2 text-gray-700"><span className="text-xs font-medium text-gray-500">Level {level}</span><TrendSparkline points={trend} level={level} /></div>)}</div>
          </div>}
          <div className="mt-3 flex flex-wrap items-start gap-2"><GovernanceExportButtons kind="cis-readiness" tenantName={selectedTenant?.name ?? null} disabled={!!busy} buildCsv={() => cisReadinessCsv(readiness)} buildJson={exportedAt => cisReadinessJson(readiness, selectedTenant?.name ?? null, exportedAt)} /><ExportButton framework={framework} plan={plan} disabled={!!busy} onClick={() => void perform("Exporting PDF…", async () => { const { file } = await request<{ file: ExportFile }>({ action: "workspace-cis-pdf", tenantId: credentials?.tenantId, tenantName: selectedTenant?.name, frameworkId: framework.id, runId: assessment.runId, ...(denominator ? { denominator } : {}) }); saveExport(file) })}><Download className="h-4 w-4" aria-hidden="true" />Export PDF</ExportButton></div>
        </section>}
        <div className="my-4 flex flex-wrap gap-2" aria-label="Filter assessment findings">{["All", "Present", "Missing", "Different", "Review"].map(status => <button key={status} aria-pressed={filter === status} onClick={() => { setFilter(status); setPage(0) }} className={`rounded-full border px-4 py-2 text-sm transition-colors ${filter === status ? "border-transparent bg-primary text-primary-foreground" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>{status} <span className="ml-1 font-semibold">{assessment.findings.filter(f => status === "All" || f.status === status).length}</span></button>)}</div>
        <p className="mb-4 text-xs leading-5 text-gray-500">Different: at least one existing configuration differs. Review: the pack contains alternative values for this setting. Select a single profile or resolve differences manually. Unassigned configurations can appear as Present. Expand a finding to inspect assignment evidence, including exclusions, filter references and unavailable reads.</p>
        <div className="space-y-2">{findings.slice(page * 50, (page + 1) * 50).map(f => <FindingRow key={f.key} finding={f} disabled={!!busy || !!creation || historical || (!!framework.comparisonOnly && framework.id !== "cis-benchmarks")} remediable={framework.id === "cis-benchmarks"} checked={selected.has(f.key)} onChange={() => { setSelected(old => { const next = new Set(old); next.has(f.key) ? next.delete(f.key) : next.add(f.key); return next }); setPreview(false); setConfirmed(false) }} />)}</div>
        {findings.length > 50 && <div className="mt-4 flex items-center justify-between gap-3"><button className={button} disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span className="text-sm text-gray-500">Page {page + 1} of {Math.ceil(findings.length / 50)}</span><button className={button} disabled={(page + 1) * 50 >= findings.length} onClick={() => setPage(page + 1)}>Next</button></div>}
        {!findings.length && <p role="status" className="py-6 text-center text-sm text-gray-500">No findings in this category.</p>}
        {framework.id === "cis-benchmarks" ? <CisRemediationPanel tenant={selectedTenant ?? undefined} assessment={assessment} policies={policies} reference={reference} selectedKeys={selected} onRecompare={() => void perform("Reading tenant policies and comparing settings...", async () => { reset(); const result = await request<Assessment>({ action: "assess", tenantId: credentials!.tenantId, appId: credentials!.appId, frameworkId: framework.id, reference, policies }); setAssessment(result); setWorkspace(await workspaceRequest("workspace-load")) })} /> : framework.comparisonOnly ? <p className="mt-5 border-t pt-4 text-sm text-gray-600">This pack is available for comparison and reports only. Review missing settings and configure them through your own change process.</p>
        : <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-sm text-gray-600">{chosen.length} missing root settings selected · {payloads.length} new {payloads.length === 1 ? "policy" : "policies"}</p><button className={primary} disabled={!chosen.length || !!busy || !!creation || historical} onClick={() => { setPreview(true); setConfirmed(false) }}>Preview recommended policies</button></div>}
      </>}
    </section>
    {preview && !framework.comparisonOnly && <section aria-labelledby="preview-title" className="mt-5 rounded-3xl border-2 border-blue-200 bg-white p-7"><h2 id="preview-title" className="text-xl font-medium tracking-tight">3. Review unassigned policies</h2><p className="mt-2 text-sm text-gray-600">Create {payloads.length} new {payloads.length === 1 ? "policy" : "policies"} in <strong>{selectedTenant?.name}</strong> using the selected missing settings and their nested dependencies. Existing policies stay unchanged. Review target groups and conflicts in Intune before assigning these policies.</p><details className="mt-4"><summary className="cursor-pointer text-sm font-medium">Inspect the exact policy payloads</summary><pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-gray-950 p-4 text-xs text-gray-100">{JSON.stringify(payloads, null, 2)}</pre></details><label className="mt-5 flex items-start gap-3 text-sm"><input type="checkbox" checked={confirmed} disabled={!!busy || !!creation} onChange={e => setConfirmed(e.target.checked)} className="mt-1 h-4 min-h-0 w-4 shrink-0" /><span>I reviewed these recommendations and want to create unassigned policies in {selectedTenant?.name}.</span></label><button className={`${primary} mt-4`} disabled={!confirmed || !!busy || !!creation} onClick={() => void perform("Rechecking tenant policies and creating unassigned policies…", async () => {
      const result = await request<NonNullable<typeof creation>>({ action: "create", tenantId: credentials!.tenantId, appId: credentials!.appId, runId: assessment!.runId, keys: [...selected], confirmUnassigned: true }); setCreation(result); setWorkspace(await workspaceRequest("workspace-load"))
    })}>Create {payloads.length} unassigned {payloads.length === 1 ? "policy" : "policies"}</button>
    {creation && <div role="status" className={`mt-4 rounded-3xl p-5 text-sm ${creation.success ? "bg-green-50 text-green-900" : "bg-amber-50 text-amber-950"}`}><strong>{creation.success ? "Unassigned policies created. Assignment and device verification are still required." : "Some policies could not be created. Review each result before comparing again."}</strong><ul className="mt-3 space-y-2">{creation.results.map((r, i) => <li key={i}>{r.name}: {r.error || `Created (${r.id})`}</li>)}</ul></div>}</section>}
  </div>
}


function FindingRow({ finding, checked, disabled, onChange, remediable = false }: { finding: Finding; checked: boolean; disabled: boolean; onChange: () => void; remediable?: boolean }) {
  const colors = { Present: "bg-green-50 text-green-800", Missing: "bg-amber-50 text-amber-900", Different: "bg-red-50 text-red-800", Review: "bg-gray-100 text-gray-700" }
  return <div className="flex items-start gap-3 rounded-2xl bg-gray-50 p-4">
    <input type="checkbox" aria-label={`Select missing setting ${finding.settingId} from ${finding.policyName}`} checked={checked} disabled={disabled || (finding.status !== "Missing" && !(remediable && finding.status === "Different"))} onChange={onChange} className="mt-1 h-4 min-h-0 w-4 shrink-0" />
    <details className="min-w-0 flex-1"><summary className="cursor-pointer text-sm"><span className="font-medium text-gray-800">{finding.policyName}</span><span className={`ml-2 inline-block rounded-full px-2.5 py-0.5 text-xs ${colors[finding.status]}`}>Configuration: {finding.status}</span><span className="mt-1 block break-all font-mono text-xs leading-5 text-gray-500">{finding.settingId}</span></summary><div className="mt-3 grid gap-3 xl:grid-cols-2"><div><p className="mb-2 text-xs font-semibold text-gray-600">Recommended configuration</p><pre className="max-h-72 overflow-auto rounded-2xl bg-white p-3 text-xs">{JSON.stringify(finding.recommended, null, 2)}</pre></div><div><p className="mb-2 text-xs font-semibold text-gray-600">Observed policies and configuration</p><pre className="max-h-72 overflow-auto rounded-2xl bg-white p-3 text-xs">{finding.observed.length ? JSON.stringify(finding.observed, null, 2) : "No matching root setting found in the assessed policy family."}</pre></div></div></details>
  </div>
}
