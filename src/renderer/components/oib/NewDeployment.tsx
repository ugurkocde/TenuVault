import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowRight, Search } from "lucide-react"
import { cn } from "~/lib/utils"
import { policyTypeName, POLICY_TYPES, typeGate, type TenantProfile } from "../../../shared/oib/licensing"
import { OIB_PLATFORMS, type OibCatalog, type OibPlatform } from "../../../shared/oib/types"
import { button, card, listJoin, OptionCard, PlatformPicker, platformsLabel, primary, StatCard, useOibTenant, type OibTenant, type Selections } from "./common"
import { batchFor } from "./deploy-sequence"
import { RunsList } from "./DeployPanel"
import { ActionBar, FlowShell } from "./FlowShell"
import { clearJob, useOibJob } from "./jobs"
import { LoadProgress, usePlatformLoader } from "./LoadProgress"
import { addShown, availableTypes, buildRows, defaultSelection, inTenantReason, needsLicensing, NEUTRAL_PROFILE, pruneSelection, rowCounts, rowKey, selectable, shownRows, type NewRow } from "./NewDeploymentRows"
import { PolicySettings } from "./PolicySettings"
import { ReviewDeploy, startedBatches, type DeployOutcome } from "./ReviewDeploy"
import { ChangeVersions } from "./Versions"

