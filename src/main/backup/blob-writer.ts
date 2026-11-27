import { assertStorageAccountName } from "../../shared/storage-account"
import { BACKUP_CONTAINER, MAX_BACKUP_ARCHIVE_BYTES } from "../../shared/constants"
import { createHash, randomUUID } from "node:crypto"
import { backupReadKeyFingerprint, wasBackupReadAuthenticated } from "../storage/authenticated-read"
import { isLocalAccount } from "../storage/blob-emulator"
import { withHeaderOnlyBackupRead, type RetentionBudget } from "./retention-budget"
import { readBytesCapped } from "../../shared/capped-body"
import { oversizedOwnershipFile } from "../../shared/backup-ownership"
import { retryDelay, retryableStatus, sleep } from "../graph-retry"
import { FetchApplicationError } from "../api/network-error"
import type { NetworkCircuit } from "./engine"
import { MAX_LIST_PAGES, REQUEST_ATTEMPTS, BlobClaimError, DeleteConditionError, ProtectedBlobError, RequestTimeoutError, RetryableStorageError, StorageError, TokenError, isImmutabilityRefusal, requestFailure, storageError, storageFailure, withAbort, withRequestTimeout } from "./request"

const LEASE_RELEASE_TIMEOUT_MS = 15_000
const deleteConfirmedUnchanged = new WeakSet<object>()

/** Whether a failed BlobWriter.delete call confirmed that storage did not move or remove the blob. */
export function wasDeleteConfirmedUnchanged(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && deleteConfirmedUnchanged.has(error))
}

/** Lease acquisition or renewal failed (conflict, missing permission, or storage error). */
export class BlobLeaseError extends FetchApplicationError {
  constructor(cause: unknown, readonly status?: number, readonly code?: string) {
    super(cause)
    this.name = "BlobLeaseError"
  }
}

export interface RetentionBlob { value: unknown; etag: string; authenticated: boolean; keyFingerprint?: string; sha256: string }

export interface BlobListing {
  blobs: string[]
  prefixes: string[]
  etags: Map<string, string>
}

/** Writes blobs to Azure or, for local accounts, to the encrypted store via the fetch bridge. */
export class BlobWriter {
  private headEtagUnsupported = false

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

  async ensureContainer(): Promise<void> {
    await this.request(`${BACKUP_CONTAINER}?restype=container`, { method: "PUT" }, async (response) => {
      if (response.ok || response.status === 409) return
      throw new StorageError(await storageError(response, this.account))
    })
  }

