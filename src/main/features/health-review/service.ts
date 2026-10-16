import { allows, type Feature } from "../../../shared/plans"
import { baselineSignals } from "../baseline-upgrades/service"
import type { SignalProvider, WorkSignal } from "../contracts"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import { signals as hygieneSignals } from "../hygiene"
import type { Stored } from "../records"
import { cisSignals } from "../../frameworks/cis-signals"
import { signals as scoreSignals } from "../scores"
import { standardSignals } from "../standards/service"
import {
  buildPayload,
  checkBackups,
  checkSignals,
  clampInterval,
  DEFAULT_INTERVAL_HOURS,
  isDue,
  localNotificationText,
  MAX_DELIVERY_ATTEMPTS,
  missedWindows,
  nextDueAfter,
  pendingNotifications,
  pruneSent,
  reconcileFindings,
  retryable,
  RETRY_DELAYS_MS,
  type BackupListing,
  type CheckResult,
  type HealthFinding,
  type NotificationPayload,
  type Severity,
  type UnreadableSignals,
} from "./rules"

/** Stored health review records (domain health-reviews): one schedule and the review runs. */
export interface ScheduleRecord {
  kind: "schedule"
  title: string
  status: "enabled" | "disabled"
  summary: string
  enabled: boolean
  intervalHours: number
  lastReviewAt: string | null
  lastAttemptAt: string | null
  /** completed, partial, could-not-authenticate, not-licensed or failed. */
  lastOutcome: string | null
  nextDueAt: string | null
}

export interface RunRecord {
  kind: "run"
  title: string
  /** completed, partial or could-not-authenticate. */
  status: string
  summary: string
  trigger: "manual" | "scheduled" | "catch-up"
  startedAt: string
  finishedAt: string
  missedWindows: number
  checks: Array<{ family: string; evaluated: boolean; detail: string }>
  counts: Record<Severity | "unknown", number>
  openFindingKeys: string[]
  deliveries: Array<{ endpoint: string; ok: boolean; attempts: number; error: string | null }>
}

export type ReviewRecord = ScheduleRecord | RunRecord

export interface DeliveryResult {
  at: string
  ok: boolean
  attempts: number
  status: number | null
  error: string | null
  findings: number
  test: boolean
}

/** A notification endpoint (domain notification-endpoints). The header value never leaves the main process. */
export interface EndpointRecord {
  kind: "local" | "webhook"
  title: string
  status: "enabled" | "disabled"
  summary: string
  enabled: boolean
  url: string | null
  headerName: string | null
  headerValue: string | null
  minSeverity: Severity
  includeTenantName: boolean
  includeIdentifiers: boolean
  /** Finding key to the occurrence already delivered to this endpoint. */
  sent: Record<string, number>
  lastDelivery: DeliveryResult | null
  deliveries: DeliveryResult[]
}

/** Review runs kept per tenant; the oldest runs are dropped first. */
export const MAX_RUNS = 300
const MAX_DELIVERY_LOG = 20
const DELIVERY_TIMEOUT_MS = 10_000

export interface ReviewOptions {
  /** Waits between delivery attempts; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Tenants with a review in progress, per deps, so a manual and a scheduled review never overlap. */
const running = new WeakMap<FeatureDeps, Set<string>>()

export function scheduleOf(deps: FeatureDeps, tenantId: string): Stored<ScheduleRecord> | null {
  return (deps.records.list<ReviewRecord>(DOMAINS.healthReviews, tenantId).find((record) => record.kind === "schedule") as Stored<ScheduleRecord> | undefined) ?? null
}

export function runsOf(deps: FeatureDeps, tenantId: string): Stored<RunRecord>[] {
  // Records are appended in order, so reversing first keeps the newest first among equal times.
  return (deps.records.list<ReviewRecord>(DOMAINS.healthReviews, tenantId).filter((record) => record.kind === "run") as Stored<RunRecord>[])
    .reverse()
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))
}

export function findingsOf(deps: FeatureDeps, tenantId: string): Stored<HealthFinding>[] {
  return deps.records.list<HealthFinding>(DOMAINS.healthFindings, tenantId)
}

