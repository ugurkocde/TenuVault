import { useEffect, useRef, useState } from "react"
import { AlertTriangle, ArrowRight, FileText, RefreshCw } from "lucide-react"
import { cn } from "~/lib/utils"
import { formatReportDate } from "../../../shared/compliance/presentation"
import { policyTypeName } from "../../../shared/oib/licensing"
import type { ReportPayload } from "../../../shared/oib/report"
import { OIB_PLATFORMS, type MatchStatus, type OibPlatform } from "../../../shared/oib/types"
import { PlanBadge } from "../UpgradeNote"
import { button, card, PlatformPicker, platformsLabel, primary, StatCard, useOibTenant, versionsLabel, type LoadedPlatform, type Selections } from "./common"
import { RunsList } from "./DeployPanel"
import { batchFor } from "./deploy-sequence"
import { ActionBar, FlowShell } from "./FlowShell"
import { clearJob, useOibJob } from "./jobs"
import { LoadProgress, usePlatformLoader } from "./LoadProgress"
import { joinRows, MatchNotes, rowKey, STATUS_LABELS, StatusBadge, ambiguousReason, versionText, type MatchRow } from "./match-ui"
import { Notice, savePdf, useSaveNotice } from "./notices"
import { ChangeVersions } from "./Versions"
import { ReviewDeploy, type DeployJob, type DeployOutcome } from "./ReviewDeploy"

// PolicyValidation imports these from here.
export { joinRows, MatchNotes, StatusBadge }

type Mode = "create" | "update"
type Filter = "all" | MatchStatus | "legacy"
type Step = "platforms" | "compare" | "review"

const STEPS = [{ id: "platforms", label: "Platforms" }, { id: "compare", label: "Compare" }, { id: "review", label: "Review and deploy" }]
const FILTERS: Filter[] = ["all", "outdated", "missing", "newer", "current", "duplicate", "legacy"]
const filterLabel = (f: Filter) => f === "all" ? "All" : f === "legacy" ? "Other copies" : STATUS_LABELS[f]
const selectable = (r: MatchRow) => r.match.status === "missing" || r.match.status === "outdated"
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Why a row cannot be selected, or undefined when it can. */
function disabledReason(r: MatchRow): string | undefined {
  if (r.match.status === "current") return "Up to date: nothing to deploy."
  if (r.match.status === "newer") return "Newer than OIB: the tenant copy is newer than the selected version, so nothing is deployed."
  if (r.match.status === "duplicate") return `Ambiguous: ${ambiguousReason(r.match)}`
}

// The platforms chosen per tenant, kept while the app runs so returning to the flow (or Compare again after a remount) keeps them.
const chosenPlatforms = new Map<string, OibPlatform[]>()

function comparisonReport(loaded: LoadedPlatform[], tenantId: string, tenantName: string): ReportPayload {
  const rows = joinRows(loaded)
  const order: MatchStatus[] = ["outdated", "missing", "duplicate", "newer", "current"]
  return {
    tenantId,
    title: "OpenIntuneBaseline deployment comparison",
    eyebrow: "OpenIntuneBaseline comparison",
    subtitle: `OpenIntuneBaseline ${versionsLabel(loaded.map(l => l.catalog))}`,
    meta: [["Tenant", tenantName], ["Compared", formatReportDate(loaded[0]?.comparison.comparedAt ?? new Date().toISOString())], ["Tenant policies read", String(loaded.reduce((sum, l) => sum + l.comparison.tenantPolicyCount, 0))], ["Matching", "OIBID in the policy description, then policy name without version. Settings are not compared; see Policy Validation."]],
    summary: order.map(status => [STATUS_LABELS[status], String(rows.filter(r => r.match.status === status).length)]),
    sections: [
      ...order.map(status => ({
        heading: STATUS_LABELS[status],
        columns: ["Platform", "Type", "OIB policy", "Tenant policy", "Versions", "Match"],
        rows: rows.filter(r => r.match.status === status).map(r => [OIB_PLATFORMS[r.platform].label, policyTypeName(r.policy.policyType), r.policy.name,
          r.match.tenant?.name ?? r.match.matches?.map(m => `${m.name} (${m.id})`).join("\n") ?? "", versionText(r.match), r.match.method === "oibid" ? "OIBID" : r.match.method === "name" ? "Name" : ""]),
      })),
      { heading: "Other copies still deployed", note: "Older versions or extra copies next to the matched policy. They keep applying until removed.", columns: ["OIB policy", "Other copy in the tenant"], rows: rows.flatMap(r => r.match.legacy.map(l => [r.policy.name, `${l.name} (${l.id})`])) },
      { heading: "Deprecated policies in the tenant", columns: ["Tenant policy", "Replacement"], rows: loaded.flatMap(l => l.comparison.deprecated).map(d => [d.tenant.name, d.replacements.map(r => `${r.name}${r.deployed ? " (deployed)" : ""}`).join("\n")]) },
    ],
    attribution: "OpenIntuneBaseline content: SkipToTheEndpoint and contributors, GPL-3.0.",
  }
}