type Step = "platforms" | "licensing" | "types" | "select" | "review"
type Answers = { licensing?: TenantProfile["licensing"]; defenderAv?: boolean; autopatch?: boolean }

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** OIBDeployer's New Deployment: platforms, licensing questions (Windows only), policy types, policies, then review and deploy. */
export function NewDeployment({ selections }: { selections: Selections }) {
  const { tenant } = useOibTenant()
  const navigate = useNavigate()
  const job = useOibJob<DeployOutcome[]>(tenant?.tenantId, { kind: "deploy", flow: "new" })
  // Returning while a deployment of this flow runs or has a result shows it.
  const [step, setStep] = useState<Step>(job ? "review" : "platforms")
  // Returning to a deployment keeps its platforms, so the steps (Licensing for Windows) stay the same.
  const [platforms, setPlatforms] = useState<OibPlatform[]>(() => job && tenant ? startedBatches(tenant.tenantId, "deploy", "new").map(b => b.platform) : [])
  // The platform set the loader last started for; the tenant is read again only when it changes.
  const [loadedFor, setLoadedFor] = useState("")
  const loader = usePlatformLoader(tenant, selections, platforms)
  const [answers, setAnswers] = useState<Answers>({})
  const [types, setTypes] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showGated, setShowGated] = useState(false)
  const [search, setSearch] = useState("")

  const licensed = needsLicensing(platforms)
  const answered: TenantProfile | null = answers.licensing && answers.defenderAv !== undefined && answers.autopatch !== undefined
    ? { licensing: answers.licensing, defenderAv: answers.defenderAv, autopatch: answers.autopatch } : null
  const profile = licensed ? answered ?? NEUTRAL_PROFILE : NEUTRAL_PROFILE
  const available = availableTypes(loader.loaded)
  // Until the types are changed by hand, every type that suits the tenant is chosen.
  const chosen = (types ?? available).filter(t => available.includes(t) && !typeGate(t, profile))
  const rows = buildRows(loader.loaded, chosen, profile)
  const shown = shownRows(rows, showGated, search)
  const counts = rowCounts(rows, showGated)
  const steps = [{ id: "platforms", label: "Platforms" }, ...(licensed ? [{ id: "licensing", label: "Licensing" }] : []), { id: "types", label: "Policy types" }, { id: "select", label: "Policies" }, { id: "review", label: "Review and deploy" }]
  const loading = loader.busy || !loader.loaded.length
  const running = !!job && !job.finishedAt

  if (!tenant) return null

  const key = [...platforms].sort().join("|")
  function load(compare: boolean) {
    if (loadedFor === key) { if (compare) loader.compare(); return }
    setLoadedFor(key)
    setTypes(null)
    loader.start({ compare })
  }
  function go(next: string) {
    // Leaving a finished deployment clears it, so the next visit to review starts a new one.
    if (job?.finishedAt) clearJob(job.id)
    // Without loaded data (after returning to a deployment) the later steps start from the platforms.
    setStep(!loadedFor && next !== "platforms" ? "platforms" : next as Step)
  }
  function fromPlatforms() {
    // Packs download while the licensing questions are answered; the tenant is read on Continue.
    if (licensed) { load(false); setStep("licensing") } else { load(true); setStep("types") }
  }
  function toSelection() {
    setSelected(defaultSelection(rows)); setShowGated(false); setSearch("")
    setStep("select")
  }
  function toggleGated(value: boolean) {
    setShowGated(value)
    if (!value) setSelected(s => pruneSelection(s, rows, false))
  }
  // After a deploy or an undo the tenant is read again, so created policies show as in the tenant.
  function refresh() {
    if (loadedFor) { loader.start(); setLoadedFor(key) }
  }
  function deployMore() {
    setSelected(new Set())
    if (loadedFor) { setStep("select"); return }
    // Returned to the deployment: nothing is loaded, so start again from its platforms.
    setPlatforms([...new Set((job?.result ?? []).map(o => o.platform))])
    setStep("platforms")
  }
  const batches = loader.loaded.map(({ catalog }) => batchFor(catalog, catalog.policies
    .filter(p => selected.has(rowKey(catalog.platform, p.source))).map(p => ({ source: p.source, mode: "create" as const })))).filter(b => b.items.length)
  const loadError = loader.failed.length ? `${platformsLabel(loader.failed)} could not be loaded. Retry ${loader.failed.length === 1 ? "it" : "them"} above.` : undefined
  const loadingView = <>
    <LoadProgress loader={loader} platforms={platforms} selections={selections} />
    <ActionBar status={loader.line} error={loadError} back={{ onClick: () => go(step === "select" ? "types" : licensed ? "licensing" : "platforms") }} />
  </>
  const failedRows = loader.failed.length > 0 && <div className="mb-5"><LoadProgress loader={loader} platforms={loader.failed} selections={selections} /></div>

  const question = (title: string, field: keyof Answers, options: Array<[Answers[keyof Answers], string, string]>) => <fieldset className="mt-6 first:mt-0">
    <legend className="text-sm font-medium text-gray-900">{title}</legend>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">{options.map(([value, label, description]) => <OptionCard key={String(value)} selected={answers[field] === value} title={label} description={description} onClick={() => setAnswers(a => ({ ...a, [field]: value }))} />)}</div>
  </fieldset>
  const unanswered = [answers.licensing, answers.defenderAv, answers.autopatch].filter(a => a === undefined).length

  return <>
    <FlowShell title="New Deployment" steps={steps} step={step} onStep={go} locked={loader.busy || running}
      description={step === "platforms" ? "Select the operating systems you want to deploy OpenIntuneBaseline policies for."
        : step === "licensing" ? "Tell us about the tenant so Windows and Windows 365 policies it cannot use, or that would conflict with your setup, are filtered out. The answers do not affect other platforms."
        : step === "types" && !loading ? `Choose the policy types to deploy from ${listJoin(loader.loaded.map(l => l.catalog.reference))}.`
        : step === "select" && !loading ? "Select the policies to deploy. Policies already in the tenant cannot be selected here; update them with Existing Deployment."
        : undefined}>
      {step === "platforms" && <>
        <PlatformPicker value={platforms} onChange={setPlatforms} />
        <ChangeVersions platforms={platforms} />
        <ActionBar summary={platforms.length ? `${platformsLabel(platforms)} selected` : "Select at least one platform"}>
          <button type="button" className={primary} disabled={!platforms.length} onClick={fromPlatforms}>Continue<ArrowRight className="h-4 w-4" aria-hidden="true" /></button>
        </ActionBar>
      </>}

      {step === "licensing" && <>
        {failedRows}
        {question("What is the tenant's primary licensing?", "licensing", [["business-premium", "Microsoft 365 Business Premium", "Windows Business / Pro entitlement"], ["enterprise", "Microsoft 365 E3, E5 or E7", "Includes the Windows Enterprise entitlement"]])}
        {question("Will Microsoft Defender for Endpoint be the primary antivirus?", "defenderAv", [[true, "Yes", "Defender for Endpoint is the primary antivirus"], [false, "No", "A third-party antivirus is used"]])}
        {question("Will Windows updates be managed by Autopatch?", "autopatch", [[true, "Yes", "Autopatch manages Windows Update deployment"], [false, "No", "Windows Update for Business is managed directly"]])}
        <ActionBar summary={unanswered ? `${plural(unanswered, "question", "questions")} left` : "All questions answered"}
          status={loader.line} error={loadError} back={{ onClick: () => go("platforms") }}>
          <button type="button" className={primary} disabled={!answered} onClick={() => { load(true); setStep("types") }}>Continue<ArrowRight className="h-4 w-4" aria-hidden="true" /></button>
        </ActionBar>
      </>}

      {step === "types" && (loading ? loadingView : <>
        {failedRows}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{available.map(type => {
          const gate = typeGate(type, profile)
          return <OptionCard key={type} selected={chosen.includes(type)} disabled={!!gate} title={policyTypeName(type)} description={gate ?? POLICY_TYPES[type]?.description ?? ""}
            onClick={() => setTypes(chosen.includes(type) ? chosen.filter(t => t !== type) : [...chosen, type])} />
        })}</div>
        <ActionBar summary={`${chosen.length} of ${plural(available.length, "policy type", "policy types")} chosen`} error={loadError} back={{ onClick: () => go(licensed ? "licensing" : "platforms") }}>
          <button type="button" className={primary} disabled={!chosen.length} onClick={toSelection}>Continue<ArrowRight className="h-4 w-4" aria-hidden="true" /></button>
        </ActionBar>
      </>)}

      {step === "select" && (loading ? loadingView : <>
        {failedRows}
        <div className="grid gap-3 sm:grid-cols-4">
          <StatCard label="Available" value={counts.available} />
          <StatCard label="New policies" value={counts.fresh} tone="blue" />
          <StatCard label="Already in tenant" value={counts.inTenant} tone="green" />
          <StatCard label="Selected" value={selected.size} tone="amber" />
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-80"><Search className="absolute left-4 top-3 h-4 w-4 text-gray-400" aria-hidden="true" /><input aria-label="Search policies" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search policies…" className="h-10 w-full rounded-full border border-gray-200 bg-white pl-10 pr-4 text-sm" /></div>
          <button type="button" className={button} disabled={!shown.some(selectable)} onClick={() => setSelected(s => addShown(s, shown))}>Select all shown</button>
          {counts.gated > 0 && <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={showGated} onChange={e => toggleGated(e.target.checked)} className="h-4 min-h-0 w-4" />Show {plural(counts.gated, "policy that does not suit this tenant", "policies that do not suit this tenant")}</label>}
          {search.trim() && <span role="status" className="text-sm text-gray-500">Showing {shown.length} of {counts.available}</span>}
        </div>
        <PolicyGroups tenant={tenant} catalogs={new Map(loader.loaded.map(l => [l.catalog.platform, l.catalog]))} rows={shown} selected={selected} onToggle={k => setSelected(s => { const next = new Set(s); next.has(k) ? next.delete(k) : next.add(k); return next })} />
        <ActionBar summary={`${selected.size} selected`} error={loadError} back={{ onClick: () => go("types") }}>
          <button type="button" className={button} disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear</button>
          <button type="button" className={primary} disabled={!selected.size} onClick={() => setStep("review")}>Review deployment ({selected.size})<ArrowRight className="h-4 w-4" aria-hidden="true" /></button>
        </ActionBar>
      </>)}

      {step === "review" && <ReviewDeploy flow="new" batches={batches} onBack={() => go("select")}
        onFinished={() => { setSelected(new Set()); refresh() }}
        next={() => [{ label: "Deploy more policies", onClick: deployMore, primary: true }, { label: "Done", onClick: () => navigate("/portal/oib") }]} />}
    </FlowShell>
    {step === "review" && <section className={cn(card, "mt-5")} aria-label="Deployment runs">
      <RunsList tenant={tenant} flow="new" empty="No runs that can be undone yet." onChanged={refresh} />
    </section>}
  </>
}

