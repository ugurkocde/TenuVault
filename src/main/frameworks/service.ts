import { assignmentEvidence, type AssignmentEvidence } from "../../shared/frameworks/evidence"
import { loadWorkspace, saveWorkspace, deleteWorkspace, recordAssessment, recordCreation, type FrameworkWorkspace } from "./workspaces"
import { tenantLabel, workspaceExportCSV, workspaceExportJSON, workspaceHistoryJSON } from "../../shared/compliance/export"
import { createHash, randomUUID } from "node:crypto"
import { frameworks } from "../../shared/frameworks/catalog"
import { comparePolicies, parsePolicies, record, remediationPayload, type Assessment, type BaselinePolicy, type LandscapePolicy, type RecordJson } from "../../shared/frameworks/policies"
import { DELEGATED_CLIENT_SECRET } from "../../shared/constants"
import { CIS_FRAMEWORKS } from "../../shared/plans"
import { loadNcsc } from "./ncsc"
import { validateRecommendationList } from "../../shared/frameworks/cis-manual"
import { parseDenominatorList, type DenominatorEntry } from "../../shared/frameworks/cis-coverage"
import { cisReadiness } from "../../shared/frameworks/cis-readiness"
import { isDateOnly, validateNewException, type CisException } from "../../shared/frameworks/cis-exceptions"
import { tenantWriteLabel, withTenantWrite } from "../features/write-lock"

const GRAPH = "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies"
interface Run { assessment: Assessment; policies: BaselinePolicy[]; fingerprint: string; expires: number; consumed: boolean }
const runs = new Map<string, Run>()
const WRITE_LABEL = "Framework policy creation"
export class FrameworkError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

let internalCisOverride: boolean | null = null
/** Test and bootstrap hook for the internal CIS Benchmarks flag. Null follows the environment. */
export function setInternalCisBenchmarksEnabled(value: boolean | null): void { internalCisOverride = value }
export function internalCisBenchmarksEnabled(): boolean {
  return internalCisOverride ?? process.env.TENUVAULT_INTERNAL_CIS_BENCHMARKS === "1"
}

function requireEnabledFramework(frameworkId: string): void {
  const framework = frameworks.find(f => f.id === frameworkId)
  if (frameworkId === "cis-benchmarks" && internalCisBenchmarksEnabled()) return
  if (framework?.disabledReason) throw new FrameworkError(framework.disabledReason, 403)
}

/**
 * Frameworks that left the catalog but may still have saved workspaces on the device. Their
 * saved assessments stay readable and exportable; nothing else is allowed for them.
 */
const LEGACY_FRAMEWORKS = new Set(["oib"])
const LEGACY_ACTIONS = new Set(["workspace-load", "workspace-pdf", "workspace-csv", "workspace-json"])

/** Comparison-only packs (NCSC) may be assessed and exported, never used to create policies. */
function requireRemediableFramework(frameworkId: unknown): void {
  if (frameworks.some(f => f.id === frameworkId && f.comparisonOnly)) throw new FrameworkError("This pack is available for comparison and reports only. Policies cannot be created from it.", 403)
}

async function jsonFetch(url: string, init: RequestInit = {}): Promise<RecordJson> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new FrameworkError(`Request failed (${response.status}) at ${new URL(url).pathname}. ${response.status === 403 ? "Check Intune permissions for this tenant." : "No complete assessment was produced. Retry after resolving the request error."}`, response.status === 403 ? 403 : 502)
  const json: unknown = await response.json()
  if (!record(json)) throw new FrameworkError("The service returned an unexpected response.", 502)
  return json
}

