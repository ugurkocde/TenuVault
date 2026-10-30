/**
 * Smoke test for the built app (run `npm run build` first).
 *
 *   node scripts/smoke.mjs [screenshot-dir] [license-key-file]
 *
 * Set TENUVAULT_SMOKE_APP to a packaged executable to test an installer build instead
 * of the development build.
 *
 * Launches Electron with a throwaway profile, drives it over the Chrome DevTools
 * Protocol and checks the first-run welcome screen, the shell, the portal pages, the
 * renderer-to-main API bridge and the per tenant license gate. No tenant is signed in, so
 * the licensing service is never called. Screenshots are written to screenshot-dir.
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { checkSchedulePanel } from "./schedule-panel-smoke.mjs"
import { checkBackupCancel } from "./backup-cancel-smoke.mjs"

const require = createRequire(import.meta.url)
const electronPath = require("electron")
const desktopDir = resolve(import.meta.dirname, "..")
const shotsDir = resolve(process.argv[2] ?? join(desktopDir, "out", "smoke"))

const licenseKey = process.argv[3] ? readFileSync(process.argv[3], "utf8").trim() : null
const port = 9300 + Math.floor(Math.random() * 500)
const inspectorPort = port + 500
const profile = mkdtempSync(join(tmpdir(), "tenuvault-smoke-"))
mkdirSync(shotsDir, { recursive: true })

const packagedApp = process.env.TENUVAULT_SMOKE_APP
const args = [...(packagedApp ? [] : [desktopDir]), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`]
if (!packagedApp) args.push(`--inspect=127.0.0.1:${inspectorPort}`)
if (process.platform === "linux") args.push("--no-sandbox")
// Development smoke profiles use a mock keychain; packaged runs exercise the real Keychain by default.
if (process.platform === "darwin" && (!packagedApp || process.env.TENUVAULT_SMOKE_MOCK_KEYCHAIN === "1")) args.push("--use-mock-keychain")
// Tools that are themselves Electron apps may export ELECTRON_RUN_AS_NODE, which would start plain Node.
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" }
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(packagedApp ?? electronPath, args, { stdio: ["ignore", "pipe", "pipe"], env })
let appLog = ""
app.stdout.on("data", (d) => (appLog += d))
app.stderr.on("data", (d) => (appLog += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((t) => t.type === "page")
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error(`App did not expose a page target. App log:\n${appLog.slice(-4000)}`)
}

const ws = new WebSocket(await connect())
await new Promise((r) => ws.addEventListener("open", r, { once: true }))
let nextId = 1
let renderFailures = 0
// Render failures the error-boundary check provokes on purpose; any beyond
// this count fail the run at the end.
let expectedRenderFailures = 0
let unhandledRejections = 0
const pending = new Map()
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data)
  if (message.method === "Runtime.consoleAPICalled" && message.params.args[0]?.value === "Screen failed to render:") {
    renderFailures++
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.args[0]?.value === "Unhandled promise rejection:") {
    unhandledRejections++
  }
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})
const send = (method, params = {}) =>
  new Promise((resolveSend, rejectSend) => {
    const id = nextId++
    // A crashed app never answers; fail the check instead of hanging the job.
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectSend(new Error(`${method} timed out`))
    }, 30000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolveSend(message)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })

async function evaluate(expression) {
  const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed")
  return result.result.value
}

async function waitForCondition(expression, timeout = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return true
    await sleep(250)
  }
  return false
}

async function waitForText(text, timeout = 20000) {
  return waitForCondition(`document.body?.innerText.includes(${JSON.stringify(text)})`, timeout)
}

async function screenshot(name) {
  const { result } = await send("Page.captureScreenshot", { format: "png" })
  writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(result.data, "base64"))
}

async function check(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name}: ${error.message}`)
    await screenshot(`fail-${name.replace(/\W+/g, "-")}`).catch(() => {})
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function go(hash, text) {
  await evaluate(`location.hash = ${JSON.stringify(hash)}`)
  assert(await waitForText(text), `"${text}" did not appear on ${hash}`)
}

// Text the sidebar always shows (a page's own nav label) also matches waitForText on a
// crashed page, so nav-named pages assert their content inside <main> and no error
// boundary. Pages show ordinary alert banners too, so the crash signature is the
// boundary title itself.
async function assertPageInMain(text, message) {
  assert(await waitForCondition(`document.querySelector('main')?.innerText.includes(${JSON.stringify(text)})`), `${message}: "${text}" did not appear in the page`)
  assert(!(await evaluate(`document.querySelector('main')?.innerText.includes("This screen could not be loaded")`)), `${message}: the page failed behind the error boundary`)
}

await send("Page.enable")
await send("Runtime.enable")

// Virtual displays (Xvfb in CI) never produce animation frames, which would freeze CSS
// enter animations at opacity 0. Turn animations off so screenshots are deterministic.
async function disableAnimations() {
  await evaluate(`(() => {
    if (document.getElementById("smoke-no-animations")) return
    const style = document.createElement("style")
    style.id = "smoke-no-animations"
    style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }"
    document.head.appendChild(style)
  })()`)
}

await check("first run shows the welcome screen", async () => {
  assert(await waitForText("Welcome to TenuVault", 30000), "welcome screen did not appear")
  await disableAnimations()
  assert(!(await evaluate(`document.body.innerText.includes("Backup & Restore")`)), "welcome screen missing, app shown instead")
  assert(await waitForText("Start free with Community"), "Community call to action missing")
  assert(await waitForText("Try Pro or MSP free for 30 days"), "trial call to action missing")
  await screenshot("00-welcome")
})

await check("a pending license retry shows progress without overlapping requests", async () => {
  try {
    await evaluate(`(async () => {
      const status = await window.tenuvault.license.status()
      window.__licenseRetry = { calls: 0 }
      const frame = document.createElement("iframe")
      frame.style.cssText = "position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 9999;"
      document.body.appendChild(frame)
      window.__licenseRetryFrame = frame
      // Run the built renderer with a mock status response, without changing the frozen preload bridge.
      frame.contentWindow.tenuvault = {
        ...window.tenuvault,
        license: {
          ...window.tenuvault.license,
          status: () => {
            window.__licenseRetry.calls++
            // Tenant storage reads status before the license provider checks it.
            if (window.__licenseRetry.calls === 1) return Promise.resolve(status)
            if (window.__licenseRetry.calls === 2) return Promise.reject(new Error("Smoke license status failure"))
            return new Promise(resolve => { window.__licenseRetry.resolve = () => resolve(status) })
          },
        },
      }
      const setInterval = frame.contentWindow.setInterval.bind(frame.contentWindow)
      frame.contentWindow.setInterval = (callback, delay, ...args) => {
        if (delay === 5 * 60 * 1000) window.__licenseRetry.refresh = callback
        return setInterval(callback, delay, ...args)
      }
      frame.contentDocument.body.innerHTML = '<div id="root"></div>'
      document.querySelectorAll('link[rel="stylesheet"]').forEach(link => frame.contentDocument.head.appendChild(link.cloneNode()))
      const script = frame.contentDocument.createElement("script")
      script.type = "module"
      script.src = document.querySelector('script[type="module"]').src
      frame.contentDocument.head.appendChild(script)
    })()`)
    const body = `window.__licenseRetryFrame.contentDocument.body`
    assert(await waitForCondition(`${body}.innerText.includes("Could not load license status")`), "startup license error missing")
    const beforeRetry = await evaluate(`window.__licenseRetry.calls`)
    await evaluate(`(() => {
      const retry = [...${body}.querySelectorAll("button")].find(b => b.textContent === "Retry")
      retry.click()
      retry.click()
    })()`)
    assert(await waitForCondition(`Boolean(${body}.querySelector(".animate-spin")) && !${body}.querySelector('[role="alert"]')`), "pending retry did not show the spinner")
    await evaluate(`window.__licenseRetry.refresh()`)
    assert(await evaluate(`window.__licenseRetry.calls === ${beforeRetry + 1}`), "pending retry started overlapping status requests")
    await evaluate(`window.__licenseRetry.resolve()`)
    assert(await waitForCondition(`${body}.innerText.includes("Welcome to TenuVault") && !${body}.querySelector(".animate-spin")`), "successful retry did not open the welcome screen")
  } finally {
    await evaluate(`window.__licenseRetryFrame?.remove(); delete window.__licenseRetryFrame; delete window.__licenseRetry`)
  }
})

await check("hung license checks time out and ignore late responses after retry", async () => {
  try {
    await evaluate(`(async () => {
      const status = await window.tenuvault.license.status()
      window.__licenseTimeout = { calls: 0, expired: 0, timers: new Set(), status }
      const frame = document.createElement("iframe")
      frame.style.cssText = "position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 9999;"
      document.body.appendChild(frame)
      window.__licenseTimeoutFrame = frame
      // Give the router the app's URL instead of about:blank.
      frame.contentDocument.open()
      frame.contentDocument.write('<html><head></head><body><div id="root"></div></body></html>')
      frame.contentDocument.close()
      frame.contentWindow.location.hash = "#/portal/onboarding"
      frame.contentWindow.tenuvault = {
        ...window.tenuvault,
        license: {
          ...window.tenuvault.license,
          status: () => {
            const call = ++window.__licenseTimeout.calls
            // The first call belongs to tenant storage, before the provider starts.
            if (call === 2) return new Promise(resolve => {
              window.__licenseTimeout.resolveFirst = () => resolve({ ...status, hasKey: true })
            })
            if (call === 4) return new Promise(resolve => {
              window.__licenseTimeout.resolveBackground = () => resolve({ ...status, hasKey: true })
            })
            return Promise.resolve(status)
          },
          onChanged: listener => {
            window.__licenseTimeout.onChanged = listener
            return () => { window.__licenseTimeout.onChanged = null }
          },
        },
      }
      const setTimeout = frame.contentWindow.setTimeout.bind(frame.contentWindow)
      const clearTimeout = frame.contentWindow.clearTimeout.bind(frame.contentWindow)
      frame.contentWindow.setTimeout = (callback, delay, ...args) => {
        if (delay !== 30000) return setTimeout(callback, delay, ...args)
        // Shorten only the renderer's 30-second deadline in this isolated smoke frame.
        const timer = setTimeout(() => {
          window.__licenseTimeout.expired++
          callback(...args)
        }, 2000)
        window.__licenseTimeout.timers.add(timer)
        return timer
      }
      frame.contentWindow.clearTimeout = timer => {
        window.__licenseTimeout.timers.delete(timer)
        clearTimeout(timer)
      }
      const setInterval = frame.contentWindow.setInterval.bind(frame.contentWindow)
      frame.contentWindow.setInterval = (callback, delay, ...args) => {
        if (delay === 5 * 60 * 1000) window.__licenseTimeout.refresh = callback
        return setInterval(callback, delay, ...args)
      }
      document.querySelectorAll('link[rel="stylesheet"]').forEach(link => frame.contentDocument.head.appendChild(link.cloneNode()))
      const script = frame.contentDocument.createElement("script")
      script.type = "module"
      script.src = document.querySelector('script[type="module"]').src
      frame.contentDocument.head.appendChild(script)
    })()`)
    const body = `window.__licenseTimeoutFrame.contentDocument.body`
    assert(await waitForCondition(`window.__licenseTimeout.calls === 2 && Boolean(${body}.querySelector(".animate-spin"))`), "hung startup check did not show the spinner")
    await evaluate(`window.__licenseTimeout.refresh()`)
    assert(await evaluate(`window.__licenseTimeout.calls === 2`), "hung startup check allowed an overlapping request")
    assert(await waitForCondition(`${body}.innerText.includes("The license check did not respond. Try again.")`), "hung startup check did not display the timeout error")
    assert(await evaluate(`window.__licenseTimeout.timers.size === 0`), "timed-out license check did not clear its timer")
    assert(await evaluate(`[...${body}.querySelectorAll("button")].some(b => b.textContent === "Retry" && !b.disabled)`), "Retry is unavailable after the timeout")
    await evaluate(`[...${body}.querySelectorAll("button")].find(b => b.textContent === "Retry").click()`)
    assert(await waitForCondition(`window.__licenseTimeout.calls === 3 && ${body}.innerText.includes("Welcome to TenuVault")`), "Retry did not send a new request and recover")
    assert(await evaluate(`window.__licenseTimeout.timers.size === 0`), "successful license check did not clear its timer")
    await evaluate(`window.__licenseTimeout.resolveFirst()`)
    await sleep(250)
    assert(await evaluate(`${body}.innerText.includes("Welcome to TenuVault") && !${body}.querySelector('[role="alert"]')`), "late startup response overwrote the successful retry")
    await evaluate(`window.__licenseTimeout.refresh()`)
    assert(await evaluate(`window.__licenseTimeout.calls === 4 && ${body}.innerText.includes("Welcome to TenuVault")`), "background check did not keep the loaded status")
    await evaluate(`window.__licenseTimeout.onChanged({ ...window.__licenseTimeout.status, hasKey: true })`)
    assert(await waitForCondition(`${body}.innerText.includes("Backup & Restore")`), "license change was not delivered during the pending check")
    assert(await waitForCondition(`window.__licenseTimeout.expired === 2 && window.__licenseTimeout.timers.size === 0`), "hung background check did not time out")
    assert(await evaluate(`${body}.innerText.includes("Backup & Restore") && !${body}.querySelector('[role="alert"]')`), "background timeout discarded the loaded status")
    await evaluate(`window.__licenseTimeout.refresh()`)
    assert(await waitForCondition(`window.__licenseTimeout.calls === 5 && ${body}.innerText.includes("Welcome to TenuVault")`), "background timeout left the refresh guard locked")
    await evaluate(`window.__licenseTimeout.resolveBackground()`)
    await sleep(250)
    assert(await evaluate(`${body}.innerText.includes("Welcome to TenuVault")`), "late background response overwrote the current status")
  } finally {
    await evaluate(`window.__licenseTimeoutFrame?.remove(); delete window.__licenseTimeoutFrame; delete window.__licenseTimeout`)
  }
})

await check("malformed license keys are rejected", async () => {
  await evaluate(`(() => {
    const input = document.getElementById("license-key")
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "abc")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })()`)
  await sleep(100)
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.innerText.trim() === "Save key").click()`)
  assert(await waitForText("Enter a valid license key"), "no error for a malformed key")
})

// Without a key, Community (or a license shared by the organization) starts at the tenant sign-in.
await check("Community users can reach the tenant sign-in without a key", async () => {
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.innerText.trim() === "Start free with Community").click()`)
  assert(await waitForText("Set up TenuVault", 15000), "tenant sign-in did not open")
  assert(await waitForText("Backup & Restore"), "app did not open")
})

await check("dashboard renders in the desktop shell", async () => {
  await disableAnimations()
  await go("#/portal/dashboard", "Dashboard")
  await assertPageInMain("Protect your Intune policies", "dashboard")
  await sleep(1000)
  await screenshot("01-dashboard")
})

await check("a failed page keeps the sidebar and offers recovery", async () => {
  await send("Network.enable")
  await send("Network.setBlockedURLs", { urls: ["*OverviewPage-*.js"] })
  try {
    await go("#/portal/overview", "This screen could not be loaded")
    assert(await evaluate(`Boolean(document.querySelector('main [role="alert"]'))`), "error panel is outside the layout")
    assert(await evaluate(`document.querySelector('main [role="alert"] p').textContent.length > 0`), "error message missing")
    const beforeRetry = renderFailures
    await evaluate(`[...document.querySelectorAll('main button')].find(b => b.textContent === 'Try again').click()`)
    for (let attempt = 0; renderFailures <= beforeRetry && attempt < 20; attempt++) await sleep(100)
    assert(await waitForCondition(`Boolean(document.querySelector('main [role="alert"]'))`), "failed retry left a blank page")
    assert(renderFailures > beforeRetry, "Try again did not re-render the failed page")
    await screenshot("01b-page-error")
    await evaluate(`document.querySelector('nav a[href="#/portal/dashboard"]').click()`)
    assert(await waitForCondition(`document.querySelector('main')?.innerText.includes('Protect your Intune policies') && !document.querySelector('main [role="alert"]')`), "sidebar did not open a healthy page")
    await send("Network.setBlockedURLs", { urls: [] })
    // React keeps a rejected lazy import. Reload retries the module after the failure is removed.
    await go("#/portal/overview", "This screen could not be loaded")
    await evaluate(`[...document.querySelectorAll('main button')].find(b => b.textContent === 'Reload').click()`)
    assert(await waitForText("Welcome to TenuVault"), "Reload did not restart the app")
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Start free with Community')).click()`)
    await go("#/portal/overview", "All tenants")
    assert(await waitForCondition(`Boolean(document.querySelector('main h1')?.textContent.includes('All tenants'))`), "Reload did not recover the page")
    await go("#/portal/dashboard", "Dashboard")
    await disableAnimations()
    // The failures above were provoked on purpose; later ones are real.
    expectedRenderFailures = renderFailures
  } finally {
    await send("Network.setBlockedURLs", { urls: [] })
  }
})

await check("unhandled promise rejections are logged without replacing the page", async () => {
  const beforeRejection = unhandledRejections
  await evaluate(`void Promise.reject(new Error('Smoke unhandled rejection'))`)
  for (let attempt = 0; unhandledRejections <= beforeRejection && attempt < 20; attempt++) await sleep(100)
  assert(unhandledRejections > beforeRejection, "unhandled rejection was not logged")
  assert(await evaluate(`document.querySelector('main')?.innerText.includes('Protect your Intune policies') && !document.querySelector('main [role="alert"]')`), "unhandled rejection replaced the page")
})

await check("preload bridge is isolated", async () => {
  assert(await evaluate(`typeof window.tenuvault?.api === "function"`), "window.tenuvault missing")
  assert(await evaluate(`typeof require === "undefined" && typeof process === "undefined"`), "Node APIs leaked into renderer")
})

await check("renderer fetch reaches the main-process API host", async () => {
  const result = await evaluate(`fetch("/api/list-backups", { method: "POST", body: "{}" }).then(async r => [r.status, (await r.json()).error])`)
  assert(result[0] === 400 && /Missing required parameters/.test(result[1]), `unexpected response ${JSON.stringify(result)}`)
})

await check("platform sign-in support", async () => {
  const info = await evaluate(`window.tenuvault.app.info()`)
  console.log(`     ${JSON.stringify(info)}`)
  assert(info.trayIconLoaded, "tray icon image did not load")
})

await check("license page asks for a license and offers the free trial", async () => {
  await go("#/license", "Add your license")
  assert(await waitForText("Official TenuVault builds are licensed under the license agreement"), "license agreement link missing on the license page")
  assert(await waitForText("Start 30 day free trial"), "trial call to action missing")
  const status = await evaluate(`window.tenuvault.license.status()`)
  assert(!status.hasKey && status.tenants.length === 0, `unexpected license state ${JSON.stringify(status)}`)
  await screenshot("02-license-none")
})

await check("license key expiry stays separate from offline verification and warns with the right priority", async () => {
  try {
    await evaluate(`(async () => {
      const status = await window.tenuvault.license.status()
      const tenant = {
        tenantId: "11111111-2222-3333-4444-555555555555",
        signedIn: true, activated: true, entitled: true, source: "key", plan: "pro", tenants: 1,
        expiresAt: new Date(Date.now() + 86400000).toISOString(), validUntil: null,
        shared: false, shareNeedsSignIn: false, displayKey: null, message: null,
      }
      window.__licenseExpiry = {
        status: { ...status, hasKey: true, plan: "pro", tenantLimit: 1, validUntil: null, tenants: [tenant] },
      }
      const frame = document.createElement("iframe")
      frame.style.cssText = "position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 9999;"
      document.body.appendChild(frame)
      window.__licenseExpiryFrame = frame
      frame.contentDocument.open()
      frame.contentDocument.write('<html><head></head><body><div id="root"></div></body></html>')
      frame.contentDocument.close()
      frame.contentWindow.location.hash = "#/license"
      frame.contentWindow.tenuvault = {
        ...window.tenuvault,
        license: {
          ...window.tenuvault.license,
          status: () => Promise.resolve(window.__licenseExpiry.status),
          onChanged: listener => {
            window.__licenseExpiry.onChanged = listener
            return () => { window.__licenseExpiry.onChanged = null }
          },
        },
      }
      document.querySelectorAll('link[rel="stylesheet"]').forEach(link => frame.contentDocument.head.appendChild(link.cloneNode()))
      const script = frame.contentDocument.createElement("script")
      script.type = "module"
      script.src = document.querySelector('script[type="module"]').src
      frame.contentDocument.head.appendChild(script)
    })()`)
    const body = "window.__licenseExpiryFrame.contentDocument.body"
    const banner = `${body}.querySelector('a[href="#/license"].bg-amber-50')`
    assert(await waitForCondition(`${body}.innerText.includes("Pro plan active") && ${body}.innerText.includes("Works offline until")`), "offline verification label missing")
    assert(await evaluate(`!${body}.innerText.includes("License valid until") && !${banner}`), "legacy token displayed a key expiry or warning")

    const setExpiry = async days => {
      const validUntil = days === null ? null : new Date(Date.now() + days * 86400000).toISOString()
      await evaluate(`(() => {
        const fixture = window.__licenseExpiry
        fixture.status = {
          ...fixture.status, validUntil: ${JSON.stringify(validUntil)},
          tenants: fixture.status.tenants.map(tenant => ({ ...tenant, validUntil: ${JSON.stringify(validUntil)} })),
        }
        fixture.onChanged(fixture.status)
      })()`)
      return validUntil
    }
    const dateText = iso => evaluate(`new Date(${JSON.stringify(iso)}).toLocaleDateString(undefined, { dateStyle: "medium" })`)
    const later = await setExpiry(45)
    const laterDate = await dateText(later)
    assert(await waitForCondition(`${body}.innerText.includes(${JSON.stringify(`License valid until ${laterDate}`)})`), "key expiry missing near the plan")
    assert(await evaluate(`!${banner}`), "key expiry warning appeared before 30 days")

    const soon = await setExpiry(20)
    const soonDate = await dateText(soon)
    const warning = `Your license key expires on ${soonDate}. Pro features stop unless it is renewed.`
    assert(await waitForCondition(`${banner}?.textContent.includes(${JSON.stringify(warning)})`), "30 day renewal warning missing")
    await evaluate(`(() => {
      const fixture = window.__licenseExpiry
      fixture.status = { ...fixture.status, offline: true }
      fixture.onChanged(fixture.status)
    })()`)
    assert(await waitForCondition(`${body}.innerText.includes("The licensing service could not be reached.")`), "offline fixture did not render")
    assert(await waitForCondition(`${banner}?.textContent.includes("Connect to the internet before")`), "the nearer offline deadline did not take priority over a later key expiry")
    const expired = await setExpiry(-1)
    const expiredDate = await dateText(expired)
    assert(await waitForCondition(`${banner}?.textContent.includes(${JSON.stringify(`Your license key expired on ${expiredDate}. Pro features stop unless it is renewed.`)})`), "expired key wording missing")
    await evaluate(`(() => {
      const fixture = window.__licenseExpiry
      fixture.status = { ...fixture.status, tenants: fixture.status.tenants.map(tenant => ({ ...tenant, entitled: false, plan: null })) }
      fixture.onChanged(fixture.status)
    })()`)
    assert(await waitForCondition(`${banner}?.textContent.includes("not covered by your")`), "uncovered tenant warning did not take priority")
  } finally {
    await evaluate("window.__licenseExpiryFrame?.remove(); delete window.__licenseExpiryFrame; delete window.__licenseExpiry")
  }
})

await check("the first tenant without a license works as Community", async () => {
  const tenant = "11111111-2222-3333-4444-555555555555"
  const body = JSON.stringify({
    tenantId: tenant,
    appId: "22222222-3333-4444-5555-666666666666",
    clientSecret: "tenuvault-desktop-delegated-auth",
    subscriptionId: "local",
    resourceGroupName: "local",
    storageAccountName: `tvlocal-${tenant}`,
  })
  const result = await evaluate(`fetch("/api/list-backups", { method: "POST", body: ${JSON.stringify(body)} }).then(async r => [r.status, await r.text()])`)
  // The license check passes as Community; the request then stops at the missing sign-in.
  assert(!/license|Community covers/i.test(result[1]), `the Community tenant was refused by the license: ${JSON.stringify(result)}`)
  const status = await evaluate(`window.tenuvault.license.status()`)
  assert(status.communityTenantId === tenant, `Community tenant not recorded: ${JSON.stringify(status)}`)
})

await check("tenants page offers delegated sign-in", async () => {
  await go("#/portal/tenants", "Tenants")
  await sleep(500)
  const opened = await evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find(b => /connect tenant/i.test(b.innerText))
    button?.click()
    return Boolean(button)
  })()`)
  assert(opened, "Connect tenant button not found")
  assert(await waitForText("Sign in with Microsoft"), "desktop add-tenant dialog did not open")
  assert(!(await evaluate(`document.body.innerText.includes("Client Secret")`)), "dialog still asks for a client secret")
  await screenshot("03-add-tenant")
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
})

await check("onboarding is the desktop wizard, without client secrets", async () => {
  await go("#/portal/onboarding", "Set up TenuVault")
  assert(await waitForText("Copy setup script"), "setup script step missing")
  assert(!(await evaluate(`/client secret/i.test(document.body.innerText) && !/no secret/i.test(document.body.innerText)`)), "wizard mentions client secrets")
  await screenshot("04-onboarding")
})

await check("settings show encrypted local backup storage", async () => {
  await go("#/portal/settings?section=storage", "Backups on this device")
  assert(await waitForText("Key fingerprint"), "encryption key section missing")
  await screenshot("05-settings")
})

await check("settings sidebar switches sections and names the section in the URL", async () => {
  await go("#/portal/settings", "Storage and recovery")
  const nav = `document.querySelector('nav[aria-label="Settings sections"]')`
  assert(await waitForCondition(`${nav}?.querySelectorAll("a").length === 8`), "settings sidebar does not list eight sections")
  assert(await evaluate(`document.getElementById("settings-storage").hidden === true`), "storage section visible on the default sign-in section")
  await evaluate(`[...${nav}.querySelectorAll("a")].find(a => a.textContent.trim() === "Background runner").click()`)
  assert(await waitForText("Keep backups for"), "background section did not appear after clicking its sidebar entry")
  assert(await evaluate(`location.hash === "#/portal/settings?section=background"`), "section not named in the URL")
  assert(await evaluate(`document.getElementById("settings-signin").hidden === true && !document.body.innerText.includes("Backups on this device")`), "only the clicked section should be visible")
  assert(await evaluate(`${nav}.querySelector('[aria-current="page"]')?.textContent.trim() === "Background runner"`), "active sidebar entry not marked")
  await evaluate(`[...${nav}.querySelectorAll("a")].find(a => a.textContent.trim() === "Sign-in").click()`)
  assert(await waitForCondition(`document.getElementById("settings-signin").hidden === false && location.hash === "#/portal/settings?section=signin"`), "sign-in section did not come back")
  // Unsaved input in a panel survives switching away and back.
  await evaluate(`[...${nav}.querySelectorAll("a")].find(a => a.textContent.trim() === "Storage and recovery").click()`)
  assert(await waitForText("Import a recovery key"), "storage section did not appear")
  await evaluate(`[...document.getElementById("settings-storage").querySelectorAll("button")].find(b => b.textContent.trim() === "Import a recovery key").click()`)
  const keyField = `document.getElementById("settings-storage").querySelector('textarea[aria-label="Recovery key"]')`
  assert(await waitForCondition(`Boolean(${keyField})`), "recovery key field did not open")
  await evaluate(`(() => { const field = ${keyField}; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'TVK2.smoke-draft'); field.dispatchEvent(new Event('input', {bubbles:true})); })()`)
  await evaluate(`[...${nav}.querySelectorAll("a")].find(a => a.textContent.trim() === "Updates").click()`)
  assert(await waitForCondition(`document.getElementById("settings-updates").hidden === false`), "updates section did not appear")
  await evaluate(`[...${nav}.querySelectorAll("a")].find(a => a.textContent.trim() === "Storage and recovery").click()`)
  assert(await waitForCondition(`${keyField}?.value === 'TVK2.smoke-draft'`), "switching sections discarded the recovery key draft")
  // An unknown section value falls back to sign-in instead of a blank page.
  await evaluate(`location.hash = "#/portal/settings?section=nope"`)
  assert(await waitForCondition(`document.getElementById("settings-signin").hidden === false`), "unknown section did not fall back to sign-in")
  // A link that only carries the recovery key anchor still opens storage and focuses the export.
  await evaluate(`location.hash = "#/portal/settings#recovery-key"`)
  assert(await waitForCondition(`document.getElementById("settings-storage").hidden === false && document.activeElement?.id === "save-recovery-key"`), "anchor-only recovery key link did not open storage and focus the export")
  // In the narrow row layout, scrolling the section strip must not move the focused export out of view.
  await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 720, deviceScaleFactor: 1, mobile: false })
  await evaluate(`location.hash = "#/portal/settings?section=signin"`)
  assert(await waitForCondition(`document.getElementById("settings-signin").hidden === false`), "sign-in section did not appear at narrow width")
  await evaluate(`location.hash = "#/portal/settings?section=storage#recovery-key"`)
  const focusedInView = `(() => { const button = document.getElementById("save-recovery-key"); if (document.activeElement !== button) return false; const box = button.getBoundingClientRect(); return box.top >= 0 && box.bottom <= window.innerHeight })()`
  assert(await waitForCondition(focusedInView), "focused Save recovery key ended outside the viewport at narrow width")
  await send("Emulation.clearDeviceMetricsOverride")
  // A dialog owned by a panel closes while its section is hidden and comes back with it.
  // Run this part with real exit animations so focus landing is checked after teardown.
  await evaluate(`document.getElementById("smoke-no-animations")?.remove()`)
  await evaluate(`location.hash = "#/portal/settings?section=about"`)
  assert(await waitForCondition(`document.getElementById("settings-about").hidden === false`), "about section did not appear")
  await evaluate(`[...document.getElementById("settings-about").querySelectorAll("button")].find(b => b.textContent.trim() === "License agreement").click()`)
  assert(await waitForText("TENUVAULT DESKTOP END USER LICENSE AGREEMENT"), "license agreement dialog did not open")
  await evaluate(`location.hash = "#/portal/settings?section=signin"`)
  assert(await waitForCondition(`!document.body.innerText.includes("TENUVAULT DESKTOP END USER LICENSE AGREEMENT")`), "dialog stayed open while its section was hidden")
  assert(await evaluate(`document.querySelectorAll('[role="dialog"]').length === 0`), "hidden panel left a dialog in the page")
  assert(await waitForCondition(`document.activeElement === document.querySelector('nav[aria-label="Settings sections"] [aria-current="page"]')`), "focus did not land on the active section entry after the dialog closed")
  await evaluate(`location.hash = "#/portal/settings?section=about"`)
  assert(await waitForText("TENUVAULT DESKTOP END USER LICENSE AGREEMENT"), "dialog did not come back with its section")
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Close").click()`)
  assert(await waitForCondition(`!document.body.innerText.includes("TENUVAULT DESKTOP END USER LICENSE AGREEMENT")`), "license agreement dialog did not close")
  await disableAnimations()
})

await check("license agreement opens from settings", async () => {
  await go("#/portal/settings?section=about", "License agreement")
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "License agreement").click()`)
  assert(await waitForText("TENUVAULT DESKTOP END USER LICENSE AGREEMENT"), "license agreement text missing")
  assert(await waitForText("Terms of Use"), "Terms of Use link missing")
  await screenshot("05b-license-agreement")
  await evaluate(`document.documentElement.classList.add('dark')`)
  await screenshot("05c-license-agreement-dark")
  await evaluate(`document.documentElement.classList.remove('dark')`)
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Close").click()`)
  assert(await waitForCondition(`!document.body.innerText.includes("TENUVAULT DESKTOP END USER LICENSE AGREEMENT")`, 5000), "license agreement did not close")
  assert(await waitForCondition(`document.activeElement?.textContent.trim() === "License agreement"`, 5000), "focus did not return to the license agreement link")
})

await check("native alert dialogs are replaced by toasts", async () => {
  await evaluate(`window.alert("Failed to do the thing")`)
  assert(await waitForText("Failed to do the thing"), "toast did not appear")
})

await check("drift detection page loads", async () => {
  await go("#/portal/drift", "Drift Detection")
  await assertPageInMain("Drift Detection", "drift detection page")
  await sleep(800)
  await screenshot("06-drift")
})

await check("framework catalog includes native providers and coming-soon CIS", async () => {
  await go("#/portal/frameworks", "Framework comparisons")
  assert(await waitForText("ISO/IEC 27001:2022"), "ISO reference missing")
  assert(await waitForText("SOC 2"), "SOC 2 reference missing")
  assert(await waitForText("UK MOD Def Stan 05-138"), "Def Stan reference missing")
  assert(await waitForText("Cyber Essentials"), "Cyber Essentials missing")
  assert(await evaluate(`document.querySelectorAll('a[href="#/portal/frameworks/cis-benchmarks"]').length === 0`), "CIS has active navigation")
  assert(!(await evaluate(`[...document.querySelectorAll('nav[aria-label="Main navigation"] a')].some(a => a.textContent.includes("CIS Benchmarks"))`)), "CIS sidebar item visible without the internal flag")
  assert(!(await evaluate(`[...document.querySelectorAll('[aria-label="Framework list"] a, [aria-label="Framework list"] span')].some(a => a.textContent.includes("CIS Benchmarks"))`)), "CIS still listed under Frameworks")
  await screenshot("14-framework-catalog")
  await go("#/portal/frameworks/cis-benchmarks", "CIS comparisons are coming soon.")
  assert(!(await evaluate(`document.body.innerText.includes("Choose your policy pack")`)), "CIS workflow mounted")
  await screenshot("15-cis-coming-soon")
  await go("#/portal/frameworks/iso-27001", "Compare your tenant")
  assert(await waitForText("Independent mapping · Community"), "Community availability missing")
  assert(!(await evaluate(`document.body.innerText.includes("Import policy JSON")`)), "native route rendered pack importer")
  // The scope and attribution notice starts collapsed and opens on demand.
  assert(await evaluate(`!document.querySelector("details summary")?.parentElement.open`), "about notice is expanded by default")
  await evaluate(`document.querySelector("details summary").click()`)
  assert(await waitForText("Edition: 2022, Annex A"), "native version not shown in the about notice")
  await evaluate(`document.querySelector("details summary").click()`)
  // The primary action must stand out from the card in both themes.
  const compareVisible = `(() => {
    const button = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Compare settings")
    if (!button) return false
    const style = getComputedStyle(button), card = getComputedStyle(button.closest("section"))
    return style.backgroundColor !== card.backgroundColor && style.color !== style.backgroundColor
  })()`
  for (const theme of ["light", "dark"]) {
    await evaluate(`document.documentElement.classList.toggle('dark', ${theme === "dark"})`)
    assert(await evaluate(compareVisible), `Compare settings is not visible in ${theme} mode`)
    await screenshot(theme === "dark" ? "17-native-framework-dark" : "16-native-framework")
  }
  await evaluate(`document.documentElement.classList.remove('dark')`)
})

await check("policy pack frameworks keep the coverage notice collapsed", async () => {
  for (const id of ["microsoft", "ncsc-dsg"]) {
    await go(`#/portal/frameworks/${id}`, "Choose your policy pack")
    const summary = `[...document.querySelectorAll("details summary")].find(s => s.textContent.includes("Assessment coverage"))`
    assert(await evaluate(`!!${summary}`), `${id}: coverage notice is not collapsible`)
    assert(await evaluate(`!${summary}.parentElement.open`), `${id}: coverage notice is expanded by default`)
    assert(!(await evaluate(`${summary}.parentElement.querySelector("div").checkVisibility()`)), `${id}: coverage details visible while collapsed`)
    await evaluate(`${summary}.click()`)
    assert(await evaluate(`${summary}.parentElement.open`), `${id}: coverage notice did not open`)
    await screenshot(`18-pack-framework-coverage-${id}`)
    await evaluate(`${summary}.click()`)
  }
})

await check("settings show background backups, retention and updates", async () => {
  await go("#/portal/settings?section=background", "Background runner")
  assert(await waitForText("Keep backups for"), "retention setting missing")
  assert(await evaluate(`document.body.innerText.includes("or a verified Backup Reader for scheduled backups")`), "background runner copy still claims a sign-in is always required")
  await go("#/portal/settings?section=updates", "Download and install updates automatically")
  assert(await waitForText("Get nightly builds"), "nightly update setting missing")
  const prefs = await evaluate(`window.tenuvault.preferences.set({ nightlyUpdates: true })`)
  assert(prefs.nightlyUpdates === true, `nightly preference not stored ${JSON.stringify(prefs)}`)
  await evaluate(`window.tenuvault.preferences.set({ nightlyUpdates: false })`)
})

for (const [platform, installed] of [["darwin", false], ["win32", true]]) {
  await check(`background runner status recovery and progress on ${platform}`, async () => {
    try {
      await evaluate(`(async () => {
        const status = await window.tenuvault.license.status()
        window.__runner = { calls: 0, installCalls: 0, removeCalls: 0 }
        const frame = document.createElement("iframe")
        frame.style.cssText = "position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 9999;"
        document.body.appendChild(frame)
        window.__runnerFrame = frame
        frame.contentDocument.open()
        frame.contentDocument.write('<html><head></head><body><div id="root"></div></body></html>')
        frame.contentDocument.close()
        frame.contentWindow.location.hash = "#/portal/settings?section=background"
        frame.contentWindow.tenuvault = {
          ...window.tenuvault,
          app: { ...window.tenuvault.app, info: () => Promise.resolve({ version: "0.2.0", platform: ${JSON.stringify(platform)}, trayIconLoaded: true }) },
          license: { ...window.tenuvault.license, status: () => Promise.resolve({ ...status, hasKey: true }) },
          backgroundLaunch: {
            status: () => {
              if (++window.__runner.calls <= 2) return Promise.reject(new Error("Smoke runner status failure"))
              return new Promise(resolve => { window.__runner.resolveStatus = () => resolve({ supported: true, installed: ${installed} }) })
            },
            install: () => {
              window.__runner.installCalls++
              return new Promise(resolve => { window.__runner.resolveChange = () => resolve({ supported: true, installed: true }) })
            },
            remove: () => {
              window.__runner.removeCalls++
              return new Promise(resolve => { window.__runner.resolveChange = () => resolve({ supported: true, installed: false }) })
            },
          },
        }
        document.querySelectorAll('link[rel="stylesheet"]').forEach(link => frame.contentDocument.head.appendChild(link.cloneNode()))
        const script = frame.contentDocument.createElement("script")
        script.type = "module"
        script.src = document.querySelector('script[type="module"]').src
        frame.contentDocument.head.appendChild(script)
      })()`)
      const section = `window.__runnerFrame.contentDocument.getElementById("settings-background")`
      const message = "Could not check background startup. Try again."
      const button = label => `[...${section}.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(label)})`
      const state = text => `${section}?.querySelector('[role="status"]')?.textContent === ${JSON.stringify(text)}`
      assert(await waitForCondition(`${state("Unable to check")} && ${section}.innerText.includes(${JSON.stringify(message)})`), "persistent status error missing")
      await evaluate(`${section}.scrollIntoView({ block: "start" })`)
      assert(await evaluate(`${button("Install background launch")}.disabled && !${button("Retry check")}.disabled`), "error did not disable installation or offer Retry check")
      await evaluate(`(() => { const retry = ${button("Retry check")}; retry.click(); retry.click() })()`)
      assert(await evaluate("window.__runner.calls === 2"), "repeated Retry check clicks submitted overlapping status requests")
      assert(await waitForCondition(`window.__runner.calls === 2 && ${state("Unable to check")}`), "Retry check did not re-request status or preserve a repeated failure")
      await screenshot(`runner-status-error-${platform}`)
      await evaluate(`(() => { const retry = ${button("Retry check")}; retry.click(); retry.click() })()`)
      assert(await evaluate("window.__runner.calls === 3"), "repeated Retry check clicks submitted overlapping status requests")
      assert(await waitForCondition(`window.__runner.calls === 3 && ${state("Checking...")}`), "pending retry did not show checking state")
      assert(await evaluate(`${section}.innerText.includes(${JSON.stringify(message)}) && ${button("Retry check")}.disabled && ${button("Install background launch")}.disabled`), "retry lost the persistent error or enabled installation before success")
      await evaluate("window.__runner.resolveStatus()")
      assert(await waitForCondition(state(installed ? "Installed" : "Not installed")), "successful retry did not show the explicit runner state")
      assert(await evaluate("window.__runner.calls === 3"), "repeated Retry check clicks submitted overlapping status requests")
      assert(await evaluate(`!${section}.innerText.includes(${JSON.stringify(message)}) && !${button("Retry check")}`), "successful retry did not replace the error and Retry check")
      await screenshot(`runner-status-success-${platform}`)
      const location = platform === "darwin" ? "menu bar" : "tray"
      const artifact = platform === "darwin" ? "Adds a LaunchAgent for your user account" : "Adds a scheduled task for your user account"
      assert(await evaluate(`${section}.innerText.includes(${JSON.stringify(artifact)}) && ${section}.innerText.includes(${JSON.stringify(`Keep running in the ${location} when I close the window`)}) && ${section}.innerText.includes(${JSON.stringify(`Start TenuVault in the ${location} when I sign in to this computer`)})`), "platform artifact or icon wording missing")
      assert(await evaluate(`${section}.innerText.includes("Backups need an awake computer and a signed in session. Locking the screen does not sign you out; closing a laptop lid may put it to sleep.")`), "power and session explanation missing")
      for (const removing of [installed, !installed]) {
        const label = removing ? "Remove background launch" : "Install background launch"
        const progress = removing ? "Removing..." : "Installing..."
        await evaluate(`(() => { const change = ${button(label)}; change.click(); change.click() })()`)
        assert(await waitForCondition(`Boolean(${button(progress)}?.disabled)`), `${progress} did not appear on a disabled button`)
        const calls = removing ? "removeCalls" : "installCalls"
        assert(await evaluate(`window.__runner.${calls} === 1`), `repeated ${label} clicks submitted overlapping requests`)
        await screenshot(`runner-${removing ? "removing" : "installing"}-${platform}`)
        await evaluate("window.__runner.resolveChange()")
        assert(await waitForCondition(`${state(removing ? "Not installed" : "Installed")} && ${button(removing ? "Install background launch" : "Remove background launch")}?.disabled === false`), "completed change did not update the state and re-enable the button")
        assert(await evaluate(`window.__runner.${calls} === 1`), "completed change left an overlapping request pending")
      }
      assert(await evaluate("window.__runner.installCalls === 1 && window.__runner.removeCalls === 1"), "change controls did not call the matching operation once")
    } finally {
      await evaluate("window.__runnerFrame?.remove(); delete window.__runnerFrame; delete window.__runner")
    }
  })
}

await check("schedules are stored by the main process", async () => {
  const list = await evaluate(`window.tenuvault.schedules.set({ tenantId: "11111111-1111-1111-1111-111111111111", enabled: true, frequency: "daily", time: "02:00" })`)
  assert(list.length === 1 && list[0].nextRunAt, `unexpected schedules ${JSON.stringify(list)}`)
  await evaluate(`window.tenuvault.schedules.remove("11111111-1111-1111-1111-111111111111")`)
})

await check("several tenants get the overview, switcher and schedule tab", async () => {
  const tenant = (id, n) => ({
    id: n, name: `Contoso ${n}`, domain: `contoso${n}.onmicrosoft.com`, status: "healthy", lastBackup: "", configCount: 0, storageUsed: "",
    client: "", license: "", region: "", tags: [n === 1 ? "Production" : "Testing"], users: 0, devices: 0, complianceRate: 0, industry: "", environment: "", lastSync: "",
    isLoading: n === 1, syncStatus: n === 1 ? "pending" : "idle", policies: { compliance: 0, configuration: 0, apps: 0 },
    credentials: { tenantId: id, appId: "22222222-2222-2222-2222-222222222222", clientSecret: "x" },
    resources: { subscriptionId: "local", subscriptionName: "", resourceGroupName: "local", storageAccountName: `tvlocal-${id}`, automationAccountName: "" },
  })
  const tenants = [tenant("11111111-1111-1111-1111-111111111111", 1), tenant("33333333-3333-3333-3333-333333333333", 2)]
  await evaluate(`window.tenuvault.storage.setItem("tenuvault_tenants", ${JSON.stringify(JSON.stringify(tenants))}).then(() => window.tenuvault.storage.setItem("tenuvault_selected_tenant", "1"))`)
  await evaluate(`location.hash = "#/"; location.reload()`)
  await sleep(1500)
  await disableAnimations()
  assert(await waitForText("All tenants", 20000), "overview did not open for several tenants")
  assert(await waitForText("Contoso 2"), "second tenant missing from the overview")
  assert(await waitForText("Save your backup recovery key"), "local storage recovery key notice missing from Overview")
  await screenshot("08-overview")
  await go("#/portal/backup", "Backup History")
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.innerText.trim() === "Schedule")?.click()`)
  assert(await waitForText("Automatic backups"), "schedule panel missing")
  await screenshot("09-schedule")
})

await check("Backup Reader card offers setup with a guide link, and the schedule says who runs backups", async () => {
  await go("#/portal/settings?section=background", "Backup Reader")
  assert(await waitForText("Set up the Backup Reader"), "Backup Reader setup entry missing")
  assert(await waitForCondition(`[...document.querySelectorAll("button")].some(b => b.textContent.includes("Setup guide"))`), "Backup Reader setup guide link missing")
  await evaluate(`[...document.querySelectorAll("h3, [data-slot='card-title']")].find(el => el.textContent.trim().startsWith("Backup Reader"))?.scrollIntoView({ block: "start" })`)
  await disableAnimations()
  await screenshot("05e-backup-reader")
  await go("#/portal/backup?tab=schedule", "Automatic backups")
  assert(await waitForText("Scheduled backups run as"), "schedule tab does not say who scheduled backups run as")
})

await check("restarting clears interrupted tenant backup and refresh flags", async () => {
  await go("#/portal/tenants", "Tenant Management")
  assert(await waitForCondition(`[...document.querySelectorAll('button')].filter(b => b.innerText.trim() === 'Backup Now' && !b.disabled).length === 2`), "backup buttons stayed disabled after restart")
  assert(await evaluate(`document.querySelectorAll('button[title="Refresh data"]').length === 2`), "refresh buttons stayed hidden after restart")
  assert(await waitForCondition(`JSON.parse(window.tenuvault.storage.getItemSync('tenuvault_tenants')).every(t => !Object.hasOwn(t, 'isLoading') && t.syncStatus !== 'pending')`), "in-flight flags were saved again")
})

await checkBackupCancel({ check, evaluate, waitForCondition, screenshot, assert, desktopDir, inspectorPort: packagedApp ? undefined : inspectorPort })

await check("Community is a neutral plan state and its Overview notice remembers dismissal for 30 days", async () => {
  const banner = `document.querySelector('a[href="#/license"].bg-gray-100')`
  const dismiss = `[...document.querySelectorAll('button')].find(button => button.textContent === 'Dismiss')`
  const chip = `document.querySelector('aside a[href="#/license"] span.ml-auto')`
  assert(await waitForCondition(`${chip}?.textContent === "Community" && ${chip}.classList.contains("bg-gray-100")`), "healthy Community sidebar chip missing")
  assert(await evaluate(`!${banner}`), "Community notice appeared on the tenants page")
  await go("#/portal/overview", "All tenants")
  assert(await waitForCondition(`Boolean(${banner})`), "neutral Community notice missing from Overview")
  assert(await evaluate(`!${banner}.querySelector('.bg-coral-500')`), "Community notice still has a coral icon")
  await screenshot("08-community-notice")
  await go("#/license", "Add your license")
  assert(await evaluate(`!${banner}`), "Community notice appeared on the License page")
  await go("#/portal/overview", "All tenants")
  assert(await waitForCondition(`Boolean(${dismiss})`), "Community notice Dismiss button missing")
  await evaluate(`${dismiss}.click()`)
  assert(await waitForCondition(`!${banner}`), "dismissed Community notice stayed visible")
  const preferences = await evaluate(`window.tenuvault.preferences.get()`)
  assert(Number.isFinite(Date.parse(preferences.communityBannerDismissedAt)), "dismissal timestamp was not stored")
  await send("Page.reload")
  assert(await waitForText("All tenants"), "Overview did not reload")
  await disableAnimations()
  assert(await waitForCondition(`${chip}?.textContent === "Community"`), "Community chip did not reload")
  assert(await evaluate(`!${banner}`), "Community notice returned after reload within 30 days")
  await evaluate(`window.tenuvault.preferences.set({ communityBannerDismissedAt: new Date(Date.now() - 31 * 86400000).toISOString() })`)
  await send("Page.reload")
  assert(await waitForCondition(`Boolean(${banner})`), "Community notice did not return after 30 days")
  await disableAnimations()
  assert(await waitForCondition(`Boolean(${dismiss})`), "Community notice Dismiss button missing after 30 days")
  await evaluate(`${dismiss}.click()`)
  assert(await waitForCondition(`!${banner}`), "Community notice could not be dismissed again")
})

await check("Community trial focuses the key input and procurement links use the external bridge", async () => {
  try {
    await evaluate(`(() => {
      window.__communityTrial = { opened: [], docs: [] }
      const frame = document.createElement("iframe")
      frame.style.cssText = "position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 9999;"
      document.body.appendChild(frame)
      window.__communityTrialFrame = frame
      frame.contentDocument.open()
      frame.contentDocument.write('<html><head></head><body><div id="root"></div></body></html>')
      frame.contentDocument.close()
      frame.contentWindow.location.hash = "#/license"
      frame.contentWindow.tenuvault = {
        ...window.tenuvault,
        license: { ...window.tenuvault.license, open: (destination, context) => { window.__communityTrial.opened.push({ destination, context }); return Promise.resolve() } },
        app: { ...window.tenuvault.app, openExternal: url => { window.__communityTrial.docs.push(url); return Promise.resolve() } },
      }
      document.querySelectorAll('link[rel="stylesheet"]').forEach(link => frame.contentDocument.head.appendChild(link.cloneNode()))
      const script = frame.contentDocument.createElement("script")
      script.type = "module"
      script.src = document.querySelector('script[type="module"]').src
      frame.contentDocument.head.appendChild(script)
    })()`)
    const body = "window.__communityTrialFrame.contentDocument.body"
    assert(await waitForCondition(`${body}.innerText.includes("Start 30 day free trial")`), "Community trial button missing")
    await evaluate(`[...${body}.querySelectorAll('button')].find(button => button.textContent.includes('Start 30 day free trial')).click()`)
    assert(await waitForCondition(`${body}.innerText.includes("Paste the key from your email to activate the trial.")`), "trial key hint missing")
    assert(await evaluate(`window.__communityTrial.opened.length === 1 && window.__communityTrial.opened[0].destination === "buy" && window.__communityTrial.opened[0].context?.source === "license-page"`), "trial did not open pricing with the license-page source")
    assert(await evaluate(`window.__communityTrialFrame.contentDocument.activeElement.id === "license-key"`), "trial did not focus the key input")
    assert(await evaluate(`(() => { const input = ${body}.querySelector('#license-key'); const rect = input.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= window.__communityTrialFrame.contentWindow.innerHeight })()`), "trial key input was not scrolled into view")
    assert(await evaluate(`${body}.innerText.includes("Buying for a company? Yearly plans are available by quote, purchase order and invoice, and a 30 day trial key without a card on request.") && ${body}.innerText.includes("Eligible nonprofits can use Pro at no cost.")`), "company or nonprofit copy missing")
    await evaluate(`${body}.querySelectorAll('a[href="https://docs.tenuvault.com/licensing/"]').forEach(link => link.click())`)
    assert(await evaluate(`window.__communityTrial.docs.length === 2 && window.__communityTrial.docs.every(url => url === "https://docs.tenuvault.com/licensing/")`), "docs links did not use the external bridge")
    await screenshot("08-community-trial-key")
  } finally {
    await evaluate("window.__communityTrialFrame?.remove(); delete window.__communityTrialFrame; delete window.__communityTrial")
  }
})

await check("the whole dashboard License tile opens License with the keyboard", async () => {
  await go("#/portal/dashboard", "Contoso 1")
  const tile = `document.querySelector('main a[href="#/license"]')`
  assert(await waitForCondition(`Boolean(${tile})`), "linked License tile missing")
  assert(await evaluate(`${tile}.getAttribute('href') === '#/license' && !${tile}.querySelector('button, a')`), "License tile has the wrong route or nested interactive elements")
  await evaluate(`${tile}.focus()`)
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  assert(await waitForText("Add your license"), "keyboard did not open License from the tile")
})

await check("tenant renames show Saved in both views and clear confirmation timers", async () => {
  await go("#/portal/tenants", "Tenant Management")
  const editor = `document.querySelector('main input[type="text"]:not([aria-label="Search tenants"])')`
  const saved = `[...document.querySelectorAll('main [role="status"]')].filter(s => s.textContent.trim() === 'Saved')`
  const noCloudSync = `!document.querySelector('[title="Syncing to cloud..."]') && !document.querySelector('main .lucide-cloud-upload') && !document.querySelector('main').innerText.includes('Syncing to cloud')`
  const startEditing = async name => {
    await evaluate(`document.querySelector(${JSON.stringify(`button[aria-label="Rename tenant: ${name}"]`)}).click()`)
    assert(await waitForCondition(`${editor}?.value === ${JSON.stringify(name)}`), "rename editor did not open")
    assert(await evaluate(`document.querySelector('button[aria-label="Save tenant name"]')?.title === 'Save' && document.querySelector('button[aria-label="Save tenant name"] svg')?.classList.contains('text-green-600')`), "Save tooltip or green check missing")
    assert(await evaluate(`document.querySelector('button[aria-label^="Cancel editing tenant name:"]')?.title === 'Cancel' && Boolean(document.querySelector('button[aria-label^="Cancel editing tenant name:"] .lucide-x'))`), "Cancel tooltip or icon missing")
  }
  const setName = async name => {
    await evaluate(`(() => {
      const input = ${editor}
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    assert(await waitForCondition(`${editor}?.value === ${JSON.stringify(name)}`), "name draft did not update")
  }
  const pressKey = async key => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key })
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key })
  }
  const saveName = async (name, method = "button") => {
    await setName(name)
    if (method === "enter") await pressKey("Enter")
    else await evaluate(`document.querySelector('button[aria-label="Save tenant name"]').click()`)
    assert(await waitForCondition(`!${editor}`), "save did not close the editor")
  }
  const assertSaved = async name => {
    assert(await waitForCondition(`${saved}.some(s => s.parentElement.textContent.includes(${JSON.stringify(name)}))`), "Saved confirmation missing next to the renamed tenant")
    assert(await evaluate(`${saved}.every(s => s.getAttribute('aria-live') === 'polite' && Boolean(s.querySelector('.lucide-check[aria-hidden="true"]')) && s.classList.contains('text-green-700'))`), "Saved confirmation is missing polite status, check or success style")
    assert(await evaluate(noCloudSync), "rename displayed a cloud sync indicator")
    return evaluate(`window.__tenantRenameTimers.scheduled.at(-1)`)
  }
  await evaluate(`(() => {
    const timers = { active: new Set(), scheduled: [], cleared: new Set() }
    window.__tenantRenameTimers = timers
    window.__tenantRenameSetTimeout = window.setTimeout
    window.__tenantRenameClearTimeout = window.clearTimeout
    const setTimeout = window.setTimeout.bind(window)
    const clearTimeout = window.clearTimeout.bind(window)
    window.setTimeout = (callback, delay, ...args) => {
      if (delay !== 2000) return setTimeout(callback, delay, ...args)
      const timer = setTimeout(() => {
        timers.active.delete(timer)
        callback(...args)
      }, delay)
      timers.active.add(timer)
      timers.scheduled.push(timer)
      return timer
    }
    window.clearTimeout = timer => {
      if (timers.active.delete(timer)) timers.cleared.add(timer)
      clearTimeout(timer)
    }
  })()`)
  try {
    for (const view of ["Grid", "List"]) {
      await evaluate(`document.querySelector('button[aria-label="${view} view"]').click()`)
      await startEditing("Contoso 1")
      const scheduled = await evaluate(`window.__tenantRenameTimers.scheduled.length`)
      for (const name of ["Contoso 1", "  Contoso 1  ", "   "]) {
        await saveName(name)
        assert(await evaluate(`${saved}.length === 0 && window.__tenantRenameTimers.scheduled.length === ${scheduled}`), "unchanged or blank name showed Saved or scheduled a timer")
        assert(await evaluate(`Boolean(document.querySelector('button[aria-label="Rename tenant: Contoso 1"]'))`), "unchanged or blank name changed the tenant")
        await startEditing("Contoso 1")
      }
      await setName("Cancelled rename")
      await pressKey("Escape")
      assert(await waitForCondition(`!${editor} && ${saved}.length === 0`), "Escape did not cancel without Saved")
      await startEditing("Contoso 1")
      await setName("Cancelled rename")
      await evaluate(`document.querySelector('button[title="Cancel"]').click()`)
      assert(await waitForCondition(`!${editor} && ${saved}.length === 0`), "Cancel did not close without Saved")

      await startEditing("Contoso 1")
      await saveName(`  Contoso ${view} renamed  `, "enter")
      const firstTimer = await assertSaved(`Contoso ${view} renamed`)
      assert(await waitForCondition(`JSON.parse(window.tenuvault.storage.getItemSync('tenuvault_tenants')).find(t => t.id === 1).name === 'Contoso ${view} renamed'`), "trimmed rename was not saved locally")
      assert(await evaluate(`${saved}.length === 1`), "rename showed more than one confirmation")
      await sleep(1100)
      await startEditing(`Contoso ${view} renamed`)
      assert(await evaluate(`${saved}.length === 0 && window.__tenantRenameTimers.cleared.has(${firstTimer}) && !window.__tenantRenameTimers.active.has(${firstTimer})`), "new edit did not clear the prior confirmation timer")
      await saveName("Contoso 1")
      const replacementTimer = await assertSaved("Contoso 1")
      await sleep(1100)
      assert(await evaluate(`${saved}.length === 1 && window.__tenantRenameTimers.active.has(${replacementTimer})`), "the previous timer hid the new confirmation early")
      assert(await waitForCondition(`${saved}.length === 0`, 4000), "Saved did not disappear after two seconds")
      assert(await evaluate(`!window.__tenantRenameTimers.active.has(${replacementTimer})`), "expired confirmation timer was retained")

      await startEditing("Contoso 1")
      await saveName(`Contoso ${view} first`)
      const firstTenantTimer = await assertSaved(`Contoso ${view} first`)
      await startEditing("Contoso 2")
      await saveName(`Contoso ${view} second`)
      const secondTenantTimer = await assertSaved(`Contoso ${view} second`)
      assert(await evaluate(`${saved}.length === 2 && window.__tenantRenameTimers.active.has(${firstTenantTimer}) && window.__tenantRenameTimers.active.has(${secondTenantTimer})`), "tenants did not keep independent confirmation timers")
      await go("#/portal/overview", "All tenants")
      assert(await evaluate(`window.__tenantRenameTimers.cleared.has(${firstTenantTimer}) && window.__tenantRenameTimers.cleared.has(${secondTenantTimer})`), "unmount did not clear all confirmation timers")
      await go("#/portal/tenants", "Tenant Management")
      assert(await evaluate(`${saved}.length === 0`), "Saved lingered after remount")
      await startEditing(`Contoso ${view} first`)
      await saveName("Contoso 1")
      await startEditing(`Contoso ${view} second`)
      await saveName("Contoso 2")
      await go("#/portal/overview", "All tenants")
      await go("#/portal/tenants", "Tenant Management")
    }
    // Let the restored names finish their metadata updates before the tag check.
    assert(await waitForCondition(`window.__tenantRenameTimers.active.size === 0`, 4000), "restored tenant names still had pending metadata timers")
  } finally {
    await evaluate(`window.setTimeout = window.__tenantRenameSetTimeout; window.clearTimeout = window.__tenantRenameClearTimeout; delete window.__tenantRenameSetTimeout; delete window.__tenantRenameClearTimeout; delete window.__tenantRenameTimers`)
  }
})

await check("tenant selection toggles from cards, rows, select all and clear without shifting layout", async () => {
  await go("#/portal/tenants", "Tenant Management")
  await evaluate(`document.querySelector('button[aria-label="Grid view"]').click()`)
  const bar = `[...document.querySelectorAll('main [aria-live="polite"]')].find(s => /selected|Select tenants to back up/.test(s.textContent))`
  const card = id => `document.querySelector('[data-tenant-card="${id}"]')`
  const setSearch = async text => {
    await evaluate(`(() => { const input = document.querySelector('input[aria-label="Search tenants"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  }
  try {
  assert(await evaluate(`${bar}.textContent.includes('Select tenants to back up')`), "selection bar hint missing before any selection")
  // Gap between the bar and the first card, plus the bar height: both are
  // scroll-independent, unlike raw viewport coordinates.
  const layout = `(() => { const barRect = document.querySelector('[data-selection-bar]').getBoundingClientRect(); const cardRect = ${card(1)}.getBoundingClientRect(); return { barHeight: barRect.height, gap: cardRect.top - barRect.bottom } })()`
  const layoutBefore = await evaluate(layout)
  await evaluate(`document.querySelector('button[aria-label="Select Contoso 1"]').click()`)
  assert(await waitForCondition(`${card(1)}.dataset.selected === 'true' && ${bar}.textContent.includes('1 tenant selected')`), "checkbox did not select the first tenant")
  assert(await evaluate(`document.querySelector('button[aria-label="Select Contoso 1"]').getAttribute('aria-checked') === 'true' && ${card(1)}.innerText.includes('Selected')`), "selected card does not say Selected with a checked box")
  const layoutAfter = await evaluate(layout)
  assert(Math.abs(layoutAfter.barHeight - layoutBefore.barHeight) < 1 && Math.abs(layoutAfter.gap - layoutBefore.gap) < 1, `selecting the first tenant shifted the cards: ${JSON.stringify({ layoutBefore, layoutAfter })}`)
  // Clicking the card outside its controls toggles too.
  await evaluate(`${card(2)}.querySelector('h3').click()`)
  assert(await waitForCondition(`${card(2)}.dataset.selected === 'true' && ${bar}.textContent.includes('2 tenants selected')`), "card click did not select the second tenant")
  assert(await evaluate(`document.querySelector('button[aria-label="Select all matching tenants"]').getAttribute('aria-checked') === 'true'`), "select all is not checked with every tenant selected")
  await screenshot("07-tenants-selected")
  // Dark theme: the selected surfaces must take the dark overrides, not the
  // light coral tints that would leave light text unreadable.
  await evaluate(`document.documentElement.classList.add('dark')`)
  assert(await evaluate(`getComputedStyle(document.querySelector('[data-selection-bar]')).backgroundColor === 'rgb(58, 32, 25)' && getComputedStyle(${card(1)}).backgroundColor === 'rgb(58, 32, 25)'`), "selected surfaces kept their light tint in dark mode")
  await screenshot("07b-tenants-selected-dark")
  await evaluate(`document.documentElement.classList.remove('dark')`)
  // Controls inside the card never toggle: the rename button opens the editor instead.
  await evaluate(`document.querySelector('button[aria-label="Rename tenant: Contoso 2"]').click()`)
  assert(await waitForCondition(`Boolean(document.querySelector('button[aria-label="Save tenant name"]')) && ${card(2)}.dataset.selected === 'true'`), "rename click changed the selection")
  // Select all also leaves the tenant being renamed alone.
  await evaluate(`document.querySelector('button[aria-label="Select all matching tenants"]').click()`)
  assert(await waitForCondition(`!${card(1)}.dataset.selected && ${card(2)}.dataset.selected === 'true'`), "select all toggled the tenant being renamed")
  await evaluate(`document.querySelector('button[aria-label^="Cancel editing tenant name:"]').click()`)
  assert(await waitForCondition(`!document.querySelector('button[aria-label="Save tenant name"]') && ${card(2)}.dataset.selected === 'true'`), "cancelling rename changed the selection")
  await evaluate(`document.querySelector('button[aria-label="Select all matching tenants"]').click()`)
  assert(await waitForCondition(`${bar}.textContent.includes('2 tenants selected')`), "select all did not reselect both tenants after rename")
  // A disabled button takes no pointer events, so only a real mouse click at
  // its coordinates proves the click cannot fall through and toggle.
  const backupCenter = await evaluate(`(() => { const button = [...${card(2)}.querySelectorAll('button')].find(b => b.innerText.includes('Backup Now')); button.disabled = true; const rect = button.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } })()`)
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: backupCenter.x, y: backupCenter.y, button: "left", clickCount: 1 })
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: backupCenter.x, y: backupCenter.y, button: "left", clickCount: 1 })
  await sleep(250)
  assert(await evaluate(`${card(2)}.dataset.selected === 'true' && ${bar}.textContent.includes('2 tenants selected')`), "clicking the disabled Backup Now toggled the selection")
  await evaluate(`[...${card(2)}.querySelectorAll('button')].find(b => b.innerText.includes('Backup Now')).disabled = false`)
  // Search scopes select all and discloses hidden selections.
  await setSearch("Contoso 2")
  assert(await waitForCondition(`${bar}.textContent.includes('1 not shown by search')`), "bar does not disclose the tenant hidden by search")
  await evaluate(`document.querySelector('button[aria-label="Select all matching tenants"]').click()`)
  assert(await waitForCondition(`${bar}.textContent.includes('1 tenant selected') && ${bar}.textContent.includes('1 not shown by search') && !document.querySelector('[data-tenant-card="2"]')?.dataset.selected`), "unselecting visible tenants dropped the hidden selection")
  await setSearch("")
  assert(await waitForCondition(`${card(1)}.dataset.selected === 'true' && !${card(2)}.dataset.selected`), "hidden selection did not survive clearing the search")
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Clear').click()`)
  assert(await waitForCondition(`!document.querySelector('[data-tenant-card][data-selected]') && ${bar}.textContent.includes('Select tenants to back up')`), "Clear did not reset the selection")
  assert(await evaluate(`document.activeElement?.getAttribute('aria-label') === 'Select all matching tenants'`), "Clear dropped keyboard focus instead of landing on select all")
  // At the minimum window width the actions wrap, so the bar reserves the
  // two row height and selection changes still move nothing.
  await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })
  const narrowLayout = `(() => { const barRect = document.querySelector('[data-selection-bar]').getBoundingClientRect(); const cardRect = document.querySelector('[data-tenant-card]').getBoundingClientRect(); return { barHeight: barRect.height, gap: cardRect.top - barRect.bottom } })()`
  const narrowBefore = await evaluate(narrowLayout)
  await evaluate(`document.querySelector('button[aria-label="Select Contoso 1"]').click()`)
  await setSearch("Contoso 2")
  assert(await waitForCondition(`${bar}.textContent.includes('1 not shown by search')`), "hidden disclosure missing at narrow width")
  const narrowAfter = await evaluate(narrowLayout)
  assert(Math.abs(narrowAfter.barHeight - narrowBefore.barHeight) < 1 && Math.abs(narrowAfter.gap - narrowBefore.gap) < 1, `selection shifted the cards at 1024px: ${JSON.stringify({ narrowBefore, narrowAfter })}`)
  await screenshot("07c-tenants-selected-narrow")
  await send("Emulation.clearDeviceMetricsOverride", {})
  await setSearch("")
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Clear').click()`)
  assert(await waitForCondition(`!document.querySelector('[data-tenant-card][data-selected]')`), "narrow width selection did not clear")
  // List view: row click toggles, the header reports mixed, Escape clears.
  await evaluate(`document.querySelector('button[aria-label="List view"]').click()`)
  const row = id => `document.querySelector('[data-tenant-row="${id}"]')`
  await evaluate(`${row(1)}.querySelector('td:nth-child(2)').click()`)
  assert(await waitForCondition(`${row(1)}.dataset.selected === 'true' && document.querySelector('button[aria-label="Select all matching tenants in the list"]').getAttribute('aria-checked') === 'mixed'`), "row click or mixed select all state failed in list view")
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Clear').focus()`)
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" })
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" })
  assert(await waitForCondition(`!document.querySelector('[data-tenant-row][data-selected]')`), "Escape did not clear the selection")
  assert(await evaluate(`document.activeElement?.getAttribute('aria-label') === 'Select all matching tenants'`), "Escape dropped focus from the bar instead of landing on select all")
  } finally {
    // Later checks start from an unfiltered grid with nothing selected.
    await send("Emulation.clearDeviceMetricsOverride", {}).catch(() => {})
    await evaluate(`document.documentElement.classList.remove('dark')`).catch(() => {})
    await setSearch("").catch(() => {})
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Clear')?.click()`).catch(() => {})
    await evaluate(`document.querySelector('button[aria-label="Grid view"]')?.click()`).catch(() => {})
  }
})

await check("tag drafts stay with their tenant and bulk tags sync every tenant", async () => {
  await go("#/portal/tenants", "Tenant Management")
  const currentTags = `document.querySelector('[role="dialog"] h3')?.nextElementSibling.innerText.trim()`
  const clickDialogButton = (text) => evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b => b.innerText.trim() === ${JSON.stringify(text)}).click()`)
  const openTags = async (name) => {
    await evaluate(`document.querySelector('button[aria-label="Tenant actions: ${name}"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))`)
    assert(await waitForCondition(`[...document.querySelectorAll('[role="menuitem"]')].some(b => b.innerText.trim() === 'Manage Tags')`), "tenant actions menu did not open")
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(b => b.innerText.trim() === 'Manage Tags').click()`)
    assert(await waitForText(`Manage Tags for ${name}`), "tag dialog did not open")
    assert(await waitForCondition(`document.querySelector('[role="dialog"]')?.contains(document.activeElement)`), "tag dialog did not receive focus")
    // Radix attaches its outside-pointer listener in a deferred task after mounting.
    await evaluate(`new Promise(resolve => setTimeout(resolve, 0))`)
  }
  const closeTags = async (method = "cancel") => {
    if (method === "escape") {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" })
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" })
    } else if (method === "overlay") {
      assert(await evaluate(`document.elementFromPoint(5, 5)?.classList.contains('inset-0')`), "tag dialog overlay missing")
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 })
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 5, button: "left", clickCount: 1 })
    } else {
      await clickDialogButton("Cancel")
    }
    assert(await waitForCondition(`!document.querySelector('[role="dialog"]')`), "tag dialog did not close")
  }
  await evaluate(`(() => {
    window.__tenantTagFetch = window.fetch
    window.__tenantTagSaves = []
    window.fetch = (input, init) => {
      if (input !== '/api/tenant-metadata/save') return window.__tenantTagFetch(input, init)
      window.__tenantTagSaves.push(JSON.parse(init.body))
      return Promise.resolve(Response.json({ success: true }))
    }
  })()`)
  try {
    await openTags("Contoso 1")
    assert((await evaluate(currentTags)) === "Production", "first tenant tags missing")
    await clickDialogButton("Non-Production")
    assert(await waitForCondition(`${currentTags}.includes('Development')`), "unsaved tag edit was not applied")
    await closeTags()
    await openTags("Contoso 1")
    assert((await evaluate(currentTags)) === "Production", "reopening the same tenant kept its cancelled draft")
    await closeTags()
    await openTags("Contoso 2")
    assert((await evaluate(currentTags)) === "Testing", "second tenant inherited the first tenant's tags or draft")
    await clickDialogButton("Save Tags")
    assert(await waitForCondition(`!document.querySelector('[role="dialog"]')`), "saved tag dialog did not close")
    assert(await evaluate(`!document.querySelector('[title="Syncing to cloud..."]') && !document.querySelector('main .lucide-cloud-upload')`), "tag save displayed a cloud sync indicator")
    assert(await waitForCondition(`window.__tenantTagSaves.length === 1`), "second tenant tags were not synced")
    assert(await evaluate(`window.__tenantTagSaves[0].tenantId.startsWith('33333333') && window.__tenantTagSaves[0].metadata.tags.length === 1 && window.__tenantTagSaves[0].metadata.tags[0] === 'Testing'`), "metadata sync saved another tenant's tags")
    assert(await evaluate(`JSON.parse(window.tenuvault.storage.getItemSync('tenuvault_tenants')).every(t => JSON.stringify(t.tags) === JSON.stringify(t.id === 1 ? ['Production'] : ['Testing']))`), "tag draft leaked into saved profiles")
    await openTags("Contoso 1")
    assert((await evaluate(currentTags)) === "Production", "returning to the first tenant kept its discarded draft")
    for (const method of ["escape", "overlay"]) {
      await clickDialogButton("Non-Production")
      assert(await waitForCondition(`${currentTags}.includes('Development')`), "unsaved tag edit was not applied")
      await closeTags(method)
      await openTags("Contoso 1")
      assert((await evaluate(currentTags)) === "Production", `reopening the same tenant after ${method} kept its discarded draft`)
    }
    await closeTags()
    await evaluate(`document.querySelector('button[aria-label="Select Contoso 1"]').click()`)
    await evaluate(`document.querySelector('button[aria-label="Select Contoso 2"]').click()`)
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Tag Selected').click()`)
    assert(await waitForText("Manage Tags for 2 tenants"), "bulk tag dialog did not open")
    assert((await evaluate(currentTags)) === "No tags selected", "bulk tagging inherited a tenant's tags")
    await clickDialogButton("Non-Production")
    assert(await waitForCondition(`${currentTags}.includes('Development')`), "unsaved bulk tag edit was not applied")
    await closeTags()
    await evaluate(`document.querySelector('button[aria-label="Select Contoso 1"]').click()`)
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Tag Selected').click()`)
    assert(await waitForText("Manage Tags for 1 tenants"), "second bulk selection tag dialog did not open")
    assert((await evaluate(currentTags)) === "No tags selected", "second bulk selection inherited the cancelled bulk draft")
    await closeTags()
    await evaluate(`document.querySelector('button[aria-label="Select Contoso 1"]').click()`)
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Tag Selected').click()`)
    assert(await waitForText("Manage Tags for 2 tenants"), "bulk tag dialog did not reopen")
    assert((await evaluate(currentTags)) === "No tags selected", "reopening bulk tagging kept its discarded draft")
    await clickDialogButton("Non-Production")
    await clickDialogButton("Save Tags")
    assert(await waitForCondition(`window.__tenantTagSaves.length === 3`), "bulk tags did not sync both tenants")
    const saves = await evaluate(`window.__tenantTagSaves.slice(1).map(s => ({ tenantId: s.tenantId, tags: s.metadata.tags }))`)
    assert(new Set(saves.map(s => s.tenantId)).size === 2 && saves.every(s => JSON.stringify(s.tags) === JSON.stringify(["Development", "Testing", "Staging"])), `unexpected bulk tag sync ${JSON.stringify(saves)}`)
  } finally {
    await evaluate(`window.fetch = window.__tenantTagFetch; delete window.__tenantTagFetch; delete window.__tenantTagSaves`)
  }
})

await check("restore journal applied IDs use validated inline inputs", async () => {
  const tenantId = "11111111-1111-1111-1111-111111111111"
  const originalId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  const appliedId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
  const correctedId = "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC"
  await evaluate(`(() => {
    window.__restoreFetch = window.fetch;
    window.__restoreRequests = [];
    window.__restoreFailList = false;
    window.__restoreFailApplied = true;
    window.__restoreHoldApplied = false;
    const records = [
      { key: 'smoke-uncertain', tenant: '${tenantId}', method: 'POST', path: '/deviceManagement/deviceConfigurations', at: '2026-01-01T00:00:00.000Z', state: 'uncertain', label: 'Interrupted smoke policy' },
      { key: 'smoke-correct', tenant: '${tenantId}', method: 'POST', path: '/deviceManagement/deviceConfigurations', at: '2026-01-01T00:00:00.000Z', state: 'reconciled', label: 'Reconciled smoke policy', objectId: '${originalId}' }
    ];
    window.fetch = (input, init) => {
      if (String(input) !== '/api/restore-journal') return window.__restoreFetch(input, init);
      const body = JSON.parse(init.body);
      window.__restoreRequests.push(body);
      if (body.action === 'list' && window.__restoreFailList) return Promise.reject(new Error('Restore history unavailable.'));
      if (body.action === 'applied') {
        if (window.__restoreFailApplied) return new Promise(resolve => {
          window.__restoreFailAppliedResponse = () => resolve(Response.json({ error: 'Restore reconciliation unavailable.' }, { status: 503 }));
        });
        Object.assign(records.find(record => record.key === body.key), { state: 'reconciled', objectId: body.objectId });
        if (window.__restoreHoldApplied) return new Promise(resolve => {
          window.__restoreAppliedResponse = () => resolve(Response.json({ records }));
        });
      }
      if (body.action === 'new-operation') {
        const index = records.findIndex(record => record.key === body.key);
        if (index !== -1) records.splice(index, 1);
      }
      return Promise.resolve(Response.json({ records }));
    };
  })()`)
  const form = label => `document.querySelector('form[aria-label="${label}"]')`
  const click = label => evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
  const open = (label, policy) => evaluate(`(() => {
    const row = [...document.querySelectorAll('p')].find(p => p.textContent === ${JSON.stringify(policy)}).parentElement;
    window.__restoreRecoveryButton = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
    window.__restoreRecoveryButton.click();
  })()`)
  const press = async key => {
    const params = { key, code: key, windowsVirtualKeyCode: key === "Escape" ? 27 : 13 }
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...params, ...(key === "Enter" ? { text: "\r" } : {}) })
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...params })
  }
  const fill = (label, value) => evaluate(`(() => {
    const input = ${form(label)}.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const submit = label => evaluate(`${form(label)}.querySelector('button[type="submit"]').click()`)
  try {
    await go("#/portal/settings?section=storage", "Restore write history")
    assert(await waitForText("Interrupted smoke policy"), "journal records did not load")
    await evaluate(`window.__restoreFailList = true`)
    await click("Refresh history")
    assert(await waitForText("Restore history unavailable."), "journal refresh error was hidden")
    assert(await evaluate(`document.body.innerText.includes('Interrupted smoke policy') && document.body.innerText.includes('Reconciled smoke policy')`), "failed refresh cleared the journal")
    await evaluate(`window.__restoreFailList = false`)
    await click("Refresh history")
    assert(await waitForCondition(`!document.body.innerText.includes('Restore history unavailable.')`), "successful refresh did not clear the error")

    await open("Confirm applied", "Interrupted smoke policy")
    assert(await waitForCondition(`!!${form("Confirm applied")}`), "Confirm applied did not open the input")
    assert(await evaluate(`${form("Confirm applied")}.querySelector('input').value === ''`), "uncertain write input was not blank")
    assert(await evaluate(`${form("Confirm applied")}.innerText.includes('A retry will reuse this result instead of repeating the write.')`), "confirmation description missing")
    await fill("Confirm applied", "invalid-id")
    await submit("Confirm applied")
    assert(await waitForText("Enter a valid object ID (GUID)."), "invalid object ID did not show validation")
    assert(await evaluate(`!window.__restoreRequests.some(r => r.action === 'applied')`), "invalid object ID sent a request")
    await evaluate(`${form("Confirm applied")}.querySelector('button[type="button"]').click()`)
    assert(await waitForCondition(`!${form("Confirm applied")}`), "Cancel did not close the input")
    assert(await waitForCondition(`document.activeElement === window.__restoreRecoveryButton`), "Cancel did not return focus to Confirm applied")
    assert(await evaluate(`!window.__restoreRequests.some(r => r.action === 'applied')`), "Cancel sent a request")

    await open("Confirm applied", "Interrupted smoke policy")
    assert(await waitForCondition(`document.activeElement === ${form("Confirm applied")}?.querySelector('input')`), "Confirm applied did not focus the input")
    await press("Escape")
    assert(await waitForCondition(`!${form("Confirm applied")}`), "Escape did not close Confirm applied")
    assert(await waitForCondition(`document.activeElement === window.__restoreRecoveryButton`), "Escape did not return focus to Confirm applied")
    assert(await evaluate(`!window.__restoreRequests.some(r => r.action === 'applied')`), "Escape sent a request")

    await open("Confirm applied", "Interrupted smoke policy")
    await fill("Confirm applied", ` ${appliedId} `)
    await submit("Confirm applied")
    assert(await waitForCondition(`${form("Confirm applied")}?.querySelector('input')?.disabled`), "input was not disabled during saving")
    assert(await waitForCondition(`${form("Confirm applied")}?.contains(document.activeElement)`), "pending save lost focus outside the form")
    await evaluate(`(() => {
      window.__restoreEscapeEvents = [];
      window.__restoreEscapeProbe = event => {
        if (event.key === 'Escape') window.__restoreEscapeEvents.push(event.defaultPrevented);
      };
      document.addEventListener('keydown', window.__restoreEscapeProbe);
    })()`)
    await press("Escape")
    assert(await evaluate(`!!${form("Confirm applied")}`), "Escape closed the input while saving")
    assert(await evaluate(`!window.__restoreEscapeEvents.includes(false)`), "pending Escape reached the document without preventing dismissal")
    assert(await evaluate(`${form("Confirm applied")}.contains(document.activeElement)`), "pending Escape lost focus outside the form")
    await evaluate(`window.__restoreFailAppliedResponse()`)
    assert(await waitForCondition(`${form("Confirm applied")}?.querySelector('[role="alert"]')?.innerText === 'Restore reconciliation unavailable.'`), "request error did not appear inside the input form")
    assert(await waitForCondition(`document.activeElement === ${form("Confirm applied")}?.querySelector('input')`), "failed reconciliation did not refocus the input")
    assert(await evaluate(`window.__restoreRequests.some(r => r.action === 'applied' && r.key === 'smoke-uncertain' && r.objectId === '${appliedId}' && r.confirmed === true && r.tenantId === '${tenantId}')`), "valid ID did not send the confirmed reconciliation")
    await screenshot("05d-restore-journal-error")
    await evaluate(`window.__restoreFailApplied = false`)
    assert(await waitForCondition(`!${form("Confirm applied")}.querySelector('button[type="submit"]').disabled`), "input stayed disabled after failure")
    await press("Enter")
    assert(await waitForCondition(`window.__restoreRequests.filter(r => r.action === 'applied' && r.key === 'smoke-uncertain').length === 2`), "Enter did not submit the recovery form")
    assert(await waitForCondition(`!${form("Confirm applied")}`), "successful reconciliation did not close the input")
    assert(await waitForText(`Object ${appliedId}`), "saved object ID was not displayed")
    assert(await waitForCondition(`(() => {
      const row = [...document.querySelectorAll('p')].find(p => p.textContent === 'Interrupted smoke policy').parentElement;
      return document.activeElement === [...row.querySelectorAll('button')].find(b => b.textContent.trim() === 'Correct applied ID');
    })()`), "successful reconciliation did not focus the record's recovery button")

    await open("Correct applied ID", "Reconciled smoke policy")
    assert(await waitForCondition(`!!${form("Correct applied ID")}`), "Correct applied ID did not open the input")
    assert(await evaluate(`${form("Correct applied ID")}.querySelector('input').value === '${originalId}'`), "correction input did not keep the recorded ID")
    assert(await evaluate(`${form("Correct applied ID")}.innerText.includes('The next retry will read and verify its creation fields before any follow-up writes.')`), "correction description missing")
    await evaluate(`${form("Correct applied ID")}.querySelector('button[type="button"]').click()`)
    assert(await waitForCondition(`!${form("Correct applied ID")}`), "Cancel did not close Correct applied ID")
    assert(await waitForCondition(`document.activeElement === window.__restoreRecoveryButton`), "Cancel did not return focus to Correct applied ID")
    await open("Correct applied ID", "Reconciled smoke policy")
    assert(await waitForCondition(`document.activeElement === ${form("Correct applied ID")}?.querySelector('input')`), "Correct applied ID did not focus the input")
    await press("Escape")
    assert(await waitForCondition(`!${form("Correct applied ID")}`), "Escape did not close Correct applied ID")
    assert(await waitForCondition(`document.activeElement === window.__restoreRecoveryButton`), "Escape did not return focus to Correct applied ID")
    assert(await evaluate(`!window.__restoreRequests.some(r => r.action === 'applied' && r.key === 'smoke-correct')`), "closing Correct applied ID sent a request")
    await open("Correct applied ID", "Reconciled smoke policy")
    await fill("Correct applied ID", correctedId)
    await submit("Correct applied ID")
    assert(await waitForCondition(`!${form("Correct applied ID")}`), "successful correction did not close the input")
    assert(await evaluate(`window.__restoreRequests.some(r => r.action === 'applied' && r.key === 'smoke-correct' && r.objectId === '${correctedId}' && r.confirmed === true && r.tenantId === '${tenantId}')`), "corrected ID did not send the confirmed reconciliation")
    assert(await waitForText(`Object ${correctedId}`), "corrected object ID was not displayed")
    assert(await waitForCondition(`document.activeElement === window.__restoreRecoveryButton`), "successful correction did not return focus to Correct applied ID")

    await evaluate(`window.__restoreHoldApplied = true`)
    await open("Correct applied ID", "Reconciled smoke policy")
    await submit("Correct applied ID")
    assert(await waitForCondition(`${form("Correct applied ID")}?.querySelector('input')?.disabled && typeof window.__restoreAppliedResponse === 'function'`), "correction save was not held pending")
    await evaluate(`(() => {
      const row = window.__restoreRecoveryButton.parentElement;
      [...row.querySelectorAll('button')].find(b => b.textContent.trim() === 'Allow a new operation').click();
    })()`)
    assert(await waitForText("Start a new operation?"), "new operation did not open the confirm dialog")
    await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Allow a new operation').click()`)
    assert(await waitForCondition(`!document.body.innerText.includes('Reconciled smoke policy')`), "new operation did not remove the edited record")
    assert(await evaluate(`window.__restoreRequests.some(r => r.action === 'new-operation' && r.key === 'smoke-correct' && r.confirmed === true)`), "new operation did not send the confirmed request")
    assert(await evaluate(`!${form("Correct applied ID")} && !window.__restoreRecoveryButton.isConnected`), "removed record left its recovery form open")
    assert(await waitForCondition(`document.activeElement?.textContent.trim() === 'Refresh history'`), "removing the edited record did not focus Refresh history before the save resolved")
    await evaluate(`window.__restoreAppliedResponse()`)
    await click("Refresh history")
    assert(await waitForCondition(`!${form("Correct applied ID")} && document.activeElement?.textContent.trim() === 'Refresh history'`), "completed save for a removed record did not keep focus on Refresh history")
  } finally {
    await evaluate(`window.__restoreFailAppliedResponse?.(); window.__restoreAppliedResponse?.(); document.removeEventListener('keydown', window.__restoreEscapeProbe); window.fetch = window.__restoreFetch; delete window.__restoreFetch; delete window.__restoreRequests; delete window.__restoreFailList; delete window.__restoreFailApplied; delete window.__restoreFailAppliedResponse; delete window.__restoreHoldApplied; delete window.__restoreAppliedResponse; delete window.__restoreRecoveryButton; delete window.__restoreEscapeEvents; delete window.__restoreEscapeProbe`)
  }
})

await check("OpenIntuneBaseline run loading errors offer retry without an empty state", async () => {
  await evaluate(`(() => {
    window.__runsFetch = window.fetch;
    window.__runsRequests = 0;
    window.fetch = (input, init) => {
      if (String(input) !== '/api/oib' || JSON.parse(init.body).action !== 'oib-runs') return window.__runsFetch(input, init);
      window.__runsRequests++;
      return window.__runsRequests === 1
        ? Promise.reject(new Error('Deployment history unavailable.'))
        : Promise.resolve(Response.json({ runs: [] }));
    };
  })()`)
  const history = `document.querySelector('section[aria-label="Deployment runs"]')`
  try {
    await go("#/portal/oib", "Deployment history")
    assert(await waitForCondition(`${history}?.innerText.includes('Deployment history unavailable.')`), "run loading failure was hidden")
    // Allow unrelated version requests and renders to settle before counting initial run requests.
    await sleep(500)
    assert(await evaluate(`window.__runsRequests === 1`), "mount sent duplicate run requests")
    assert(!(await evaluate(`${history}.innerText.includes('No deployments that can be undone are recorded for this tenant.')`)), "failed request showed the empty state")
    await screenshot("19-oib-run-error")
    await evaluate(`[...${history}.querySelectorAll('button')].find(b => b.textContent.trim() === 'Retry').click()`)
    assert(await waitForCondition(`${history}?.innerText.includes('No deployments that can be undone are recorded for this tenant.')`), "successful retry did not show the empty state")
    assert(await evaluate(`window.__runsRequests === 2`), "Retry did not send one run request")
    assert(!(await evaluate(`${history}.innerText.includes('Deployment history unavailable.')`)), "successful retry did not clear the error")
  } finally {
    await evaluate(`window.fetch = window.__runsFetch; delete window.__runsFetch; delete window.__runsRequests`)
  }
})

await check("local recovery key notices link to the export action", async () => {
  await go("#/portal/overview", "Save your backup recovery key")
  await evaluate(`[...document.querySelectorAll("a")].find(a => a.textContent.trim() === "Go to Save recovery key").click()`)
  assert(await waitForText("Backups on this device"), "recovery key notice did not open Settings")
  assert(await waitForText("Save your backup recovery key"), "local storage recovery key notice missing from Settings")
  assert(await waitForCondition(`document.activeElement?.id === "save-recovery-key"`), "recovery key notice did not focus the export action")
  await screenshot("09b-recovery-key-notice")
})

// Network independent: the landing page renders before the OIB source is read from GitHub.
await check("OpenIntuneBaseline has its own section and left the framework catalog", async () => {
  assert(await evaluate(`[...document.querySelectorAll("nav a")].some(a => a.getAttribute("href") === "#/portal/oib")`), "sidebar item missing")
  await go("#/portal/oib", "Existing Deployment")
  assert(await waitForText("New Deployment") && await waitForText("Policy Validation"), "workflow cards missing")
  await screenshot("10-oib")
  await evaluate(`location.hash = "#/portal/frameworks/oib"`)
  assert(await waitForCondition(`location.hash === "#/portal/oib"`), "frameworks/oib did not redirect")
  await go("#/portal/frameworks", "Frameworks")
  assert(!(await evaluate(`[...document.querySelectorAll("a")].some(a => a.getAttribute("href") === "#/portal/frameworks/oib")`)), "OIB still listed as a framework")
  const unknown = await evaluate(`fetch("/api/oib", { method: "POST", body: JSON.stringify({ action: "nope" }) }).then(async r => [r.status, (await r.json()).error])`)
  assert(unknown[0] === 400 && /Unknown OpenIntuneBaseline action/.test(unknown[1]), `unexpected response ${JSON.stringify(unknown)}`)
  assert(await evaluate(`typeof window.tenuvault.reports?.savePdf === "function"`), "PDF report bridge missing")
  assert(await evaluate(`typeof window.tenuvault.reports?.saveFile === "function"`), "export save bridge missing")
})

await check("OpenIntuneBaseline action bar stays readable in dark mode", async () => {
  // Network independent: renders the action bar's classes (FlowShell ActionBar) instead of opening a
  // workflow, which first reads the OpenIntuneBaseline releases from GitHub.
  await go("#/portal/dashboard", "Dashboard")
  await evaluate(`document.documentElement.classList.add('dark')`)
  try {
    // Relative luminance of the bar and of its summary text; WCAG AA for normal text needs 4.5:1.
    const contrast = await evaluate(`(() => {
      const bar = document.createElement("div")
      bar.className = "sticky bottom-0 border-t border-gray-100 bg-white/95 px-7 py-4 backdrop-blur"
      const text = document.createElement("p")
      text.className = "text-sm text-gray-600"
      text.textContent = "Select at least one platform"
      bar.append(text)
      document.body.append(bar)
      // Chromium may report oklab() or a translucent color, so paint it over the page background
      // on a canvas and read back sRGB.
      const page = getComputedStyle(document.body).backgroundColor
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1
      const ctx = canvas.getContext("2d", { willReadFrequently: true })
      const rgb = c => { ctx.fillStyle = page; ctx.fillRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3) }
      const lum = c => { const [r, g, b] = rgb(c).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
      const background = getComputedStyle(bar).backgroundColor, color = getComputedStyle(text).color
      bar.remove()
      const a = lum(background), b = lum(color)
      return { background, color, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
    })()`)
    console.log(`     ${JSON.stringify(contrast)}`)
    assert(contrast.ratio >= 4.5, `action bar text contrast ${contrast.ratio.toFixed(2)}:1 is below 4.5:1`)
  } finally {
    await evaluate(`document.documentElement.classList.remove('dark')`)
  }
})

await check("dashboard shows the selected tenant in light and dark", async () => {
  const scroll = (to) => evaluate(`[document.scrollingElement, ...document.querySelectorAll("*")].filter(e => e && e.scrollHeight > e.clientHeight + 4 && getComputedStyle(e).overflowY !== "visible" || e === document.scrollingElement).forEach(e => { e.scrollTop = ${to} })`)
  const wasDark = await evaluate(`document.documentElement.classList.contains("dark")`)
  await go("#/portal/dashboard", "Contoso 1")
  assert(await waitForText("Policies protected"), "dashboard tiles missing")
  await sleep(1500)
  for (const dark of [false, true]) {
    await evaluate(`document.documentElement.classList.toggle("dark", ${dark})`)
    await sleep(300)
    const suffix = dark ? "dark" : "light"
    await scroll(0)
    await screenshot(`08b-dashboard-tenant-${suffix}`)
    await scroll(100000)
    await screenshot(`08c-dashboard-tenant-${suffix}-end`)
    await scroll(0)
    await go("#/portal/overview", "All tenants")
    await sleep(500)
    await screenshot(`08d-overview-${suffix}`)
    await go("#/portal/dashboard", "Contoso 1")
    await sleep(500)
  }
  await evaluate(`document.documentElement.classList.toggle("dark", ${wasDark})`)
})

await check("restore deep links and navigation preserve the selected tab", async () => {
  await go("#/portal/backup?tab=restore", "Backup & Restore")
  // The sidebar already contains "Backup & Restore" before the lazy page loads.
  assert(await waitForCondition(`[...document.querySelectorAll('nav button')].some(b => b.innerText.trim() === 'Restore')`), "restore tab missing")
  assert(await evaluate(`location.hash.includes('tab=restore')`), "restore tab lost its URL state")
})

await check("search with no matches and missing dates stay truthful", async () => {
  await go("#/portal/tenants", "Tenant Management")
  assert(!(await evaluate(`document.body.innerText.includes('NaN') || document.body.innerText.includes('Next backup in 2 hours')`)), "invented time shown")
  await evaluate(`(() => { const input = document.querySelector('[aria-label="Search tenants"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'no-such-tenant'); input.dispatchEvent(new Event('input', {bubbles:true})); })()`)
  assert(await waitForText("No matching tenants"), "search claims no tenants are configured")
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText === 'Clear search').click()`)
})

await check("appearance can switch to dark and back", async () => {
  await go("#/portal/settings?section=appearance", "Appearance")
  await evaluate(`(() => { const select = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'dark')); select.value = 'dark'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  assert(await evaluate(`document.documentElement.classList.contains('dark')`), "dark appearance was not applied")
  await screenshot("12-settings-dark")
  await go("#/portal/onboarding", "Create the app registration")
  const contrast = await evaluate(`(() => {
    const style = getComputedStyle(document.querySelector('[class~="bg-blue-50/60"]'));
    const luminance = color => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0); };
    const a = luminance(style.color), b = luminance(style.backgroundColor);
    const button = getComputedStyle(document.querySelector('button.bg-blue-600')); const c = luminance(button.color), d = luminance(button.backgroundColor); return Math.min((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), (Math.max(c, d) + 0.05) / (Math.min(c, d) + 0.05));
  })()`)
  assert(contrast >= 4.5, `dark setup card contrast is too low: ${contrast}`)
  await screenshot("13-setup-dark")
  await go("#/portal/settings?section=appearance", "Appearance")
  await evaluate(`(() => { const select = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'light')); select.value = 'light'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  await go("#/portal/backup?tab=schedule", "Automatic backups")
})

await check("unsaved schedule drafts stay with their tenant", async () => {
  await go("#/portal/backup?tab=schedule", "Automatic backups")
  await evaluate(`document.querySelector('label input[type="checkbox"]').click()`)
  await sleep(100)
  await evaluate(`(() => { const input = document.getElementById('schedule-time'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '07:45'); input.dispatchEvent(new Event('input', {bubbles:true})); })()`)
  const switchTenant = async name => {
    await evaluate(`document.querySelector('button[aria-label^="Switch tenant"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))`)
    await sleep(150)
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(item => item.innerText.includes(${JSON.stringify(name)})).click()`)
    await sleep(250)
  }
  await switchTenant('Contoso 2')
  assert(await evaluate(`!document.querySelector('label input[type="checkbox"]').checked`), 'draft enabled backups for another tenant')
  await switchTenant('Contoso 1')
  assert(await waitForCondition(`document.getElementById('schedule-time')?.value === '07:45'`), 'tenant draft was discarded')
  await go("#/portal/settings?section=appearance", "Appearance")
  await go("#/portal/backup?tab=schedule", "Automatic backups")
  assert(await waitForCondition(`document.getElementById('schedule-time')?.value === '07:45'`), 'navigation discarded the draft')
})

await check("switching tenants cannot show an older tenant's drift results", async () => {
  // Scans run as main-process jobs; this stands in for /api/drift-scan and holds the first tenant's scan open.
  await evaluate(`(() => {
    window.__originalFetch = window.fetch;
    const jobs = [];
    const result = (tenantId, drifts) => ({ schemaVersion: 1, tenantId, jobId: 'job-' + tenantId, storageAccountName: 'tvlocal-' + tenantId, drifts, summary: { total: drifts.length, critical: 0, warning: 0, info: drifts.length, affectedTenants: 1 }, lastScan: new Date().toISOString(), backupsAnalyzed: 2, baseline: { id: 'backup-2026-01-01-000000', timestamp: '2026-01-01T00:00:00.000Z' }, comparison: { id: 'backup-2026-01-02-000000', timestamp: '2026-01-02T00:00:00.000Z' }, warnings: [], stats: { compared: 1, unchanged: 0 } });
    const old = [{ id: 'old', configName: 'OLD-TENANT-RESULT', type: 'Device Configuration', severity: 'info', changeType: 'added', affectedPolicies: 1, affectedDevices: 0, detectedAt: new Date().toISOString() }];
    const backups = ['2026-01-02', '2026-01-01'].map(day => ({ id: 'backup-' + day + '-000000', timestamp: day + 'T00:00:00.000Z', type: 'manual', status: 'Success', totalPolicies: 1, scope: null, size: 1, duration: 1 }));
    window.fetch = (input, init) => {
      // Two complete backups, so the picker can compare them.
      if (String(input) === '/api/list-backups') return Promise.resolve(Response.json({ backups }));
      if (String(input) !== '/api/drift-scan') return window.__originalFetch(input, init);
      const body = JSON.parse(init.body);
      const tenantId = String(body.tenantId ?? '').toLowerCase();
      const job = jobs.find(j => j.tenantId === tenantId);
      if (body.action === 'jobs') return Promise.resolve(Response.json({ jobs }));
      if (body.action === 'result') return Promise.resolve(Response.json({ result: job?.status === 'completed' ? result(tenantId, tenantId.startsWith('11111111') ? old : []) : null }));
      if (body.action === 'cancel') { if (job) job.status = 'cancelled'; return Promise.resolve(Response.json({ ok: true })); }
      if (body.action === 'start') {
        const created = { jobId: 'job-' + tenantId, tenantId, status: 'running', phase: 'comparing', detail: 'Comparing', done: 0, total: 1, percent: 10, startedAt: new Date().toISOString(), baseline: null, comparison: null };
        if (job) jobs.splice(jobs.indexOf(job), 1);
        jobs.push(created);
        if (tenantId.startsWith('11111111')) window.__oldScanStatus = () => created.status, window.__oldScanResolve = () => Object.assign(created, { status: 'completed', percent: 100, finishedAt: new Date().toISOString() });
        else Object.assign(created, { status: 'completed', percent: 100, finishedAt: new Date().toISOString() });
        return Promise.resolve(Response.json({ job: created }));
      }
      return window.__originalFetch(input, init);
    };
  })()`)
  try {
    await go("#/portal/drift", "Drift Detection")
    await assertPageInMain("Drift Detection", "drift detection page")
    await sleep(300)
    // The page may have scanned this tenant already, so start one explicitly when it did not.
    if (!(await evaluate(`typeof window.__oldScanResolve === 'function'`))) {
      await sleep(500)
      await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Compare').click()`)
      await sleep(300)
    }
    assert(await evaluate(`typeof window.__oldScanResolve === 'function'`), 'first tenant scan did not start')
    // The running scan fills the page as an overlay; the sidebar stays usable underneath it.
    assert(await waitForCondition(`!!document.querySelector('[aria-label="Drift scan in progress"] [role="progressbar"]')`), 'drift scan overlay did not show')
    await screenshot("06b-drift-running")
    await evaluate(`document.querySelector('button[aria-label^="Switch tenant"]').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,button:0,pointerType:'mouse'}))`)
    await sleep(150)
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(item => item.innerText.includes('Contoso 2')).click()`)
    await sleep(650)
    assert((await evaluate(`window.__oldScanStatus()`)) === 'running', 'switching tenants ended the first scan')
    await evaluate(`window.__oldScanResolve()`)
    await sleep(2500)
    assert(!(await evaluate(`document.body.innerText.includes('OLD-TENANT-RESULT')`)), 'old tenant scan replaced the active tenant results')
  } finally {
    await evaluate(`window.fetch = window.__originalFetch; delete window.__originalFetch; delete window.__oldScanResolve; delete window.__oldScanStatus`)
    await evaluate(`document.querySelector('button[aria-label^="Switch tenant"]').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,button:0,pointerType:'mouse'}))`)
    await sleep(150)
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(item => item.innerText.includes('Contoso 1')).click()`)
    await go("#/portal/backup?tab=schedule", "Automatic backups")
  }
})

// The scheduler checks every minute, so this waits for the next slot: up to two minutes.
await check("scheduled backups of a second tenant without a license fail with the Community reason", async () => {
  const tenantId = "11111111-1111-1111-1111-111111111111"
  const at = new Date(Date.now() + 60_000)
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
  await evaluate(`window.tenuvault.schedules.set({ tenantId: "${tenantId}", enabled: true, frequency: "daily", time: "${time}" })`)
  let schedule = null
  for (let i = 0; i < 90 && !schedule?.lastAttemptAt; i++) {
    await sleep(2000)
    schedule = (await evaluate(`window.tenuvault.schedules.list()`)).find((s) => s.tenantId === tenantId)
  }
  assert(schedule?.lastStatus === "Failed", `scheduled backup did not fail: ${JSON.stringify(schedule)}`)
  assert(/Community covers one tenant/i.test(schedule.lastMessage ?? ""), `unexpected reason ${JSON.stringify(schedule)}`)
  const refusals = await evaluate(`window.tenuvault.schedules.refusals("${tenantId}")`)
  assert(
    refusals.length === 1 && refusals[0].trigger === "scheduled" && refusals[0].tenantName === "Contoso 1" && /Community covers one tenant/i.test(refusals[0].reason),
    `refusal not logged: ${JSON.stringify(refusals)}`,
  )
  assert(await waitForText("Not backed up because of the license"), "refusal missing from the schedule panel")
  await screenshot("10-refused-backup")
  await evaluate(`window.tenuvault.schedules.remove("${tenantId}")`)
})

await check("a second tenant without a license cannot be added on Community", async () => {
  const refusal = await evaluate(`window.tenuvault.license.checkNewTenant("44444444-4444-4444-4444-444444444444")`)
  const message = refusal.planError?.message ?? ""
  assert(refusal.planError?.code === "community_tenant_limit", "Community tenant refusal lost its stable code")
  assert(/tenant was not added/i.test(message) && /Community covers one tenant/i.test(message), `unexpected result ${JSON.stringify(message)}`)
})

await check("tenants connected by an older version without a sign-in keep the first use label", async () => {
  await go("#/", "All tenants")
  assert(await waitForText("License checked at first use"), "label for unchecked tenants missing")
})

await check("compliance scoring notice dismisses once on this machine", async () => {
  await evaluate(`(() => {
    localStorage.removeItem('tenuvault-compliance-scoring-v2-dismissed');
    window.__scoringNoticeFetch = window.fetch;
    window.fetch = (input, init) => {
      if (String(input) === '/api/frameworks' && JSON.parse(init.body ?? '{}').action === 'native-history') return Promise.resolve(Response.json({ history: [], persistent: true, scoringChanged: true }));
      return window.__scoringNoticeFetch(input, init);
    };
  })()`)
  try {
    await go("#/portal/frameworks/iso-27001", "Compare your tenant")
    assert(await waitForText("Compliance scoring changed in this version."), "scoring reset notice missing")
    await evaluate(`document.querySelector('[aria-label="Dismiss compliance scoring notice"]').click()`)
    assert(await waitForCondition(`!document.body.innerText.includes('Compliance scoring changed in this version.')`), "scoring notice did not dismiss")
    assert(await evaluate(`localStorage.getItem('tenuvault-compliance-scoring-v2-dismissed') === 'true'`), "scoring dismissal was not saved")
    await go("#/portal/overview", "All tenants")
    await go("#/portal/frameworks/soc2", "Compare your tenant")
    assert(await waitForCondition(`document.body.innerText.includes('No comparison yet')`), "second framework history did not load")
    assert(!(await evaluate(`document.body.innerText.includes('Compliance scoring changed in this version.')`)), "scoring notice repeated on another framework")
  } finally {
    await evaluate(`window.fetch = window.__scoringNoticeFetch; delete window.__scoringNoticeFetch`)
  }
})

await check("paid roadmap screens explain their plan and the server refuses Community", async () => {
  for (const [hash, title] of [["#/portal/governance", "Governance"], ["#/portal/changes", "Changes"], ["#/portal/operations", "Operations"], ["#/portal/baselines", "baselines"]]) {
    await go(hash, title)
    await sleep(300)
    await screenshot(`12-${title.toLowerCase()}`)
  }
  const tenant = "11111111-2222-3333-4444-555555555555"
  const result = await evaluate(`fetch("/api/scores", { method: "POST", body: JSON.stringify({ tenantId: "${tenant}", action: "summary" }) }).then(r => r.status)`)
  assert(result === 402, `Community reached a paid roadmap action: ${result}`)
  const audit = await evaluate(`fetch("/api/audit/logs", { method: "POST", body: JSON.stringify({ tenantId: "${tenant}" }) }).then(r => r.status)`)
  assert(audit === 402, `Community reached the audit log: ${audit}`)
})

await check("tenant changes wait for the disclaimer, once per tenant", async () => {
  const deploy = `fetch("/api/oib", { method: "POST", body: JSON.stringify({ action: "oib-deploy", tenantId: "11111111-1111-1111-1111-111111111111", items: [] }) }).then(async r => [r.status, (await r.json()).error])`
  const buttons = `[...document.querySelectorAll("[role=dialog] button")]`
  const accept = `${buttons}.find(b => b.innerText.trim() === "Accept and continue")`
  const ticks = `[...document.querySelectorAll("[role=dialog] [role=checkbox]")]`
  // Cancelling refuses the change without writing anything.
  await evaluate(`window.__deploy = ${deploy}; true`)
  assert(await waitForText("Before you change this tenant"), "disclaimer did not open")
  assert(await waitForText("No liability is assumed"), "liability text missing")
  assert(!(await evaluate(`${buttons}.some(b => b.innerText.trim() === "Close")`)), "disclaimer can be closed")
  assert(await evaluate(`${accept}.disabled`), "accept enabled before confirming")
  await screenshot("13-disclaimer")
  await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`)
  await sleep(300)
  assert(await evaluate(`!!document.querySelector("[role=dialog]")`), "Escape closed the disclaimer")
  await evaluate(`${buttons}.find(b => b.innerText.trim() === "Cancel change").click()`)
  const cancelled = await evaluate(`window.__deploy`)
  assert(cancelled[0] === 428 && /No changes were made/.test(cancelled[1]), `unexpected cancel ${JSON.stringify(cancelled)}`)
  // Accepting records the tenant and sends the change again.
  await evaluate(`window.__deploy = ${deploy}; true`)
  assert(await waitForText("Before you change this tenant"), "disclaimer did not open again")
  await evaluate(`document.querySelector("[role=dialog] .overflow-y-auto").scrollTop = 1e6; document.querySelector("[role=dialog] .overflow-y-auto").dispatchEvent(new Event("scroll"))`)
  await evaluate(`${ticks}.forEach(t => t.click())`)
  assert(await waitForCondition(`!${accept}.disabled`), "accept stays disabled after confirming")
  await evaluate(`${accept}.click()`)
  const accepted = await evaluate(`window.__deploy`)
  assert(accepted[0] !== 428, `change still refused after accepting ${JSON.stringify(accepted)}`)
  // The same tenant is not asked again.
  const again = await evaluate(deploy)
  assert(again[0] !== 428 && !(await evaluate(`!!document.querySelector("[role=dialog]")`)), "disclaimer asked twice for one tenant")
})

await checkSchedulePanel({ check, evaluate, waitForCondition, screenshot, assert })

await check("a saved key before tenant sign-in stays neutral with activation guidance", async () => {
  const chip = `document.querySelector('aside a[href="#/license"] span.ml-auto')`
  try {
    const status = await evaluate(`window.tenuvault.license.setKey("SMOKE-LICENSE-KEY")`)
    assert(status.keyState === "pending" && status.keyMessage === null && status.message.includes("Sign in to a tenant"), "saving a key without tenants did not produce pending guidance")
    await go("#/license", "License key saved")
    assert(await waitForCondition(`${chip}?.textContent === "Key saved" && ${chip}.classList.contains("bg-gray-100")`), "saved key chip is not neutral")
    await send("Page.reload")
    assert(await waitForText("License key saved"), "saved key title changed after reload")
    await disableAnimations()
    assert(await waitForCondition(`${chip}?.textContent === "Key saved"`), "saved key chip changed after reload")
  } finally {
    await evaluate(`window.tenuvault.license.deactivate()`)
    assert(await waitForCondition(`${chip}?.textContent === "Community"`), "deactivation did not restore Community")
  }
})

if (licenseKey) {
  // No tenant is signed in, so the key is only saved; it activates when a tenant is used.
  await check("a license key is saved until a tenant signs in", async () => {
    const status = await evaluate(`window.tenuvault.license.setKey(${JSON.stringify(licenseKey)})`)
    assert(status.hasKey, `key not saved: ${JSON.stringify(status)}`)
    await go("#/license", "License key saved")
    await screenshot("11-license-saved")
  })
}

await finish()

async function finish() {
  ws.close()
  const exited = new Promise((r) => app.once("exit", r))
  app.kill()
  await Promise.race([exited, sleep(5000)])
  // Chromium helper processes can hold the profile briefly on Windows; cleanup must not fail the run.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (error) {
    console.warn(`Could not remove smoke profile ${profile}: ${error.message}`)
  }

  if (renderFailures > expectedRenderFailures) {
    failures++
    console.log(`FAIL ${renderFailures - expectedRenderFailures} unexpected page render failure(s) were logged during the run`)
  }
  if (failures > 0) {
    console.log(`\n${failures} smoke check(s) failed. App log:\n${appLog.slice(-4000)}`)
    process.exit(1)
  }
  console.log(`\nAll smoke checks passed. Screenshots: ${shotsDir}`)
  process.exit(0)
}
