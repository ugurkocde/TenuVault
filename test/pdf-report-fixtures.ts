import { crc32, deflateSync } from "node:zlib"
import { assessCompliance, assessFramework, complianceFrameworks } from "../src/shared/compliance/engine"
import { expectedValue } from "../src/shared/compliance/check-results"
import { FRAMEWORK_SOURCE_COMMIT, FRAMEWORK_USAGE_NOTICE, type NativeAssessment } from "../src/shared/compliance/native"
import type { AssessmentScope, AssignmentSummary, CapabilityResult, ControlAssessment, DetectionSignal, TechnicalCheck } from "../src/shared/compliance/types"
import type { SavedAssessment } from "../src/shared/compliance/export"
import type { CisLevelReadiness, CisReadinessSummary } from "../src/shared/frameworks/cis-readiness"
import { MANUAL_NOT_ASSESSED_NOTE, MANUAL_RECOMMENDATIONS_FALLBACK, MANUAL_RECOMMENDATIONS_URL } from "../src/shared/frameworks/cis-readiness"
import type { Finding } from "../src/shared/frameworks/policies"

/**
 * Fictional Contoso report inputs for the PDF layout tests and scripts/render-sample-reports.ts:
 * synthetic GUIDs, a credible status mix and, with `extreme`, inputs that stress the layout.
 */

export const TENANT_ID = "8f3c2a71-5d4e-4b9a-9c1f-2e6d7b8a9c10"
export const LONG_ID = "A".repeat(300)
export const EXPORTED_AT = "2026-10-14T09:30:00.000Z"
const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const POLICIES = [
  "WIN Baseline BitLocker",
  "WIN Security Defender Antivirus",
  "WIN Compliance Corporate",
  "MAC FileVault enforcement",
  "IOS Restrictions Corporate",
  "AND Work profile Restrictions",
]

function settingFor(signal: DetectionSignal | undefined, fallback: string): string {
  if (!signal) return fallback
  if (signal.source === "settingsCatalog") return signal.settingDefinitionId
  if (signal.source === "graphProperty") return `${signal.odataTypes[0]}.${signal.propertyPath}`
  if (signal.source === "policyCheck") return signal.check
  return signal.settingId
}

const assigned = (index: number): AssignmentSummary => ({
  state: "assigned",
  targets: [index % 2 ? "Group: All Corporate Devices" : "All devices"],
  exclusions: index % 3 === 0 ? ["Group: Kiosk Devices"] : [],
  filters: index % 4 === 0 ? [{ target: "Group: All Corporate Devices", id: guid(9000 + index), mode: "include" }] : [],
  coverage: "unverified",
})

