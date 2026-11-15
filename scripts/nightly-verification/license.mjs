/**
 * Nightly verification, paid key: the installed app activates the licensing canary's Pro key
 * against production for the canary tenant, the same key and ids scripts/license-canary.ts uses.
 *
 *   NIGHTLY_VERIFY_APP=<installed executable> LICENSING_CANARY_KEY=<key> node scripts/nightly-verification/license.mjs [screenshot-dir]
 *
 * With a throwaway profile, through the app's own UI and preload bridge: the key is entered on
 * the welcome screen, the canary tenant is checked as a newly connected tenant would be (this
 * activates the key for it), the License page shows Pro for it, a refresh succeeds, the app is
 * restarted and still has the key (the OS credential store round trip), and the activation is
 * released at the end, also when a step failed. Exits 1 on any failure.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { assert, checker, launch } from "./app.mjs"

/** The canary tenant and the key's plan, as in scripts/license-canary.ts. */
export const CANARY_TENANT = "c0a1b2c3-d4e5-4f60-8a71-9b0c1d2e3f40"

const appPath = process.env.NIGHTLY_VERIFY_APP
const key = process.env.LICENSING_CANARY_KEY?.trim()
const shotsDir = resolve(process.argv[2] ?? join(process.cwd(), "out", "nightly-license"))
const { check, failures } = checker()

/** True when any file in the profile holds `secret` in plain text. */
function plainTextIn(dir, secret) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    let stats
    try {
      stats = statSync(path)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      if (plainTextIn(path, secret)) return true
    } else if (stats.size < 50_000_000) {
      try {
        if (readFileSync(path).includes(secret)) return true
      } catch {
        /* locked by the app */
      }
    }
  }
  return false
}

/** The license state and the app's license log lines, without the key, for a failure message. */
function diagnose(status, app) {
  const summary = {
    hasKey: status?.hasKey,
    keyState: status?.keyState,
    keyMessage: status?.keyMessage ?? null,
    message: status?.message ?? null,
    offline: status?.offline,
    tenants: (status?.tenants ?? []).map(({ tenantId, activated, entitled, source, plan, message }) => ({ tenantId, activated, entitled, source, plan, message })),
  }
  const log = app.log().split("\n").filter((line) => /\[license\]/i.test(line)).slice(-20).join("\n")
  return `License status: ${JSON.stringify(summary)}\nLicense log:\n${log}`.split(key).join("<key>")
}

const canaryRow = (status) => status?.tenants?.find((tenant) => tenant.tenantId === CANARY_TENANT) ?? null

