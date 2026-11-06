import { generateKeyPairSync } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  PLACEHOLDER_LICENSE_PUBLIC_KEY,
  PRODUCTION_LICENSE_PUBLIC_KEY_FINGERPRINT,
  checkLicensePublicKey,
  licensePublicKeyFingerprint,
} from "../scripts/license-public-key"

// The production verification key, read back from the shipped 0.4.2 and nightly installers.
// A public key is not a secret; keeping it here pins the fingerprint to the key customers run.
const PRODUCTION_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAh/aEyyt/J6FTGT43Pit8wgz3oJfCAhSmZYfdAMQDzYg=
-----END PUBLIC KEY-----`

const otherEd25519 = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString()

describe("license public key fingerprint", () => {
  it("pins the fingerprint to the shipped production key", () => {
    expect(licensePublicKeyFingerprint(PRODUCTION_LICENSE_PUBLIC_KEY)).toBe(PRODUCTION_LICENSE_PUBLIC_KEY_FINGERPRINT)
  })

  it("is stable across PEM formatting and escaped newlines", () => {
    const escaped = PRODUCTION_LICENSE_PUBLIC_KEY.replace(/\n/g, "\\n")
    expect(licensePublicKeyFingerprint(escaped.replace(/\\n/g, "\n"))).toBe(PRODUCTION_LICENSE_PUBLIC_KEY_FINGERPRINT)
    expect(licensePublicKeyFingerprint(PLACEHOLDER_LICENSE_PUBLIC_KEY)).not.toBe(PRODUCTION_LICENSE_PUBLIC_KEY_FINGERPRINT)
  })
})

describe("checkLicensePublicKey", () => {
  it("accepts the production key in a release build", () => {
    expect(checkLicensePublicKey(PRODUCTION_LICENSE_PUBLIC_KEY, true)).toBe(PRODUCTION_LICENSE_PUBLIC_KEY_FINGERPRINT)
  })

  it("refuses the placeholder in a release build", () => {
    expect(() => checkLicensePublicKey(PLACEHOLDER_LICENSE_PUBLIC_KEY, true)).toThrow(/placeholder key verifies no entitlement/)
  })

  it("refuses a different valid Ed25519 key in a release build", () => {
    expect(() => checkLicensePublicKey(otherEd25519, true)).toThrow(/does not match the pinned production license key/)
  })

  it("allows the placeholder and other keys outside release builds", () => {
    expect(checkLicensePublicKey(PLACEHOLDER_LICENSE_PUBLIC_KEY, false)).toBe(licensePublicKeyFingerprint(PLACEHOLDER_LICENSE_PUBLIC_KEY))
    expect(checkLicensePublicKey(otherEd25519, false)).toBe(licensePublicKeyFingerprint(otherEd25519))
  })

  it("refuses a key that is not Ed25519 in any build", () => {
    expect(() => checkLicensePublicKey(rsa, false)).toThrow(/must be an Ed25519 public key/)
    expect(() => checkLicensePublicKey(rsa, true)).toThrow(/must be an Ed25519 public key/)
  })
})