/** Gives each capability a deterministic outcome: mostly matches, some different, missing and unchecked. */
function shape(cap: CapabilityResult, index: number, extreme: boolean): CapabilityResult {
  const signal = cap.capability.signals[0]
  const settingId = settingFor(signal, cap.capability.id)
  const expected = signal ? expectedValue(signal) : "Configured"
  const policyIndex = index % POLICIES.length
  const policy = { policyId: guid(100 + policyIndex), policyName: POLICIES[policyIndex]! }
  const pattern = index % 8
  const check = (result: TechnicalCheck["result"], actual: string | null, assignment?: AssignmentSummary, reason?: string): TechnicalCheck => ({
    assessmentStatus: "checked", result, settingId, expectedValue: expected, actualValue: actual, ...policy, ...(assignment ? { assignment } : {}), ...(reason ? { reason } : {}),
  })
  const evidence = (verdict: "enforced" | "disabled") => (cap.capability.requiredGroups?.length ? cap.capability.requiredGroups : [undefined]).map(group => ({
    capabilityId: cap.capability.id, ...policy, policyType: "settingsCatalog", source: signal?.source ?? "settingsCatalog", settingId, observedValue: expected,
    verdict, assignment: assigned(index), kind: "configuration" as const, policyVersion: "4", policyModifiedAt: "2026-09-28T14:10:00Z", ...(group ? { requirementGroup: group } : {}),
  }))
  if (index === 13) return { ...cap, status: "notApplicable", checks: [{ assessmentStatus: "outsideScope", result: null, settingId, expectedValue: expected, actualValue: null, reason: "The platform of this capability is outside the selected scope." }] }
  if (pattern === 6) return { ...cap, status: "collectionIncomplete", checks: [{ assessmentStatus: "unableToCheck", result: null, settingId, expectedValue: expected, actualValue: null, reason: "Collection completeness is unknown for this policy family. Refresh policy data before concluding a setting is missing." }] }
  if (pattern === 3) return { ...cap, status: "disabledByPolicy", evidence: evidence("disabled"), checks: [check("different", "false", assigned(index), "The assigned policy sets a value that does not enforce this capability.")] }
  if (pattern === 4) return { ...cap, status: "noEvidence", checks: [check("missing", null, assigned(index), "No supported setting was found after checking the collected policies.")] }
  if (pattern === 7) return { ...cap, status: "configuredNotAssigned", checks: [check("matches", expected, { state: "notAssigned", targets: [], exclusions: [], filters: [], coverage: "unverified" })] }
  const checks = [check("matches", expected, assigned(index))]
  if (index === 1) {
    checks.push({ ...check("matches", "\"Enabled\"", assigned(index)), settingId: "./Device/Vendor/MSFT/Policy/Config/ADMX_MicrosoftDefenderAntivirus/Scan_DisableScanningNetworkFiles_with_a_long_vendor_suffix_for_layout", policyName: "WIN Security Defender Antivirus, extended scanning, network files and removable drives (Pilot ring 2)" })
  }
  if (extreme && index === 0) {
    for (let n = 0; n < 200; n++) checks.push({ ...check(n % 5 === 0 ? "different" : "matches", n % 7 === 0 ? LONG_ID : "true", assigned(n)), settingId: n % 3 === 0 ? LONG_ID : `${settingId}_${n}`, policyId: n % 4 === 0 ? LONG_ID : guid(5000 + n), policyName: n % 6 === 0 ? `Contoso ${"very long policy name segment ".repeat(14)}${n}` : policy.policyName })
  }
  return { ...cap, status: "enforced", evidence: evidence("enforced"), checks, limitations: index === 2 ? ["Compliance requirement, not an observed device state. Resource access depends on applicable Conditional Access policies; effective access is unverified."] : [] }
}

/** A saved native comparison of a fictional Contoso tenant. */
export function nativeRun(options: { frameworkId?: string; nativeId?: string; scope?: AssessmentScope; extreme?: boolean } = {}): NativeAssessment {
  const frameworkId = options.frameworkId ?? "nist-800-53"
  const nativeId = options.nativeId ?? "nist-800-53-r5"
  const scope: AssessmentScope = options.scope ?? { platforms: ["windows", "macos", "ios", "android"] }
  const data = { collectedAt: "2026-10-14T08:55:00.000Z", settingsCatalog: [], deviceConfigurations: [], administrativeTemplates: [], compliancePolicies: [], securityBaselines: [], scripts: { windows: [], macOS: [] } }
  const assessment = assessCompliance(data, scope)
  const definition = complianceFrameworks(assessment.scope).find(item => item.id === nativeId)
  if (!definition) throw new Error(`Unknown framework ${nativeId}`)
  const base = assessment.frameworks.find(item => item.framework.id === nativeId)!
  const ids = new Set(base.controls.flatMap(control => [...control.capabilityIds, ...control.excludedCapabilityIds]))
  const capabilities = assessment.capabilities.filter(cap => ids.has(cap.capability.id)).map((cap, index) => shape(cap, index, options.extreme === true))
  const framework = assessFramework(capabilities, definition, assessment.scope)
  if (options.extreme) {
    const extra: ControlAssessment[] = Array.from({ length: Math.max(0, 40 - framework.controls.length) }, (_, index) => ({
      control: { id: `ZZ-${index + 1}`, title: `Synthetic reference ${index + 1} with a title long enough to wrap onto a second line in the overview`, summary: `Synthetic control ${index + 1} used to stress the layout.` },
      capabilityIds: capabilities.slice(index % capabilities.length, (index % capabilities.length) + 2).map(cap => cap.capability.id),
      enforcedCapabilityIds: [], status: index % 3 ? "partialEvidence" : "noEvidence",
      unassessedAspects: index === 0 ? Array.from({ length: 30 }, (_, n) => `Synthetic organizational aspect ${n + 1} that needs a separate review by the information owner.`) : [],
      excludedCapabilityIds: [],
      ...(index === 1 ? { unavailableCheck: { assessmentStatus: "unableToCheck" as const, result: null, settingId: LONG_ID, expectedValue: LONG_ID, actualValue: null, reason: "No supported detector for this synthetic requirement." } } : {}),
    }))
    framework.controls.push(...extra)
  }
  return {
    schemaVersion: 1, runId: "6a1f0c2e-8b7d-4e3a-9f50-1c2d3e4f5a6b", tenantId: TENANT_ID, frameworkId,
    sourceCommit: FRAMEWORK_SOURCE_COMMIT, snapshotSha256: "3b7e1d9c0a4f8e2b6d5c9a1f7e3b0d4c8a2f6e1b9d7c5a3f0e8b4d2c6a9f1e7b", rulesetSha256: "9c4e2a7f1b8d3e6c0a5f9b2d7e4c1a8f3b6d0e9c2a5f8b1d4e7c0a3f6b9d2e5c",
    licenseNotice: "NIST-authored publications: royalty-free reuse with attribution; third-party material excluded.",
    assessment: {
      ...assessment, generatedAt: "2026-10-14T09:02:00.000Z", frameworks: [framework], capabilities,
      collectionCoverage: assessment.collectionCoverage.map((family, index) => ({
        ...family, collectedPolicies: 3 + index * 2, recognizedPolicies: 2 + index, status: index === 3 ? "incomplete" : "complete",
        errors: index === 3 ? [`Graph returned 403 for one security baseline. Grant DeviceManagementConfiguration.Read.All. Request ${guid(77)}${options.extreme ? ` ${LONG_ID}` : ""}`] : [],
      })),
    },
  }
}

