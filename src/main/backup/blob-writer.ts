import { backupBlobName, backupContainer, backupStoragePath, LARGE_BACKUP_CONTAINER, logicalBackupName } from "../../shared/backup-storage"
import { assertStorageAccountName } from "../../shared/storage-account"
import { BACKUP_CONTAINER, MAX_BACKUP_ARCHIVE_BYTES } from "../../shared/constants"
import { backupReadKeyFingerprint, wasBackupReadAuthenticated } from "../storage/authenticated-read"
import { isLocalAccount } from "../storage/blob-emulator"
import { releaseLocalRetentionGuard, type ExpectedReplacement } from "../storage/local-blob-store"
import { createHash, randomUUID } from "node:crypto"
import { readBytesCapped, readJsonCapped } from "../../shared/capped-body"
import { oversizedOwnershipFile } from "../../shared/backup-ownership"
import { retryDelay, retryableStatus, sleep } from "../graph-retry"
import { FetchApplicationError } from "../api/network-error"
import type { RetentionBudget } from "./retention-budget"
import type { NetworkCircuit } from "./engine"
import { MAX_LIST_PAGES, REQUEST_ATTEMPTS, BlobClaimError, DeleteConditionError, ImmutableBlobError, InventoryDamagedError, ProtectedBlobError, RequestTimeoutError, RetryableStorageError, StorageError, LargeStorageError, TokenError, isImmutabilityRefusal, requestFailure, storageError, storageFailure, withAbort, withRequestTimeout } from "./request"

const LEASE_RELEASE_TIMEOUT_MS = 15_000
const deleteConfirmedUnchanged = new WeakSet<object>()

/** Whether a failed BlobWriter.delete call confirmed that storage did not move or remove the blob. */
export function wasDeleteConfirmedUnchanged(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && deleteConfirmedUnchanged.has(error))
}

export type { ExpectedReplacement }

/** A replacement backup changed before cleanup completed or before a quarantined local delete could be finalized. */
export class ReplacementChangedError extends FetchApplicationError {
  constructor(cause: unknown) {
    super(cause)
    this.name = "ReplacementChangedError"
  }
}

/** Lease acquisition or renewal failed (conflict, missing permission, or storage error). */
export class BlobLeaseError extends FetchApplicationError {
  constructor(
    cause: unknown,
    readonly status?: number,
    readonly code?: string,
    readonly lockPath?: string,
    readonly lockHolder?: string,
  ) {
    super(cause)
    this.name = "BlobLeaseError"
  }
}

