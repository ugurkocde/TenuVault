import { assertStorageAccountName } from "../../shared/storage-account"
import { BACKUP_CONTAINER, MAX_BACKUP_ARCHIVE_BYTES } from "../../shared/constants"
import { createHash } from "node:crypto"
import { backupReadKeyFingerprint, wasBackupReadAuthenticated } from "../storage/authenticated-read"
import type { RetentionBudget } from "./retention-budget"
import { readBytesCapped } from "../../shared/capped-body"
import { oversizedOwnershipFile } from "../../shared/backup-ownership"
import { retryDelay, retryableStatus, sleep } from "../graph-retry"
import { FetchApplicationError } from "../api/network-error"
import type { NetworkCircuit } from "./engine"
import { MAX_LIST_PAGES, REQUEST_ATTEMPTS, BlobClaimError, DeleteConditionError, ProtectedBlobError, RequestTimeoutError, RetryableStorageError, StorageError, TokenError, isImmutabilityRefusal, requestFailure, storageError, storageFailure, withAbort, withRequestTimeout } from "./request"

export interface RetentionBlob { value: unknown; etag: string; authenticated: boolean; keyFingerprint?: string; sha256: string }

export interface BlobListing {
  blobs: string[]
  prefixes: string[]
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

  async delete(name: string, etag?: string): Promise<void> {
    await this.request(`${BACKUP_CONTAINER}/${name.split("/").map(encodeURIComponent).join("/")}`, {
      method: "DELETE",
      ...(etag ? { headers: { "if-match": etag } } : {}),
    }, async (response) => {
      if (!response.ok && response.status !== 404) {
        const code = response.headers.get("x-ms-error-code") ?? ""
        if (isImmutabilityRefusal(response.status, code)) throw new ProtectedBlobError(code)
        if (response.status === 412 && (etag || code === "BlobQuarantined")) {
          if (code === "BlobQuarantined") throw new DeleteConditionError(await storageFailure(response, this.account))
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
        await sleep(retryDelay(response, attempt), retrySignal)
      }
    }
  }
}