  /**
   * `onDispatch` runs right before each PUT is sent, after its token and cancellation checks.
   * A create-only body must be unique to its writer (the engine includes the run id), so a retry
   * that finds identical bytes knows its own earlier attempt created the blob.
   */
  async put(name: string, body: string, beforeCommit?: NetworkCircuit, createOnly = false, onDispatch?: () => void, onUnconfirmed?: () => void): Promise<void> {
    const path = `${BACKUP_CONTAINER}/${name.split("/").map(encodeURIComponent).join("/")}`
    // The earlier PUT may have landed. Read it back and compare it with what this writer sent.
    const landed = async (response: Response, signal: AbortSignal) => {
      const stored = await this.request(path, { method: "GET", signal }, async (readBack) => {
        if (!readBack.ok) throw new StorageError(await storageError(readBack, this.account))
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
      throw new StorageError(await storageError(response, this.account))
    }, beforeCommit, onDispatch, onUnconfirmed)
  }

  /** Lists blob names and, with a delimiter, virtual folders under a prefix. */
  async list(prefix: string, delimiter = ""): Promise<BlobListing> {
    const blobs: string[] = []
    const prefixes: string[] = []
    const etags = new Map<string, string>()
    let marker = ""
    const seen = new Set<string>()
    do {
      if (seen.size >= MAX_LIST_PAGES) throw new Error(`Storage listing did not finish after ${MAX_LIST_PAGES} pages`)
      const query = new URLSearchParams({ restype: "container", comp: "list", prefix, ...(delimiter ? { delimiter } : {}), ...(marker ? { marker } : {}) })
      const xml = await this.request(`${BACKUP_CONTAINER}?${query.toString()}`, { method: "GET" }, async (response) => {
        if (response.status === 404) return null
        if (!response.ok) throw await storageFailure(response, this.account)
        return response.text()
      })
      if (xml === null) break
      const decode = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
      for (const m of xml.matchAll(/<BlobPrefix><Name>([^<]*)<\/Name><\/BlobPrefix>/g)) prefixes.push(decode(m[1]!))
      for (const m of xml.matchAll(/<Blob><Name>([^<]*)<\/Name>([\s\S]*?)<\/Blob>/g)) {
        const name = decode(m[1]!)
        const properties = m[2]!
        blobs.push(name)
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
    return { blobs, prefixes, etags }
  }

  /** Retain the identity and the authentication evidence from the same read. */
  async readForRetention(name: string): Promise<RetentionBlob>
  async readForRetention(name: string, optional: true): Promise<RetentionBlob | null>
  async readForRetention(name: string, optional = false): Promise<RetentionBlob | null> {
    return this.request(`${BACKUP_CONTAINER}/${name.split("/").map(encodeURIComponent).join("/")}`, { method: "GET" }, async (response) => {
      if (optional && response.status === 404) {
        void response.body?.cancel().catch(() => undefined)
        return null
      }
      if (!response.ok) throw await storageFailure(response, this.account)
      const bytes = await readBytesCapped(response, MAX_BACKUP_ARCHIVE_BYTES)
      const etag = response.headers.get("etag")
      if (!bytes) throw new FetchApplicationError(new Error(oversizedOwnershipFile(name.split("/").pop() ?? name)))
      if (!etag || etag === "*") throw new FetchApplicationError(new Error(`${name} could not be verified for retention.`))
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object")
        return { value, etag, authenticated: wasBackupReadAuthenticated(response), keyFingerprint: backupReadKeyFingerprint(response), sha256: createHash("sha256").update(bytes).digest("hex") }
      } catch (error) {
        throw new FetchApplicationError(new Error(`${name} could not be verified for retention.`, { cause: error }))
      }
    })
  }

  /** Reads a blob's ETag with HEAD where supported, falling back to a header-only GET when HEAD is unsupported or omits the ETag. */
  async readEtag(name: string): Promise<string | null> {
    const path = `${BACKUP_CONTAINER}/${name.split("/").map(encodeURIComponent).join("/")}`
    if (!this.headEtagUnsupported) {
      const head = await this.request(path, { method: "HEAD" }, async (response) => {
        void response.body?.cancel().catch(() => undefined)
        if (response.status === 404) return { kind: "missing" as const }
        if (response.status === 405 || response.status === 501) return { kind: "unsupported" as const }
        if (!response.ok) throw await storageFailure(response, this.account)
        const etag = response.headers.get("etag")
        if (!etag || etag === "*") return { kind: "missing-etag" as const }
        return { kind: "etag" as const, etag }
      })
      if (head.kind === "missing") return null
      if (head.kind === "etag") return head.etag
      this.headEtagUnsupported = true
    }
    return withHeaderOnlyBackupRead(() => this.request(path, { method: "GET" }, async (response) => {
      if (response.status === 404) {
        void response.body?.cancel().catch(() => undefined)
        return null
      }
      if (!response.ok) throw await storageFailure(response, this.account)
      void response.body?.cancel().catch(() => undefined)
      const etag = response.headers.get("etag")
      if (!etag || etag === "*") throw new FetchApplicationError(new Error(`${name} could not be verified for retention.`))
      return etag
    }))
  }

  /** Acquires a finite lease on a blob (Azure) without modifying its content. */
  async acquireLease(name: string, durationSeconds = 60): Promise<string> {
    const path = `${BACKUP_CONTAINER}/${name.split("/").map(encodeURIComponent).join("/")}?comp=lease`
    return this.acquireLeaseAt(path, durationSeconds)
  }

  /** Renews an active blob lease. Runs outside the retention request budget so long deletes stay protected. */
  async renewLease(name: string, leaseId: string, signal?: AbortSignal): Promise<void> {
    const path = `${BACKUP_CONTAINER}/${name.split("/").map(encodeURIComponent).join("/")}?comp=lease`
    await this.withoutBudget().renewLeaseAt(path, leaseId, undefined, signal)
  }

  /** Best-effort release of a blob lease. Never throws through the retention budget or aborted job circuit. */
  async releaseLease(name: string, leaseId: string, signal?: AbortSignal): Promise<void> {
    const path = `${BACKUP_CONTAINER}/${name.split("/").map(encodeURIComponent).join("/")}?comp=lease`
    await this.releaseLeaseAt(path, leaseId, signal)
  }

  /** Acquires the local cross-process retention lock file and registers protected replacement prefixes in-process. */
  async acquireContainerLease(protectedPrefixes?: string[]): Promise<string> {
    const headers = protectedPrefixes?.length
      ? { "x-tenuvault-protected-prefixes": JSON.stringify(protectedPrefixes) }
      : undefined
    return this.acquireLeaseAt(`${BACKUP_CONTAINER}?restype=container&comp=lease`, undefined, headers)
  }

  /** Best-effort release of a container lock; returns any lock-mismatch warning reported by local storage. */
  async releaseContainerLease(leaseId: string, signal?: AbortSignal): Promise<string | undefined> {
    return this.releaseLeaseAt(`${BACKUP_CONTAINER}?restype=container&comp=lease`, leaseId, signal)
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
      }, async (response, _signal, ambiguous) => {
        if (response.ok) {
          void response.body?.cancel().catch(() => undefined)
          return response.headers.get("x-ms-lease-id") || proposedId
        }
        if (ambiguous && response.status === 409) {
          // An earlier attempt may have acquired this proposed lease before its response was lost.
          await this.releaseLeaseAt(path, proposedId).catch(() => undefined)
        }
        const code = await this.leaseResponseCode(response)
        throw new BlobLeaseError(await storageFailure(response, this.account), response.status, code)
      })
    } catch (error) {
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
      const warning = response.headers.get("x-tenuvault-lock-warning") ?? undefined
      void response.body?.cancel().catch(() => undefined)
      return warning
    } finally {
      clearTimeout(timer)
    }
  }

  async delete(name: string, etag?: string, retentionLockId?: string): Promise<void> {
    let dispatched = false
    let confirmedUnchanged = false
    try {
      const headers: Record<string, string> = {}
      if (etag) headers["if-match"] = etag
      if (retentionLockId) headers["x-tenuvault-retention-lock-id"] = retentionLockId
      await this.request(`${BACKUP_CONTAINER}/${name.split("/").map(encodeURIComponent).join("/")}`, {
        method: "DELETE",
        ...(Object.keys(headers).length ? { headers } : {}),
      }, async (response, _signal, ambiguous) => {
        if (!response.ok && response.status !== 404) {
          const code = response.headers.get("x-ms-error-code") ?? ""
          const local = isLocalAccount(this.account)
          const unchangedHeader = response.headers.get("x-tenuvault-delete-unchanged") === "1"
          if (code === "RetentionLockLost") {
            if (!ambiguous && (!local || unchangedHeader)) confirmedUnchanged = true
            throw new BlobLeaseError(await storageFailure(response, this.account), response.status, code)
          }
          if (isImmutabilityRefusal(response.status, code)) {
            if (!ambiguous && (!local || unchangedHeader)) confirmedUnchanged = true
            throw new ProtectedBlobError(code)
          }
          if (response.status === 412 && (etag || code === "BlobQuarantined")) {
            if (code === "BlobQuarantined") throw new DeleteConditionError(await storageFailure(response, this.account))
            if (!ambiguous && (!local || unchangedHeader)) confirmedUnchanged = true
            void response.body?.cancel().catch(() => undefined)
            throw new DeleteConditionError(new Error(`${name} changed before it could be deleted.`))
          }
          const text = await response.clone().text()
          const bodyCode = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? ""
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
          if (retryableStatus(response.status) && !(init.method === "HEAD" && response.status === 501) && attempt < REQUEST_ATTEMPTS - 1) {
            throw new RetryableStorageError(await storageError(response, this.account))
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
        if (response && (response.status === 401 || response.status === 403) && !(error instanceof ProtectedBlobError) && !(error instanceof BlobLeaseError)) {
          this.network?.authFailed("backup storage", response.status, error instanceof Error ? error.message : String(error))
        }
        if ((attempted || error instanceof RequestTimeoutError) && requestFailure(error) === "network" && !init.signal?.aborted) this.network?.failed("backup storage", error)
        if (!attempted && error instanceof RequestTimeoutError && attempt >= REQUEST_ATTEMPTS - 1) throw new TokenError(error.message, { cause: error })
        if (error instanceof FetchApplicationError || error instanceof TokenError || error instanceof StorageError || error instanceof ProtectedBlobError || init.signal?.aborted || attempt >= REQUEST_ATTEMPTS - 1) throw error
        ambiguous = true
        const retrySignals = [beforeCommit?.signal, this.network?.signal, init.signal ?? undefined].filter((value): value is AbortSignal => value !== undefined)
        const retrySignal = retrySignals.length > 1 ? AbortSignal.any(retrySignals) : retrySignals[0]
        await sleep(retryDelay(response, attempt), retrySignal)
      }
    }
  }
}

