import { useState } from "react"
import type { Tenant } from "~/contexts/TenantContext"
import { featureCall } from "../../lib/feature-api"
import { showFeaturePlanError } from "../../lib/plan-dialog"
import { toast } from "../../lib/toast"
import type { Assessment, BaselinePolicy } from "../../../shared/frameworks/policies"
import { packBenchmarkName, selectedDeviatingFindings } from "../../../shared/frameworks/cis-display"
import { cachedCisCatalog } from "../../lib/cis-catalog-cache"
import { deploymentReferenceLabel } from "./CisRemediationHistory"
import { PATH, type Deployment } from "./api"

/** The deployment title, naming the benchmark by its display name and kept within the 200 character limit. */
export function remediationTitle(whole: boolean, benchmark: string): string {
  const [verb, noun] = whole ? ["Deploy", "policies"] : ["Remediate", "findings"]
  const name = benchmark.trim().slice(0, 200 - verb.length - noun.length - 2).trim()
  return name ? `${verb} ${name} ${noun}` : `${verb} benchmark ${noun}`
}

const button = "inline-flex h-10 items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-5 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"

/**
 * Deploy and remediation from a benchmark assessment. Planning happens in the
 * main process through the change-set engine; this panel only selects findings
 * or whole policies. The planned deployment opens in the remediation history,
 * which hosts the shared review, apply and rollback flow for every deployment.
 */
/** `readOnly` marks saved results, whose findings cannot be selected until the assessment runs again. */
export function CisRemediationPanel({ tenant, assessment, policies, reference, selectedKeys, onPlanned, readOnly = false }: { tenant: Tenant | undefined; assessment: Assessment; policies: BaselinePolicy[]; reference: string; selectedKeys: Set<string>; onPlanned: (deploymentId: string) => void; readOnly?: boolean }) {
  const [busy, setBusy] = useState(false)
  const deviating = selectedDeviatingFindings(assessment.findings, selectedKeys)
  const plan = async (whole: boolean) => {
    if (!tenant || readOnly) return
    setBusy(true)
    const benchmarkId = reference.trim().split(/\s+/)[0] ?? ""
    const benchmarkName = (packBenchmarkName(policies)?.trim() || cachedCisCatalog(tenant.credentials?.tenantId)?.find(benchmark => benchmark.id === benchmarkId)?.name) ?? null
    try {
      const result = await featureCall<{ deployment: Deployment }>(PATH, tenant, "plan", {
        title: remediationTitle(whole, deploymentReferenceLabel(reference, tenant.credentials?.tenantId, benchmarkName)),
        reference, ...(benchmarkName ? { benchmarkName } : {}), runId: assessment.runId, policies: JSON.parse(JSON.stringify(policies)) as unknown[],
        findings: assessment.findings,
        ...(whole ? { selectedPolicyIndexes: [...new Set(deviating.map((finding) => finding.policyIndex))] } : { selectedFindingKeys: deviating.map((finding) => finding.key) }),
      })
      onPlanned(result.deployment.id)
      toast("Benchmark deployment planned. Review it in the remediation history below before applying.", "success")
    } catch (error) { showFeaturePlanError(error); toast(error instanceof Error ? error.message : "Planning failed.", "error") } finally { setBusy(false) }
  }
  return <section aria-labelledby="cis-deploy-title" className="mt-5 rounded-3xl border-2 border-blue-200 bg-white p-7">
    <h2 id="cis-deploy-title" className="text-xl font-medium tracking-tight">3. Deploy or remediate from this assessment</h2>
    <p className="mt-2 text-sm text-gray-600">{readOnly ? "These are saved results. Run again first to get current evidence, then select deviating findings to remediate them to the benchmark value, or deploy whole benchmark policies for them." : "Select deviating findings above to remediate them to the benchmark value, or deploy whole benchmark policies for the selected findings."} New policies are created with no assignments and nothing takes effect until an administrator assigns them in Intune. Assignments are never copied. The preview is an offline comparison against this assessment, not a tenant dry run. Planned deployments open in the remediation history below, where they stay available for review, apply and rollback.</p>
    <div className="mt-4 flex flex-wrap gap-3">
      <button type="button" className={button} disabled={busy || readOnly || !deviating.length || !tenant} onClick={() => void plan(false)}>Plan remediation for {deviating.length} selected findings</button>
      <button type="button" className={button} disabled={busy || readOnly || !deviating.length || !tenant} onClick={() => void plan(true)}>Deploy whole benchmark policies</button>
    </div>
  </section>
}
