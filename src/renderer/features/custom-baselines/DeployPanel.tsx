import { showFeaturePlanError } from "../../lib/plan-dialog"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useTenants, type Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { allows, type Plan } from "../../../shared/plans"
import { toast } from "../../lib/toast"
import { useConfirm } from "~/components/ConfirmDialog"
import { ChangeSetFlow } from "../shared/ChangeSetFlow"
import { workflowChangeActions } from "../baseline-upgrades/api"
import { deployBaseline, getDeployment, PATH, type Baseline, type Deployment, type VersionView } from "./api"

const card = "space-y-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]"

/**
 * Deploys the viewed version: TenuVault plans create and update operations against the target
 * tenant's Settings Catalog policies (matched by name without version suffix) and freezes them
 * in a change set that is reviewed, approved and applied here with a pre-change backup.
 * Assignments are never written; created policies are unassigned.
 */
export function DeployPanel({ tenant, baseline, version, allowed, plan, deployments, onChanged }: { tenant: Tenant; baseline: Baseline; version: VersionView; allowed: boolean; plan: Plan | null; deployments: Deployment[]; onChanged: () => void }) {
  const tenants = useTenants()
  const owner = baseline.tenantId
  const targets = tenants.filter((entry) => entry.credentials?.tenantId)
  const [targetId, setTargetId] = useState(tenant.credentials?.tenantId ?? "")
  const [selected, setSelected] = useState<string | null>(null)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const target = targets.find((entry) => entry.credentials?.tenantId === targetId) ?? tenant
  const opened = selected ? JSON.parse(selected) as { tenantId: string; id: string } : null
  const openedTenant = opened ? targets.find((entry) => entry.credentials?.tenantId === opened.tenantId) ?? tenant : null
  const detail = useQuery({ queryKey: ["custom-baselines", "deployment", selected], queryFn: () => getDeployment(openedTenant!, opened!.id), enabled: !!opened && !!openedTenant })
  const other = target.credentials?.tenantId !== tenant.credentials?.tenantId
  const { confirm, confirmDialog } = useConfirm()

  const deploy = async () => {
    if (!(await confirm({ title: "Plan this deployment?", description: `Plan a deployment of ${baseline.name} v${version.version} into ${target.name}? TenuVault reads its policies and creates a change set for review. Nothing is written until you approve and apply it.`, confirmLabel: "Plan deployment" }))) return
    setBusy(true)
    try {
      const result = await deployBaseline(target, owner, baseline.id, version.version, selection.size ? [...selection] : null)
      toast(`Change set created with ${result.changeSet.operations.length} operation(s). Review it below.`, "success")
      setSelected(JSON.stringify({ tenantId: target.credentials!.tenantId, id: result.deployment.id }))
      onChanged()
    } catch (error) {
      showFeaturePlanError(error)
      toast(error instanceof Error ? error.message : "The deployment could not be planned.", "error")
    } finally {
      setBusy(false)
    }
  }

  const refresh = () => {
    void detail.refetch()
    onChanged()
  }

  return (
    <div className="space-y-6">
      {confirmDialog}
      {allowed && (
        <section aria-label="Deploy" className={card}>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Deploy version {version.version}</h3>
          <p className="max-w-3xl text-sm text-gray-600 dark:text-gray-400">Policies with the same name (without version suffix) are updated in place and keep their scope tags and assignments; the others are created unassigned with the Default scope tag. Policies with secret or tenant-specific values, several matches or a different platform or template are left out and listed. A change set holds at most 25 operations.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-gray-500">Target tenant
              <select className="h-10 rounded-full border border-gray-200 bg-white px-3 text-sm dark:border-gray-700 dark:bg-gray-900" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                {targets.map((entry) => <option key={entry.id} value={entry.credentials!.tenantId}>{entry.name}{entry.credentials!.tenantId === owner ? " (this baseline's tenant)" : ""}</option>)}
              </select>
            </label>
            <p className="self-end text-xs text-gray-500">{other ? (plan && allows(plan, "portfolio") ? "MSP: any connected tenant on MSP." : "Pro: only the other tenant covered by the same license. Both licenses are checked.") : "The baseline's own tenant."}</p>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-xs text-gray-500">Policies (none selected deploys all)</legend>
            <div className="grid max-h-48 gap-1 overflow-auto sm:grid-cols-2">
              {version.policies.map((policy) => (
                <label key={policy.key} className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                  <input type="checkbox" className="h-4 min-h-0 w-4" checked={selection.has(policy.key)} onChange={(event) => { const next = new Set(selection); event.target.checked ? next.add(policy.key) : next.delete(policy.key); setSelection(next) }} />
                  <span className="truncate">{policy.name}</span>
                  {policy.nonPortable.length > 0 && <Chip tone="warning">blocked</Chip>}
                </label>
              ))}
            </div>
          </fieldset>
          <Button type="button" disabled={busy} onClick={() => void deploy()}>{busy ? "Reading the target tenant" : `Plan deployment into ${target.name}`}</Button>
        </section>
      )}

      <section aria-label="Deployments" className={card}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Deployments into {tenant.name}</h3>
        {!deployments.length && <p className="text-sm text-gray-600 dark:text-gray-400">No deployment of this baseline into this tenant is recorded.</p>}
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {deployments.map((entry) => {
            const key = JSON.stringify({ tenantId: tenant.credentials?.tenantId, id: entry.id })
            return (
              <li key={entry.id}>
                <button type="button" aria-pressed={selected === key} onClick={() => setSelected(selected === key ? null : key)} className="flex w-full flex-wrap items-center gap-3 rounded-2xl px-2 py-3 text-left hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 dark:hover:bg-gray-900">
                  <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-gray-900 dark:text-gray-100">{entry.title}</span><span className="block text-xs text-gray-500">{entry.summary}</span></span>
                  <Chip tone={entry.status === "applied" ? "success" : entry.status === "failed" || entry.status === "uncertain" ? "danger" : "coral"}>{entry.status}</Chip>
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      {detail.data && openedTenant && (
        <section aria-label="Deployment" className={card}>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{detail.data.deployment.title} into {openedTenant.name}</h3>
          <ul className="space-y-1 text-sm">
            {detail.data.deployment.policies.map((policy) => (
              <li key={policy.key} className="flex flex-wrap items-center gap-2">
                <Chip tone={policy.action === "blocked" ? "warning" : policy.action === "unchanged" ? "neutral" : "coral"}>{policy.action}</Chip>
                <span className="text-gray-900 dark:text-gray-100">{policy.name}</span>
                {policy.outcome && <span className="text-xs text-gray-500">{policy.outcome}</span>}
                {policy.reason && <span className="block w-full pl-2 text-xs text-gray-500">{policy.reason}</span>}
              </li>
            ))}
          </ul>
          {detail.data.changeSets.map((changeSet) => (
            <div key={changeSet.id} className="rounded-3xl border border-gray-100 p-4 dark:border-gray-800">
              <ChangeSetFlow changeSet={changeSet} actions={allowed ? workflowChangeActions(PATH, "", openedTenant, detail.data.deployment.id, changeSet.id) : null} tenantName={openedTenant.name} onChanged={refresh} rollbackHint="Rollback change set created. Review and apply it below." />
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
