import { BACKUP_OWNER_FILE } from "../../shared/constants"
import { parseBackupName } from "../../shared/intune/backup-names"
import { resolveBackupOwnership } from "../../shared/backup-ownership"
import { FetchApplicationError, FetchPreconditionError } from "../api/network-error"
import { isLocalAccount } from "../storage/blob-emulator"
import type { BlobWriter, RetentionBlob } from "./blob-writer"
import { RetentionBudget, RetentionBudgetError, type RetentionLimits } from "./retention-budget"
import { DAY_MS, HOUR_MS, RetentionClockError } from "./retention-clock"
import { readRetentionProgress, type DeletionJournalEntry, type RetentionProgressStore } from "./retention-progress"
import { RetentionVerificationError, checkOwner, manifestTypes, verifyBackup } from "./retention-verification"
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

async function verifyReplacementUnchanged(storage: BlobWriter, prefix: string, expected: Map<string, string>): Promise<boolean> {
  const listing = await storage.list(prefix)
  const seen = new Set(listing.blobs)
  if (seen.size !== listing.blobs.length || seen.size !== expected.size) return false
  for (const [path, etag] of expected) {
    if (!seen.has(path)) return false
    if (listing.etags.has(path)) {
      if (listing.etags.get(path) !== etag) return false
    } else {
      const current = await storage.readForRetention(path, true)
      if (!current || current.etag !== etag) return false
    }
  }
  return true
}

interface PlannedDeletion {
  prefix: string
  identities: Map<string, string>
  types: Set<string>
  noTypes: boolean
  untagged: boolean
  replacements: string[]
  ownedReplacements: string[] | null
  resumed: boolean
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
  const rawProgress = run.progress.get(key)
  const state = readRetentionProgress(rawProgress)
  if (rawProgress && !state.cursor && !state.latest && !state.latestAttempts && !Object.keys(state.reviews).length && !state.deletes) {
    run.progress.delete(key)
  }
  const latestPrefix = `${current}/`
  const older = all.filter(backup => backup.prefix < latestPrefix)
  const previous = state.cursor ? older.findIndex(backup => backup.prefix < state.cursor!) : 0
  const start = Math.max(0, previous)
  const candidates = older.slice(start, start + limits.candidates)
  const existing = new Set([latestPrefix, ...older.map(backup => backup.prefix)])
  const save = () => {
    for (const prefix of Object.keys(state.reviews)) if (!existing.has(prefix)) delete state.reviews[prefix]
    if (state.latest && !existing.has(state.latest)) delete state.latest
    if (state.deletes) {
      for (const prefix of Object.keys(state.deletes)) if (!existing.has(prefix)) delete state.deletes[prefix]
      if (!Object.keys(state.deletes).length) delete state.deletes
    }
    if (!state.cursor && !state.latest && !state.latestAttempts && !Object.keys(state.reviews).length && !state.deletes) run.progress.delete(key)
    else run.progress.set(key, JSON.stringify(state))
  }
  const advance = (prefix: string | undefined) => {
    state.cursor = prefix && older.some(backup => backup.prefix < prefix) ? prefix : undefined
    save()
  }
  let invalidJournal = false
  const discardJournal = (prefix: string, reason?: string) => {
    if (!state.deletes || !Object.hasOwn(state.deletes, prefix)) return
    delete state.deletes[prefix]
    if (!Object.keys(state.deletes).length) delete state.deletes
    save()
    if (reason) {
      invalidJournal = true
      notice(reason, "warning")
    }
  }
  discardJournal(latestPrefix, `Discarded an invalid deletion journal for protected backup ${latestPrefix}.`)

