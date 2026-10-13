import { showFeaturePlanError } from "../../lib/plan-dialog"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Chip } from "~/components/dashboard/tiles"
import { canUse, GatedButton } from "../../components/PlanGate"
import { toast } from "../../lib/toast"
import type { FeatureTabProps } from "../types"
import { usePortfolioTargets } from "../health-review/portfolio-targets"
import { listAdoptions, listStandards, portfolioAdoptions, type AdoptionState } from "./api"
import { AdoptionPanel } from "./AdoptionPanel"
import { CustomizationsPanel } from "./CustomizationsPanel"
import { StandardsLibrary } from "./StandardsLibrary"
import { standardsViewState } from "./state"
import { Button } from "~/components/ui/button"

const card = "space-y-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]"

const freshness = (state: AdoptionState) => (state.freshness === "unknown" ? "not assessed" : state.freshness === "stale" ? "stale" : `${state.deviations ?? 0} deviation(s)`)

/**
 * Standards and customizations (#148). Pro: the organization's documented customizations. MSP:
 * reusable golden standards (shared, no tenant evidence), this customer's adoption with
 * parameters, overlay and exceptions, and a portfolio of adoptions. Without a plan it shows
 * stored records read-only.
 */
export default function StandardsTab({ tenant, plan, allowed }: FeatureTabProps) {
  const tenantId = tenant.credentials?.tenantId
  const msp = canUse(plan, "goldenStandards")
  const [selected, setSelected] = useState<string | null>(null)
  const [portfolio, setPortfolio] = useState<Awaited<ReturnType<typeof portfolioAdoptions>> | null>(null)
  const targets = usePortfolioTargets(tenant)
  const standards = useQuery({ queryKey: ["standards", "library", tenantId], queryFn: () => listStandards(tenant), enabled: !!tenantId })
  const adoptions = useQuery({ queryKey: ["standards", "adoptions", tenantId], queryFn: () => listAdoptions(tenant), enabled: !!tenantId })
  const versions = standards.data?.standards ?? []
  const records = adoptions.data?.adoptions ?? []
  const refresh = () => {
    void standards.refetch()
    void adoptions.refetch()
  }
  const view = standardsViewState({ isLoading: standards.isLoading || adoptions.isLoading, hasError: !!(standards.error ?? adoptions.error), standardsCount: versions.length, adoptionsCount: records.length })
  const loadError = standards.error ?? adoptions.error

  return (
    <div className="space-y-6">
      <CustomizationsPanel tenant={tenant} allowed={allowed} />

      {view === "loading" && (
        <div aria-label="Loading standards" className="space-y-4">
          <div className="h-24 animate-pulse rounded-3xl bg-gray-100 dark:bg-gray-800" />
          <div className="h-24 animate-pulse rounded-3xl bg-gray-100 dark:bg-gray-800" />
        </div>
      )}
      {view === "error" && (
        <section role="alert" aria-label="Standards could not be loaded" className={card}>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Standards could not be loaded</h3>
          <p className="text-sm text-red-700 dark:text-red-400">{loadError instanceof Error ? loadError.message : "Standards could not be loaded."}</p>
          <div>
            <Button type="button" variant="outline" onClick={refresh}>Retry</Button>
          </div>
        </section>
      )}
      {view === "empty" && !msp && (
        <section aria-label="No standards yet" className={card}>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">No standards yet</h3>
          <p className="max-w-3xl text-sm text-gray-500">No standards have been published and none have been adopted for this tenant yet. Published standards and stored adoptions appear here.</p>
        </section>
      )}
      {view === "empty" && msp && records.length === 0 && (
        <section aria-label="No adoptions yet" className={card}>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">No adoptions yet</h3>
          <p className="max-w-3xl text-sm text-gray-500">No standard has been adopted for this tenant yet. Adopt a published standard to track its version, deviations and upgrades here.</p>
        </section>
      )}

      {(msp || versions.length > 0) && <StandardsLibrary tenant={tenant} standards={versions} adoptedKeys={records.map((record) => record.standardKey)} canWrite={msp} onChanged={refresh} />}
      {!msp && allowed && (
        <section aria-label="Golden standards" className={card}>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Golden standards for customers</h3>
          <p className="max-w-3xl text-sm text-gray-500">Reusable versioned standards with parameters, customer overlays and approved exceptions, adopted per customer through reviewed change sets.</p>
          <GatedButton feature="goldenStandards" plan={plan} type="button">Create a golden standard</GatedButton>
        </section>
      )}

      {records.length > 0 && (
        <section aria-label="Adoptions" className={card}>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{msp ? `Standards adopted by ${tenant.name}` : "Stored adoptions (read-only)"}</h3>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {records.map((record) => (
              <li key={record.id}>
                <button type="button" aria-pressed={selected === record.id} onClick={() => setSelected(selected === record.id ? null : record.id)} className="flex w-full flex-wrap items-center gap-3 rounded-2xl px-2 py-3 text-left hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 dark:hover:bg-gray-900">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">{record.title}</span>
                    <span className="block text-xs text-gray-500">Adopted {record.state.adoptedVersion ? `v${record.state.adoptedVersion}` : "not yet"}; latest v{record.state.latestVersion ?? "?"}; {freshness(record.state)}.</span>
                  </span>
                  {record.state.pendingUpgrade && <Chip tone="coral">upgrade available</Chip>}
                  <Chip tone={record.status === "adopted" ? "success" : record.status === "draft" ? "neutral" : "warning"}>{record.status}</Chip>
                </button>
              </li>
            ))}
          </ul>
          {selected && <AdoptionPanel key={selected} tenant={tenant} adoptionId={selected} standards={versions} canWrite={msp} onChanged={refresh} />}
        </section>
      )}

      {(msp || allowed) && (
        <section aria-label="Adoption portfolio" className={card}>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Adoption across customers</h3>
          <p className="max-w-3xl text-sm text-gray-500">Adopted version, pending upgrade, deviation and assessment freshness for {targets.included.length + 1} tenant(s). {targets.excluded.length ? `${targets.excluded.length} connected tenant(s) without MSP are not included.` : ""}</p>
          <GatedButton feature="portfolio" plan={plan} type="button" variant="outline" onClick={() => void portfolioAdoptions(tenant, targets.ids).then(setPortfolio).catch((error: unknown) => { showFeaturePlanError(error); toast(error instanceof Error ? error.message : "The portfolio could not be loaded.", "error") })}>Load portfolio</GatedButton>
          {portfolio && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-gray-500"><tr><th className="py-1 pr-3 font-medium">Tenant</th><th className="pr-3 font-medium">Standard</th><th className="pr-3 font-medium">Adopted</th><th className="pr-3 font-medium">Latest</th><th className="font-medium">Deviation</th></tr></thead>
                <tbody>
                  {portfolio.tenants.flatMap((entry) => (entry.adoptions.length ? entry.adoptions : [null]).map((state, index) => (
                    <tr key={`${entry.tenantId}-${index}`} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="py-1 pr-3 text-gray-900 dark:text-gray-100">{entry.name ?? entry.tenantId}</td>
                      <td className="pr-3 text-gray-700 dark:text-gray-300">{state?.title ?? "none"}</td>
                      <td className="pr-3 text-gray-700 dark:text-gray-300">{state?.adoptedVersion ? `v${state.adoptedVersion}` : "not yet"}</td>
                      <td className="pr-3 text-gray-700 dark:text-gray-300">{state ? `v${state.latestVersion ?? "?"}${state.pendingUpgrade ? " (upgrade pending)" : ""}` : ""}</td>
                      <td className="text-gray-700 dark:text-gray-300">{state ? freshness(state) : ""}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
