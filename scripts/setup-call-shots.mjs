/**
 * Capture every screen that offers the free setup call from the built app (run `npm run build`
 * first), with fictional data and swapped IPC handlers, in light and dark, at the size the window
 * opens with and at its minimum size.
 *
 *   node scripts/setup-call-shots.mjs [screenshot-dir]
 *
 * It also prints what the welcome screen and the Connect step measure at each size. It fails when
 * the welcome screen cuts off its primary button, the setup call or the answers to the setup
 * diagnostics question, when the welcome screen scrolls (at the size the window opens with while
 * it asks about setup diagnostics, at any size once that is answered), or when the Connect step
 * scrolls at the size the window opens with.
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const require = createRequire(import.meta.url)
const electronPath = require("electron")
const desktopDir = resolve(import.meta.dirname, "..")
const shotsDir = resolve(process.argv[2] ?? join(desktopDir, "out", "setup-call-shots"))

const NOW = Date.now()
const TENANT_ID = "8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14"
const CLIENT_ID = "5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3"
const ACCOUNT = { tenantId: TENANT_ID, clientId: CLIENT_ID, username: "admin@contoso.onmicrosoft.com", name: "Contoso" }
// A setup error that offers no other action, and the sign-in refusals with and without actions.
const SETUP_ERROR = "Microsoft Graph refused to create the app registration: Insufficient privileges to complete the operation. Sign in as a Global Administrator, Cloud Application Administrator or Application Administrator."
const BLOCKED = "Conditional Access blocked this sign-in. Check the sign-in logs in the Entra admin center for the policy, or sign in from a device and location it allows. (AADSTS53003)"
const NOT_FOUND = "Microsoft could not find this application in the tenant. Check the client ID, or wait a minute if the app registration was created just now. (AADSTS700016)"
const REFUSED = "This license covers 2 tenants and both are in use. Remove a tenant or upgrade the license to add another."
const BACKUP_ERROR = "The backup could not start: Microsoft Graph did not answer. Check your network connection and try again."

const port = 9300 + Math.floor(Math.random() * 400)
const inspectPort = port + 400
const profile = mkdtempSync(join(tmpdir(), "tenuvault-setup-call-"))
mkdirSync(shotsDir, { recursive: true })

const args = [desktopDir, `--remote-debugging-port=${port}`, `--inspect=${inspectPort}`, `--user-data-dir=${profile}`]
if (process.platform === "linux") args.push("--no-sandbox", "--ozone-platform=x11")
if (process.platform === "darwin") args.push("--use-mock-keychain")
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
  // 1. Main process: wait for the window. The welcome screen uses the real state of this fresh profile.
  main = await connect(await target(`http://127.0.0.1:${inspectPort}/json/list`, (t) => t.type === "node"))
  const windowsReady = `(() => { try { const r = process.getBuiltinModule("module").createRequire(process.cwd() + "/x.cjs"); return r("electron").BrowserWindow.getAllWindows().length } catch { return 0 } })()`
  for (let i = 0; i < 60 && !(await main.evaluate(windowsReady)); i++) await sleep(500)
  await sleep(1000) // bootstrap registers the IPC handlers before it creates the window
  // The page area of the window as it opens and at its minimum size (createWindow in src/main/index.ts),
  // without the title bar and frame of this platform.
  const bounds = await main.evaluate(`(() => {
    const req = process.getBuiltinModule("module").createRequire(process.cwd() + "/x.cjs")
    const win = req("electron").BrowserWindow.getAllWindows()[0]
    const [width, height] = win.getSize()
    const [contentWidth, contentHeight] = win.getContentSize()
    const [minWidth, minHeight] = win.getMinimumSize()
    return { width, height, minWidth, minHeight, frameWidth: width - contentWidth, frameHeight: height - contentHeight }
  })()`)
  console.log(`window ${JSON.stringify(bounds)}`)
  const SIZES = [
    { name: "default", width: 1440 - bounds.frameWidth, height: 920 - bounds.frameHeight },
    { name: "minimum", width: bounds.minWidth - bounds.frameWidth, height: bounds.minHeight - bounds.frameHeight },
  ]

  // 2. Renderer: drive the built app over the Chrome DevTools Protocol.
  page = await connect(await target(`http://127.0.0.1:${port}/json/list`, (t) => t.type === "page"))
  page.ws.addEventListener("message", event => {
    const message = JSON.parse(event.data)
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") console.error(message.params.args.map(arg => arg.description ?? arg.value).join(" "))
  })
  const { send, evaluate } = page
  await send("Page.enable")
  await send("Runtime.enable")
  // The recovery panel waits 3 minutes; the screenshots do not. Only that one delay is shortened.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const original = window.setTimeout; window.setTimeout = (fn, ms, ...rest) => original(fn, ms === 180000 ? 300 : ms, ...rest) })()` })

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
  const shots = []
  const screenshot = async (name) => {
    await evaluate(`document.activeElement?.blur?.()`)
    await sleep(400)
    const { data } = await send("Page.captureScreenshot", { format: "png" })
    const file = join(shotsDir, `${name}.png`)
    writeFileSync(file, Buffer.from(data, "base64"))
    shots.push(name)
    console.log(`shot ${file}`)
  }
  const click = (label) => evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
  const center = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`)
  /** The setup call link of one screen must be there before its screenshot is taken. */
  const assertLink = async (source) => {
    if (!(await waitFor(`Boolean(document.querySelector('[data-setup-call="${source}"]'))`))) throw new Error(`The setup call link "${source}" is missing on ${await evaluate("location.hash")}`)
  }

  await waitFor(`typeof window.tenuvault?.storage?.setItem === "function"`, 30000)
  const licenseStatus = await evaluate(`window.tenuvault.license.status()`)

  // Fresh installs are asked about setup diagnostics on the welcome screen, which makes it its tallest.
  // Its helper text is longer while tenant trials are off, which is also how every start begins,
  // until the licensing service has answered.
  const handlers = ({ signIn = "waiting", createRegistration = "waiting", checkNewTenant = `() => (${JSON.stringify(licenseStatus)})`, diagnostics = "granted", trials = Boolean(licenseStatus.tenantTrialsEnabled) } = {}) => main.evaluate(`(() => {
    const req = process.getBuiltinModule("module").createRequire(process.cwd() + "/x.cjs")
    const { ipcMain, BrowserWindow } = req("electron")
    const handle = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, (_event, ...args) => fn(...args)) }
    // The license status of each screenshot is the one set here, so a later push of the real one is dropped.
    if (!globalThis.__setupCallShotsQuiet) {
      globalThis.__setupCallShotsQuiet = true
      for (const win of BrowserWindow.getAllWindows()) {
        const send = win.webContents.send.bind(win.webContents)
        win.webContents.send = (channel, ...args) => channel === "license:changed" ? undefined : send(channel, ...args)
      }
    }
    handle("license:status", () => ({ ...${JSON.stringify(licenseStatus)}, tenantTrialsEnabled: ${JSON.stringify(trials)} }))
    // A sign-in that waits for the browser. Its answer is kept, because Electron ends a call
    // whose unanswered promise was collected with "reply was never sent".
    const kept = globalThis.__setupCallShots ??= []
    const waiting = () => new Promise((resolve) => { kept.push(resolve) })
    handle("auth:signIn", ${signIn})
    handle("auth:cancelSignIn", () => undefined)
    handle("auth:copySignInLink", () => true)
    handle("auth:accounts", () => [${JSON.stringify(ACCOUNT)}])
    handle("setup:checkPermissions", () => ({ missing: [] }))
    handle("setup:saveServices", () => undefined)
    handle("setup:createRegistration", ${createRegistration})
    handle("setup:cancelCreateRegistration", () => undefined)
    handle("setup:clipboardIds", () => null)
    handle("diagnostics:status", () => ({ state: ${JSON.stringify(diagnostics)}, policy: false, reminder: { setup: false, signin: false } }))
    handle("license:checkNewTenant", ${checkNewTenant})
    handle("api", request => ({ status: 500, statusText: "Internal Server Error", headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(request.path === "/api/backup/start" ? { error: ${JSON.stringify(BACKUP_ERROR)} } : {})) }))
  })()`)
  /** Opens the guided setup on a step, with no tenant connected. Step 2 resumes a fictional sign-in. */
  const openStep = async (step, theme) => {
    await evaluate(`Promise.all([
      window.tenuvault.storage.setItem("tenuvault_tenants", "[]"),
      window.tenuvault.storage.setItem("tenuvault.onboarding.draft", ${JSON.stringify(JSON.stringify({ step, tenant: "contoso.onmicrosoft.com", clientId: CLIENT_ID, displayName: "Contoso", account: step === 2 ? ACCOUNT : null, signedInAt: NOW }))}),
    ])`)
    await setTheme(theme)
    await evaluate(`location.hash = "#/portal/onboarding"; location.reload()`)
    await sleep(1500)
    await disableAnimations()
  }

  for (const size of SIZES) {
    await send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false })
    for (const theme of ["light", "dark"]) {
      const name = (screen) => `${screen}-${theme}-${size.name}`

      // 1. The welcome screen with both helper texts, with the setup diagnostics question of a fresh install and without it.
      for (const [screen, trials, diagnostics] of [
        ["welcome", true, "unasked"],
        ["welcome-answered", true, "declined"],
        ["welcome-long-text", false, "unasked"],
        ["welcome-long-text-answered", false, "declined"],
      ]) {
        await handlers({ diagnostics, trials })
        await evaluate(`Promise.all([window.tenuvault.storage.setItem("tenuvault_tenants", "[]"), window.tenuvault.storage.removeItem("tenuvault.onboarding.draft")])`)
        await setTheme(theme)
        await evaluate(`localStorage.setItem("tenuvault.splash.seen", "1"); location.hash = "#/"; location.reload()`)
        await sleep(1500)
        await assertText("Welcome to TenuVault", 30000)
        await disableAnimations()
        await assertLink("welcome")
        await assertText(trials ? "New tenants start with a Pro trial, no card and no email needed." : "It is free on Community for one tenant")
        if (diagnostics === "unasked") await assertText("Help us make setup work in your environment")
        await evaluate(`window.scrollTo(0, 0)`)
        const welcome = await evaluate(`(() => {
          const rect = (element) => { const r = element.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) } }
          const button = (label) => [...document.querySelectorAll("button")].find(b => b.textContent.trim().startsWith(label))
          const primary = button("Connect your tenant")
          // The card without the centering of the screen around it, plus the margin the screen keeps.
          const card = primary.closest(".bg-card")
          const frame = getComputedStyle(card.parentElement)
          const content = Math.round(card.getBoundingClientRect().height + parseFloat(frame.paddingTop) + parseFloat(frame.paddingBottom))
          const visible = { primary: rect(primary), setupCall: rect(document.querySelector('[data-setup-call="welcome"]')) }
          if (button("Share setup diagnostics")) Object.assign(visible, { share: rect(button("Share setup diagnostics")), decline: rect(button("Don't share")) })
          return { viewport: innerHeight, content, page: document.scrollingElement.scrollHeight, visible }
        })()`)
        console.log(`${screen} ${size.width}x${size.height} ${theme}: ${JSON.stringify(welcome)}`)
        // Without scrolling, every window shows the primary button, the setup call and the answers to the diagnostics question.
        for (const [part, { top, bottom }] of Object.entries(welcome.visible)) {
          if (top < 0 || bottom > welcome.viewport) throw new Error(`The welcome screen cuts off ${part} at ${size.width}x${size.height}: ${JSON.stringify(welcome)}`)
        }
        // With the diagnostics question the screen fits the window as it opens; without it, the smallest window too.
        const fits = diagnostics === "unasked" ? size.name === "default" : true
        if (fits && welcome.content > welcome.viewport) throw new Error(`The welcome screen scrolls at ${size.width}x${size.height}: ${JSON.stringify(welcome)}`)
        await screenshot(name(screen))
      }

      // 2. The Connect step with the first-run header.
      await handlers()
      await openStep(0, theme)
      await assertText("Set up with Microsoft sign-in", 30000)
      await assertLink("setup-header")
      const connect = await evaluate(`({ viewport: innerHeight, page: document.scrollingElement.scrollHeight, header: [...document.querySelectorAll('nav[aria-label="Help"] > *')].map(item => item.textContent.trim()) })`)
      console.log(`connect ${size.width}x${size.height} ${theme}: ${JSON.stringify(connect)}`)
      if (size.name === "default" && connect.page > connect.viewport) throw new Error(`The Connect step scrolls at ${size.width}x${size.height}`)
      await screenshot(name("connect-header"))

      // 7. The Support dialog, opened from that header.
      await click("Support")
      await assertLink("support")
      await screenshot(name("support-dialog"))

      // 3. The waiting panel, on the setup sign-in and on the first sign-in.
      await openStep(0, theme)
      await assertText("Set up with Microsoft sign-in", 30000)
      await click("Set up with Microsoft sign-in")
      await assertText("Still waiting for Microsoft?")
      await assertLink("signin-waiting")
      await center("[data-sign-in-recovery]")
      await screenshot(name("waiting-setup"))
      await openStep(1, theme)
      await assertText("Sign in with Microsoft", 30000)
      await click("Sign in with Microsoft")
      await assertText("Still waiting for Microsoft?")
      await assertLink("signin-waiting")
      await center("[data-sign-in-recovery]")
      await screenshot(name("waiting-signin"))

      // 4. A setup error that offers no other action.
      await handlers({ createRegistration: `() => { throw new Error(${JSON.stringify(SETUP_ERROR)}) }` })
      await openStep(0, theme)
      await assertText("Set up with Microsoft sign-in", 30000)
      await click("Set up with Microsoft sign-in")
      await assertLink("setup-error")
      await center('[role="alert"]')
      await screenshot(name("setup-error"))

      // 5. First sign-in errors: one with its own actions and one that had none before.
      for (const [screen, message] of [["signin-error-actions", BLOCKED], ["signin-error-plain", NOT_FOUND]]) {
        await handlers({ signIn: `() => { throw new Error(${JSON.stringify(message)}) }` })
        await openStep(1, theme)
        await assertText("Sign in with Microsoft", 30000)
        await click("Sign in with Microsoft")
        await assertLink("signin-error")
        await center('[role="alert"]')
        await screenshot(name(screen))
      }

      // 5. The Sign in step again, after the license check refused the tenant on Continue.
      await handlers({ checkNewTenant: `() => { throw new Error(${JSON.stringify(REFUSED)}) }` })
      await openStep(2, theme)
      await assertText("Choose where backups are stored", 30000)
      await waitFor(`[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Continue" && !b.disabled)`)
      await click("Continue")
      await assertText("Sign in to your tenant")
      await assertLink("signin-error")
      await center('[role="alert"]')
      await screenshot(name("signin-refused"))

      // 6. A first backup that could not start.
      await handlers()
      await openStep(2, theme)
      await assertText("Choose where backups are stored", 30000)
      await waitFor(`[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Continue" && !b.disabled)`)
      await click("Continue")
      await assertText("Take a first backup")
      await disableAnimations()
      await click("Run first backup")
      await assertLink("first-backup-error")
      await center('[data-setup-call="first-backup-error"]')
      await screenshot(name("first-backup-error"))
    }
  }
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