/** OIBDeployer's Existing Deployment: compare with the selected OIB versions, then deploy missing or outdated policies. */
export function ExistingDeployment({ selections }: { selections: Selections }) {
  const { tenant, can } = useOibTenant()
  const job = useOibJob<DeployOutcome[]>(tenant?.tenantId, { kind: "deploy", flow: "existing" })
  const [step, setStep] = useState<Step>(job ? "review" : "platforms")
  const [platforms, setPlatformsState] = useState<OibPlatform[]>(() => (tenant && chosenPlatforms.get(tenant.tenantId)) ?? [])
  const loader = usePlatformLoader(tenant, selections, platforms)
  const [filter, setFilter] = useState<Filter>("all")
  const [selected, setSelected] = useState<Map<string, Mode>>(new Map())
  const pdf = useSaveNotice()
  const exportButton = useRef<HTMLButtonElement>(null)
  // An undo finished while the review was open; the comparison is read again on the way back.
  const stale = useRef(false)
  const rows = joinRows(loader.loaded)

  // After a reload, drop selections that are no longer deployable (deployed meanwhile); a failed backup leaves them selectable, so they stay.
  useEffect(() => {
    if (loader.busy || !loader.settled) return
    const ready = new Set(loader.loaded.map(l => l.catalog.platform))
    const open = new Set(rows.filter(selectable).map(rowKey))
    setSelected(s => {
      const next = new Map([...s].filter(([k]) => !ready.has(k.split("\n")[0] as OibPlatform) || open.has(k)))
      return next.size === s.size ? s : next
    })
  }, [loader.status])

  // The notice makes the action bar taller; keep the export row clear of it.
  useEffect(() => { if (pdf.result) requestAnimationFrame(() => exportButton.current?.scrollIntoView({ block: "nearest" })) }, [pdf.result])

  if (!tenant) return null
  const canUpdate = can("replaceRestore")
  const setPlatforms = (value: OibPlatform[]) => {
    chosenPlatforms.set(tenant.tenantId, value); setPlatformsState(value)
    // Selections of platforms no longer chosen go too.
    setSelected(s => new Map([...s].filter(([k]) => value.includes(k.split("\n")[0] as OibPlatform))))
  }
  const running = !!job && !job.finishedAt
  const refresh = () => { stale.current = false; loader.start() }
  const compare = () => { setStep("compare"); refresh() }
  // Back to the dashboard; reads again when the data is stale or gone (the flow remounted after a deploy).
  // Without remembered platforms there is nothing to compare: start at the platforms step.
  const toCompare = () => !platforms.length ? setStep("platforms") : stale.current || (!loader.busy && !loader.loaded.length && !loader.failed.length) ? compare() : setStep("compare")
  const goTo = (next: string) => {
    // A finished result would hide the next review; leaving the step clears it.
    if (step === "review" && job?.finishedAt) clearJob(job.id)
    if (next === "compare") toCompare()
    else setStep(next as Step)
  }

  const count = (f: Filter) => f === "all" ? rows.length : f === "legacy" ? rows.filter(r => r.match.legacy.length).length : rows.filter(r => r.match.status === f).length
  const shown = rows.filter(r => filter === "all" || (filter === "legacy" ? r.match.legacy.length > 0 : r.match.status === filter))
  const chosen = rows.filter(r => selected.has(rowKey(r)))
  const hidden = chosen.length - shown.filter(r => selected.has(rowKey(r))).length
  const open = rows.filter(r => selectable(r) && !selected.has(rowKey(r)))
  const toggle = (r: MatchRow) => setSelected(s => { const next = new Map(s); next.has(rowKey(r)) ? next.delete(rowKey(r)) : next.set(rowKey(r), defaultMode(r)); return next })
  // Pro updates outdated policies in place by default (assignments kept); otherwise the new version is created alongside.
  const defaultMode = (r: MatchRow): Mode => canUpdate && r.match.status === "outdated" && r.match.tenant ? "update" : "create"
  const setMode = (r: MatchRow, mode: Mode) => setSelected(s => new Map(s).set(rowKey(r), mode))
  const batches = loader.loaded.map(({ catalog }) => batchFor(catalog, chosen.filter(r => r.platform === catalog.platform).map(r => selected.get(rowKey(r)) === "update" && r.match.tenant
    ? { source: r.policy.source, mode: "update" as const, targetId: r.match.tenant.id, targetName: r.match.tenant.name }
    : { source: r.policy.source, mode: "create" as const }))).filter(b => b.items.length)
  const alongside = chosen.filter(r => r.match.status === "outdated" && selected.get(rowKey(r)) === "create")
  const loading = loader.busy || (loader.failed.length > 0 && !loader.loaded.length)

  function next(finishedJob: DeployJob) {
    const changed = (finishedJob.result ?? []).some(o => o.run && (o.run.created.length || o.run.updated.length))
    return [
      { label: changed ? "Compare again" : "Back to the selection", onClick: toCompare, primary: true },
      { label: "Done", onClick: () => { setSelected(new Map()); setStep("platforms") } },
    ]
  }

  const description = step === "platforms" ? "Compare the OpenIntuneBaseline policies in your tenant with the selected version, then deploy missing or outdated policies."
    : step === "compare" && loader.loaded.length ? <>Comparing against OpenIntuneBaseline {versionsLabel(loader.loaded.map(l => l.catalog))}. Policies are matched on the OIBID in their description, or on their name for older versions; settings are not compared here. Use Policy Validation to check settings.</>
    : undefined

  return <>
    <FlowShell title="Existing Deployment" steps={STEPS} step={step} onStep={goTo} locked={loader.busy || running} description={description}>
      {step === "platforms" && <>
        <PlatformPicker value={platforms} onChange={setPlatforms} />
        <ChangeVersions platforms={platforms} />
        <ActionBar summary={platforms.length ? `${platformsLabel(platforms)} selected` : "Select at least one platform"}>
          <button type="button" className={primary} disabled={!platforms.length} onClick={compare}>Compare<ArrowRight className="h-4 w-4" aria-hidden="true" /></button>
        </ActionBar>
      </>}

      {step === "compare" && (loading ? <>
        <LoadProgress loader={loader} platforms={platforms} selections={selections} />
        <ActionBar status={loader.line} back={{ onClick: () => goTo("platforms") }} />
      </> : <>
        {loader.failed.length > 0 && <div className="mb-5"><LoadProgress loader={loader} platforms={loader.failed} selections={selections} /></div>}
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Up to date" value={count("current")} tone="green" />
          <StatCard label="Update available" value={count("outdated")} tone="amber" />
          <StatCard label="New policies" value={count("missing")} tone="blue" />
          <StatCard label="Newer than OIB" value={count("newer")} />
          <StatCard label="Ambiguous" value={count("duplicate")} tone="red" />
          <StatCard label="With other copies" value={count("legacy")} />
        </div>
        <MatchNotes loaded={loader.loaded} legacy />
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter policies">
            {FILTERS.map(f => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={cn("rounded-full border px-4 py-2 text-sm transition-colors", filter === f ? "border-transparent bg-primary text-primary-foreground" : "border-gray-200 text-gray-600 hover:bg-gray-50")}>{filterLabel(f)} ({count(f)})</button>)}
          </div>
          <span className="flex-1" />
          <button type="button" className={button} onClick={compare}><RefreshCw className="h-4 w-4" aria-hidden="true" />Compare again</button>
          <button ref={exportButton} type="button" className={button} disabled={pdf.saving || !rows.length} onClick={() => void pdf.save(() => savePdf(comparisonReport(loader.loaded, tenant.tenantId, tenant.name), `OIB existing deployment comparison ${tenant.name} ${new Date().toISOString().slice(0, 10)}`))}><FileText className="h-4 w-4" aria-hidden="true" />Export PDF</button>
        </div>
        <ul className="mt-4 divide-y divide-gray-100 overflow-hidden rounded-2xl bg-gray-50">{shown.map(r => {
          const k = rowKey(r), mode = selected.get(k), reason = disabledReason(r)
          return <li key={k} className="flex flex-wrap items-start gap-3 p-3 text-sm">
            <input type="checkbox" aria-label={`Select ${r.policy.name}`} checked={!!mode} disabled={!!reason} title={reason} onChange={() => toggle(r)} className="mt-1 h-4 min-h-0 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-gray-900">{r.policy.name}<span className="ml-2 text-xs text-gray-500">{OIB_PLATFORMS[r.platform].label} · {policyTypeName(r.policy.policyType)}</span></p>
              {r.match.tenant && <p className="mt-1 text-xs text-gray-600">Tenant policy: {r.match.tenant.name}</p>}
              <div className="mt-1"><StatusBadge match={r.match} /></div>
              {reason && r.match.status !== "current" && <p className="mt-1 text-xs text-gray-600">{reason}</p>}
              {r.match.legacy.length > 0 && <div className="mt-1 text-xs text-amber-800"><p>{r.match.legacy.length === 1 ? "Another copy" : "Other copies"} of this policy also deployed (older versions or extra copies), review for removal; {r.match.legacy.length === 1 ? "it keeps" : "they keep"} applying until removed:</p><ul className="mt-1 list-disc space-y-0.5 pl-5">{r.match.legacy.map(l => <li key={l.id}>{l.name}<span className="ml-2 font-mono opacity-80">{l.id}</span></li>)}</ul></div>}
              {r.policy.status === "deprecated" && <p className="mt-1 text-xs text-amber-800">Deprecated{r.policy.replacements.length ? `; replaced by ${r.policy.replacements.map(x => x.name).join(", ")}` : ""}.</p>}
            </div>
            {mode && r.match.status === "outdated" && <div className="w-full text-xs text-gray-700 sm:w-80">
              <label>How to update
                <select value={mode} onChange={e => setMode(r, e.target.value as Mode)} className="mt-1 block h-9 w-full rounded-full border border-gray-300 bg-white px-3 text-sm">
                  <option value="create">Create the new version alongside</option>
                  <option value="update" disabled={!canUpdate}>Update the existing policy in place{canUpdate ? "" : " (Pro)"}</option>
                </select>
              </label>
              {mode === "create" && <p className="mt-1 flex items-start gap-1 text-amber-800"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />The old version stays in the tenant and keeps applying until you remove it.</p>}
              {mode === "update" && <p className="mt-1 text-gray-600">Replaces the settings of {r.match.tenant?.name ?? "the tenant policy"}; assignments stay.</p>}
              {!canUpdate && <span className="mt-1 flex items-center gap-1">Updating in place keeps assignments <PlanBadge feature="replaceRestore" /></span>}
            </div>}
          </li>
        })}{!shown.length && <li className="p-6 text-center text-sm text-gray-500">No policies in this category.</li>}</ul>
        <ActionBar summary={<div className="space-y-2"><p>{chosen.length ? `${chosen.length} selected${hidden ? `, ${hidden} not shown by this filter` : ""}` : "Select missing or outdated policies to deploy"}</p><Notice result={pdf.result} onDismiss={pdf.clear} /></div>}
          status={loader.line ?? (pdf.saving ? "Preparing the PDF report" : null)} back={{ onClick: () => goTo("platforms") }}>
          <button type="button" className={button} disabled={!selected.size} onClick={() => setSelected(new Map())}>Clear selection</button>
          <button type="button" className={button} disabled={!open.length} onClick={() => setSelected(s => new Map([...s, ...open.map(r => [rowKey(r), defaultMode(r)] as const)]))}>Select all missing and outdated{open.length ? ` (${open.length})` : ""}</button>
          <button type="button" className={primary} disabled={!batches.length} onClick={() => setStep("review")}>Review deployment ({chosen.length})<ArrowRight className="h-4 w-4" aria-hidden="true" /></button>
        </ActionBar>
      </>)}

      {step === "review" && <ReviewDeploy flow="existing" batches={batches} onBack={toCompare} onFinished={() => platforms.length && refresh()} next={next}
        notes={alongside.length > 0 && <div role="note" className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-950">
          <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />{plural(alongside.length, "policy is", "policies are")} created alongside {alongside.length === 1 ? "its" : "their"} old version.</p>
          <p className="mt-1 text-xs leading-5">The old {alongside.length === 1 ? "version stays" : "versions stay"} in the tenant with {alongside.length === 1 ? "its" : "their"} assignments and {alongside.length === 1 ? "keeps" : "keep"} applying settings until you remove {alongside.length === 1 ? "it" : "them"} in Intune. Compare again afterwards lists {alongside.length === 1 ? "it" : "them"} under Other copies to review.</p>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs">{alongside.map(r => <li key={rowKey(r)}>{r.match.tenant?.name ?? r.policy.name} stays next to {r.policy.name}</li>)}</ul>
        </div>} />}
    </FlowShell>
    {step !== "platforms" && <section className={cn(card, "mt-5")} aria-label="Deployment runs"><RunsList tenant={tenant} flow="existing" onChanged={() => { if (step === "compare" || job) refresh(); else stale.current = true }} empty="No runs in this tenant can be undone yet." /></section>}
  </>
}
