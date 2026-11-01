import { assignmentEvidence, type AssignmentEvidence } from "../../shared/frameworks/evidence"
import { loadWorkspace, saveWorkspace, deleteWorkspace, pruneHistory, recordAssessment, recordCreation, workspaceCapacity, workspaceView, type FrameworkWorkspace } from "./workspaces"
import { HISTORY_FULL_MESSAGE, KEEP_NEWEST_ASSESSMENTS, MAX_WORKSPACE_HISTORY } from "../../shared/frameworks/workspace-history"
import { tenantLabel, workspaceExportCSV, workspaceExportJSON, workspaceHistoryJSON } from "../../shared/compliance/export"
import { createHash, randomUUID } from "node:crypto"
import { frameworks } from "../../shared/frameworks/catalog"
import { comparePolicies, parsePolicies, record, remediationPayload, type Assessment, type BaselinePolicy, type Finding, type LandscapePolicy, type RecordJson } from "../../shared/frameworks/policies"
import { DELEGATED_CLIENT_SECRET } from "../../shared/constants"
import { CIS_FRAMEWORKS } from "../../shared/plans"
import { loadNcsc } from "./ncsc"
import { pdfBrandingFor } from "../pdf-branding"
import { validateRecommendationList } from "../../shared/frameworks/cis-manual"
import { parseDenominatorList, type DenominatorEntry } from "../../shared/frameworks/cis-coverage"
import { readinessFor } from "../../shared/frameworks/cis-readiness"
import { attachRecommendations } from "../../shared/frameworks/cis-recommendations"
import { exceptionKey, isActive, isDateOnly, localDate, MAX_EXCEPTIONS, validateNewException, type CisException } from "../../shared/frameworks/cis-exceptions"
import { tenantWriteLabel, withTenantWrite } from "../features/write-lock"
import { CisContentError, fetchCisCatalog, fetchCisList, fetchCisPack } from "./cis-content"
import { BENCHMARK_ID_PATTERN, MAX_CIS_BENCHMARK_ID_LENGTH, VERSION_PATTERN, type CisLevel } from "../../shared/frameworks/cis-content"
import { retryableStatus, retryDelay, sleep } from "../graph-retry"
import { cisExportFileName, knownBenchmarkName } from "../../shared/frameworks/cis-display"
import { kitLevelForPolicy } from "../../shared/frameworks/cis-flow"
import { MAX_DEFINITIONS } from "../../shared/intune/drift-format"
import { readSettingNames } from "../../portal/lib/drift/setting-names"
import { graphCaller } from "../../portal/lib/policies/graph-restore"

const GRAPH = "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies"
interface Run { assessment: Assessment; policies: BaselinePolicy[]; fingerprint: string; expires: number; consumed: boolean }
const runs = new Map<string, Run>()
const WRITE_LABEL = "Framework policy creation"
export class FrameworkError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

let internalCisOverride: boolean | null = null
let internalCisProvider: (() => boolean) | null = null
/** Test hook for the internal CIS Benchmarks gate. A set override wins over the provider. */
export function setInternalCisBenchmarksEnabled(value: boolean | null): void { internalCisOverride = value }
/**
 * Bootstrap hook wiring the gate to the license service. The provider reports whether a
 * verified entitlement on this machine carries the server-issued internal CIS claim.
 * There is deliberately no environment or settings fallback: without a provider or a
 * test override, CIS Benchmarks stays off in every shipped build.
 */
export function setInternalCisBenchmarksProvider(provider: (() => boolean) | null): void { internalCisProvider = provider }
let cisEntitlementProvider: ((tenantId: string) => string | null) | null = null
/**
 * Bootstrap hook wiring CIS content delivery to the license service. The provider
 * returns the selected tenant's currently valid entitlement token, sent as the
 * bearer credential to the delivery service. Without a provider, delivery fails closed.
 */
export function setCisEntitlementProvider(provider: ((tenantId: string) => string | null) | null): void { cisEntitlementProvider = provider }
let exportSaver: ((file: ExportFile) => Promise<{ saved: boolean; path?: string }>) | null = null
/**
 * Bootstrap hook that saves a framework export through the native Save dialog in the main
 * process. A request with `save: "dialog"` answers with the outcome instead of the file, so a
 * large export is never sent to the renderer and back.
 */
