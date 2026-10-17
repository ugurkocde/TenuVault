import { BACKUP_CANCELLED_MESSAGE } from "../constants"

/**
 * The status a backup's metadata.json records. A run the user cancelled after claiming its folder
 * records Cancelled; versions before that recorded it as Failed with the cancel message.
 */
export function manifestStatus(metadata: Record<string, unknown>): unknown {
  const status = metadata.Status ?? metadata.status
  const legacyCancel = typeof status === "string" && status.trim().toLowerCase() === "failed" && typeof metadata.Error === "string" && metadata.Error.startsWith(BACKUP_CANCELLED_MESSAGE)
  return legacyCancel ? "Cancelled" : status
}

/**
 * A backup that stopped before it finished, because it failed or the user cancelled it: never a
 * complete backup, for restore, comparison and every other use of its data. Not for display: a
 * cancel is the user's choice and is shown neutral, never as a failure.
 */
export function stoppedEarly(status: unknown): boolean {
  const value = typeof status === "string" ? status.trim().toLowerCase() : ""
  return value.includes("fail") || value === "cancelled"
}