export function endpointsOf(deps: FeatureDeps, tenantId: string): Stored<EndpointRecord>[] {
  return deps.records.list<EndpointRecord>(DOMAINS.notificationEndpoints, tenantId)
}

/** Creates or changes the schedule of a tenant. */
export function saveSchedule(deps: FeatureDeps, tenantId: string, change: Partial<Pick<ScheduleRecord, "enabled" | "intervalHours" | "lastReviewAt" | "lastAttemptAt" | "lastOutcome" | "nextDueAt">>, meta: { actor: string | null; reason: string }): Stored<ScheduleRecord> {
  const current = scheduleOf(deps, tenantId)
  const describe = (value: ScheduleRecord): ScheduleRecord => ({
    ...value,
    status: value.enabled ? "enabled" : "disabled",
    summary: value.enabled ? `Reviews every ${value.intervalHours} hours while TenuVault runs and you are signed in.` : "Scheduled reviews are off.",
  })
  if (!current) {
    const intervalHours = clampInterval(change.intervalHours ?? DEFAULT_INTERVAL_HOURS)
    const base: ScheduleRecord = { kind: "schedule", title: "Health review schedule", status: "disabled", summary: "", enabled: false, intervalHours, lastReviewAt: null, lastAttemptAt: null, lastOutcome: null, nextDueAt: null, ...change }
    base.intervalHours = intervalHours
    return deps.records.create<ReviewRecord>(DOMAINS.healthReviews, tenantId, describe(base), meta) as Stored<ScheduleRecord>
  }
  return deps.records.update<ReviewRecord>(DOMAINS.healthReviews, tenantId, current.id, (value) => {
    const next = { ...(value as ScheduleRecord), ...change }
    next.intervalHours = clampInterval(next.intervalHours)
    return describe(next)
  }, meta) as Stored<ScheduleRecord>
}

/** Reads the backup list through the app's own route, mapping sign-in failures to "auth". */
async function listBackups(deps: FeatureDeps, tenantId: string): Promise<BackupListing> {
  if (!deps.actor(tenantId)) return { outcome: "auth", backups: [] }
  try {
    const response = await deps.api("/api/list-backups", tenantId)
    const body = (await response.json().catch(() => null)) as { backups?: unknown; error?: unknown } | null
    if (response.status === 401) return { outcome: "auth", backups: [] }
    if (!response.ok) return { outcome: "unavailable", backups: [], error: brief(typeof body?.error === "string" ? body.error : `storage answered ${response.status}`) }
    if (!body || !Array.isArray(body.backups)) return { outcome: "unavailable", backups: [], error: "the backup list was not readable" }
    return { outcome: "ok", backups: body.backups as BackupListing["backups"] }
  } catch (error) {
    if (error instanceof Error && error.name === "SignInRequiredError") return { outcome: "auth", backups: [] }
    return { outcome: "unavailable", backups: [], error: brief(error instanceof Error ? error.message : String(error)) }
  }
}

function brief(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 200)
}

/** Signal providers of the other workflows, each with the feature that licenses it and the screen that owns its records. */
const SIGNAL_PROVIDERS: Array<{ feature: Feature; provider: SignalProvider; source: UnreadableSignals }> = [
  { feature: "baselineUpgrades", provider: (deps, tenantId) => baselineSignals(deps, tenantId), source: { label: "baseline upgrades", link: "/portal/changes/baseline-upgrades" } },
  { feature: "goldenStandards", provider: (deps, tenantId) => standardSignals(deps, tenantId), source: { label: "standards", link: "/portal/governance/standards" } },
  { feature: "hygieneExplorer", provider: hygieneSignals, source: { label: "conflicts and hygiene", link: "/portal/governance/hygiene" } },
  { feature: "baselineScores", provider: scoreSignals, source: { label: "baseline scores", link: "/portal/governance/scores" } },
  { feature: "baselineScores", provider: (_deps, tenantId) => cisSignals(tenantId), source: { label: "CIS Benchmarks", link: "/portal/frameworks/cis-benchmarks" } },
]

