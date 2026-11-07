/**
 * The licensing canary: the buyer path against production, as a shipped app runs it.
 *
 *   npx esbuild scripts/license-canary.ts --bundle --platform=node --format=esm --outfile=/tmp/canary.mjs
 *   LICENSING_CANARY_KEY=<key> node /tmp/canary.mjs
 *
 * Runs the app's own LicenseService with the pinned production verification key against
 * https://www.tenuvault.com: the service is healthy, the canary key activates for a fixed
 * canary tenant and installation, the token verifies offline as a shipped app verifies it, a
 * refresh succeeds, an unknown key is refused as not_found, and the activation is released
 * again. Any failure exits 1, so the scheduled workflow (.github/workflows/license-canary.yml)
 * fails and GitHub emails the maintainer. Unlike the website's own 15 minute check it runs
 * outside Vercel, so it also notices when that check has stopped running.
 *
 * The canary key is a dedicated Pro key of the owner's Polar customer that nothing else uses.
 * The tenant and installation ids below are random ids no real tenant has; each run releases
 * its activation, so the key never holds more than one tenant slot.
 */
import { CommunityLimitError } from "../src/shared/plan-errors"
import { LicenseService } from "../src/main/license/service"
import { licensePublicKeyFingerprint, PRODUCTION_LICENSE_PUBLIC_KEY_FINGERPRINT } from "./license-public-key"

/** The production verification key, as shipped in 0.4.2 and the nightlies; checked against the pinned fingerprint below. */
export const PRODUCTION_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAh/aEyyt/J6FTGT43Pit8wgz3oJfCAhSmZYfdAMQDzYg=
-----END PUBLIC KEY-----`

const API_BASE = "https://www.tenuvault.com"
const CANARY_TENANT = "c0a1b2c3-d4e5-4f60-8a71-9b0c1d2e3f40"
const CANARY_INSTALL = "c0a1b2c3-d4e5-4f60-8a71-9b0c1d2e3f41"
// Shows up as this version in the service's outcome log, apart from real apps.
const APP_VERSION = "0.0.1-canary"

function memoryStore(installId: string) {
  const values = new Map<string, string>([["license.installId", installId]])
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => void values.set(key, value),
    delete: (key: string) => void values.delete(key),
  }
}

const service = (installId: string) =>
  new LicenseService({
    store: memoryStore(installId),
    persist: false,
    publicKey: PRODUCTION_LICENSE_PUBLIC_KEY,
    apiBase: API_BASE,
    appVersion: APP_VERSION,
    platform: "linux",
  })

const failures: string[] = []
async function step(name: string, run: () => Promise<string | void>): Promise<void> {
  const started = Date.now()
  try {
    const detail = await run()
    console.log(`ok   ${name} (${Date.now() - started} ms)${detail ? `: ${detail}` : ""}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${name}: ${message}`)
    console.log(`FAIL ${name} (${Date.now() - started} ms): ${message}`)
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function main(): Promise<void> {
  if (licensePublicKeyFingerprint(PRODUCTION_LICENSE_PUBLIC_KEY) !== PRODUCTION_LICENSE_PUBLIC_KEY_FINGERPRINT) {
    throw new Error("The canary's verification key is not the pinned production key (scripts/license-public-key.ts).")
  }
  const key = process.env.LICENSING_CANARY_KEY?.trim()
  if (!key) throw new Error("LICENSING_CANARY_KEY is not set.")

  await step("service health", async () => {
    const response = await fetch(`${API_BASE}/api/desktop-license/health`, { redirect: "error", signal: AbortSignal.timeout(30_000) })
    const body = (await response.json()) as { ok?: boolean; missing?: string[] }
    check(response.ok && body.ok === true, `health answered ${response.status}: ${JSON.stringify(body.missing ?? [])}`)
  })

  const license = service(CANARY_INSTALL)
  await step("activate the canary key", async () => {
    await license.setKey(key, [CANARY_TENANT])
    const tenant = license.status([CANARY_TENANT]).tenants[0]
    check(tenant?.entitled === true, `not entitled: ${tenant?.message ?? "no message"}`)
    check(tenant?.plan === "pro", `plan ${String(tenant?.plan)}, expected pro`)
    return `entitled until ${tenant?.expiresAt}`
  })

  await step("verify offline with the shipped key", async () => {
    // The same check a shipped app makes before every tenant use, without a network call.
    check((await license.requireEntitlement(CANARY_TENANT)) === "pro", "the cached token does not entitle the tenant")
    check(license.entitlementToken(CANARY_TENANT) !== null, "no valid token is stored")
  })

  await step("refresh", async () => {
    await license.refreshAll()
    const status = license.status([CANARY_TENANT])
    check(!status.offline, "the refresh did not reach the licensing service")
    check(status.tenants[0]?.entitled === true, `not entitled after refresh: ${status.tenants[0]?.message ?? "no message"}`)
  })

  await step("refuse an unknown key", async () => {
    const other = service("c0a1b2c3-d4e5-4f60-8a71-9b0c1d2e3f42")
    const error = await other.setKey("TENU-CANARY-UNKNOWN-0000-0000", [CANARY_TENANT]).then(() => null, (caught: unknown) => caught)
    check(error instanceof Error && !(error instanceof CommunityLimitError), "an unknown key was accepted")
    check(/not valid, or it has been revoked or has expired/.test((error as Error).message), `unexpected answer: ${(error as Error).message}`)
  })

  await step("release the activation", async () => {
    await license.deactivate()
    check(license.status([CANARY_TENANT]).hasKey === false, "the key is still saved after deactivation")
  })

  if (failures.length > 0) {
    for (const failure of failures) console.log(`::error title=Licensing canary::${failure}`)
    process.exit(1)
  }
  console.log("The buyer path works: activate, verify offline, refresh, refuse and release.")
}

if (!process.versions.electron) {
  main().catch((error: unknown) => {
    console.log(`::error title=Licensing canary::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