/** The usage notice is part of every native report. */
export const NATIVE_NOTICE = FRAMEWORK_USAGE_NOTICE

/** A saved policy pack assessment with every status and a creation outcome. */
export function workspaceAssessment(options: { extreme?: boolean } = {}): SavedAssessment {
  const statuses: Finding["status"][] = ["Present", "Present", "Missing", "Different", "Present", "Review", "Present", "Missing"]
  const settings = ["device_vendor_msft_policy_config_defender_allowrealtimemonitoring", "device_vendor_msft_bitlocker_requiredeviceencryption", "device_vendor_msft_policy_config_localpoliciessecurityoptions_useraccountcontrol_behavioroftheelevationpromptforadministrators", "device_vendor_msft_firewall_mdmstore_domainprofile_enablefirewall", "device_vendor_msft_policy_config_deviceguard_enablevirtualizationbasedsecurity"]
  const count = options.extreme ? 160 : 26
  const findings: Finding[] = Array.from({ length: count }, (_, index) => {
    const status = statuses[index % statuses.length]!
    const settingId = options.extreme && index % 9 === 0 ? LONG_ID : settings[index % settings.length]!
    return {
      key: `${index % 4}:${index}`, policyIndex: index % 4, settingIndex: index, policyName: ["Contoso Windows Defender", "Contoso Windows BitLocker", "Contoso Windows Security options", "Contoso Windows Firewall"][index % 4]!,
      settingId, status, recommended: { settingDefinitionId: settingId, value: "1" },
      observed: status === "Missing" ? [] : [{ policyId: guid(300 + index), policyName: options.extreme && index % 5 === 0 ? `Tenant ${"long observed policy name ".repeat(10)}` : `WIN Tenant policy ${index % 5}`, value: status === "Different" ? "0" : "1", targeting: { state: index % 6 === 0 ? "unavailable" : "configured", targets: [{ kind: "allDevices" }], limitations: [] } }],
    }
  })
  return {
    assessment: { runId: "run-2026-10-14-contoso", tenantId: TENANT_ID, frameworkId: "custom", reference: "Contoso workstation baseline v3", assessedAt: "2026-10-14T08:40:00.000Z", policyCount: 42, findings },
    policies: [0, 1, 2, 3].map(index => ({ name: `Pack policy ${index + 1}`, platforms: "windows10", technologies: "mdm", description: "", settings: [] })),
    creation: { success: false, results: [{ name: "Contoso Windows Firewall", id: guid(401) }, { name: "Contoso Windows Security options", error: "Graph returned 400: the setting value is not valid for this template." }] },
  }
}

