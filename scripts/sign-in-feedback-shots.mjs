/** Capture sign-in feedback screens from the built app with fictional data and swapped IPC handlers. */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const require = createRequire(import.meta.url)
const electronPath = require("electron")
const desktopDir = resolve(import.meta.dirname, "..")
const shotsDir = resolve(process.argv[2] ?? join(desktopDir, "out", "sign-in-feedback-shots"))

const NOW = Date.now()
const DAY = 86400000
const CLIENT_ID = "5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3"
const TENANTS = [
  { id: 1, name: "Contoso Ltd", guid: "8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14", domain: "contoso.onmicrosoft.com", local: true },
  { id: 2, name: "Fabrikam Inc", guid: "2f9d4a7c-1b6e-4c3d-8a5f-9e0b7c2d4a61", domain: "fabrikam.onmicrosoft.com", local: false },
]
const MOCK = {
  tenants: TENANTS.map(t => ({ id: t.id, name: t.name, domain: t.domain, status: "healthy", tags: [], configCount: 0, users: 0, devices: 0, policies: { compliance: 0, configuration: 0, apps: 0 }, credentials: { tenantId: t.guid, appId: CLIENT_ID, clientSecret: "tenuvault-desktop-delegated-auth" }, resources: { subscriptionId: t.local ? "local" : CLIENT_ID, resourceGroupName: t.local ? "local" : "rg-backups", storageAccountName: t.local ? `tvlocal-${t.guid}` : "stfabrikamintune", automationAccountName: "" } })),
  accounts: TENANTS.map(t => ({ tenantId: t.guid, clientId: CLIENT_ID, username: `admin@${t.domain}`, name: t.name })),
  license: { hasKey: true, keyState: "active", keyHint: "****TEST", persisted: true, offline: false, message: null, plan: "pro", tenantLimit: 2, communityTenantId: null, tenants: TENANTS.map(t => ({ tenantId: t.guid, signedIn: true, activated: true, entitled: true, source: "key", plan: "pro", expiresAt: new Date(NOW + DAY).toISOString() })) },
  schedules: TENANTS.map(t => ({ tenantId: t.guid, enabled: true, frequency: "daily", time: "02:00", since: new Date(NOW - DAY).toISOString(), attempts: 0, nextRunAt: null })),
  preferences: { startAtLogin: false, keepRunningInTray: true, retentionDays: 30, autoUpdate: true, nightlyUpdates: false },
  backupSettings: { localFolder: "TenuVault Backups", keyFingerprint: "7F3A-91C2-4D0E", recoveryExported: true },
}
const MAIN_OVERRIDES = `(() => {
  const req = process.getBuiltinModule("module").createRequire(process.cwd() + "/x.cjs")
  const { ipcMain, BrowserWindow } = req("electron")
  const M = globalThis.__marketingMock = ${JSON.stringify(MOCK)}
  const handle = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, (_event, ...args) => fn(...args)) }
  const json = value => ({ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(value)) })
  handle("api", request => request.path === "/api/notifications" ? json({ licensed: false, runtimeNote: "Runs while TenuVault is running.", channels: [{ id: "local", kind: "local", title: "This computer", enabled: true, recipients: [], lastDelivery: null }], rules: [], auditWatch: { enabled: true, intervalMinutes: 15, categories: [], ignoreOwnChanges: true, includeActor: false, externalWatcher: false, lastPollAt: null, lastError: null, watermark: null, conditionalAccess: { enabled: false, watermark: null, lastPollAt: null, lastError: null } }, deliveries: [] }) : request.path === "/api/reports" ? json({ licensed: false, runtimeNote: "Runs while TenuVault is running.", reports: [], settings: { afterScheduledBackup: true, recipients: [], includeValues: true } }) : json({ backups: [], data: [], entries: [], records: [], tenants: [], jobs: [], exists: true }))
  handle("auth:accounts", () => M.accounts)
  handle("license:status", () => M.license)
  handle("schedules:list", () => M.schedules)
  handle("schedules:refusals", () => [])
  handle("preferences:get", () => M.preferences)
  handle("backups:settings", () => M.backupSettings)
  handle("backups:scope", () => ({ scope: { excluded: ["Apps"] }, saved: true }))
  handle("updates:status", () => ({ state: "not-available" }))
  const blocked = new Set(["license:changed", "schedules:changed", "schedules:refusalsChanged", "updates:changed", "auth:signInRequired"])
  for (const win of BrowserWindow.getAllWindows()) {
    const send = win.webContents.send.bind(win.webContents)
    win.webContents.send = (channel, ...args) => blocked.has(channel) ? undefined : send(channel, ...args)
  }
  return BrowserWindow.getAllWindows().length
})()`

