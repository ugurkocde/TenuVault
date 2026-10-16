import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Chip } from "~/components/dashboard/tiles"
import { ChangeSetFlow } from "../shared/ChangeSetFlow"
import { formatDate, STATUS_TONE } from "../shared/change-set"
import { cachedCisCatalog } from "../../lib/cis-catalog-cache"
import { cachedCisSettingNames, loadCisSettingNames } from "../../lib/cis-setting-names"
import { benchmarkTitle, diffDefinitionIds, knownBenchmarkName, referenceDisplayName } from "../../../shared/frameworks/cis-display"
import type { SettingNames } from "../../../shared/intune/drift"
import { deploymentActions, getDeployment, listDeployments, rollbackActions, type Deployment, type DeploymentDetail } from "./api"

const tone = (status: Deployment["status"]) => (status === "blocked" ? "danger" : STATUS_TONE[status])
/**
 * The chips of a deployment: rolled back once its rollback is applied, otherwise its own
 * status plus the state of an existing rollback (rejected, failed, or pending review or apply).
 */
export function deploymentState(deployment: Pick<Deployment, "status" | "rollbackChangeSetId" | "rollbackStatus">): { label: string; tone: ReturnType<typeof tone>; rollback: { label: string; tone: ReturnType<typeof tone> } | null } {
  if (deployment.rollbackChangeSetId && deployment.rollbackStatus === "applied") return { label: "rolled back", tone: "neutral", rollback: null }
  const status = deployment.rollbackStatus
  const rollback = !deployment.rollbackChangeSetId ? null
    : status === "rejected" ? { label: "rollback rejected", tone: "neutral" as const }
      : status === "failed" || status === "partial" ? { label: "rollback failed", tone: "danger" as const }
        : { label: "rollback pending", tone: "warning" as const }
  return { label: deployment.status, tone: tone(deployment.status), rollback }
}

/**
 * A deployment reference such as "id 1.0.0 Level 1" with the id replaced by the benchmark name:
 * the name stamped on the pack when known, else the known name of a delivered benchmark, else the
 * name in the loaded catalog, else the prettified id. Known benchmarks therefore read the same
 * before and after the catalog loads.
 */
export function deploymentReferenceLabel(reference: string, tenantId: string | undefined, packName?: string | null): string {
  const id = reference.trim().split(/\s+/)[0] ?? ""
  if (!id) return reference
  return referenceDisplayName(reference.trim(), packName?.trim() || knownBenchmarkName(id) || benchmarkTitle(id, cachedCisCatalog(tenantId)?.find(benchmark => benchmark.id === id)?.name))
}

/** What a planned deployment does to the tenant, from its planned items: new policies stay unassigned, updates keep the assignments of the policy they change. */
export function deploymentImpactText(items: Deployment["items"]): string {
  const creates = items.filter(item => item.action === "create").length
  const updates = items.filter(item => item.action === "update")
  const assigned = updates.filter(item => item.assignedExposure)
  const parts: string[] = []
  if (creates) parts.push(`Creates ${creates} new ${creates === 1 ? "policy" : "policies"} with no assignments: ${creates === 1 ? "it takes" : "they take"} no effect until an administrator assigns ${creates === 1 ? "it" : "them"} in Intune.`)
  if (updates.length) {
    parts.push(`Updates ${updates.length} existing tenant ${updates.length === 1 ? "policy" : "policies"} in place for the Different findings.`)
    parts.push(assigned.length
      ? `${assigned.length} of them ${assigned.length === 1 ? "is" : "are"} assigned and keep${assigned.length === 1 ? "s" : ""} ${assigned.length === 1 ? "its" : "their"} assignments, so the change reaches those devices after apply.`
      : `${updates.length === 1 ? "It has" : "They have"} no assignments recorded at planning, and assignments are not changed.`)
  }
  parts.push("Assignments are never copied or changed by this flow.")
  return parts.join(" ")
}

/**
 * Every benchmark deployment of the selected tenant, newest first, read from the
 * main process. A deployment stays reachable after a new assessment, a re-run or
 * navigation, so an applied remediation can still be reviewed and rolled back.
 * `focus` opens a deployment that was just planned and reloads the list.
 */
