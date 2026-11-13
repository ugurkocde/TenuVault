import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto"

/** Main/helper-only input. Keys and download URLs must never cross renderer IPC. */
export interface ContentEncryption {
  profileIdentifier: "ProfileVersion1"
  encryptionKey: string
  initializationVector: string
  macKey: string
  mac: string
  fileDigest: string
  fileDigestAlgorithm: "SHA256"
}

export interface ContentIntegrity {
  bytes: number
  encryptedBytes: number
  sha256: string
  encryptedSha256: string
}

export const MAX_CAPTURE_BYTES = 2 * 1024 ** 3
const BLOCK = 64 * 1024
function binary(value: unknown, length: number): Buffer {
  if (typeof value !== "string" || value.length !== Math.ceil(length / 3) * 4) throw new Error("Invalid content encryption metadata.")
  const bytes = Buffer.from(value, "base64")
  if (bytes.length !== length || bytes.toString("base64") !== value) throw new Error("Invalid content encryption metadata.")
  return bytes
}

/**
 * Decrypt only into an unpublished encrypted staging writer. CBC produces bytes
 * before the final HMAC/digest is known; the sink MUST NOT parse, export or publish
 * them. Resolving this function is the authentication boundary, not a write call.
 * The producer owns request timeout/cancellation and must stop reads on abort.
 */
export async function ingestContent(
  encrypted: AsyncIterable<Uint8Array>, metadata: ContentEncryption, expectedBytes: number,
  writeUncommitted: (plain: Buffer) => Promise<void>, signal?: AbortSignal,
): Promise<ContentIntegrity> {
  if (!metadata || metadata.profileIdentifier !== "ProfileVersion1" || metadata.fileDigestAlgorithm !== "SHA256" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_CAPTURE_BYTES) throw new Error("Unsupported content encryption profile or size.")
  const secret: Buffer[] = []
  const decode = (value: unknown, length: number) => { const bytes = binary(value, length); secret.push(bytes); return bytes }
  let decipher: ReturnType<typeof createDecipheriv> | undefined
  try {
    const encryptionKey = decode(metadata.encryptionKey, 32), iv = decode(metadata.initializationVector, 16)
    const macKey = decode(metadata.macKey, 32), expectedMac = decode(metadata.mac, 32), expectedHash = decode(metadata.fileDigest, 32)
    decipher = createDecipheriv("aes-256-cbc", encryptionKey, iv)
    const mac = createHmac("sha256", macKey), hash = createHash("sha256"), encryptedHash = createHash("sha256")
    const expectedEncryptedBytes = 48 + (Math.floor(expectedBytes / 16) + 1) * 16
    const header = Buffer.alloc(48)
    let headerSize = 0, bytes = 0, encryptedBytes = 0
    const consume = async (plain: Buffer) => {
      try {
        signal?.throwIfAborted()
        bytes += plain.length
        if (bytes > expectedBytes) throw new Error("The captured content exceeds its declared size.")
        hash.update(plain)
        if (plain.length) await writeUncommitted(plain)
      } finally { plain.fill(0) }
    }
    signal?.throwIfAborted()
    for await (const chunk of encrypted) {
      signal?.throwIfAborted()
      if (!(chunk instanceof Uint8Array)) throw new Error("Invalid encrypted content stream.")
      encryptedBytes += chunk.byteLength
      if (encryptedBytes > expectedEncryptedBytes) throw new Error("The encrypted content exceeds its declared size.")
      // Bound every cipher call independently of the producer's chunk size.
      for (let offset = 0; offset < chunk.byteLength;) {
        signal?.throwIfAborted()
        if (headerSize < 48) {
          const count = Math.min(48 - headerSize, chunk.byteLength - offset)
          encryptedHash.update(chunk.subarray(offset, offset + count))
          header.set(chunk.subarray(offset, offset + count), headerSize); offset += count; headerSize += count
          if (headerSize === 48) {
            if (!timingSafeEqual(header.subarray(0, 32), expectedMac) || !timingSafeEqual(header.subarray(32), iv)) throw new Error("The content header does not match its encryption metadata.")
            mac.update(header.subarray(32))
          }
        } else {
          const part = chunk.subarray(offset, Math.min(chunk.byteLength, offset + BLOCK)); offset += part.byteLength
          encryptedHash.update(part)
          mac.update(part)
          await consume(decipher.update(part))
        }
      }
    }
    signal?.throwIfAborted()
    if (encryptedBytes !== expectedEncryptedBytes || headerSize !== 48) throw new Error("The encrypted content is truncated.")
    if (!timingSafeEqual(mac.digest(), expectedMac)) throw new Error("The content HMAC could not be verified.")
    await consume(decipher.final())
    const digest = hash.digest()
    if (bytes !== expectedBytes || !timingSafeEqual(digest, expectedHash)) throw new Error("The captured content digest or size could not be verified.")
    signal?.throwIfAborted()
    return { bytes, encryptedBytes, sha256: digest.toString("hex"), encryptedSha256: encryptedHash.digest("hex") }
  } finally {
    decipher?.destroy()
    for (const bytes of secret) bytes.fill(0)
  }
}
