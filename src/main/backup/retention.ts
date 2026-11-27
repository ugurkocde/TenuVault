import { BACKUP_OWNER_FILE } from "../../shared/constants"
import { parseBackupName } from "../../shared/intune/backup-names"
import { resolveBackupOwnership } from "../../shared/backup-ownership"
import { FetchApplicationError, FetchPreconditionError } from "../api/network-error"
import { isLocalAccount } from "../storage/blob-emulator"
import type { BlobWriter, RetentionBlob } from "./blob-writer"
import { RetentionBudget, RetentionBudgetError, type RetentionLimits } from "./retention-budget"
import { DAY_MS, HOUR_MS, RetentionClockError } from "./retention-clock"
import { readRetentionProgress, type RetentionProgressStore } from "./retention-progress"
import { RetentionVerificationError, checkOwner, verifyBackup } from "./retention-verification"
import { DeleteConditionError, InventoryDamagedError, ProtectedBlobError } from "./request"

const UNREADABLE_ATTEMPTS = 3

function isCandidateUnreadable(error: unknown): boolean {
  if (error instanceof RetentionVerificationError) return true
  return error instanceof FetchApplicationError
    && !(error instanceof RetentionBudgetError)
    && !(error instanceof FetchPreconditionError)
    && !(error instanceof DeleteConditionError)
}

function unreadableWarning(prefix: string, attempts: number, reason?: string): string {
  const detail = reason ? `: ${reason.replace(/\.$/, "")}` : ""
  return `Kept unreadable backup ${prefix} after ${attempts} consecutive failed attempts${detail}. Review it before removing it manually.`
}

interface RetentionRun {
  storage: BlobWriter
  tenant: string
  account: string
  current: string
  written: Record<string, unknown>
  days: number
  now: number
  limits: RetentionLimits
  progress: RetentionProgressStore
  keyFingerprint?: string
  beforeDelete: () => void
  notice: (message: string, level: "info" | "warning") => void
}

