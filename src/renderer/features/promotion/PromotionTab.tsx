import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useTenants } from "~/contexts/TenantContext"
import { Chip } from "~/components/dashboard/tiles"
import type { FeatureTabProps } from "../types"
import { ChangeSetFlow } from "../shared/ChangeSetFlow"
import { STATUS_TONE } from "../shared/change-set"
import { PromotionPlanner } from "./PromotionPlanner"
import { getPromotion, listPromotions, promotionActions, rollbackActions, type Promotion } from "./api"

const card = "space-y-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]"

const tone = (status: Promotion["status"]) => (status === "blocked" ? "danger" : STATUS_TONE[status])

/**
 * Dev to Prod settings promotion (#145). The selected tenant is the production destination.
 * One-way, started by the admin, never continuous: select, review the destination diff and
 * dependencies, approve, back up production and apply with read-back, then read results and
 * review, approve and apply a rollback. On Pro the source must be the other tenant of the same license; the
 * main process enforces it. Without the plan it lists stored promotions read-only.
 */
export default function PromotionTab({ tenant, allowed }: FeatureTabProps) {
  const tenantId = tenant.credentials?.tenantId
  const sources = useTenants().filter((entry) => entry.credentials?.tenantId && entry.credentials.tenantId !== tenantId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sourceChanges, setSourceChanges] = useState<string[]>([])
  const list = useQuery({ queryKey: ["promotion", tenantId], queryFn: () => listPromotions(tenant), enabled: !!tenantId })
  const detail = useQuery({ queryKey: ["promotion", tenantId, selectedId], queryFn: () => getPromotion(tenant, selectedId!), enabled: !!selectedId })
  const promotions = list.data?.promotions ?? []
  if (!allowed && !promotions.length) return null
  const refresh = () => {
    void list.refetch()
    if (selectedId) void detail.refetch()
  }
  const promotion = detail.data?.promotion
  const changeSet = detail.data?.changeSet
  const rollbackChangeSet = detail.data?.rollbackChangeSet

  return (
    <div className="space-y-6">
      {allowed && (
        <section aria-label="Plan a promotion" className={card}>
          <div>
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Promote settings into {tenant.name}</h3>
            <p className="max-w-3xl text-sm text-gray-500">Supported: Settings Catalog policies, compliance policies, endpoint security policies and device configuration profiles. Promotion copies the reviewed version once; later edits in the source are never synchronized. Production is backed up and its current state captured before anything is written, and assignments stay out unless reviewed.</p>
          </div>
          <PromotionPlanner tenant={tenant} sources={sources} blocked={promotion?.status === "blocked" ? promotion : null} onPlanned={(planned) => { setSelectedId(planned.id); refresh() }} />
        </section>
      )}

      <section aria-label="Promotions" className={card}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{allowed ? "Promotions" : "Stored promotions (read-only)"}</h3>
        {list.isLoading && <div className="h-16 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-800" />}
        {list.error && <p className="text-sm text-red-700 dark:text-red-400">{list.error instanceof Error ? list.error.message : "Promotions could not be loaded."}</p>}
        {list.data && !promotions.length && <p className="text-sm text-gray-600">No promotions yet.</p>}
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {promotions.map((entry) => (
            <li key={entry.id}>
              <button type="button" aria-pressed={selectedId === entry.id} onClick={() => { setSourceChanges([]); setSelectedId(selectedId === entry.id ? null : entry.id) }} className="flex w-full flex-wrap items-center gap-3 rounded-2xl px-2 py-3 text-left hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 dark:hover:bg-gray-900">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">{entry.title}</span>
                  <span className="block text-xs text-gray-500">{new Date(entry.createdAt).toLocaleString()}. {entry.items.length} policies. {entry.summary}</span>
                </span>
                <Chip tone={tone(entry.status)}>{entry.status}</Chip>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {promotion && (
        <section aria-label="Promotion" className={card}>
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Selected policies</p>
            <ul className="space-y-2">
              {promotion.items.map((item) => (
                <li key={item.sourceId} className="rounded-2xl border border-gray-100 p-3 text-sm dark:border-gray-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone={item.blocked ? "danger" : "success"}>{item.blocked ? "blocked" : "ready"}</Chip>
                    <span className="text-gray-900 dark:text-gray-100">{item.sourceName}</span>
                    <span className="text-xs text-gray-500">{item.action === "update" ? `updates ${item.destinationId}` : "creates a new policy"}; source version {item.sourceVersion ?? "unknown"}</span>
                  </div>
                  {item.findings.length > 0 && (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                      {item.findings.map((finding, index) => <li key={index} className={finding.severity === "blocking" ? "text-red-700 dark:text-red-400" : "text-gray-600 dark:text-gray-400"}>{finding.message}</li>)}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
          {sourceChanges.length > 0 && (
            <ul className="list-disc space-y-1 rounded-2xl bg-amber-50 p-4 pl-8 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {sourceChanges.map((line, index) => <li key={index}>{line}</li>)}
            </ul>
          )}
          {changeSet && (
            <ChangeSetFlow
              key={changeSet.id}
              changeSet={changeSet}
              actions={allowed ? promotionActions(tenant, promotion, setSourceChanges) : null}
              tenantName={tenant.name}
              onChanged={refresh}
              rollbackHint="Rollback created. Review, approve and apply it below."
            />
          )}
          {rollbackChangeSet && (
            <div className="space-y-2 border-t border-gray-100 pt-5 dark:border-gray-800">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Rollback</p>
              <ChangeSetFlow key={rollbackChangeSet.id} changeSet={rollbackChangeSet} actions={allowed ? rollbackActions(tenant, promotion) : null} tenantName={tenant.name} onChanged={refresh} />
            </div>
          )}
        </section>
      )}
    </div>
  )
}
