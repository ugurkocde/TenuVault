import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { ChevronDown, ChevronRight, Download, FileText, History, LoaderCircle, RotateCcw, ShieldCheck, Trash2 } from "lucide-react"
import { cn } from "~/lib/utils"
import { queryClient } from "~/lib/query-client"
import { invalidateScores } from "../../features/scores/invalidate"
import { VALIDATED_FOLDERS } from "../../../shared/oib/compare"
import { policyTypeName } from "../../../shared/oib/licensing"
import { validationJson } from "../../../shared/oib/validation-export"
import { reportHtml, toCsv } from "../../../shared/oib/report"
import { isFullValidation, OIB_PLATFORMS, type OibCatalog, type OibPlatform, type PolicyValidation as Validation, type SettingDiff, type ValidationRun } from "../../../shared/oib/types"
import { NO_VALIDATION_FILTER, validationFilterView, type ValidationFilter, type ValidationFilterItem, type ValidationResultFilter } from "../../../shared/oib/validation-filter"
import { FilterChips, FilterSelect, SearchInput } from "../FilterControls"
import { PlanBadge } from "../UpgradeNote"
import { GatedButton } from "../PlanGate"
import { RunsList } from "./DeployPanel"
import { joinRows, MatchNotes, StatusBadge } from "./ExistingDeployment"
import { button, card, errorText, GUID, oibRequest, PlatformPicker, platformsLabel, primary, StatCard, useOibTenant, versionsLabel, type OibTenant, type Selections } from "./common"
import { batchFor } from "./deploy-sequence"
import { ActionBar, FlowShell } from "./FlowShell"
import { clearJob, jobProgress, startJob, useJobFinished, useOibJob } from "./jobs"
import { LoadProgress, usePlatformLoader } from "./LoadProgress"
import { Notice, savePdf, saveText, useSaveNotice } from "./notices"
import { ReviewDeploy, type DeployOutcome } from "./ReviewDeploy"
import { ChangeVersions } from "./Versions"

type Row = ReturnType<typeof joinRows>[number]
type Shown = Validation & { platform: OibPlatform }
type Step = "platforms" | "results" | "fix" | "saved"
/** What a Validate all job keeps, so its results can be shown again after leaving the page. */
interface ValidateAll { platforms: OibPlatform[]; runs: ValidationRun[] }

const key = (platform: OibPlatform, source: string) => `${platform}\n${source}`
const STATUS: Record<Validation["status"], { label: string; tone: string }> = {
  compliant: { label: "Matches the baseline", tone: "bg-green-100 text-green-800" },
  drifted: { label: "Drift detected", tone: "bg-amber-100 text-amber-900" },
  unsupported: { label: "Not validated", tone: "bg-gray-100 text-gray-700" },
  error: { label: "Validation error", tone: "bg-red-100 text-red-800" },
}
const STEPS = [{ id: "platforms", label: "Platforms" }, { id: "results", label: "Results" }]
const today = () => new Date().toISOString().slice(0, 10)
const count = (results: Validation[], status: Validation["status"]) => results.filter(r => r.status === status).length
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "Validated 13 policies: 6 match, 5 drift, 2 errors" */
const validatedText = (results: Validation[]) =>
  `Validated ${plural(results.length, "policy", "policies")}: ${count(results, "compliant")} match, ${count(results, "drifted")} drift, ${plural(count(results, "error"), "error", "errors")}`

/** The tenant policy's name; the service stores the object ID when it could not read the policy. */
const tenantName = (r: Validation, names?: Map<string, string>) =>
  r.tenantPolicyName && !GUID.test(r.tenantPolicyName) && r.tenantPolicyName !== r.tenantPolicyId ? r.tenantPolicyName : names?.get(r.tenantPolicyId) ?? "Name not read (the policy could not be opened)"

function deviations(result: Validation): string[][] {
  if (result.status === "error") return [["Error", "", "", result.error ?? ""]]
  if (!result.result) return []
  return [
    ...result.result.mismatches.map(d => ["Value mismatch", `${d.label}${d.path ? ` (${d.path})` : ""}`, d.oibValue ?? "", d.tenantValue ?? ""]),
    ...result.result.oibOnly.map(d => ["Missing in tenant", d.label, d.oibValue ?? "(configured)", "(not set)"]),
    ...result.result.tenantOnly.map(d => ["Only in tenant", d.label, "(not set)", d.tenantValue ?? "(configured)"]),
  ]
}

