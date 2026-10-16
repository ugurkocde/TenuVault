import { randomUUID } from 'node:crypto'
import type { KeyValueStore } from '../storage/secure-store'
import { frameworks, type Framework } from '../../shared/frameworks/catalog'
import { record, type RecordJson } from '../../shared/frameworks/policies'
import { createEvidenceManifest, frameworkRulesetSha256 } from '../../shared/compliance/manifest'
import { FRAMEWORK_SOURCE_COMMIT, type NativeAssessment } from '../../shared/compliance/native'
import type { AssessmentScope } from '../../shared/compliance/types'
import { collectNativeEvidence, graphEvidenceReader, type CollectionProgress } from './collector'
import { FrameworkError, tokenFor } from './service'
import rights from '../../shared/compliance/rights.json'
import { COMPLIANCE_DETECTOR_VERSION } from '../../shared/compliance/detector-version'
import { COMPLIANCE_RULESET_VERSION, complianceFrameworks } from '../../shared/compliance/engine'
import essentialEightRequirements from '../../shared/compliance/frameworks/essential-eight-requirements.json'
import { nativeExportCSV, nativeExportJSON, tenantLabel } from '../../shared/compliance/export'
import { allows, CIS_FRAMEWORKS, upgradeMessage, type Plan } from '../../shared/plans'
import { pdfBrandingFor } from '../pdf-branding'

const memory = new Map<string, string>()
const unreadable = new Set<string>()
let store: KeyValueStore = { get: key => memory.get(key) ?? null, set: (key, value) => { memory.set(key, value) }, delete: key => { memory.delete(key) } }
// Resolves when the tenant may be used. When it returns the tenant's plan, CIS reports are
// also checked against it here, behind the API host's plan guard.
let authorize: (tenant: string) => Promise<Plan | void> = async () => { throw new FrameworkError('Tenant authorization is unavailable.', 403) }
let persistent = false
let notify: (job: NativeJobSummary) => void = () => {}
export function setNativeFrameworkStore(value: KeyValueStore): void { store = value; persistent = true }
export function setNativeFrameworkAuthorization(value: typeof authorize): void { authorize = value }

/**
 * Authorizes a framework request for a signed-in, licensed tenant. Reports of licensed CIS
 * content additionally need Pro or MSP; the API host's plan guard enforces that for every
 * request, and this repeats it whenever the authorizer reports the plan.
 */
export async function authorizeFrameworkTenant(tenant: string, cisReport = false): Promise<void> {
  const plan = await authorize(tenant)
  if (cisReport && plan && !allows(plan, 'baselineAllPlatforms')) throw new FrameworkError(upgradeMessage('baselineAllPlatforms'), 402)
}

/** The response for a framework export: a local file the renderer saves where the admin chooses. */
export function exportResponse(data: string | Uint8Array<ArrayBuffer>, type: string, filename: string): Response {
  return new Response(data, { headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '-')}"`, 'Cache-Control': 'no-store' } })
}
/** Called once when a background comparison finishes, fails or is cancelled. */
export function setNativeFrameworkNotifier(value: typeof notify): void { notify = value }

export type NativeJobStep = 'connecting' | 'collecting' | 'evaluating' | 'saving'
export interface NativeJobSummary {
  jobId: string
  tenantId: string
  frameworkId: string
  frameworkName: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  step: NativeJobStep
  /** Human readable description of the current step. */
  detail: string
  /** 0 to 100. */
  percent: number
  startedAt: string
  finishedAt?: string
  runId?: string
  error?: string
}
interface NativeJob extends NativeJobSummary { controller: AbortController }

/**
 * Comparisons run in the main process, independent of the page that started them, so
 * the admin can keep working in the app. Finished jobs stay listed for a while so the
 * renderer can pick up the result after navigating back.
 */
const jobs = new Map<string, NativeJob>()
const FINISHED_JOB_TTL = 30 * 60_000

function summary({ controller: _controller, ...job }: NativeJob): NativeJobSummary { return { ...job } }
function pruneJobs(now = Date.now()): void {
  for (const [id, job] of jobs) if (job.finishedAt && now - Date.parse(job.finishedAt) > FINISHED_JOB_TTL) jobs.delete(id)
}
export function listNativeJobs(): NativeJobSummary[] {
  pruneJobs()
  return [...jobs.values()].map(summary)
}

function collectionPercent(progress: CollectionProgress): number {
  const within = progress.policyCount ? progress.policiesRead / progress.policyCount : 0
  return Math.round(5 + ((progress.familyIndex + within) / progress.familyCount) * 85)
}
function collectionDetail(progress: CollectionProgress): string {
  const family = `Reading ${progress.label.toLowerCase()} (${progress.familyIndex + 1} of ${progress.familyCount})`
  return progress.policyCount ? `${family}: ${progress.policiesRead} of ${progress.policyCount} policies` : family
}
function key(tenant: string, framework: string) { return `framework.native.v1.${tenant.toLowerCase()}.${framework}` }

