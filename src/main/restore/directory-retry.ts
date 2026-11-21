import { RestoreWriteDeferredError } from "../../shared/intune/restore-guards"

/** A failed safety read dispatched no write and can be checked again on resume. */
export class DirectoryReadDeferredError extends RestoreWriteDeferredError {
  constructor() { super("A temporary Microsoft Graph read failure deferred this row. Resume to repeat its safety checks.") }
}

/** The signed-in admin can resume after activating the required Entra role. */
export class DirectoryRoleDeferredError extends RestoreWriteDeferredError {
  constructor(message = "Your Entra role does not allow this change. Activate the role, then resume.") { super(message, undefined, "role") }
}
export class DirectoryAuthenticationDeferredError extends RestoreWriteDeferredError {
  constructor(message = "Microsoft Graph rejected the connection's authentication. Resume with a fresh connection to repeat permission and approval checks.") { super(message, undefined, "authentication") }
}

/** Graph rejected a member add while the new group replicates. No write was applied. */
export class DirectoryReplicationDeferredError extends RestoreWriteDeferredError {
  constructor() { super("The group has not finished replicating in Microsoft Entra. Wait a few seconds, then resume to repeat permission, approval and safety checks.", Date.now() + 5000, "replication") }
}

export class DirectoryThrottledError extends RestoreWriteDeferredError {
  constructor(readonly response: Response) { super("The directory request was throttled and was not applied.", directoryRetryAt(response, 0), "throttle") }
}
/** An intermediary throttle does not prove whether a dispatched write reached Graph. */
export class DirectoryWriteUncertainError extends Error {
  readonly retryAt: number
  constructor(response: Response) {
    super("The directory throttle did not contain a structured Microsoft Graph error. Confirm the write after Retry-After before any retry.")
    this.retryAt = directoryRetryAt(response, 0)
  }
}
export async function directoryThrottleError(response: Response, read: boolean): Promise<DirectoryThrottledError | DirectoryWriteUncertainError> {
  if (read) return new DirectoryThrottledError(response)
  if (/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) {
    try {
      const value = await response.clone().json()
      if (value && typeof value.error?.code === "string" && value.error.code.toLowerCase() === "toomanyrequests") return new DirectoryThrottledError(response)
    } catch { /* Unparseable error bodies cannot prove a write was rejected by Graph. */ }
  }
  return new DirectoryWriteUncertainError(response)
}
/** Retry the entire writer so a throttled safety read cannot bypass earlier checks. */
export async function retryDirectoryWrite<T>(attemptWrite: () => Promise<T>, onUnapplied?: (retryAt: number, cause?: RestoreWriteDeferredError["deferralCause"]) => void, signal?: AbortSignal, wait?: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await attemptWrite() }
    catch (error) {
      if (error instanceof DirectoryRoleDeferredError || error instanceof DirectoryAuthenticationDeferredError || error instanceof DirectoryReplicationDeferredError) {
        onUnapplied?.(error.retryAt ?? Date.now(), error.deferralCause)
        throw error
      }
      if (!(error instanceof DirectoryThrottledError)) throw error
      const retryAt = directoryRetryAt(error.response, attempt)
      onUnapplied?.(retryAt, "throttle")
      try {
        if (attempt >= DIRECTORY_RETRIES) throw error
        await waitForDirectoryRetry(retryAt, signal, wait)
      } catch { throw new RestoreWriteDeferredError("The unapplied directory request is deferred. Resume after Retry-After.", retryAt, "throttle") }
    }
  }
}
/** Match the directory transport's four retries and one-minute wait budget. */
export const DIRECTORY_RETRIES = 4
export function directoryRetryAt(response: Response, attempt: number): number {
  const header = response.headers.get("Retry-After")
  const seconds = header?.trim() ? Number(header) : NaN
  const delay = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : NaN
  return Date.now() + Math.max(1000, Number.isFinite(delay) ? delay : 1000 * 2 ** attempt)
}
/** Longer server delays are deferred, never shortened to send before Retry-After. */
export async function waitForDirectoryRetry(retryAt: number, signal?: AbortSignal, wait?: (ms: number) => Promise<void>): Promise<void> {
  const delay = retryAt - Date.now()
  if (!Number.isFinite(delay) || delay > 60_000 || signal?.aborted) throw new RestoreWriteDeferredError("The unapplied directory request is deferred. Resume after Retry-After.")
  if (delay <= 0) return
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: unknown) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort)
      if (error) reject(error); else resolve()
    }
    const abort = () => finish(new RestoreWriteDeferredError("The unapplied directory request was cancelled. Resume to continue."))
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener("abort", abort, { once: true })
    if (wait) void wait(delay).then(() => finish(), finish)
    else timer = setTimeout(() => finish(), delay)
  })
}

/** Attempt both durable records even when one store write fails. Never turn a known throttle into a terminal failure. */
export class DirectoryRetryPersistenceError extends Error {
  constructor() { super("The Microsoft Graph retry deadline could not be saved in both restore records. The page remains locked. Resume to recover its saved deadline.") }
}
export function persistDirectoryRetry(saveJournal: () => void, saveCoordinator: () => void): void {
  let failed = false
  for (const save of [saveJournal, saveCoordinator]) {
    try { save() } catch { try { save() } catch { failed = true } }
  }
  if (failed) throw new DirectoryRetryPersistenceError()
}