export function setFrameworkExportSaver(saver: ((file: ExportFile) => Promise<{ saved: boolean; path?: string }>) | null): void { exportSaver = saver }
function cisEntitlementToken(tenantId: string): string | null {
  try { return cisEntitlementProvider?.(tenantId) ?? null } catch { return null }
}
export function internalCisBenchmarksEnabled(): boolean {
  if (internalCisOverride !== null) return internalCisOverride
  try {
    return internalCisProvider?.() === true
  } catch {
    return false
  }
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
/** Display names from the last delivered catalog, by benchmark id and version, stamped on packs loaded later. Memory only. */
const cisBenchmarkNames = new Map<string, string>()
const LEGACY_FRAMEWORKS = new Set(["oib"])
const LEGACY_ACTIONS = new Set(["workspace-load", "workspace-pdf", "workspace-csv", "workspace-json"])

/** Comparison-only packs (NCSC) may be assessed and exported, never used to create policies. */
function requireRemediableFramework(frameworkId: unknown): void {
  if (frameworks.some(f => f.id === frameworkId && f.comparisonOnly)) throw new FrameworkError("This pack is available for comparison and reports only. Policies cannot be created from it.", 403)
}

/** Attempts per Graph read: throttling (429) and transient service errors (5xx) are retried. */
const READ_ATTEMPTS = 4
/** The longest single wait and the total wait one read accepts before it fails instead. */
const MAX_READ_RETRY_DELAY_MS = 30_000
const READ_RETRY_BUDGET_MS = 60_000

/**
 * One JSON request. Reads wait out throttling and transient service errors, honoring
 * Retry-After within a bounded wait, and call `beforeRetry` before each repeat so a revoked
 * access stops the read. Writes are never repeated: a failed POST may still have been applied.
 */
async function jsonFetch(url: string, init: RequestInit = {}, beforeRetry?: () => void): Promise<RecordJson> {
  const retries = !init.method || init.method.toUpperCase() === "GET" ? READ_ATTEMPTS - 1 : 0
  const tooLong = (status: number) => new FrameworkError(`Request failed (${status}) at ${new URL(url).pathname}. The service asked to wait longer than an assessment waits. Retry later.`, 502)
  let waited = 0
  let response: Response
  for (let attempt = 0; ; attempt += 1) {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) })
    if (response.ok || !retryableStatus(response.status) || attempt >= retries) break
    let delay: number
    try { delay = retryDelay(response, attempt) } catch { throw tooLong(response.status) }
    if (delay > MAX_READ_RETRY_DELAY_MS || waited + delay > READ_RETRY_BUDGET_MS) throw tooLong(response.status)
    waited += delay
    await response.body?.cancel().catch(() => undefined)
    await sleep(delay)
    beforeRetry?.()
  }
  if (!response.ok) throw new FrameworkError(`Request failed (${response.status}) at ${new URL(url).pathname}. ${response.status === 403 ? "Check Intune permissions for this tenant." : "No complete assessment was produced. Retry after resolving the request error."}`, response.status === 403 ? 403 : 502)
  const json: unknown = await response.json()
  if (!record(json)) throw new FrameworkError("The service returned an unexpected response.", 502)
  return json
}

export async function collectGraph(url: string, token: string, beforeNetwork?: () => void): Promise<RecordJson[]> {
  const result: RecordJson[] = []
  const visited = new Set<string>()
  while (url) {
    const parsed = new URL(url)
    if (parsed.origin !== "https://graph.microsoft.com" || !parsed.pathname.startsWith("/beta/deviceManagement/configurationPolicies") || visited.has(url) || visited.size >= 1000) {
      throw new FrameworkError("Invalid or repeated Graph continuation link. Assessment stopped.", 502)
    }
    visited.add(url)
    beforeNetwork?.()
    const page = await jsonFetch(url, { headers: { Authorization: `Bearer ${token}` } }, beforeNetwork)
    if (!Array.isArray(page.value) || !page.value.every(record)) throw new FrameworkError("Graph returned an incomplete policy collection.", 502)
    result.push(...page.value)
    const next = page["@odata.nextLink"]
    if (next != null && typeof next !== "string") throw new FrameworkError("Invalid Graph continuation link.", 502)
    url = next as string || ""
  }
  return result
}

export interface LandscapeProgress { read: number; total: number; policyName: string }
/** Re-reads of one policy whose settings do not match its reported count before the read fails. */
const SETTINGS_REREADS = 2

async function landscape(token: string, onProgress?: (progress: LandscapeProgress) => void, beforeNetwork?: () => void): Promise<LandscapePolicy[]> {
  // Expanding settings severely reduces Graph's page size. Read the policy list first,
  // then each settings collection with bounded concurrency and its own continuation.
  beforeNetwork?.()
  const policies = await collectGraph(GRAPH, token, beforeNetwork)
  const result: LandscapePolicy[] = []
  let read = 0
  for (let i = 0; i < policies.length; i += 4) {
    beforeNetwork?.()
    const chunk = await Promise.all(policies.slice(i, i + 4).map(async listed => {
      const id = listed.id
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) throw new FrameworkError("Policy ID missing from Graph response.", 502)
      let policy = listed
      let settings = await collectGraph(`${GRAPH}/${id}/settings`, token, beforeNetwork)
      // A policy edited between the list read and its settings read reports a stale count.
      // Re-read that policy and its settings a bounded number of times before failing.
      for (let reread = 0; typeof policy.settingCount === "number" && settings.length !== policy.settingCount; reread += 1) {
        if (reread >= SETTINGS_REREADS) throw new FrameworkError("Policy settings changed during the read. Compare again.", 409)
        beforeNetwork?.()
        policy = await jsonFetch(`${GRAPH}/${id}`, { headers: { Authorization: `Bearer ${token}` } }, beforeNetwork)
        if (policy.id !== id) throw new FrameworkError("Policy ID missing from Graph response.", 502)
        settings = await collectGraph(`${GRAPH}/${id}/settings`, token, beforeNetwork)
      }
      read += 1
      onProgress?.({ read, total: policies.length, policyName: typeof policy.name === "string" ? policy.name : "" })
      if (!settings.length) return null
      let targeting: AssignmentEvidence
      try { targeting = assignmentEvidence(await collectGraph(`${GRAPH}/${id}/assignments`, token, beforeNetwork)) }
      catch { beforeNetwork?.(); targeting = { state: "unavailable", targets: [], limitations: ["Assignment evidence could not be read completely. Check Intune access and compare again."] } }
      return { ...parsePolicies({ ...policy, settings })[0]!, id, targeting }
    }))
    result.push(...chunk.filter((policy) => policy !== null))
  }
  return result
}

