import { typeForFolder } from "../intune/registry"
import type { RunOutcomes } from "../backup-outcomes"
import { MAX_FOLDER_REFUSALS, type ConnectionRecord, type PermissionChange, type RunObservation, type Snapshot } from "./model"

/** Folder keys must be plain names, never properties inherited from an object prototype. */
export const validFolder = (folder: unknown): folder is string => typeof folder === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(folder) && !Object.hasOwn(Object.prototype, folder)
export const folderValue = <T>(values: Record<string, T>, folder: string): T | undefined => Object.hasOwn(values, folder) ? values[folder] : undefined

/**
 * What a backup run says about access, type by type, without any text of the run:
 * - saved is a read. Not configured says nothing about access to previously saved policies.
 * - a type Microsoft refused is a refusal, with the cause the run found.
 * - a type the Backup Reader leaves out, or that only a signed-in admin can read, was never asked
 *   for, so it says nothing about access.
 * - a type that failed for another reason (a request without an answer, a throttle, a run that
 *   stopped) says nothing about access either. Only a 403 on the type's own read does: the types
 *   whose refusal ends as failed are refused that way.
 *
 * `account` is the admin who ran it; left out for a Backup Reader run.
 */
export function runObservation(outcomes: RunOutcomes, account?: string, permissionHeld: Record<string, boolean | undefined> = {}): RunObservation {
  const observation: RunObservation = {
    runId: outcomes.runId,
    at: outcomes.endedAt,
    trigger: outcomes.trigger,
    status: outcomes.status,
    ...(outcomes.authMode === "delegated" && account ? { account } : {}),
    read: [],
    refused: [],
    unread: [],
    excluded: [],
  }
  for (const type of outcomes.types) {
    if (!validFolder(type.folder)) continue
    if (type.outcome === "notConfigured") continue
    if (type.outcome === "saved") observation.read.push(type.folder)
    else if (type.outcome === "skipped") {
      // A deliberate mode restriction is not evidence that Microsoft removed access.
      if (type.cause === "appOnly" || (outcomes.authMode === "delegated" && typeForFolder(type.folder)?.backupMode === "application")) observation.unread.push(type.folder)
      else if (type.reader) observation.excluded.push({ folder: type.folder, cause: "reader" })
      else if (type.cause === "signedIn") observation.excluded.push({ folder: type.folder, cause: "signedIn" })
      else observation.refused.push({ folder: type.folder, cause: type.cause, ...answer(type) })
    // A type with explicit availability rules can fail on an unclassified license refusal.
    // That 403 is unread configuration, not evidence of a missing permission.
    } else if (type.status === 403 && typeForFolder(type.folder)?.unavailable === undefined) observation.refused.push({ folder: type.folder, cause: "permission", ...answer(type) })
    else observation.unread.push(type.folder)
  }
  for (const refusal of observation.refused) {
    const held = folderValue(permissionHeld, refusal.folder)
    if (held !== undefined) refusal.permissionHeld = held
  }
  return observation
}

/** The status and the error code Microsoft Graph answered with, never its message. */
function answer(type: { status?: number; code?: string }): { status?: number; code?: string } {
  return { ...(type.status !== undefined ? { status: type.status } : {}), ...(type.code ? { code: type.code.slice(0, 80) } : {}) }
}

/**
 * Adds what a run says to the evidence its connection keeps per folder: when the folder was last
 * read, and which runs refused it since.
 * - A read is the folder's last read when no later one is known, and ends every refusal before it.
 * - A refusal counts only for a folder that was read before it: a folder that was never read
 *   cannot be lost. Each run counts once. Of the refusals since the read, the first and the
 *   latest are kept.
 * - A run that left the folder out, or could not read it for another reason, changes nothing.
 */
export function keepEvidence(evidence: Pick<ConnectionRecord, "verified" | "refused">, run: RunObservation): void {
  const ended = Date.parse(run.at)
  for (const folder of run.read) {
    if (!validFolder(folder)) continue
    if (!(Date.parse(folderValue(evidence.verified, folder) ?? "") >= ended)) evidence.verified[folder] = run.at
    const readAt = Date.parse(folderValue(evidence.verified, folder)!)
    const since = (folderValue(evidence.refused, folder) ?? []).filter((refusal) => Date.parse(refusal.at) > readAt)
    if (since.length) evidence.refused[folder] = since
    else delete evidence.refused[folder]
  }
  for (const { folder, cause, permissionHeld } of run.refused) {
    if (!validFolder(folder)) continue
    const readAt = folderValue(evidence.verified, folder)
    if (!readAt || Date.parse(readAt) >= ended) continue
    const kept = folderValue(evidence.refused, folder) ?? []
    if (kept.some((refusal) => refusal.runId === run.runId)) continue
    const since = [...kept, { runId: run.runId, at: run.at, cause, ...(permissionHeld !== undefined ? { permissionHeld } : {}) }].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    evidence.refused[folder] = since.length > MAX_FOLDER_REFUSALS ? [since[0]!, ...since.slice(1 - MAX_FOLDER_REFUSALS)] : since
  }
}

/** Changes already found belong to the earlier sign-in, with their discovery time and no account. */
export function carryChanges(snapshot: Snapshot | undefined): PermissionChange[] {
  return [...(snapshot?.carried ?? []), ...(snapshot?.found ?? [])].map((change) => ({ ...change, earlierSignIn: true }))
}
