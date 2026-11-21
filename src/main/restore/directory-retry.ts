import { RestoreWriteDeferredError } from "../../shared/intune/restore-guards"

export class DirectoryThrottledError extends RestoreWriteDeferredError {
  constructor(readonly response: Response) { super("The directory request was throttled and was not applied.", directoryRetryAt(response, 0)) }
}
/** Retry the entire writer so a throttled safety read cannot bypass earlier checks. */
export async function retryDirectoryWrite<T>(attemptWrite: () => Promise<T>, onUnapplied?: (retryAt: number) => void, signal?: AbortSignal, wait?: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await attemptWrite() }
    catch (error) {
      if (!(error instanceof DirectoryThrottledError)) throw error
      const retryAt = directoryRetryAt(error.response, attempt)
      onUnapplied?.(retryAt)
      try {
        if (attempt >= DIRECTORY_RETRIES) throw error
        await waitForDirectoryRetry(retryAt, signal, wait)
      } catch { throw new RestoreWriteDeferredError("The unapplied directory request is deferred. Resume after Retry-After.", retryAt) }
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