/** Refuses a new assessment before the tenant is read when its result could not be saved. */
function requireHistoryRoom(tenantId: string, frameworkId: string): void {
  if (workspaceCapacity(loadWorkspace(tenantId, frameworkId)).full) throw new FrameworkError(HISTORY_FULL_MESSAGE, 409)
}

function fingerprint(policies: LandscapePolicy[]): string {
  return createHash("sha256").update(JSON.stringify(policies.slice().sort((a, b) => a.id.localeCompare(b.id)))).digest("hex")
}

export type AssessPhase = "connecting" | "reading" | "comparing" | "saving" | "done" | "failed"

export interface AssessJobSnapshot {
  jobId: string
  phase: AssessPhase
  status: "queued" | "running" | "done" | "failed"
  state: "queued" | "running" | "done" | "failed"
  tenantId: string
  frameworkId: string
  read: number
  total: number
  currentPolicy: string
  comparedPolicies: number
  packPolicies: number
  currentPackPolicy: string
  findings: Finding[]
  nextSince: number
  error: string | null
  assessment: Assessment | null
}

interface AssessJob {
  id: string
  tenantId: string
  frameworkId: string
  reference: string
  policiesJson: string
  phase: AssessPhase
  read: number
  total: number
  currentPolicy: string
  comparedPolicies: number
  packPolicies: number
  currentPackPolicy: string
  findings: Finding[]
  error: string | null
  assessment: Assessment | null
  expiresAt: number | null
  startedAt: string
  finishedAt: string | null
  /** Wall-clock deadline; a job still running past it is failed instead of blocking its tenant forever. */
  deadlineAt: number
}

/** One assessment job without its findings, for the background activity panel on every page. */
export interface AssessJobSummary {
  jobId: string
  tenantId: string
  frameworkId: string
  reference: string
  phase: AssessPhase
  status: "running" | "done" | "failed"
  read: number
  total: number
  currentPolicy: string
  comparedPolicies: number
  packPolicies: number
  currentPackPolicy: string
  findingsCount: number
  error: string | null
  runId: string | null
  startedAt: string
  finishedAt: string | null
}

const jobs = new Map<string, AssessJob>()
const JOB_TTL_MS = 10 * 60_000
const MAX_JOBS = 10
const COMPARE_PACE_MS = 50
/** Longest a pack assessment may run before it is failed; tests shorten it. */
export const ASSESS_JOB_LIMITS = { maxMs: 30 * 60_000 }
const JOB_DEADLINE_MESSAGE = "The assessment timed out and was stopped. Run it again; if reading the tenant keeps timing out, check the connection and the app registration permissions."

function isFinished(job: AssessJob): boolean {
  return job.phase === "done" || job.phase === "failed"
}

/** Fails a running job that is past its deadline, so a hung read cannot block its tenant and framework until the app restarts. */
function failPastDeadline(job: AssessJob, now: number): void {
  if (isFinished(job) || now <= job.deadlineAt) return
  job.phase = "failed"
  job.error = JOB_DEADLINE_MESSAGE
  job.assessment = null
  job.finishedAt = new Date(now).toISOString()
  job.expiresAt = now + JOB_TTL_MS
}

/** The per-attempt guard of a running job: framework still enabled and deadline not yet passed. */
function requireJobCurrent(job: AssessJob): void {
  requireEnabledFramework(job.frameworkId)
  if (Date.now() > job.deadlineAt) throw new FrameworkError(JOB_DEADLINE_MESSAGE, 504)
}

function pruneJobs(): void {
  const now = Date.now()
  for (const job of jobs.values()) failPastDeadline(job, now)
  for (const [id, job] of jobs) if (job.expiresAt !== null && job.expiresAt <= now) jobs.delete(id)
  while (jobs.size > MAX_JOBS) {
    const oldestFinished = [...jobs].find(([, job]) => isFinished(job))
    if (!oldestFinished) break
    jobs.delete(oldestFinished[0])
  }
}

