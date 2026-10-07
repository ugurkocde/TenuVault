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

const require = createRequire(import.meta.url)
const electronPath = require("electron")
const desktopDir = resolve(import.meta.dirname, "..")
const shotsDir = resolve(process.argv[2] ?? join(desktopDir, "out", "smoke"))

const licenseKey = process.argv[3] ? readFileSync(process.argv[3], "utf8").trim() : null
const port = 9300 + Math.floor(Math.random() * 500)
const profile = mkdtempSync(join(tmpdir(), "tenuvault-smoke-"))
mkdirSync(shotsDir, { recursive: true })

const packagedApp = process.env.TENUVAULT_SMOKE_APP
const args = [...(packagedApp ? [] : [desktopDir]), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`]
if (process.platform === "linux") args.push("--no-sandbox")
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
const pending = new Map()
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data)
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
  await sleep(1000)
  await screenshot("01-dashboard")
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
  await go("#/portal/settings", "Backups on this device")
  assert(await waitForText("Key fingerprint"), "encryption key section missing")
  await screenshot("05-settings")
})

await check("license agreement opens from settings", async () => {
  await go("#/portal/settings", "License agreement")
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
  await go("#/portal/settings", "Background and retention")
  assert(await waitForText("Keep backups for"), "retention setting missing")
  assert(await waitForText("Download and install updates automatically"), "update setting missing")
  assert(await waitForText("Get nightly builds"), "nightly update setting missing")
  const prefs = await evaluate(`window.tenuvault.preferences.set({ nightlyUpdates: true })`)
  assert(prefs.nightlyUpdates === true, `nightly preference not stored ${JSON.stringify(prefs)}`)
  await evaluate(`window.tenuvault.preferences.set({ nightlyUpdates: false })`)
})

await check("schedules are stored by the main process", async () => {
  const list = await evaluate(`window.tenuvault.schedules.set({ tenantId: "11111111-1111-1111-1111-111111111111", enabled: true, frequency: "daily", time: "02:00" })`)
  assert(list.length === 1 && list[0].nextRunAt, `unexpected schedules ${JSON.stringify(list)}`)
  await evaluate(`window.tenuvault.schedules.remove("11111111-1111-1111-1111-111111111111")`)
})

await check("several tenants get the overview, switcher and schedule tab", async () => {
  const tenant = (id, n) => ({
    id: n, name: `Contoso ${n}`, domain: `contoso${n}.onmicrosoft.com`, status: "healthy", lastBackup: "", configCount: 0, storageUsed: "",
    client: "", license: "", region: "", tags: [], users: 0, devices: 0, complianceRate: 0, industry: "", environment: "", lastSync: "",
    syncStatus: "idle", policies: { compliance: 0, configuration: 0, apps: 0 },
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
  await screenshot("08-overview")
  await go("#/portal/backup", "Backup History")
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.innerText.trim() === "Schedule")?.click()`)
  assert(await waitForText("Automatic backups"), "schedule panel missing")
  await screenshot("09-schedule")
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
  await go("#/portal/settings", "Appearance")
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
  await go("#/portal/settings", "Appearance")
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
  await go("#/portal/settings", "Appearance")
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
    window.fetch = (input, init) => {
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
        if (tenantId.startsWith('11111111')) window.__oldScanResolve = () => Object.assign(created, { status: 'completed', percent: 100, finishedAt: new Date().toISOString() });
        else Object.assign(created, { status: 'completed', percent: 100, finishedAt: new Date().toISOString() });
        return Promise.resolve(Response.json({ job: created }));
      }
      return window.__originalFetch(input, init);
    };
  })()`)
  try {
    await go("#/portal/drift", "Drift Detection")
    await sleep(300)
    // The page may have scanned this tenant already, so start one explicitly when it did not.
    if (!(await evaluate(`typeof window.__oldScanResolve === 'function'`))) {
      await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('Compare latest backups')).click()`)
      await sleep(300)
    }
    assert(await evaluate(`typeof window.__oldScanResolve === 'function'`), 'first tenant scan did not start')
    await evaluate(`document.querySelector('button[aria-label^="Switch tenant"]').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,button:0,pointerType:'mouse'}))`)
    await sleep(150)
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(item => item.innerText.includes('Contoso 2')).click()`)
    await sleep(650)
    await evaluate(`window.__oldScanResolve()`)
    await sleep(2500)
    assert(!(await evaluate(`document.body.innerText.includes('OLD-TENANT-RESULT')`)), 'old tenant scan replaced the active tenant results')
  } finally {
    await evaluate(`window.fetch = window.__originalFetch; delete window.__originalFetch; delete window.__oldScanResolve`)
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
  for (let i = 0; i < 90 && !schedule?.lastRunAt; i++) {
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
  let message = ""
  await evaluate(`window.tenuvault.license.checkNewTenant("44444444-4444-4444-4444-444444444444")`).catch((error) => (message = error.message))
  assert(/tenant was not added/i.test(message) && /Community covers one tenant/i.test(message), `unexpected result ${JSON.stringify(message)}`)
})

await check("tenants connected by an older version without a sign-in keep the first use label", async () => {
  await go("#/", "All tenants")
  assert(await waitForText("License checked at first use"), "label for unchecked tenants missing")
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

  if (failures > 0) {
    console.log(`\n${failures} smoke check(s) failed. App log:\n${appLog.slice(-4000)}`)
    process.exit(1)
  }
  console.log(`\nAll smoke checks passed. Screenshots: ${shotsDir}`)
  process.exit(0)
}
