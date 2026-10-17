import { createHash } from "node:crypto"
import { backupHealth, latestComplete, normalizeBackupStatus, type BackupState } from "../../../portal/lib/backup-health"
import type { WorkSignal } from "../contracts"

/**
 * Pure rules of the scheduled health review (#147): thresholds, checks, finding lifecycle,
 * schedule math, notification payloads and webhook validation. No Electron, storage or
 * network imports, so every rule is unit tested directly.
 */

/**
 * Documented thresholds. Backup age uses the same limits as the dashboard's backupHealth
 * (src/portal/lib/backup-health.ts): healthy below 24 hours, warning below 48 hours,
 * critical after that. The review calls backupHealth itself so the two never disagree.
 */
export const THRESHOLDS = {
  backupWarningHours: 24,
  backupCriticalHours: 48,
} as const

export const DEFAULT_INTERVAL_HOURS = 24
export const MIN_INTERVAL_HOURS = 1
export const MAX_INTERVAL_HOURS = 168

/** Delivery attempts per endpoint and review, and the waits between them. */
export const MAX_DELIVERY_ATTEMPTS = 3
export const RETRY_DELAYS_MS = [2_000, 8_000] as const

export type Severity = "critical" | "high" | "medium" | "low"
export type CheckFamily = "backup" | "signals"
export type FindingState = "open" | "unknown" | "resolved"

/** What one check observed: a finding, or an explicit unknown when the evidence is missing. */
export interface ObservedFinding {
  /** Deduplication key, stable across reviews: `<check>:<subject>`. */
  key: string
  family: CheckFamily
  check: string
  severity: Severity
  state: "open" | "unknown"
  title: string
  reason: string
  /** When the review read the evidence; null when it could not be read. */
  observedAt: string | null
  /** The time the evidence itself refers to (backup time, expiry date), when known. */
  evidenceAt: string | null
  link: string
  /** Record references `<domain>:<id>` the finding was derived from. */
  evidence: string[]
}

