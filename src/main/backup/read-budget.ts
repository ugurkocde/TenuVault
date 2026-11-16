import type { ReadControl } from "./graph-session"

export class ReadBudgetError extends Error {
  constructor(message = "Too many groups to read within the backup's time budget. This type was not fully read.") {
    super(message)
  }
}

/** A local deadline also interrupts retry sleeps and pending reads; the run keeps its own signal. */
export async function withReadBudget<T>(runSignal: AbortSignal, durationMs: number, maxRequests: number, read: (control: ReadControl) => Promise<T>, error = new ReadBudgetError()): Promise<T> {
  const controller = new AbortController()
  const signal = AbortSignal.any([runSignal, controller.signal])
  const deadline = Date.now() + durationMs
  const expire = () => controller.abort(error)
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

/** One allowance across list, detail, sub-read, retry and page requests of a type. */
export function typeReadBudget(runSignal: AbortSignal, budget: { durationMs: number; maxRequests: number }) {
  let deadline: number | undefined
  let requests = 0
  return <T>(read: (control: ReadControl) => Promise<T>): Promise<T> => {
    deadline ??= Date.now() + budget.durationMs
    return withReadBudget(runSignal, Math.max(0, deadline - Date.now()), Infinity, control => read({
      ...control,
      beforeRequest: () => {
        control.beforeRequest!()
        if (requests >= budget.maxRequests) throw new ReadBudgetError("The configuration request budget was reached. This type was not fully read.")
        requests++
      },
    }), new ReadBudgetError("The configuration time budget was reached. This type was not fully read."))
  }
}