function level(levelNumber: 1 | 2, extreme: boolean): CisLevelReadiness {
  const recommendations = Array.from({ length: extreme ? 60 : 8 }, (_, index) => {
    const result = (["Pass", "Pass", "Fail", "Pass", "Review", "Not assessed", "Pass", "Fail"] as const)[index % 8]!
    const id = `${levelNumber === 1 ? 18 : 19}.${(index % 9) + 1}.${index + 1}`
    return {
      id, title: `Ensure synthetic recommendation ${id} is configured as recommended${index === 2 ? " for every domain, private and public network profile of the device" : ""}`,
      level: levelNumber, result,
      settings: [{ id: extreme && index % 10 === 0 ? LONG_ID : `device_vendor_msft_policy_config_synthetic_${index}`, status: result === "Fail" ? "Missing" as const : result === "Review" ? "Review" as const : result === "Not assessed" ? "Unmapped" as const : "Present" as const, findingKeys: [`0:${index}`] }],
      findingKeys: [`0:${index}`],
    }
  })
  return {
    benchmark: "cis-windows-11-enterprise", version: "4.0.0", level: levelNumber,
    assessedSettings: levelNumber === 1 ? 84 : 31, present: levelNumber === 1 ? 61 : 19, different: levelNumber === 1 ? 9 : 4, missing: levelNumber === 1 ? 11 : 6, review: levelNumber === 1 ? 3 : 2,
    passRate: levelNumber === 1 ? 61 / 84 : 19 / 31, excepted: levelNumber === 1 ? 2 : 0,
    exceptions: levelNumber === 1 ? [
      { id: "ex-1", benchmark: "cis-windows-11-enterprise", version: "4.0.0", level: 1, policyName: "Contoso Windows Security options", settingId: "device_vendor_msft_policy_config_localpoliciessecurityoptions_interactivelogon_machineinactivitylimit", owner: "Ada Lovelace", reason: "Shared lab devices keep a longer inactivity limit until the kiosk migration completes.", expiresOn: "2027-01-31", createdAt: "2026-09-01T10:00:00Z" },
      { id: "ex-2", benchmark: "cis-windows-11-enterprise", version: "4.0.0", level: 1, policyName: "Contoso Windows Firewall", settingId: extreme ? LONG_ID : "device_vendor_msft_firewall_mdmstore_publicprofile_disableinboundnotifications", owner: "Grace Hopper", reason: "Accepted risk for the build agents. ".repeat(extreme ? 20 : 3), expiresOn: "2026-12-15", createdAt: "2026-09-02T10:00:00Z" },
    ] : [],
    adjustedPassRate: levelNumber === 1 ? 63 / 84 : 19 / 31,
    assessedAutomated: 72, enumerated: levelNumber === 1 ? 74 : 28, enumeratedIds: [], denominatorIdentifiers: [], automatedIdentifiers: [],
    denominator: levelNumber === 1 ? 96 : 38, coverage: levelNumber === 1 ? 72 / 96 : 26 / 38, coverageSource: "authoritative",
    notAssessed: levelNumber === 1 ? ["18.4.1", "18.4.2", "18.9.7", "18.10.3"] : ["19.5.1"],
    manual: [
      { identifier: `${levelNumber === 1 ? 1 : 2}.1.1`, level: levelNumber, title: "Ensure the account lockout threshold is reviewed", description: "Review the lockout threshold against the password policy.", impact: "Users locked out after repeated failures need a recovery path.", audit: "Check the account policy in the domain or Entra configuration.", remediation: "Set the threshold to 5 or fewer invalid attempts.", hasText: true, fallback: MANUAL_RECOMMENDATIONS_FALLBACK, fallbackUrl: MANUAL_RECOMMENDATIONS_URL, state: "Manual" },
      { identifier: `${levelNumber === 1 ? 1 : 2}.1.2`, level: levelNumber, hasText: false, fallback: MANUAL_RECOMMENDATIONS_FALLBACK, fallbackUrl: MANUAL_RECOMMENDATIONS_URL, state: "Manual" },
    ],
    recommendations,
    recommendationPassRate: 0.6, recommendationsExcepted: 1, adjustedRecommendationPassRate: 0.7,
  }
}

