import { useMemo } from "react"
import { Link } from "react-router-dom"
import { useMutation } from "@tanstack/react-query"
import { Building2 } from "lucide-react"
import { useTenants, type Tenant } from "~/contexts/TenantContext"
import { Chip } from "~/components/dashboard/tiles"
import type { Plan } from "../../../shared/plans"
import { GatedButton } from "../../components/PlanGate"
import { tenantLicense, tenantPlan, useLicense } from "../../lib/license"
import { useInternalCisBenchmarks } from "../../lib/internal-cis"
import { formatDate, formatPercent, groupUnavailable, loadPortfolio, namesLabel, type PortfolioTenant } from "./api"
import { cisCardPath, loadPortfolioCis } from "./cis"

/**
 * MSP portfolio: scores of every connected tenant whose license includes the portfolio, each
 * with its own freshness and coverage, and a drill-down to that tenant's score detail, shown
 * in the one detail panel of the scores tab. Tenants that are not licensed for it are listed
 * as not included, never guessed. With internal CIS access each tenant's saved CIS benchmarks
 * are listed too, with the rates of that tenant's Governance CIS cards.
 */
export function PortfolioScores({ tenant, plan, onDrill }: { tenant: Tenant; plan: Plan | null; onDrill: (tenant: Tenant, frameworkId: string) => void }) {
  const tenants = useTenants()
  const { status } = useLicense()
  const selectedId = tenant.credentials?.tenantId?.toLowerCase()
  const { included, excluded } = useMemo(() => {
    const others = tenants.filter((candidate) => candidate.credentials?.tenantId && candidate.credentials.tenantId.toLowerCase() !== selectedId)
    const licensed = (candidate: Tenant) => tenantPlan(tenantLicense(status, candidate.credentials?.tenantId)) === "msp"
    return { included: others.filter(licensed), excluded: others.filter((candidate) => !licensed(candidate)) }
  }, [tenants, status, selectedId])
  const cisAccess = useInternalCisBenchmarks()
  const load = useMutation({
    mutationFn: async () => {
      const targets = included.map((candidate) => candidate.credentials!.tenantId!)
      const [scores, cis] = await Promise.all([loadPortfolio(tenant, targets), loadPortfolioCis(cisAccess, [tenant.credentials!.tenantId!, ...targets])])
      return { ...scores, cis }
    },
  })
  const byId = (id: string) => tenants.find((candidate) => candidate.credentials?.tenantId?.toLowerCase() === id)

  return (
    <section aria-label="Portfolio scores" className="space-y-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-medium text-gray-900">
            <Building2 className="h-4 w-4 text-gray-500" aria-hidden="true" />
            Portfolio
          </h3>
          <p className="text-sm text-gray-500">Scores per customer tenant from each tenant's own saved comparisons.</p>
        </div>
        <GatedButton feature="portfolio" plan={plan} variant="outline" size="sm" disabled={load.isPending} onClick={() => load.mutate()}>
          {load.isPending ? "Loading" : load.data ? "Refresh portfolio" : "Load portfolio"}
        </GatedButton>
      </div>
      {excluded.length > 0 && <p className="text-xs text-gray-500">Not included (no MSP license or not signed in): {excluded.map((candidate) => candidate.name).join(", ")}.</p>}
      {load.error && <p className="text-sm text-red-700">{load.error instanceof Error ? load.error.message : "The portfolio could not be loaded."}</p>}
      {load.data && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">Tenant</th>
                <th scope="col" className="py-2 pr-4 font-medium">Framework</th>
                <th scope="col" className="py-2 pr-4 font-medium">Score</th>
                <th scope="col" className="py-2 pr-4 font-medium">Coverage</th>
                <th scope="col" className="py-2 pr-4 font-medium">Assessed</th>
                <th scope="col" className="py-2 font-medium"><span className="sr-only">Drill down</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {load.data.tenants.flatMap((row: PortfolioTenant) => {
                const assessed = row.frameworks.filter((framework) => framework.state !== "not-assessed" && framework.state !== "unavailable")
                const failed = row.frameworks.filter((framework) => framework.state === "unavailable")
                const name = row.tenantName ?? row.tenantId
                const cis = load.data.cis.get(row.tenantId.toLowerCase())
                // CIS benchmarks are listed with the rate of the tenant's CIS card; CIS checks configuration, so there is no coverage.
                const cisRows = [...(cis?.cards ?? []).map((card) => (
                  <tr key={`${row.tenantId}:cis:${card.key}`}>
                    <td className="py-2 pr-4 text-gray-800">{name}</td>
                    <td className="py-2 pr-4 text-gray-700">
                      {card.title}
                      <span className="block text-xs text-gray-500">CIS Benchmarks{card.version ? `, version ${card.version}` : ""}</span>
                    </td>
                    <td className="py-2 pr-4 tabular-nums text-gray-900">
                      {card.levels.length ? card.levels.map((level) => (
                        <span key={level.level} className="block">
                          Level {level.level} {level.rate === null ? "not available" : `${level.rate}%`}
                          <span className="block text-xs text-gray-500">{level.label}</span>
                          {/* The rate with exclusions and its date, as the CIS card shows them. */}
                          {level.withExclusions !== null && <span className="block text-xs text-gray-700">{level.withExclusions}<span className="block text-gray-500">Exclusions as of {formatDate(`${level.exclusionsAsOf}T00:00:00`)}</span></span>}
                        </span>
                      )) : "Not available"}
                    </td>
                    <td className="py-2 pr-4 text-xs text-gray-500">Not counted: CIS checks configuration</td>
                    <td className="py-2 pr-4 text-gray-700">{formatDate(card.assessedAt)}</td>
                    <td className="py-2 text-right">
                      <Link to={cisCardPath(card, row.tenantId.toLowerCase() === selectedId ? undefined : row.tenantId)} aria-label={`Open ${card.title} for ${name}`} className="text-sm font-medium text-gray-800 underline underline-offset-2 hover:text-gray-950">Open</Link>
                    </td>
                  </tr>
                )), ...(cis?.error ? [
                  <tr key={`${row.tenantId}:cis:error`}>
                    <td className="py-2 pr-4 text-gray-800">{name}</td>
                    <td colSpan={5} className="py-2 text-gray-500">CIS Benchmarks unavailable: {cis.error}</td>
                  </tr>,
                ] : [])]
                // Frameworks that failed for the same reason are one row, not one row each.
                const errorRows = (row.error ? [{ message: row.error, names: [] as string[] }] : groupUnavailable(failed)).map((group) => (
                  <tr key={`${row.tenantId}:error:${group.message}`}>
                    <td className="py-2 pr-4 text-gray-800">{name}</td>
                    <td colSpan={4} className="py-2 text-gray-500">{group.names.length ? `${namesLabel(group.names)} unavailable: ` : ""}{group.message}</td>
                    <td className="py-2 text-right">
                      <button type="button" className="text-sm font-medium text-gray-800 underline underline-offset-2 hover:text-gray-950" disabled={load.isPending} onClick={() => load.mutate()}>Retry</button>
                    </td>
                  </tr>
                ))
                if (!row.error && !assessed.length && !failed.length) {
                  if (cisRows.length) return cisRows
                  return [
                    <tr key={row.tenantId}>
                      <td className="py-2 pr-4 text-gray-800">{name}</td>
                      <td colSpan={5} className="py-2 text-gray-500">No saved comparison yet.</td>
                    </tr>,
                  ]
                }
                if (row.error) return [...errorRows, ...cisRows]
                return [...assessed.map((framework) => {
                  const target = byId(row.tenantId)
                  return (
                    <tr key={`${row.tenantId}:${framework.frameworkId}`}>
                      <td className="py-2 pr-4 text-gray-800">{name}</td>
                      <td className="py-2 pr-4 text-gray-700">
                        {framework.frameworkName}
                        {framework.version && <span className="block text-xs text-gray-500">{framework.version}</span>}
                      </td>
                      <td className="py-2 pr-4 tabular-nums text-gray-900">{formatPercent(framework.score)}</td>
                      {framework.state === "history-only" ? (
                        // Results kept in history only have no score and so no coverage: the reason says why.
                        <td className="py-2 pr-4 text-xs text-gray-500">{framework.message ?? "Kept in history only, no score."}</td>
                      ) : (
                        <td className="py-2 pr-4 tabular-nums text-gray-700">
                          {formatPercent(framework.coverage, framework.score === null ? "None" : "Unknown")}
                          {framework.unknown ? <span className="block text-xs text-gray-500">{framework.unknown} unknown</span> : null}
                        </td>
                      )}
                      <td className="py-2 pr-4 text-gray-700">
                        {formatDate(framework.assessedAt)}
                        <span className="ml-1 inline-flex gap-1">
                          {framework.stale && <Chip tone="warning">Stale</Chip>}
                          {framework.partial && <Chip tone="warning">Partial</Chip>}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        {target && framework.state !== "history-only" && (
                          <button type="button" aria-label={`Score details for ${name}, ${framework.frameworkName}`} className="text-sm font-medium text-gray-800 underline underline-offset-2 hover:text-gray-950" onClick={() => onDrill(target, framework.frameworkId)}>
                            Details
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                }), ...errorRows, ...cisRows]
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