function csvOf(results: Shown[]): string {
  const rows = [["Platform", "OIB policy", "Tenant policy", "Status", "Deviation", "Setting", "OIB value", "Tenant value"]]
  for (const r of results) {
    const found = deviations(r)
    if (!found.length) rows.push([OIB_PLATFORMS[r.platform].label, r.name, r.tenantPolicyName, STATUS[r.status].label, "", "", "", ""])
    for (const d of found) rows.push([OIB_PLATFORMS[r.platform].label, r.name, r.tenantPolicyName, STATUS[r.status].label, ...d])
  }
  return toCsv(rows)
}

function pdfOf(results: Shown[], tenantName: string, reference: string, validatedAt: string): string {
  return reportHtml({
    title: "OpenIntuneBaseline policy validation",
    subtitle: reference,
    meta: [["Tenant", tenantName], ["Validated", new Date(validatedAt).toLocaleString()], ["Policies", String(results.length)], ["Scope", "Setting-level comparison of matched policies. Read-only: nothing was changed in the tenant."]],
    summary: [["Match the baseline", String(count(results, "compliant"))], ["Drift detected", String(count(results, "drifted"))], ["Not validated", String(count(results, "unsupported"))], ["Errors", String(count(results, "error"))]],
    sections: [
      { heading: "Summary", columns: ["Platform", "OIB policy", "Tenant policy", "Status", "Settings matched"], rows: results.map(r => [OIB_PLATFORMS[r.platform].label, r.name, r.tenantPolicyName, STATUS[r.status].label, r.result ? `${r.result.matched} of ${r.result.totalOib}` : ""]) },
      ...results.filter(r => r.status === "drifted" || r.status === "error").map(r => ({ heading: r.name, note: `Tenant policy: ${r.tenantPolicyName}`, columns: ["Deviation", "Setting", "OIB value", "Tenant value"], rows: deviations(r) })),
    ],
    footer: `OpenIntuneBaseline content: SkipToTheEndpoint and contributors, GPL-3.0. Generated by TenuVault on ${new Date().toLocaleString()}.`,
  })
}

/**
 * Validates matched policies of one pack; `save` asks to keep the run under Saved validations.
 * Only a validation of every matched policy ("all") sets the OIB baseline score; a single-policy
 * check is kept in history only. `saved` says whether the run was actually kept.
 */
const validateRequest = async (tenant: OibTenant, catalog: OibCatalog, rows: Row[], save: boolean, selection: "all" | "single"): Promise<{ run: ValidationRun; saved: boolean }> => {
  const { saved, ...run } = await requestValidation(tenant, catalog, rows, save, selection)
  return { run, saved: saved !== false }
}

/** The notice after a single-policy check, accurate about whether Saved validations kept it. */
export function singleCheckNotice(policyName: string, status: string, saved: boolean): string {
  return saved
    ? `${policyName}: ${status}. Saved under Saved validations.`
    : `${policyName}: ${status}. This result was not saved because Saved validations is full of Validate all results, which are kept first. Export the results to keep it, or delete older saved validations below to make room.`
}

const requestValidation = (tenant: OibTenant, catalog: OibCatalog, rows: Row[], save: boolean, selection: "all" | "single") => oibRequest<ValidationRun & { saved?: boolean }>({
  action: "oib-validate", tenantId: tenant.tenantId, appId: tenant.appId, platform: catalog.platform, commit: catalog.commit, ...(catalog.tag ? { tag: catalog.tag } : {}),
  items: rows.map(r => ({ source: r.policy.source, targetId: r.match.tenant!.id })), save, selection,
})

function DiffTable({ title, items, kind }: { title: string; items: SettingDiff[]; kind: "mismatch" | "oib" | "tenant" }) {
  const [open, setOpen] = useState(kind === "mismatch")
  if (!items.length) return null
  return <div className="mt-3">
    <button type="button" className="flex items-center gap-1 text-xs font-medium text-gray-700" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}{title} ({items.length})</button>
    {open && <div className="mt-2 overflow-x-auto"><table className="w-full table-fixed text-left text-xs">
      <thead><tr className="text-gray-500"><th className="w-2/5 py-1 pr-2 font-medium">Setting</th>{kind !== "tenant" && <th className="py-1 pr-2 font-medium">OIB value</th>}{kind !== "oib" && <th className="py-1 font-medium">Tenant value</th>}</tr></thead>
      <tbody>{items.map((item, i) => <tr key={i} className="border-t border-gray-100 align-top">
        <td className="break-words py-1 pr-2" title={item.settingDefinitionId}>{item.label}{item.path && <span className="block text-gray-500">{item.path}</span>}</td>
        {kind !== "tenant" && <td className="break-all py-1 pr-2 font-mono">{item.oibValue}</td>}
        {kind !== "oib" && <td className="break-all py-1 font-mono">{item.tenantValue}</td>}
      </tr>)}</tbody>
    </table></div>}
  </div>
}

