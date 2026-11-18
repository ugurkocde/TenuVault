import { INTUNE_TYPES, type IntuneType, type Item } from "../../shared/intune/registry"
import { graphVersion, readObject, listPath } from "../../shared/intune/read"
import { graphContinuation } from "../../shared/graph-continuation"
import { replacedReferenceReport, type RestoreMapping, type ReplacedReference } from "../../shared/intune/restore-references"
import { safetyReader } from "./safety-reader"

export const REFERENCE_SCAN_BUDGET = { requests: 500, milliseconds: 30_000, bytes: 16 * 1024 * 1024 } as const
// These policy payloads can embed directory IDs in settings or configuration values. Other
// policies need only their targeting and scope fields, never scripts, images or secret sub-reads.
const configuration = new Set(["DeviceConfigurations", "ConfigurationPolicies", "GroupPolicyConfigurations", "ReusablePolicySettings", "CompliancePolicies", "ComplianceSettingsPolicies", "EndpointSecurityIntents", "Apps", "AppConfigurationPolicies", "ManagedAppConfigurations", "AppProtectionIOS", "AppProtectionAndroid", "AppProtectionWindows", "PolicySets", "EnrollmentConfigurations", "ConditionalAccessPolicies"])
const referenceExtras = new Set(["assignments", "definitionValues", "settings", "roleAssignments", "relationships", "scheduledActionsForRule"])
const referenceFields = ["roleScopeTagIds", "assignments", "groupAssignments", "apps", "conditions", "grantControls", "sessionControls", "members", "scopeMembers", "resourceScopes", "approverGroupIds", "roleAssignments", "relationships"]

export interface ReferenceScanOptions { signal?: AbortSignal; requests?: number; milliseconds?: number; bytes?: number }

/** Keep matches from each policy, then release its payload. Incomplete or cancelled scans throw. */
export async function referenceMatches(token: string, mappings: readonly RestoreMapping[], fetchImpl: typeof fetch = fetch, options: ReferenceScanOptions = {}): Promise<ReplacedReference[]> {
  const deadline = AbortSignal.timeout(options.milliseconds ?? REFERENCE_SCAN_BUDGET.milliseconds)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  let requests = 0, bytes = 0
  const check = () => { signal.throwIfAborted() }
  const boundedFetch: typeof fetch = async (input, init) => {
    check()
    if (++requests > (options.requests ?? REFERENCE_SCAN_BUDGET.requests)) throw new Error("Reference scan request budget exceeded")
    const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal
    // Race even an injected transport that fails to honor cancellation. No more requests follow it.
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }) })
    try {
      const response = await Promise.race([fetchImpl(input, { ...init, signal: requestSignal }), cancelled])
      const body = await Promise.race([response.text(), cancelled])
      bytes += Buffer.byteLength(body)
      if (bytes > (options.bytes ?? REFERENCE_SCAN_BUDGET.bytes)) throw new Error("Reference scan size budget exceeded")
      check()
      return new Response(body || null, { status: response.status, headers: response.headers })
    } finally { signal.removeEventListener("abort", abort) }
  }
  const matches: ReplacedReference[] = []
  for (const type of INTUNE_TYPES.filter(type => type.restoreSafety !== "identity" && !type.singleton && !type.staticIds)) {
    check()
    const full = configuration.has(type.folder)
    const expanded = (type.expand ?? "").split(",").filter(property => /^(assignments|apps|items|settings)(?:$|\()/.test(property)).join(",")
    const scanType: IntuneType = { ...type, expand: expanded || undefined, secrets: undefined, extras: type.extras?.filter(extra => referenceExtras.has(extra.property)) }
    const reader = safetyReader(token, boundedFetch, graphVersion(type), type.headers)
    const root = `https://graph.microsoft.com/${graphVersion(type)}/`
    const start = root + listPath(type)
    let next: string | undefined = start
    const seen = new Set<string>()
    while (next) {
      check()
      const page = await reader.get(graphContinuation(start, next, seen, type.filter))
      if (!Array.isArray(page.value)) throw new Error("Reference scan returned an incomplete collection")
      for (const item of page.value) {
        check()
        if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id) throw new Error("Reference scan returned a policy without an ID")
        // Polymorphic configuration needs its detail shape. Assignment-only types select no
        // script or binary content. The backup descriptors supply the supported sub-resources.
        const snapshot = await readObject(full ? scanType : { ...scanType, select: ["id", ...referenceFields.filter(key => key in item && !["assignments", "apps"].includes(key))].join(",") }, item.id, reader)
        const referenceSnapshot = full ? snapshot : Object.fromEntries(referenceFields.filter(key => key in snapshot).map(key => [key, snapshot[key]!]))
        matches.push(...replacedReferenceReport([{ path: `${type.folder}/${item.id}`, snapshot: referenceSnapshot }], mappings))
      }
      if (page["@odata.nextLink"] !== undefined && typeof page["@odata.nextLink"] !== "string") throw new Error("Invalid reference continuation")
      next = page["@odata.nextLink"] as string | undefined
    }
  }
  check()
  return matches
}
