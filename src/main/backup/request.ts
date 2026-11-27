import type { GrantedPermissions } from "../../shared/services/modules"
import { LARGE_STORAGE_UNAVAILABLE } from "../../shared/backup-storage"
import { FetchApplicationError, NetworkUnreachableError } from "../api/network-error"
import { isLocalAccount } from "../storage/blob-emulator"

export const GRAPH = "https://graph.microsoft.com"
/** Far above any real listing; stops a storage service that keeps returning continuation markers. */
export const MAX_LIST_PAGES = 10_000
export const REQUEST_TIMEOUT_MS = 90_000
export const REQUEST_ATTEMPTS = 3

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

/** The error code and message of a refused Microsoft Graph request, as far as its body gives them. */
export interface GraphAnswer {
  code?: string
  message?: string
}

/**
 * A Graph error with its status, so an expired sign-in (401) stops the backup while a missing permission for one type does not.
 * `answer` keeps what Graph said, for telling a missing permission from a missing license or a setting that was never made.
 */
export class GraphError extends Error {
  continuationPage?: true

  constructor(message: string, readonly status: number, readonly answer: GraphAnswer = {}, readonly grant?: GrantedPermissions) {
    super(message)
  }
}

/** Another reader extended the shared pause while this reader acquired its token. */
export class GraphPauseError extends Error {}

/**
 * A request of a service that isolates its failures got no answer from Microsoft Graph in any of
 * its attempts, or was not sent because the service had stopped answering. It ends the type it
 * belongs to, never the backup; `cause` is the connection failure.
 */
export class GraphUnansweredError extends Error {}

export class StorageError extends Error {}
class StorageResponseError extends StorageError {
  constructor(message: string, readonly code: string | undefined) { super(message) }
}
/** A write that an immutability policy or legal hold refused, with the provider's error code. */
export class ImmutableBlobError extends StorageError {
  constructor(readonly code: string, message: string) { super(message) }
}
export class LargeStorageError extends StorageError {
  constructor(readonly status?: number, options?: ErrorOptions) {
    const cause = options?.cause
    const hasSpecificGuidance = cause instanceof StorageResponseError &&
      ((status === 403 && cause.code === "AuthenticationFailed") || (status === 404 && cause.code === "BlobNotFound"))
    super(hasSpecificGuidance ? cause.message : `${LARGE_STORAGE_UNAVAILABLE}${status ? ` Storage returned ${status}.` : ""}`, options)
  }
}
/**
 * Local storage refused because files in the backup folder are damaged: a backup that is
 * unavailable, or a delete while damage is present. The message says what and how to recover.
 */
export class InventoryDamagedError extends StorageError {}

/** The error for a failed storage response, keeping the local store's damage refusals apart. */
export async function storageFailure(response: Response, account: string): Promise<StorageError> {
  const code = response.headers.get("x-ms-error-code")
  if (isLocalAccount(account) && (code === "InventoryIncomplete" || code === "BackupUnavailable" || code === "BlobQuarantined"
    || code === "LeaseAlreadyPresent" || code === "LeaseUnavailable" || code === "RetentionLockLost" || code === "BackupProtectedByRetention")) {
    const text = await response.text()
    const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1]
    if (message || code === "InventoryIncomplete" || code === "BackupUnavailable" || code === "BlobQuarantined") {
      const decoded = (message ?? "Files in the backup folder could not be read.").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
      return code === "InventoryIncomplete" || code === "BackupUnavailable" ? new InventoryDamagedError(decoded) : new StorageError(decoded)
    }
    return storageError(new Response(text, { status: response.status, headers: response.headers }), account)
  }
  return storageError(response, account)
}
/** The create-only claim for a backup folder found the marker already there. */
export class BlobClaimError extends StorageError {}
/** The storage request ended with a network error response (status 0) instead of an HTTP status. */
export class StorageUnreachableError extends StorageError {}

export class RetryableStorageError extends Error {}
export class RequestTimeoutError extends Error {}

/** The verified blob changed before its conditional delete reached storage. */
export class DeleteConditionError extends FetchApplicationError {}

/** MSAL rethrows a token or discovery request that got no HTTP response with this code; it keeps only the original message. */
const MSAL_NETWORK_ERROR = "network_error"

