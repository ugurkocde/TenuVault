import { cisReadiness, type CisReadinessSummary } from "../frameworks/cis-readiness"
import type { RecommendationList, RecommendationListItem } from "../frameworks/cis-manual"
import type { CisException } from "../frameworks/cis-exceptions"
import type { PackRecommendation } from "../frameworks/cis-recommendations"
import type { Assessment, BaselinePolicy, Finding, Json, RecordJson } from "../frameworks/policies"
import type { AssignmentEvidence } from "../frameworks/evidence"
import { generateCisReadinessPDF, type CisReportContext, type CisSamplePresentation } from "./report-pdf"

/**
 * A sample CIS readiness report that every plan can open, so people see what the PDF holds before
 * they assess a tenant. Everything in it is synthetic and built here: a fictional tenant, fictional
 * results, placeholder recommendation ids (S1.1, S2.1), titles and text. Nothing is read from the
 * delivery service, a delivered pack, a recommendation list or the tenant. Only the identity of a
 * certified benchmark is real, so the certification callout and remediation labels read as they do
 * in a real report. The data runs through the same readiness code and PDF generator as a real
 * export, so the sample shows the real report layout and figures that agree with each other.
 */

export const CIS_SAMPLE_MARKER = "SAMPLE DATA"
export const CIS_SAMPLE_TITLE = "Sample CIS readiness report"
export const CIS_SAMPLE_NOTE = "Sample data: a fictional tenant and fictional results, with placeholder recommendation titles and text. This is not a real assessment and not CIS content."
export const CIS_SAMPLE_FILE_NAME = "TenuVault sample CIS readiness report (sample data).pdf"
export const CIS_SAMPLE_PRESENTATION: CisSamplePresentation = { title: CIS_SAMPLE_TITLE, marker: CIS_SAMPLE_MARKER, note: CIS_SAMPLE_NOTE }

const BENCHMARK = "intune-for-defender"
const VERSION = "1.0.0"
const BENCHMARK_NAME = "CIS Microsoft Intune for Microsoft Defender Antivirus Benchmark"
const TENANT_ID = "00000000-0000-4000-8000-000000000000"
const TENANT_NAME = "Contoso (sample)"
const ASSESSED_AT = "2026-11-02T09:00:00.000Z"
const AS_OF = "2026-11-02"

/** How each sample recommendation turns out, in a repeating pattern that gives a realistic mix. */
type SampleOutcome = "pass" | "missing" | "different" | "review" | "outside" | "partial"
const PATTERN: readonly SampleOutcome[] = ["pass", "pass", "pass", "missing", "pass", "pass", "different", "pass", "review", "pass", "pass", "partial", "pass", "pass", "outside", "pass", "pass", "missing"]

/** Each Level of the sample; `missingEvery` adds a further missing setting so the Levels score differently. */
interface LevelSpec { level: 1 | 2; recommendations: number; manual: number; notAssessed: number; missingEvery: number; policies: string[] }
const LEVELS: readonly LevelSpec[] = [
  { level: 1, recommendations: 66, manual: 5, notAssessed: 3, missingEvery: 0, policies: ["Sample policy: account settings", "Sample policy: device security", "Sample policy: network settings", "Sample policy: update settings"] },
  { level: 2, recommendations: 28, manual: 3, notAssessed: 2, missingEvery: 5, policies: ["Sample policy: advanced device security", "Sample policy: advanced network settings"] },
]