/** A CIS readiness summary with two Levels, exceptions, recommendation results and manual items. */
export function cisSummary(options: { extreme?: boolean } = {}): CisReadinessSummary {
  return {
    benchmark: "cis-windows-11-enterprise", benchmarkName: "CIS Microsoft Windows 11 Enterprise Benchmark", version: "4.0.0",
    levels: [level(1, options.extreme === true), level(2, options.extreme === true)],
    manualNote: MANUAL_NOT_ASSESSED_NOTE, manualFallback: MANUAL_RECOMMENDATIONS_FALLBACK, manualFallbackUrl: MANUAL_RECOMMENDATIONS_URL,
  }
}

export const CIS_CONTEXT = { exportedAt: EXPORTED_AT, tenantName: "Contoso Ltd", tenantId: TENANT_ID, assessedAt: "2026-10-14T08:45:00.000Z", runId: "cis-run-2026-10-14" }

const OIB_ATTRIBUTION = "OpenIntuneBaseline content: SkipToTheEndpoint and contributors, GPL-3.0."
const OIB_PLATFORMS = ["Windows", "macOS", "iOS/iPadOS", "Android"]
const OIB_POLICIES = ["Win - OIB - ES - Defender Antivirus - D - AV Configuration - v3.8", "Win - OIB - SC - Device Security - D - BitLocker (OS Disk) - v3.8", "Win - OIB - SC - Windows Update for Business - D - Update Ring - v3.8", "MacOS - OIB - Compliance - U - Device Health - v1.0", "iOS - OIB - Restrictions - D - Device Restrictions - v2.1", "Android - OIB - Work Profile - D - Password - v1.4"]

/** A fictional Existing Deployment comparison as the renderer builds it; `extreme` adds long names, many rows and odd characters. */
export function oibComparisonReport(options: { extreme?: boolean } = {}) {
  const statuses = ["Update available", "New policy", "Ambiguous match", "Newer than OIB", "Up to date"]
  const count = options.extreme ? 120 : 14
  const rows = Array.from({ length: count }, (_, index) => {
    const name = OIB_POLICIES[index % OIB_POLICIES.length]!
    const long = options.extreme && index % 7 === 0
    return { status: statuses[index % statuses.length]!, row: [OIB_PLATFORMS[index % OIB_PLATFORMS.length]!, index % 2 ? "Settings Catalog" : "Compliance policy", long ? `${name} ${"Extended naming convention segment ".repeat(4)}` : name,
      index % 5 === 1 ? "" : long ? `${name}\n${name} (${guid(index)})\nLegacyCopy_${"x".repeat(80)}` : `${name.replace(/ - v\d.\d$/, "")} - v3.6`, index % 5 === 0 ? "v3.6 to v3.8" : "v3.8", index % 3 ? "OIBID" : "Name"] }
  })
  return {
    tenantId: TENANT_ID,
    title: "OpenIntuneBaseline deployment comparison",
    eyebrow: "OpenIntuneBaseline comparison",
    subtitle: "OpenIntuneBaseline Windows v3.8, macOS v1.0, iOS/iPadOS v2.1, Android v1.4",
    meta: [["Tenant", options.extreme ? `Contoso Holdings International "Global" Ltd \u2019s ${"Region ".repeat(8)}` : "Contoso Ltd"], ["Compared", "2026-10-14 08:45 UTC"], ["Tenant policies read", "212"], ["Matching", "OIBID in the policy description, then policy name without version. Settings are not compared; see Policy Validation."]] as Array<[string, string]>,
    summary: statuses.map(status => [status, String(rows.filter(row => row.status === status).length)]) as Array<[string, string]>,
    sections: [
      ...statuses.map(status => ({ heading: status, columns: ["Platform", "Type", "OIB policy", "Tenant policy", "Versions", "Match"], rows: rows.filter(row => row.status === status).map(row => row.row) })),
      { heading: "Other copies still deployed", note: "Older versions or extra copies next to the matched policy. They keep applying until removed.", columns: ["OIB policy", "Other copy in the tenant"], rows: [[OIB_POLICIES[0]!, `${OIB_POLICIES[0]!.replace("v3.8", "v3.4")} (${guid(901)})`]] },
      { heading: "Deprecated policies in the tenant", columns: ["Tenant policy", "Replacement"], rows: [] },
    ],
    attribution: OIB_ATTRIBUTION,
  }
}

