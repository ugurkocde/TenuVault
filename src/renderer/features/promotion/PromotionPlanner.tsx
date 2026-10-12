import { showFeaturePlanError } from "../../lib/plan-dialog"
import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ClipboardList } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { toast } from "../../lib/toast"
import { MappingEditor } from "./MappingEditor"
import { planPromotion, promotionPolicies, type Mapping, type Promotion, type ReferenceResolution } from "./api"

const fieldClass = "h-9 w-full rounded-full border border-gray-200 bg-white px-3 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"

/**
 * Steps 1 and 2 of a promotion: choose the source tenant and policies, choose for each policy
 * whether it creates a new destination policy or updates one chosen explicitly (a same name is
 * only a hint), map dependencies, and plan. Planning reads both tenants and records how each
 * reference resolved; it does not write anything.
 */
export function PromotionPlanner({ tenant, sources, blocked, onPlanned }: { tenant: Tenant; sources: Tenant[]; blocked: Promotion | null; onPlanned: (promotion: Promotion) => void }) {
  const destinationId = tenant.credentials?.tenantId ?? ""
  const [sourceTenantId, setSourceTenantId] = useState(sources[0]?.credentials?.tenantId ?? "")
  const [selected, setSelected] = useState<Record<string, string | null>>({})
  const [includeAssignments, setIncludeAssignments] = useState(false)
  const [acknowledgeRedacted, setAcknowledgeRedacted] = useState(false)
  const [mappings, setMappings] = useState<Mapping[]>([])
  const [title, setTitle] = useState("")
  const [ticket, setTicket] = useState("")
  const [busy, setBusy] = useState(false)
  const [references, setReferences] = useState<ReferenceResolution[]>([])
  const policies = useQuery({ queryKey: ["promotion", "policies", destinationId, sourceTenantId], queryFn: () => promotionPolicies(tenant, sourceTenantId), enabled: !!sourceTenantId })

  // A blocked plan: show the references it resolved so they can be mapped.
  useEffect(() => {
    if (!blocked) return
    setReferences(blocked.items.flatMap((item) => item.references ?? []))
    setSourceTenantId(blocked.sourceTenantId)
    setSelected(Object.fromEntries(blocked.items.map((item) => [item.sourceId, item.destinationId])))
    setIncludeAssignments(blocked.includeAssignments)
    setAcknowledgeRedacted(blocked.acknowledgeRedacted === true)
    setTitle(blocked.title)
    setTicket(blocked.ticket ?? "")
  }, [blocked])

  const destination = policies.data?.destination ?? []
  const toggle = (id: string) => {
    const next = { ...selected }
    if (id in next) delete next[id]
    else if (Object.keys(next).length < 25) next[id] = null
    setSelected(next)
  }

  const plan = async () => {
    setBusy(true)
    try {
      const { promotion } = await planPromotion(tenant, { sourceTenantId, title, ticket, includeAssignments, acknowledgeRedacted, items: Object.entries(selected).map(([sourceId, destinationPolicy]) => ({ sourceId, destinationId: destinationPolicy })), mappings })
      setReferences(promotion.items.flatMap((item) => item.references ?? []))
      toast(promotion.status === "blocked" ? "Planned with blocking findings. Resolve the findings and plan again." : "Planned. Review the destination diff next; nothing was written.", promotion.status === "blocked" ? "info" : "success")
      onPlanned(promotion)
    } catch (error) {
      showFeaturePlanError(error)
      toast(error instanceof Error ? error.message : "The promotion could not be planned.", "error")
    } finally {
      setBusy(false)
    }
  }

  if (!sources.length) return <p className="text-sm text-gray-600">Connect the development tenant covered by the same license to promote from it.</p>

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Source (development) tenant
          <select className={fieldClass} value={sourceTenantId} onChange={(event) => { setSourceTenantId(event.target.value); setSelected({}); setMappings([]); setReferences([]); setAcknowledgeRedacted(false) }}>
            {sources.map((entry) => <option key={entry.credentials!.tenantId} value={entry.credentials!.tenantId}>{entry.name}</option>)}
          </select>
        </label>
        <div className="flex flex-col gap-1 text-xs text-gray-500">
          Destination (production) tenant
          <span className="flex h-9 items-center rounded-full bg-gray-100 px-3 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-100">{tenant.name}</span>
        </div>
      </div>
      {policies.isLoading && <div className="h-16 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-800" />}
      {policies.error && <p className="text-sm text-red-700 dark:text-red-400">{policies.error instanceof Error ? policies.error.message : "Policies could not be read."}</p>}
      {policies.data && (
        <div className="max-h-80 overflow-y-auto rounded-2xl border border-gray-100 dark:border-gray-800">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Settings Catalog policies of the source tenant</caption>
            <thead className="sticky top-0 bg-card text-xs text-gray-500"><tr><th className="p-2 font-normal">Promote</th><th className="p-2 font-normal">Source policy</th><th className="p-2 font-normal">In the destination</th></tr></thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {policies.data.source.map((policy) => {
                const chosen = policy.id in selected
                const sameName = destination.filter((entry) => entry.name.trim().toLowerCase() === policy.name.trim().toLowerCase())
                return (
                  <tr key={policy.id}>
                    <td className="p-2"><input type="checkbox" className="h-4 w-4" aria-label={`Promote ${policy.name}`} checked={chosen} onChange={() => toggle(policy.id)} /></td>
                    <td className="p-2 text-gray-900 dark:text-gray-100">{policy.name}{policy.platforms ? <span className="text-xs text-gray-500"> ({policy.platforms})</span> : null}</td>
                    <td className="p-2">
                      <select className={fieldClass} disabled={!chosen} aria-label={`Destination for ${policy.name}`} value={selected[policy.id] ?? ""} onChange={(event) => setSelected({ ...selected, [policy.id]: event.target.value || null })}>
                        <option value="">Create a new policy</option>
                        {destination.map((entry) => <option key={entry.id} value={entry.id}>Update: {entry.name}{sameName.includes(entry) ? " (same name, confirm it is the same policy)" : ""}</option>)}
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input type="checkbox" className="h-4 w-4" checked={includeAssignments} onChange={(event) => setIncludeAssignments(event.target.checked)} />
        Promote assignments too, after reviewing their mapped groups and filters (default: created unassigned, existing assignments untouched)
      </label>
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input type="checkbox" className="h-4 w-4" checked={acknowledgeRedacted} onChange={(event) => setAcknowledgeRedacted(event.target.checked)} />
        I understand that secrets in this policy are not promoted and must be set again in the destination
      </label>
      {references.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Dependency mappings</p>
          <MappingEditor tenant={tenant} references={references} mappings={mappings} onChange={setMappings} />
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-gray-500">Title<input className={fieldClass} value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="For example Promote OIB Windows 3.6" /></label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">Ticket or reference<input className={fieldClass} value={ticket} maxLength={200} onChange={(event) => setTicket(event.target.value)} placeholder="Optional" /></label>
      </div>
      <Button type="button" size="sm" disabled={busy || !title.trim() || !Object.keys(selected).length} onClick={() => void plan()}>
        <ClipboardList className="h-4 w-4" />
        {busy ? "Reading both tenants" : blocked ? "Plan again" : "Plan promotion"}
      </Button>
    </div>
  )
}
