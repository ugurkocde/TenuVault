import { backupBlobName, backupContainer, backupStoragePath, LARGE_BACKUP_CONTAINER, logicalBackupName } from "../../shared/backup-storage"
import { assertStorageAccountName } from "../../shared/storage-account"
import { BACKUP_CONTAINER, MAX_BACKUP_ARCHIVE_BYTES } from "../../shared/constants"
import { wasBackupReadAuthenticated } from "../storage/authenticated-read"
import { createHash } from "node:crypto"
import { readBytesCapped, readJsonCapped } from "../../shared/capped-body"
import { oversizedOwnershipFile } from "../../shared/backup-ownership"
import { retryDelay, retryableStatus, sleep } from "../graph-retry"
import { FetchApplicationError } from "../api/network-error"
import type { RetentionBudget } from "./retention-budget"
import type { NetworkCircuit } from "./engine"
import { MAX_LIST_PAGES, REQUEST_ATTEMPTS, BlobClaimError, DeleteConditionError, ImmutableBlobError, ProtectedBlobError, RequestTimeoutError, RetryableStorageError, StorageError, LargeStorageError, TokenError, isImmutabilityRefusal, requestFailure, storageError, storageFailure, withAbort, withRequestTimeout } from "./request"

export interface RetentionBlob { value: unknown; etag: string; authenticated: boolean; sha256: string }

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
  async list(prefix: string, delimiter = "", container = backupContainer(prefix), physicalPrefix = false): Promise<{ blobs: string[]; prefixes: string[]; sizes: Map<string, number> }> {
    const blobs: string[] = []
    const sizes = new Map<string, number>()
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
      for (const m of xml.matchAll(/<Blob><Name>([^<]*)<\/Name>/g)) blobs.push(logicalBackupName(decode(m[1]!)))
      for (const m of xml.matchAll(/<Blob>[\s\S]*?<Name>([^<]*)<\/Name>[\s\S]*?<Content-Length>(\d+)<\/Content-Length>[\s\S]*?<\/Blob>/g)) sizes.set(logicalBackupName(decode(m[1]!)), Number(m[2]))
      // The marker is XML-escaped like the names; send back the name it stands for.
      marker = decode(/<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1] ?? "")
      if (marker && seen.has(marker)) throw new Error("Storage returned a repeated continuation marker")
      seen.add(marker)
    } while (marker)
    return { blobs, prefixes, sizes }
  }

  /** Root records and payload together, for deletion after ownership has been checked. */
  async listFolder(prefix: string): Promise<{ blobs: string[]; sizes: Map<string, number> }> {
    const payload = await this.list(prefix)
    if (backupContainer(prefix) !== LARGE_BACKUP_CONTAINER) return payload
    const roots = await this.list(prefix, "", LARGE_BACKUP_CONTAINER, true)
    return { blobs: [...roots.blobs, ...payload.blobs], sizes: new Map([...roots.sizes, ...payload.sizes]) }
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
        return { value, etag, authenticated: wasBackupReadAuthenticated(response), sha256: createHash("sha256").update(bytes).digest("hex") }
      } catch (error) {
        throw new FetchApplicationError(new Error(`${name} could not be verified for retention.`, { cause: error }))
      }
    })
  }

  async delete(name: string, etag?: string): Promise<void> {
    await this.request(backupStoragePath(name), {
      method: "DELETE",
      ...(etag ? { headers: { "if-match": etag } } : {}),
    }, async (response) => {
      if (!response.ok && response.status !== 404) {
        const code = response.headers.get("x-ms-error-code") ?? ""
        if (isImmutabilityRefusal(response.status, code)) throw new ProtectedBlobError(code)
        if (response.status === 412 && code !== "BlobQuarantined") {
          void response.body?.cancel().catch(() => undefined)
          throw new DeleteConditionError(new Error(`${name} changed before it could be deleted.`))
        }
        const text = await response.clone().text()
        const bodyCode = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? ""
        if (isImmutabilityRefusal(response.status, bodyCode)) throw new ProtectedBlobError(bodyCode)
        throw await storageFailure(response, this.account)
      }
    })
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
          if (error instanceof StorageError && !(error instanceof BlobClaimError) && !(error instanceof ProtectedBlobError)) throw new LargeStorageError(response?.status, { cause: error })
        }
        if (response && (response.status === 401 || response.status === 403) && !(error instanceof ProtectedBlobError)) {
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

