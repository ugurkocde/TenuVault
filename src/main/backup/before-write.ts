import { record } from "../../shared/frameworks/policies"
import { backupGaps, describeMissing, describeStatus } from "./completeness"

interface BackupProgress { stage: string; percent?: number; backupJobId: string }
interface BackupOptions {
  workflow: "oib" | "change-set"
  post: (path: string, body: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json: Record<string, unknown> }>
  startBody: Record<string, unknown>
  folders: string[]
  now: () => number
  polling: { intervalMs: number; timeoutMs: number; sleep: (milliseconds: number) => Promise<void> }
  error: (message: string, status: number) => Error
  report?: (update: BackupProgress) => void
}

/**
 * Starts, waits for and checks the backup before tenant writes. Callers keep their existing
 * credentials, scope and error wording. Backup routes still generate the folder and metadata;
 * the returned folder is kept verbatim so saved undo and rollback records keep resolving.
 */
export async function backupBeforeWrite(options: BackupOptions): Promise<string> {
  const { post, folders, polling, report } = options
  const oib = options.workflow === "oib"
  const backup = oib ? "backup" : "pre-change backup"
  const stopped = oib ? "nothing was changed" : "nothing was written"
  const fail: (message: string, status?: number) => never = (message, status = 502) => { throw options.error(message, status) }
  const started = await post("/api/backup/start", options.startBody)
  if (!started.ok || typeof started.json.jobId !== "string") {
    fail(`The ${backup} could not start, so ${stopped}. ${typeof started.json.error === "string" ? started.json.error : ""}`.trim(), started.status === 402 ? 402 : 502)
  }
  const jobId = started.json.jobId
  const types = `${folders.length} policy type${folders.length === 1 ? "" : "s"}`
  report?.({ stage: `Backing up ${types}`, percent: 0, backupJobId: jobId })
  const deadline = options.now() + polling.timeoutMs
  for (;;) {
    const status = await post("/api/backup/status", { jobId })
    if (!status.ok) fail(`The ${backup} status could not be read, so ${stopped}.`)
    if (status.json.isComplete === true) {
      if (status.json.isSuccessful !== true || typeof status.json.backupFolder !== "string" || !status.json.backupFolder) {
        fail(`The ${backup} failed, so ${stopped}. ${typeof status.json.exception === "string" ? status.json.exception : ""}`.trim())
      }
      const backupFolder = status.json.backupFolder
      report?.({ stage: "Checking the backup", percent: 100, backupJobId: jobId })
      const contents = await post("/api/list-backup-contents", { backupId: backupFolder })
      const gaps = contents.ok ? backupGaps(record(contents.json.content) ? contents.json.content.metadata : undefined, folders) : null
      if (!gaps) fail(`The result of the ${backup} ${backupFolder} could not be read, so ${stopped}.`)
      if (!gaps.succeeded) fail(`The ${backup} ${backupFolder} is not complete (${describeStatus(gaps)}), so ${stopped}. Check the backup log, fix the cause and ${oib ? "try again" : "apply again"}.`)
      if (gaps.missing.length) {
        const typesWritten = oib ? "policy type this run changes" : "type this change set writes"
        const retry = oib ? "Grant the missing permissions and try again." : "Include those types in the backup scope, grant the missing permissions and apply again."
        fail(`The ${backup} ${backupFolder} did not collect every ${typesWritten} (${describeMissing(gaps)}), so ${stopped}. ${retry}`)
      }
      return backupFolder
    }
    if (options.now() > deadline) fail(`The ${backup} did not finish within an hour, so ${stopped}.`, 504)
    const percent = typeof status.json.progress === "number" && Number.isFinite(status.json.progress) ? Math.min(100, Math.max(0, Math.round(status.json.progress))) : undefined
    report?.({ stage: `Backing up ${types}: ${typeof status.json.progressMessage === "string" ? status.json.progressMessage : "in progress"}`, ...(percent !== undefined ? { percent } : {}), backupJobId: jobId })
    await polling.sleep(polling.intervalMs)
  }
}