const settingId = (level: number, index: number, part = 0) => `sample_setting_s${level}_${index}${part ? `_part${part}` : ""}`
function instance(id: string, value: string): RecordJson {
  return { "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: id, choiceSettingValue: { value: `${id}_${value}`, children: [] } }
}
const targeting = (state: AssignmentEvidence["state"]): AssignmentEvidence => ({ state, targets: state === "unassigned" ? [] : [{ kind: "allDevices" }], limitations: [] })

function placeholderText(kind: "Manual" | "Not assessed", identifier: string): Pick<RecommendationListItem, "title" | "description" | "impact" | "audit" | "remediation"> {
  const subject = kind === "Manual" ? "manual recommendation" : "recommendation not assessed by this tool"
  return {
    title: kind === "Manual" ? `Sample manual recommendation: example review step ${identifier}` : `Sample recommendation: example setting outside the pack ${identifier}`,
    description: `Placeholder description of a ${subject}. In a real report this holds the CIS text of the recommendation from the delivered list.`,
    impact: "Placeholder impact text. A real report states what changes for users and devices.",
    audit: "Placeholder audit text. A real report states how to check the setting by hand.",
    remediation: "Placeholder remediation text. A real report states how to apply the recommendation by hand.",
  }
}

/** The synthetic pack, assessment, recommendation list and exception the sample report is measured from. */
export function cisSampleInputs(): { assessment: Assessment; policies: BaselinePolicy[]; recommendationList: RecommendationList; exceptions: CisException[] } {
  const policies: BaselinePolicy[] = []
  const findings: Finding[] = []
  const items: RecommendationListItem[] = []
  const exceptions: CisException[] = []
  let observedPolicy = 0
  for (const spec of LEVELS) {
    const first = policies.length
    for (const name of spec.policies) policies.push({ name, platforms: "windows10", technologies: "mdm", description: "Synthetic sample policy.", settings: [], provenance: { benchmark: BENCHMARK, version: VERSION, benchmarkName: BENCHMARK_NAME, level: spec.level }, recommendations: [] })
    for (let index = 1; index <= spec.recommendations; index++) {
      const patterned = PATTERN[(index - 1 + spec.level) % PATTERN.length]!
      const outcome: SampleOutcome = spec.missingEvery && patterned === "pass" && index % spec.missingEvery === 0 ? "missing" : patterned
      const identifier = `S${spec.level}.${index}`
      const policyIndex = first + (index % spec.policies.length)
      const policy = policies[policyIndex]!
      const declared = [settingId(spec.level, index)]
      if (outcome === "partial") declared.push(settingId(spec.level, index, 2))
      const recommendation: PackRecommendation = { id: identifier, title: `Sample recommendation: example setting ${identifier}`, level: spec.level, settings: declared }
      policy.recommendations!.push(recommendation)
      items.push({ identifier, level: spec.level, automated: true })
      // A recommendation outside the pack names a setting the pack does not hold, so it is not assessed.
      if (outcome === "outside") continue
      const id = declared[0]!
      const recommended = instance(id, "1")
      const settingIndex = policy.settings.length
      policy.settings.push({ settingInstance: recommended })
      const status: Finding["status"] = outcome === "missing" || outcome === "partial" ? "Missing" : outcome === "different" ? "Different" : outcome === "review" ? "Review" : "Present"
      const observedName = `Contoso (sample) Windows policy ${(observedPolicy++ % 9) + 1}`
      const observed = status === "Missing" ? [] : [{ policyId: `sample-policy-${spec.level}-${index}`, policyName: observedName, value: (status === "Different" ? instance(id, "0") : recommended) as Json, targeting: targeting(index % 11 === 0 ? "unassigned" : "configured") }]
      findings.push({ key: `${policyIndex}:${settingIndex}`, policyIndex, settingIndex, policyName: policy.name, settingId: id, status, recommended, observed })
      // One accepted exception, so the report shows how exclusions read next to the headline.
      if (spec.level === 1 && status === "Different" && !exceptions.length) {
        exceptions.push({ id: "sample-exception-1", benchmark: BENCHMARK, version: VERSION, level: 1, policyName: policy.name, settingId: id, owner: "Sample owner", reason: "Placeholder reason for an accepted exception in this sample report.", expiresOn: "2027-06-30", createdAt: "2026-10-01T09:00:00.000Z" })
      }
    }
    for (let index = 1; index <= spec.manual; index++) {
      const identifier = `S${spec.level}.M${index}`
      // The last manual item has no text, so the report shows the CIS notice with its link in its place.
      items.push({ identifier, level: spec.level, automated: false, ...(index < spec.manual ? placeholderText("Manual", identifier) : { title: `Sample manual recommendation: example review step ${identifier}` }) })
    }
    for (let index = 1; index <= spec.notAssessed; index++) {
      const identifier = `S${spec.level}.N${index}`
      items.push({ identifier, level: spec.level, automated: true, ...placeholderText("Not assessed", identifier) })
    }
  }
  const pack = policies.map(policy => policy.recommendations?.length ? policy : { ...policy, recommendations: undefined })
  return {
    assessment: { runId: "sample-report", tenantId: TENANT_ID, frameworkId: "cis-benchmarks", reference: `${BENCHMARK} ${VERSION}`, assessedAt: ASSESSED_AT, policyCount: 64, findings },
    policies: pack,
    recommendationList: { benchmark: BENCHMARK, version: VERSION, items },
    exceptions,
  }
}

/** The readiness of the synthetic sample, measured by the same code as a real assessment. */
export function cisSampleSummary(): CisReadinessSummary {
  const { assessment, policies, recommendationList, exceptions } = cisSampleInputs()
  return cisReadiness(assessment, policies, undefined, recommendationList, exceptions, AS_OF)
}

export const CIS_SAMPLE_CONTEXT: CisReportContext = { exportedAt: ASSESSED_AT, tenantName: TENANT_NAME, tenantId: TENANT_ID, assessedAt: ASSESSED_AT, runId: "sample-report" }

/** The sample report as PDF bytes, in the default TenuVault design: it describes no tenant, so no branding applies. */
export function generateCisSampleReportPDF(): Uint8Array<ArrayBuffer> {
  return generateCisReadinessPDF(cisSampleSummary(), CIS_SAMPLE_CONTEXT, undefined, CIS_SAMPLE_PRESENTATION)
}
