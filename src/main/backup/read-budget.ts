import type { ReadControl } from "./graph-session"

export class ReadBudgetError extends Error {
  constructor() {
    super("Too many groups to read within the backup's time budget. This type was not fully read.")
  }
}

/** A local deadline also interrupts retry sleeps and pending reads; the run keeps its own signal. */
export async function withReadBudget<T>(runSignal: AbortSignal, durationMs: number, maxRequests: number, read: (control: ReadControl) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const signal = AbortSignal.any([runSignal, controller.signal])
  const deadline = Date.now() + durationMs
  const expire = () => controller.abort(new ReadBudgetError())
  const timer = setTimeout(expire, durationMs)
  let requests = 0
  let onAbort: () => void = () => {}
  try {
    signal.throwIfAborted()
    const stopped = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener("abort", onAbort, { once: true })
    })
    return await Promise.race([stopped, read({ signal, beforeRequest: () => {
      signal.throwIfAborted()
      if (Date.now() >= deadline || requests >= maxRequests) {
        expire()
        signal.throwIfAborted()
      }
      requests++
    } })])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}