const RESULT_FILTERS: Array<{ value: ValidationResultFilter; label: string }> = [
  { value: "all", label: "All" }, { value: "compliant", label: "Matches" }, { value: "drifted", label: "Drift" }, { value: "error", label: "Errors" }, { value: "other", label: "Not validated" },
]
const describeShown = (r: Shown): ValidationFilterItem => ({ text: [r.name, r.tenantPolicyName, OIB_PLATFORMS[r.platform].label], platform: r.platform, status: r.status })

/** Search, result and platform for a validation list; the list renders `view.shown`. */
function ValidationFilterBar({ view, total, filter, onChange }: { view: ReturnType<typeof validationFilterView<unknown>>; total: number; filter: ValidationFilter; onChange: (filter: ValidationFilter) => void }) {
  return <div className="mt-4 flex flex-wrap items-center gap-3">
    <SearchInput label="Search policies" value={filter.query} onChange={query => onChange({ ...filter, query })} placeholder="Search OIB or tenant policy" />
    <FilterChips label="Filter by result" value={view.effective.result} onChange={result => onChange({ ...filter, result })} options={RESULT_FILTERS.map(option => ({ ...option, count: view.count(option.value) }))} />
    {view.platforms.length > 1 && <FilterSelect label="Filter by platform" value={view.effective.platform} onChange={platform => onChange({ ...filter, platform })}
      options={[{ value: "" as const, label: "All platforms" }, ...view.platforms.map(platform => ({ value: platform, label: OIB_PLATFORMS[platform].label }))]} />}
    <span className="text-sm text-gray-500 lg:ml-auto">
      <span aria-live="polite">{view.active ? `${view.shown.length} of ${total} policies shown.` : ""}</span>
      {view.active && <>{" "}<button type="button" className="font-medium text-gray-700 underline" onClick={() => onChange(NO_VALIDATION_FILTER)}>Clear filters</button></>}
    </span>
  </div>
}

function ResultDetails({ result }: { result: Validation }) {
  if (result.status === "error" || result.status === "unsupported") return <p className="mt-2 text-xs text-gray-600">{result.error}</p>
  if (!result.result) return null
  if (result.result.compliant) return <p className="mt-2 text-xs text-green-800">All {result.result.totalOib} settings match the OIB baseline.</p>
  return <div>
    <DiffTable title="Value mismatches" items={result.result.mismatches} kind="mismatch" />
    <DiffTable title="Missing in tenant" items={result.result.oibOnly} kind="oib" />
    <DiffTable title="Only in tenant" items={result.result.tenantOnly} kind="tenant" />
  </div>
}