export function CisRemediationHistory({ tenant, focus, onApplied }: { tenant: Tenant; focus: { id: string; at: number } | null; onApplied?: (at: string) => void }) {
  const tenantId = tenant.credentials?.tenantId
  const [deployments, setDeployments] = useState<Deployment[] | null>(null)
  const [error, setError] = useState("")
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<DeploymentDetail | null>(null)
  const [detailError, setDetailError] = useState("")
  const generation = useRef(0)
  const opened = useRef<string | null>(null)
  opened.current = open
  const [names, setNames] = useState<SettingNames>(() => cachedCisSettingNames())
  const rows = useRef(new Map<string, HTMLLIElement>())
  const scrolledFor = useRef<number | null>(null)

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

  // A just planned deployment is scrolled into view once its row is listed.
  useEffect(() => {
    if (!focus || scrolledFor.current === focus.at || !deployments?.some(deployment => deployment.id === focus.id)) return
    scrolledFor.current = focus.at
    rows.current.get(focus.id)?.scrollIntoView?.({ behavior: "smooth", block: "start" })
  }, [focus?.at, deployments])
  // Settings Catalog differences read by setting and option name once the names are read.
  const credentials = tenant.credentials
  useEffect(() => {
    const operations = [...(detail?.changeSet?.operations ?? []), ...(detail?.rollbackChangeSet?.operations ?? [])]
    const ids = [...new Set(operations.flatMap(operation => operation.diff.flatMap(diffDefinitionIds)))]
    if (!ids.length || !credentials?.tenantId || !credentials.appId) return
    let active = true
    void loadCisSettingNames({ tenantId: credentials.tenantId, appId: credentials.appId }, ids).then(read => { if (active) setNames(read) }).catch(() => undefined)
    return () => { active = false }
  }, [detail, credentials?.tenantId])
  const applied = () => onApplied?.(new Date().toISOString())

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
        const state = deploymentState(deployment)
        const shown = expanded && detail?.deployment.id === deployment.id ? detail : null
        return <li key={deployment.id} ref={element => { if (element) rows.current.set(deployment.id, element); else rows.current.delete(deployment.id) }} className="scroll-mt-6 p-3">
          <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : deployment.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left focus-visible:outline focus-visible:outline-2">
            {expanded ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-gray-900">{deployment.title}</span>
              <span className="block text-xs text-gray-500">{deploymentReferenceLabel(deployment.reference, tenantId, deployment.benchmarkName)} · {formatDate(deployment.createdAt)} · {deployment.items.length} {deployment.items.length === 1 ? "operation" : "operations"}</span>
            </span>
            {state.rollback && <Chip tone={state.rollback.tone}>{state.rollback.label}</Chip>}
            <Chip tone={state.tone}>{state.label}</Chip>
          </button>
          {expanded && <div className="mt-4 space-y-5 pl-6">
            {deployment.status === "blocked" && <p className="text-sm text-gray-600">{deployment.summary}</p>}
            {detailError && <p role="alert" className="text-sm text-red-700">{detailError}</p>}
            {!shown && !detailError && deployment.changeSetId && <div className="h-12 animate-pulse rounded-2xl bg-gray-100" />}
            {shown?.changeSet && <ChangeSetFlow changeSet={shown.changeSet} actions={deploymentActions(tenant, shown.deployment)} tenantName={tenant.name} onChanged={refresh} onApplied={applied} embedded settingNames={names} sourceLabel={deploymentReferenceLabel(shown.deployment.reference, tenantId, shown.deployment.benchmarkName)} intro={<p className="rounded-2xl bg-blue-50 px-4 py-3 text-sm text-gray-800">{deploymentImpactText(shown.deployment.items)}</p>} rollbackHint="Rollback change set created. Review and apply it below, then run the comparison again to verify recovery." />}
            {shown?.rollbackChangeSet && <div className="space-y-2 border-t border-gray-100 pt-5">
              <p className="text-sm font-medium text-gray-900">Rollback</p>
              <ChangeSetFlow changeSet={shown.rollbackChangeSet} actions={rollbackActions(tenant, shown.deployment)} tenantName={tenant.name} onChanged={refresh} onApplied={applied} settingNames={names} sourceLabel={deploymentReferenceLabel(shown.deployment.reference, tenantId, shown.deployment.benchmarkName)} />
            </div>}
          </div>}
        </li>
      })}
    </ul>}
  </section>
}