function decodeHeaderValue(value: string | null): string | undefined {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export interface RetentionBlob { value: unknown; etag: string; authenticated: boolean; keyFingerprint?: string; sha256: string }

export interface BlobListing {
  blobs: string[]
  prefixes: string[]
  sizes: Map<string, number>
  etags: Map<string, string>
}

/** Writes blobs to Azure or, for local accounts, to the encrypted store via the fetch bridge. */
export class BlobWriter {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly account: string,
    private readonly token: () => Promise<string>,
    private readonly network?: NetworkCircuit,
    private readonly budget?: RetentionBudget,
  ) {
    assertStorageAccountName(account)
  }

  withBudget(budget: RetentionBudget): BlobWriter {
    return new BlobWriter(this.fetchImpl, this.account, this.token, this.network, budget)
  }

  private withoutBudget(): BlobWriter {
    return new BlobWriter(this.fetchImpl, this.account, this.token, this.network)
  }

  async ensureContainer(container = BACKUP_CONTAINER): Promise<void> {
    await this.request(`${container}?restype=container`, { method: "PUT" }, async (response) => {
      if (response.ok || response.status === 409) return
      throw await storageError(response, this.account)
    })
  }

  /**
   * `onDispatch` runs right before each PUT is sent, after its token and cancellation checks.
   * A create-only body must be unique to its writer (the engine includes the run id), so a retry
   * that finds identical bytes knows its own earlier attempt created the blob.
   */
  async put(name: string, body: string, beforeCommit?: NetworkCircuit, createOnly = false, onDispatch?: () => void, signal?: AbortSignal, onUnconfirmed?: () => void): Promise<void> {
    const path = backupStoragePath(name)
    // The earlier PUT may have landed. Read it back and compare it with what this writer sent.
    const landed = async (response: Response, signal: AbortSignal) => {
      const stored = await this.request(path, { method: "GET", signal }, async (readBack) => {
        if (!readBack.ok) throw await storageError(readBack, this.account)
        return readBack.text()
      })
      if (stored !== body) return false
      void response.body?.cancel().catch(() => undefined)
      return true
    }
    await this.request(path, {
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob", "content-type": "application/json", ...(createOnly ? { "if-none-match": "*" } : {}) },
      body,
      ...(signal ? { signal } : {}),
    }, async (response, signal, ambiguous) => {
      if (response.ok) return
      if (createOnly && (response.status === 412 || response.headers.get("x-ms-error-code") === "BlobAlreadyExists")) {
        // The conditional create was refused because the blob already exists. On a first attempt it
        // belongs to someone else. On a retry it may be this writer's own earlier attempt whose
        // response was lost; only identical bytes, which hold this run's id, count as ours.
        if (ambiguous && await landed(response, signal)) return
        void response.body?.cancel().catch(() => undefined)
        throw new BlobClaimError(`Blob already exists: ${name}`)
      }
      if (ambiguous && (response.status === 409 || response.status === 412
        || isImmutabilityRefusal(response.status, response.headers.get("x-ms-error-code") ?? ""))) {
        if (await landed(response, signal)) return
      }
      // A refusal by an immutability policy or legal hold keeps the provider's code, so a caller can tell
      // it from a permission refusal.
      const headerCode = response.headers.get("x-ms-error-code") ?? ""
      const bodyCode = isImmutabilityRefusal(response.status, headerCode) ? headerCode : /<Code>([^<]+)<\/Code>/.exec(await response.clone().text())?.[1] ?? ""
      const error = await storageError(response, this.account)
      if (isImmutabilityRefusal(response.status, bodyCode)) throw new ImmutableBlobError(bodyCode, error.message)
      throw error
    }, beforeCommit, onDispatch, onUnconfirmed)
  }

  /** Lists blob names and, with a delimiter, virtual folders under a prefix. */
  async list(prefix: string, delimiter = "", container = backupContainer(prefix), physicalPrefix = false): Promise<BlobListing> {
    const blobs: string[] = []
    const sizes = new Map<string, number>()
    const etags = new Map<string, string>()
    const prefixes: string[] = []
    let marker = ""
    const seen = new Set<string>()
    do {
      if (seen.size >= MAX_LIST_PAGES) throw new Error(`Storage listing did not finish after ${MAX_LIST_PAGES} pages`)
      const query = new URLSearchParams({ restype: "container", comp: "list", prefix: physicalPrefix ? prefix : backupBlobName(prefix), ...(delimiter ? { delimiter } : {}), ...(marker ? { marker } : {}) })
      const xml = await this.request(`${container}?${query.toString()}`, { method: "GET" }, async (response) => {
        if (response.status === 404) return null
        if (!response.ok) throw await storageFailure(response, this.account)
        return response.text()
      })
      if (xml === null) break
      const decode = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
      for (const m of xml.matchAll(/<BlobPrefix><Name>([^<]*)<\/Name><\/BlobPrefix>/g)) prefixes.push(logicalBackupName(decode(m[1]!)))
      for (const m of xml.matchAll(/<Blob><Name>([^<]*)<\/Name>([\s\S]*?)<\/Blob>/g)) {
        const name = logicalBackupName(decode(m[1]!))
        const properties = m[2]!
        blobs.push(name)
        const size = /<Content-Length>(\d+)<\/Content-Length>/.exec(properties)?.[1]
        if (size !== undefined) sizes.set(name, Number(size))
        const raw = /<Etag>([^<]+)<\/Etag>/i.exec(properties)?.[1]
        if (raw) {
          const etag = decode(raw)
          if (etag !== "*") etags.set(name, etag.startsWith('"') ? etag : `"${etag}"`)
        }
      }
      // The marker is XML-escaped like the names; send back the name it stands for.
      marker = decode(/<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1] ?? "")
      if (marker && seen.has(marker)) throw new Error("Storage returned a repeated continuation marker")
      seen.add(marker)
    } while (marker)
    return { blobs, prefixes, sizes, etags }
  }

  /** Root records and payload together, for deletion after ownership has been checked. */
  async listFolder(prefix: string): Promise<BlobListing> {
    const payload = await this.list(prefix)
    if (backupContainer(prefix) !== LARGE_BACKUP_CONTAINER) return payload
    const roots = await this.list(prefix, "", LARGE_BACKUP_CONTAINER, true)
    return {
      blobs: [...roots.blobs, ...payload.blobs],
      prefixes: [],
      sizes: new Map([...roots.sizes, ...payload.sizes]),
      etags: new Map([...roots.etags, ...payload.etags]),
    }
  }

  /**
   * A JSON object blob, or null when it does not exist. A blob that exists but is not a JSON object
   * (damaged, or written by something else) throws a FetchApplicationError: it is unreadable, never
   * the same as a missing blob, so retention keeps it and counts the container as shared.
   */
  async readJson(name: string): Promise<Record<string, unknown> | null> {
    return this.request(backupStoragePath(name), { method: "GET" }, async (response) => {
      if (response.status === 404) return null
      if (!response.ok) throw await storageFailure(response, this.account)
      // Capped like every other backup read; an oversized file is unreadable, never buffered whole.
      const body = await readJsonCapped(response, MAX_BACKUP_ARCHIVE_BYTES)
      if (body.kind === "oversized") throw new FetchApplicationError(new Error(oversizedOwnershipFile(name.split("/").pop() ?? name)))
      if (body.kind === "invalid") throw new FetchApplicationError(new Error(`${name.split("/").pop()} is not valid JSON`))
      const value = body.value
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new FetchApplicationError(new Error(`${name.split("/").pop()} is not a JSON object`))
      return value as Record<string, unknown>
    })
  }

  /** Retain the identity and the authentication evidence from the same read. */
  async readForRetention(name: string): Promise<RetentionBlob> {
    return this.request(backupStoragePath(name), { method: "GET" }, async (response) => {
      if (!response.ok) throw await storageFailure(response, this.account)
      const bytes = await readBytesCapped(response, MAX_BACKUP_ARCHIVE_BYTES)
      const etag = response.headers.get("etag")
      if (!bytes || !etag || etag === "*") throw new FetchApplicationError(new Error(`${name} could not be verified for retention.`))
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        if (!value || typeof value !== "object") throw new Error("Expected JSON data")
        return { value, etag, authenticated: wasBackupReadAuthenticated(response), keyFingerprint: backupReadKeyFingerprint(response), sha256: createHash("sha256").update(bytes).digest("hex") }
      } catch (error) {
        throw new FetchApplicationError(new Error(`${name} could not be verified for retention.`, { cause: error }))
      }
    })
  }

  /** Reads only the current ETag identity of a blob, or null if it no longer exists. */
  async headETag(name: string): Promise<string | null> {
    return this.request(backupStoragePath(name), { method: "HEAD" }, async (response) => {
      if (response.status === 404) return null
      if (!response.ok) throw await storageFailure(response, this.account)
      const etag = response.headers.get("etag")
      return etag && etag !== "*" ? etag : null
    })
  }

  /** Acquires a finite lease on a blob (Azure) without modifying its content. */
  async acquireLease(name: string, durationSeconds = 60): Promise<string> {
    return this.acquireLeaseAt(`${backupStoragePath(name)}?comp=lease`, durationSeconds)
  }

  /** Renews an active blob lease outside the retention request budget. */
  async renewLease(name: string, leaseId: string, signal?: AbortSignal): Promise<void> {
    await this.withoutBudget().renewLeaseAt(`${backupStoragePath(name)}?comp=lease`, leaseId, undefined, signal)
  }

  /** Releases a blob lease outside the retention budget and aborted job circuit. Throws on HTTP 5xx; callers catch it, and an unreleased lease expires on its own. */
  async releaseLease(name: string, leaseId: string, signal?: AbortSignal): Promise<void> {
    await this.releaseLeaseAt(`${backupStoragePath(name)}?comp=lease`, leaseId, signal)
  }

  /** Acquires the local cross-process retention lock file and registers protected replacement prefixes in-process. */
  async acquireContainerLease(container = BACKUP_CONTAINER, protectedPrefixes?: string[]): Promise<string> {
    const headers = protectedPrefixes?.length
      ? { "x-tenuvault-protected-prefixes": JSON.stringify(protectedPrefixes) }
      : undefined
    return this.acquireLeaseAt(`${container}?restype=container&comp=lease`, undefined, headers)
  }

  /** Best-effort release of a container lock; retries once and always clears the local in-process guard. */
  async releaseContainerLease(leaseId: string, container = BACKUP_CONTAINER, signal?: AbortSignal): Promise<string | undefined> {
    const path = `${container}?restype=container&comp=lease`
    try {
      try {
        return await this.releaseLeaseAt(path, leaseId, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        return await this.releaseLeaseAt(path, leaseId, signal)
      }
    } finally {
      if (isLocalAccount(this.account)) releaseLocalRetentionGuard(leaseId)
    }
  }

  private async leaseResponseCode(response: Response): Promise<string | undefined> {
    const header = response.headers.get("x-ms-error-code") ?? undefined
    if (header) return header
    const text = await response.clone().text().catch(() => "")
    return /<Code>([^<]+)<\/Code>/.exec(text)?.[1]
  }

  private async acquireLeaseAt(path: string, durationSeconds?: number, extraHeaders?: Record<string, string>): Promise<string> {
    const proposedId = randomUUID()
    try {
      return await this.request(path, {
        method: "PUT",
        headers: {
          "x-ms-lease-action": "acquire",
          ...(durationSeconds !== undefined ? { "x-ms-lease-duration": String(durationSeconds) } : {}),
          "x-ms-proposed-lease-id": proposedId,
          ...extraHeaders,
        },
      }, async (response, signal, ambiguous) => {
        if (response.ok) {
          const leaseId = response.headers.get("x-ms-lease-id") || proposedId
          void response.body?.cancel().catch(() => undefined)
          if (signal.aborted) {
            await this.releaseLeaseAt(path, leaseId).catch(() => undefined)
            signal.throwIfAborted()
          }
          return leaseId
        }
        if (ambiguous && response.status === 409) {
          await this.releaseLeaseAt(path, proposedId).catch(() => undefined)
        }
        const code = await this.leaseResponseCode(response)
        const lockPath = decodeHeaderValue(response.headers.get("x-tenuvault-lock-path"))
        const lockHolder = decodeHeaderValue(response.headers.get("x-tenuvault-lock-holder"))
        throw new BlobLeaseError(await storageFailure(response, this.account), response.status, code, lockPath, lockHolder)
      })
    } catch (error) {
      if (isLocalAccount(this.account)) releaseLocalRetentionGuard(proposedId)
      if (this.network?.signal.aborted) throw error
      if (error instanceof BlobLeaseError) throw error
      throw new BlobLeaseError(error)
    }
  }

  private async renewLeaseAt(path: string, leaseId: string, durationSeconds?: number, signal?: AbortSignal): Promise<void> {
    try {
      await this.request(path, {
        method: "PUT",
        ...(signal ? { signal } : {}),
        headers: {
          "x-ms-lease-action": "renew",
          "x-ms-lease-id": leaseId,
          ...(durationSeconds !== undefined ? { "x-ms-lease-duration": String(durationSeconds) } : {}),
        },
      }, async (response) => {
        if (response.ok) {
          void response.body?.cancel().catch(() => undefined)
          return
        }
        const code = await this.leaseResponseCode(response)
        throw new BlobLeaseError(await storageFailure(response, this.account), response.status, code)
      })
    } catch (error) {
      if (this.network?.signal.aborted || signal?.aborted) throw error
      if (error instanceof BlobLeaseError) throw error
      throw new BlobLeaseError(error)
    }
  }

  private async releaseLeaseAt(path: string, leaseId: string, signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new RequestTimeoutError("Lease release timed out.")), LEASE_RELEASE_TIMEOUT_MS)
    timer.unref?.()
    const effective = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    try {
      const pendingToken = this.token()
      void pendingToken.catch(() => undefined)
      const token = await withAbort(() => pendingToken, effective)
      const pendingFetch = this.fetchImpl(`https://${this.account}.blob.core.windows.net/${path}`, {
        method: "PUT",
        ...(this.budget ? { redirect: "error" as const } : {}),
        signal: effective,
        headers: {
          "x-ms-lease-action": "release",
          "x-ms-lease-id": leaseId,
          "x-ms-version": "2021-12-02",
          "x-ms-date": new Date().toUTCString(),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      void pendingFetch.catch(() => undefined)
      const response = await withAbort(() => pendingFetch, effective)
      if (response.status >= 500) {
        void response.body?.cancel().catch(() => undefined)
        throw new StorageError(`Lease release failed with HTTP ${response.status}.`)
      }
      const warning = decodeHeaderValue(response.headers.get("x-tenuvault-lock-warning"))
      void response.body?.cancel().catch(() => undefined)
      return warning
    } finally {
      clearTimeout(timer)
    }
  }

  async delete(name: string, etag?: string, retentionLockId?: string, expectedReplacements?: readonly ExpectedReplacement[]): Promise<void> {
    let dispatched = false
    let confirmedUnchanged = false
    try {
      const headers: Record<string, string> = {}
      if (etag) headers["if-match"] = etag
      if (retentionLockId) headers["x-tenuvault-retention-lock-id"] = retentionLockId
      const sendReplacements = isLocalAccount(this.account) && Boolean(expectedReplacements?.length)
      if (sendReplacements) {
        headers["x-tenuvault-expected-replacements"] = "1"
        headers["content-type"] = "application/json"
      }
      await this.request(backupStoragePath(name), {
        method: "DELETE",
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(sendReplacements ? { body: JSON.stringify(expectedReplacements) } : {}),
      }, async (response, _signal, ambiguous) => {
        if (!response.ok && response.status !== 404) {
          const code = response.headers.get("x-ms-error-code") ?? ""
          const local = isLocalAccount(this.account)
          const unchangedHeader = response.headers.get("x-tenuvault-delete-unchanged") === "1"
          if (code === "ReplacementChanged") {
            if (!ambiguous && (!local || unchangedHeader)) confirmedUnchanged = true
            const body = await response.clone().text().catch(() => "")
            const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1]
              ?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
            throw new ReplacementChangedError(message ? new Error(message) : await storageFailure(response, this.account))
          }
          if (code === "RetentionLockLost") {
            if (!ambiguous && (!local || unchangedHeader)) confirmedUnchanged = true
            throw new BlobLeaseError(await storageFailure(response, this.account), response.status, code)
          }
          if (isImmutabilityRefusal(response.status, code)) {
            if (!ambiguous && (!local || unchangedHeader)) confirmedUnchanged = true
            throw new ProtectedBlobError(code)
          }
          if (response.status === 412 && code !== "BlobQuarantined") {
            if (!ambiguous && (!local || unchangedHeader)) confirmedUnchanged = true
            void response.body?.cancel().catch(() => undefined)
            throw new DeleteConditionError(new Error(`${name} changed before it could be deleted.`))
          }
          const text = await response.clone().text()
          const bodyCode = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? ""
          if (bodyCode === "ReplacementChanged") {
            if (!ambiguous && (!local || unchangedHeader)) confirmedUnchanged = true
            throw new ReplacementChangedError(await storageFailure(response, this.account))
          }
          if (bodyCode === "RetentionLockLost") {
            if (!ambiguous && (!local || unchangedHeader)) confirmedUnchanged = true
            throw new BlobLeaseError(await storageFailure(response, this.account), response.status, bodyCode)
          }
          if (isImmutabilityRefusal(response.status, bodyCode)) {
            if (!ambiguous && (!local || unchangedHeader)) confirmedUnchanged = true
            throw new ProtectedBlobError(bodyCode)
          }
          if (!ambiguous && local && unchangedHeader) confirmedUnchanged = true
          throw await storageFailure(response, this.account)
        }
      }, undefined, () => { dispatched = true; confirmedUnchanged = false })
    } catch (error) {
      if ((!dispatched || confirmedUnchanged) && error && typeof error === "object") {
        deleteConfirmedUnchanged.add(error)
      }
      throw error
    }
  }

  private async request<T>(path: string, init: RequestInit, read: (response: Response, signal: AbortSignal, ambiguous: boolean) => Promise<T>, beforeCommit?: NetworkCircuit, onDispatch?: () => void, onUnconfirmed?: () => void): Promise<T> {
    let ambiguous = false
    for (let attempt = 0; ; attempt++) {
      this.network?.signal.throwIfAborted()
      beforeCommit?.signal.throwIfAborted()
      let response: Response | undefined
      let attempted = false
      try {
        return await withRequestTimeout(async (signal) => {
          const token = beforeCommit
            ? await withAbort(this.token, AbortSignal.any([signal, beforeCommit.signal]))
            : await this.token()
          signal.throwIfAborted()
          beforeCommit?.signal.throwIfAborted()
          beforeCommit = undefined
          this.budget?.dispatch(init.method === "DELETE")
          attempted = true
          onDispatch?.()
          const send = () => this.fetchImpl(`https://${this.account}.blob.core.windows.net/${path}`, {
            ...init,
            ...(this.budget ? { redirect: "error" as const } : {}),
            signal,
            headers: {
              ...(init.headers as Record<string, string> | undefined),
              "x-ms-version": "2021-12-02",
              "x-ms-date": new Date().toUTCString(),
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
          })
          response = await (this.budget ? this.budget.fetch(send) : send())
          if (retryableStatus(response.status) && attempt < REQUEST_ATTEMPTS - 1) {
            throw new RetryableStorageError((await storageError(response, this.account)).message)
          }
          const result = await read(response, signal, ambiguous)
          signal.throwIfAborted()
          if (response.ok) this.network?.succeeded("backup storage")
          return result
        }, this.network?.signal, init.signal ?? undefined)
      } catch (error) {
        if (attempted && (!response || response.ok || response.status === 408 || response.status >= 500)) onUnconfirmed?.()
        this.network?.signal.throwIfAborted()
        beforeCommit?.signal.throwIfAborted()
        if (path.startsWith(`${LARGE_BACKUP_CONTAINER}/`) || path.startsWith(`${LARGE_BACKUP_CONTAINER}?`)) {
          if (error instanceof StorageError && !(error instanceof BlobClaimError) && !(error instanceof InventoryDamagedError)) throw new LargeStorageError(response?.status, { cause: error })
        }
        if (response && (response.status === 401 || response.status === 403) && !(error instanceof ProtectedBlobError) && !(error instanceof BlobLeaseError)) {
          this.network?.authFailed("backup storage", response.status, error instanceof Error ? error.message : String(error))
        }
        if ((attempted || error instanceof RequestTimeoutError) && requestFailure(error) === "network" && !init.signal?.aborted) this.network?.failed("backup storage", error)
        if (!attempted && error instanceof RequestTimeoutError && attempt >= REQUEST_ATTEMPTS - 1) throw new TokenError(error.message, { cause: error })
        if (error instanceof FetchApplicationError || error instanceof TokenError || error instanceof StorageError || error instanceof ProtectedBlobError || init.signal?.aborted || attempt >= REQUEST_ATTEMPTS - 1) throw error
        ambiguous = true
        const retrySignal = beforeCommit
          ? AbortSignal.any([beforeCommit.signal, ...(this.network ? [this.network.signal] : [])])
          : this.network?.signal
        await sleep(retryDelay(response, attempt), init.signal ? AbortSignal.any([init.signal, ...(retrySignal ? [retrySignal] : [])]) : retrySignal)
      }
    }
  }
}

