/**
 * Licensing behind an HTTPS-inspecting proxy, with the app's own network stack and LicenseService
 * in real Chromium (Electron). Run per stable release; the procedure and the dated results are in
 * docs/license-network-checks.md.
 *
 * MODE=trusted    the inspection CA (CA_PEM) is trusted: activate KEY, refresh, release.
 * MODE=untrusted  it is not: activation must fail with the certificate guidance.
 * MODE=blocked    the proxy answers tenuvault.com with an HTML block page (license-mitm-block.py):
 *                 a tenant with a cached token (CACHED_STATE, printed by a trusted run) stays
 *                 licensed, and a new activation names a firewall block.
 *
 * The proxy listens on 127.0.0.1:18081. On Linux the trusted CA is passed to Chromium with
 * --ignore-certificate-errors-spki-list, which stands in for installing it in the OS store.
 */
import { app, net, session } from "electron"
import { createHash, X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import { createChromiumFetch } from "../src/main/chromium-fetch"
import { rejectProxyAuthResponses } from "../src/main/api/network-error"
import { LicenseService } from "../src/main/license/service"
import { PRODUCTION_LICENSE_PUBLIC_KEY } from "./license-canary"

const mode = process.env.MODE ?? "trusted"
if (mode !== "untrusted") {
  const ca = new X509Certificate(readFileSync(process.env.CA_PEM ?? ""))
  const spki = createHash("sha256").update(ca.publicKey.export({ type: "spki", format: "der" })).digest("base64")
  app.commandLine.appendSwitch("ignore-certificate-errors-spki-list", spki)
}

const noProxyAuth = { login: () => Promise.resolve(null), responded: () => {} }
const chromiumFetch = rejectProxyAuthResponses(createChromiumFetch((options) => net.request(options), () => noProxyAuth))
// Random ids no real tenant or installation has, as the licensing canary uses.
const TENANT = "c0a1b2c3-d4e5-4f60-8a71-9b0c1d2e3f40"
const values = new Map<string, string>([["license.installId", "c0a1b2c3-d4e5-4f60-8a71-9b0c1d2e3f43"]])
const store = {
  get: (key: string) => values.get(key) ?? null,
  set: (key: string, value: string) => void values.set(key, value),
  delete: (key: string) => void values.delete(key),
}
const service = () =>
  new LicenseService({
    store,
    persist: true,
    publicKey: PRODUCTION_LICENSE_PUBLIC_KEY,
    apiBase: "https://www.tenuvault.com",
    appVersion: "0.0.1-mitmcheck",
    platform: process.platform,
    fetch: chromiumFetch,
  })
const log = (line: string) => console.log(`CHECK ${line}`)

app.whenReady().then(async () => {
  await session.defaultSession.setProxy({ proxyRules: "http://127.0.0.1:18081" })
  const key = process.env.KEY ?? ""
  try {
    if (mode === "blocked") {
      values.set("license.state", process.env.CACHED_STATE ?? "")
      const cached = service()
      await cached.refreshAll()
      const status = cached.status([TENANT])
      log(`block page refresh: entitled=${status.tenants[0]?.entitled} offline=${status.offline}`)
      values.delete("license.state")
      const outcome = await service().setKey(key, [TENANT]).then(() => "activated", (error: Error) => error.message)
      log(`block page activation: ${outcome}`)
    } else {
      const license = service()
      const outcome = await license.setKey(key, [TENANT]).then(() => "activated", (error: Error) => error.message)
      log(`${mode} activation: ${outcome}; entitled=${license.status([TENANT]).tenants[0]?.entitled}`)
      if (outcome === "activated") {
        console.log(`STATE ${values.get("license.state")}`)
        await license.refreshAll()
        const status = license.status([TENANT])
        log(`${mode} refresh: entitled=${status.tenants[0]?.entitled} offline=${status.offline}`)
        await license.deactivate()
        log(`${mode} release: hasKey=${license.status([TENANT]).hasKey}`)
      }
    }
  } catch (error) {
    log(`FAILED ${error instanceof Error ? error.stack : String(error)}`)
  }
  app.quit()
})
