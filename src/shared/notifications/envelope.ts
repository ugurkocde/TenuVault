/**
 * The one notification event model shared by the desktop app and the Azure watcher
 * runbook. Producers build envelopes; channels only render them. The PowerShell watcher
 * implements the same builders and the same canonical JSON, proven by shared fixtures.
 *
 * Payload allowlist: an envelope carries names, counts, statuses, timestamps and, when
 * the admin opted in, actor UPNs. It never carries policy content, audit request bodies,
 * audit property values, tokens or credentials.
 */

export const NOTIFICATION_SCHEMA = "tenuvault.notification/v1"

export type NotificationSeverity = "info" | "warning" | "critical"

/** Severity rank for rule matching: a rule fires at or above its minimum. */
export const SEVERITY_RANK: Record<NotificationSeverity, number> = { info: 0, warning: 1, critical: 2 }

export const NOTIFICATION_EVENT_TYPES = [
  "backup.failed",
  "backup.warning",
  "backup.succeeded",
  "backup.missed",
  "restore.completed",
  "restore.partial",
  "restore.failed",
  "drift.detected",
  "health.finding",
  "intune.change",
  "watcher.stale",
  "test",
] as const

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number]

export interface NotificationItem {
  title: string
  detail?: string
  actor?: string
  at?: string
}

export interface NotificationEnvelope {
  schema: typeof NOTIFICATION_SCHEMA
  eventId: string
  type: NotificationEventType
  severity: NotificationSeverity
  tenant: { id: string; name?: string }
  occurredAt: string
  title: string
  summary: string
  details: Array<{ label: string; value: string }>
  items: NotificationItem[]
  moreCount: number
  source: "desktop" | "azure-watcher"
  test?: boolean
}

const MAX_TITLE = 200
const MAX_SUMMARY = 1000
const MAX_DETAIL_VALUE = 500
const MAX_DETAILS = 20
const MAX_ITEMS = 20
const MAX_ITEM_TEXT = 300

function clean(value: string, max: number): string {
  // Control characters are stripped on purpose: rendered fields come from tenant data.
  // oxlint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
}

export interface EnvelopeInput {
  type: NotificationEventType
  severity: NotificationSeverity
  tenantId: string
  tenantName?: string | null
  occurredAt: string
  naturalKey: string
  title: string
  summary: string
  details?: Array<{ label: string; value: string }>
  items?: NotificationItem[]
  moreCount?: number
  source: "desktop" | "azure-watcher"
  test?: boolean
}

/** Builds one envelope with bounded, cleaned fields and a deterministic id. */
export function buildEnvelope(input: EnvelopeInput): NotificationEnvelope {
  const items = (input.items ?? []).slice(0, MAX_ITEMS).map((item) => ({
    title: clean(item.title, MAX_ITEM_TEXT),
    ...(item.detail ? { detail: clean(item.detail, MAX_ITEM_TEXT) } : {}),
    ...(item.actor ? { actor: clean(item.actor, 200) } : {}),
    ...(item.at ? { at: item.at } : {}),
  }))
  const envelope: NotificationEnvelope = {
    schema: NOTIFICATION_SCHEMA,
    eventId: eventId(input.tenantId, input.type, input.naturalKey),
    type: input.type,
    severity: input.severity,
    tenant: { id: input.tenantId.toLowerCase(), ...(input.tenantName ? { name: clean(input.tenantName, 200) } : {}) },
    occurredAt: input.occurredAt,
    title: clean(input.title, MAX_TITLE),
    summary: clean(input.summary, MAX_SUMMARY),
    details: (input.details ?? []).slice(0, MAX_DETAILS).map((entry) => ({ label: clean(entry.label, 80), value: clean(entry.value, MAX_DETAIL_VALUE) })),
    items,
    moreCount: Math.max(0, Math.floor(input.moreCount ?? 0)),
    source: input.source,
    ...(input.test ? { test: true } : {}),
  }
  return envelope
}

