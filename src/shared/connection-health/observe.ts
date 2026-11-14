import type { RunOutcomes } from "../backup-outcomes"
import type { RunObservation } from "./model"

/**
 * What a backup run says about access, type by type, without any text of the run:
 * - saved and not configured are reads: Microsoft answered for the type.
 * - a type Microsoft refused is a refusal, with the cause the run found.
 * - a type the Backup Reader leaves out, or that only a signed-in admin can read, was never asked
 *   for, so it says nothing about access.
 * - a type that failed for another reason (a request without an answer, a throttle, a run that
 *   stopped) says nothing about access either. Only a 403 on the type's own read does: the types
 *   whose refusal ends as failed are refused that way.
 *
 * `account` is the admin who ran it; left out for a Backup Reader run.
 */
export function runObservation(outcomes: RunOutcomes, account?: string): RunObservation {
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
    if (type.outcome === "saved" || type.outcome === "notConfigured") observation.read.push(type.folder)
    else if (type.outcome === "skipped") {
      if (type.reader) observation.excluded.push({ folder: type.folder, cause: "reader" })
      else if (type.cause === "signedIn") observation.excluded.push({ folder: type.folder, cause: "signedIn" })
      else observation.refused.push({ folder: type.folder, cause: type.cause, ...answer(type) })
    } else if (type.status === 403) observation.refused.push({ folder: type.folder, cause: "permission", ...answer(type) })
    else observation.unread.push(type.folder)
  }
  return observation
}

/** The status and the error code Microsoft Graph answered with, never its message. */
function answer(type: { status?: number; code?: string }): { status?: number; code?: string } {
  return { ...(type.status !== undefined ? { status: type.status } : {}), ...(type.code ? { code: type.code.slice(0, 80) } : {}) }
}
