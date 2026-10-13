import { FetchApplicationError } from "../api/network-error"

export const GRAPH = "https://graph.microsoft.com"
/** Far above any real listing; stops a storage service that keeps returning continuation markers. */
export const MAX_LIST_PAGES = 10_000
export const REQUEST_TIMEOUT_MS = 90_000
export const REQUEST_ATTEMPTS = 3
export const MAX_RETRY_DELAY_MS = 5 * 60_000

/**
 * The storage provider refused a delete because the blob is protected by an immutability
 * policy or a legal hold (for example 409 BlobImmutableDueToPolicy or
 * BlobImmutableDueToLegalHold). Retention treats the backup as protected and kept; it never
 * tries to weaken the policy or remove the hold.
 */
export class ProtectedBlobError extends Error {
  constructor(readonly code: string) {
    super(`The storage provider protects this backup (${code}).`)
    this.name = "ProtectedBlobError"
  }
}

/** Whether a rejected delete is an immutability or legal hold refusal rather than an access or network problem. */
export function isImmutabilityRefusal(status: number, code: string): boolean {
  return (status === 409 || status === 403) && /immutab|legalhold/i.test(code)
}


/** Sign-in or license problems affect every request, so they stop the backup instead of becoming per-policy warnings. */
export class TokenError extends Error {}

/** A Graph error with its status, so an expired sign-in (401) stops the backup while a missing permission for one type does not. */
export class GraphError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** Another reader extended the shared pause while this reader acquired its token. */
export class GraphPauseError extends Error {}

export class StorageError extends Error {}
/** The create-only claim for a backup folder found the marker already there. */
export class BlobClaimError extends StorageError {}

export class RetryableStorageError extends Error {}
export class RequestTimeoutError extends Error {}

/** Only a fully read HTTP error is a status failure; failed body reads are network failures. */
export function requestFailure(error: unknown): "network" | "status" | "token" | "other" {
  if (error instanceof TokenError) return "token"
  if (error instanceof GraphError || error instanceof StorageError || error instanceof RetryableStorageError || error instanceof ProtectedBlobError) return "status"
  if (error instanceof SyntaxError || error instanceof GraphPauseError || error instanceof FetchApplicationError) return "other"
  return "network"
}

/** Bound the whole request, including token acquisition and response reads, even for a fetch bridge that ignores aborts. */
export async function withRequestTimeout<T>(request: (signal: AbortSignal) => Promise<T>, ...signals: Array<AbortSignal | undefined>): Promise<T> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new RequestTimeoutError("Backup request timed out after 90 seconds. Check your connection and retry.")), REQUEST_TIMEOUT_MS)
  timer.unref?.()
  const signal = AbortSignal.any([timeout.signal, ...signals.filter((value): value is AbortSignal => value !== undefined)])
  try {
    return await withAbort(() => request(signal), signal)
  } finally {
    clearTimeout(timer)
  }
}

export async function withAbort<T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: () => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([request(), aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

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

export async function graphError(response: Response): Promise<string> {
  const text = await response.text()
  try {
    const message = (JSON.parse(text) as { error?: { message?: string } }).error?.message
    if (response.status === 403) {
      return `Access denied by Microsoft Graph${message ? `: ${message}` : ""}. Check that your account has an Intune role and the app registration has the Intune permissions.`
    }
    return message ?? `Microsoft Graph returned ${response.status}`
  } catch {
    return `Microsoft Graph returned ${response.status}`
  }
}

export async function storageError(response: Response, account: string): Promise<string> {
  if (response.status === 0 || response.type === "error") return `Storage account ${account} could not be reached.`
  const text = await response.text()
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? response.headers.get("x-ms-error-code") ?? ""
  // AuthorizationFailure is the storage firewall or network rules rejecting this computer, not a missing role.
  if (code === "AuthorizationFailure") {
    return `Storage account ${account} rejected the request from this network. Allow this computer's public IP address in the storage account's networking settings, or connect through a network it allows.`
  }
  if (response.status === 403 || code.startsWith("Authorization")) {
    return `You do not have write access to storage account ${account}. Ask an Azure administrator for the "Storage Blob Data Contributor" role on it. New role assignments can take a few minutes to apply.`
  }
  const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1]
  return `Storage account ${account} returned ${response.status}${code ? ` (${code})` : ""}${message ? `: ${message.split("\n")[0]}` : ""}`
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