/** The license could not be read, so no provider ran. */
const LICENSE_UNREADABLE: UnreadableSignals = { label: "the license", link: "/license" }

/**
 * Reads the work signals of one tenant from stored records. A provider runs only when
 * the tenant plan includes its feature, and providers only read records, so a review
 * never writes to the tenant for a signal. A provider that fails marks the family as
 * not evaluated; the signals that were read still count.
 */
export async function collectSignals(deps: FeatureDeps, tenantId: string): Promise<{ signals: WorkSignal[]; evaluated: boolean; unreadable: UnreadableSignals[] }> {
  let plan: Awaited<ReturnType<FeatureDeps["plan"]>> | null = null
  try {
    plan = await deps.plan(tenantId)
  } catch {
    plan = null
  }
  if (!plan) return { signals: [], evaluated: false, unreadable: [LICENSE_UNREADABLE] }
  const signals: WorkSignal[] = []
  const seen = new Set<string>()
  const unreadable: UnreadableSignals[] = []
  for (const entry of SIGNAL_PROVIDERS) {
    if (!allows(plan, entry.feature)) continue
    try {
      for (const signal of await entry.provider(deps, tenantId)) {
        if (seen.has(signal.key)) continue
        seen.add(signal.key)
        signals.push(signal)
      }
    } catch {
      unreadable.push(entry.source)
    }
  }
  return { signals, evaluated: unreadable.length === 0, unreadable }
}

export class ReviewInProgress extends Error {
  constructor() {
    super("A health review for this tenant is already running.")
    this.name = "ReviewInProgress"
  }
}

/**
 * Runs one health review for a tenant: reads backups, reconciles stored findings from that fresh evidence, stores the run, moves the
 * schedule forward and then notifies opted-in endpoints. Findings are persisted before any
 * delivery, and delivery results never change a finding.
 */
export async function runReview(deps: FeatureDeps, tenantId: string, trigger: RunRecord["trigger"], actor: string | null, options: ReviewOptions = {}): Promise<{ run: Stored<RunRecord>; findings: Stored<HealthFinding>[] }> {
  const active = running.get(deps) ?? new Set<string>()
  running.set(deps, active)
  const tenant = tenantId.toLowerCase()
  if (active.has(tenant)) throw new ReviewInProgress()
  active.add(tenant)
  try {
    const startedAt = deps.now()
    const schedule = scheduleOf(deps, tenant)
    const missed = schedule ? missedWindows(schedule, startedAt) : 0
    const listing = await listBackups(deps, tenant)
    const collected = await collectSignals(deps, tenant)
    const now = deps.now()
    const results: CheckResult[] = [checkBackups(tenant, listing, now), checkSignals(tenant, collected.signals, collected.evaluated, collected.unreadable)]

    // Without history: the reconciled values become new revisions and must not nest old ones.
    const existing = findingsOf(deps, tenant).map(({ history: _history, ...plain }) => plain)
    deps.records.batch(() => {
      for (const change of reconcileFindings(existing, results, now)) {
        if (change.kind === "create") deps.records.create<HealthFinding>(DOMAINS.healthFindings, tenant, change.value, { actor: null, reason: change.reason })
        else {
          const current = existing.find((finding) => finding.key === change.key)
          if (current) deps.records.update<HealthFinding>(DOMAINS.healthFindings, tenant, current.id, () => change.value, { actor: null, reason: change.reason })
        }
      }
    })
    const findings = findingsOf(deps, tenant)
    const open = findings.filter((finding) => finding.state !== "resolved")
    const counts = countFindings(open)
    const status = listing.outcome === "auth" ? "could-not-authenticate" : results.every((result) => result.evaluated) ? "completed" : "partial"

    const deliveries = await notifyEndpoints(deps, tenant, findings, { reviewedAt: now.toISOString(), status }, options)
    const finishedAt = deps.now().toISOString()
    const summary = status === "could-not-authenticate"
      ? "Could not authenticate: backups were not read. Sign in to this tenant and review again."
      : `${open.length} open or unknown findings${status === "partial" ? "; some evidence could not be read" : ""}.`
    const run = deps.records.create<ReviewRecord>(DOMAINS.healthReviews, tenant, {
      kind: "run",
      title: `Health review ${trigger === "manual" ? "(manual)" : trigger === "catch-up" ? "(catch-up)" : "(scheduled)"}`,
      status,
      summary,
      trigger,
      startedAt: startedAt.toISOString(),
      finishedAt,
      missedWindows: missed,
      checks: results.map((result) => ({ family: result.family, evaluated: result.evaluated, detail: result.detail })),
      counts,
      openFindingKeys: open.map((finding) => finding.key),
      deliveries,
    }, { actor, reason: `Health review ${trigger}` }) as Stored<RunRecord>
    pruneRuns(deps, tenant)

    const interval = schedule?.intervalHours ?? DEFAULT_INTERVAL_HOURS
    // A sign-in problem is retried within the hour instead of waiting a whole interval.
    const nextDueAt = status === "could-not-authenticate" ? nextDueAfter(now, Math.min(interval, 1)) : nextDueAfter(now, interval)
    saveSchedule(deps, tenant, { lastReviewAt: finishedAt, lastAttemptAt: finishedAt, lastOutcome: status, nextDueAt }, { actor, reason: `Review ${status}` })
    return { run, findings }
  } finally {
    active.delete(tenant)
  }
}

