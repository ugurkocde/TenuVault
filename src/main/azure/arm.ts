/**
 * Azure Resource Manager from the main process, with the signed-in admin's delegated token.
 * The token only ever goes to management.azure.com: a request names a path under
 * /subscriptions or /providers, never a URL, so nothing a caller or a response contains can
 * aim it at another host. Request bodies are never logged; they can hold deployment secrets.
 */

export interface ArmRequest {
  method: "GET" | "PUT" | "POST" | "DELETE"
  /** A path with its query string, starting with /subscriptions/ or /providers/. */
  path: string
  body?: unknown
  signal?: AbortSignal
}

export interface ArmResponse {
  status: number
  body: unknown
  retryAfterSeconds: number | null
}

export type ArmCaller = (request: ArmRequest) => Promise<ArmResponse>

const ARM_ORIGIN = "https://management.azure.com"
const RETRYABLE = new Set([429, 502, 503, 504])
const MAX_ATTEMPTS = 3

function armUrl(path: string): string {
  if (typeof path !== "string" || path.length > 4000 || path.includes("\\") || path.includes("#")) throw new Error("That is not an Azure Resource Manager path.")
  if (!path.startsWith("/subscriptions/") && !path.startsWith("/providers/")) throw new Error("That is not an Azure Resource Manager path.")
  const url = new URL(path, ARM_ORIGIN)
  if (url.origin !== ARM_ORIGIN || url.username || url.password) throw new Error("That is not an Azure Resource Manager path.")
  return url.toString()
}

function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("retry-after")
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds)
  const at = Date.parse(raw)
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - Date.now()) / 1000))
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "")
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { message: text.slice(0, 300) }
  }
}

/** The one-line reason ARM gives for a failed call, without anything the request carried. */
export function armErrorMessage(body: unknown, status: number): string {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null
  const error = record?.error && typeof record.error === "object" ? record.error as Record<string, unknown> : null
  const details = Array.isArray(error?.details) ? error.details as Array<Record<string, unknown>> : []
  const detail = details.find((entry) => typeof entry?.message === "string")?.message
  const message = [error?.message, detail, record?.message].find((value): value is string => typeof value === "string" && value.trim().length > 0)
  return (message ?? `Azure answered HTTP ${status}.`).replace(/\s+/g, " ").trim().slice(0, 300)
}

export interface ArmCallerOptions {
  getToken: () => Promise<string>
  fetch: typeof globalThis.fetch
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
}

/**
 * A caller for one tenant. Reads retry throttling as ARM asks; writes never retry, because
 * a write whose answer was lost may have landed, and the caller re-reads state instead.
 */
export function createArmCaller(options: ArmCallerOptions): ArmCaller {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const timeoutMs = options.timeoutMs ?? 15_000
  return async (request) => {
    const url = armUrl(request.path)
    let last: ArmResponse | null = null
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const token = await options.getToken()
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
      const response = await options.fetch(url, {
        method: request.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        signal,
      })
      last = { status: response.status, body: await readBody(response), retryAfterSeconds: retryAfterSeconds(response.headers) }
      const mayRetry = request.method === "GET" && RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS - 1
      if (!mayRetry) return last
      await sleep(Math.min(last.retryAfterSeconds ?? 2, 10) * 1000)
    }
    return last!
  }
}
