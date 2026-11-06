import { createHash, createPublicKey } from "node:crypto"

/**
 * The placeholder verification key of development and pull request builds. Its private half
 * was discarded, so no entitlement token verifies against it and an unconfigured build cannot
 * license any tenant (Community still works).
 */
export const PLACEHOLDER_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAKxXrhBA4x3ybwuC7hkZm8pyRgkM/Zy51UwCGj8EzsF8=
-----END PUBLIC KEY-----`

/**
 * SHA-256 of the production license public key in SPKI DER form. The public key itself is not
 * a secret (it ships in every installer, and this fingerprint was read back from the released
 * 0.4.2 and nightly builds), but pinning its fingerprint here means a release build fails
 * loudly when the TENUVAULT_LICENSE_PUBLIC_KEY secret is ever replaced by a different valid
 * Ed25519 key (sandbox, preview, or an uncoordinated rotation) instead of shipping an app in
 * which every paid activation fails verification. Rotating the signing key means updating this
 * fingerprint in the same change that teaches the app to trust the new key, and only after a
 * release that trusts both keys has shipped (see the licensing invariants in RELEASING.md).
 */
export const PRODUCTION_LICENSE_PUBLIC_KEY_FINGERPRINT =
  "71e8a17a5a7cf36a60d057b51ba6742dd33200eb1f1ce17afb7ba6b95e6f2b50"

/**
 * Further verification keys the app trusts besides TENUVAULT_LICENSE_PUBLIC_KEY, only while the
 * licensing service's signing key is rotated (runbook: docs/release-setup.md, "Rotating the
 * license signing key"): the next key before the service switches to it, then the previous key
 * until every token it signed has expired. Empty outside a rotation. Public keys are not secrets,
 * so they live here, reviewed like code, rather than in a CI secret.
 */
export const ROTATION_LICENSE_PUBLIC_KEYS: readonly string[] = []

/** The key's fingerprint: SHA-256 hex of its SPKI DER encoding, PEM formatting aside. */
export function licensePublicKeyFingerprint(pem: string): string {
  const der = createPublicKey(pem).export({ type: "spki", format: "der" })
  return createHash("sha256").update(der).digest("hex")
}

/**
 * Validates the build-time license public key and returns its fingerprint. The app parses this
 * key at startup, so a key that is not Ed25519 never builds. A release build (the release and
 * manual installer workflows set TENUVAULT_RELEASE_BUILD=1) must additionally carry exactly the
 * pinned production key: a missing secret silently falls back to the placeholder and a wrong
 * secret still parses, and both would otherwise ship an app that cannot verify any entitlement.
 */
export function checkLicensePublicKey(pem: string, releaseBuild: boolean): string {
  if (createPublicKey(pem).asymmetricKeyType !== "ed25519") {
    throw new Error("TENUVAULT_LICENSE_PUBLIC_KEY must be an Ed25519 public key.")
  }
  const fingerprint = licensePublicKeyFingerprint(pem)
  if (releaseBuild && fingerprint !== PRODUCTION_LICENSE_PUBLIC_KEY_FINGERPRINT) {
    throw new Error(
      pem === PLACEHOLDER_LICENSE_PUBLIC_KEY
        ? "Release builds must set TENUVAULT_LICENSE_PUBLIC_KEY to the production license public key; the placeholder key verifies no entitlement."
        : `TENUVAULT_LICENSE_PUBLIC_KEY does not match the pinned production license key (fingerprint ${fingerprint}, expected ${PRODUCTION_LICENSE_PUBLIC_KEY_FINGERPRINT}). Refusing to build a release that cannot verify entitlements. If the signing key was rotated on purpose, update PRODUCTION_LICENSE_PUBLIC_KEY_FINGERPRINT in scripts/license-public-key.ts as part of that rotation.`,
    )
  }
  return fingerprint
}

/**
 * Validates the rotation keys against the current key and returns their fingerprints. Each must
 * be an Ed25519 key, differ from the current key and from each other, and never be the
 * placeholder, whose private half no longer exists.
 */
export function checkRotationLicensePublicKeys(keys: readonly string[], current: string): string[] {
  const seen = new Set([licensePublicKeyFingerprint(current)])
  return keys.map((pem) => {
    if (createPublicKey(pem).asymmetricKeyType !== "ed25519") {
      throw new Error("ROTATION_LICENSE_PUBLIC_KEYS may only contain Ed25519 public keys.")
    }
    const fingerprint = licensePublicKeyFingerprint(pem)
    if (fingerprint === licensePublicKeyFingerprint(PLACEHOLDER_LICENSE_PUBLIC_KEY)) {
      throw new Error("ROTATION_LICENSE_PUBLIC_KEYS must not contain the placeholder key.")
    }
    if (seen.has(fingerprint)) {
      throw new Error(`ROTATION_LICENSE_PUBLIC_KEYS repeats a key (fingerprint ${fingerprint}).`)
    }
    seen.add(fingerprint)
    return fingerprint
  })
}
