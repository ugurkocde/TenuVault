import { X509Certificate, createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"

/**
 * A self-signed certificate and its private key, for the Backup Reader's certificate credential.
 * Entra ID only needs the public certificate to verify the client assertions MSAL signs; nothing
 * checks the issuer, so the certificate is a minimal X.509 v3 structure built with node:crypto.
 */
export interface GeneratedCertificate {
  certificatePem: string
  privateKeyPem: string
  /** Hex SHA-256 of the DER certificate, as MSAL's clientCertificate.thumbprintSha256 expects. */
  thumbprintSha256: string
  notBefore: string
  notAfter: string
}

const SHA256_WITH_RSA = "1.2.840.113549.1.1.11"
const COMMON_NAME = "2.5.4.3"

export function createSelfSignedCertificate(subject: string, validDays: number, now = new Date()): GeneratedCertificate {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  // Backdated a little, so a device clock slightly ahead of Entra's does not reject a new certificate.
  const notBefore = new Date(now.getTime() - 5 * 60_000)
  const notAfter = new Date(now.getTime() + validDays * 86_400_000)
  const algorithm = sequence(objectId(SHA256_WITH_RSA), Buffer.from([0x05, 0x00]))
  const name = sequence(element(0x31, sequence(objectId(COMMON_NAME), element(0x0c, Buffer.from(subject, "utf8")))))
  const serial = randomBytes(16)
  serial[0] = (serial[0]! & 0x7f) | 0x01 // positive and not zero
  const tbs = sequence(
    element(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    algorithm,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
  )
  const der = sequence(tbs, algorithm, element(0x03, Buffer.concat([Buffer.from([0]), sign("sha256", tbs, privateKey)])))
  return {
    certificatePem: pem("CERTIFICATE", der),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    thumbprintSha256: createHash("sha256").update(der).digest("hex").toUpperCase(),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
  }
}

/**
 * How Entra ID identifies a certificate: its SHA-1 thumbprint (the setup script prints the same
 * value) and its subject name, which names the computer the certificate belongs to. MSAL uses the
 * SHA-256 thumbprint instead, so the app shows this one wherever an admin compares with the portal.
 */
export function certificateIdentity(certificatePem: string): { thumbprint: string; name: string } {
  try {
    const certificate = new X509Certificate(certificatePem)
    const name = /(?:^|\n)CN=([^\n]+)/.exec(certificate.subject)?.[1]?.trim() ?? certificate.subject
    return { thumbprint: certificate.fingerprint.replaceAll(":", ""), name }
  } catch {
    return { thumbprint: "", name: "" }
  }
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

function element(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), length(body.length), body])
}

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size])
  const bytes: number[] = []
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

const sequence = (...parts: Buffer[]) => element(0x30, ...parts)

function integer(value: Buffer): Buffer {
  return element(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value)
}

function objectId(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split(".").map(Number)
  const bytes = [first! * 40 + second!]
  for (const arc of rest) {
    const chunk: number[] = []
    for (let value = arc; ; value = Math.floor(value / 128)) {
      chunk.unshift((value % 128) | (chunk.length ? 0x80 : 0))
      if (value < 128) break
    }
    bytes.push(...chunk)
  }
  return element(0x06, Buffer.from(bytes))
}

/** UTCTime through 2049, GeneralizedTime after, as RFC 5280 requires. */
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14)
  return date.getUTCFullYear() < 2050 ? element(0x17, Buffer.from(`${iso.slice(2)}Z`)) : element(0x18, Buffer.from(`${iso}Z`))
}
