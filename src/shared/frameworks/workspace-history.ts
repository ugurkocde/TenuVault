/** Saved assessments a policy-pack workspace keeps per tenant and framework. */
export const MAX_WORKSPACE_HISTORY = 50
/** The largest serialized workspace the main process saves. */
export const MAX_WORKSPACE_BYTES = 32_000_000
/** The newest saved assessments kept when an admin removes older ones to make room. */
export const KEEP_NEWEST_ASSESSMENTS = 10
export const HISTORY_FULL_MESSAGE = "Workspace history is full. Export older assessments if you need them, then delete them before continuing."

/**
 * How full a workspace history is. `full` means the next assessment cannot be saved:
 * the history holds the most assessments it can keep (`count`), or one more assessment of
 * the size of the newest would pass the storage limit (`size`).
 */
export interface WorkspaceCapacity { count: number; limit: number; full: boolean; reason: "count" | "size" | null }

/** True when a request failed because the workspace history is full. */
export function isHistoryFullError(message: string): boolean {
  return message.includes(HISTORY_FULL_MESSAGE)
}

/** A saved workspace that is damaged or from an unsupported version. Only a reset can clear it. */
export const WORKSPACE_UNREADABLE_MESSAGE = "The saved workspace cannot be read"

/** True when a request failed because the saved workspace cannot be read. */
export function isWorkspaceUnreadableError(message: string): boolean {
  return message.includes(WORKSPACE_UNREADABLE_MESSAGE)
}
