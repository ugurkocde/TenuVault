import { AsyncLocalStorage } from "node:async_hooks"
import { authenticatedBackupRead, backupReadKeyFingerprint, wasBackupReadAuthenticated } from "../storage/authenticated-read"
import { FetchApplicationError } from "../api/network-error"
import { REQUEST_ATTEMPTS } from "./request"

export interface RetentionLimits { candidates: number; requests: number; bytes: number }
export const RETENTION_LIMITS: RetentionLimits = { candidates: 32, requests: 100_000, bytes: 512 * 1024 * 1024 }

export class RetentionBudgetError extends FetchApplicationError {
  constructor() { super(new Error("The retention review reached its storage budget.")) }
}

const active = new AsyncLocalStorage<{ budget: RetentionBudget; metered: boolean }>()

/** Charge sealed wire bytes before the compatibility reader buffers or decrypts them. */
export function meterLegacyBackupResponse(response: Response): Response {
  const context = active.getStore()
  if (!context) return response
  context.metered = true
  return context.budget.meter(response)
}

export class RetentionBudget {
  private requests = 0
  private reserved = 0
  private bytes = 0
  private inCleanup = false

  constructor(readonly limits: RetentionLimits) {}

  get exhausted(): boolean {
    return this.bytes >= this.limits.bytes || this.requests + this.reserved >= this.limits.requests
  }

  async withCleanup<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.inCleanup
    this.inCleanup = true
    try {
      return await run()
    } finally {
      this.inCleanup = previous
    }
  }

  reserveDeletes(count: number): void {
    const reserve = count * REQUEST_ATTEMPTS
    if (this.requests + this.reserved + reserve > this.limits.requests) throw new RetentionBudgetError()
    this.reserved += reserve
  }

  dispatch(deleting: boolean): void {
    const reserved = deleting || this.inCleanup
    if (this.requests + (reserved ? 0 : this.reserved) >= this.limits.requests) throw new RetentionBudgetError()
    this.requests++
    if (reserved) this.reserved = Math.max(0, this.reserved - 1)
  }

  async fetch(send: () => Promise<Response>): Promise<Response> {
    const context = { budget: this, metered: false }
    const response = await active.run(context, send)
    return context.metered ? response : this.meter(response)
  }

  meter(response: Response): Response {
    if (!response.body) return response
    const declared = Number(response.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > this.limits.bytes - this.bytes) {
      void response.body.cancel().catch(() => undefined)
      throw new RetentionBudgetError()
    }
    const reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        const { value, done } = await reader.read()
        if (done) { controller.close(); return }
        this.bytes += value.byteLength
        if (this.bytes > this.limits.bytes) {
          controller.error(new RetentionBudgetError())
          await reader.cancel().catch(() => undefined)
          return
        }
        controller.enqueue(value)
      },
      cancel: reason => reader.cancel(reason),
    }, { highWaterMark: 0 })
    const metered = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    return wasBackupReadAuthenticated(response) ? authenticatedBackupRead(metered, backupReadKeyFingerprint(response)) : metered
  }
}