export function countFindings(findings: HealthFinding[]): Record<Severity | "unknown", number> {
  const counts: Record<Severity | "unknown", number> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
  for (const finding of findings) {
    if (finding.state === "resolved") continue
    counts[finding.severity]++
    if (finding.state === "unknown") counts.unknown++
  }
  return counts
}

function pruneRuns(deps: FeatureDeps, tenantId: string): void {
  const runs = runsOf(deps, tenantId)
  for (const run of runs.slice(MAX_RUNS)) deps.records.remove(DOMAINS.healthReviews, tenantId, run.id)
}

/**
 * Sends new findings to every enabled endpoint of the tenant. Each finding occurrence is sent
 * once per endpoint; a failed delivery is retried with backoff up to MAX_DELIVERY_ATTEMPTS
 * and then left for the next review, never turned into another notification.
 */
export async function notifyEndpoints(deps: FeatureDeps, tenantId: string, findings: HealthFinding[], review: { reviewedAt: string; status: string }, options: ReviewOptions = {}): Promise<RunRecord["deliveries"]> {
  const results: RunRecord["deliveries"] = []
  for (const endpoint of endpointsOf(deps, tenantId)) {
    if (!endpoint.enabled) continue
    const pending = pendingNotifications(findings, endpoint.sent, endpoint.minSeverity)
    if (!pending.length) continue
    const payload = payloadFor(deps, tenantId, endpoint, pending, findings, review)
    const delivery = await deliver(deps, endpoint, payload, pending, deps.tenant(tenantId)?.name ?? null, options)
    deps.records.update<EndpointRecord>(DOMAINS.notificationEndpoints, tenantId, endpoint.id, (value) => {
      const sent = pruneSent(value.sent, findings)
      if (delivery.ok) for (const finding of pending) sent[finding.key] = finding.occurrence
      return { ...value, sent, lastDelivery: delivery, deliveries: [...value.deliveries, delivery].slice(-MAX_DELIVERY_LOG) }
    }, { actor: null, reason: delivery.ok ? `Sent ${pending.length} findings` : `Delivery failed: ${delivery.error ?? "unknown error"}` })
    results.push({ endpoint: endpoint.title, ok: delivery.ok, attempts: delivery.attempts, error: delivery.error })
  }
  return results
}

export function payloadFor(deps: FeatureDeps, tenantId: string, endpoint: Pick<EndpointRecord, "includeTenantName" | "includeIdentifiers">, listed: HealthFinding[], all: HealthFinding[], review: { reviewedAt: string | null; status: string | null }, test = false): NotificationPayload {
  return buildPayload(
    { findings: listed, counted: all, tenantId, tenantName: deps.tenant(tenantId)?.name ?? null, reviewedAt: review.reviewedAt, reviewStatus: review.status, now: deps.now(), test },
    { includeTenantName: endpoint.includeTenantName, includeIdentifiers: endpoint.includeIdentifiers },
  )
}

