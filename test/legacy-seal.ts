import { createCipheriv, hkdfSync, randomBytes } from "node:crypto"

/**
 * Seals a blob the way TenuVault versions before plain Azure backups did (the `TVAZ1` envelope),
 * so tests can put legacy backups in a container. The app itself only opens these.
 */
export function sealLegacyAzure(plain: Buffer, master: Buffer, tenant: string, url: URL): Buffer {
  const key = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "tenuvault-azure-backup-v1", 32))
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(JSON.stringify([tenant.toLowerCase(), url.hostname, decodeURIComponent(url.pathname)])))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([Buffer.from("TVAZ1\n"), iv, cipher.getAuthTag(), body])
}
