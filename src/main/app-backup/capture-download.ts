import type { CaptureIdentity, CapturedAppSource } from "../../shared/app-sources/types"
import type { AppSourceStore } from "../app-sources/store"
import { bindCapture } from "./capture-identity"
import { MAX_CAPTURE_BYTES, type ContentEncryption } from "./content-stream"

/** Supplied only by the authenticated device adapter, never accepted through IPC. */
export interface DeviceContent {
  identity: CaptureIdentity
  downloadUrl: string
  encryption: ContentEncryption
  bytes: number
}

/** Final download/store stage. Device authorization and CMS unwrap happen upstream. */
export async function downloadCapturedContent(store: AppSourceStore, expected: CaptureIdentity, content: DeviceContent, appName: string, options: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<CapturedAppSource> {
  const identity = bindCapture(expected, content.identity), bytes = content.bytes, encryption = { ...content.encryption }
  const target = new URL(content.downloadUrl)
  if (target.protocol !== "https:" || !/(^|\.)manage\.microsoft\.com$/.test(target.hostname) || target.username || target.password || target.port || target.hash) throw new Error("The device returned an unsupported content download address.")
  if (!Number.isSafeInteger(bytes) || bytes < 22 || bytes > MAX_CAPTURE_BYTES) throw new Error("The device returned an unsupported content size.")
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000), ...(options.signal ? [options.signal] : [])])
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    signal.throwIfAborted()
    let response: Response
    try {
      // A fresh request carries no Graph token, device certificate or caller headers.
      response = await (options.fetch ?? fetch)(target.href, { method: "GET", redirect: "error", credentials: "omit", signal })
    } catch {
      signal.throwIfAborted()
      throw new Error("The installer download could not be started. Retry the capture.")
    }
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new Error(`The installer download failed (HTTP ${response.status}).`)
    }
    const declared = response.headers.get("content-length"), expectedEncryptedBytes = 48 + (Math.floor(bytes / 16) + 1) * 16
    if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) !== expectedEncryptedBytes)) {
      await response.body?.cancel()
      throw new Error("The installer download has an unexpected length.")
    }
    reader = response.body?.getReader()
    if (!reader) throw new Error("The installer download returned no content.")
    async function* chunks() {
      for (;;) {
        signal.throwIfAborted()
        let part: ReadableStreamReadResult<Uint8Array>
        try { part = await reader!.read() } catch { signal.throwIfAborted(); throw new Error("The installer download was interrupted. Retry the capture.") }
        if (part.done) break
        yield part.value
      }
    }
    return await store.capture(identity, identity, chunks(), encryption, bytes, appName, signal)
  } finally {
    controller.abort()
    try { await reader?.cancel() } catch { /* Transport already closed. */ }
    reader?.releaseLock()
  }
}
