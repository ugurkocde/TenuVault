import { adminCenterLink, adminCenterListLink, inTenant } from "../../../shared/intune/admin-links"
import type { ChangeSet } from "../shared/change-set"
import type { SyncBackup, SyncPreview, SyncStatusEntry, SyncTarget } from "./api"

/**
 * The Sync screens' rules as pure functions: the status chip of a source policy, what the review
 * shows per policy and whether a target can be approved, the state of each target in the result
 * flowchart (always read from its stored change set), and the geometry of the flowchart links.
 */

export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export type Tone = "neutral" | "success" | "warning" | "danger" | "coral"

/** Stable key of a source policy, as the engine keys its links. */
export const policyKey = (folder: string, sourceId: string) => `${folder}:${sourceId.toLowerCase()}`

/** Two letters for a tenant's round badge. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)
  return letters.toUpperCase()
}

/**
 * The status chip of one source policy from /api/sync status, over every target it is linked
 * in. Not linked anywhere: not synced yet. Otherwise the state that needs attention first. A
 * target whose status could not be read (`unread`) leaves the policy's state there unknown.
 */
export function policyStatus(links: Array<{ tenantName: string; entry: SyncStatusEntry }>, unread: Array<{ tenantName: string; error: string }> = []): { label: string; tone: Tone; title?: string } {
  if (!links.length && !unread.length) return { label: "Not synced yet", tone: "neutral" }
  const title = [...links.map(({ tenantName, entry }) => `${tenantName}: ${STATE_WORDS[entry.state]}${entry.error ? `. ${entry.error}` : ""}`), ...unread.map(({ tenantName, error }) => `${tenantName}: ${error}`)].join("\n")
  if (links.some(({ entry }) => entry.state === "missing-in-target")) return { label: "Missing in target", tone: "warning", title }
  if (links.some(({ entry }) => entry.state === "changed")) return { label: "Changed since last sync", tone: "warning", title }
  if (unread.length || links.some(({ entry }) => entry.state !== "in-sync")) return { label: "Unknown", tone: "neutral", title }
  return { label: links.length === 1 ? `In sync with ${links[0]!.tenantName}` : `In sync with ${links.length} tenants`, tone: "success", title }
}

const STATE_WORDS: Record<SyncStatusEntry["state"], string> = {
  "in-sync": "in sync",
  changed: "changed since the last sync",
  "missing-in-target": "the synced policy is missing",
  "missing-in-source": "the source policy is missing",
  unknown: "unknown",
}

// ---------------------------------------------------------------------------------------------
// Review

export interface ReviewRow {
  key: string
  name: string
  kind: "create" | "update" | "same" | "skip" | "blocked"
  notes: Array<{ tone: "danger" | "warning" | "neutral"; message: string }>
}

export const ROW_LABEL: Record<ReviewRow["kind"], { label: string; tone: Tone }> = {
  create: { label: "Create", tone: "coral" },
  update: { label: "Update", tone: "warning" },
  same: { label: "No change", tone: "neutral" },
  skip: { label: "Skip: already in sync", tone: "success" },
  blocked: { label: "Blocked", tone: "danger" },
}

/**
 * Per selected policy of one target: create, update, no change (an update whose live difference
 * is empty), blocked, or skipped because the plan found it already in sync, with every finding
 * of the plan and every blocker and warning of the live preview under it.
 */
export function reviewRows(target: SyncTarget, preview: SyncPreview | null): ReviewRow[] {
  const skipped: ReviewRow[] = (target.skipped ?? []).map((item) => ({ key: policyKey(item.folder, item.sourceId), name: item.sourceName, kind: "skip", notes: [] }))
  const promotion = target.promotion
  if (!promotion) return skipped
  return [...promotion.items.map((item): ReviewRow => {
    const operation = target.changeSet?.operations.find((entry) => entry.folder === item.folder && entry.source?.objectId?.toLowerCase() === item.sourceId.toLowerCase())
    const live = operation ? preview?.changeSet.operations.find((entry) => entry.key === operation.key) : undefined
    const kind: ReviewRow["kind"] = item.blocked ? "blocked" : item.action === "create" ? "create" : live && !live.diff.length && !live.diffTruncated ? "same" : "update"
    const notes: ReviewRow["notes"] = [
      ...item.findings.map((finding) => ({ tone: finding.severity === "blocking" ? "danger" as const : finding.severity === "warning" ? "warning" as const : "neutral" as const, message: finding.message })),
      ...(live?.blockers ?? []).map((message) => ({ tone: "danger" as const, message })),
      ...(live?.warnings ?? []).map((message) => ({ tone: "warning" as const, message })),
    ]
    return { key: policyKey(item.folder, item.sourceId), name: item.sourceName, kind, notes }
  }), ...skipped]
}

/** Every selected policy of the target is in sync there, so its plan has nothing to write. */
export const allInSync = (target: SyncTarget) => !target.error && !target.promotion && !!target.skipped?.length

/** Whether any selected policy of the run holds secrets the admin has to acknowledge. */
export function needsSecretAck(targets: SyncTarget[]): boolean {
  return targets.some((target) => target.promotion?.items.some((item) => item.findings.some((finding) => finding.code === "secret-values")))
}

export interface ReviewState { preview: SyncPreview | null; error: string | null }

/**
 * Whether a target can be approved with the chosen backup, or why it is left out. A target
 * without backup storage cannot back up, so with "back up now" it is left out, as an OIB
 * deployment to a further tenant without storage is.
 */
