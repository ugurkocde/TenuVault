import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Tenant } from "~/contexts/TenantContext"
import { Chip } from "~/components/dashboard/tiles"
import { cn } from "~/lib/utils"
import { getCustomBaseline, type Comparison, type Deployment } from "./api"
import { VersionEditor } from "./VersionEditor"
import { DeployPanel } from "./DeployPanel"
import { RebasePanel } from "./RebasePanel"
import { ComparePanel } from "./ComparePanel"

const SECTIONS = [["settings", "Settings"], ["deploy", "Deploy"], ["updates", "OIB updates"], ["compare", "Compare"], ["history", "History"]] as const
type Section = (typeof SECTIONS)[number][0]

/**
 * One baseline: its versions and settings, deployments, rebases onto newer OIB releases and
 * comparisons. Without the plan every section is read-only and shows stored records only.
 */
export default function BaselineDetail({ tenant, baselineId, allowed, deployments, comparisons, onChanged }: { tenant: Tenant; baselineId: string; allowed: boolean; deployments: Deployment[]; comparisons: Comparison[]; onChanged: () => void }) {
  const [section, setSection] = useState<Section>("settings")
  const [viewing, setViewing] = useState<number | null>(null)
  const detail = useQuery({ queryKey: ["custom-baselines", tenant.credentials?.tenantId, baselineId, viewing], queryFn: () => getCustomBaseline(tenant, baselineId, viewing ?? undefined) })
  const refresh = () => {
    void detail.refetch()
    onChanged()
  }
  if (detail.isLoading) return <div className="h-24 animate-pulse rounded-3xl bg-card" />
  if (detail.error || !detail.data) return <p role="alert" className="rounded-3xl bg-red-50 p-4 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">{detail.error instanceof Error ? detail.error.message : "The baseline could not be loaded."}</p>
  const { baseline, version, rebases } = detail.data
  const provenance = baseline.provenance

  return (
    <div className="space-y-6">
      <section className="space-y-2 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]" aria-label="Baseline">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 flex-1 text-2xl font-light text-gray-900 dark:text-gray-100">{baseline.name}</h2>
          <Chip tone="neutral">{baseline.origin === "oib" ? "customized OIB" : "company baseline from a snapshot"}</Chip>
          <Chip tone="coral">current v{baseline.currentVersion}</Chip>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Based on {provenance.reference}{provenance.commit ? ` (commit ${provenance.commit.slice(0, 7)})` : ""}{provenance.collectedAt ? `, taken ${new Date(provenance.collectedAt).toLocaleString()}` : ""}.
          {baseline.latestKnownRelease ? ` A newer OpenIntuneBaseline version is available: ${baseline.latestKnownRelease.reference}.` : ""}
        </p>
        {baseline.excluded.length > 0 && (
          <details className="text-xs text-gray-500">
            <summary className="cursor-pointer">{baseline.excluded.length} source policies are not part of this baseline</summary>
            <ul className="mt-2 space-y-1 pl-4">{baseline.excluded.map((entry) => <li key={entry.name}>{entry.name}: {entry.reason}</li>)}</ul>
          </details>
        )}
      </section>

      <nav aria-label="Baseline sections" className="flex flex-wrap gap-2">
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" aria-current={section === id ? "page" : undefined} onClick={() => setSection(id)} className={cn("rounded-full px-4 py-2 text-sm font-medium transition-colors", section === id ? "bg-primary text-primary-foreground" : "bg-card text-gray-700 hover:bg-secondary dark:text-gray-300")}>{label}</button>
        ))}
      </nav>

      {section === "settings" && <VersionEditor key={version.version} tenant={tenant} baseline={baseline} version={version} allowed={allowed && version.version === baseline.currentVersion} onViewVersion={setViewing} onSaved={() => { setViewing(null); refresh() }} />}
      {section === "deploy" && <DeployPanel tenant={tenant} baseline={baseline} version={version} allowed={allowed} deployments={deployments} onChanged={refresh} />}
      {section === "updates" && <RebasePanel tenant={tenant} baseline={baseline} rebases={rebases} allowed={allowed} onChanged={() => { setViewing(null); refresh() }} />}
      {section === "compare" && <ComparePanel tenant={tenant} baseline={baseline} version={version} allowed={allowed} comparisons={comparisons} onChanged={refresh} />}
      {section === "history" && (
        <section aria-label="Version history" className="space-y-3 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Versions</h3>
          <p className="text-sm text-gray-500">Every save is a new version; earlier versions never change.</p>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {[...baseline.versions].reverse().map((entry) => (
              <li key={entry.version} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <Chip tone={entry.version === baseline.currentVersion ? "coral" : "neutral"}>v{entry.version}</Chip>
                <span className="min-w-0 flex-1 text-gray-900 dark:text-gray-100">{entry.note}<span className="block text-xs text-gray-500">{entry.name}. {entry.policies} policies. {new Date(entry.createdAt).toLocaleString()}{entry.actor ? ` by ${entry.actor}` : ""}. Base: {entry.base.reference}.</span></span>
                <button type="button" className="text-sm text-blue-700 hover:underline dark:text-blue-400" onClick={() => { setViewing(entry.version); setSection("settings") }}>View</button>
              </li>
            ))}
          </ul>
          {baseline.deployments.length > 0 && (
            <>
              <h3 className="pt-2 text-lg font-medium text-gray-900 dark:text-gray-100">Deployments</h3>
              <ul className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
                {[...baseline.deployments].reverse().map((entry) => <li key={entry.deploymentId}>v{entry.version} to tenant {entry.targetTenantId}: {entry.status} ({new Date(entry.at).toLocaleString()})</li>)}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  )
}
