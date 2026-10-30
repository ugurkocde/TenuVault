import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Chip } from "~/components/dashboard/tiles"
import type { FeatureTabProps } from "../types"
import { loadList } from "../hygiene/api"
import { listAdoptions, listCustomizations } from "../standards/api"
import { formatDate } from "../scores/api"
import { buildDeviations, deviationKindLabel, type DeviationKind } from "./model"
import { GovernanceExportButtons } from "../shared/GovernanceExportButtons"
import { deviationsCsv, deviationsJson } from "../shared/governance-export"
import { FreshnessStrip } from "./FreshnessStrip"

const selectClass = "h-9 rounded-full border border-gray-200 bg-white px-3 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"

/**
 * Accepted deviations: every place this tenant knowingly differs, in one register.
 * Documented customizations, acknowledged and false positive hygiene findings, and
 * approved standard exceptions, each with owner, reason and expiry where recorded.
 * Read-only by design: changing a decision happens on the owning screen, and every
 * decision is recorded in the Audit Log.
 */
export default function DeviationsTab({ tenant }: FeatureTabProps) {
  const tenantId = tenant.credentials?.tenantId
  const [kind, setKind] = useState<DeviationKind | "all">("all")
  const [expiredOnly, setExpiredOnly] = useState(false)
  const customizations = useQuery({ queryKey: ["customizations", tenantId], queryFn: () => listCustomizations(tenant), enabled: !!tenantId })
  const hygiene = useQuery({ queryKey: ["hygiene", tenantId], queryFn: () => loadList(tenant), enabled: !!tenantId })
  const adoptions = useQuery({ queryKey: ["standards", "adoptions", tenantId], queryFn: () => listAdoptions(tenant), enabled: !!tenantId })

  const all = useMemo(() => buildDeviations({ customizations: customizations.data?.customizations ?? [], findings: hygiene.data?.findings ?? [], adoptions: adoptions.data?.adoptions ?? [] }), [customizations.data, hygiene.data, adoptions.data])
  const shown = all.filter((entry) => (kind === "all" || entry.kind === kind) && (!expiredOnly || entry.expired))
  const loading = customizations.isLoading || hygiene.isLoading || adoptions.isLoading
  const error = customizations.error ?? hygiene.error ?? adoptions.error

  return (
    <div className="space-y-6">
      <section aria-label="Accepted deviations" className="space-y-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <h3 className="text-lg font-medium text-gray-900">Accepted deviations</h3>
            <p className="max-w-3xl text-sm text-gray-500">One register of what this tenant knowingly does differently: documented customizations, hygiene findings a reviewer accepted or marked false positive, and approved standard exceptions. Expired entries need a new decision on their owning screen. Decisions are recorded in the <Link to="/portal/audit" className="font-medium text-gray-900 underline underline-offset-2">Audit Log</Link>.</p>
            <FreshnessStrip source="stored customization, hygiene review and adoption records" at={hygiene.data?.scans[0]?.collectedAt ?? null} />
          </div>
          <GovernanceExportButtons kind="deviations" tenantName={tenant.name} disabled={shown.length === 0 || loading || !!error} buildCsv={() => deviationsCsv(shown)} buildJson={(exportedAt) => deviationsJson(shown, tenant.name, exportedAt)} />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-gray-500">
            Kind
            <select className={selectClass} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
              <option value="all">All</option>
              <option value="customization">Customizations</option>
              <option value="hygiene-review">Hygiene reviews</option>
              <option value="standard-exception">Standard exceptions</option>
            </select>
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm text-gray-700">
            <input type="checkbox" className="size-4" checked={expiredOnly} onChange={(event) => setExpiredOnly(event.target.checked)} />
            Expired only
          </label>
          <p className="pb-2 text-xs text-gray-500" aria-live="polite">{shown.length} of {all.length} deviations shown.</p>
        </div>
        {loading && <div className="h-24 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-800" aria-hidden="true" />}
        {error && <p role="alert" className="text-sm text-red-700">{error instanceof Error ? error.message : "Deviations could not be loaded."}</p>}
        {!loading && !error && shown.length === 0 && <p className="text-sm text-gray-600">No accepted deviations recorded. Document one under <Link to="/portal/governance/customizations" className="font-medium text-gray-900 underline underline-offset-2">Customizations</Link>, or accept a finding in <Link to="/portal/governance/hygiene" className="font-medium text-gray-900 underline underline-offset-2">Conflicts and hygiene</Link>.</p>}
        {shown.length > 0 && (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {shown.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 text-sm">
                <span className="min-w-0 flex-1">
                  <Link to={entry.link} className="block break-words font-medium text-gray-900 underline-offset-2 hover:underline">{entry.title}</Link>
                  <span className="block break-words text-xs text-gray-500">
                    {entry.settingKey ?? "No setting recorded"}{entry.policyName ? `, ${entry.policyName}` : ""}. {entry.reason}
                  </span>
                  <span className="block text-xs text-gray-500">
                    Owner: {entry.owner ?? "not recorded"}. {entry.decidedAt ? `Decided ${formatDate(entry.decidedAt)}. ` : ""}{entry.evidenceAt ? `Evidence ${formatDate(entry.evidenceAt)}. ` : ""}{entry.expiresAt ? `Expires ${formatDate(entry.expiresAt)}.` : "No expiry recorded."}
                  </span>
                </span>
                <span className="flex flex-wrap gap-1.5">
                  <Chip tone="neutral">{deviationKindLabel(entry.kind)}</Chip>
                  <Chip tone={entry.expired ? "danger" : entry.status === "false-positive" ? "neutral" : "warning"}>{entry.expired ? "Expired" : entry.status}</Chip>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
