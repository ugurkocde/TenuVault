import { assertStorageAccountName } from "../../shared/storage-account"
import { BACKUP_CONTAINER } from "../../shared/constants"
import { retryDelay, retryableStatus, sleep } from "../graph-retry"
import { FetchApplicationError } from "../api/network-error"
import type { NetworkCircuit } from "./engine"
import { MAX_LIST_PAGES, REQUEST_ATTEMPTS, BlobClaimError, ProtectedBlobError, RequestTimeoutError, RetryableStorageError, StorageError, TokenError, isImmutabilityRefusal, requestFailure, storageError, withAbort, withRequestTimeout } from "./request"

/** Writes blobs to Azure or, for local accounts, to the encrypted store via the fetch bridge. */
export class BlobWriter {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly account: string,
    private readonly token: () => Promise<string>,
    private readonly network?: NetworkCircuit,
  ) {
    assertStorageAccountName(account)
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
  async put(name: string, body: string, beforeCommit?: NetworkCircuit, createOnly = false, onDispatch?: () => void): Promise<void> {
    const path = `${BACKUP_CONTAINER}/${name.split("/").map(encodeURIComponent).join("/")}`
    // The earlier PUT may have landed. Read through the same decrypting wrapper and compare plaintext.
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
    }, beforeCommit, onDispatch)
  }

  /** Lists blob names and, with a delimiter, virtual folders under a prefix. */
  async list(prefix: string, delimiter = ""): Promise<{ blobs: string[]; prefixes: string[] }> {
    const blobs: string[] = []
    const prefixes: string[] = []
    let marker = ""
    const seen = new Set<string>()
    do {
      if (seen.size >= MAX_LIST_PAGES) throw new Error(`Storage listing did not finish after ${MAX_LIST_PAGES} pages`)
      const query = new URLSearchParams({ restype: "container", comp: "list", prefix, ...(delimiter ? { delimiter } : {}), ...(marker ? { marker } : {}) })
      const xml = await this.request(`${BACKUP_CONTAINER}?${query.toString()}`, { method: "GET" }, async (response) => {
        if (response.status === 404) return null
        if (!response.ok) throw new StorageError(await storageError(response, this.account))
        return response.text()
      })
      if (xml === null) break
      const decode = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
      for (const m of xml.matchAll(/<BlobPrefix><Name>([^<]*)<\/Name><\/BlobPrefix>/g)) prefixes.push(decode(m[1]!))
      for (const m of xml.matchAll(/<Blob><Name>([^<]*)<\/Name>/g)) blobs.push(decode(m[1]!))
      marker = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1] ?? ""
      if (marker && seen.has(marker)) throw new Error("Storage returned a repeated continuation marker")
      seen.add(marker)
    } while (marker)
    return { blobs, prefixes }
  }

  /** A JSON blob, or null when it does not exist or is not valid JSON. */
  async readJson(name: string, authenticated = false): Promise<Record<string, unknown> | null> {
    return this.request(`${BACKUP_CONTAINER}/${name.split("/").map(encodeURIComponent).join("/")}`, { method: "GET" }, async (response) => {
      if (response.status === 404) return null
      if (!response.ok) throw new StorageError(await storageError(response, this.account))
      if (authenticated && response.headers.get("x-tenuvault-authenticated") !== "true") {
        void response.body?.cancel().catch(() => undefined)
        return null
      }
      try {
        return (await response.json()) as Record<string, unknown>
      } catch (error) {
        if (error instanceof SyntaxError) return null
        throw error
      }
    })
  }

  async delete(name: string): Promise<void> {
    await this.request(`${BACKUP_CONTAINER}/${name.split("/").map(encodeURIComponent).join("/")}`, {
      method: "DELETE",
    }, async (response) => {
      if (!response.ok && response.status !== 404) {
        const code = response.headers.get("x-ms-error-code") ?? ""
        if (isImmutabilityRefusal(response.status, code)) throw new ProtectedBlobError(code)
        const text = await response.clone().text()
        const bodyCode = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? ""
        if (isImmutabilityRefusal(response.status, bodyCode)) throw new ProtectedBlobError(bodyCode)
        throw new StorageError(await storageError(response, this.account))
      }
    })
  }

  private async request<T>(path: string, init: RequestInit, read: (response: Response, signal: AbortSignal, ambiguous: boolean) => Promise<T>, beforeCommit?: NetworkCircuit, onDispatch?: () => void): Promise<T> {
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
          attempted = true
          onDispatch?.()
          response = await this.fetchImpl(`https://${this.account}.blob.core.windows.net/${path}`, {
            ...init,
            signal,
            headers: {
              ...(init.headers as Record<string, string> | undefined),
              "x-ms-version": "2021-12-02",
              "x-ms-date": new Date().toUTCString(),
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
          })
          if (retryableStatus(response.status) && attempt < REQUEST_ATTEMPTS - 1) {
            throw new RetryableStorageError(await storageError(response, this.account))
          }
          const result = await read(response, signal, ambiguous)
          signal.throwIfAborted()
          if (response.ok) this.network?.succeeded("backup storage")
          return result
        }, this.network?.signal, init.signal ?? undefined)
      } catch (error) {
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