/** Delivers one payload: a local system notification, or a POST to the admin's https webhook. */
export async function deliver(deps: FeatureDeps, endpoint: EndpointRecord, payload: NotificationPayload, findings: HealthFinding[], tenantName: string | null, options: ReviewOptions & { attempts?: number } = {}): Promise<DeliveryResult> {
  const at = deps.now().toISOString()
  const base = { at, findings: payload.findings.length, test: payload.test }
  if (endpoint.kind === "local") {
    try {
      const text = payload.test ? { title: "TenuVault health review", body: "Test notification. Local notifications are working." } : localNotificationText(tenantName, findings)
      deps.notify(text.title, text.body)
      return { ...base, ok: true, attempts: 1, status: null, error: null }
    } catch (error) {
      return { ...base, ok: false, attempts: 1, status: null, error: brief(error instanceof Error ? error.message : String(error)) }
    }
  }
  if (!endpoint.url || !endpoint.url.startsWith("https://")) return { ...base, ok: false, attempts: 0, status: null, error: "The endpoint has no valid https URL." }
  const sleep = options.sleep ?? realSleep
  const maxAttempts = Math.min(options.attempts ?? MAX_DELIVERY_ATTEMPTS, MAX_DELIVERY_ATTEMPTS)
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (endpoint.headerName && endpoint.headerValue) headers[endpoint.headerName] = endpoint.headerValue
  let status: number | null = null
  let error: string | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await deps.externalFetch(endpoint.url, { method: "POST", headers, body: JSON.stringify(payload), redirect: "error", signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) })
      status = response.status
      if (response.ok) return { ...base, ok: true, attempts: attempt, status, error: null }
      error = `The endpoint answered HTTP ${response.status}.`
    } catch (caught) {
      status = null
      error = brief(caught instanceof Error ? caught.message : String(caught)) || "The endpoint could not be reached."
    }
    if (!retryable(status) || attempt === maxAttempts) return { ...base, ok: false, attempts: attempt, status, error }
    await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 8_000)
  }
  return { ...base, ok: false, attempts: maxAttempts, status, error }
}

/** Whether the tenant's plan includes the health review; false when unlicensed or unknown. */
async function licensed(deps: FeatureDeps, tenantId: string): Promise<boolean> {
  try {
    return allows(await deps.plan(tenantId), "healthReview")
  } catch {
    return false
  }
}

const ticking = new WeakSet<FeatureDeps>()

/**
 * One scheduler pass: runs every due review, one tenant after another. After a long gap
 * (the app was closed or the computer asleep) a due tenant gets one catch-up review, not
 * one per missed window. A tenant whose plan no longer includes the review is skipped and
 * retried within the hour; its stored findings stay readable.
 */
export async function tick(deps: FeatureDeps, options: ReviewOptions = {}): Promise<void> {
  if (ticking.has(deps)) return
  ticking.add(deps)
  try {
    for (const tenantId of deps.tenants()) {
      const schedule = scheduleOf(deps, tenantId)
      const now = deps.now()
      if (!schedule || !isDue(schedule, now)) continue
      if (!(await licensed(deps, tenantId))) {
        saveSchedule(deps, tenantId, { lastAttemptAt: now.toISOString(), lastOutcome: "not-licensed", nextDueAt: nextDueAfter(now, Math.min(schedule.intervalHours, 1)) }, { actor: null, reason: "Skipped: the plan does not include the health review" })
        continue
      }
      try {
        await runReview(deps, tenantId, missedWindows(schedule, now) > 0 ? "catch-up" : "scheduled", null, options)
      } catch (error) {
        if (error instanceof ReviewInProgress) continue
        saveSchedule(deps, tenantId, { lastAttemptAt: now.toISOString(), lastOutcome: "failed", nextDueAt: nextDueAfter(now, Math.min(schedule.intervalHours, 1)) }, { actor: null, reason: `Review failed: ${brief(error instanceof Error ? error.message : String(error))}` })
      }
    }
  } finally {
    ticking.delete(deps)
  }
}