/** The deterministic delivery identity: SHA-256 of tenant, type and natural key. */
export function eventId(tenantId: string, type: string, naturalKey: string): string {
  return sha256Hex(`${tenantId.toLowerCase()}|${type}|${naturalKey}`)
}

/** Canonical JSON: object keys sorted recursively, no whitespace. Same bytes in both runtimes. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export interface BackupEventInput {
  tenantId: string
  tenantName?: string | null
  status: "Success" | "CompletedWithWarnings" | "Failed"
  backupFolder: string
  occurredAt: string
  totalPolicies?: number | null
  failures?: number | null
  failedTypes?: string[]
  trigger?: string | null
  message?: string | null
  source: "desktop" | "azure-watcher"
}

export function backupEvent(input: BackupEventInput): NotificationEnvelope {
  const type: NotificationEventType = input.status === "Failed" ? "backup.failed" : input.status === "CompletedWithWarnings" ? "backup.warning" : "backup.succeeded"
  const details: Array<{ label: string; value: string }> = [
    { label: "Backup", value: input.backupFolder },
    { label: "Result", value: input.status },
  ]
  if (input.totalPolicies !== null && input.totalPolicies !== undefined) details.push({ label: "Policies saved", value: String(input.totalPolicies) })
  if (input.failures) details.push({ label: "Item failures", value: String(input.failures) })
  if (input.failedTypes?.length) details.push({ label: "Failed types", value: input.failedTypes.slice(0, 10).join(", ") })
  if (input.trigger) details.push({ label: "Trigger", value: input.trigger })
  const tenantLabel = input.tenantName ?? "your tenant"
  return buildEnvelope({
    type,
    severity: type === "backup.failed" ? "critical" : type === "backup.warning" ? "warning" : "info",
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    occurredAt: input.occurredAt,
    naturalKey: input.backupFolder,
    title: type === "backup.failed" ? `Backup failed: ${tenantLabel}` : type === "backup.warning" ? `Backup completed with warnings: ${tenantLabel}` : `Backup succeeded: ${tenantLabel}`,
    summary: input.message || (type === "backup.succeeded" ? "The backup completed successfully." : "Open TenuVault to see what could not be saved."),
    details,
    source: input.source,
  })
}

export function missedBackupEvent(input: { tenantId: string; tenantName?: string | null; occurredAt: string; lastBackupAt: string | null; thresholdHours: number; source: "desktop" | "azure-watcher" }): NotificationEnvelope {
  const tenantLabel = input.tenantName ?? "your tenant"
  return buildEnvelope({
    type: "backup.missed",
    severity: "critical",
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    occurredAt: input.occurredAt,
    naturalKey: `missed:${input.lastBackupAt ?? "none"}:${input.thresholdHours}`,
    title: `No recent backup: ${tenantLabel}`,
    summary: input.lastBackupAt ? `The newest backup is from ${input.lastBackupAt}, older than the ${input.thresholdHours} hour threshold.` : `No backup was found within the ${input.thresholdHours} hour threshold.`,
    details: [
      { label: "Newest backup", value: input.lastBackupAt ?? "none found" },
      { label: "Threshold (hours)", value: String(input.thresholdHours) },
    ],
    source: input.source,
  })
}

export interface DriftEventInput {
  tenantId: string
  tenantName?: string | null
  occurredAt: string
  jobId: string
  added: number
  modified: number
  deleted: number
  items?: NotificationItem[]
  source: "desktop" | "azure-watcher"
}

export function driftEvent(input: DriftEventInput): NotificationEnvelope {
  const total = input.added + input.modified + input.deleted
  const tenantLabel = input.tenantName ?? "your tenant"
  return buildEnvelope({
    type: "drift.detected",
    severity: input.deleted > 0 ? "warning" : "info",
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    occurredAt: input.occurredAt,
    naturalKey: input.jobId,
    title: `Drift detected: ${tenantLabel}`,
    summary: `${total} ${total === 1 ? "change" : "changes"} between the compared backups (${input.added} added, ${input.modified} modified, ${input.deleted} deleted).`,
    details: [
      { label: "Added", value: String(input.added) },
      { label: "Modified", value: String(input.modified) },
      { label: "Deleted", value: String(input.deleted) },
    ],
    items: input.items,
    moreCount: Math.max(0, total - (input.items?.length ?? 0)),
    source: input.source,
  })
}

export interface RestoreEventInput {
  tenantId: string
  tenantName?: string | null
  status: "Completed" | "PartiallyCompleted" | "Failed"
  jobId: string
  occurredAt: string
  restored?: number | null
  failed?: number | null
  partial?: number | null
  message?: string | null
  source: "desktop" | "azure-watcher"
}

export function restoreEvent(input: RestoreEventInput): NotificationEnvelope {
  const type: NotificationEventType = input.status === "Failed" ? "restore.failed" : input.status === "PartiallyCompleted" ? "restore.partial" : "restore.completed"
  const tenantLabel = input.tenantName ?? "your tenant"
  const details: Array<{ label: string; value: string }> = [{ label: "Result", value: input.status }]
  if (input.restored !== null && input.restored !== undefined) details.push({ label: "Restored", value: String(input.restored) })
  if (input.partial) details.push({ label: "Partial", value: String(input.partial) })
  if (input.failed) details.push({ label: "Failed", value: String(input.failed) })
  return buildEnvelope({
    type,
    severity: type === "restore.failed" ? "critical" : type === "restore.partial" ? "warning" : "info",
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    occurredAt: input.occurredAt,
    naturalKey: input.jobId,
    title: type === "restore.failed" ? `Restore failed: ${tenantLabel}` : type === "restore.partial" ? `Restore partially completed: ${tenantLabel}` : `Restore completed: ${tenantLabel}`,
    summary: input.message || "Open TenuVault for the restore details.",
    details,
    source: input.source,
  })
}

export function testEvent(input: { tenantId: string; tenantName?: string | null; occurredAt: string; channelTitle: string; source: "desktop" | "azure-watcher" }): NotificationEnvelope {
  return buildEnvelope({
    type: "test",
    severity: "info",
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    occurredAt: input.occurredAt,
    naturalKey: `test:${input.occurredAt}:${input.channelTitle}`,
    title: "TenuVault test notification",
    summary: `This is a test of the "${input.channelTitle}" notification channel. No backup or policy needs attention.`,
    details: [{ label: "Channel", value: input.channelTitle }],
    source: input.source,
    test: true,
  })
}

/**
 * SHA-256 in pure TypeScript so the shared module stays free of platform imports.
 * Input is encoded as UTF-8. Verified against published test vectors in the test suite.
 */
export function sha256Hex(input: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const bytes = new TextEncoder().encode(input)
  const bitLength = bytes.length * 8
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6)
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 4, bitLength >>> 0)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32))
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  const W = new Uint32Array(64)
  for (let block = 0; block < paddedLength; block += 64) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(block + t * 4)
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15]!, 7) ^ rotr(W[t - 15]!, 18) ^ (W[t - 15]! >>> 3)
      const s1 = rotr(W[t - 2]!, 17) ^ rotr(W[t - 2]!, 19) ^ (W[t - 2]! >>> 10)
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H as [number, number, number, number, number, number, number, number]
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[t]! + W[t]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    H[0] = (H[0]! + a) >>> 0; H[1] = (H[1]! + b) >>> 0; H[2] = (H[2]! + c) >>> 0; H[3] = (H[3]! + d) >>> 0
    H[4] = (H[4]! + e) >>> 0; H[5] = (H[5]! + f) >>> 0; H[6] = (H[6]! + g) >>> 0; H[7] = (H[7]! + h) >>> 0
  }
  return H.map((word) => word.toString(16).padStart(8, "0")).join("")
}
