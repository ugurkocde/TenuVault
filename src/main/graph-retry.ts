/**
 * One bounded retry delay for Microsoft Graph and storage reads.
 *
 * Honors the server-provided Retry-After (seconds or HTTP date, plus the Azure
 * x-ms-retry-after-ms header) and never shortens it: a delay beyond the bound
 * fails instead of retrying early. Without a usable server delay the fallback
 * backs off exponentially from the attempt number.
 */
export const MAX_RETRY_DELAY_MS = 5 * 60_000

export const retryableStatus = (status: number) => status === 429 || status >= 500

export function retryDelay(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get("retry-after")
  const seconds = Number(header)
  const azureDelay = Number(response?.headers.get("x-ms-retry-after-ms"))
  // Check units before conversion, including positive values that overflow to Infinity.
  if (seconds > MAX_RETRY_DELAY_MS / 1000 || azureDelay > MAX_RETRY_DELAY_MS) {
    throw new Error("The service requested a retry delay longer than 5 minutes. Retry this backup later.")
  }
  const retryAfter = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : 0
  const delay = Math.max(Number.isFinite(retryAfter) ? retryAfter : 0, Number.isFinite(azureDelay) ? azureDelay : 0)
  // Never shorten a server's pause. A longer interval fails this bounded request instead.
  if (delay > MAX_RETRY_DELAY_MS) throw new Error("The service requested a retry delay longer than 5 minutes. Retry this backup later.")
  return delay > 0 ? delay : 1000 * 2 ** attempt
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
