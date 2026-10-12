import { showFeaturePlanError } from "../../lib/plan-dialog"
import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { frameworks } from "../../../shared/frameworks/catalog"
import { OIB_PLATFORMS, type OibPlatform, type OibVersions } from "../../../shared/oib/types"
import { defaultSelection, selectionLabel } from "../../../shared/oib/versions"
import { toast } from "../../lib/toast"
import { compareFramework, compareTenant, getComparison, type Baseline, type Comparison, type FrameworkInput, type VersionView } from "./api"

const card = "space-y-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]"
const select = "h-10 rounded-full border border-gray-200 bg-white px-3 text-sm dark:border-gray-700 dark:bg-gray-900"
const STATUS_TONE: Record<string, "neutral" | "coral" | "success" | "warning" | "danger"> = { Present: "success", Missing: "warning", Different: "danger", Review: "neutral", matches: "success", different: "danger", missing: "warning" }

/** Pack and native framework options; CIS stays under its own gate and is not offered while disabled. */
const packFrameworks = frameworks.filter((entry) => !entry.nativeId && !entry.disabledReason && entry.id !== "ncsc-dsg")
const nativeFrameworks = frameworks.filter((entry) => entry.nativeId && !entry.disabledReason)

/**
 * Compares the viewed version with the tenant (latest complete backup or a live read) or with a
 * framework. Framework results never read the tenant and say so: "compared with baseline <name>
 * v<n>, not with the live tenant". Stored comparisons stay readable on every plan.
 */
