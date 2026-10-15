import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, ArrowRight, ExternalLink, Package, PencilRuler, RotateCcw, Search, ShieldCheck } from "lucide-react"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { OIB_PLATFORMS, OIB_REPO, type OibPlatform, type OibSelection, type OibVersions } from "../../shared/oib/types"
import { defaultSelection, selectionLabel } from "../../shared/oib/versions"
import { GatedButton } from "../components/PlanGate"
import { customizeOib } from "../features/custom-baselines/api"
import { RunsList } from "../components/oib/DeployPanel"
import { ExistingDeployment } from "../components/oib/ExistingDeployment"
import { NewDeployment } from "../components/oib/NewDeployment"
import { PolicyValidation } from "../components/oib/PolicyValidation"
import { EarlierComparisons } from "../components/oib/EarlierComparisons"
import { OibJobCard } from "../components/oib/JobIndicator"
import { markSeen, useOibJobs } from "../components/oib/jobs"
import { mainNotes, selectionsLabel, VersionsContext, VersionsPanel } from "../components/oib/Versions"
import { button, card, errorText, oibRequest, useOibTenant, useTask, Status, type Selections } from "../components/oib/common"

const FLOWS = [
  { id: "new", title: "New Deployment", icon: Package, description: "Deploy OpenIntuneBaseline policies to this tenant for the first time.", features: ["Latest published release by default", "Licensing-aware policy filtering", "Optional backup first, undo per run"] },
  { id: "existing", title: "Existing Deployment", icon: Search, description: "Compare your current OIB deployment with the selected version.", features: ["Policy comparison by OIBID or name", "Version analysis and deprecated policies", "Deploy missing or outdated policies"] },
  { id: "validate", title: "Policy Validation", icon: ShieldCheck, description: "Check your deployed OIB policies for setting-level drift against the baseline.", features: ["Per-setting drift check", "CSV and PDF reports, saved history", "No changes made to your tenant"] },
] as const

type Flow = (typeof FLOWS)[number]["id"]

// The versions chosen on this page, kept while the app runs so moving between workflows keeps them.
let chosen: Partial<Selections> = {}
// Whether beta and unstable prereleases are offered by default, kept across workflows like the choices.
let chosenPrerelease = false