export function validateAssessmentScope(value: unknown): AssessmentScope {
  if (value === undefined) return { platforms: ['windows', 'macos', 'ios', 'android', 'tenant'], essentialEightMaturityLevel: 1, defStanRiskLevel: 1 }
  if (!record(value) || !Array.isArray(value.platforms) || !value.platforms.length || value.platforms.some(p => !['windows', 'macos', 'ios', 'android', 'tenant'].includes(String(p))) ||
    ![1, 2, 3].includes(Number(value.essentialEightMaturityLevel)) || ![0, 1, 2, 3].includes(Number(value.defStanRiskLevel)) ||
    typeof value.essentialEightMaturityLevel !== 'number' || typeof value.defStanRiskLevel !== 'number') throw new FrameworkError('Choose valid platforms, maturity level and risk level.')
  return { platforms: [...new Set(value.platforms)] as AssessmentScope['platforms'], essentialEightMaturityLevel: value.essentialEightMaturityLevel as 1 | 2 | 3, defStanRiskLevel: value.defStanRiskLevel as 0 | 1 | 2 | 3 }
}

export function loadNativeHistory(tenant: string, framework: string): NativeAssessment[] {
  const raw = store.get(key(tenant, framework))
  if (!raw) return []
  let value: unknown
  try { value = JSON.parse(raw) } catch { value = null }
  if (!Array.isArray(value) || value.length > 20 || value.some(run => !record(run) || run.schemaVersion !== 1 || run.tenantId !== tenant.toLowerCase() || run.frameworkId !== framework || !record(run.assessment) || !Array.isArray(run.assessment.capabilities) || !Array.isArray(run.assessment.frameworks))) {
    // Unreadable history would otherwise block every comparison of this framework. It is
    // set aside, not deleted, so it can still be recovered from the store.
    store.set(`${key(tenant, framework)}.unreadable.${Date.now()}`, raw)
    store.delete(key(tenant, framework))
    unreadable.add(key(tenant, framework))
    return []
  }
  return value as NativeAssessment[]
}

async function runAssessment(job: NativeJob, framework: Framework, body: RecordJson, scope: AssessmentScope): Promise<NativeAssessment> {
  const { signal } = job.controller
  try {
    const { token } = await tokenFor(body)
    signal.throwIfAborted()
    Object.assign(job, { step: 'collecting', detail: 'Reading Intune policies', percent: 5 })
    const data = await collectNativeEvidence(graphEvidenceReader(token, signal), scope.platforms?.includes('tenant'), {
      signal, onProgress: progress => Object.assign(job, { detail: collectionDetail(progress), percent: collectionPercent(progress) }),
    })
    signal.throwIfAborted()
    Object.assign(job, { step: 'evaluating', detail: 'Comparing settings with the framework mapping', percent: 92 })
    data.assessmentScope = scope
    const manifest = await createEvidenceManifest(data, scope, framework.nativeId)
    const selected = manifest.assessment.frameworks.find(f => f.framework.id === framework.nativeId)
    if (!selected) throw new FrameworkError('Native framework definition unavailable.', 500)
    signal.throwIfAborted()
    Object.assign(job, { step: 'saving', detail: 'Saving the result on this device', percent: 97 })
    const ids = new Set(selected.controls.flatMap(c => [...c.capabilityIds, ...c.excludedCapabilityIds]))
    const run: NativeAssessment = {
      schemaVersion: 1, runId: randomUUID(), tenantId: job.tenantId, frameworkId: job.frameworkId,
      sourceCommit: FRAMEWORK_SOURCE_COMMIT, snapshotSha256: manifest.snapshotSha256, rulesetSha256: manifest.rulesetSha256,
      licenseNotice: framework.licenseNotice ?? '',
      assessment: { ...manifest.assessment, frameworks: [selected], capabilities: manifest.assessment.capabilities.filter(c => ids.has(c.capability.id)) },
    }
    const history = [run, ...loadNativeHistory(job.tenantId, job.frameworkId)].slice(0, 20)
    // Keep the new result: when the history outgrows the store limit, the oldest runs go first.
    let json = JSON.stringify(history)
    while (json.length > 24_000_000 && history.length > 1) { history.pop(); json = JSON.stringify(history) }
    if (json.length > 24_000_000) throw new FrameworkError('This comparison is too large to save. Narrow the platforms in scope and compare again.', 413)
    store.set(key(job.tenantId, job.frameworkId), json)
    Object.assign(job, { status: 'completed', detail: 'Comparison complete', percent: 100, runId: run.runId, finishedAt: new Date().toISOString() })
    return run
  } catch (error) {
    const cancelled = signal.aborted
    Object.assign(job, {
      status: cancelled ? 'cancelled' : 'failed', finishedAt: new Date().toISOString(),
      detail: cancelled ? 'Comparison cancelled' : 'Comparison failed',
      error: cancelled ? undefined : error instanceof Error ? error.message : 'Comparison failed.',
    })
    throw cancelled ? new FrameworkError('The comparison was cancelled.', 409) : error
  } finally {
    notify(summary(job))
  }
}

