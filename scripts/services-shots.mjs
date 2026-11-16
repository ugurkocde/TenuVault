/** Capture connection health, services and incomplete backup results from the built app with fictional data and swapped IPC handlers. */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const require = createRequire(import.meta.url)
const electronPath = require("electron")
const desktopDir = resolve(import.meta.dirname, "..")
const shotsDir = resolve(process.argv[2] ?? "/Users/ugurkoc/Desktop/GitHub/TenuVault/tasks/0.6-research/shots/2b")
const docsDir = join(desktopDir, "docs-site/public/images/services")
mkdirSync(docsDir, { recursive: true })
const { buildSync } = require("esbuild")
const bundle = buildSync({ entryPoints: [join(desktopDir, "test/fixtures/services-health.ts")], bundle: true, platform: "node", format: "esm", write: false })
const { healthScene, incompleteBackupFixture } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"))

const NOW = Date.parse("2026-11-15T10:00:00Z")
const DAY = 86400000
const CLIENT_ID = "5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3"
const TENANTS = [
  { id: 1, name: "Contoso Ltd", guid: "8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14", domain: "contoso.onmicrosoft.com", local: true },
  { id: 2, name: "Fabrikam Inc", guid: "2f9d4a7c-1b6e-4c3d-8a5f-9e0b7c2d4a61", domain: "fabrikam.onmicrosoft.com", local: false },
]
const MOCK = {
  tenants: TENANTS.slice(0, 1).map(t => ({ id: t.id, name: t.name, domain: t.domain, status: "healthy", tags: [], configCount: 0, users: 0, devices: 0, policies: { compliance: 0, configuration: 0, apps: 0 }, credentials: { tenantId: t.guid, appId: CLIENT_ID, clientSecret: "tenuvault-desktop-delegated-auth" }, resources: { subscriptionId: t.local ? "local" : CLIENT_ID, resourceGroupName: t.local ? "local" : "rg-backups", storageAccountName: t.local ? `tvlocal-${t.guid}` : "stfabrikamintune", automationAccountName: "" } })),
  accounts: TENANTS.map(t => ({ tenantId: t.guid, clientId: CLIENT_ID, username: `admin@${t.domain}`, name: t.name })),
  license: { hasKey: true, keyState: "active", keyHint: "****TEST", persisted: true, offline: false, message: null, plan: "pro", tenantLimit: 2, communityTenantId: null, tenants: TENANTS.map(t => ({ tenantId: t.guid, signedIn: true, activated: true, entitled: true, source: "key", plan: "pro", expiresAt: new Date(NOW + DAY).toISOString() })) },
  schedules: TENANTS.map(t => ({ tenantId: t.guid, enabled: true, frequency: "daily", time: "02:00", since: new Date(NOW - DAY).toISOString(), attempts: 0, nextRunAt: "2026-11-16T01:00:00Z" })),
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
const profile = mkdtempSync(join(tmpdir(), "tenuvault-services-"))
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
      }, 60000)
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
  main = await connect(await target(`http://127.0.0.1:${inspectPort}/json/list`, t => t.type === "node"))
  for (let i = 0; i < 60; i++) {
    if (await main.evaluate(`(() => { try { return process.getBuiltinModule("module").createRequire(process.cwd() + "/x.cjs")("electron").BrowserWindow.getAllWindows().length } catch { return 0 } })()`)) break
    await sleep(500)
  }
  await sleep(1000)
  await main.evaluate(MAIN_OVERRIDES)
  await main.evaluate(`(() => {
    const { ipcMain, BrowserWindow } = process.getBuiltinModule("module").createRequire(process.cwd() + "/x.cjs")("electron")
    const handle = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, (_event, ...args) => fn(...args)) }
    const M = globalThis.__marketingMock
    const json = value => ({ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(value)) })
    handle("health:check", () => M.loading ? new Promise(() => {}) : M.health)
    handle("health:report", () => M.health)
    handle("health:acknowledge", () => M.health)
    handle("services:setEnabled", (_tenant, _client, id, enabled) => { M.health.services.find(service => service.id === id).enabled = enabled; return {} })
    handle("backups:inventoryProblem", () => null)
    handle("backups:failedAttempts", () => [])
    handle("backups:liveRuns", () => [])
    handle("backupReader:status", () => ({ supported: true, available: true, reader: null }))
    handle("backgroundLaunch:status", () => ({ installed: true }))
    handle("api", request => {
      if (request.path === "/api/backup/start") return json({ jobId: "desktop-fixture", status: "Running" })
      if (request.path === "/api/backup/status") return json(M.backup)
      if (request.path === "/api/list-backups") return json({ backups: [{ id: "2026-11-14_02-00-00", name: "2026-11-14_02-00-00", timestamp: "2026-11-14T02:00:00Z", status: "Completed", totalPolicies: 36, policyCount: 36, type: "scheduled", size: 46000, duration: 120, counts: { ConfigurationPolicies: 24, CompliancePolicies: 12 } }] })
      return json({ backups: [], data: [], entries: [], records: [], tenants: [], jobs: [], exists: true })
    })
  })()`)
  page = await connect(await target(`http://127.0.0.1:${port}/json/list`, t => t.type === "page"))
  const { send, evaluate } = page
  await send("Page.enable")
  await send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Berlin" })
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `{
    const OriginalDate = Date
    globalThis.Date = class extends OriginalDate {
      constructor(...args) { super(...(args.length ? args : [${NOW}])) }
      static now() { return ${NOW} }
    }
  }` })
  const waitFor = async (expression) => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression).catch(() => false)) return; await sleep(200) }
    throw new Error(`Screen did not become ready: ${expression}`)
  }
  await waitFor(`typeof window.tenuvault?.storage?.setItem === "function"`)
  await evaluate(`Promise.all([window.tenuvault.storage.setItem("tenuvault_tenants", ${JSON.stringify(JSON.stringify(MOCK.tenants))}), window.tenuvault.storage.setItem("tenuvault_selected_tenant", "1")])`)
  const shot = async (state, theme) => {
    await evaluate(`document.activeElement?.blur?.()`)
    await sleep(150)
    const { data } = await send("Page.captureScreenshot", { format: "png" })
    for (const folder of [shotsDir, docsDir]) writeFileSync(join(folder, `${state}-${theme}.png`), Buffer.from(data, "base64"))
    console.log(`shot ${state}-${theme}.png`)
  }
  const click = async text => {
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`)
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`)
  }
  const scenes = [
    "healthy", "first-check", "missing-permission", "restore-only-gap", "partly-verified", "graph-consentMissing", "graph-registrationNotFoundInTenant", "graph-applicationDisabled", "registration-replaced", "reader-expiring", "reader-expired", "reader-lost-access", "changes", "personal-data", "intune-confirmation", "intune-off", "entra-backup-types",
    ...["permission", "notVerifiedYet", "refusedWithPermission", "role", "license", "signedIn", "reader", "notRead"].map(cause => `cause-${cause}`),
    ...["notChecked", "unknown", "signInNeeded", "mfaRequired", "blockedByConditionalAccess", "registrationMisconfigured", "servicePrincipalMissing", "notAssigned", "accountDisabled", "accountLockedOrBlocked", "wrongTenantOrAccount", "throttled", "unreachable"].map(state => `graph-${state}`),
    ...["notSetUp", "pending", "rolesChanged", "refused", "throttled", "unreachable"].map(state => `reader-${state}`),
    ...["healthy", "local", "notChecked", "unknown", "signInNeeded", "mfaRequired", "blockedByConditionalAccess", "consentMissing", "registrationNotFoundInTenant", "registrationMisconfigured", "applicationDisabled", "servicePrincipalMissing", "notAssigned", "accountDisabled", "accountLockedOrBlocked", "wrongTenantOrAccount", "throttled", "unreachable"].map(state => `storage-${state}`),
    "backup-list-intune-off", "schedule-intune-off", "overview-intune-off", "dashboard-intune-off", "tenants-intune-off", "tenants-list-intune-off", "backup-incomplete",
  ]
  const selectedScenes = scenes.filter(state => !process.env.SHOT_STATES || process.env.SHOT_STATES.split(",").includes(state))
  for (const state of selectedScenes) {
    for (const theme of ["light", "dark"]) {
      console.log(`capturing ${state}-${theme}`)
      const health = healthScene(state.includes("intune-off") ? "intune-off" : state)
      await main.evaluate(`Object.assign(globalThis.__marketingMock, { health: ${JSON.stringify(health)}, loading: ${state === "first-check"}, backup: ${JSON.stringify(incompleteBackupFixture)} })`)
      const route = state === "overview-intune-off" ? "#/portal/overview" : state === "dashboard-intune-off" ? "#/portal/dashboard" : (state === "tenants-intune-off" || state === "tenants-list-intune-off") ? "#/portal/tenants" : state === "schedule-intune-off" ? "#/portal/backup?tab=schedule" : state === "backup-list-intune-off" || state === "backup-incomplete" ? "#/portal/backup" : "#/portal/settings?section=services"
      await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 1100, deviceScaleFactor: 1, mobile: false })
      await evaluate(`localStorage.setItem("tenuvault-appearance", "${theme}"); location.hash = ${JSON.stringify(route)}; location.reload()`)
      await waitFor(`document.body?.innerText.includes(${JSON.stringify(state === "first-check" ? "Checking connection health" : route.includes("settings") ? "Microsoft Graph sign-in" : state.includes("intune-off") ? "Intune is off" : "Run Backup")})`)
      await evaluate(`document.documentElement.classList.toggle("dark", ${theme === "dark"}); (() => { const style = document.createElement("style"); style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }"; document.head.appendChild(style) })()`)
      if (state === "missing-permission" || state === "registration-replaced" || state === "restore-only-gap") await evaluate(`document.querySelector('[data-service="intune"] [data-permission-routes]').open = true; document.querySelectorAll('[data-service="intune"] [data-permission-routes] details').forEach(e => e.open = true)`)
      if (state === "restore-only-gap") await evaluate(`document.querySelector('[data-service="intune"] > details').open = true`)
      if (state === "entra-backup-types") {
        await waitFor(`document.querySelector('[data-service="entra"]')?.innerText.includes("Backup: Permissions present")`)
        if (await evaluate(`document.querySelector('[data-service="entra"]').innerText.includes("no backup types for Entra ID yet")`)) throw new Error("Entra ID backup types are missing from Services and permissions")
        await evaluate(`document.querySelector('[data-service="entra"] > details').open = true`)
        if (await evaluate(`["externalIdentities", "roles"].some(id => document.querySelector('[data-service="entra"] [data-area="' + id + '"]').innerText.includes("no backup types"))`)) throw new Error("External identities or Roles and PIM types are missing")
      }
      if (state === "personal-data") await evaluate(`document.querySelector('[data-service="entra"] > details').open = true`)
      if (state === "reader-lost-access" || state === "partly-verified" || state.startsWith("cause-")) await evaluate(`document.querySelector('[data-service="intune"] > details').open = true`)
      if (state === "intune-confirmation") {
        await evaluate(`document.querySelector('input[aria-label="Include Intune in backups"]').click()`)
        await waitFor(`document.querySelector('[role="dialog"]')?.innerText.includes("Turn off Intune?")`)
      }
      if (state === "backup-incomplete") {
        await click("Run Backup")
        await waitFor(`document.querySelector('[role="dialog"]')?.innerText.includes("Start backup")`)
        await click("Start backup")
        await waitFor(`document.body.innerText.includes("Coverage incomplete")`)
      }
      if (state === "tenants-list-intune-off") {
        await evaluate(`document.querySelector('button[aria-label="List view"]').click()`)
        await waitFor(`document.querySelector('[data-tenant-row]')?.innerText.includes("Intune is off")`)
      }
      // Keep width at 1024 and fit the real scroll surface vertically, so long states are reviewable in one image.
      const height = await evaluate(`Math.min(4200, Math.max(1100, ...[...document.querySelectorAll('main, #services, [role="dialog"]')].map(e => e.scrollHeight + 220)))`)
      if (state !== "intune-confirmation" && state !== "backup-list-intune-off" && state !== "schedule-intune-off" && state !== "backup-incomplete") await send("Emulation.setDeviceMetricsOverride", { width: 1024, height, deviceScaleFactor: 1, mobile: false })
      await evaluate(`[document.scrollingElement, ...document.querySelectorAll('*')].filter(e => e && e.scrollHeight > e.clientHeight + 4 && getComputedStyle(e).overflowY !== "visible").forEach(e => e.scrollTop = 0)`)
      await shot(state, theme)
    }
  }
  const inventory = "# Services and permissions screenshots\n\nFictional health reports, built desktop app, 1024px width, both themes. Generated with `node scripts/services-shots.mjs`. Storage has its own copy for all 18 supported states.\n\n" + scenes.map(state => `* ${state}-light.png, ${state}-dark.png: ${state === "entra-backup-types" ? "Entra ID enabled with configuration backup types available" : state.replaceAll("-", " ")}.\n`).join("")
  for (const folder of [shotsDir, docsDir]) writeFileSync(join(folder, "README.md"), inventory)
  rmSync(join(shotsDir, "failure.png"), { force: true })
  console.log(`${selectedScenes.length * 2} fixture screenshots saved to ${shotsDir} and ${docsDir}`)
} catch (error) {
  exitCode = 1
  console.error(`FAILED: ${error.stack}`)
  if (page) {
    const { data } = await page.send("Page.captureScreenshot", { format: "png" }).catch(() => ({}))
    if (data) writeFileSync(join(shotsDir, "failure.png"), Buffer.from(data, "base64"))
  }
} finally {
  page?.ws.close()
  main?.ws.close()
  const exited = new Promise(resolveExit => app.once("exit", resolveExit))
  app.kill()
  await Promise.race([exited, sleep(5000)])
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  process.exit(exitCode)
}