export async function collectGraph(url: string, token: string): Promise<RecordJson[]> {
  const result: RecordJson[] = []
  const visited = new Set<string>()
  while (url) {
    const parsed = new URL(url)
    if (parsed.origin !== "https://graph.microsoft.com" || !parsed.pathname.startsWith("/beta/deviceManagement/configurationPolicies") || visited.has(url) || visited.size >= 1000) {
      throw new FrameworkError("Invalid or repeated Graph continuation link. Assessment stopped.", 502)
    }
    visited.add(url)
    const page = await jsonFetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!Array.isArray(page.value) || !page.value.every(record)) throw new FrameworkError("Graph returned an incomplete policy collection.", 502)
    result.push(...page.value)
    const next = page["@odata.nextLink"]
    if (next != null && typeof next !== "string") throw new FrameworkError("Invalid Graph continuation link.", 502)
    url = next as string || ""
  }
  return result
}

async function landscape(token: string): Promise<LandscapePolicy[]> {
  // Expanding settings severely reduces Graph's page size. Read the policy list first,
  // then each settings collection with bounded concurrency and its own continuation.
  const policies = await collectGraph(GRAPH, token)
  const result: LandscapePolicy[] = []
  for (let i = 0; i < policies.length; i += 4) {
    const chunk = await Promise.all(policies.slice(i, i + 4).map(async policy => {
      if (typeof policy.id !== "string" || !/^[a-f0-9-]{36}$/i.test(policy.id)) throw new FrameworkError("Policy ID missing from Graph response.", 502)
      const settings = await collectGraph(`${GRAPH}/${policy.id}/settings`, token)
      if (typeof policy.settingCount === "number" && settings.length !== policy.settingCount) throw new FrameworkError("Policy settings changed during the read. Compare again.", 409)
      if (!settings.length) return null
      let targeting: AssignmentEvidence
      try { targeting = assignmentEvidence(await collectGraph(`${GRAPH}/${policy.id}/assignments`, token)) }
      catch { targeting = { state: "unavailable", targets: [], limitations: ["Assignment evidence could not be read completely. Check Intune access and compare again."] } }
      return { ...parsePolicies({ ...policy, settings })[0]!, id: policy.id, targeting }
    }))
    result.push(...chunk.filter((policy) => policy !== null))
  }
  return result
}

function fingerprint(policies: LandscapePolicy[]): string {
  return createHash("sha256").update(JSON.stringify(policies.slice().sort((a, b) => a.id.localeCompare(b.id)))).digest("hex")
}

/**
 * A pack assessment of a policy set: the framework pack (`policies`) compared with the Settings
 * Catalog policies given as `current`. The tenant route passes the live landscape; custom
 * baselines pass their own stored policies, so the same findings logic runs without reading
 * a tenant. Pure apart from the run ID and timestamp, which callers may inject.
 */
export function assessPolicySet(input: { tenantId: string; frameworkId: string; reference: string; policies: BaselinePolicy[]; current: LandscapePolicy[]; runId?: string; assessedAt?: string }): Assessment {
  return { runId: input.runId ?? randomUUID(), tenantId: input.tenantId, frameworkId: input.frameworkId, reference: input.reference,
    assessedAt: input.assessedAt ?? new Date().toISOString(), policyCount: input.current.length, findings: comparePolicies(input.policies, input.current), organizationalEvidence: { state: "manual", note: "Organizational controls, policy approval and operational evidence require a separate assessment." } }
}

export async function tokenFor(body: RecordJson, forceRefresh = false): Promise<{ tenant: string; token: string }> {
  const { tenantId, appId } = body
  if (typeof tenantId !== "string" || !/^[a-f0-9-]{36}$/i.test(tenantId) || typeof appId !== "string" || !/^[a-f0-9-]{36}$/i.test(appId)) throw new FrameworkError("Select a signed-in tenant first.")
  const token = await jsonFetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST", body: new URLSearchParams({ client_id: appId, client_secret: DELEGATED_CLIENT_SECRET,
      grant_type: "client_credentials", force_refresh: String(forceRefresh), scope: "https://graph.microsoft.com/.default" }),
  })
  if (typeof token.access_token !== "string") throw new FrameworkError("Sign in again to access this tenant.", 401)
  return { tenant: tenantId.toLowerCase(), token: token.access_token }
}