/**
 * Whether a backup failed because Microsoft or the storage account could not be reached, including
 * timeouts, rather than because of the tenant, the sign-in or the storage. Follows `cause`, because
 * sign-in and circuit errors wrap the request failure that caused them.
 */
export function isUnreachable(error: unknown): boolean {
  for (let depth = 0; depth < 8 && error instanceof Error; depth++) {
    if (error instanceof NetworkUnreachableError || error instanceof RequestTimeoutError || error instanceof StorageUnreachableError) return true
    if (error.name === "TimeoutError" || (error as { errorCode?: unknown }).errorCode === MSAL_NETWORK_ERROR) return true
    error = error.cause
  }
  return false
}

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

/** A fixed message by status. Graph's own error text stays out of messages and logs; graphAnswer keeps it for classification. */
function graphErrorMessage(status: number): string {
  if (status === 403) return "Access denied by Microsoft Graph (HTTP 403). Check that your account has an Intune role and the app registration has the Intune permissions."
  if (status === 401) return "Microsoft Graph authentication failed (HTTP 401)."
  if (status === 429) return "Microsoft Graph throttled the request (HTTP 429)."
  return `Microsoft Graph request failed (HTTP ${status}).`
}

/**
 * What a refused request's body says. Most of Graph answers `{ error: { code, message } }`; the role
 * management endpoints answer `{ errorCode, message }`; some answer an HTML page or nothing at all,
 * which reads as no code and no message.
 */
export function graphAnswer(text: string): GraphAnswer {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return {}
  }
  if (!body || typeof body !== "object") return {}
  const { error, errorCode, message } = body as { error?: unknown; errorCode?: unknown; message?: unknown }
  const source = error && typeof error === "object" ? (error as { code?: unknown; message?: unknown }) : { code: errorCode, message }
  return {
    ...(typeof source.code === "string" && source.code ? { code: source.code } : {}),
    ...(typeof source.message === "string" && source.message ? { message: source.message } : {}),
  }
}

/** The error of a failed Graph response, with its message as before and what Graph answered. */
export async function graphFailure(response: Response, grant?: GrantedPermissions, grantUnknown = false): Promise<GraphError> {
  const text = await response.text()
  const message = response.status === 403 && grantUnknown
    ? "Microsoft Graph refused this read (HTTP 403). TenuVault could not verify the permissions for this request."
    : graphErrorMessage(response.status)
  return new GraphError(message, response.status, graphAnswer(text), grant)
}

/** Provider code fields can contain free text too. Keep only short error identifiers. */
export function providerErrorCode(code: string | undefined): string | undefined {
  return code && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) ? code : undefined
}

export function providerStatus(status: number, code: string | undefined): string {
  return `HTTP ${status}${code ? `, ${code}` : ""}`
}

/** A failed storage response. A network error response rejects with a StorageUnreachableError instead. */
export async function storageError(response: Response, account: string): Promise<StorageError> {
  if (response.status === 0 || response.type === "error") throw new StorageUnreachableError(`Storage account ${account} could not be reached.`)
  const text = await response.text()
  const code = providerErrorCode(/<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? response.headers.get("x-ms-error-code") ?? undefined)
  const detail = providerStatus(response.status, code)
  if (response.status === 403 && code === "AuthenticationFailed") {
    return new StorageResponseError(`Storage account ${account} refused authentication (${detail}). Sign in again to this tenant.`, code)
  }
  if (response.status === 404 && code === "BlobNotFound") {
    return new StorageResponseError(`Storage account ${account} could not find the backup blob (${detail}). Check the configured container or backup location.`, code)
  }
  // AuthorizationFailure is the storage firewall or network rules rejecting this computer, not a missing role.
  if (code === "AuthorizationFailure") {
    return new StorageResponseError(`Storage account ${account} rejected the request from this network (${detail}). Allow this computer's public IP address in the storage account's networking settings, or connect through a network it allows.`, code)
  }
  if (response.status === 403 || code?.startsWith("Authorization")) {
    return new StorageResponseError(`You do not have write access to storage account ${account} (${detail}). Ask an Azure administrator for the "Storage Blob Data Contributor" role on it. New role assignments can take a few minutes to apply.`, code)
  }
  return new StorageResponseError(`Storage account ${account} rejected the backup request (${detail}). Check that the backup storage is available and retry.`, code)
}