/** The outcome of one check family. `evaluated` is false when its evidence could not be read. */
export interface CheckResult {
  family: CheckFamily
  evaluated: boolean
  /** Plain sentence describing the result, shown in the review. */
  detail: string
  findings: ObservedFinding[]
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

export interface BackupListing {
  /** "ok" with backups; "auth" when sign-in failed; "unavailable" for any other read failure. */
  outcome: "ok" | "auth" | "unavailable"
  backups: Array<{ status?: unknown; timestamp?: unknown; properties?: { status?: unknown }; result?: unknown }>
  error?: string
}

/** Stale or missing backups, classified with the dashboard's backupHealth thresholds. */
export function checkBackups(tenantId: string, listing: BackupListing, now: Date): CheckResult {
  const link = "/portal/backup"
  const at = now.toISOString()
  if (listing.outcome !== "ok") {
    const auth = listing.outcome === "auth"
    const reason = auth
      ? "Could not authenticate. Sign in to this tenant in TenuVault; the review cannot read backups while you are signed out."
      : `Backups could not be read: ${listing.error ?? "storage is unavailable"}. Backup age is unknown.`
    return {
      family: "backup",
      evaluated: false,
      detail: reason,
      findings: [{ key: `backup-unavailable:${tenantId}`, family: "backup", check: auth ? "backup-auth" : "backup-unavailable", severity: "medium", state: "unknown", title: auth ? "Could not authenticate to read backups" : "Backup status unknown", reason, observedAt: null, evidenceAt: null, link, evidence: [] }],
    }
  }
  const backups = listing.backups.map((backup) => ({
    status: normalizeBackupStatus(backup) as BackupState,
    timestamp: new Date(typeof backup.timestamp === "string" ? backup.timestamp : Number.NaN),
  }))
  const latest = latestComplete(backups)
  const health = backupHealth(backups, now)
  if (health === "healthy" && latest) {
    return { family: "backup", evaluated: true, detail: `Latest complete backup ${hoursAgo(latest.timestamp, now)}.`, findings: [] }
  }
  const failed = backups.some((backup) => ["failed", "partial", "incomplete"].includes(backup.status))
  const reason = latest
    ? latest.timestamp.getTime() > now.getTime()
      ? "The latest complete backup has a timestamp in the future; check the computer clock. Backup age is unknown."
      : `The latest complete backup is ${hoursAgo(latest.timestamp, now)} (healthy below ${THRESHOLDS.backupWarningHours} hours, critical after ${THRESHOLDS.backupCriticalHours} hours).`
    : failed
      ? "No complete backup was found and recent backups failed or stopped early."
      : "No complete backup was found for this tenant."
  const finding: ObservedFinding = {
    key: `backup-stale:${tenantId}`,
    family: "backup",
    check: latest ? "backup-stale" : "backup-missing",
    severity: health === "critical" ? "critical" : latest ? "medium" : "high",
    state: "open",
    title: latest ? (health === "critical" ? "Backups are overdue" : "Backups are getting old") : "No complete backup",
    reason,
    observedAt: at,
    evidenceAt: latest ? latest.timestamp.toISOString() : null,
    link,
    evidence: [],
  }
  return { family: "backup", evaluated: true, detail: reason, findings: [finding] }
}

/**
 * Work signals of the other workflows (pending baseline upgrades and conflicts, standard
 * deviations, open hygiene findings, stale scores) as health findings. The signal keeps its
 * own severity and state; a stale or never collected signal stays unknown, never healthy.
 * `evaluated` is false when a signal provider could not be read: the findings that were
 * read still count, and older signal findings are left as they were.
 */
/** A signal source that could not be read, with the screen that owns its records. */
export interface UnreadableSignals {
  label: string
  link: string
}

export function checkSignals(tenantId: string, signals: WorkSignal[], evaluated: boolean, unreadable: UnreadableSignals[] = []): CheckResult {
  const findings: ObservedFinding[] = signals.map((signal) => ({
    key: signal.key,
    family: "signals",
    check: signal.key.split(":")[0] ?? "work-signal",
    severity: signal.severity,
    state: signal.state,
    title: signal.title,
    reason: signal.reason,
    observedAt: signal.observedAt,
    evidenceAt: signal.observedAt,
    link: signal.link,
    evidence: signal.evidence,
  }))
  if (!evaluated) {
    const from = unreadable.length ? ` Could not read: ${unreadable.map((source) => source.label).join(", ")}.` : ""
    const reason = `Work signals could not be read completely.${from} Pending upgrades, conflicts, deviations and stale scores are unknown.`
    if (!findings.some((finding) => finding.key === `signals-unavailable:${tenantId}`)) {
      // Link to the screen whose records failed to read, not to a fixed screen.
      findings.push({ key: `signals-unavailable:${tenantId}`, family: "signals", check: "signals-unavailable", severity: "medium", state: "unknown", title: "Work signals unknown", reason, observedAt: null, evidenceAt: null, link: unreadable[0]?.link ?? "/portal/operations/health-review", evidence: [] })
    }
    return { family: "signals", evaluated: false, detail: reason, findings }
  }
  return {
    family: "signals",
    evaluated: true,
    detail: findings.length ? `${findings.length} work signal${findings.length === 1 ? "" : "s"} need attention.` : "No pending upgrades, conflicts, deviations, hygiene findings or stale scores.",
    findings,
  }
}

function hoursAgo(time: Date, now: Date): string {
  const hours = Math.max(0, Math.floor((now.getTime() - time.getTime()) / 3_600_000))
  return hours < 48 ? `${hours} hours old` : `${Math.floor(hours / 24)} days old`
}

// ---------------------------------------------------------------------------------------------
// Finding lifecycle
// ---------------------------------------------------------------------------------------------

/** A stored health finding (domain health-findings). `status` mirrors `state` for listings. */
export interface HealthFinding {
  key: string
  family: CheckFamily
  check: string
  severity: Severity
  state: FindingState
  title: string
  status: FindingState
  summary: string
  reason: string
  observedAt: string | null
  evidenceAt: string | null
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
  /** Starts at 1 and grows every time fresh evidence reopens a resolved finding. */
  occurrence: number
  owner: string | null
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  link: string
  evidence: string[]
}

export type FindingChange =
  | { kind: "create"; value: HealthFinding; reason: string }
  | { kind: "update"; key: string; value: HealthFinding; reason: string }

/**
 * Reconciles stored findings with a fresh review. Only evidence decides the state:
 * - a finding observed again stays open (or unknown) and keeps owner and acknowledgement;
 * - a resolved finding observed again reopens with a new occurrence, clearing acknowledgement;
 * - a finding not observed again is resolved, but only when its check family was actually
 *   evaluated. When the evidence could not be read, the finding is left as it was.
 * Notification delivery never changes a finding.
 */
export function reconcileFindings(existing: HealthFinding[], results: CheckResult[], now: Date): FindingChange[] {
  const at = now.toISOString()
  const byKey = new Map(existing.map((finding) => [finding.key, finding]))
  const evaluated = new Set(results.filter((result) => result.evaluated).map((result) => result.family))
  const observed = new Map<string, ObservedFinding>()
  for (const result of results) for (const finding of result.findings) observed.set(finding.key, finding)
  const changes: FindingChange[] = []

  for (const finding of observed.values()) {
    const current = byKey.get(finding.key)
    const fields = { family: finding.family, check: finding.check, severity: finding.severity, state: finding.state, status: finding.state, title: finding.title, summary: finding.reason, reason: finding.reason, observedAt: finding.observedAt, evidenceAt: finding.evidenceAt, lastSeenAt: at, link: finding.link, evidence: finding.evidence }
    if (!current) {
      changes.push({ kind: "create", value: { key: finding.key, ...fields, firstSeenAt: at, resolvedAt: null, occurrence: 1, owner: null, acknowledgedAt: null, acknowledgedBy: null }, reason: "Found by the health review" })
    } else if (current.state === "resolved") {
      changes.push({ kind: "update", key: finding.key, value: { ...current, ...fields, resolvedAt: null, occurrence: current.occurrence + 1, acknowledgedAt: null, acknowledgedBy: null }, reason: "Reopened: fresh evidence shows the problem again" })
    } else {
      changes.push({ kind: "update", key: finding.key, value: { ...current, ...fields }, reason: "Still present in the health review" })
    }
  }
  for (const current of existing) {
    if (current.state === "resolved" || observed.has(current.key) || !evaluated.has(current.family)) continue
    changes.push({ kind: "update", key: current.key, value: { ...current, state: "resolved", status: "resolved", resolvedAt: at }, reason: "Resolved: fresh evidence no longer shows the problem" })
  }
  return changes
}

// ---------------------------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------------------------

export interface ScheduleState {
  enabled: boolean
  intervalHours: number
  lastReviewAt: string | null
  nextDueAt: string | null
}

/** Whether a review is due. A disabled schedule is never due. */
export function isDue(schedule: ScheduleState, now: Date): boolean {
  if (!schedule.enabled) return false
  if (!schedule.nextDueAt) return true
  const due = Date.parse(schedule.nextDueAt)
  return !Number.isFinite(due) || now.getTime() >= due
}

/**
 * Review windows that passed without a review, for example while the computer was off.
 * The scheduler runs one catch-up review for all of them, not one per window.
 */
export function missedWindows(schedule: ScheduleState, now: Date): number {
  if (!schedule.enabled || !schedule.nextDueAt) return 0
  const due = Date.parse(schedule.nextDueAt)
  if (!Number.isFinite(due) || now.getTime() < due) return 0
  return Math.floor((now.getTime() - due) / (clampInterval(schedule.intervalHours) * 3_600_000))
}

/** The next due time after a review attempt at `now`: always in the future, so no burst of reviews follows a long gap. */
export function nextDueAfter(now: Date, intervalHours: number): string {
  return new Date(now.getTime() + clampInterval(intervalHours) * 3_600_000).toISOString()
}

export function clampInterval(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULT_INTERVAL_HOURS
  return Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.round(hours)))
}

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 }

