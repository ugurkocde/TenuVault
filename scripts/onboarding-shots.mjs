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
const baseline = process.env.SHOT_BASELINE === "1"

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
  license: { tenantTrialsEnabled: true, hasKey: true, keyState: "active", keyHint: "****TEST", persisted: true, offline: false, message: null, plan: "pro", tenantLimit: 2, communityTenantId: null, tenants: TENANTS.map(t => ({ tenantId: t.guid, signedIn: true, activated: true, entitled: true, source: "key", plan: "pro", expiresAt: new Date(NOW + DAY).toISOString() })) },
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
  let scene = "00-welcome"
  let initialDraft = null
  globalThis.fixtureScene = (value, draft) => { scene = value; initialDraft = draft }
  const storageReads = ipcMain.listeners("storage:getSync")
  ipcMain.removeAllListeners("storage:getSync")
  ipcMain.on("storage:getSync", (event, key) => {
    if (key === "tenuvault.onboarding.draft") event.returnValue = initialDraft
    else for (const listener of storageReads) listener(event, key)
  })
  const pending = () => new Promise(() => {})
  const coverage = choice => [
    ...(choice.defender ? [{ service: "defender", folders: ["DefenderCustomDetectionRules"], readable: [] }] : []),
    ...(choice.entra ? [{ service: "entra", folders: ["AuthorizationPolicy", "NamedLocations", "AccessPackages"], readable: scene === "04-missing-permissions" ? [] : ["AuthorizationPolicy", "NamedLocations"] }] : []),
    ...(choice.intune ? [{ service: "intune", folders: ["DeviceConfigurations"], readable: scene === "15-check-no-access" ? [] : ["DeviceConfigurations"] }] : []),
  ]
  const json = value => ({ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(value)) })
  handle("api", ({path}) => {
    const answers = {
      "/api/list-backups": { backups: ${JSON.stringify([backup])} },
      "/api/list-backup-contents": { content: { groups: [{ folder: "DeviceConfigurations", label: "configuration profile", area: "Devices", policies: ${JSON.stringify([policy])} }] } },
      "/api/restore-preview": { items: [{ path: ${JSON.stringify(policy.path)}, name: ${JSON.stringify(policy.displayName)} }] },
      "/api/backup/start": { jobId: "first-backup" },
      "/api/backup/status": scene === "18-backup-complete" ? {
        status: "Completed", progress: 100, progressMessage: "Backup completed successfully", isComplete: true, isSuccessful: true,
        startTime: "2026-11-15T09:58:48Z", endTime: "2026-11-15T10:00:00Z",
        results: { totalPolicies: 214, types: [{ folder: "DeviceConfigurations", label: "Device configurations", saved: 214, failed: 0, state: "saved" }], notices: [] },
      } : { status: "Running", progress: 35, progressMessage: "Saving device configurations", isComplete: false, isSuccessful: false },
      "/api/list-azure-resources": { storageAccounts: [{ name: "stcontosobackups", subscriptionId: M.accounts[0].clientId, resourceGroup: "rg-backups", location: "westeurope" }] },
      "/api/fetch-tenant-details": { organization: { id: M.accounts[0].tenantId, displayName: M.tenants[0].name } },
    }
    return json(answers[path.split("?")[0]] ?? { backups: [], data: [], entries: [], records: [], tenants: [], jobs: [], exists: true })
  })
  handle("setup:checkPermissions", (_tenantId, _clientId, choice) => scene === "14-check-wait" ? pending() : ({
    missing: choice.entra ? ["Policy.Read.All", "AuthenticationContext.Read.All"] : [],
    coverage: coverage(choice),
  }))
  handle("setup:createRegistration", pending)
  handle("auth:signIn", pending)
  handle("backups:verifyAzureStorage", () => undefined)
  handle("setup:enrollOwnApp", () => ({ result: true }))
  handle("setup:saveServices", () => undefined)
  handle("setup:clipboardIds", () => null)
  handle("settings:import", () => ({
    importId: "contoso-setup", exportedAt: null, appVersion: null, skipped: [],
    groups: [{ id: M.accounts[0].tenantId, title: M.tenants[0].name, connected: false, items: [],
      setup: { tenantId: M.accounts[0].tenantId, clientId: M.accounts[0].clientId, name: M.tenants[0].name, storage: { kind: "local" } } }],
  }))
  handle("health:check", () => ({
    tenantId: M.accounts[0].tenantId, clientId: "${restoreAppId}", granted: ["DeviceManagementConfiguration.Read.All"],
    services: [{ id: "intune", enabled: true, access: "backup", areas: [] }],
  }))
  handle("auth:connection", () => ({ tenantId: M.accounts[0].tenantId, clientId: "${restoreAppId}", graphScopes: [] }))
  handle("auth:savedDirectoryRestores", () => ({ owner: "Contoso Admin", pages: [] }))
  handle("auth:graphCliAvailable", () => true)
  handle("auth:tenuvaultAppAvailable", () => scene !== "02-connect")
  handle("auth:wizardStage", (_tenantId, _method, choice) => scene.endsWith("-wait") ? pending() : ({ result: {
    id: "contoso-sign-in",
    account: { ...M.accounts[0], clientId: "14d82eec-204b-4c2f-b7e8-296a70dab67e" },
    organizationName: M.tenants[0].name,
    coverage: coverage(choice),
    missing: ["EntitlementManagement.Read.All", "CustomDetection.Read.All"],
  } }))
  handle("auth:wizardFinish", () => ({ result: true }))
  handle("auth:wizardPackConsent", pending)
  handle("auth:wizardDiscard", () => undefined)
  handle("services:status", () => ({ tenantId: M.accounts[0].tenantId, modules: ["defender", "entra", "intune"].map(id => ({ id, enabled: true })), needsAccess: ["defender"] }))
  handle("license:checkNewTenant", () => M.license)
  handle("diagnostics:status", () => ({ state: "unasked", policy: false, reminder: { setup: false, signin: false } }))
  handle("diagnostics:record", () => undefined)
  handle("backups:inventoryProblem", () => null)
  handle("backups:failedAttempts", () => [])
  handle("backups:liveRuns", () => [])
  handle("auth:accounts", () => M.accounts)
  handle("license:status", () => scene === "00-welcome" ? { ...M.license, tenantTrialsEnabled: false, hasKey: false, keyState: "none", plan: null, tenants: [] } : M.license)
  handle("schedules:list", () => scene === "18-backup-complete" ? [] : M.schedules)
  handle("schedules:refusals", () => [])
  handle("preferences:get", () => M.preferences)
  handle("backups:settings", () => ({ ...M.backupSettings, recoveryExported: scene !== "18-backup-complete" }))
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
  ["04-missing-permissions", "See which Entra ID areas need access and find out how to add it."],
  ["05-storage", "Confirm your tenant and choose where to store backups."],
  ["06-first-backup", "Follow the first backup after saving your storage choice."],
]
const extended = [
  ["00-welcome", "Welcome to TenuVault."],
  ["07-restore-access", "Intune restore access prompt."],
  ["08-start-now", "Sign in with the access already available."],
  ["09-tenuvault-app", "Sign in with the TenuVault app."],
  ["10-own-registration", "Create an app registration."],
  ["11-start-now-wait", "Wait for Start now sign-in in the browser."],
  ["12-tenuvault-app-wait", "Wait for the TenuVault app sign-in in the browser."],
  ["13-own-registration-wait", "Wait for the registration setup sign-in."],
  ["14-check-wait", "Check backup access."],
  ["15-check-no-access", "No chosen services can be read."],
  ["16-check-partial", "Intune and part of Entra ID are readable."],
  ["17-storage-azure", "Choose and verify your Azure storage account."],
  ["18-backup-complete", "Review the completed first backup."],
  ["19-own-signin", "Enter the IDs for an existing registration."],
  ["20-own-signin-wait", "Wait for sign-in with an existing registration."],
  ["21-own-routes", "Find other ways to set up an app registration."],
  ["22-help", "Find setup and support actions."],
  ["23-check-partial-expanded", "Review which backup areas need access."],
  ["24-start-now-storage", "Choose local storage for Start now."],
  ["25-tenuvault-app-permissions", "Review permissions and open admin consent."],
  ["26-needs-access", "Find services that need access in the sidebar."],
  ["27-methods-available", "Compare all three connection methods."],
  ["28-setup-file", "Sign in with the registration from an imported setup file."],
  ["29-different-tenant", "Enter a different tenant ID or domain."],
  ["30-own-setup-details", "Review what creating an app registration does."],
  ["31-check-permission-names", "Expand technical names for access that is missing."],
  ["32-consent-wait", "Wait for administrator approval in the browser."],
]
const captureScenes = process.env.SHOT_ALL || process.env.SHOT_STATES
  ? [...scenes, ...extended].sort(([a], [b]) => a.localeCompare(b)) : scenes
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
    throw new Error(`Screen did not become ready: ${expression}. Visible text: ${await evaluate("document.body?.innerText")}`)
  }
  const click = async (text, exact = true) => {
    const selector = `(() => {
      const label = ${JSON.stringify(text)};
      return [...document.querySelectorAll('button')].find(b => !b.disabled && (${exact} ? (b.getAttribute('aria-label') ?? b.textContent.trim()) === label : b.textContent.trim().includes(label)));
    })()`
    await waitFor(`(() => {
      const button = ${selector};
      if (!button) return false;
      button.click();
      return true;
    })()`)
    await sleep(150)
  }
  const showing = text => waitFor(`document.body?.innerText.includes(${JSON.stringify(text)})`)
  const captured = []
  await waitFor(`typeof window.tenuvault?.storage?.setItem === "function"`)
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
  for (const [state, description] of captureScenes) {
    if (process.env.SHOT_STATES && !process.env.SHOT_STATES.split(",").includes(state)) continue
    if (state === "00-welcome" && process.argv[2] === undefined && !process.env.SHOT_ALL && !process.env.SHOT_STATES) continue
    captured.push([state, description])
    for (const theme of ["light", "dark"]) {
      console.log(`Opening ${state}-${theme}`)
      const restore = state === "07-restore-access"
      const welcome = state === "00-welcome"
      const sidebar = state === "26-needs-access"
      const expanded = ["04-missing-permissions", "23-check-partial-expanded", "31-check-permission-names"].includes(state)
      const partial = ["16-check-partial", "23-check-partial-expanded", "31-check-permission-names"].includes(state)
      const resume = ["03-check", "04-missing-permissions", "05-storage", "06-first-backup", "14-check-wait", "15-check-no-access", "17-storage-azure", "18-backup-complete"].includes(state)
      const services = {
        ...(expanded || partial ? { entra: { access: "backup" }, conditionalAccess: { access: "backup" } } : {}),
        ...(partial || !resume ? { defender: { access: "backup" }, entra: { access: "backup" }, conditionalAccess: { access: "backup" } } : {}),
        intune: { access: "backup" },
      }
      const draft = { step: resume ? 4 : -1, tenant: resume ? TENANTS[0].guid : "", clientId: resume ? CLIENT_ID : "", displayName: "", signedInAt: Date.now(), account: resume ? MOCK.accounts[0] : null, services }
      await main.evaluate(`fixtureScene(${JSON.stringify(state)}, ${welcome ? "null" : JSON.stringify(JSON.stringify(draft))})`)
      const tenants = restore || sidebar ? MOCK.tenants.map(tenant => ({ ...tenant, credentials: { ...tenant.credentials, appId: restoreAppId } })) : []
      await evaluate(`Promise.all([
        window.tenuvault.storage.setItem("tenuvault_tenants", ${JSON.stringify(JSON.stringify(tenants))}),
        window.tenuvault.storage.setItem("tenuvault_selected_tenant", "1"),
      ])`)
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })
      const route = welcome ? "#/" : restore ? "#/portal/backup?tab=restore" : sidebar ? "#/portal/dashboard" : "#/portal/onboarding"
      await evaluate(`localStorage.setItem("tenuvault-appearance", "${theme}"); location.hash = ${JSON.stringify(route)}; location.reload()`)
      const disclose = async text => {
        const summary = `[...document.querySelectorAll("summary")].find(item => item.textContent.includes(${JSON.stringify(text)}))`
        await waitFor(`Boolean(${summary})`)
        await evaluate(`${summary}.click()`)
      }
      if (welcome) {
        await showing("Welcome to TenuVault")
      } else if (restore) {
        await click("1 items", false)
        await showing("Allow restore for Intune")
      } else if (sidebar) {
        await showing("Needs access")
      } else if (resume) {
        await showing(state === "14-check-wait" ? "Checking permissions" : state === "15-check-no-access" ? "TenuVault can't read any" : "You're ready to back up Intune.")
        if (expanded) await disclose("What's missing")
        if (["05-storage", "06-first-backup", "17-storage-azure", "18-backup-complete"].includes(state)) {
          await click("Continue")
          await showing("This device, encrypted")
        }
        if (state === "17-storage-azure") {
          await click(baseline ? "Use my Azure storage account instead" : "Your Azure storage account", false)
          await showing("stcontosobackups")
          await evaluate(`(() => { const input = document.querySelector('#storage-account'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(input, "stcontosobackups"); input.dispatchEvent(new Event("change", { bubbles: true })) })()`)
          await showing("Access confirmed")
        }
        if (state === "06-first-backup" || state === "18-backup-complete") {
          await click("Start first backup")
          await showing(state === "06-first-backup" ? "Cancel backup" : "Your first backup is done")
          if (state === "18-backup-complete") {
            await showing(baseline ? "Save recovery key" : "Save your recovery key")
            if (await evaluate(`location.hash !== "#/portal/onboarding" || Boolean(document.querySelector('nav[aria-label="Main navigation"]'))`)) throw new Error("Completion left the wizard")
          }
        }
      } else {
        await showing("Which services do you want to connect?")
        if (state !== "01-services" && state !== "22-help") {
          await click(baseline ? "Continue with Defender, Entra ID and Intune" : "Continue")
          await showing("How do you want to connect?")
        }
        if (state === "28-setup-file") {
          if (baseline) {
            await click("Choose Your own app registration")
            await disclose("sign in as an admin here?")
          }
          await click(baseline ? "Set up from a file" : "Another admin sent you a setup file?", false)
          await showing("From a setup file")
        } else if (state === "22-help" && !baseline) {
          await evaluate(`document.querySelector('nav[aria-label="Help"] button').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`)
          await showing("Support")
        } else if (["08-start-now", "11-start-now-wait", "16-check-partial", "23-check-partial-expanded", "24-start-now-storage", "29-different-tenant", "31-check-permission-names"].includes(state)) {
          await click("Choose Start now")
          await showing("Sign in with Microsoft")
          if (state === "29-different-tenant") await disclose(baseline ? "Setting up a different tenant?" : "Different tenant?")
          else if (!state.startsWith("08")) await click("Sign in with Microsoft")
          if (state.endsWith("-wait")) await showing("Finish signing in in your browser")
          if (partial || state === "24-start-now-storage") {
            await showing("You're ready to back up Intune and Entra ID")
            if (state === "24-start-now-storage") {
              await click("Continue with Intune and Entra ID")
              await showing("This device, encrypted")
            } else if (expanded) {
              await disclose("What's missing")
              if (state === "31-check-permission-names") await disclose("Show permission names")
            }
          }
        } else if (["09-tenuvault-app", "12-tenuvault-app-wait", "25-tenuvault-app-permissions", "32-consent-wait"].includes(state)) {
          await click("Choose TenuVault app")
          if (state === "12-tenuvault-app-wait") {
            await click("Sign in with Microsoft")
            await showing("Finish signing in in your browser")
          } else if (state !== "09-tenuvault-app") {
            await disclose(baseline ? "Permissions an admin will approve" : "See the permissions")
            await showing("Open admin consent")
            if (state === "32-consent-wait") {
              await click("Open admin consent")
              await showing(baseline ? "Finish signing in in your browser" : "Finish approving access in your browser")
            }
          }
        } else if (["10-own-registration", "13-own-registration-wait", "19-own-signin", "20-own-signin-wait", "21-own-routes", "30-own-setup-details"].includes(state)) {
          await click("Choose Your own app registration")
          if (state === "30-own-setup-details") await disclose("What the setup does")
          if (state === "13-own-registration-wait") {
            await click("Set up with Microsoft sign-in")
            await showing("Finish signing in in your browser")
          }
          if (["19-own-signin", "20-own-signin-wait", "21-own-routes"].includes(state)) {
            await disclose("sign in as an admin here?")
            if (state !== "21-own-routes") await click("I already have an app registration")
            if (state === "20-own-signin-wait") {
              await evaluate(`(() => {
                for (const [id, value] of Object.entries(${JSON.stringify({ tenant: TENANTS[0].guid, clientId: CLIENT_ID })})) {
                  const input = document.getElementById(id);
                  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
                  input.dispatchEvent(new Event("input", { bubbles: true }));
                }
              })()`)
              await click("Sign in with Microsoft")
              await showing("Finish signing in in your browser")
            }
          }
        }
      }
      await evaluate(`document.documentElement.classList.toggle("dark", ${theme === "dark"})`)
      await evaluate(`document.activeElement?.blur?.(); window.scrollTo(0, 0)`)
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 })
      await sleep(250)
      if (restore) {
        await evaluate(`[...document.querySelectorAll("button")].find(button => button.textContent.includes("Allow restore for Intune"))?.scrollIntoView({ block: "center" })`)
      }
      if (state.endsWith("-wait") && state !== "14-check-wait") {
        const prompt = state === "32-consent-wait" && !baseline ? "Finish approving access in your browser" : "Finish signing in in your browser"
        await showing(prompt)
      }
      if (state === "31-check-permission-names") {
        await evaluate(`(() => {
          const details = [...document.querySelectorAll("summary")].find(item => item.textContent === "Show permission names")?.parentElement
          if (details?.getBoundingClientRect().bottom > innerHeight - 24) {
            details.scrollIntoView({ block: "end" })
            window.scrollBy(0, 24)
          }
        })()`)
      }
      if (await evaluate(`document.documentElement.scrollWidth > ${width}`)) throw new Error(`Horizontal overflow: ${state}`)
      if (sidebar && !baseline) {
        await evaluate("document.fonts.ready.then(() => true)")
        const truncatedRows = await evaluate(`(() => {
          const rows = [...document.querySelectorAll('section[aria-label="Services"] [data-nav-row]')]
          if (!rows.length) throw new Error("No sidebar service rows found")
          return rows.filter(row => [row, ...row.querySelectorAll("span")].some(element => element.scrollWidth > element.clientWidth))
            .map(row => row.textContent.trim())
        })()`)
        if (truncatedRows.length) throw new Error(`Truncated sidebar service rows: ${truncatedRows.join(", ")}`)
      }
      const disclosures = [expanded, restore, sidebar, state === "21-own-routes", state === "25-tenuvault-app-permissions", state === "30-own-setup-details"]
      const scrollHeight = await evaluate("document.scrollingElement.scrollHeight")
      if (!baseline && !disclosures.includes(true) && scrollHeight > height + 1) {
        throw new Error(`Screen needs vertical scrolling: ${state} takes ${scrollHeight}px at ${width} by ${height}`)
      }
      const { data } = await send("Page.captureScreenshot", { format: "png" })
      writeFileSync(join(shotsDir, `${state}-${theme}.png`), Buffer.from(data, "base64"))
      console.log(`Captured ${state}-${theme} at ${width} by ${height}`)
      if (state === "18-backup-complete") {
        await click("Go to dashboard")
        await waitFor(`location.hash === "#/portal/dashboard" && Boolean(document.querySelector('nav[aria-label="Main navigation"]'))`)
      }
    }
  }
  const inventory = "# Onboarding flow screenshots\n\nBuilt desktop app using fictional Contoso data and local IPC fixtures. Generated by `node scripts/onboarding-shots.mjs`. The default viewport is 1024 by 768. The script checks for horizontal overflow in every scene.\n\n" +
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