export function ComparePanel({ tenant, baseline, version, allowed, comparisons, onChanged }: { tenant: Tenant; baseline: Baseline; version: VersionView; allowed: boolean; comparisons: Comparison[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [choice, setChoice] = useState("oib")
  const [platform, setPlatform] = useState<OibPlatform>(baseline.provenance.platform ?? "windows")
  // The OpenIntuneBaseline versions the main process resolved; the only ones it loads.
  const [versions, setVersions] = useState<OibVersions | null>(null)
  const selection = versions ? defaultSelection(versions, platform) : null
  const commit = selection?.commit ?? null
  const detail = useQuery({ queryKey: ["custom-baselines", "comparison", selected], queryFn: () => getComparison(tenant, selected!), enabled: !!selected })

  useEffect(() => {
    void fetch("/api/oib", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "oib-versions" }) })
      .then((response) => response.json())
      .then((result: Partial<OibVersions>) => setVersions(result.main && Array.isArray(result.releases) ? result as OibVersions : null))
      .catch(() => setVersions(null))
  }, [])

  const run = async (action: () => Promise<{ comparison: Comparison }>) => {
    setBusy(true)
    try {
      const { comparison } = await action()
      setSelected(comparison.id)
      onChanged()
    } catch (error) {
      showFeaturePlanError(error)
      toast(error instanceof Error ? error.message : "The comparison failed.", "error")
    } finally {
      setBusy(false)
    }
  }
  const target = (): FrameworkInput => (choice === "oib" ? { kind: "oib", platform, commit: commit! } : choice === "ncsc" ? { kind: "ncsc" } : choice.startsWith("native:") ? { kind: "native", frameworkId: choice.slice(7) } : { kind: "workspace", frameworkId: choice.slice(10) })

  return (
    <div className="space-y-6">
      {allowed && (
        <section aria-label="Compare" className={card}>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Compare version {version.version}</h3>
          <div className="space-y-2 rounded-2xl border border-gray-100 p-4 dark:border-gray-800">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">With {tenant.name}</p>
            <p className="text-xs text-gray-500">Shows where the tenant's Settings Catalog policies deviate from this version. Reads a backup or the live tenant; writes nothing.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => compareTenant(tenant, baseline.id, version.version, "backup"))}>Compare with the latest complete backup</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => compareTenant(tenant, baseline.id, version.version, "live"))}>Compare with the live tenant</Button>
            </div>
          </div>
          <div className="space-y-2 rounded-2xl border border-gray-100 p-4 dark:border-gray-800">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">With a framework</p>
            <p className="text-xs text-gray-500">Runs the framework comparison with this baseline instead of the tenant. Evidence a baseline cannot hold (assignments, other policy types, Conditional Access) stays unknown.</p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs text-gray-500">Framework
                <select className={select} value={choice} onChange={(event) => setChoice(event.target.value)}>
                  <option value="oib">OpenIntuneBaseline (latest)</option>
                  <option value="ncsc">UK NCSC Device Security Guidance</option>
                  {packFrameworks.map((entry) => <option key={entry.id} value={`workspace:${entry.id}`}>{entry.name} (your saved pack)</option>)}
                  {nativeFrameworks.map((entry) => <option key={entry.id} value={`native:${entry.id}`}>{entry.name}</option>)}
                </select>
              </label>
              {choice === "oib" && (
                <>
                  <label className="flex flex-col gap-1 text-xs text-gray-500">Platform
                    <select className={select} value={platform} onChange={(event) => setPlatform(event.target.value as OibPlatform)}>{(Object.keys(OIB_PLATFORMS) as OibPlatform[]).map((id) => <option key={id} value={id}>{OIB_PLATFORMS[id].label}</option>)}</select>
                  </label>
                  <p className="text-xs text-gray-500">{selection ? `Latest release: ${selectionLabel(selection)}` : "The latest OpenIntuneBaseline version could not be read."}</p>
                </>
              )}
              <Button type="button" disabled={busy || (choice === "oib" && !commit)} onClick={() => void run(() => compareFramework(tenant, baseline.id, version.version, target()))}>{busy ? "Comparing" : "Compare"}</Button>
            </div>
          </div>
        </section>
      )}

      <section aria-label="Comparisons" className={card}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Saved comparisons</h3>
        {!comparisons.length && <p className="text-sm text-gray-600 dark:text-gray-400">No comparison of this baseline is stored.</p>}
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {comparisons.map((entry) => (
            <li key={entry.id}>
              <button type="button" aria-pressed={selected === entry.id} onClick={() => setSelected(selected === entry.id ? null : entry.id)} className="flex w-full flex-wrap items-center gap-3 rounded-2xl px-2 py-3 text-left hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 dark:hover:bg-gray-900">
                <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-gray-900 dark:text-gray-100">{entry.title}</span><span className="block text-xs text-gray-500">{entry.summary} {new Date(entry.createdAt).toLocaleString()}</span></span>
                <Chip tone="neutral">{entry.kind === "tenant" ? "tenant" : "framework"}</Chip>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {detail.data && <ComparisonView comparison={detail.data.comparison} />}
    </div>
  )
}

const deviations = (policy: NonNullable<Comparison["tenantPolicies"]>[number]) => policy.differences.filter((difference) => difference.kind !== "unsupported").length

function ComparisonView({ comparison }: { comparison: Comparison }) {
  const [filter, setFilter] = useState("All")
  const findings = (comparison.findings ?? []).filter((finding) => filter === "All" || finding.status === filter)
  return (
    <section aria-label="Comparison" className={card}>
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{comparison.title}</h3>
      <p role="note" className="rounded-2xl bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:bg-blue-950/40 dark:text-blue-200">{comparison.label}</p>
      <p className="text-sm text-gray-600 dark:text-gray-400">{comparison.summary}</p>

      {comparison.tenantPolicies && (
        <ul className="space-y-2">
          {comparison.tenantPolicies.map((policy) => (
            <li key={policy.key} className="rounded-2xl border border-gray-100 p-3 text-sm dark:border-gray-800">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={policy.state === "matched" ? (deviations(policy) ? "warning" : "success") : policy.state === "missing" ? "warning" : "neutral"}>{policy.state === "matched" ? (deviations(policy) ? `${deviations(policy)} deviations` : policy.differences.length ? "matches, some values not comparable" : "matches") : policy.state === "ambiguous" || policy.state === "unreadable" ? "unknown" : policy.state}</Chip>
                <span className="text-gray-900 dark:text-gray-100">{policy.name}</span>
              </div>
              {policy.note && <p className="mt-1 text-xs text-gray-500">{policy.note}</p>}
              {policy.differences.length > 0 && (
                <table className="mt-2 w-full text-left text-xs">
                  <thead className="text-gray-500"><tr><th className="py-1 pr-2 font-medium">Setting</th><th className="pr-2 font-medium">Baseline</th><th className="font-medium">Tenant</th></tr></thead>
                  <tbody>{policy.differences.map((difference) => <tr key={difference.key} className="border-t border-gray-100 align-top dark:border-gray-800"><td className="break-all py-1 pr-2 font-mono">{difference.key}{difference.kind === "unsupported" ? <span className="block font-sans text-gray-500">not comparable: {difference.note}</span> : null}</td><td className="break-all pr-2 font-mono text-gray-600 dark:text-gray-400">{difference.base ?? "absent"}</td><td className="break-all font-mono text-gray-600 dark:text-gray-400">{difference.local ?? "absent"}</td></tr>)}</tbody>
                </table>
              )}
            </li>
          ))}
        </ul>
      )}

      {comparison.findings && (
        <>
          <div className="flex flex-wrap gap-2" aria-label="Filter findings">
            {["All", "Present", "Missing", "Different", "Review"].map((status) => (
              <button key={status} type="button" aria-pressed={filter === status} onClick={() => setFilter(status)} className={`rounded-full border px-4 py-2 text-sm ${filter === status ? "border-transparent bg-primary text-primary-foreground" : "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300"}`}>{status} <span className="ml-1 font-semibold">{(comparison.findings ?? []).filter((finding) => status === "All" || finding.status === status).length}</span></button>
            ))}
          </div>
          <p className="text-xs text-gray-500">Present means the baseline configures the recommended value; it says nothing about assignments or devices. Review means the pack holds alternatives or the baseline value is masked.</p>
          <ul className="max-h-[32rem] space-y-1 overflow-auto text-sm">
            {findings.slice(0, 500).map((finding) => <li key={finding.key} className="flex flex-wrap items-center gap-2"><Chip tone={STATUS_TONE[finding.status] ?? "neutral"}>{finding.status}</Chip><span className="text-gray-900 dark:text-gray-100">{finding.policyName}</span><span className="break-all font-mono text-xs text-gray-500">{finding.settingId}</span></li>)}
          </ul>
          {findings.length > 500 && <p className="text-xs text-gray-500">The first 500 of {findings.length} findings are shown.</p>}
        </>
      )}

      {comparison.native && (
        <>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            {Object.entries(comparison.counts).map(([key, value]) => <div key={key} className="rounded-2xl bg-gray-50 p-3 dark:bg-gray-900"><dt className="text-xs text-gray-500">{key === "unableToCheck" ? "unknown" : key}</dt><dd className="text-lg font-medium text-gray-900 dark:text-gray-100">{value}</dd></div>)}
          </dl>
          <p className="text-xs text-gray-500">Assignments, device state and every policy type outside Settings Catalog are not part of a baseline, so controls that depend on them are not assessed.</p>
          <ul className="max-h-[32rem] space-y-1 overflow-auto text-sm">
            {comparison.native.assessment.frameworks[0]?.controls.map((control) => <li key={control.control.id} className="flex flex-wrap items-center gap-2"><Chip tone={control.status === "partialEvidence" ? "coral" : control.status === "notApplicable" ? "neutral" : "warning"}>{control.status === "notAssessed" ? "unknown" : control.status}</Chip><span className="font-mono text-xs text-gray-500">{control.control.id}</span><span className="text-gray-900 dark:text-gray-100">{control.control.title}</span></li>)}
          </ul>
        </>
      )}
    </section>
  )
}