export function atLeast(severity: Severity, minimum: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum]
}

/**
 * Findings an endpoint has not been told about yet. A finding is sent once per occurrence:
 * a duplicate review does not repeat it, and only a resolve followed by a reopen (a new
 * occurrence) sends it again.
 */
export function pendingNotifications(findings: HealthFinding[], sent: Record<string, number>, minimum: Severity): HealthFinding[] {
  return findings.filter((finding) => finding.state !== "resolved" && atLeast(finding.severity, minimum) && sent[finding.key] !== finding.occurrence)
}

/** Keeps the sent map small: forgets findings that no longer exist. */
export function pruneSent(sent: Record<string, number>, findings: HealthFinding[]): Record<string, number> {
  const keys = new Set(findings.map((finding) => finding.key))
  return Object.fromEntries(Object.entries(sent).filter(([key]) => keys.has(key)))
}

export interface PayloadOptions {
  includeTenantName: boolean
  includeIdentifiers: boolean
}

export interface NotificationPayload {
  schema: "tenuvault.health-review.v1"
  test: boolean
  generatedAt: string
  tenant: { name?: string; id?: string }
  review: { reviewedAt: string | null; status: string | null }
  counts: Record<Severity | "unknown", number>
  findings: Array<{ key: string; check: string; severity: Severity; state: "open" | "unknown"; firstSeenAt: string; lastSeenAt: string; evidenceAt: string | null }>
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** Replaces every GUID with a short stable reference, so a receiver can still deduplicate. */
export function redactIdentifiers(value: string): string {
  return value.replace(GUID, (guid) => `ref-${createHash("sha256").update(guid.toLowerCase()).digest("hex").slice(0, 10)}`)
}

/**
 * The exact body an endpoint receives, and what the preview shows. `findings` are listed,
 * `counted` (all open findings, defaulting to `findings`) feed the counts. Allowed metadata only:
 * finding keys and checks, severities, states, counts and timestamps; the tenant display
 * name and raw identifiers only when the admin opted in. Titles, reasons, owners, policy
 * content, tokens and credentials are never part of it.
 */
export function buildPayload(input: { findings: HealthFinding[]; counted?: HealthFinding[]; tenantId: string; tenantName: string | null; reviewedAt: string | null; reviewStatus: string | null; now: Date; test?: boolean }, options: PayloadOptions): NotificationPayload {
  const open = (list: HealthFinding[]) => list.filter((finding): finding is HealthFinding & { state: "open" | "unknown" } => finding.state !== "resolved")
  const findings = open(input.findings)
  const counts: Record<Severity | "unknown", number> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
  for (const finding of open(input.counted ?? input.findings)) {
    counts[finding.severity]++
    if (finding.state === "unknown") counts.unknown++
  }
  const key = (value: string) => (options.includeIdentifiers ? value : redactIdentifiers(value))
  const tenant: NotificationPayload["tenant"] = {}
  if (options.includeTenantName && input.tenantName) tenant.name = input.tenantName.slice(0, 200)
  if (options.includeIdentifiers) tenant.id = input.tenantId
  return {
    schema: "tenuvault.health-review.v1",
    test: input.test ?? false,
    generatedAt: input.now.toISOString(),
    tenant,
    review: { reviewedAt: input.reviewedAt, status: input.reviewStatus },
    counts,
    findings: findings.map((finding) => ({ key: key(finding.key), check: finding.check, severity: finding.severity, state: finding.state, firstSeenAt: finding.firstSeenAt, lastSeenAt: finding.lastSeenAt, evidenceAt: finding.evidenceAt })),
  }
}

/** The short local system notification text; stays on this computer. */
export function localNotificationText(tenantName: string | null, findings: HealthFinding[]): { title: string; body: string } {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const finding of findings) counts[finding.severity]++
  const parts = (Object.entries(counts) as Array<[Severity, number]>).filter(([, count]) => count > 0).map(([severity, count]) => `${count} ${severity}`)
  return {
    title: tenantName ? `Health review: ${tenantName}` : "TenuVault health review",
    body: `${findings.length} ${findings.length === 1 ? "finding needs" : "findings need"} attention (${parts.join(", ")}). Open TenuVault for details.`,
  }
}

