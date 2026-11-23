/** Capture onboarding from the built app with fictional data and swapped IPC handlers. */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const require = createRequire(import.meta.url)
const electronPath = require("electron")
const desktopDir = resolve(import.meta.dirname, "..")
const shotsDir = resolve(process.argv[2] ?? "/Users/ugurkoc/Desktop/GitHub/TenuVault/tasks/0.6-research/shots/3a")
const docsDir = join(desktopDir, "docs-site/public/images/onboarding")
mkdirSync(docsDir, { recursive: true })
const { buildSync } = require("esbuild")
const bundle = buildSync({ entryPoints: [join(desktopDir, "test/fixtures/services-health.ts")], bundle: true, platform: "node", format: "esm", write: false })
const { healthScene } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"))

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

const scenes = [
  ["01-welcome-start", "Welcome, with the setup diagnostics choice."],
  ["02-choice-default", "Intune preselected, with all three service cards visible."],
  ["03-choice-entra-details", "Entra ID selected with area coverage, read and write counts, Conditional Access and opt-in areas."],
  ["03-choice-governance", "Governance configuration and licensing limits, with Continue visible."],
  ["03-choice-external-roles", "Entra ID external identities and roles coverage, with the app-only API connector note."],
  ["03-choice-exact-permissions", "Exact permissions below the cards, grouped by area and marked read or write."],
  ["04-choice-defender-details", "Defender area coverage, permission counts and coverage limits."],
  ["04-choice-both-details", "Entra ID and Defender cards both expanded, with area coverage and permission counts."],
  ["05-choice-personal-data", "Groups opted in with the statement of personal data stored."],
  ["06-choice-customize", "Customize access, Intune restore and Entra backup only."],
  ["07-choice-intune-entra", "Continue with Entra ID and Intune."],
  ["08-choice-entra-only", "Continue with Entra ID, with Intune off."],
  ["09-connect-quick", "Entra-only quick setup before Microsoft, explaining broader setup-only access and the second sign-in."],
  ["09-connect-script", "Entra-only setup script with the generated command."],
  ["09-connect-manual", "Entra-only manual setup and its chosen permission list."],
  ["09-connect-handoff", "Entra-only instructions for an administrator, including command and permissions."],
  ["09-connect-existing", "Existing registration, ready for tenant and client IDs."],
  ["10-permissions-checking", "Permission check in progress, with storage and Continue held until the result or timeout."],
  ["10-permissions-unavailable", "Permission check timed out after 20 seconds, with an advisory notice and storage available."],
  ["10-permissions-missing", "After sign-in, chosen permissions missing, with the existing remediation routes and a way to continue."],
  ["10-storage-local", "Storage choice after sign-in."],
  ["11-backup-intune", "First backup for the default Intune choice, with Run first backup available."],
  ["11-backup-first", "First backup for Entra-only, with configuration backup available and Run first backup enabled."],
  ["12-hub-intune-required", "Governance with Intune off, keeping all tabs and Accepted deviations and Customizations reachable."],
  ["12-intune-required", "OpenIntuneBaseline on a tenant without Intune, linked to service settings."],
  ["13-tenant-unavailable", "A notification link for an unavailable tenant, with a link to Tenants and no workflow mounted."],
]
let exitCode = 0
let main = null
let page = null
try {
  main = await connect(await target(`http://127.0.0.1:${inspectPort}/json/list`, t => t.type === "node"))
  await sleep(1500)
  await main.evaluate(MAIN_OVERRIDES)
  await main.evaluate(`(() => {
    const { ipcMain } = process.getBuiltinModule("module").createRequire(process.cwd() + "/x.cjs")("electron")
    const handle = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, (_event, ...args) => fn(...args)) }
    const M = globalThis.__marketingMock
    handle("setup:checkPermissions", () => M.stall ? new Promise(resolve => { (M.pendingChecks ??= []).push(resolve) }) : ({ missing: M.missing ? ["Policy.Read.All", "Domain.Read.All"] : [] }))
    handle("setup:saveServices", () => undefined)
    handle("setup:saveScript", () => ({ saved: true, folder: "/Users/admin/Downloads", fileName: "New-TenuVaultDesktopApp.ps1" }))
    handle("setup:clipboardIds", () => null)
    handle("health:report", () => M.health)
    handle("health:check", () => M.health)
    handle("services:status", () => ({ tenantId: M.accounts[0].tenantId, modules: [{ id: "intune", enabled: false }] }))
    handle("license:checkNewTenant", () => M.license)
    handle("diagnostics:status", () => ({ state: "unasked", policy: false, reminder: { setup: false, signin: false } }))
    handle("diagnostics:record", () => undefined)
    handle("backups:inventoryProblem", () => null)
    handle("backups:failedAttempts", () => [])
    handle("backups:liveRuns", () => [])
  })()`)
  page = await connect(await target(`http://127.0.0.1:${port}/json/list`, t => t.type === "page"))
  const { send, evaluate } = page
  await send("Page.enable")
  const waitFor = async (expression, attempts = 100) => {
    for (let i = 0; i < attempts; i++) { if (await evaluate(expression).catch(() => false)) return; await sleep(100) }
    throw new Error(`Screen did not become ready: ${expression}`)
  }
  const click = async text => {
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`)
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`)
    await sleep(150)
  }
  const expand = async selector => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).forEach(e => e.open = true)`)
  await waitFor(`typeof window.tenuvault?.storage?.setItem === "function"`)
  for (const [state] of scenes) for (const theme of ["light", "dark"]) {
    if (process.env.SHOT_STATES && !process.env.SHOT_STATES.split(",").includes(state)) continue
    console.log(`capturing ${state}-${theme}`)
    const welcome = state.startsWith("01")
    const connectScene = state.startsWith("09")
    const afterSignIn = state.startsWith("10") || state.startsWith("11")
    const intuneRequired = state.startsWith("12")
    const tenantUnavailable = state === "13-tenant-unavailable"
    const services = state !== "11-backup-intune" && (connectScene || afterSignIn) ? { entra: { access: "backup" } } : { intune: { access: "restore" } }
    const draft = welcome || intuneRequired || tenantUnavailable ? null : { step: connectScene ? 0 : afterSignIn ? 2 : -1, tenant: afterSignIn ? TENANTS[0].guid : "", clientId: afterSignIn ? CLIENT_ID : "", displayName: "Contoso Ltd", account: afterSignIn ? MOCK.accounts[0] : null, signedInAt: Date.now(), services }
    const license = welcome ? { ...MOCK.license, hasKey: false, plan: null, tenants: [], tenantTrialsEnabled: true } : { ...MOCK.license, tenantTrialsEnabled: true }
    await main.evaluate(`Object.assign(globalThis.__marketingMock, { license: ${JSON.stringify(license)}, missing: ${state === "10-permissions-missing"}, stall: ${["10-permissions-checking", "10-permissions-unavailable"].includes(state)}, health: ${JSON.stringify(healthScene("intune-off"))} })`)
    await evaluate(`Promise.all([window.tenuvault.storage.setItem("tenuvault_tenants", ${JSON.stringify(JSON.stringify(intuneRequired || tenantUnavailable ? MOCK.tenants : []))}), window.tenuvault.storage.setItem("tenuvault_selected_tenant", "1"), ${draft ? `window.tenuvault.storage.setItem("tenuvault.onboarding.draft", ${JSON.stringify(JSON.stringify(draft))})` : 'window.tenuvault.storage.removeItem("tenuvault.onboarding.draft")'}])`)
    await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false })
    const route = tenantUnavailable ? "#/portal/governance/scores?tenant=removed-tenant" : state === "12-hub-intune-required" ? "#/portal/governance/scores" : intuneRequired ? "#/portal/oib" : "#/portal/onboarding"
    await evaluate(`localStorage.setItem("tenuvault-appearance", "${theme}"); location.hash = ${JSON.stringify(route)}; location.reload()`)
    await waitFor(`document.body?.innerText.includes(${JSON.stringify(welcome ? "Welcome to TenuVault" : tenantUnavailable ? "The linked tenant is not connected" : intuneRequired ? "This page needs Intune" : connectScene ? "Connect your tenant" : afterSignIn ? "Signed in as" : "What do you want to back up?")})`)
    await evaluate(`document.documentElement.classList.toggle("dark", ${theme === "dark"}); (() => { const style = document.createElement("style"); style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }"; document.head.appendChild(style) })()`)
    if (["03-choice-entra-details", "03-choice-governance", "03-choice-external-roles", "03-choice-exact-permissions", "04-choice-both-details", "05-choice-personal-data", "06-choice-customize", "07-choice-intune-entra", "08-choice-entra-only"].includes(state)) await evaluate(`document.querySelector('[aria-label="Back up Entra ID"]').click()`)
    if (["03-choice-entra-details", "03-choice-governance", "03-choice-external-roles", "04-choice-both-details", "05-choice-personal-data"].includes(state)) await expand('[data-onboarding-service="entra"] details')
    if (["04-choice-defender-details", "04-choice-both-details"].includes(state)) { await evaluate(`document.querySelector('[aria-label="Back up Defender"]').click()`); await expand('[data-onboarding-service="defender"] details') }
    if (state === "03-choice-governance") await evaluate(`(() => { const region = document.querySelector('[aria-label="Entra ID coverage"]'); const target = [...region.querySelectorAll('li')].find(e => e.textContent.startsWith("Governance")); region.scrollTop = target.offsetTop - region.offsetTop })()`)
    if (state === "03-choice-external-roles") await evaluate(`(() => { const region = document.querySelector('[aria-label="Entra ID coverage"]'); const target = [...region.querySelectorAll('li')].find(e => e.textContent.startsWith("External identities")); region.scrollTop = target.offsetTop - region.offsetTop })()`)
    if (state === "05-choice-personal-data") await evaluate(`(() => { const input = document.querySelector('[aria-label="Include Groups"]'); input.click(); const region = input.closest('[aria-label="Entra ID coverage"]'); region.scrollTop += input.closest('div').getBoundingClientRect().top - region.getBoundingClientRect().top })()`)
    if (state === "03-choice-exact-permissions") await expand("[data-exact-permissions]")
    if (state === "06-choice-customize") await expand('[data-customize-access]')
    if (state === "08-choice-entra-only") await evaluate(`document.querySelector('[aria-label="Back up Intune"]').click()`)
    if (state === "09-connect-script") { await click("Use the setup script instead"); await click("Save setup script") }
    if (state === "09-connect-manual") { await click("Create it by hand"); await expand('section details') }
    if (state === "09-connect-handoff") {
      await evaluate(`Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.__handoffText = text } } })`)
      await click("Someone else is the admin? Copy instructions")
      await waitFor(`document.body.innerText.includes("Instructions for your administrator")`)
    }
    if (state === "09-connect-existing") await click("I already have an app registration")
    if (state === "10-permissions-checking") await waitFor(`document.body.innerText.includes("Checking permissions") && ![...document.querySelectorAll('button')].some(b => b.textContent.trim() === "Continue")`)
    if (state === "10-permissions-unavailable") await waitFor(`document.body.innerText.includes("The permission check did not finish within 20 seconds.")`, 300)
    if (state === "10-storage-local") await waitFor(`document.body.innerText.includes("Choose where backups are stored")`)
    if (state === "10-permissions-missing") { await waitFor(`document.body.innerText.includes("Some chosen permissions are missing")`); await expand('[data-permission-routes]'); await expand('[data-permission-routes] details') }
    if (state.startsWith("11-backup")) await click("Continue")
    if (state === "11-backup-first") {
      await waitFor(`document.body.innerText.includes("Entra ID") && [...document.querySelectorAll('button')].some(b => b.textContent.trim() === "Run first backup" && !b.disabled)`)
      if (await evaluate(`document.body.innerText.includes("no backup types for Entra ID yet")`)) throw new Error("Entra ID backup types are missing from onboarding")
    }
    await sleep(250)
    const choiceScreen = state.includes("-choice-")
    if (choiceScreen) {
      const action = await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Continue with')); const rect = button.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, scrollTop: document.querySelector('main')?.scrollTop ?? 0 } })()`)
      if (action.top < 0 || action.bottom > 768 || action.scrollTop !== 0) throw new Error(`Continue needs scrolling at 1024 by 768 for ${state}: ${JSON.stringify(action)}`)
      console.log(`Continue visible at 1024 by 768: ${state}-${theme}, bottom ${action.bottom}`)
    }
    const height = choiceScreen && !["03-choice-exact-permissions", "06-choice-customize"].includes(state) ? 768 : await evaluate(`Math.min(5000, Math.max(1100, ...[...document.querySelectorAll('main')].map(e => e.scrollHeight + 130)))`)
    await send("Emulation.setDeviceMetricsOverride", { width: 1024, height, deviceScaleFactor: 1, mobile: false })
    await evaluate(`[document.scrollingElement, ...document.querySelectorAll('*')].filter(e => e && e.scrollHeight > e.clientHeight + 4 && getComputedStyle(e).overflowY !== "visible" && !e.hasAttribute("aria-label")).forEach(e => e.scrollTop = 0); document.activeElement?.blur?.()`)
    await sleep(150)
    const overflow = await evaluate(`document.documentElement.scrollWidth > 1024`)
    if (overflow) throw new Error(`Horizontal overflow: ${state}`)
    const { data } = await send("Page.captureScreenshot", { format: "png" })
    for (const folder of [shotsDir, docsDir]) writeFileSync(join(folder, `${state}-${theme}.png`), Buffer.from(data, "base64"))
  }
  const inventory = "# Onboarding flow screenshots\n\nBuilt desktop app at 1024px with fictional tenant and sign-in results. No Microsoft sign-in or registration writes are made. Generated by `node scripts/onboarding-shots.mjs`. Choice screens use a 1024 by 768 viewport and assert that Continue is visible without scrolling, including expanded cards. Card details scroll inside their card. The exact permissions disclosure and other tall screens include all content for review.\n\n" + scenes.map(([state, description]) => `* ${state}-light.png, ${state}-dark.png: ${description}\n`).join("")
  for (const folder of [shotsDir, docsDir]) writeFileSync(join(folder, "README.md"), inventory)
} catch (error) {
  exitCode = 1
  console.error(error.stack)
} finally {
  page?.ws.close()
  main?.ws.close()
  app.kill()
  await sleep(1500)
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  process.exit(exitCode)
}
