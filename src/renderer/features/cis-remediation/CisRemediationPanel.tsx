import { useCallback, useEffect, useState } from "react"
import type { Tenant } from "~/contexts/TenantContext"
import { featureCall } from "../../lib/feature-api"
import { showFeaturePlanError } from "../../lib/plan-dialog"
import { toast } from "../../lib/toast"
import type { Assessment, BaselinePolicy } from "../../../shared/frameworks/policies"
import type { CisRemediationRecord } from "../../../main/features/cis-remediation/engine"
import { ChangeSetFlow } from "../shared/ChangeSetFlow"
import type { ChangeSet, ChangeSetActions, ChangeSetPreview, RollbackPreview } from "../shared/change-set"

const PATH = "/api/cis-remediation" as const
type Deployment = CisRemediationRecord & { id: string; createdAt: string; updatedAt: string }
const button = "inline-flex h-10 items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-5 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"

function actions(tenant: Tenant, deployment: Deployment): ChangeSetActions {
  const base = { id: deployment.id }
  return {
    preview: async () => (await featureCall<{ changeSet: ChangeSetPreview }>(PATH, tenant, "preview", base)).changeSet,
    approve: (input) => featureCall(PATH, tenant, "approve", { ...base, ...input }),
    reject: (input) => featureCall(PATH, tenant, "reject", { ...base, ...input }),
    apply: (contentHash) => featureCall(PATH, tenant, "apply", { ...base, contentHash, confirm: true }),
    retry: (contentHash) => featureCall(PATH, tenant, "retry", { ...base, contentHash, confirm: true }),
    rollbackPreview: () => featureCall<RollbackPreview>(PATH, tenant, "rollback-preview", base),
    rollbackCreate: () => featureCall<{ changeSet: ChangeSet }>(PATH, tenant, "rollback-create", base),
  }
}
function rollbackActions(tenant: Tenant, deployment: Deployment): ChangeSetActions {
  const base = { id: deployment.id }
  const none = () => Promise.reject(new Error("A rollback is itself undone by a new reviewed change, not by a rollback of a rollback."))
  return {
    preview: () => featureCall<ChangeSetPreview>(PATH, tenant, "rollback-review", base),
    approve: (input) => featureCall(PATH, tenant, "rollback-approve", { ...base, ...input }),
    reject: (input) => featureCall(PATH, tenant, "rollback-reject", { ...base, ...input }),
    apply: (contentHash) => featureCall(PATH, tenant, "rollback-apply", { ...base, contentHash, confirm: true }),
    retry: (contentHash) => featureCall(PATH, tenant, "rollback-apply", { ...base, contentHash, confirm: true }),
    rollbackPreview: none, rollbackCreate: none,
  }
}

/**
 * Deploy and remediation from a benchmark assessment. Planning happens in the
 * main process through the change-set engine; this panel only selects findings
 * or whole policies and hosts the shared review, apply and rollback flow.
 */
export function CisRemediationPanel({ tenant, assessment, policies, reference, selectedKeys, onRecompare }: { tenant: Tenant | undefined; assessment: Assessment; policies: BaselinePolicy[]; reference: string; selectedKeys: Set<string>; onRecompare: () => void }) {
  const [deployment, setDeployment] = useState<Deployment | null>(null)
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null)
  const [rollbackChangeSet, setRollbackChangeSet] = useState<ChangeSet | null>(null)
  const [busy, setBusy] = useState(false)
  const deviating = assessment.findings.filter((finding) => selectedKeys.has(finding.key) && (finding.status === "Different" || finding.status === "Missing"))
  const refresh = useCallback(async () => {
    if (!deployment || !tenant) return
    const result = await featureCall<{ deployment: Deployment; changeSet: ChangeSet | null; rollbackChangeSet: ChangeSet | null }>(PATH, tenant, "get", { id: deployment.id })
    setDeployment(result.deployment); setChangeSet(result.changeSet); setRollbackChangeSet(result.rollbackChangeSet)
  }, [deployment, tenant])
  useEffect(() => { void refresh().catch(() => undefined) }, [deployment?.id])
  const plan = async (whole: boolean) => {
    if (!tenant) return
    setBusy(true)
    try {
      const result = await featureCall<{ deployment: Deployment }>(PATH, tenant, "plan", {
        title: whole ? "Deploy benchmark policies" : "Remediate benchmark findings",
        reference, runId: assessment.runId, policies: JSON.parse(JSON.stringify(policies)) as unknown[],
        findings: assessment.findings,
        ...(whole ? { selectedPolicyIndexes: [...new Set(deviating.map((finding) => finding.policyIndex))] } : { selectedFindingKeys: deviating.map((finding) => finding.key) }),
      })
      setDeployment(result.deployment)
      const full = await featureCall<{ deployment: Deployment; changeSet: ChangeSet | null; rollbackChangeSet: ChangeSet | null }>(PATH, tenant, "get", { id: result.deployment.id })
      setChangeSet(full.changeSet); setRollbackChangeSet(full.rollbackChangeSet)
      toast("Benchmark deployment planned. Review it below before applying.", "success")
    } catch (error) { showFeaturePlanError(error); toast(error instanceof Error ? error.message : "Planning failed.", "error") } finally { setBusy(false) }
  }
  return <section aria-labelledby="cis-deploy-title" className="mt-5 rounded-3xl border-2 border-blue-200 bg-white p-7">
    <h2 id="cis-deploy-title" className="text-xl font-medium tracking-tight">3. Deploy or remediate from this assessment</h2>
    <p className="mt-2 text-sm text-gray-600">Select deviating findings above to remediate them to the benchmark value, or deploy whole benchmark policies for the selected findings. New policies are created with no assignments and nothing takes effect until an administrator assigns them in Intune. Assignments are never copied. The preview is an offline comparison against this assessment, not a tenant dry run.</p>
    <div className="mt-4 flex flex-wrap gap-3">
      <button type="button" className={button} disabled={busy || !deviating.length || !tenant} onClick={() => void plan(false)}>Plan remediation for {deviating.length} selected findings</button>
      <button type="button" className={button} disabled={busy || !deviating.length || !tenant} onClick={() => void plan(true)}>Deploy whole benchmark policies</button>
      <button type="button" className={button} disabled={busy} onClick={onRecompare}>Run comparison again</button>
    </div>
    {changeSet && deployment && <div className="mt-5"><ChangeSetFlow changeSet={changeSet} actions={tenant ? actions(tenant, deployment) : null} tenantName={tenant?.name ?? ""} onChanged={() => void refresh()} rollbackHint="Rollback change set created. Review and apply it below, then run the comparison again to verify recovery." /></div>}
    {rollbackChangeSet && deployment && <div className="mt-5"><ChangeSetFlow changeSet={rollbackChangeSet} actions={tenant ? rollbackActions(tenant, deployment) : null} tenantName={tenant?.name ?? ""} onChanged={() => void refresh()} /></div>}
    {(changeSet?.status === "applied" || rollbackChangeSet?.status === "applied") && <p className="mt-4 text-sm text-gray-600">Run the comparison again from this screen to verify which findings closed or recovered.</p>}
  </section>
}