function PolicyGroups({ tenant, catalogs, rows, selected, onToggle }: { tenant: OibTenant; catalogs: Map<OibPlatform, OibCatalog>; rows: NewRow[]; selected: Set<string>; onToggle: (key: string) => void }) {
  const groups = new Map<string, NewRow[]>()
  for (const row of rows) {
    const group = `${OIB_PLATFORMS[row.platform].label} · ${policyTypeName(row.policy.policyType)}`
    groups.set(group, [...(groups.get(group) ?? []), row])
  }
  if (!rows.length) return <p role="status" className="py-8 text-center text-sm text-gray-500">No policies match your filters.</p>
  return <div className="mt-5 space-y-5">{[...groups].map(([group, entries]) => <div key={group}>
    <h3 className="mb-2 text-sm font-medium text-gray-800">{group} <span className="ml-1 text-xs font-normal text-gray-500">{entries.length}</span></h3>
    <ul className="divide-y divide-gray-100 overflow-hidden rounded-2xl bg-gray-50">{entries.map(row => {
      const { key, policy, inTenant, gate } = row
      const catalog = catalogs.get(row.platform)
      return <li key={key} className="p-3"><label className={cn("flex items-start gap-3 text-sm", selectable(row) ? "cursor-pointer" : "opacity-70")}>
        <input type="checkbox" checked={selected.has(key)} disabled={!selectable(row)} onChange={() => onToggle(key)} className="mt-1 h-4 min-h-0 w-4 shrink-0" />
        <span className="min-w-0 flex-1"><span className="text-gray-900">{policy.name}</span>
          <span className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            {inTenant ? <span className="rounded-full bg-green-100 px-2 py-0.5 text-green-800">Already in tenant</span> : <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-800">New</span>}
            {policy.scope && <span className="rounded-full bg-white px-2 py-0.5 text-gray-600">{policy.scope}</span>}
            {policy.status === "deprecated" && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-900">Deprecated</span>}
            {gate && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-900">{gate}</span>}
            {inTenant && <span className="text-gray-600">{inTenantReason(inTenant)}</span>}
          </span>
        </span>
      </label>
      {/* Outside the label, so opening the settings never ticks the policy. */}
      {catalog && <div className="pl-7"><PolicySettings tenant={tenant} catalog={catalog} source={policy.source} name={policy.name} /></div>}</li>
    })}</ul>
  </div>)}</div>
}
