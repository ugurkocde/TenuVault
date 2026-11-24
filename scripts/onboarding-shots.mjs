/** Capture onboarding from the built app with fictional data and swapped IPC handlers. */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const require = createRequire(import.meta.url)
const electronPath = require("electron")
const desktopDir = resolve(import.meta.dirname, "..")
const shotsDir = resolve(process.argv[2] ?? join(desktopDir, "docs-site/public/images/onboarding"))
const width = Number(process.env.SHOT_WIDTH ?? 1024)
const height = Number(process.env.SHOT_HEIGHT ?? 768)

const NOW = Date.parse("2026-11-15T10:00:00Z")
const DAY = 86400000
const CLIENT_ID = "5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3"
const TENANTS = [
  { id: 1, name: "Contoso Ltd", guid: "8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14", domain: "contoso.onmicrosoft.com", local: true },
  { id: 2, name: "Fabrikam Inc", guid: "2f9d4a7c-1b6e-4c3d-8a5f-9e0b7c2d4a61", domain: "fabrikam.onmicrosoft.com", local: false },
]
const MOCK = {
  tenants: TENANTS.slice(0, 1).map(t => ({ id: t.id, name: t.name, domain: t.domain, status: "healthy", tags: [], configCount: 0, users: 0, devices: 0, policies: { compliance: 0, configuration: 0, apps: 0 }, credentials: { tenantId: t.guid, appId: CLIENT_ID, clientSecret: "tenuvault-desktop-delegated-auth" }, resources: { subscriptionId: t.local ? "local" : CLIENT_ID, resourceGroupName: t.local ? "local" : "rg-backups", storageAccountName: t.local ? `tvlocal-${t.guid}` : "stfabrikamintune", automationAccountName: "" } })),
  accounts: TENANTS.map(t => ({ tenantId: t.guid, clientId: CLIENT_ID, username: `admin@${t.domain}`, name: "Contoso Admin" })),
  license: { hasKey: true, keyState: "active", keyHint: "****TEST", persisted: true, offline: false, message: null, plan: "pro", tenantLimit: 2, communityTenantId: null, tenants: TENANTS.map(t => ({ tenantId: t.guid, signedIn: true, activated: true, entitled: true, source: "key", plan: "pro", expiresAt: new Date(NOW + DAY).toISOString() })) },
  schedules: TENANTS.map(t => ({ tenantId: t.guid, enabled: true, frequency: "daily", time: "02:00", since: new Date(NOW - DAY).toISOString(), attempts: 0, nextRunAt: "2026-11-16T01:00:00Z" })),
  preferences: { startAtLogin: false, keepRunningInTray: true, retentionDays: 30, autoUpdate: true, nightlyUpdates: false },
  backupSettings: { localFolder: "TenuVault Backups", keyFingerprint: "7F3A-91C2-4D0E", recoveryExported: true },
}
const restoreAppId = "61eff188-672b-4be4-acac-2d254a6f9e05"
const backup = { id: "contoso-backup", timestamp: "2026-11-15T10:00:00Z", status: "Completed", type: "manual", totalPolicies: 1, size: 635, duration: 3, changes: null, comparedWith: null }
const policy = { path: "DeviceConfigurations/windows-security.json", displayName: "Windows security baseline" }
const MAIN_OVERRIDES = `(() => {
  const req = process.getBuiltinModule("module").createRequire(process.cwd() + "/x.cjs")
  const { ipcMain, BrowserWindow } = req("electron")
  const M = ${JSON.stringify(MOCK)}
  const handle = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, (_event, ...args) => fn(...args)) }
  const json = value => ({ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(value)) })
  handle("api", ({path}) => {
    const answers = {
      "/api/list-backups": { backups: ${JSON.stringify([backup])} },
      "/api/list-backup-contents": { content: { groups: [{ folder: "DeviceConfigurations", label: "configuration profile", area: "Devices", policies: ${JSON.stringify([policy])} }] } },
      "/api/restore-preview": { items: [{ path: ${JSON.stringify(policy.path)}, name: ${JSON.stringify(policy.displayName)} }] },
      "/api/backup/start": { jobId: "first-backup" },
      "/api/backup/status": { status: "Running", progress: 35, progressMessage: "Backing up Intune policies", isComplete: false, isSuccessful: false },
      "/api/fetch-tenant-details": { organization: { id: M.accounts[0].tenantId, displayName: M.tenants[0].name } },
    }
    return json(answers[path.split("?")[0]] ?? { backups: [], data: [], entries: [], records: [], tenants: [], jobs: [], exists: true })
  })
  handle("setup:checkPermissions", (_tenantId, _clientId, choice) => ({
    missing: choice.entra ? ["Policy.Read.All", "AuthenticationContext.Read.All", "DeviceManagementConfiguration.Read.All"] : [],
  }))
  handle("setup:enrollOwnApp", () => ({ result: true }))
  handle("setup:saveServices", () => undefined)
  handle("setup:clipboardIds", () => null)
  handle("health:check", () => ({
    tenantId: M.accounts[0].tenantId, clientId: "${restoreAppId}", granted: ["DeviceManagementConfiguration.Read.All"],
    services: [{ id: "intune", enabled: true, access: "backup", areas: [] }],
  }))
  handle("auth:connection", () => ({ tenantId: M.accounts[0].tenantId, clientId: "${restoreAppId}", graphScopes: [] }))
  handle("auth:savedDirectoryRestores", () => ({ owner: "Contoso Admin", pages: [] }))
  handle("auth:graphCliAvailable", () => true)
  handle("auth:tenuvaultAppAvailable", () => true)
  handle("services:status", () => ({ tenantId: M.accounts[0].tenantId, modules: [{ id: "intune", enabled: true }] }))
  handle("license:checkNewTenant", () => M.license)
  handle("diagnostics:status", () => ({ state: "unasked", policy: false, reminder: { setup: false, signin: false } }))
  handle("diagnostics:record", () => undefined)
  handle("backups:inventoryProblem", () => null)
  handle("backups:failedAttempts", () => [])
  handle("backups:liveRuns", () => [])
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
const profile = mkdtempSync(join(tmpdir(), "tenuvault-services-"))
mkdirSync(shotsDir, { recursive: true })

const args = [process.env.SHOT_APP_PATH ?? desktopDir, `--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${inspectPort}`, `--user-data-dir=${profile}`, "--proxy-server=http://127.0.0.1:1"]
if (process.platform === "linux") args.push("--no-sandbox", "--ozone-platform=x11", "--password-store=basic")
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
      const found = (await (await fetch(url, { signal: AbortSignal.timeout(1000) })).json()).find(pick)
      if (found) return found.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error(`No debug target at ${url}. App log:\n${appLog.slice(-4000)}`)
}

async function connect(wsUrl, awaitPromise = true) {
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
      }, 10000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) rejectSend(new Error(`${method}: ${message.error.message}`))
        else resolveSend(message.result)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  return { ws, send, evaluate }
}

const scenes = [
  ["01-services", "Choose Intune, Entra ID or Defender for backup."],
  ["02-connect", "Choose how to connect your tenant."],
  ["03-check", "Review backup access after signing in."],
  ["04-missing-permissions", "Review missing Entra ID permissions and find the steps to resolve them."],
  ["05-storage", "Confirm your tenant and choose where to store backups."],
  ["06-first-backup", "Follow the first backup after saving your storage choice."],
]
const captureScenes = process.env.SHOT_STATES?.split(",").includes("07-restore-access")
  ? [...scenes, ["07-restore-access", "Request Intune restore access before selecting a policy."]] : scenes
let exitCode = 0
let main = null
let page = null
try {
  main = await connect(await target(`http://127.0.0.1:${inspectPort}/json/list`, t => t.type === "node"), false)
  page = await connect(await target(`http://127.0.0.1:${port}/json/list`, t => t.type === "page"))
  await main.evaluate(MAIN_OVERRIDES)
  const { send, evaluate } = page
  await send("Page.enable")
  const waitFor = async (expression, attempts = 100) => {
    for (let i = 0; i < attempts; i++) { if (await evaluate(expression).catch(() => false)) return; await sleep(100) }
    throw new Error(`Screen did not become ready: ${expression}`)
  }
  const click = async (text, exact = true) => {
    const selector = `(() => {
      const label = ${JSON.stringify(text)};
      return [...document.querySelectorAll('button')].find(b => !b.disabled && (${exact} ? b.textContent.trim() === label : b.textContent.trim().includes(label)));
    })()`
    await waitFor(`Boolean(${selector})`)
    await evaluate(`${selector}.click()`)
    await sleep(150)
  }
  const showing = text => waitFor(`document.body?.innerText.includes(${JSON.stringify(text)})`)
  const captured = []
  await waitFor(`typeof window.tenuvault?.storage?.setItem === "function"`)
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
  for (const [state, description] of captureScenes) {
    if (process.env.SHOT_STATES && !process.env.SHOT_STATES.split(",").includes(state)) continue
    captured.push([state, description])
    for (const theme of ["light", "dark"]) {
      console.log(`Opening ${state}-${theme}`)
      const restore = state === "07-restore-access"
      const missing = state === "04-missing-permissions"
      const signedIn = state.startsWith("03") || missing || state.startsWith("05") || state.startsWith("06")
      const services = missing ? { entra: { access: "backup" }, conditionalAccess: { access: "backup" }, intune: { access: "backup" } } : { intune: { access: "backup" } }
      const draft = { step: signedIn ? 4 : -1, tenant: signedIn ? TENANTS[0].guid : "", clientId: signedIn ? CLIENT_ID : "", displayName: "", signedInAt: Date.now(), account: signedIn ? MOCK.accounts[0] : null, services }
      const tenants = restore ? MOCK.tenants.map(tenant => ({ ...tenant, credentials: { ...tenant.credentials, appId: restoreAppId } })) : []
      await evaluate(`Promise.all([
        window.tenuvault.storage.setItem("tenuvault_tenants", ${JSON.stringify(JSON.stringify(tenants))}),
        window.tenuvault.storage.setItem("tenuvault_selected_tenant", "1"),
        window.tenuvault.storage.setItem("tenuvault.onboarding.draft", ${JSON.stringify(JSON.stringify(draft))}),
      ])`)
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })
      const route = restore ? "#/portal/backup?tab=restore" : "#/portal/onboarding"
      await evaluate(`localStorage.setItem("tenuvault-appearance", "${theme}"); location.hash = ${JSON.stringify(route)}; location.reload()`)
      await showing(restore ? "Choose a backup" : "Set up TenuVault")
      await evaluate(`document.documentElement.classList.toggle("dark", ${theme === "dark"})`)
      if (restore) {
        await click("1 items", false)
        await showing("Allow restore for Intune")
      } else if (!signedIn) {
        await showing("Which services do you want to connect?")
        const action = await evaluate(`(() => {
          const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === "Continue with Intune");
          const rect = button.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, scrollTop: document.querySelector('main')?.scrollTop ?? 0 };
        })()`)
        if (action.top < 0 || action.bottom > height || action.scrollTop !== 0) throw new Error(`Continue needs scrolling at ${width} by ${height}: ${JSON.stringify(action)}`)
        if (state === "02-connect") { await click("Continue with Intune"); await showing("Start now") }
      } else if (missing) {
        await showing("Copy instructions for my admin")
      } else {
        await showing("Connected. Everything you picked can be backed up.")
        if (state.startsWith("05") || state.startsWith("06")) await click("Continue to storage")
        if (state.startsWith("06")) { await click("Start first backup"); await showing("Your first backup") }
      }
      await evaluate(`document.activeElement?.blur?.()`)
      await sleep(250)
      if (await evaluate(`document.documentElement.scrollWidth > ${width}`)) throw new Error(`Horizontal overflow: ${state}`)
      const { data } = await send("Page.captureScreenshot", { format: "png" })
      writeFileSync(join(shotsDir, `${state}-${theme}.png`), Buffer.from(data, "base64"))
      console.log(`Captured ${state}-${theme} at ${width} by ${height}`)
    }
  }
  const inventory = "# Onboarding flow screenshots\n\nBuilt desktop app using fictional Contoso data and local IPC fixtures. Generated by `node scripts/onboarding-shots.mjs`. The default viewport is 1024 by 768. The script checks that Continue is visible without scrolling on the services screen and that no scene overflows horizontally.\n\n" +
    captured.map(([state, description]) => `* ${state}-light.png, ${state}-dark.png. ${description}\n`).join("")
  writeFileSync(join(shotsDir, "README.md"), inventory)
} catch (error) {
  exitCode = 1
  console.error(error.stack, appLog.slice(-4000))
} finally {
  page?.ws.close()
  main?.ws.close()
  const closed = new Promise(resolve => app.once("exit", resolve))
  app.kill()
  await Promise.race([closed, sleep(1500)])
  if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL")
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  process.exit(exitCode)
}