/** Every running and recently finished assessment job, newest first, without findings payloads. */
export function listAssessJobs(): AssessJobSummary[] {
  pruneJobs()
  return [...jobs.values()]
    .map((job) => ({
      jobId: job.id, tenantId: job.tenantId, frameworkId: job.frameworkId, reference: job.reference,
      phase: job.phase, status: job.phase === "done" ? "done" as const : job.phase === "failed" ? "failed" as const : "running" as const,
      read: job.read, total: job.total, currentPolicy: job.currentPolicy,
      comparedPolicies: job.comparedPolicies, packPolicies: job.packPolicies, currentPackPolicy: job.currentPackPolicy,
      findingsCount: job.findings.length, error: job.error, runId: job.assessment?.runId ?? null,
      startedAt: job.startedAt, finishedAt: job.finishedAt,
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

function jobSnapshot(job: AssessJob, since: number): AssessJobSnapshot {
  const status = job.phase === "done" ? "done" : job.phase === "failed" ? "failed" : "running"
  return {
    jobId: job.id, phase: job.phase, status, state: status,
    tenantId: job.tenantId, frameworkId: job.frameworkId,
    read: job.read, total: job.total, currentPolicy: job.currentPolicy,
    comparedPolicies: job.comparedPolicies, packPolicies: job.packPolicies, currentPackPolicy: job.currentPackPolicy,
    findings: job.findings.slice(since), nextSince: job.findings.length,
    error: job.error, assessment: job.assessment,
  }
}

/**
 * Admissions and completions per tenant and framework. Opening a workspace compares it before and
 * after reading, so a job that starts or finishes during the read is not missed.
 */
const jobGenerations = new Map<string, number>()
const jobGenerationKey = (tenant: string, frameworkId: string) => `${tenant}:${frameworkId}`
const jobGeneration = (tenant: string, frameworkId: string) => jobGenerations.get(jobGenerationKey(tenant, frameworkId)) ?? 0
function nextJobGeneration(tenant: string, frameworkId: string): void {
  jobGenerations.set(jobGenerationKey(tenant, frameworkId), jobGeneration(tenant, frameworkId) + 1)
}

/** The running job of a tenant and framework with the pack it assesses, or null. */
function activeJob(tenant: string, frameworkId: string): { jobId: string; reference: string; policies: BaselinePolicy[] } | null {
  pruneJobs()
  const running = [...jobs.values()].find(job => !isFinished(job) && job.tenantId === tenant && job.frameworkId === frameworkId)
  return running ? { jobId: running.id, reference: running.reference, policies: JSON.parse(running.policiesJson) as BaselinePolicy[] } : null
}

/** Runs an admitted job: it acquires the tenant token itself, so the job is visible while it connects. */
async function runAssessJob(job: AssessJob, connect: () => Promise<{ token: string }>, policies: BaselinePolicy[]): Promise<void> {
  try {
    const { token } = await connect()
    requireJobCurrent(job)
    job.phase = "reading"
    requireJobCurrent(job)
    const current = await landscape(token, progress => {
      job.read = progress.read
      job.total = progress.total
      job.currentPolicy = progress.policyName
    }, () => requireJobCurrent(job))
    requireJobCurrent(job)
    job.phase = "comparing"
    job.packPolicies = policies.length
    const allFindings = comparePolicies(policies, current)
    let offset = 0
    for (let index = 0; index < policies.length; index += 1) {
      requireJobCurrent(job)
      if (index > 0) await new Promise(resolve => setTimeout(resolve, COMPARE_PACE_MS))
      const policy = policies[index]!
      job.currentPackPolicy = policy.name
      const count = policy.settings.length
      job.findings.push(...allFindings.slice(offset, offset + count))
      offset += count
      job.comparedPolicies = index + 1
    }
    requireJobCurrent(job)
    job.phase = "saving"
    const assessment: Assessment = {
      runId: randomUUID(), tenantId: job.tenantId, frameworkId: job.frameworkId, reference: job.reference,
      assessedAt: new Date().toISOString(), policyCount: current.length, findings: allFindings,
      organizationalEvidence: { state: "manual", note: "Organizational controls, policy approval and operational evidence require a separate assessment." },
    }
    recordAssessment(assessment, policies)
    for (const [id, run] of runs) if (run.expires < Date.now()) runs.delete(id)
    if (runs.size >= 30) runs.delete(runs.keys().next().value!)
    runs.set(assessment.runId, { assessment, policies, fingerprint: fingerprint(current), expires: Date.now() + 15 * 60_000, consumed: false })
    job.assessment = assessment
    job.phase = "done"
  } catch (error) {
    job.phase = "failed"
    job.error = error instanceof Error ? error.message : "Assessment failed."
    job.assessment = null
  } finally {
    job.finishedAt = new Date().toISOString()
    job.expiresAt = Date.now() + JOB_TTL_MS
    nextJobGeneration(job.tenantId, job.frameworkId)
    pruneJobs()
  }
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

/**
 * True for a status poll of an assessment job that exists for the tenant and framework the
 * request names. Jobs enter the job store only through assess-start, after the API host's
 * plan guard admitted that tenant, so such a poll needs no new license check and does not
 * wait on a license refresh. Every other request, including new work, is checked as before.
 */
export async function isAdmittedAssessStatus(request: Request): Promise<boolean> {
  if (request.method !== "POST" || new URL(request.url).pathname.replace(/\/$/, "") !== "/api/frameworks") return false
  let body: unknown
  try { body = await request.clone().json() } catch { return false }
  // Listing job summaries exposes no findings and starts no work, so the panel may poll it freely.
  if (record(body) && body.action === "assess-jobs") return true
  if (!record(body) || body.action !== "assess-status" || typeof body.jobId !== "string" || typeof body.tenantId !== "string" || typeof body.frameworkId !== "string") return false
  const job = jobs.get(body.jobId)
  return !!job && job.tenantId === body.tenantId.toLowerCase() && job.frameworkId === body.frameworkId
}

function signedInTenant(body: RecordJson): { tenantId: string; appId: string } {
  const { tenantId, appId } = body
  if (typeof tenantId !== "string" || !/^[a-f0-9-]{36}$/i.test(tenantId) || typeof appId !== "string" || !/^[a-f0-9-]{36}$/i.test(appId)) throw new FrameworkError("Select a signed-in tenant first.")
  return { tenantId, appId }
}

export async function tokenFor(body: RecordJson, forceRefresh = false): Promise<{ tenant: string; token: string }> {
  const { tenantId, appId } = signedInTenant(body)
  const token = await jsonFetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
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
  requireEnabledFramework(workspace.frameworkId)
  const context = { exportedAt: new Date().toISOString(), tenantName: tenantLabel(body.tenantName) }
  const base = `framework-${workspace.frameworkId}`
  // CIS files are named for the benchmark, the tenant and the day, so a saved file says what it holds.
  const cis = workspace.frameworkId === "cis-benchmarks"
  const cisName = (reference: string, benchmarkName: string | null, part: string, extension: string) => cisExportFileName({ reference, benchmarkName, part, tenantName: context.tenantName, date: localDate(), extension })
  if (body.action === "workspace-json" && body.runId === undefined) {
    if (!workspace.history.length) throw new FrameworkError("No saved assessment to export.", 404)
    return { file: { name: cis ? cisName("", null, "saved assessments", "json") : `${base}-history.json`, type: "application/json", encoding: "utf8", data: workspaceHistoryJSON(workspace.history, context) } }
  }
  const saved = workspace.history.find(entry => entry.assessment.runId === body.runId)
  if (!saved) throw new FrameworkError("Saved assessment not found.", 404)
  const name = `${base}-${saved.assessment.runId}`
  const savedName = (part: string, extension: string) => cis ? cisName(saved.assessment.reference, readinessBenchmarkName(saved.policies), part, extension) : `${name}.${extension}`
  if (body.action === "workspace-cis-pdf") {
    if (workspace.frameworkId !== "cis-benchmarks") throw new FrameworkError("CIS readiness reports are available for CIS Benchmarks assessments only.", 400)
    let denominator: DenominatorEntry[] | undefined
    if (body.denominator !== undefined) {
      if (!Array.isArray(body.denominator)) throw new FrameworkError("The denominator list is invalid.")
      try { denominator = parseDenominatorList(JSON.stringify(body.denominator)) }
      catch (error) { throw new FrameworkError(error instanceof Error ? error.message : "The denominator list is invalid.") }
    }
    // The same exclusion rule as every CIS view, so the PDF matches the page for this run.
    const summary = readinessFor(saved, workspace, localDate(), denominator)
    const { generateCisReadinessPDF } = await import("../../shared/compliance/report-pdf")
    const pdf = generateCisReadinessPDF(summary, { exportedAt: context.exportedAt, tenantName: context.tenantName, tenantId: workspace.tenantId, assessedAt: saved.assessment.assessedAt, runId: saved.assessment.runId }, await pdfBrandingFor(workspace.tenantId))
    return { file: { name: savedName("readiness report", "pdf"), type: "application/pdf", encoding: "base64", data: Buffer.from(pdf).toString("base64") } }
  }
  if (body.action === "workspace-csv") return { file: { name: savedName("findings", "csv"), type: "text/csv;charset=utf-8", encoding: "utf8", data: `\uFEFF${workspaceExportCSV(saved, context, cis ? { layout: "table" } : {})}` } }
  if (body.action === "workspace-json") return { file: { name: savedName("findings", "json"), type: "application/json", encoding: "utf8", data: workspaceExportJSON(saved, context) } }
  const { generateWorkspaceAssessmentPDF } = await import("../../shared/compliance/report-pdf")
  return { file: { name: `${name}.pdf`, type: "application/pdf", encoding: "base64", data: Buffer.from(generateWorkspaceAssessmentPDF(saved, context, await pdfBrandingFor(workspace.tenantId))).toString("base64") } }
}

/** The catalog display name stamped on a saved pack, or null. */
function readinessBenchmarkName(policies: BaselinePolicy[]): string | null {
  for (const policy of policies) if (typeof policy.provenance?.benchmarkName === "string" && policy.provenance.benchmarkName) return policy.provenance.benchmarkName
  return null
}

/** Setting definition IDs a CIS view asks names for: Settings Catalog IDs only, at most MAX_DEFINITIONS. */
function settingDefinitionIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new FrameworkError("Provide the setting definition IDs to name.")
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length <= 400 && /^[\w.~\-{}]+$/.test(id)))].slice(0, MAX_DEFINITIONS)
}

/**
 * Validates one new CIS exception against the workspace and appends it, without saving. Refuses an
 * expired date, a full list, a second active exception for one identity and a finding no saved
 * assessment holds, each with the message the admin sees.
 */
function addCisException(workspace: FrameworkWorkspace, body: RecordJson, today: string): CisException {
  let input: ReturnType<typeof validateNewException>
  try { input = validateNewException(body) }
  catch (error) { throw new FrameworkError(error instanceof Error ? error.message : "The exception is invalid.") }
  // Dates are local, like the expiry date input: an exception is active through its expiry date, so today is the earliest.
  if (!isDateOnly(input.expiresOn) || input.expiresOn < today) throw new FrameworkError("Provide an expiry date of today or later.")
  const existing = workspace.exceptions ?? []
  if (existing.length >= MAX_EXCEPTIONS) throw new FrameworkError(`Exceptions must contain at most ${MAX_EXCEPTIONS} entries. Remove an exception before adding another.`)
  const newKey = exceptionKey(input.benchmark, input.version, input.level, input.policyName, input.settingId)
  if (existing.some(exception => isActive(exception, today) && exceptionKey(exception.benchmark, exception.version, exception.level, exception.policyName, exception.settingId) === newKey)) throw new FrameworkError("An active exception already exists for this finding.", 409)
  const matchesFinding = workspace.history.some(entry => entry.assessment.findings.some(finding => {
    const policy = entry.policies[finding.policyIndex]
    if (!policy) return false
    const provenance = policy.provenance ?? {}
    const bench = typeof provenance.benchmark === "string" ? provenance.benchmark : ""
    const ver = typeof provenance.version === "string" ? provenance.version : ""
    const lvl = kitLevelForPolicy(policy)
    return bench === input.benchmark && ver === input.version && lvl === input.level && finding.policyName === input.policyName && finding.settingId === input.settingId
  }))
  if (!matchesFinding) throw new FrameworkError("No saved assessment finding matches this exception. Run an assessment for this benchmark first.")
  const exception: CisException = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
  workspace.exceptions = [...existing, exception]
  return exception
}

/** Most findings excluded in one batch request; the exception limit applies as well. */
const MAX_EXCEPTION_BATCH = 500

export async function handleFramework(body: RecordJson): Promise<unknown> {
  const legacy = typeof body.frameworkId === "string" && LEGACY_FRAMEWORKS.has(body.frameworkId)
  if (legacy && !LEGACY_ACTIONS.has(String(body.action))) throw new FrameworkError("Saved OpenIntuneBaseline pack comparisons are read-only. New comparisons use the Existing Deployment and Policy Validation workflows.", 403)
  if (typeof body.frameworkId === "string") requireEnabledFramework(body.frameworkId)
  if (["assess", "assess-start", "create"].includes(String(body.action)) && frameworks.some(f => f.id === body.frameworkId && f.nativeId)) throw new FrameworkError("Use the native read-only comparison for this framework.", 403)
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
    if (["workspace-delete", "workspace-delete-assessment", "workspace-prune-history"].includes(body.action)) {
      if (tenantWriteLabel(tenantKey) === WRITE_LABEL) throw new FrameworkError("Wait for policy creation to finish before deleting its assessment.", 409)
      for (const [id, run] of runs) if (run.assessment.tenantId === tenantKey && run.assessment.frameworkId === body.frameworkId && (body.action === "workspace-delete" || (body.action === "workspace-delete-assessment" && id === body.runId))) runs.delete(id)
    }
    // Deleting does not read the saved workspace first, so it also resets one that cannot be read.
    if (body.action === "workspace-delete") { deleteWorkspace(body.tenantId, body.frameworkId); return workspaceView(loadWorkspace(body.tenantId, body.frameworkId)) }
    if (body.action === "workspace-open") {
      // The saved workspace and the running assessment as one consistent answer: when a job was
      // admitted or finished while the workspace was read, both are read again.
      const frameworkId = body.frameworkId
      for (let attempt = 0; ; attempt += 1) {
        const before = jobGeneration(tenantKey, frameworkId)
        const workspace = workspaceView(loadWorkspace(body.tenantId, frameworkId))
        const running = activeJob(tenantKey, frameworkId)
        if (jobGeneration(tenantKey, frameworkId) === before || attempt >= 2) return { workspace, activeJob: running }
      }
    }
    const workspace = loadWorkspace(body.tenantId, body.frameworkId)
    if (["workspace-pdf", "workspace-csv", "workspace-json", "workspace-cis-pdf"].includes(body.action)) {
      const exported = await exportWorkspace(body, workspace)
      if (body.save !== "dialog") return exported
      if (!exportSaver) throw new FrameworkError("Saving exports is not available.", 500)
      return { name: exported.file.name, ...(await exportSaver(exported.file)) }
    }
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
    } else if (body.action === "workspace-prune-history") {
      if (typeof body.keep !== "number" || !Number.isInteger(body.keep) || body.keep < KEEP_NEWEST_ASSESSMENTS || body.keep > MAX_WORKSPACE_HISTORY) throw new FrameworkError(`Choose how many saved assessments to keep, from ${KEEP_NEWEST_ASSESSMENTS} to ${MAX_WORKSPACE_HISTORY}.`)
      const removed = new Set(pruneHistory(workspace, body.keep))
      for (const [id, run] of runs) if (run.assessment.tenantId === tenantKey && run.assessment.frameworkId === body.frameworkId && removed.has(id)) runs.delete(id)
    } else if (body.action === "workspace-cis-exception-add") {
      if (body.frameworkId !== "cis-benchmarks") throw new FrameworkError("Exceptions are available for CIS Benchmarks only.")
      addCisException(workspace, body, localDate())
      saveWorkspace(workspace)
    } else if (body.action === "workspace-cis-exception-add-batch") {
      // Every finding is checked on its own and the accepted ones are saved in one write, so a
      // refused finding neither stops the others nor leaves a half saved list.
      if (body.frameworkId !== "cis-benchmarks") throw new FrameworkError("Exceptions are available for CIS Benchmarks only.")
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_EXCEPTION_BATCH) throw new FrameworkError(`Select between 1 and ${MAX_EXCEPTION_BATCH} findings to exclude.`)
      const today = localDate()
      const { owner, reason, expiresOn } = body
      const results = body.items.map(item => {
        try {
          if (!record(item)) throw new FrameworkError("The finding to exclude is invalid.")
          return { ok: true as const, exceptionId: addCisException(workspace, { ...item, owner, reason, expiresOn } as RecordJson, today).id }
        } catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "The finding could not be excluded." } }
      })
      if (results.some(result => result.ok)) saveWorkspace(workspace)
      return { workspace: workspaceView(loadWorkspace(body.tenantId, body.frameworkId)), results }
    } else if (body.action === "workspace-cis-exception-remove") {
      if (body.frameworkId !== "cis-benchmarks") throw new FrameworkError("Exceptions are available for CIS Benchmarks only.")
      const exceptionId = typeof body.exceptionId === "string" ? body.exceptionId : typeof body.id === "string" ? body.id : ""
      if (!exceptionId) throw new FrameworkError("Select an exception to remove.")
      const existing = workspace.exceptions ?? []
      if (!existing.some(exception => exception.id === exceptionId)) throw new FrameworkError("Exception not found.", 404)
      workspace.exceptions = existing.filter(exception => exception.id !== exceptionId)
      saveWorkspace(workspace)
    } else if (body.action !== "workspace-load") throw new FrameworkError("Unknown workspace action.")
    return workspaceView(loadWorkspace(body.tenantId, body.frameworkId))
  }
  if (body.action === "cis-catalog" || body.action === "cis-fetch-pack") {
    if (body.frameworkId !== "cis-benchmarks") throw new FrameworkError("CIS content delivery is available for CIS Benchmarks only.")
    if (typeof body.tenantId !== "string" || !body.tenantId) throw new FrameworkError("Select a tenant and framework.")
    try {
      if (body.action === "cis-catalog") {
        const catalog = await fetchCisCatalog(cisEntitlementToken(body.tenantId))
        requireEnabledFramework(body.frameworkId)
        for (const benchmark of catalog.benchmarks) cisBenchmarkNames.set(`${benchmark.id}@${benchmark.version}`, benchmark.name)
        return catalog
      }
      const benchmark = typeof body.benchmark === "string" ? body.benchmark : ""
      const version = typeof body.version === "string" ? body.version : ""
      const level = body.level === 1 || body.level === 2 ? (body.level as CisLevel) : null
      if (!BENCHMARK_ID_PATTERN.test(benchmark) || benchmark.length > MAX_CIS_BENCHMARK_ID_LENGTH || !VERSION_PATTERN.test(version) || level === null) throw new FrameworkError("Select a benchmark, version and level.")
      // A pack that could not be saved is not fetched: an unreadable workspace fails before any download.
      loadWorkspace(body.tenantId, body.frameworkId)
      const pack = await fetchCisPack({ benchmark, version, level }, cisEntitlementToken(body.tenantId))
      // The list is optional: without one the readiness view shows the CIS notice only, as before.
      const list = await fetchCisList({ benchmark, version, level }, cisEntitlementToken(body.tenantId))
      requireEnabledFramework(body.frameworkId)
      let policies: BaselinePolicy[]
      try { policies = parsePolicies(pack.policies); if (pack.recommendations) policies = attachRecommendations(policies, pack.recommendations) }
      catch (error) { throw new FrameworkError(error instanceof Error ? error.message : "The CIS pack is invalid.") }
      // The validated benchmark, version, Level and catalog display name travel in the provenance, so saved assessments keep them.
      const benchmarkName = cisBenchmarkNames.get(`${pack.benchmark}@${pack.version}`) ?? knownBenchmarkName(pack.benchmark)
      policies = policies.map(policy => ({ ...policy, provenance: { ...policy.provenance, benchmark: pack.benchmark, version: pack.version, level: `Level ${pack.level}`, ...(benchmarkName ? { benchmarkName } : {}) } }))
      const reference = `${pack.benchmark} ${pack.version} Level ${pack.level}`
      const workspace = loadWorkspace(body.tenantId, body.frameworkId)
      workspace.policies = policies
      workspace.reference = reference
      // A list belongs to the pack it came with; a list from an earlier pack or import never stays.
      if (list) workspace.recommendationList = list
      else delete workspace.recommendationList
      saveWorkspace(workspace)
      return { benchmark: pack.benchmark, version: pack.version, level: pack.level, reference, policyCount: policies.length, settingCount: policies.reduce((total, policy) => total + policy.settings.length, 0) }
    } catch (error) {
      if (error instanceof FrameworkError) throw error
      if (error instanceof CisContentError) throw new FrameworkError(error.message, error.status)
      throw new FrameworkError(error instanceof Error ? error.message : "The CIS content delivery service returned an invalid response.", 502)
    }
  }
  if (body.action === "assess-jobs") {
    // Summaries only, like native-jobs: the activity panel polls this from every page.
    return { jobs: listAssessJobs() }
  }
  if (body.action === "assess-status") {
    pruneJobs()
    const job = typeof body.jobId === "string" ? jobs.get(body.jobId) : undefined
    if (!job) throw new FrameworkError("Assessment job not found.", 404)
    if (typeof body.tenantId !== "string" || body.tenantId.toLowerCase() !== job.tenantId || typeof body.frameworkId !== "string" || body.frameworkId !== job.frameworkId) throw new FrameworkError("Assessment job not found.", 404)
    const since = typeof body.since === "number" && Number.isFinite(body.since) && body.since > 0 ? Math.floor(body.since) : 0
    return jobSnapshot(job, since)
  }
  if (body.action === "assess-start") {
    // The job is admitted before any await, so it is visible to workspace-open while it connects.
    const tenant = signedInTenant(body).tenantId.toLowerCase()
    if (typeof body.frameworkId !== "string" || !frameworks.some(f => f.id === body.frameworkId)) throw new FrameworkError("Select a framework.")
    if (typeof body.reference !== "string" || !body.reference.trim() || body.reference.length > 200) throw new FrameworkError("Provide a source version and profile (up to 200 characters).")
    const policies = parsePolicies(body.policies)
    pruneJobs()
    const running = [...jobs.values()].filter(job => !isFinished(job))
    const duplicate = running.find(job => job.tenantId === tenant && job.frameworkId === body.frameworkId)
    if (duplicate) {
      if (duplicate.reference !== body.reference || duplicate.policiesJson !== JSON.stringify(policies)) throw new FrameworkError("An assessment is already running for a different policy pack. Wait for it to finish before starting another.", 409)
      return { jobId: duplicate.id }
    }
    requireHistoryRoom(tenant, body.frameworkId)
    if (running.length >= MAX_JOBS) throw new FrameworkError("Too many assessments are running. Wait for a running assessment to finish before starting another.", 409)
    const job: AssessJob = {
      id: randomUUID(), tenantId: tenant, frameworkId: body.frameworkId, reference: body.reference, policiesJson: JSON.stringify(policies),
      phase: "connecting", read: 0, total: 0, currentPolicy: "",
      comparedPolicies: 0, packPolicies: policies.length, currentPackPolicy: "",
      findings: [], error: null, assessment: null, expiresAt: null,
      startedAt: new Date().toISOString(), finishedAt: null,
      deadlineAt: Date.now() + ASSESS_JOB_LIMITS.maxMs,
    }
    jobs.set(job.id, job)
    nextJobGeneration(tenant, job.frameworkId)
    pruneJobs()
    void runAssessJob(job, () => tokenFor(body), policies)
    return { jobId: job.id }
  }
  const { tenant, token } = await tokenFor(body)
  if (typeof body.frameworkId === "string") requireEnabledFramework(body.frameworkId)
  if (body.action === "cis-setting-names") {
    // Display names of Settings Catalog definitions and their choice options: Microsoft's public
    // catalog read with the tenant token, so CIS findings and deployment diffs read in plain words.
    if (body.frameworkId !== "cis-benchmarks") throw new FrameworkError("Setting names are available for CIS Benchmarks only.")
    const ids = settingDefinitionIds(body.ids)
    return ids.length ? readSettingNames(ids, graphCaller(token, fetch, { beforeAttempt: () => requireEnabledFramework("cis-benchmarks") })) : { settings: {}, options: {} }
  }
  for (const [id, run] of runs) if (run.expires < Date.now()) runs.delete(id)
  if (body.action === "assess") {
    if (typeof body.frameworkId !== "string" || !frameworks.some(f => f.id === body.frameworkId)) throw new FrameworkError("Select a framework.")
    if (typeof body.reference !== "string" || !body.reference.trim() || body.reference.length > 200) throw new FrameworkError("Provide a source version and profile (up to 200 characters).")
    const policies = parsePolicies(body.policies)
    requireHistoryRoom(tenant, body.frameworkId)
    const current = await landscape(token, undefined, () => requireEnabledFramework(body.frameworkId as string))
    requireEnabledFramework(body.frameworkId)
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
    const current = await landscape(token, undefined, () => requireEnabledFramework(run.assessment.frameworkId))
    requireEnabledFramework(run.assessment.frameworkId)
    if (fingerprint(current) !== run.fingerprint) throw new FrameworkError("The tenant policy landscape changed. Compare again before creating policies.", 409)
    run.consumed = true // A network failure may hide a successful write. Never blindly repeat it.
    const results: { name: string; id?: string; error?: string }[] = []
    // A failed workspace save is reported, never allowed to stop the remaining creations or hide created IDs.
    let saveError: string | undefined
    const save = () => {
      try { recordCreation(run.assessment, { success: results.every(r => !r.error), results }); saveError = undefined }
      catch (error) { saveError = error instanceof Error ? error.message : String(error) }
    }
    for (const policyIndex of new Set(selected.map(f => f.policyIndex))) {
      requireEnabledFramework(run.assessment.frameworkId)
      const policy = run.policies[policyIndex]!
      const payload = remediationPayload(policy, selected.filter(f => f.policyIndex === policyIndex).map(f => policy.settings[f.settingIndex]!), run.assessment.reference)
      try {
        const created = await jsonFetch(GRAPH, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        if (typeof created.id !== "string") throw new FrameworkError("No policy ID was returned. Check Intune before retrying.", 502)
        results.push({ name: payload.name, id: created.id })
      } catch (error) {
        results.push({ name: payload.name, error: error instanceof Error ? error.message : "Creation failed; check Intune before retrying." })
      }
      save()
    }
    save()
    return { success: results.every(r => !r.error), results, ...(saveError ? { warning: `The results could not be saved to the workspace, so note the created policy IDs: ${saveError}` } : {}) }
  })
}