export async function handleNativeFramework(body: RecordJson): Promise<Response> {
  if (body.action === 'native-jobs') return Response.json({ jobs: listNativeJobs() })
  const framework = frameworks.find(f => f.id === body.frameworkId)
  if (!framework || framework.disabledReason || !framework.nativeId) throw new FrameworkError(framework?.disabledReason ?? 'This framework has no native provider.', 403)
  if (body.action === 'native-info') return Response.json({ rights: { ...rights.providers.find(p => p.id === framework.nativeId), strategies: framework.nativeId === 'essential-eight' ? [...new Set(essentialEightRequirements.requirements.map(r => r.strategy))] : [] }, rulesetVersion: COMPLIANCE_RULESET_VERSION })
  if (typeof body.tenantId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.tenantId)) throw new FrameworkError('Select a signed-in tenant.')
  const tenant = body.tenantId.toLowerCase()
  // Historical reports stay offline, but still require the local tenant entitlement.
  const exporting = body.action === 'native-pdf' || body.action === 'native-csv' || body.action === 'native-json'
  await authorizeFrameworkTenant(tenant, exporting && CIS_FRAMEWORKS.has(framework.id))
  if (body.action === 'native-assess' || body.action === 'native-start') {
    const scope = validateAssessmentScope(body.scope)
    const running = [...jobs.values()].find(job => job.status === 'running' && !job.controller.signal.aborted && job.tenantId === tenant && job.frameworkId === framework.id)
    if (running) {
      if (body.action === 'native-start') return Response.json({ job: summary(running) })
      throw new FrameworkError('A comparison for this framework is already running.', 409)
    }
    const job: NativeJob = {
      jobId: randomUUID(), tenantId: tenant, frameworkId: framework.id, frameworkName: framework.name, status: 'running',
      step: 'connecting', detail: 'Connecting to Microsoft Graph', percent: 2, startedAt: new Date().toISOString(), controller: new AbortController(),
    }
    pruneJobs()
    jobs.set(job.jobId, job)
    const work = runAssessment(job, framework, body, scope)
    if (body.action === 'native-start') {
      void work.catch(() => {})
      return Response.json({ job: summary(job) })
    }
    return Response.json({ run: await work, persistent })
  }
  if (body.action === 'native-cancel') {
    const job = jobs.get(String(body.jobId))
    if (!job || job.tenantId !== tenant || job.frameworkId !== framework.id) throw new FrameworkError('Comparison not found.', 404)
    // Reported as cancelled at once; in-flight reads stop and nothing is saved.
    if (job.status === 'running') { job.controller.abort(); Object.assign(job, { status: 'cancelled', detail: 'Comparison cancelled', finishedAt: new Date().toISOString() }) }
    return Response.json({ job: summary(job) })
  }
  const history = loadNativeHistory(tenant, framework.id)
  if (body.action === 'native-history') {
    const recovered = unreadable.delete(key(tenant, framework.id))
    const scoringChanged = history.some(run => (run.assessment.provenance?.detectorVersion ?? 1) < COMPLIANCE_DETECTOR_VERSION)
    const currentRulesets = await Promise.all(history.map(async run => {
      const definition = complianceFrameworks(run.assessment.scope).find(item => item.id === framework.nativeId)!
      return { runId: run.runId, sha256: await frameworkRulesetSha256(definition) }
    }))
    const currentRunIds = history.filter(run => run.assessment.provenance?.detectorVersion === COMPLIANCE_DETECTOR_VERSION && currentRulesets.some(item => item.runId === run.runId && item.sha256 === run.rulesetSha256)).map(run => run.runId)
    return Response.json({ history, persistent, currentRunIds, scoringChanged: scoringChanged || currentRunIds.length < history.length, ...(recovered && { notice: 'Saved comparisons for this framework could not be read and were set aside. New comparisons are saved normally.' }) })
  }
  const run = history.find(item => item.runId === body.runId)
  if (!run) throw new FrameworkError('Saved comparison not found.', 404)
  if (body.action === 'native-delete') {
    store.set(key(tenant, framework.id), JSON.stringify(history.filter(item => item.runId !== run.runId)))
    return Response.json({ success: true })
  }
  // Exports use the saved run only; nothing is collected from the tenant again.
  const context = { exportedAt: new Date().toISOString(), tenantName: tenantLabel(body.tenantName) }
  const name = `${framework.id}-${run.runId}`
  if (body.action === 'native-pdf') {
    const { generateNativeFrameworkPDF } = await import('../../shared/compliance/report-pdf')
    return exportResponse(generateNativeFrameworkPDF(run, context, await pdfBrandingFor(tenant)), 'application/pdf', `${name}.pdf`)
  }
  if (body.action === 'native-csv') return exportResponse(`\uFEFF${nativeExportCSV(run, context)}`, 'text/csv; charset=utf-8', `${name}.csv`)
  if (body.action === 'native-json') return exportResponse(nativeExportJSON(run, context), 'application/json', `${name}.json`)
  throw new FrameworkError('Unknown native framework action.')
}