/** A framework export file for the renderer to save where the admin chooses; PDF is base64. */
export interface ExportFile { name: string; type: string; encoding: "utf8" | "base64"; data: string }

/**
 * Exports a saved policy pack assessment (runId) or, as JSON, every saved assessment of the
 * workspace. Only recorded results are used; nothing is read from the tenant again.
 */
async function exportWorkspace(body: RecordJson, workspace: FrameworkWorkspace): Promise<{ file: ExportFile }> {
  const { authorizeFrameworkTenant } = await import("./native")
  await authorizeFrameworkTenant(workspace.tenantId, CIS_FRAMEWORKS.has(workspace.frameworkId))
  const context = { exportedAt: new Date().toISOString(), tenantName: tenantLabel(body.tenantName) }
  const base = `framework-${workspace.frameworkId}`
  if (body.action === "workspace-json" && body.runId === undefined) {
    if (!workspace.history.length) throw new FrameworkError("No saved assessment to export.", 404)
    return { file: { name: `${base}-history.json`, type: "application/json", encoding: "utf8", data: workspaceHistoryJSON(workspace.history, context) } }
  }
  const saved = workspace.history.find(entry => entry.assessment.runId === body.runId)
  if (!saved) throw new FrameworkError("Saved assessment not found.", 404)
  const name = `${base}-${saved.assessment.runId}`
  if (body.action === "workspace-cis-pdf") {
    if (workspace.frameworkId !== "cis-benchmarks") throw new FrameworkError("CIS readiness reports are available for CIS Benchmarks assessments only.", 400)
    let denominator: DenominatorEntry[] | undefined
    if (body.denominator !== undefined) {
      if (!Array.isArray(body.denominator)) throw new FrameworkError("The denominator list is invalid.")
      try { denominator = parseDenominatorList(JSON.stringify(body.denominator)) }
      catch (error) { throw new FrameworkError(error instanceof Error ? error.message : "The denominator list is invalid.") }
    }
    const summary = cisReadiness(saved.assessment, saved.policies, denominator, workspace.recommendationList, workspace.exceptions)
    const { generateCisReadinessPDF } = await import("../../shared/compliance/report-pdf")
    const pdf = generateCisReadinessPDF(summary, { exportedAt: context.exportedAt, tenantName: context.tenantName, tenantId: workspace.tenantId, assessedAt: saved.assessment.assessedAt, runId: saved.assessment.runId })
    return { file: { name: `${name}.pdf`, type: "application/pdf", encoding: "base64", data: Buffer.from(pdf).toString("base64") } }
  }
  if (body.action === "workspace-csv") return { file: { name: `${name}.csv`, type: "text/csv;charset=utf-8", encoding: "utf8", data: `\uFEFF${workspaceExportCSV(saved, context)}` } }
  if (body.action === "workspace-json") return { file: { name: `${name}.json`, type: "application/json", encoding: "utf8", data: workspaceExportJSON(saved, context) } }
  const { generateWorkspaceAssessmentPDF } = await import("../../shared/compliance/report-pdf")
  return { file: { name: `${name}.pdf`, type: "application/pdf", encoding: "base64", data: Buffer.from(generateWorkspaceAssessmentPDF(saved, context)).toString("base64") } }
}