export default function OibPage() {
  const { flow } = useParams()
  const { tenant } = useOibTenant()
  const [versions, setVersions] = useState<OibVersions | null>(null)
  const [overrides, setOverrides] = useState<Partial<Selections>>(chosen)
  const [allowPrerelease, setAllowPrereleaseState] = useState(chosenPrerelease)
  const setAllowPrerelease = (value: boolean) => { chosenPrerelease = value; setAllowPrereleaseState(value) }
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState("")
  const [checking, setChecking] = useState(false)
  const loadVersions = (retry = false) => {
    setError(""); setChecking(true)
    void oibRequest<OibVersions>({ action: "oib-versions", retry }).then(setVersions).catch((e: unknown) => setError(errorText(e, "GitHub could not be reached."))).finally(() => setChecking(false))
  }
  useEffect(() => loadVersions(), [])
  const active = FLOWS.find(f => f.id === flow)?.id as Flow | undefined
  // A remembered release counts only while it is still offered; a main choice follows main as it moves.
  const resolve = (v: OibVersions, platform: OibPlatform, selection?: OibSelection): OibSelection => {
    if (selection && !selection.tag) return { commit: v.main.commit }
    if (selection && v.releases.some(r => r.platform === platform && r.tag === selection.tag && r.commit === selection.commit)) return selection
    return defaultSelection(v, platform, allowPrerelease)
  }
  const selections = versions ? Object.fromEntries((Object.keys(OIB_PLATFORMS) as OibPlatform[]).map(p => [p, resolve(versions, p, overrides[p])])) as Selections : null
  // Only choices that differ from the default are kept, so a platform left alone follows new releases.
  const choose = (value: Partial<Selections>) => {
    const next = Object.fromEntries(Object.entries(value).filter(([p, s]) => versions && JSON.stringify(s) !== JSON.stringify(defaultSelection(versions, p as OibPlatform, allowPrerelease)))) as Partial<Selections>
    chosen = next; setOverrides(next)
  }
  const notes = versions && selections ? mainNotes(versions, selections) : null
  const retryButton = (label = "Retry") => <button type="button" className="underline disabled:cursor-wait disabled:opacity-60" disabled={checking} aria-busy={checking} onClick={() => loadVersions(true)}>{checking ? "Retrying…" : label}</button>

  return <div className="mx-auto max-w-6xl p-6 lg:p-8">
    <div className="mb-6">
      <p className="mb-3 text-xs font-medium text-gray-500">Baseline deployment and validation</p>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-medium tracking-tight text-gray-900">OpenIntuneBaseline</h1>
          <p className="mt-3 max-w-2xl text-lg text-gray-500">Deploy, compare and validate the community OpenIntuneBaseline security policies in {tenant?.name ?? "your tenant"}.</p>
        </div>
        <a href={`https://github.com/${OIB_REPO}`} target="_blank" rel="noreferrer" className={button}>Source <ExternalLink className="h-4 w-4" aria-hidden="true" /></a>
      </div>
      <div className="mt-3 text-xs text-gray-500">
        {selections ? <p>
          Versions: {selectionsLabel(selections)}.{" "}
          {active ? "Change them in the first step of the workflow." : !picking && <button type="button" className="underline" onClick={() => setPicking(true)}>Change versions</button>}
        </p> : error ? !active && <p role="alert" className="text-red-800">{error} {retryButton()}</p> : <p role="status">Checking the OpenIntuneBaseline releases…</p>}
        {/* Retrying inside a workflow could change the versions and restart it, so only the overview offers it. */}
        {versions?.warning && <p role="status" className="mt-2 text-amber-900">{versions.warning}{!active && <> {retryButton()}</>}</p>}
        {/* Workflows show these notes for their platforms next to Change versions. */}
        {!active && notes?.info && <p className="mt-2">{notes.info}</p>}
        {!active && notes?.warning && <p role="status" className="mt-2 text-amber-900">{notes.warning}</p>}
        <p className="mt-2">Content: SkipToTheEndpoint and contributors, <a href={`https://github.com/${OIB_REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer" className="underline">GPL-3.0</a>.</p>
      </div>
      {picking && !active && versions && selections && <VersionsPanel className="mt-4 rounded-3xl border-0 p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]" versions={versions} selections={selections} allowPrerelease={allowPrerelease} onAllowPrereleaseChange={setAllowPrerelease} onCancel={() => setPicking(false)} onDone={value => { choose(value); setPicking(false) }} />}
    </div>
    {!tenant && <p role="status" className="rounded-3xl bg-amber-50 px-6 py-5 text-sm text-amber-950">Choose a connected tenant using the sidebar.</p>}
    {tenant && !active && <>
      <TenantJobs tenantId={tenant.tenantId} />
      <div className="grid gap-4 lg:grid-cols-3">{FLOWS.map(f => <Link key={f.id} to={`/portal/oib/${f.id}`} className="group flex flex-col rounded-3xl bg-white p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)] transition-colors hover:bg-blue-50/50">
        <span className="flex size-11 items-center justify-center rounded-full bg-secondary text-foreground" aria-hidden="true"><f.icon className="h-5 w-5" /></span>
        <h2 className="mt-4 text-lg font-medium text-gray-900">{f.title}</h2>
        <p className="mt-1 text-sm text-gray-600">{f.description}</p>
        <ul className="mt-3 flex-1 space-y-1 text-xs text-gray-500">{f.features.map(x => <li key={x}>• {x}</li>)}</ul>
        <span className="mt-4 flex size-10 items-center justify-center self-end rounded-full bg-secondary text-muted-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground" aria-hidden="true"><ArrowRight className="h-4 w-4" /></span>
      </Link>)}</div>
      <p className="mt-5 text-sm text-gray-500">Not sure which to choose? Use New Deployment the first time, Existing Deployment to compare and update previously deployed policies, and Policy Validation to check deployed policies for configuration drift. Always test in a pilot or test tenant first: these baselines can change the user experience and device behaviour.</p>
      <CustomizeCard selections={selections} />
      <section className={`${card} mt-6`} aria-label="Deployment runs"><h2 className="text-lg font-medium">Deployment history</h2><p className="mt-1 text-sm text-gray-600">Each deployment or drift reset is recorded on this device so it can be undone.</p><RunsList tenant={tenant} empty="No deployments that can be undone are recorded for this tenant." /></section>
      <EarlierComparisons key={tenant.tenantId} tenant={tenant} />
    </>}
    {tenant && active && <>
      <Link to="/portal/oib" className="mb-4 inline-flex items-center gap-1 text-sm text-blue-700 hover:underline"><ArrowLeft className="h-4 w-4" aria-hidden="true" />All OpenIntuneBaseline workflows</Link>
      {!selections ? error
        ? <section className={card} aria-labelledby="versions-error"><h2 id="versions-error" className="text-lg font-medium text-gray-900">The OpenIntuneBaseline versions could not be loaded</h2>
          <p role="alert" className="mt-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>
          <p className="mt-3 text-sm text-gray-600">The workflow needs the list of published releases from GitHub to continue.</p>
          <button type="button" className={`${button} mt-5`} disabled={checking} aria-busy={checking} onClick={() => loadVersions(true)}><RotateCcw className={checking ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden="true" />{checking ? "Retrying…" : "Retry"}</button>
        </section>
        : <p role="status" className="text-sm text-gray-500">Checking the OpenIntuneBaseline releases…</p>
        : <VersionsContext.Provider value={{ versions: versions!, selections, choose, allowPrerelease, setAllowPrerelease }}>
          <div key={`${tenant.tenantId}:${JSON.stringify(selections)}`}>
            {active === "new" && <NewDeployment selections={selections} />}
            {active === "existing" && <ExistingDeployment selections={selections} />}
            {active === "validate" && <PolicyValidation selections={selections} />}
          </div>
        </VersionsContext.Provider>}
    </>}
  </div>
}

/** Running and unseen finished OIB jobs of the tenant, so a deployment in progress shows here too. */
function TenantJobs({ tenantId }: { tenantId: string }) {
  const jobs = useOibJobs().filter(job => job.tenantId === tenantId && (!job.finishedAt || !job.seen))
  if (!jobs.length) return null
  return <section className="mb-6 grid gap-2 sm:grid-cols-2" aria-label="OpenIntuneBaseline jobs for this tenant">
    {jobs.map(job => <OibJobCard key={job.id} job={job} onDismiss={job.finishedAt ? () => markSeen(job.id) : undefined} />)}
  </section>
}

/** Customize an editable baseline from the version selected for a platform (Pro and MSP). */
function CustomizeCard({ selections }: { selections: Selections | null }) {
  const { selectedTenant } = useSelectedTenant()
  const { plan } = useOibTenant()
  const navigate = useNavigate()
  const task = useTask()
  const [platform, setPlatform] = useState<OibPlatform>("windows")
  const selection = selections?.[platform]
  return <section className={`${card} mt-6`} aria-labelledby="customize-title">
    <div className="flex flex-wrap items-center gap-3">
      <span className="flex size-10 items-center justify-center rounded-full bg-secondary text-foreground" aria-hidden="true"><PencilRuler className="h-[18px] w-[18px]" /></span>
      <h2 id="customize-title" className="text-lg font-medium">Your own baseline</h2>
    </div>
    <p className="mt-2 text-sm text-gray-600">Customize stores the supported Settings Catalog policies of a platform, at the version selected above, as your organization's own baseline under <Link to="/portal/baselines" className="text-blue-700 hover:underline">My baselines</Link>, where you edit settings in versions, compare them with newer OIB versions and deploy them through a reviewed change set. It does not change the tenant.</p>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <label className="text-sm text-gray-700">Platform
        <select value={platform} disabled={!!task.busy} onChange={e => setPlatform(e.target.value as OibPlatform)} className="ml-2 h-10 rounded-full border border-gray-300 bg-white px-4 text-sm">
          {(Object.keys(OIB_PLATFORMS) as OibPlatform[]).map(p => <option key={p} value={p}>{OIB_PLATFORMS[p].label}</option>)}
        </select>
      </label>
      {selection && <span className="text-sm text-gray-600">Version {selectionLabel(selection)}</span>}
      <GatedButton feature="customBaselines" plan={plan} variant="outline" className="h-10 rounded-full" disabled={!!task.busy || !selectedTenant || !selection} title="Create your organization's own editable baseline from this platform and version" onClick={() => void task.run("Creating your baseline", async () => {
        const { baseline } = await customizeOib(selectedTenant!, platform, selection!.commit, undefined, selection!.tag)
        navigate(`/portal/baselines/${baseline.id}`)
      })}>Customize</GatedButton>
      <Link to="/portal/baselines" className={button}>My baselines</Link>
    </div>
    <Status busy={task.busy} error={task.error} />
  </section>
}