const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "connection", "transfer-encoding", "cookie", "origin", "referer", "user-agent", "te", "upgrade", "expect"])

/** Whether a dotted IPv4 address is loopback, private (RFC 1918), CGNAT, link-local (including cloud metadata) or "this network". */
function privateIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** Whether a URL host (as URL.hostname gives it) names this computer or a private network. */
function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost")) return true
  // URL already turned decimal, hex and shortened IPv4 forms into dotted quads.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return privateIpv4(host)
  if (!host.startsWith("[")) return false
  const [head = "", tail = ""] = host.slice(1, -1).split("::")
  const part = (text: string) => (text ? text.split(":").map((group) => parseInt(group, 16)) : [])
  const start = part(head)
  const end = part(tail)
  const groups = [...start, ...Array.from({ length: 8 - start.length - end.length }, () => 0), ...end]
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7]! <= 1) return true
  // IPv4-mapped addresses (::ffff:a.b.c.d) are checked as IPv4.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return privateIpv4(`${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`)
  return (groups[0]! & 0xfe00) === 0xfc00 || (groups[0]! & 0xffc0) === 0xfe80
}

/**
 * Validates an admin-entered webhook URL: https only, no embedded credentials, bounded length,
 * and no localhost names or literal loopback, private, CGNAT or link-local addresses (IPv4 or
 * IPv6). Only the literal host is checked: a public name that resolves to a private address
 * (DNS rebinding) is out of scope.
 */
export function validateWebhookUrl(value: string): { ok: true; url: string } | { ok: false; error: string } {
  if (value.length > 2000) return { ok: false, error: "The webhook URL is too long." }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, error: "Enter a full webhook URL starting with https://." }
  }
  if (url.protocol !== "https:") return { ok: false, error: "Only https webhook URLs are allowed." }
  if (url.username || url.password) return { ok: false, error: "Do not put credentials in the URL. Use the secret header instead." }
  if (!url.hostname) return { ok: false, error: "The webhook URL has no host." }
  if (privateHost(url.hostname)) return { ok: false, error: "The webhook must be a public address, not this computer or a private network." }
  return { ok: true, url: url.toString() }
}

/** Validates an optional secret header for the webhook (name and value). */
export function validateHeader(name: string | null, value: string | null): { ok: true } | { ok: false; error: string } {
  if (!name && !value) return { ok: true }
  if (!name || !value) return { ok: false, error: "Enter both the header name and its value, or neither." }
  if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) return { ok: false, error: "The header name is not allowed." }
  if (value.length > 2000 || /[\r\n\0]/.test(value)) return { ok: false, error: "The header value is invalid." }
  return { ok: true }
}

/** Whether a delivery failure is worth retrying: network errors, timeouts, 429 and 5xx. */
export function retryable(status: number | null): boolean {
  return status === null || status === 408 || status === 429 || status >= 500
}
