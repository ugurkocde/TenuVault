/**
 * Reads a fetch response body with a hard byte cap, without buffering more
 * than the cap. Returns null when the body exceeds the cap (by its declared
 * length or by the bytes actually read), cancelling the stream so an endless
 * or replaced body cannot exhaust memory before a length check runs.
 */
export async function readBytesCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel() } catch { /* The cap refusal is the result. */ }
    return null
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.byteLength > maxBytes ? null : bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      try { await reader.cancel() } catch { /* The cap refusal is the result. */ }
      return null
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/** The response body as text when it fits the byte cap, or null when it does not. */
export async function readTextCapped(response: Response, maxBytes: number): Promise<string | null> {
  const bytes = await readBytesCapped(response, maxBytes)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}