/** Build the entire deletion plan before touching storage. Only authenticated candidates enter it. */
export async function applyRetention(run: RetentionRun): Promise<boolean> {
  const { current, written, days, now, limits, keyFingerprint, notice } = run
  const local = isLocalAccount(run.account)
  const tenant = run.tenant.toLowerCase()
  const budget = new RetentionBudget(limits)
  const storage = run.storage.withBudget(budget)
  const { prefixes } = await storage.list("backup-", "/")
  const cutoff = now - days * DAY_MS
  const listed = [...new Set(prefixes)].sort().reverse().flatMap(prefix => {
    if (prefix === `${current}/`) return []
    const time = Date.parse(parseBackupName(prefix.slice(0, -1))?.timestamp ?? "")
    return Number.isFinite(time) ? [{ prefix, time }] : []
  })
  const all = listed.filter(backup => backup.time <= now + HOUR_MS)
  if (all.length !== listed.length) notice("Retention kept future-dated backups and excluded them from the review.", "warning")

  const key = `${tenant}/${run.account}`
  const state = readRetentionProgress(run.progress.get(key))
  const latestPrefix = `${current}/`
  const older = all.filter(backup => backup.prefix < latestPrefix)
  const previous = state.cursor ? older.findIndex(backup => backup.prefix < state.cursor!) : 0
  const start = Math.max(0, previous)
  const candidates = older.slice(start, start + limits.candidates)
  const existing = new Set([latestPrefix, ...older.map(backup => backup.prefix)])
  const save = () => {
    for (const prefix of Object.keys(state.reviews)) if (!existing.has(prefix)) delete state.reviews[prefix]
    if (state.latest && !existing.has(state.latest)) delete state.latest
    if (!state.cursor && !state.latest && !state.latestAttempts && !Object.keys(state.reviews).length) run.progress.delete(key)
    else run.progress.set(key, JSON.stringify(state))
  }
  const advance = (prefix: string | undefined) => {
    state.cursor = prefix && older.some(backup => backup.prefix < prefix) ? prefix : undefined
    save()
  }

  if (!candidates.length || !older.some(backup => backup.time < cutoff)) {
    let warned = all.length !== listed.length
    for (const backup of older) {
      const review = state.reviews[backup.prefix]
      if ((review?.failures ?? 0) >= UNREADABLE_ATTEMPTS) {
        warned = true
        notice(unreadableWarning(backup.prefix, review!.failures!, review!.reason), "warning")
      }
    }
    return warned
  }
  const owner = BACKUP_OWNER_FILE
  const resumedLatest = state.latest && state.latest !== latestPrefix
    ? older.find(backup => backup.prefix === state.latest && backup.time >= cutoff)
    : undefined
  let anchorPrefix = resumedLatest && Object.keys(state.reviews[resumedLatest.prefix]?.files ?? {}).length > 0
    ? resumedLatest.prefix
    : latestPrefix
  if (state.latest && state.latest !== anchorPrefix) {
    delete state.latest
    delete state.latestAttempts
  }
  let latestProgress = state.reviews[anchorPrefix] ??= { files: {}, attempts: 0 }
  let beforeLatestFiles = Object.keys(latestProgress.files).length
  let coverage: Set<string>
  let unreadableAnchor: { prefix: string; error: unknown } | undefined
  try {
    const currentTime = Date.parse(parseBackupName(current)?.timestamp ?? "")
    if (currentTime > now + HOUR_MS) throw new RetentionClockError("the newest backup is future-dated")
    const manifest = await storage.readForRetention(latestPrefix + "metadata.json")
    if (JSON.stringify(manifest.value) !== JSON.stringify(written)) throw new Error("the newest backup's stored manifest differs from what was written")
    const claim = await storage.readForRetention(latestPrefix + owner)
    checkOwner(claim, written, tenant, latestPrefix)
    const verifyAnchor = async () => {
      if (anchorPrefix === latestPrefix) {
        const roots = new Map([["metadata.json", manifest], [owner, claim]])
        return (await verifyBackup(storage, latestPrefix, written, roots, await storage.list(latestPrefix), keyFingerprint, latestProgress)).covers
      }
      const anchorManifest = await storage.readForRetention(anchorPrefix + "metadata.json")
      const anchorMetadata = anchorManifest.value as Record<string, unknown>
      if (typeof anchorMetadata.TenantId !== "string" || anchorMetadata.TenantId.toLowerCase() !== tenant) {
        throw new RetentionVerificationError(`${anchorPrefix}metadata.json does not match the backup's ownership.`)
      }
      const anchorClaim = await storage.readForRetention(anchorPrefix + owner)
      checkOwner(anchorClaim, anchorMetadata, tenant, anchorPrefix)
      const anchorRoots = new Map([["metadata.json", anchorManifest], [owner, anchorClaim]])
      return (await verifyBackup(storage, anchorPrefix, anchorMetadata, anchorRoots, await storage.list(anchorPrefix), keyFingerprint, latestProgress)).covers
    }
    try {
      coverage = await verifyAnchor()
    } catch (error) {
      if (anchorPrefix !== latestPrefix && isCandidateUnreadable(error)) {
        unreadableAnchor = { prefix: anchorPrefix, error }
        delete state.latest
        delete state.latestAttempts
        save()
        anchorPrefix = latestPrefix
        latestProgress = state.reviews[latestPrefix] = { files: {}, attempts: 0 }
        beforeLatestFiles = 0
        coverage = await verifyAnchor()
      } else {
        throw error
      }
    }
    delete state.latestAttempts
    if (Object.keys(latestProgress.files).length > 0) {
      state.latest = anchorPrefix
      save()
    } else {
      if (state.latest === anchorPrefix) delete state.latest
      delete state.reviews[anchorPrefix]
    }
  } catch (error) {
    const madeLatestProgress = Object.keys(latestProgress.files).length > beforeLatestFiles
    if (error instanceof RetentionBudgetError) {
      state.latestAttempts = (state.latestAttempts ?? 0) + 1
      if (Object.keys(latestProgress.files).length > 0) state.latest = anchorPrefix
      else delete state.reviews[anchorPrefix]
      save()
      if (state.latestAttempts >= 3) notice("Retention repeatedly reached its budget while verifying the newest backup. Review storage size and the backup log.", "warning")
    } else if (madeLatestProgress) {
      state.latest = anchorPrefix
      save()
    } else if (!Object.keys(latestProgress.files).length) {
      delete state.reviews[anchorPrefix]
      if (state.latest === anchorPrefix) {
        delete state.latest
        save()
      }
    }
    throw error
  }

  const ownedCoverage = new Set(coverage)
  const untaggedCoverage = new Set<string>()
  const hasCoverage = (types: Set<string>, ownedOnly: boolean) =>
    [...types].every(folder => ownedCoverage.has(folder) || (!ownedOnly && untaggedCoverage.has(folder)))
  const plan: Array<{ prefix: string; identities: Map<string, string>; untagged: boolean; coveredByOwned: boolean }> = []
  const reviewed: Array<{ backup: typeof candidates[number]; metadata: Record<string, unknown>; roots: Map<string, RetentionBlob>; untagged: boolean }> = []
  let shared = candidates.length !== listed.length || unreadableAnchor !== undefined
  let warning = all.length !== listed.length
  if (unreadableAnchor && !candidates.some(backup => backup.prefix === unreadableAnchor!.prefix)) {
    const reason = unreadableAnchor.error instanceof Error ? unreadableAnchor.error.message : String(unreadableAnchor.error)
    warning = true
    notice(`Kept backup ${unreadableAnchor.prefix} because it could not be verified: ${reason.replace(/\.$/, "")}.`, "warning")
  }
  let kept = 0
  let unowned = 0
  let visiting: string | undefined
  let lastCompleted: string | undefined
  let madeProgress = false
  const unreadableThisRun = new Set<string>()
  const handleUnreadable = (prefix: string, error: unknown): boolean => {
    const progress = state.reviews[prefix] ??= { files: {}, attempts: 0 }
    progress.failures = (progress.failures ?? 0) + 1
    const reason = error instanceof Error ? error.message : String(error)
    progress.reason = reason
    if (progress.failures < UNREADABLE_ATTEMPTS) {
      save()
      return false
    }
    shared = true
    warning = true
    unreadableThisRun.add(prefix)
    notice(unreadableWarning(prefix, progress.failures, reason), "warning")
    for (let index = plan.length - 1; index >= 0; index--) {
      const entry = plan[index]!
      if (entry.untagged) {
        plan.splice(index, 1)
        unowned++
      } else if (!entry.coveredByOwned) {
        plan.splice(index, 1)
        kept++
      }
    }
    return true
  }
  try {
    for (const backup of candidates) {
      const { prefix } = backup
      if (prefix === anchorPrefix) continue
      visiting = prefix
      if (unreadableAnchor && prefix === unreadableAnchor.prefix) {
        if (handleUnreadable(prefix, unreadableAnchor.error)) continue
        throw unreadableAnchor.error
      }
      const roots = new Map<string, RetentionBlob>()
      try {
        const { manifest, owner: ownership } = await resolveBackupOwnership(async name => {
          const file = await storage.readForRetention(prefix + name, true)
          if (!file) return { kind: "missing" }
          roots.set(name, file)
          return { kind: "found", value: file.value }
        }, tenant)
        if (manifest.kind === "unreadable") throw new RetentionVerificationError(manifest.error instanceof Error ? manifest.error.message : String(manifest.error), { cause: manifest.error })
        if (ownership.kind === "unreadable") throw new RetentionVerificationError(ownership.error instanceof Error ? ownership.error.message : String(ownership.error), { cause: ownership.error })
        if (ownership.kind === "other") {
          delete state.reviews[prefix]
          shared = true
          if (backup.time < cutoff) unowned++
          continue
        }
        if (manifest.kind !== "found" || manifest.metadata.Items === undefined) {
          delete state.reviews[prefix]
          if (manifest.kind === "found" && backup.time < cutoff) {
            notice(`Kept backup ${prefix} because it has no manifest item list.`, "warning")
            warning = true
          }
          continue
        }
        reviewed.push({ backup, metadata: manifest.metadata, roots, untagged: ownership.kind === "untagged" })
      } catch (error) {
        if (isCandidateUnreadable(error) && handleUnreadable(prefix, error)) continue
        throw error
      }
    }

    for (const { backup: { prefix, time }, metadata, roots, untagged } of reviewed) {
      visiting = prefix
      if (untagged && shared) {
        if (time < cutoff) unowned++
        lastCompleted = prefix
        continue
      }
      const progress = state.reviews[prefix] ??= { files: {}, attempts: 0 }
      const beforeFiles = Object.keys(progress.files).length
      try {
        const listing = await storage.list(prefix)
        if (listing.blobs.includes(prefix + owner)) {
          const claim = roots.get(owner) ?? await storage.readForRetention(prefix + owner)
          checkOwner(claim, metadata, tenant, prefix)
          roots.set(owner, claim)
        }
        const verified = await verifyBackup(storage, prefix, metadata, roots, listing, keyFingerprint, progress)
        if (time < cutoff && hasCoverage(verified.types, shared)) {
          budget.reserveDeletes(verified.identities.size)
          plan.push({ prefix, identities: verified.identities, untagged, coveredByOwned: hasCoverage(verified.types, true) })
        } else {
          if (time < cutoff) kept++
          // Only a backup that will remain on disk can supply coverage for an older candidate.
          const target = untagged ? untaggedCoverage : ownedCoverage
          for (const folder of verified.covers) target.add(folder)
        }
        delete state.reviews[prefix]
        lastCompleted = prefix
      } catch (error) {
        if (Object.keys(progress.files).length > beforeFiles) madeProgress = true
        if (isCandidateUnreadable(error) && handleUnreadable(prefix, error)) {
          lastCompleted = prefix
          continue
        }
        throw error
      }
    }
    for (const backup of older) {
      if (unreadableThisRun.has(backup.prefix)) continue
      const review = state.reviews[backup.prefix]
      if ((review?.failures ?? 0) >= UNREADABLE_ATTEMPTS) {
        warning = true
        notice(unreadableWarning(backup.prefix, review!.failures!, review!.reason), "warning")
      }
    }
    const last = candidates.at(-1)?.prefix
    const hasMore = Boolean(last && older.some(backup => backup.prefix < last))
    if (!hasMore && state.latest === anchorPrefix) {
      delete state.latest
      delete state.reviews[anchorPrefix]
    }
    advance(last)
  } catch (error) {
    if (!(error instanceof RetentionBudgetError)) {
      if (visiting && !Object.keys(state.reviews[visiting]?.files ?? {}).length
        && !state.reviews[visiting]?.attempts && !state.reviews[visiting]?.failures) {
        delete state.reviews[visiting]
      }
      if (madeProgress || unreadableThisRun.size > 0) save()
      if (error instanceof InventoryDamagedError) throw error
      throw new Error(`${visiting ?? "A backup"} could not be verified. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    warning = true
    if (visiting) {
      const progress = state.reviews[visiting] ??= { files: {}, attempts: 0 }
      progress.attempts++
      notice(`Kept backup ${visiting} because retention reached its storage budget. It will be reconsidered.`, "warning")
      if (progress.attempts >= 3) notice(`Retention repeatedly deferred backup ${visiting}. Review its storage size and the backup log.`, "warning")
    }
    if (lastCompleted) advance(lastCompleted)
    else if (madeProgress || visiting !== candidates[0]?.prefix) save()
    else advance(visiting)
  }

  run.beforeDelete()
  let removed = 0
  for (const { prefix, identities } of plan) {
    const manifest = prefix + "metadata.json"
    const marker = prefix + owner
    const payloads = [...identities.keys()].filter(name => name !== manifest && name !== marker)
    // Local inventory flags a missing manifest entry as damage. Azure keeps the manifest
    // until all conditional payload deletes succeed, and both keep ownership until the end.
    const order = local ? [manifest, ...payloads, marker] : [...payloads, manifest, marker]
    let deleted = 0
    try {
      for (const name of order) {
        const etag = identities.get(name)
        if (etag) {
          await storage.delete(name, etag)
          deleted++
        }
      }
      removed++
    } catch (error) {
      if (!(error instanceof DeleteConditionError) && !(error instanceof ProtectedBlobError)) throw error
      warning = true
      const reason = error instanceof ProtectedBlobError ? "storage immutability or a legal hold refused deletion" : error.message
      notice(`Kept ${deleted ? "the remaining files in " : ""}backup ${prefix} because ${reason.replace(/\.$/, "")}.`, "warning")
    }
  }
  if (removed) notice(`Removed ${removed} backup${removed === 1 ? "" : "s"} older than ${days} days.`, "info")
  if (kept) notice(`Kept ${kept} older backup${kept === 1 ? "" : "s"} because ${kept === 1 ? "it holds" : "they hold"} the newest copy of types this backup leaves out.`, "info")
  if (unowned) notice(`Kept ${unowned} older backup${unowned === 1 ? "" : "s"} not recorded as this tenant's.`, "info")
  return warning
}