/** A fictional Policy Validation report as the renderer builds it; `extreme` adds long setting paths and values. */
export function oibValidationReport(options: { extreme?: boolean } = {}) {
  const statuses = ["Matches the baseline", "Drift detected", "Drift detected", "Not validated", "Validation error"]
  const policies = Array.from({ length: options.extreme ? 40 : 8 }, (_, index) => ({ name: OIB_POLICIES[index % OIB_POLICIES.length]!, status: statuses[index % statuses.length]!, platform: OIB_PLATFORMS[index % OIB_PLATFORMS.length]! }))
  const path = (index: number) => options.extreme && index % 3 === 0 ? `device_vendor_msft_policy_config_defender_${"attacksurfacereductionrules_".repeat(4)}${index}` : `device_vendor_msft_policy_config_defender_allowrealtimemonitoring_${index}`
  const deviations = (index: number) => policies[index]!.status === "Validation error"
    ? [["Error", "", "", "The policy could not be read: Graph returned 403 Forbidden for this request. Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"]]
    : Array.from({ length: options.extreme ? 30 : 4 }, (_, row) => [["Value mismatch", "Missing in tenant", "Only in tenant"][row % 3]!, `Real-time monitoring ${row + 1} (${path(row)})`, row % 3 === 2 ? "(not set)" : options.extreme && row % 4 === 0 ? `{"rules":[${"\"block\",".repeat(30)}"audit"]}` : "Enabled", row % 3 === 1 ? "(not set)" : "Disabled"])
  return {
    tenantId: TENANT_ID,
    title: "OpenIntuneBaseline policy validation",
    eyebrow: "OpenIntuneBaseline validation",
    subtitle: "OpenIntuneBaseline Windows v3.8",
    meta: [["Tenant", "Contoso Ltd"], ["Validated", "2026-10-14 09:02 UTC"], ["Policies", String(policies.length)], ["Scope", "Setting-level comparison of matched policies. Read-only: nothing was changed in the tenant."]] as Array<[string, string]>,
    summary: [["Match the baseline", "Matches the baseline"], ["Drift detected", "Drift detected"], ["Not validated", "Not validated"], ["Errors", "Validation error"]].map(([label, status]) => [label, String(policies.filter(policy => policy.status === status).length)]) as Array<[string, string]>,
    sections: [
      { heading: "Summary", columns: ["Platform", "OIB policy", "Tenant policy", "Status", "Settings matched"], rows: policies.map(policy => [policy.platform, policy.name, `${policy.name} (Contoso)`, policy.status, policy.status === "Matches the baseline" ? "42 of 42" : policy.status === "Drift detected" ? "38 of 42" : ""]) },
      ...policies.map((policy, index) => ({ policy, index })).filter(({ policy }) => policy.status === "Drift detected" || policy.status === "Validation error").map(({ policy, index }) => ({ heading: policy.name, note: `Tenant policy: ${policy.name} (Contoso)`, columns: ["Deviation", "Setting", "OIB value", "Tenant value"], rows: deviations(index) })),
    ],
    attribution: OIB_ATTRIBUTION,
  }
}

/** A solid PNG of the given size with a darker band, built without an image library, as a data URL. */
export function pngLogo(width = 240, height = 80, color: [number, number, number] = [11, 61, 92]): string {
  const crc = (data: Buffer) => { const value = Buffer.alloc(4); value.writeUInt32BE(crc32(data)); return value }
  const chunk = (type: string, data: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, "latin1"), data]); return Buffer.concat([length, body, crc(body)]) }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 4 + 1) + 1 + x * 4
      const mark = x < height
      const inside = mark ? (x - height / 2) ** 2 + (y - height / 2) ** 2 < (height / 2.4) ** 2 : y > height * 0.3 && y < height * 0.7 && (x - height) % 22 < 16
      raw[offset] = mark ? 43 : color[0]; raw[offset + 1] = mark ? 179 : color[1]; raw[offset + 2] = mark ? 163 : color[2]; raw[offset + 3] = inside ? 255 : 0
    }
  }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
  return `data:image/png;base64,${png.toString("base64")}`
}