export function readiness(target: SyncTarget, review: ReviewState | undefined, backup: SyncBackup, hasStorage: boolean): { state: "ready" | "checking" | "excluded" | "in-sync"; reason: string | null } {
  if (target.error) return { state: "excluded", reason: target.error }
  if (allInSync(target)) return { state: "in-sync", reason: null }
  if (!target.promotion) return { state: "excluded", reason: "This tenant could not be planned." }
  if (target.promotion.status === "blocked" || !target.changeSet) return { state: "excluded", reason: "Blocked by the findings below. Nothing is written to this tenant." }
  if (!review) return { state: "checking", reason: null }
  if (review.error) return { state: "excluded", reason: review.error }
  if (!review.preview) return { state: "checking", reason: null }
  if (review.preview.changeSet.blockers.length) return { state: "excluded", reason: review.preview.changeSet.blockers.join(" ") }
  if (backup === "new" && !hasStorage) return { state: "excluded", reason: "This tenant has no backup storage, so no backup can be taken. It is left out unless you choose Skip the backup." }
  return { state: "ready", reason: null }
}

// ---------------------------------------------------------------------------------------------
// Result

export type TargetPhase = "excluded" | "waiting" | "writing" | "verified" | "partial" | "failed" | "in-sync"

const verifiedCount = (changeSet: ChangeSet) => changeSet.operations.filter((operation) => changeSet.results[operation.key]?.status === "verified").length

/**
 * The flowchart state of one target, from its stored change set. `active` is true while this
 * screen's approve or apply request for it is running; `error` is the message of a request of
 * this screen that failed.
 */
export function targetPhase(target: SyncTarget, active: boolean, error: string | null): TargetPhase {
  const changeSet = target.changeSet
  if (active) return "writing"
  if (allInSync(target)) return "in-sync"
  if (!changeSet) return error ? "failed" : "excluded"
  switch (changeSet.status) {
    case "applying": return "writing"
    case "applied": return "verified"
    case "partial":
    case "uncertain": return "partial"
    case "failed": return verifiedCount(changeSet) ? "partial" : "failed"
    // Approved but not applied: an apply was refused before it started, or never sent.
    case "approved": return "failed"
    default: return error ? "failed" : "excluded"
  }
}

/** Verified and planned operations of a target, for its progress bar. */
export function progress(target: SyncTarget): { done: number; total: number } {
  const changeSet = target.changeSet
  return changeSet ? { done: verifiedCount(changeSet), total: changeSet.operations.length } : { done: 0, total: 0 }
}

/**
 * The backup choice a target is bound to: the one it was approved with, else (for targets
 * approved before that was stored) the one its change set's first claimed apply stored, else what
 * its pre-change capture shows, else "new" once an apply was claimed, or null before approval.
 */
export function backupOf(target: SyncTarget): SyncBackup | null {
  if (target.promotion?.sync?.backup) return target.promotion.sync.backup
  const changeSet = target.changeSet
  if (!changeSet) return null
  if (changeSet.backupChoice) return changeSet.backupChoice
  if (changeSet.preChange) return changeSet.preChange.backupFolder === null ? "none" : "new"
  return changeSet.attempts > 0 ? "new" : null
}

/** Operations that failed or whose outcome is unconfirmed, with the engine's message. */
export function failedItems(changeSet: ChangeSet | null): Array<{ name: string; message: string }> {
  if (!changeSet) return []
  return changeSet.operations.flatMap((operation) => {
    const result = changeSet.results[operation.key]
    if (result?.status !== "failed" && result?.status !== "uncertain") return []
    return [{ name: operation.name, message: result.message ?? (result.status === "uncertain" ? "The outcome could not be confirmed." : "The write failed.") }]
  })
}

/** Why a target that was not synced was left out, from its stored records alone. */
export function excludedReason(target: SyncTarget): string {
  if (target.error) return target.error
  if (!target.promotion || target.promotion.status === "blocked" || !target.changeSet) return "Blocked by findings in the review."
  if (target.changeSet.status === "stale") return "The review is out of date. Start a new sync."
  if (target.changeSet.status === "rejected") return "Rejected in the review."
  return "Reviewed but not approved."
}

/**
 * Where "Open Intune" goes for a target: the policy's own page when the sync wrote one policy
 * and the page needs nothing TenuVault does not know, otherwise the list of its policy type.
 * Opened in the target tenant. `platforms` are the source policies' platforms by source ID,
 * which the Settings Catalog page needs; without them that type opens its list.
 */
export function intuneLink(target: SyncTarget, platforms: Record<string, string | null> = {}): { url: string; exact: boolean } | null {
  const changeSet = target.changeSet
  if (!changeSet?.operations.length) return null
  const written = changeSet.operations.flatMap((operation) => {
    const id = changeSet.results[operation.key]?.status === "verified" ? changeSet.results[operation.key]!.objectId ?? operation.targetId : null
    return id ? [{ operation, id }] : []
  })
  const only = written.length === 1 ? written[0]! : null
  const platform = only?.operation.source?.objectId ? platforms[only.operation.source.objectId.toLowerCase()] : undefined
  const exact = only && (only.operation.folder !== "ConfigurationPolicies" || platform) ? adminCenterLink(only.operation.folder, only.id, { displayName: only.operation.name, ...(platform ? { platforms: platform } : {}) }) : undefined
  const link = exact ?? adminCenterListLink((only?.operation ?? changeSet.operations[0]!).folder)
  return link ? { url: inTenant(link.url, target.targetTenantId), exact: link.exact } : null
}

/** A cubic link from (x1, y1) to (x2, y2) that leaves and arrives horizontally, and its midpoint. */
export function linkPath(x1: number, y1: number, x2: number, y2: number): { d: string; mid: { x: number; y: number } } {
  const dx = (x2 - x1) / 2
  // At t = 0.5 this curve passes through the middle of its end points.
  return { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } }
}
