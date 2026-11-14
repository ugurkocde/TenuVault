import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto"
import type { ContentEncryption } from "./content-stream"

export interface RestoreSecrets { key: string; iv: string; macKey: string }
export const newRestoreSecrets = (): RestoreSecrets => ({ key: randomBytes(32).toString("base64"), iv: randomBytes(16).toString("base64"), macKey: randomBytes(32).toString("base64") })
const binary = (v: string, size: number) => {
  const b = Buffer.from(v, "base64")
  if (b.length !== size || b.toString("base64") !== v) throw new Error("Invalid restore encryption material.")
  return b
}
/** Two bounded passes avoid plaintext staging and allow the MAC to precede ciphertext. */
export async function* encryptRestoreContent(input: AsyncIterable<Buffer>, secrets: RestoreSecrets, expected: { bytes: number; sha256: string }, result: { profile?: ContentEncryption }, header?: ContentEncryption): AsyncGenerator<Buffer> {
  const key = binary(secrets.key, 32), iv = binary(secrets.iv, 16), macKey = binary(secrets.macKey, 32)
  const cipher = createCipheriv("aes-256-cbc", key, iv), hash = createHash("sha256"), mac = createHmac("sha256", macKey).update(iv)
  let size = 0
  try {
    if (header) yield Buffer.concat([binary(header.mac, 32), iv])
    for await (const plain of input) {
      size += plain.length; hash.update(plain)
      if (size > expected.bytes) throw new Error("Restore source length changed.")
      const encrypted = cipher.update(plain); mac.update(encrypted)
      if (encrypted.length) yield encrypted
    }
    const final = cipher.final(); mac.update(final)
    const digest = hash.digest(), authentication = mac.digest()
    if (size !== expected.bytes || digest.toString("hex") !== expected.sha256 || (header && header.mac !== authentication.toString("base64"))) throw new Error("Restore source integrity check failed.")
    result.profile = { profileIdentifier: "ProfileVersion1", encryptionKey: secrets.key, macKey: secrets.macKey, initializationVector: secrets.iv, mac: authentication.toString("base64"), fileDigest: digest.toString("base64"), fileDigestAlgorithm: "SHA256" }
    yield final
  } finally { cipher.destroy(); key.fill(0); iv.fill(0); macKey.fill(0) }
}
