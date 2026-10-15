import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Chip } from "~/components/dashboard/tiles"
import { ChangeSetFlow } from "../shared/ChangeSetFlow"
import { formatDate, STATUS_TONE } from "../shared/change-set"
import { deploymentActions, getDeployment, listDeployments, rollbackActions, type Deployment, type DeploymentDetail } from "./api"

const tone = (status: Deployment["status"]) => (status === "blocked" ? "danger" : STATUS_TONE[status])

/**
 * Every benchmark deployment of the selected tenant, newest first, read from the
 * main process. A deployment stays reachable after a new assessment, a re-run or
 * navigation, so an applied remediation can still be reviewed and rolled back.
 * `focus` opens a deployment that was just planned and reloads the list.
 */
export function CisRemediationHistory({ tenant, focus }: { tenant: Tenant; focus: { id: string; at: number } | null }) {
  const tenantId = tenant.credentials?.tenantId
  const [deployments, setDeployments] = useState<Deployment[] | null>(null)
  const [error, setError] = useState("")
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<DeploymentDetail | null>(null)
  const [detailError, setDetailError] = useState("")
  const generation = useRef(0)
  const opened = useRef<string | null>(null)
  opened.current = open

  const loadList = useCallback(async () => {
    const current = ++generation.current
    try {
      const result = await listDeployments(tenant)
      if (generation.current === current) { setDeployments(result.deployments); setError("") }
    } catch (e) {
      if (generation.current === current) setError(e instanceof Error ? e.message : "The remediation history could not be loaded.")
    }
  }, [tenantId])
  const loadDetail = useCallback(async (id: string) => {
    try {
      const result = await getDeployment(tenant, id)
      if (opened.current === id) { setDetail(result); setDetailError("") }
    } catch (e) {
      if (opened.current === id) setDetailError(e instanceof Error ? e.message : "The deployment could not be loaded.")
    }
  }, [tenantId])

  useEffect(() => { void loadList() }, [loadList, focus?.at])
  useEffect(() => { if (focus) setOpen(focus.id) }, [focus?.at])
  useEffect(() => {
    setDetail(null); setDetailError("")
    if (open) void loadDetail(open)
  }, [open, tenantId])

  const refresh = () => {
    void loadList()
    if (open) void loadDetail(open)
  }

  return <section aria-labelledby="cis-remediation-history-title" className="mt-5 rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
    <h2 id="cis-remediation-history-title" className="text-xl font-medium tracking-tight">Remediation history</h2>
    <p className="mt-2 text-sm text-gray-600">Benchmark deployments planned for this tenant, newest first. Open one to review, approve and apply it, or to preview, create and apply its rollback. Run the comparison again after an apply or rollback to verify which findings closed or recovered.</p>
    {error && <p role="alert" className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
    {!deployments && !error && <div className="mt-4 h-12 animate-pulse rounded-2xl bg-gray-100" />}
    {deployments && !deployments.length && <p className="mt-4 text-sm text-gray-500">No benchmark deployments yet for this tenant.</p>}
    {deployments && deployments.length > 0 && <ul className="mt-4 divide-y divide-gray-100 rounded-2xl border border-gray-100">
      {deployments.map(deployment => {
        const expanded = open === deployment.id
        const shown = expanded && detail?.deployment.id === deployment.id ? detail : null
        return <li key={deployment.id} className="p-3">
          <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : deployment.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left focus-visible:outline focus-visible:outline-2">
            {expanded ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-gray-900">{deployment.title}</span>
              <span className="block text-xs text-gray-500">{deployment.reference} · {formatDate(deployment.createdAt)} · {deployment.items.length} {deployment.items.length === 1 ? "operation" : "operations"}{deployment.rollbackChangeSetId ? " · rollback created" : ""}</span>
            </span>
            <Chip tone={tone(deployment.status)}>{deployment.status}</Chip>
          </button>
          {expanded && <div className="mt-4 space-y-5 pl-6">
            {deployment.status === "blocked" && <p className="text-sm text-gray-600">{deployment.summary}</p>}
            {detailError && <p role="alert" className="text-sm text-red-700">{detailError}</p>}
            {!shown && !detailError && deployment.changeSetId && <div className="h-12 animate-pulse rounded-2xl bg-gray-100" />}
            {shown?.changeSet && <ChangeSetFlow changeSet={shown.changeSet} actions={deploymentActions(tenant, shown.deployment)} tenantName={tenant.name} onChanged={refresh} rollbackHint="Rollback change set created. Review and apply it below, then run the comparison again to verify recovery." />}
            {shown?.rollbackChangeSet && <div className="space-y-2 border-t border-gray-100 pt-5">
              <p className="text-sm font-medium text-gray-900">Rollback</p>
              <ChangeSetFlow changeSet={shown.rollbackChangeSet} actions={rollbackActions(tenant, shown.deployment)} tenantName={tenant.name} onChanged={refresh} />
            </div>}
          </div>}
        </li>
      })}
    </ul>}
  </section>
}
