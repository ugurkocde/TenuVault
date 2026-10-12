import { backupBeforeWrite } from "../../backup/before-write"
import type { FeatureDeps } from "../deps"
import { FeatureError } from "../route"

/** Polling of the pre-change backup. Tests replace `sleep`; nothing else reads real time. */
export const BACKUP_POLLING = {
  intervalMs: 2000,
  timeoutMs: 60 * 60_000,
  sleep: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/**
 * Runs a full backup of the tenant through the app's own backup routes and waits for it,
 * like OpenIntuneBaseline deployments. Fails closed: any start, status or result failure throws before a single
 * tenant write, and so does a backup that is not complete for the folders being written.
 * Returns the backup folder, which the change set records.
 */
export async function requirePreChangeBackup(deps: FeatureDeps, tenantId: string, folders: string[]): Promise<string> {
  const post = async (path: string, body: Record<string, unknown>) => {
    try {
      const response = await deps.api(path, tenantId, body)
      return { ok: response.ok, status: response.status, json: record(await response.json().catch(() => ({}))) }
    } catch (error) {
      return { ok: false, status: 502, json: { error: error instanceof Error ? error.message : String(error) } }
    }
  }
  return backupBeforeWrite({
    workflow: "change-set", post, startBody: {}, folders,
    now: () => deps.now().getTime(),
    polling: BACKUP_POLLING,
    error: (message, status) => new FeatureError(message, status),
  })
}