const port = 9300 + Math.floor(Math.random() * 400)
const inspectPort = port + 400
const profile = mkdtempSync(join(tmpdir(), "tenuvault-sign-in-feedback-"))
mkdirSync(shotsDir, { recursive: true })

const args = [desktopDir, `--remote-debugging-port=${port}`, `--inspect=${inspectPort}`, `--user-data-dir=${profile}`]
if (process.platform === "linux") args.push("--no-sandbox", "--ozone-platform=x11")
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(electronPath, args, { stdio: ["ignore", "pipe", "pipe"], env })
let appLog = ""
app.stdout.on("data", (d) => (appLog += d))
app.stderr.on("data", (d) => (appLog += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target(url, pick) {
  for (let i = 0; i < 60; i++) {
    try {
      const found = (await (await fetch(url)).json()).find(pick)
      if (found) return found.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error(`No debug target at ${url}. App log:\n${appLog.slice(-4000)}`)
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true })
    ws.addEventListener("error", j, { once: true })
  })
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
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectSend(new Error(`${method} timed out`))
      }, 30000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) rejectSend(new Error(`${method}: ${message.error.message}`))
        else resolveSend(message.result)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  return { ws, send, evaluate }
}

let exitCode = 0
let main = null
let page = null
try {
  // 1. Main process: wait for the window, then swap in the demo IPC handlers.
  main = await connect(await target(`http://127.0.0.1:${inspectPort}/json/list`, (t) => t.type === "node"))
  const windowsReady = `(() => { try { const r = process.getBuiltinModule("module").createRequire(process.cwd() + "/x.cjs"); return r("electron").BrowserWindow.getAllWindows().length } catch { return 0 } })()`
  for (let i = 0; i < 60 && !(await main.evaluate(windowsReady)); i++) await sleep(500)
  await sleep(1000) // bootstrap registers the IPC handlers before it creates the window
  const windows = await main.evaluate(MAIN_OVERRIDES)
  if (!windows) throw new Error("App window not found in the main process")

  // 2. Renderer: seed the tenant profiles in the app's own store, then reload with the demo data.
  page = await connect(await target(`http://127.0.0.1:${port}/json/list`, (t) => t.type === "page"))
  page.ws.addEventListener("message", event => {
    const message = JSON.parse(event.data)
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") console.error(message.params.args.map(arg => arg.description ?? arg.value).join(" "))
  })
  const { send, evaluate } = page
  await send("Page.enable")
  await send("Runtime.enable")

  const waitFor = async (expression, timeout = 20000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await evaluate(expression).catch(() => false)) return true
      await sleep(250)
    }
    return false
  }
  const waitForText = (text, timeout) => waitFor(`document.body?.innerText.includes(${JSON.stringify(text)})`, timeout)
  const assertText = async (text, timeout) => {
    if (!(await waitForText(text, timeout))) throw new Error(`"${text}" did not appear on ${await evaluate("location.hash")}`)
  }
  const disableAnimations = () =>
    evaluate(`(() => {
      if (document.getElementById("marketing-no-animations")) return
      const style = document.createElement("style")
      style.id = "marketing-no-animations"
      style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }"
      document.head.appendChild(style)
    })()`)
  const setTheme = (theme) =>
    evaluate(`localStorage.setItem("tenuvault-appearance", "${theme}"); document.documentElement.classList.toggle("dark", ${theme === "dark"})`)
  const scrollAll = (to) =>
    evaluate(`[document.scrollingElement, ...document.querySelectorAll("*")].filter(e => e && (e === document.scrollingElement || (e.scrollHeight > e.clientHeight + 4 && getComputedStyle(e).overflowY !== "visible"))).forEach(e => { e.scrollTop = ${to} })`)
  const shots = []
  const screenshot = async (name, expectedVerificationFailure = false) => {
    await evaluate(`document.activeElement?.blur?.()`)
    await sleep(400)
    const toast = await evaluate(`[...document.querySelectorAll('[role="status"], [role="alert"]')].map(e => e.innerText).join(" | ")`)
    if (!expectedVerificationFailure && /fail|error|unavailable/i.test(toast)) throw new Error(`Error visible before ${name}: ${toast}`)
    const { data } = await send("Page.captureScreenshot", { format: "png" })
    const file = join(shotsDir, `${name}.png`)
    writeFileSync(file, Buffer.from(data, "base64"))
    shots.push(name)
    console.log(`shot ${file}`)
  }

  await waitFor(`typeof window.tenuvault?.storage?.setItem === "function"`, 30000)
  await main.evaluate(`(() => {
    const req = process.getBuiltinModule("module").createRequire(process.cwd() + "/x.cjs")
    const { ipcMain } = req("electron")
    ipcMain.removeHandler("auth:signIn")
    ipcMain.handle("auth:signIn", () => { throw new Error("Sign-in failed. Check the app registration and try again.") })
    globalThis.__marketingMock.accounts = []
    globalThis.__marketingMock.license.tenants = []
  })()`)
  await evaluate(`Promise.all([
    window.tenuvault.storage.setItem("tenuvault_tenants", "[]"),
    window.tenuvault.storage.setItem("tenuvault.onboarding.draft", ${JSON.stringify(JSON.stringify({ step: 1, tenant: "contoso.onmicrosoft.com", clientId: CLIENT_ID, displayName: "Contoso", account: null }))}),
  ])`)
  await setTheme("light")
  await evaluate(`location.hash = "#/portal/onboarding"; location.reload()`)
  await sleep(1500)
  await assertText("Sign in with Microsoft", 30000)
  await disableAnimations()
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false })
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === "Sign in with Microsoft").click()`)
  await assertText("Tell us what went wrong")
  await scrollAll(0)
  await screenshot("sign-in-failed", true)
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === "Tell us what went wrong").click()`)
  await waitFor(`Boolean(document.querySelector('[role="dialog"]'))`)
  const fields = await evaluate(`[...document.querySelectorAll('[role="dialog"] textarea, [role="dialog"] input[type="email"]')].map(e => e.value)`)
  if (fields.length !== 3 || fields.some(Boolean)) throw new Error("Feedback fields must start empty")
  await screenshot("sign-in-feedback-empty", true)
  console.log(`${shots.length} screenshots captured from the built Electron app`)
} catch (error) {
  exitCode = 1
  console.error(`FAILED: ${error.message}`)
  if (page) {
    const { data } = await page.send("Page.captureScreenshot", { format: "png" }).catch(() => ({}))
    if (data) writeFileSync(join(shotsDir, "failure.png"), Buffer.from(data, "base64"))
  }
} finally {
  page?.ws.close()
  main?.ws.close()
  const exited = new Promise((r) => app.once("exit", r))
  app.kill()
  await Promise.race([exited, sleep(5000)])
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (error) {
    console.warn(`Could not remove profile ${profile}: ${error.message}`)
  }
  process.exit(exitCode)
}