export async function handleFramework(body: RecordJson): Promise<unknown> {
  const legacy = typeof body.frameworkId === "string" && LEGACY_FRAMEWORKS.has(body.frameworkId)
  if (legacy && !LEGACY_ACTIONS.has(String(body.action))) throw new FrameworkError("Saved OpenIntuneBaseline pack comparisons are read-only. New comparisons use the Existing Deployment and Policy Validation workflows.", 403)
  if (typeof body.frameworkId === "string") requireEnabledFramework(body.frameworkId)
  if (["assess", "create"].includes(String(body.action)) && frameworks.some(f => f.id === body.frameworkId && f.nativeId)) throw new FrameworkError("Use the native read-only comparison for this framework.", 403)
  // Creation requests normally omit frameworkId. Check the actual assessment,
  // not a renderer-provided ID, before acquiring tokens or making any writes.
  if (body.action === "create") requireRemediableFramework(body.frameworkId)
  if (body.action === "create" && typeof body.runId === "string") {
    const run = runs.get(body.runId)
    if (run) requireEnabledFramework(run.assessment.frameworkId)
    if (run) requireRemediableFramework(run.assessment.frameworkId)
    if (run && frameworks.some(f => f.id === run.assessment.frameworkId && f.nativeId)) throw new FrameworkError("Native framework evidence cannot authorize policy creation.", 403)
  }
  if (body.action === "load-ncsc") {
    // Fixed pinned source; nothing in the request selects what is downloaded.
    try { return await loadNcsc() }
    catch (error) { throw new FrameworkError(error instanceof Error ? error.message : "The NCSC pack could not be loaded.", 502) }
  }
  if (typeof body.action === "string" && body.action.startsWith("workspace-")) {
    if (typeof body.tenantId !== "string" || typeof body.frameworkId !== "string" || (!legacy && !frameworks.some(f => f.id === body.frameworkId))) throw new FrameworkError("Select a tenant and framework.")
    const tenantKey = body.tenantId.toLowerCase()
    if (["workspace-delete", "workspace-delete-assessment"].includes(body.action)) {
      if (tenantWriteLabel(tenantKey) === WRITE_LABEL) throw new FrameworkError("Wait for policy creation to finish before deleting its assessment.", 409)
      for (const [id, run] of runs) if (run.assessment.tenantId === tenantKey && run.assessment.frameworkId === body.frameworkId && (body.action === "workspace-delete" || id === body.runId)) runs.delete(id)
    }
    const workspace = loadWorkspace(body.tenantId, body.frameworkId)
    if (["workspace-pdf", "workspace-csv", "workspace-json", "workspace-cis-pdf"].includes(body.action)) return exportWorkspace(body, workspace)
    if (body.action === "workspace-delete") { deleteWorkspace(body.tenantId, body.frameworkId); return loadWorkspace(body.tenantId, body.frameworkId) }
    if (body.action === "workspace-save") {
      if (typeof body.reference !== "string" || body.reference.length > 200) throw new FrameworkError("Provide a source version up to 200 characters.")
      workspace.policies = Array.isArray(body.policies) && !body.policies.length ? [] : parsePolicies(body.policies)
      workspace.reference = body.reference
      if ("recommendationList" in body) {
        if (body.recommendationList === null) delete workspace.recommendationList
        else {
          try { workspace.recommendationList = validateRecommendationList(body.recommendationList) }
          catch (error) { throw new FrameworkError(error instanceof Error ? error.message : "The recommendation list is invalid.") }
        }
      }
      saveWorkspace(workspace)
    } else if (body.action === "workspace-delete-assessment") {
      workspace.history = workspace.history.filter(entry => entry.assessment.runId !== body.runId)
      saveWorkspace(workspace)
    } else if (body.action === "workspace-cis-exception-add") {
      if (body.frameworkId !== "cis-benchmarks") throw new FrameworkError("Exceptions are available for CIS Benchmarks only.")
      let input: ReturnType<typeof validateNewException>
      try { input = validateNewException(body) }
      catch (error) { throw new FrameworkError(error instanceof Error ? error.message : "The exception is invalid.") }
      const today = new Date().toISOString().slice(0, 10)
      if (!isDateOnly(input.expiresOn) || input.expiresOn <= today) throw new FrameworkError("Provide an expiry date in the future.")
      const exception: CisException = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
      workspace.exceptions = [...(workspace.exceptions ?? []), exception]
      saveWorkspace(workspace)
    } else if (body.action === "workspace-cis-exception-remove") {
      if (body.frameworkId !== "cis-benchmarks") throw new FrameworkError("Exceptions are available for CIS Benchmarks only.")
      const exceptionId = typeof body.exceptionId === "string" ? body.exceptionId : typeof body.id === "string" ? body.id : ""
      if (!exceptionId) throw new FrameworkError("Select an exception to remove.")
      const existing = workspace.exceptions ?? []
      if (!existing.some(exception => exception.id === exceptionId)) throw new FrameworkError("Exception not found.", 404)
      workspace.exceptions = existing.filter(exception => exception.id !== exceptionId)
      saveWorkspace(workspace)
    } else if (body.action !== "workspace-load") throw new FrameworkError("Unknown workspace action.")
    return loadWorkspace(body.tenantId, body.frameworkId)
  }
  const { tenant, token } = await tokenFor(body)
  for (const [id, run] of runs) if (run.expires < Date.now()) runs.delete(id)
  if (body.action === "assess") {
    if (typeof body.frameworkId !== "string" || !frameworks.some(f => f.id === body.frameworkId)) throw new FrameworkError("Select a framework.")
    if (typeof body.reference !== "string" || !body.reference.trim() || body.reference.length > 200) throw new FrameworkError("Provide a source version and profile (up to 200 characters).")
    const policies = parsePolicies(body.policies)
    const current = await landscape(token)
    const assessment = assessPolicySet({ tenantId: tenant, frameworkId: body.frameworkId, reference: body.reference, policies, current })
    recordAssessment(assessment, policies)
    if (runs.size >= 30) runs.delete(runs.keys().next().value!)
    runs.set(assessment.runId, { assessment, policies, fingerprint: fingerprint(current), expires: Date.now() + 15 * 60_000, consumed: false })
    return assessment
  }
  if (body.action !== "create") throw new FrameworkError("Unknown framework action.")
  return withTenantWrite(tenant, WRITE_LABEL, async () => {
    const run = typeof body.runId === "string" ? runs.get(body.runId) : undefined
    if (!run || run.assessment.tenantId !== tenant || run.consumed) throw new FrameworkError("This assessment has expired or was already used. Run comparison again.", 409)
    if (body.confirmUnassigned !== true || !Array.isArray(body.keys) || !body.keys.length || body.keys.some(k => typeof k !== "string")) throw new FrameworkError("Review and confirm the selected unassigned policies.")
    const keys = new Set(body.keys)
    const selected = run.assessment.findings.filter(f => keys.has(f.key))
    if (keys.size !== selected.length || selected.some(f => f.status !== "Missing")) throw new FrameworkError("Only missing settings from this assessment can be created.")
    const definitions = selected.map(f => `${run.policies[f.policyIndex]!.platforms}:${f.settingId}`)
    if (new Set(definitions).size !== definitions.length) throw new FrameworkError("The selection repeats a setting across multiple policies. Select it from one policy only.")
    const current = await landscape(token)
    if (fingerprint(current) !== run.fingerprint) throw new FrameworkError("The tenant policy landscape changed. Compare again before creating policies.", 409)
    run.consumed = true // A network failure may hide a successful write. Never blindly repeat it.
    const results: { name: string; id?: string; error?: string }[] = []
    for (const policyIndex of new Set(selected.map(f => f.policyIndex))) {
      const policy = run.policies[policyIndex]!
      const payload = remediationPayload(policy, selected.filter(f => f.policyIndex === policyIndex).map(f => policy.settings[f.settingIndex]!), run.assessment.reference)
      try {
        const created = await jsonFetch(GRAPH, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        if (typeof created.id !== "string") throw new FrameworkError("No policy ID was returned. Check Intune before retrying.", 502)
        results.push({ name: payload.name, id: created.id })
      } catch (error) {
        results.push({ name: payload.name, error: error instanceof Error ? error.message : "Creation failed; check Intune before retrying." })
      }
      recordCreation(run.assessment, { success: results.every(r => !r.error), results })
    }
    const outcome = { success: results.every(r => !r.error), results }
    recordCreation(run.assessment, outcome)
    return outcome
  })
}