  if (!candidates.length || !older.some(backup => backup.time < cutoff)) {
    let warned = all.length !== listed.length || invalidJournal
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
  let anchorVerified: Awaited<ReturnType<typeof verifyBackup>>
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
        return verifyBackup(storage, latestPrefix, written, roots, await storage.list(latestPrefix), keyFingerprint, latestProgress)
      }
      const anchorManifest = await storage.readForRetention(anchorPrefix + "metadata.json")
      const anchorMetadata = anchorManifest.value as Record<string, unknown>
      if (typeof anchorMetadata.TenantId !== "string" || anchorMetadata.TenantId.toLowerCase() !== tenant) {
        throw new RetentionVerificationError(`${anchorPrefix}metadata.json does not match the backup's ownership.`)
      }
      const anchorClaim = await storage.readForRetention(anchorPrefix + owner)
      checkOwner(anchorClaim, anchorMetadata, tenant, anchorPrefix)
      const anchorRoots = new Map([["metadata.json", anchorManifest], [owner, anchorClaim]])
      return verifyBackup(storage, anchorPrefix, anchorMetadata, anchorRoots, await storage.list(anchorPrefix), keyFingerprint, latestProgress)
    }
    try {
      anchorVerified = await verifyAnchor()
    } catch (error) {
      if (anchorPrefix !== latestPrefix && isCandidateUnreadable(error)) {
        unreadableAnchor = { prefix: anchorPrefix, error }
        delete state.latest
        delete state.latestAttempts
        save()
        anchorPrefix = latestPrefix
        latestProgress = state.reviews[latestPrefix] = { files: {}, attempts: 0 }
        beforeLatestFiles = 0
        anchorVerified = await verifyAnchor()
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

  discardJournal(anchorPrefix, `Discarded an invalid deletion journal for protected backup ${anchorPrefix}.`)
  if (unreadableAnchor) discardJournal(unreadableAnchor.prefix, `Discarded an invalid deletion journal for unreadable backup ${unreadableAnchor.prefix}.`)

  const replacementIdentities = new Map<string, Map<string, string>>([[anchorPrefix, anchorVerified.identities]])
  const ownedProviders = new Map<string, string>()
  const untaggedProviders = new Map<string, string>()
  for (const folder of anchorVerified.covers) ownedProviders.set(folder, anchorPrefix)
  const providersFor = (types: Set<string>, ownedOnly: boolean, allowEmpty = false): string[] | null => {
    if (!types.size) return allowEmpty ? [anchorPrefix] : null
    const providers = new Set<string>()
    for (const folder of types) {
      const provider = ownedProviders.get(folder) ?? (ownedOnly ? undefined : untaggedProviders.get(folder))
      if (!provider) return null
      providers.add(provider)
    }
    return [...providers]
  }
  const plan: PlannedDeletion[] = []
  type DiscoveredCandidate =
    | { backup: typeof candidates[number]; journal: DeletionJournalEntry; manifest: Record<string, unknown> | null; roots: Map<string, RetentionBlob> }
    | { backup: typeof candidates[number]; metadata: Record<string, unknown>; roots: Map<string, RetentionBlob>; untagged: boolean }
  const reviewed: DiscoveredCandidate[] = []
  let shared = candidates.length !== listed.length || unreadableAnchor !== undefined
  let warning = all.length !== listed.length || invalidJournal
  if (unreadableAnchor && !candidates.some(backup => backup.prefix === unreadableAnchor!.prefix)) {
    const reason = unreadableAnchor.error instanceof Error ? unreadableAnchor.error.message : String(unreadableAnchor.error)
    warning = true
    notice(`Kept backup ${unreadableAnchor.prefix} because it could not be verified: ${reason.replace(/\.$/, "")}.`, "warning")
  }
  let kept = 0
  let unowned = 0
  let visiting: string | undefined
  let lastDiscovered: string | undefined
  let discoveryBudgetPrefix: string | undefined
  let lastCompleted: string | undefined
  let madeProgress = false
  let pendingCursor: string | undefined
  let hasPendingCursor = false
  let windowCompleted = false
  let budgetHit = false
  const unreadableThisRun = new Set<string>()
  const handleUnreadable = (prefix: string, error: unknown): void => {
    const progress = state.reviews[prefix] ??= { files: {}, attempts: 0 }
    progress.failures = (progress.failures ?? 0) + 1
    const reason = error instanceof Error ? error.message : String(error)
    progress.reason = reason
    shared = true
    warning = true
    unreadableThisRun.add(prefix)
    const detail = reason.replace(/\.$/, "")
    notice(
      progress.failures >= UNREADABLE_ATTEMPTS
        ? unreadableWarning(prefix, progress.failures, reason)
        : `Kept backup ${prefix} because it could not be verified: ${detail}.`,
      "warning",
    )
    for (let index = plan.length - 1; index >= 0; index--) {
      const entry = plan[index]!
      if (entry.untagged) {
        plan.splice(index, 1)
        unowned++
      } else if (!entry.ownedReplacements) {
        plan.splice(index, 1)
        kept++
      } else {
        entry.replacements = entry.ownedReplacements
      }
    }
  }
  try {
    for (const backup of candidates) {
      const { prefix } = backup
      if (prefix === anchorPrefix) continue
      visiting = prefix
      if (unreadableAnchor && prefix === unreadableAnchor.prefix) {
        handleUnreadable(prefix, unreadableAnchor.error)
        lastDiscovered = prefix
        continue
      }
      const journal = state.deletes?.[prefix]
      if (journal) {
        const remainingEntries = Object.entries(journal.remaining)
        const journalValid = prefix !== latestPrefix
          && prefix !== anchorPrefix
          && journal.prefix === prefix
          && (journal.types.length === 0 ? journal.noTypes : !journal.noTypes)
          && journal.types.every(entry => entry.length > 0)
          && remainingEntries.every(([name, etag]) => name.startsWith(prefix) && name.length > prefix.length && etag.length > 0 && etag !== "*")
          && (!journal.noTypes || remainingEntries.every(([name]) => name === prefix + "metadata.json" || name === prefix + owner))
        if (!journalValid) {
          discardJournal(prefix, `Kept backup ${prefix} because its deletion journal failed validation and was discarded.`)
          warning = true
          lastDiscovered = prefix
          continue
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
            discardJournal(prefix)
            delete state.reviews[prefix]
            shared = true
            if (backup.time < cutoff) unowned++
            lastDiscovered = prefix
            continue
          }
          const untagged = ownership.kind === "untagged"
          if (untagged !== journal.untagged || (!local && untagged && manifest.kind !== "found")) {
            discardJournal(prefix, `Kept backup ${prefix} because its deletion journal did not match its ownership and was discarded.`)
            warning = true
            lastDiscovered = prefix
            continue
          }
          reviewed.push({ backup, journal, manifest: manifest.kind === "found" ? manifest.metadata : null, roots })
          lastDiscovered = prefix
          continue
        } catch (error) {
          if (error instanceof RetentionBudgetError) {
            discoveryBudgetPrefix = prefix
            shared = true
            break
          }
          if (isCandidateUnreadable(error)) {
            discardJournal(prefix)
            handleUnreadable(prefix, error)
            lastDiscovered = prefix
            continue
          }
          throw error
        }
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
          lastDiscovered = prefix
          continue
        }
        if (manifest.kind !== "found" || manifest.metadata.Items === undefined) {
          delete state.reviews[prefix]
          if (manifest.kind === "found" && backup.time < cutoff) {
            notice(`Kept backup ${prefix} because it has no manifest item list.`, "warning")
            warning = true
          }
          lastDiscovered = prefix
          continue
        }
        reviewed.push({ backup, metadata: manifest.metadata, roots, untagged: ownership.kind === "untagged" })
        lastDiscovered = prefix
      } catch (error) {
        if (error instanceof RetentionBudgetError) {
          discoveryBudgetPrefix = prefix
          shared = true
          break
        }
        if (isCandidateUnreadable(error)) {
          handleUnreadable(prefix, error)
          lastDiscovered = prefix
          continue
        }
        throw error
      }
    }

    if (discoveryBudgetPrefix && (budget.exhausted || !reviewed.length)) {
      visiting = discoveryBudgetPrefix
      throw new RetentionBudgetError()
    }

    for (const item of reviewed) {
      const { prefix, time } = item.backup
      visiting = prefix
      if ("journal" in item) {
        const { journal, manifest, roots } = item
        if (prefix === latestPrefix || prefix === anchorPrefix || journal.prefix !== prefix) {
          discardJournal(prefix, `Kept backup ${prefix} because its deletion journal failed validation and was discarded.`)
          warning = true
          lastCompleted = prefix
          continue
        }
        if (journal.untagged && shared) {
          if (time < cutoff) unowned++
          lastCompleted = prefix
          continue
        }
        const journalTypes = new Set(journal.types)
        if (manifest) {
          const declaredTypes = manifestTypes(manifest, prefix)
          if (!declaredTypes
            || journal.noTypes !== (declaredTypes.size === 0)
            || [...declaredTypes].some(folder => !journalTypes.has(folder))) {
            discardJournal(prefix, `Kept backup ${prefix} because its deletion journal did not match its manifest and was discarded.`)
            warning = true
            lastCompleted = prefix
            continue
          }
        }
        const replacements = time < cutoff ? providersFor(journalTypes, shared, journal.noTypes) : null
        if (!replacements) {
          if (time < cutoff) kept++
          warning = true
          notice(`Kept the remaining files in backup ${prefix} because replacement coverage is no longer verified.`, "warning")
          lastCompleted = prefix
          continue
        }
        const listing = await storage.list(prefix)
        const listedSet = new Set(listing.blobs)
        if (listedSet.size !== listing.blobs.length) {
          warning = true
          notice(`Kept the remaining files in backup ${prefix} because storage listed duplicate files.`, "warning")
          lastCompleted = prefix
          continue
        }
        if (!listedSet.size) {
          discardJournal(prefix)
          lastCompleted = prefix
          continue
        }
        if (manifest && listedSet.has(prefix + owner)) {
          try {
            const claim = roots.get(owner) ?? await storage.readForRetention(prefix + owner)
            checkOwner(claim, manifest, tenant, prefix)
            roots.set(owner, claim)
          } catch (error) {
            if (isCandidateUnreadable(error)) {
              discardJournal(prefix)
              handleUnreadable(prefix, error)
              lastCompleted = prefix
              continue
            }
            throw error
          }
        }
        const unexpected = listing.blobs.find(name => !Object.hasOwn(journal.remaining, name))
        if (unexpected) {
          warning = true
          notice(`Kept the remaining files in backup ${prefix} because ${unexpected.slice(prefix.length)} was not in the verified deletion plan.`, "warning")
          lastCompleted = prefix
          continue
        }
        const identities = new Map<string, string>()
        let changedName: string | undefined
        for (const name of listing.blobs) {
          const expectedEtag = journal.remaining[name]!
          const rootEtag = name.startsWith(prefix) ? roots.get(name.slice(prefix.length))?.etag : undefined
          const observedEtag = listing.etags.get(name) ?? rootEtag
          if (observedEtag !== undefined && observedEtag !== expectedEtag) {
            changedName = name
            break
          }
          identities.set(name, expectedEtag)
        }
        if (changedName) {
          warning = true
          notice(`Kept the remaining files in backup ${prefix} because ${changedName} changed before it could be deleted.`, "warning")
          lastCompleted = prefix
          continue
        }
        const ownedReplacements = providersFor(journalTypes, true, journal.noTypes)
        budget.reserveDeletes(identities.size + replacements.length)
        plan.push({ prefix, identities, types: journalTypes, noTypes: journal.noTypes, untagged: journal.untagged, replacements, ownedReplacements, resumed: true })
        lastCompleted = prefix
        continue
      }
      const { metadata, roots, untagged } = item
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
        const noTypes = verified.types.size === 0
        const replacements = time < cutoff ? providersFor(verified.types, shared, noTypes) : null
        if (replacements) {
          const ownedReplacements = providersFor(verified.types, true, noTypes)
          budget.reserveDeletes(verified.identities.size + replacements.length)
          plan.push({ prefix, identities: verified.identities, types: verified.types, noTypes, untagged, replacements, ownedReplacements, resumed: false })
        } else {
          if (time < cutoff) kept++
          // Only a backup that will remain on disk can supply coverage for an older candidate.
          replacementIdentities.set(prefix, verified.identities)
          const target = untagged ? untaggedProviders : ownedProviders
          for (const folder of verified.covers) if (!target.has(folder)) target.set(folder, prefix)
        }
        delete state.reviews[prefix]
        lastCompleted = prefix
      } catch (error) {
        if (Object.keys(progress.files).length > beforeFiles) madeProgress = true
        if (isCandidateUnreadable(error)) {
          handleUnreadable(prefix, error)
          lastCompleted = prefix
          continue
        }
        throw error
      }
    }
    if (discoveryBudgetPrefix) {
      visiting = discoveryBudgetPrefix
      lastCompleted = lastDiscovered
      throw new RetentionBudgetError()
    }
    for (const backup of older) {
      if (unreadableThisRun.has(backup.prefix)) continue
      const review = state.reviews[backup.prefix]
      if ((review?.failures ?? 0) >= UNREADABLE_ATTEMPTS) {
        warning = true
        notice(unreadableWarning(backup.prefix, review!.failures!, review!.reason), "warning")
      }
    }
    pendingCursor = candidates.at(-1)?.prefix
    hasPendingCursor = true
    windowCompleted = true
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
    budgetHit = true
    warning = true
    if (visiting) {
      const progress = state.reviews[visiting] ??= { files: {}, attempts: 0 }
      progress.attempts++
      notice(`Kept backup ${visiting} because retention reached its storage budget. It will be reconsidered.`, "warning")
      if (progress.attempts >= 3) notice(`Retention repeatedly deferred backup ${visiting}. Review its storage size and the backup log.`, "warning")
    }
    if (lastCompleted) {
      pendingCursor = lastCompleted
      hasPendingCursor = true
    } else if (discoveryBudgetPrefix && lastDiscovered && !madeProgress) {
      pendingCursor = lastDiscovered
      hasPendingCursor = true
    } else if (madeProgress || visiting !== candidates[0]?.prefix) {
      save()
    } else {
      pendingCursor = visiting
      hasPendingCursor = true
    }
  }

  if (plan.length > 0 && (madeProgress || unreadableThisRun.size > 0 || budgetHit)) save()

  let removed = 0
  let completedPlan = true
  for (const { prefix, identities, types, noTypes, untagged, replacements, resumed } of plan) {
    if (prefix === latestPrefix || prefix === anchorPrefix) continue
    run.beforeDelete()
    const intact = await budget.withCleanup(async () => {
      for (const replacementPrefix of replacements) {
        const expected = replacementIdentities.get(replacementPrefix)
        if (!expected || !(await verifyReplacementUnchanged(storage, replacementPrefix, expected))) {
          warning = true
          notice(`Kept remaining backups because replacement backup ${replacementPrefix} changed before deletion.`, "warning")
          return false
        }
      }
      return true
    })
    if (!intact) {
      completedPlan = false
      break
    }
    const manifest = prefix + "metadata.json"
    const marker = prefix + owner
    const payloads = [...identities.keys()].filter(name => name !== manifest && name !== marker)
    // Local inventory flags a missing manifest entry as damage. Azure keeps the manifest
    // until all conditional payload deletes succeed, and both keep ownership until the end.
    const order = (local ? [manifest, ...payloads, marker] : [...payloads, manifest, marker]).filter(name => identities.has(name))
    const remaining = Object.fromEntries(order.map(name => [name, identities.get(name)!]))
    state.deletes ??= {}
    state.deletes[prefix] = { prefix, remaining, types: [...types], noTypes, untagged }
    save()
    let deleted = 0
    try {
      for (const name of order) {
        const etag = identities.get(name)
        if (etag) {
          await storage.delete(name, etag)
          deleted++
          delete remaining[name]
          if (!Object.keys(remaining).length && state.deletes) {
            delete state.deletes[prefix]
            if (!Object.keys(state.deletes).length) delete state.deletes
          }
          save()
        }
      }
      if (state.deletes) {
        delete state.deletes[prefix]
        if (!Object.keys(state.deletes).length) delete state.deletes
      }
      removed++
      advance(prefix)
    } catch (error) {
      if (!deleted && !resumed && state.deletes) {
        delete state.deletes[prefix]
        if (!Object.keys(state.deletes).length) delete state.deletes
      }
      save()
      if (!(error instanceof DeleteConditionError) && !(error instanceof ProtectedBlobError)) throw error
      warning = true
      const reason = error instanceof ProtectedBlobError ? "storage immutability or a legal hold refused deletion" : error.message
      notice(`Kept ${deleted || resumed ? "the remaining files in " : ""}backup ${prefix} because ${reason.replace(/\.$/, "")}.`, "warning")
      advance(prefix)
    }
  }
  if (completedPlan && hasPendingCursor) {
    const hasMore = Boolean(pendingCursor && older.some(backup => backup.prefix < pendingCursor!))
    if (windowCompleted && !hasMore && state.latest === anchorPrefix && !state.deletes) {
      delete state.latest
      delete state.reviews[anchorPrefix]
    }
    advance(pendingCursor)
  }
  if (removed) notice(`Removed ${removed} backup${removed === 1 ? "" : "s"} older than ${days} days.`, "info")
  if (kept) notice(`Kept ${kept} older backup${kept === 1 ? "" : "s"} because ${kept === 1 ? "it holds" : "they hold"} the newest copy of types this backup leaves out.`, "info")
  if (unowned) notice(`Kept ${unowned} older backup${unowned === 1 ? "" : "s"} not recorded as this tenant's.`, "info")
  return warning
}