/** OIBDeployer's Policy Validation: setting-level drift of matched policies, read-only, with history and Fix drift (Pro). */
export function PolicyValidation({ selections }: { selections: Selections }) {
  const { tenant, can, plan } = useOibTenant()
  const job = useOibJob<ValidateAll>(tenant?.tenantId, { kind: "validate", flow: "validate" })
  const fixJob = useOibJob<DeployOutcome[]>(tenant?.tenantId, { kind: "fix", flow: "validate" })
  // Returning to the page: a fix job opens its progress or result, a validation its results.
  const [initial] = useState(() => {
    const platforms = job?.result?.platforms.length ? job.result.platforms : [...new Set(fixJob?.result?.map(o => o.platform) ?? [])]
    return { platforms, step: (fixJob && !fixJob.finishedAt ? "fix" : job && platforms.length ? "results" : "platforms") as Step }
  })
  const [step, setStep] = useState<Step>(initial.step)
  const [platforms, setPlatforms] = useState<OibPlatform[]>(initial.platforms)
  const loader = usePlatformLoader(tenant, selections, platforms)
  const [singles, setSingles] = useState<ValidationRun[]>([])
  const [checking, setChecking] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [history, setHistory] = useState<ValidationRun[]>([])
  const [viewing, setViewing] = useState<{ run: ValidationRun; from: Step } | null>(null)
  const [deleting, setDeleting] = useState<{ runId: string; busy?: boolean } | null>(null)
  const [historyError, setHistoryError] = useState("")
  const [fixing, setFixing] = useState<{ row: Row; catalog: OibCatalog; changes: number } | null>(null)
  const [notice, setNotice] = useState("")
  const [filter, setFilter] = useState<ValidationFilter>(NO_VALIDATION_FILTER)
  const [error, setError] = useState("")
  const exports = useSaveNotice()
  const refreshHistory = () => tenant ? oibRequest<{ runs: ValidationRun[] }>({ action: "oib-validations", tenantId: tenant.tenantId }).then(r => setHistory(r.runs)).catch(() => setHistory([])) : Promise.resolve()
  useEffect(() => { void refreshHistory() }, [tenant?.tenantId])
  useEffect(() => { if (initial.platforms.length) loader.start() }, [])
  useJobFinished(job, () => void refreshHistory())
  if (!tenant) return null

  const validating = !!job && !job.finishedAt
  const matched = joinRows(loader.loaded).filter(r => r.match.tenant && ["current", "outdated", "newer"].includes(r.match.status))
  const supported = matched.filter(r => VALIDATED_FOLDERS.includes(r.policy.folder))
  const names = new Map(matched.map(r => [r.match.tenant!.id, r.match.tenant!.name]))
  // Validate all and single checks of this session, oldest first, so the newest result of a policy wins.
  const runs = [...(job?.result?.runs ?? []), ...singles].sort((a, b) => a.validatedAt.localeCompare(b.validatedAt))
  const results = new Map<string, Validation>()
  for (const run of runs) for (const r of run.results) results.set(key(run.platform, r.source), r)
  const current: Shown[] = [...results.entries()].map(([k, r]) => ({ ...r, platform: k.split("\n")[0] as OibPlatform, tenantPolicyName: tenantName(r, names) }))
  const validatedAt = runs.at(-1)?.validatedAt ?? ""
  const reference = loader.loaded.map(l => l.catalog.reference).join("; ")
  const canFix = can("driftRevert")
  const storage = !!tenant.storageAccountName
  const busy = validating || !!checking
  const summary = notice || (job?.finishedAt && job.result?.runs.length ? `${validatedText(job.result.runs.flatMap(r => r.results))}.` : "")

  function goto(next: Step) {
    if (next === "platforms") {
      // Going back starts over; the results stay under Saved validations.
      if (job?.finishedAt) clearJob(job.id)
      setSingles([]); setNotice(""); setError(""); setFilter(NO_VALIDATION_FILTER); exports.clear()
    }
    if (next === "results" && !loader.loaded.length && !loader.busy) {
      if (!platforms.length) { setStep("platforms"); return }
      loader.start()
    }
    setStep(next)
  }

  function validateAll() {
    setError(""); setNotice(""); exports.clear()
    const t = tenant!, chosen = platforms
    const groups = loader.loaded.map(({ catalog }) => ({ catalog, rows: supported.filter(r => r.platform === catalog.platform) })).filter(g => g.rows.length)
    try {
      void startJob<ValidateAll>({ tenantId: t.tenantId, tenantName: t.name, kind: "validate", flow: "validate", label: `Validating ${t.name}`, stage: "Validating settings" }, async ctx => {
        const done: ValidationRun[] = [], failures: string[] = []
        ctx.setResult({ platforms: chosen, runs: [] })
        for (const { catalog, rows } of groups) {
          if (groups.length > 1) ctx.update({ detail: OIB_PLATFORMS[catalog.platform].label })
          // One platform failing does not stop the others.
          try { done.push((await validateRequest(t, catalog, rows, true, "all")).run); invalidateScores(queryClient) } catch (e) { failures.push(`${OIB_PLATFORMS[catalog.platform].label}: ${errorText(e)}`) }
          ctx.setResult({ platforms: chosen, runs: [...done] })
        }
        if (failures.length) throw new Error(`Some platforms were not validated. ${failures.join(" ")}`)
        return { platforms: chosen, runs: done }
      })
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function validateOne(row: Row, catalog?: OibCatalog) {
    const pack = catalog ?? loader.loaded.find(l => l.catalog.platform === row.platform)?.catalog
    if (!pack) return
    setChecking(key(row.platform, row.policy.source)); setError(""); setNotice(""); exports.clear()
    try {
      const { run, saved } = await validateRequest(tenant!, pack, [row], true, "single")
      invalidateScores(queryClient)
      setSingles(s => [...s, run])
      const status = run.results[0]?.status
      setNotice(singleCheckNotice(row.policy.name, status ? STATUS[status].label.toLowerCase() : "validated", saved))
      void refreshHistory()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setChecking(null)
    }
  }

  function openFix(row: Row) {
    const catalog = loader.loaded.find(l => l.catalog.platform === row.platform)?.catalog
    const result = results.get(key(row.platform, row.policy.source))?.result
    if (!catalog) return
    setFixing({ row, catalog, changes: result ? result.mismatches.length + result.oibOnly.length + result.tenantOnly.length : 0 })
    setStep("fix")
  }

  async function deleteSaved(runId: string) {
    setDeleting({ runId, busy: true }); setHistoryError("")
    try {
      setHistory((await oibRequest<{ runs: ValidationRun[] }>({ action: "oib-validation-delete", tenantId: tenant!.tenantId, runId })).runs)
      invalidateScores(queryClient)
      if (viewing?.run.runId === runId) { setStep(viewing.from); setViewing(null); setFilter(NO_VALIDATION_FILTER) }
      setDeleting(null)
    } catch (e) {
      setHistoryError(errorText(e, "The saved validation could not be deleted.")); setDeleting(null)
    }
  }

  // `label` keeps the file names apart: "session 2026-10-01", "saved 2026-09-30", "history 2026-10-01".
  const exportJson = (list: ValidationRun[], label: string) => void exports.save(() => saveText(validationJson(list, tenant.tenantId, tenant.name, new Date().toISOString()), `OIB validation ${tenant.name} ${label}.json`))
  const exportCsv = (list: Shown[], label: string) => void exports.save(() => saveText(csvOf(list), `OIB validation ${tenant.name} ${label}.csv`))
  const exportPdf = (list: Shown[], label: string, ref: string, at: string) => void exports.save(() => savePdf(pdfOf(list, tenant.name, ref, at), `OIB validation ${tenant.name} ${label}`))
  const barSummary = (text?: string) => (text || exports.result || exports.saving) ? <div className="space-y-2">
    {text && <p>{text}</p>}
    {exports.saving && <p className="flex items-center gap-2 text-blue-700"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Preparing the export</p>}
    <Notice result={exports.result} onDismiss={exports.clear} />
  </div> : undefined

  const steps = step === "fix" ? [...STEPS, { id: "fix", label: "Fix drift" }] : step === "saved" ? [{ id: "saved", label: "Saved validation" }] : STEPS
  // A running Validate all (or its results) shows at once on return, while the packs load again behind it.
  const jobShown = validating || !!job?.result?.runs.length
  const loading = loader.busy && !loader.loaded.length && !jobShown
  const failedOnly = !loader.busy && !loader.loaded.length && loader.failed.length > 0 && !jobShown
  const saved = viewing?.run
  const savedResults: Shown[] = saved ? saved.results.map(r => ({ ...r, platform: saved.platform, tenantPolicyName: tenantName(r, names) })) : []
  // The list narrows by search, result and platform; exports and the counts above it keep every policy.
  const rowView = validationFilterView(matched, filter, row => ({ text: [row.policy.name, row.match.tenant!.name, policyTypeName(row.policy.policyType), OIB_PLATFORMS[row.platform].label], platform: row.platform, status: results.get(key(row.platform, row.policy.source))?.status }))
  const currentView = validationFilterView(current, filter, describeShown)
  const savedView = validationFilterView(savedResults, filter, describeShown)
  const listView = matched.length ? rowView : currentView
  const listTotal = matched.length || current.length
  const noMatch = <li className="p-6 text-center text-sm text-gray-500">No policies match the filters. <button type="button" className="font-medium underline" onClick={() => setFilter(NO_VALIDATION_FILTER)}>Clear filters</button></li>

  return <>
    <FlowShell title="Policy Validation" steps={steps} step={step} focusKey={step === "saved" ? `saved:${saved?.runId}` : step} focusOnMount={initial.step !== "platforms"} onStep={id => goto(id as Step)} locked={loader.busy || busy || !!(fixJob && !fixJob.finishedAt)}
      heading={step === "platforms" ? "Choose the platforms to validate" : step === "results" ? "Validation results" : step === "saved" && saved ? `Saved validation of ${new Date(saved.validatedAt).toLocaleString()}` : undefined}>
      {step === "platforms" && <>
        <p className="text-sm text-gray-600">Check deployed OpenIntuneBaseline policies for setting-level drift against the baseline. Validation only reads the tenant.</p>
        <div className="mt-5"><PlatformPicker value={platforms} onChange={setPlatforms} /></div>
        <ChangeVersions platforms={platforms} />
        <ActionBar summary={platforms.length ? `${platformsLabel(platforms)} selected` : "Select at least one platform"}>
          <button type="button" className={primary} disabled={!platforms.length} onClick={() => { setStep("results"); loader.start() }}>Continue</button>
        </ActionBar>
      </>}

      {step === "results" && (loading || failedOnly ? <>
        <LoadProgress loader={loader} platforms={platforms} selections={selections} />
        <ActionBar status={loader.line} error={failedOnly ? "Nothing could be loaded. Retry a platform above or go back." : undefined} back={{ onClick: () => goto("platforms") }} />
      </> : <>
        {loader.loaded.length > 0 && <p className="text-sm text-gray-600">Validating against OpenIntuneBaseline {versionsLabel(loader.loaded.map(l => l.catalog))}. Settings Catalog, Endpoint security, compliance, update rings, driver updates, Endpoint Analytics and administrative templates are compared setting by setting. Duplicates are skipped.</p>}
        {loader.failed.length > 0 && <div className="mt-5"><LoadProgress loader={loader} platforms={loader.failed} selections={selections} /></div>}
        <MatchNotes loaded={loader.loaded} />
        {current.length > 0 ? <div className="mt-5 grid gap-3 sm:grid-cols-4">
          <StatCard label="Match the baseline" value={count(current, "compliant")} tone="green" />
          <StatCard label="Drift detected" value={count(current, "drifted")} tone="amber" />
          <StatCard label="Errors" value={count(current, "error")} tone="red" />
          <StatCard label="Validated" value={loader.loaded.length ? `${count(current, "compliant") + count(current, "drifted")}/${supported.length}` : count(current, "compliant") + count(current, "drifted")} />
        </div> : !validating && supported.length > 0 && <div className="mt-5 flex flex-wrap items-center gap-4 rounded-2xl bg-blue-50 p-5">
          <ShieldCheck className="h-6 w-6 shrink-0 text-blue-700" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm text-gray-800"><strong className="font-medium">Next: select Validate all</strong> to compare the {plural(supported.length, "matched policy", "matched policies")} setting by setting. Nothing in the tenant changes, and the result is kept under Saved validations.</p>
        </div>}
        {current.length > 0 && <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={button} disabled={busy || exports.saving || !runs.length} onClick={() => exportJson(runs, `session ${today()}`)}><Download className="h-4 w-4" aria-hidden="true" />Export session JSON</button>
          <button type="button" className={button} disabled={busy || exports.saving} onClick={() => exportCsv(current, `session ${today()}`)}><Download className="h-4 w-4" aria-hidden="true" />Export CSV</button>
          <button type="button" className={button} disabled={busy || exports.saving} onClick={() => exportPdf(current, `session ${today()}`, reference, validatedAt)}><FileText className="h-4 w-4" aria-hidden="true" />Export PDF</button>
        </div>}
        <div className={cn("mt-4 rounded-2xl border border-gray-200 p-4", !canFix && "opacity-70")}>
          <p className="flex items-center gap-2 text-sm font-medium text-gray-800">Fix drift{!canFix && <PlanBadge feature="driftRevert" />}</p>
          <p className="mt-1 text-xs leading-5 text-gray-500">Resets a drifted policy to its OIB configuration in place. You review the change and choose the backup before anything happens. Assignments stay; the run can be undone.</p>
          {canFix && !storage && <p className="mt-2 text-xs leading-5 text-amber-900">This tenant has no backup storage, so a fix runs without a backup; undo then puts back the previous version saved in the run. <Link to="/portal/settings" className="text-blue-700 underline">Choose backup storage in Settings</Link>.</p>}
        </div>
        {listTotal > 0 && <ValidationFilterBar view={listView} total={listTotal} filter={filter} onChange={setFilter} />}
        <ul className="mt-4 divide-y divide-gray-100 overflow-hidden rounded-2xl bg-gray-50">{rowView.shown.map(row => {
          const k = key(row.platform, row.policy.source)
          const result = results.get(k)
          const isSupported = VALIDATED_FOLDERS.includes(row.policy.folder)
          return <li key={k} className="p-3 text-sm">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-gray-900">{row.policy.name}<span className="ml-2 text-xs text-gray-500">{OIB_PLATFORMS[row.platform].label}, {policyTypeName(row.policy.policyType)}</span></p>
                <p className="mt-1 text-xs text-gray-600">Tenant policy: {row.match.tenant!.name}</p>
                <div className="mt-1 flex flex-wrap gap-2"><StatusBadge match={row.match} />{result && <span className={cn("rounded-full px-2 py-0.5 text-xs", STATUS[result.status].tone)}>{STATUS[result.status].label}{result.result && result.status === "drifted" ? `, ${result.result.matched} of ${result.result.totalOib} settings match` : ""}</span>}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={button} disabled={busy || !isSupported} title={isSupported ? "Validates this policy now and keeps the result under Saved validations" : undefined} onClick={() => void validateOne(row)}>
                  {checking === k ? <><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Validating</> : result ? "Re-validate" : "Validate"}
                </button>
                {result && result.status !== "unsupported" && <button type="button" className={button} aria-expanded={expanded.has(k)} onClick={() => setExpanded(s => { const next = new Set(s); next.has(k) ? next.delete(k) : next.add(k); return next })}>{expanded.has(k) ? "Hide" : "Details"}</button>}
                {result?.status === "drifted" && <GatedButton feature="driftRevert" plan={plan} variant="outline" className="h-10 rounded-full" disabled={busy} onClick={() => openFix(row)}><RotateCcw className="h-4 w-4" aria-hidden="true" />Fix drift</GatedButton>}
              </div>
            </div>
            {!isSupported && <p className="mt-2 text-xs text-gray-500">This policy type is not validated setting by setting.</p>}
            {result && expanded.has(k) && <ResultDetails result={result} />}
          </li>
        })}{!matched.length && currentView.shown.map(r => {
          // The packs are still loading after a return: the results so far, without the row actions.
          const k = key(r.platform, r.source)
          return <li key={k} className="p-3 text-sm">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-gray-900">{r.name}<span className="ml-2 text-xs text-gray-500">{OIB_PLATFORMS[r.platform].label}</span></p>
                <p className="mt-1 text-xs text-gray-600">Tenant policy: {r.tenantPolicyName}</p>
                <span className={cn("mt-1 inline-block rounded-full px-2 py-0.5 text-xs", STATUS[r.status].tone)}>{STATUS[r.status].label}</span>
              </div>
              {r.status !== "unsupported" && <button type="button" className={button} aria-expanded={expanded.has(k)} onClick={() => setExpanded(s => { const next = new Set(s); next.has(k) ? next.delete(k) : next.add(k); return next })}>{expanded.has(k) ? "Hide" : "Details"}</button>}
            </div>
            {expanded.has(k) && <ResultDetails result={r} />}
          </li>
        })}{listTotal > 0 && !listView.shown.length && noMatch}{!matched.length && !current.length && <li className="p-6 text-center text-sm text-gray-500">{validating ? "Results appear here as each platform finishes." : loader.busy ? "Reading your tenant's policies" : "No deployed OpenIntuneBaseline policies were found. Use New Deployment first."}</li>}</ul>
        <ActionBar summary={barSummary(summary)} status={jobProgress(job) ?? (checking ? "Validating the policy" : loader.line)} error={error || job?.error} back={{ onClick: () => goto("platforms"), disabled: busy }}>
          <button type="button" className={primary} disabled={busy || loader.busy || !supported.length} onClick={validateAll}><ShieldCheck className="h-4 w-4" aria-hidden="true" />{current.length ? "Validate all again" : "Validate all"} ({supported.length})</button>
        </ActionBar>
      </>)}

      {step === "fix" && <ReviewDeploy kind="fix" flow="validate" backLabel="Back to the results" onBack={() => { setFixing(null); goto("results") }}
        batches={fixing ? [batchFor(fixing.catalog, [{ source: fixing.row.policy.source, mode: "update", targetId: fixing.row.match.tenant!.id, targetName: fixing.row.match.tenant!.name }])] : []}
        notes={fixing && <p className="text-sm text-gray-700">{plural(fixing.changes, "deviation is", "deviations are")} replaced with the OIB configuration of {fixing.row.policy.name}, including settings that exist only in the tenant. Assignments stay.</p>}
        onFinished={done => {
          // Re-read the fixed platforms so the row labels are current, then check the policy again.
          for (const platform of new Set((done.result ?? []).map(o => o.platform))) if (loader.status[platform]) loader.retry(platform)
          if (fixing && !done.error) void validateOne(fixing.row, fixing.catalog)
        }}
        next={() => [{ label: "Back to the results", primary: true, onClick: () => { setFixing(null); goto("results") } }]} />}

      {step === "saved" && saved && <>
        <p role="status" className="rounded-2xl bg-blue-50 px-4 py-3 text-sm text-gray-800">A saved result of {OIB_PLATFORMS[saved.platform].label} ({saved.reference}), not current tenant evidence. Validate again for current results.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <StatCard label="Match the baseline" value={count(saved.results, "compliant")} tone="green" />
          <StatCard label="Drift detected" value={count(saved.results, "drifted")} tone="amber" />
          <StatCard label="Errors" value={count(saved.results, "error")} tone="red" />
        </div>
        {savedResults.length > 0 && <ValidationFilterBar view={savedView} total={savedResults.length} filter={filter} onChange={setFilter} />}
        <ul className="mt-4 divide-y divide-gray-100 overflow-hidden rounded-2xl bg-gray-50">{savedResults.length > 0 && !savedView.shown.length && noMatch}{savedView.shown.map(r => <li key={r.source} className="p-3 text-sm">
          <p className="text-gray-900">{r.name}</p><p className="mt-1 text-xs text-gray-600">Tenant policy: {r.tenantPolicyName}</p>
          <span className={cn("mt-1 inline-block rounded-full px-2 py-0.5 text-xs", STATUS[r.status].tone)}>{STATUS[r.status].label}</span>
          <ResultDetails result={r} />
        </li>)}</ul>
        <ActionBar summary={barSummary()} back={{ label: viewing.from === "platforms" ? "Back" : "Back to the results", onClick: () => { setStep(viewing.from); setViewing(null); setFilter(NO_VALIDATION_FILTER) } }}>
          <button type="button" className={button} disabled={exports.saving} onClick={() => exportJson([saved], `saved ${saved.validatedAt.slice(0, 10)}`)}><Download className="h-4 w-4" aria-hidden="true" />JSON</button>
          <button type="button" className={button} disabled={exports.saving} onClick={() => exportCsv(savedResults, `saved ${saved.validatedAt.slice(0, 10)}`)}><Download className="h-4 w-4" aria-hidden="true" />CSV</button>
          <button type="button" className={button} disabled={exports.saving} onClick={() => exportPdf(savedResults, `saved ${saved.validatedAt.slice(0, 10)}`, saved.reference, saved.validatedAt)}><FileText className="h-4 w-4" aria-hidden="true" />PDF</button>
        </ActionBar>
      </>}
    </FlowShell>

    {history.length > 0 && <section className={cn(card, "mt-6")} aria-labelledby="saved-validations">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="saved-validations" className="flex items-center gap-2 text-lg font-medium"><History className="h-4 w-4" aria-hidden="true" />Saved validations</h2>
        <button type="button" className={button} disabled={exports.saving} onClick={() => exportJson(history, `history ${today()}`)}><Download className="h-4 w-4" aria-hidden="true" />Export all (JSON)</button>
      </div>
      <p className="mt-1 text-xs text-gray-500">Kept in encrypted storage on this device (latest 50). Validate all and single policy checks are both saved. Only Validate all sets the OIB baseline score.</p>
      {historyError && <p role="alert" className="mt-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{historyError}</p>}
      <ul className="mt-2 divide-y divide-gray-100">{history.map(run => <li key={run.runId} className="py-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>{new Date(run.validatedAt).toLocaleString()}, {run.reference}<span className="text-xs text-gray-500">{". "}{plural(run.results.length, "policy", "policies")}: {count(run.results, "compliant")} match, {count(run.results, "drifted")} drift, {plural(count(run.results, "error"), "error", "errors")}{isFullValidation(run) ? "" : ". Single policy check, not part of the baseline score"}</span></span>
          <span className="flex gap-2">
            <button type="button" className={button} disabled={busy || step === "fix"} onClick={() => { exports.clear(); setFilter(NO_VALIDATION_FILTER); setViewing({ run, from: step === "saved" ? viewing?.from ?? "platforms" : step }); setStep("saved") }}>View</button>
            <button type="button" className={button} aria-label="Delete saved validation" aria-expanded={deleting?.runId === run.runId} disabled={!!deleting} onClick={() => setDeleting({ runId: run.runId })}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
          </span>
        </div>
        {deleting?.runId === run.runId && <div role="group" aria-label="Confirm delete" className="mt-3 flex flex-wrap items-center gap-3 rounded-2xl bg-gray-50 p-4">
          <p className="min-w-0 flex-1 text-gray-800">Delete the saved validation of {new Date(run.validatedAt).toLocaleString()} from this device? The tenant is not changed.</p>
          <button type="button" className={button} disabled={deleting.busy} onClick={() => setDeleting(null)}>Cancel</button>
          <button type="button" className={primary} disabled={deleting.busy} onClick={() => void deleteSaved(run.runId)}>{deleting.busy ? <><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Deleting</> : <><Trash2 className="h-4 w-4" aria-hidden="true" />Delete</>}</button>
        </div>}
      </li>)}</ul>
    </section>}

    <section className={cn(card, "mt-6")} aria-label="Deployment runs"><h2 className="text-lg font-medium">Drift fixes and deployments</h2>
      <RunsList tenant={tenant} flow="validate" empty="No runs that can be undone are recorded for this tenant." onChanged={() => { for (const p of platforms) if (loader.status[p]) loader.retry(p) }} />
    </section>
  </>
}
