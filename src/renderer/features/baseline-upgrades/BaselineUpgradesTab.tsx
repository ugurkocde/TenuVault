import { showFeaturePlanError } from "../../lib/plan-dialog"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { toast } from "../../lib/toast"
import type { FeatureTabProps } from "../types"
import { baselineSources, checkReleases, compareRelease, getUpgrade, listBaselines, recordInstall, type ReleaseOption } from "./api"
import { UpgradeDetail } from "./UpgradeDetail"

const card = "space-y-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]"

/**
 * Baseline upgrades that keep customizations (#144). Record which OIB commit an OpenIntuneBaseline
 * deployment installed, compare it three ways with the latest OpenIntuneBaseline main commit, resolve conflicts, and apply through a
 * reviewed change set. Without the plan it lists stored records read-only.
 */
export default function BaselineUpgradesTab({ tenant, allowed }: FeatureTabProps) {
  const tenantId = tenant.credentials?.tenantId
  const [selected, setSelected] = useState<string | null>(null)
  const [releases, setReleases] = useState<Record<string, ReleaseOption[]>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const list = useQuery({ queryKey: ["baseline-upgrades", tenantId], queryFn: () => listBaselines(tenant), enabled: !!tenantId })
  const sources = useQuery({ queryKey: ["baseline-upgrades", tenantId, "sources"], queryFn: () => baselineSources(tenant), enabled: !!tenantId && allowed })
  const detail = useQuery({ queryKey: ["baseline-upgrades", tenantId, selected], queryFn: () => getUpgrade(tenant, selected!), enabled: !!selected })
  const installs = list.data?.installs ?? []
  const upgrades = list.data?.upgrades ?? []
  if (!allowed && !installs.length && !upgrades.length) return null

  const refresh = () => {
    void list.refetch()
    void sources.refetch()
    if (selected) void detail.refetch()
  }
  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label)
    try {
      await action()
    } catch (error) {
      showFeaturePlanError(error)
      toast(error instanceof Error ? error.message : "The request failed.", "error")
    } finally {
      setBusy(null)
      refresh()
    }
  }
  const unrecorded = (sources.data?.runs ?? []).filter((run) => !run.recorded)

  return (
    <div className="space-y-6">
      {allowed && unrecorded.length > 0 && (
        <section aria-label="OpenIntuneBaseline deployments" className={card}>
          <div>
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Record an installed baseline</h3>
            <p className="max-w-3xl text-sm text-gray-500">OpenIntuneBaseline deployments on this device (including earlier Quick Start runs), with the policies they created or updated. Recording one stores the exact OIB content as the base of later three-way comparisons. When the deployed commit is not recorded, the baseline is recorded with unknown provenance and upgrades are compared manually.</p>
          </div>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {unrecorded.map((entry) => (
              <li key={entry.runId} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1 text-gray-900 dark:text-gray-100">{entry.reference}<span className="block text-xs text-gray-500">{new Date(entry.createdAt).toLocaleString()}. {entry.policies} policies created.</span></span>
                <Button type="button" variant="outline" disabled={!!busy} onClick={() => void run(`record-${entry.runId}`, async () => {
                  const result = await recordInstall(tenant, entry.runId)
                  toast(result.install.status === "tracked" ? "Installed baseline recorded." : "Recorded with unknown provenance; upgrades are compared manually.", result.install.status === "tracked" ? "success" : "info")
                })}>Record</Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Installed baselines" className={card}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{allowed ? "Installed baselines" : "Stored baselines (read-only)"}</h3>
        {list.isLoading && <div className="h-16 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-800" />}
        {list.error && <p className="text-sm text-red-700 dark:text-red-400">{list.error instanceof Error ? list.error.message : "Baselines could not be loaded."}</p>}
        {list.data && !installs.length && <p className="text-sm text-gray-600">No installed baseline is recorded yet. Deploy one in the OpenIntuneBaseline section, then record it here.</p>}
        <ul className="space-y-3">
          {installs.map((install) => (
            <li key={install.id} className="rounded-2xl border border-gray-100 p-3 text-sm dark:border-gray-800">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={install.status === "tracked" ? "success" : install.status === "mixed" ? "warning" : "neutral"}>{install.status === "unknown-provenance" ? "source unknown" : install.status}</Chip>
                <span className="min-w-0 flex-1 text-gray-900 dark:text-gray-100">{install.reference}</span>
                <span className="text-xs text-gray-500">Customization version {install.customizationVersion}</span>
              </div>
              <p className="mt-1 text-xs text-gray-500">{install.summary}{install.latestKnownRelease ? ` Newer OpenIntuneBaseline version known: ${install.latestKnownRelease.reference}.` : ""}</p>
              {allowed && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={() => void run(`releases-${install.id}`, async () => {
                    const result = await checkReleases(tenant, install.id)
                    setReleases({ ...releases, [install.id]: result.releases })
                    toast(result.releases.length ? `A newer OpenIntuneBaseline version is available: ${result.releases[0]!.tag}.` : result.warning ?? "This baseline is based on the latest OpenIntuneBaseline version.", result.releases.length ? "success" : "info")
                  })}>Check the latest OpenIntuneBaseline version</Button>
                  {(releases[install.id] ?? []).map((release) => (
                    <Button key={release.commit} type="button" size="sm" disabled={!!busy} onClick={() => void run(`compare-${release.commit}`, async () => {
                      const result = await compareRelease(tenant, install.id, release.commit)
                      setSelected(result.upgrade.id)
                    })}>Compare with {release.tag}</Button>
                  ))}
                  {install.origin.type === "workspace" && <Button type="button" size="sm" disabled={!!busy} onClick={() => void run("compare-workspace", async () => { setSelected((await compareRelease(tenant, install.id, null)).upgrade.id) })}>Compare with the workspace pack</Button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {upgrades.length > 0 && (
        <section aria-label="Upgrades" className={card}>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Upgrades</h3>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {upgrades.map((upgrade) => (
              <li key={upgrade.id}>
                <button type="button" aria-pressed={selected === upgrade.id} onClick={() => setSelected(selected === upgrade.id ? null : upgrade.id)} className="flex w-full flex-wrap items-center gap-3 rounded-2xl px-2 py-3 text-left hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 dark:hover:bg-gray-900">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">{upgrade.title}</span>
                    <span className="block text-xs text-gray-500">{upgrade.summary}</span>
                  </span>
                  <Chip tone={upgrade.status === "applied" ? "success" : upgrade.status === "review" ? "warning" : "coral"}>{upgrade.status}</Chip>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.data && (
        <section aria-label="Upgrade" className={card}>
          <UpgradeDetail key={detail.data.upgrade.id} tenant={tenant} upgrade={detail.data.upgrade} comparison={detail.data.comparison} changeSets={detail.data.changeSets} allowed={allowed} onChanged={refresh} />
        </section>
      )}
    </div>
  )
}