async function main() {
  if (!appPath) throw new Error("NIGHTLY_VERIFY_APP is not set to the installed executable.")
  if (!key) throw new Error("LICENSING_CANARY_KEY is not set. Add the canary Pro key as a repository secret (RELEASING.md).")
  const profile = mkdtempSync(join(tmpdir(), "tenuvault-nightly-license-"))
  let app = null
  let activated = false
  try {
    const started = await check("the installed app opens its welcome screen", async () => {
      app = await launch(appPath, profile, shotsDir)
      assert(await app.waitForText("Welcome to TenuVault", 60_000), "The welcome screen did not appear.")
      const info = await app.evaluate("window.tenuvault.app.info()")
      return `version ${info?.version ?? "unknown"}`
    })
    if (!started) return

    await check("the canary key is saved on the welcome screen", async () => {
      await app.click("I have a license key")
      assert(await app.waitFor(`Boolean(document.querySelector('input[name="license-key"]'))`), "The license key field did not open.")
      await app.fill('input[name="license-key"]', key)
      await app.click("Save key")
      assert(await app.waitFor("window.tenuvault.license.status().then((s) => s.hasKey)"), "The key was not saved.")
      await app.screenshot("01-key-saved")
    })

    await check("the canary key activates for the canary tenant against production", async () => {
      // What the app does when a tenant signs in for the first time with a saved key.
      activated = true
      const status = await app.evaluate(`window.tenuvault.license.checkNewTenant(${JSON.stringify(CANARY_TENANT)})`)
      const row = canaryRow(status)
      assert(row?.entitled === true, `The canary tenant is not entitled: ${row?.message ?? status?.keyMessage ?? "no message"}`)
      assert(row.plan === "pro", `The canary tenant has plan ${String(row.plan)}, expected pro.`)
      assert(row.source === "key", `The canary tenant is licensed through ${String(row.source)}, expected the key.`)
      assert(status.keyState === "active", `The key state is ${String(status.keyState)}, expected active.`)
      return `entitled until ${row.expiresAt}`
    })

    await check("the License page shows Pro for the canary tenant", async () => {
      await app.evaluate(`location.hash = "#/license"`)
      const row = `[...document.querySelectorAll("main p")].find((p) => p.textContent === ${JSON.stringify(CANARY_TENANT)})?.closest("div.space-y-2")`
      assert(await app.waitFor(`${row}?.innerText.includes("Active, Pro")`), "The License page does not show the canary tenant as Active, Pro.")
      await app.screenshot("02-license-pro")
    })

    await check("the key is stored encrypted, not in plain text", async () => {
      assert(!plainTextIn(profile, key), "The license key is readable in plain text in the profile folder.")
    })

    await check("a refresh reaches the licensing service and keeps Pro", async () => {
      const status = await app.evaluate("window.tenuvault.license.refresh()")
      assert(!status.offline, "The refresh did not reach the licensing service.")
      const row = canaryRow(status)
      if (!(row?.entitled === true && row.plan === "pro")) {
        throw new Error(`Not entitled to Pro after the refresh: ${row?.message ?? status.keyMessage ?? status.message ?? "the activation is gone"}\n${diagnose(status, app)}`)
      }
      return `entitled until ${row.expiresAt}`
    })
    await check("the key survives a restart (OS credential store round trip)", async () => {
      await app.close()
      app = await launch(appPath, profile, shotsDir)
      assert(await app.waitFor("Boolean(window.tenuvault?.license)", 60_000), "The restarted app has no window.")
      // The key comes back from the encrypted store. The canary tenant's activation may already be
      // gone: on start the app releases activations of tenants that are not connected, and the
      // canary tenant never is.
      const status = await app.evaluate("window.tenuvault.license.status()")
      assert(status.hasKey === true, "After a restart the saved key is gone.")
      assert(status.keyState !== "failed", `After a restart the saved key failed: ${status.keyMessage ?? "no message"}`)
    })
  } finally {
    if (activated) await release(app, profile)
    await app?.close().catch(() => {})
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    } catch (error) {
      console.warn(`Could not remove the profile: ${error.message}`)
    }
  }
}

/** Releases the activation, restarting the app with the same profile when it is gone. */
async function release(current, profile) {
  await check("the activation is released", async () => {
    let app = current
    const alive = app && (await app.evaluate("Boolean(window.tenuvault?.license)").catch(() => false))
    if (!alive) {
      await app?.close().catch(() => {})
      // Whatever version starts, the activation must not stay behind.
      app = await launch(appPath, profile, shotsDir, { checkVersion: false })
      assert(await app.waitFor("Boolean(window.tenuvault?.license)", 60_000), "The app could not be restarted to release the activation.")
    }
    const status = await app.evaluate("window.tenuvault.license.deactivate()")
    assert(status.hasKey === false, "The key is still saved after deactivation.")
    assert(!canaryRow(status)?.activated, "The canary tenant is still activated.")
    if (app !== current) await app.close()
  })
}

main()
  .catch((error) => failures.push(error instanceof Error ? error.message : String(error)))
  .finally(() => {
    if (failures.length > 0) {
      for (const failure of failures) console.log(`::error title=Nightly paid key::${failure.split("\n")[0]}`)
      process.exit(1)
    }
    console.log("The installed nightly activates, shows, keeps, refreshes and releases the canary Pro key.")
    process.exit(0)
  })
