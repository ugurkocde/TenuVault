/** Capture the sign-in recovery screens from the built app with fictional data and swapped IPC handlers. */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const require = createRequire(import.meta.url)
const electronPath = require("electron")
const desktopDir = resolve(import.meta.dirname, "..")
const shotsDir = resolve(process.argv[2] ?? join(desktopDir, "out", "sign-in-recovery-shots"))

const NOW = Date.now()
const CLIENT_ID = "5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3"
// The texts the main process sends for these cases (FIRST_SIGN_IN_TIMEOUT_MESSAGE and the AADSTS53003 mapping).
const TIMEOUT = "The sign-in in the browser was not completed within 15 minutes. Select Try again to sign in again. If Microsoft showed an error in the browser, such as a Conditional Access block, an MFA prompt you could not complete or a request for admin approval, copy the instructions for your admin and send them the setup."
const BLOCKED = "Conditional Access blocked this sign-in. Check the sign-in logs in the Entra admin center for the policy, or sign in from a device and location it allows. (AADSTS53003)"

const port = 9300 + Math.floor(Math.random() * 400)
const inspectPort = port + 400
const profile = mkdtempSync(join(tmpdir(), "tenuvault-sign-in-recovery-"))
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
  // 1. Main process: wait for the window. The welcome screen uses the real state of this fresh profile.
  main = await connect(await target(`http://127.0.0.1:${inspectPort}/json/list`, (t) => t.type === "node"))
  const windowsReady = `(() => { try { const r = process.getBuiltinModule("module").createRequire(process.cwd() + "/x.cjs"); return r("electron").BrowserWindow.getAllWindows().length } catch { return 0 } })()`
  for (let i = 0; i < 60 && !(await main.evaluate(windowsReady)); i++) await sleep(500)
  await sleep(1000) // bootstrap registers the IPC handlers before it creates the window
  const diagnosticsStatus = (value) => main.evaluate(`(() => {
    const req = process.getBuiltinModule("module").createRequire(process.cwd() + "/x.cjs")
    const { ipcMain } = req("electron")
    for (const channel of ["diagnostics:status", "diagnostics:reminderShown", "diagnostics:consent", "diagnostics:decline"]) ipcMain.removeHandler(channel)
    const value = ${JSON.stringify(value)}
    ipcMain.handle("diagnostics:status", () => value)
    ipcMain.handle("diagnostics:reminderShown", () => undefined)
    ipcMain.handle("diagnostics:consent", () => ({ ...value, state: "granted" }))
    ipcMain.handle("diagnostics:decline", () => ({ ...value, state: "declined" }))
  })()`)

  // 2. Renderer: seed the tenant profiles in the app's own store, then reload with the demo data.
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
  await disableAnimations()
  await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 1000, deviceScaleFactor: 1, mobile: false })

  const handlers = (signIn) => main.evaluate(`(() => {
    const req = process.getBuiltinModule("module").createRequire(process.cwd() + "/x.cjs")
    const { ipcMain } = req("electron")
    for (const channel of ["auth:signIn", "auth:cancelSignIn", "auth:copySignInLink", "setup:createRegistration", "setup:cancelCreateRegistration", "setup:clipboardIds", "diagnostics:status"]) ipcMain.removeHandler(channel)
    ipcMain.handle("auth:signIn", ${signIn})
    ipcMain.handle("auth:cancelSignIn", () => undefined)
    ipcMain.handle("auth:copySignInLink", () => true)
    ipcMain.handle("setup:createRegistration", () => new Promise(() => undefined))
    ipcMain.handle("setup:cancelCreateRegistration", () => undefined)
    ipcMain.handle("setup:clipboardIds", () => null)
    ipcMain.handle("diagnostics:status", () => ({ state: "granted", policy: false, reminder: { setup: false, signin: false } }))
  })()`)
  const openStep = async (step, theme) => {
    await evaluate(`Promise.all([
      window.tenuvault.storage.setItem("tenuvault_tenants", "[]"),
      window.tenuvault.storage.setItem("tenuvault.onboarding.draft", ${JSON.stringify(JSON.stringify({ step, tenant: "contoso.onmicrosoft.com", clientId: CLIENT_ID, displayName: "Contoso", account: null, signedInAt: NOW }))}),
    ])`)
    await setTheme(theme)
    await evaluate(`location.hash = "#/portal/onboarding"; location.reload()`)
    await sleep(1500)
    await disableAnimations()
  }
  const click = (label) => evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`)

  // The recovery panel next to a first sign-in that waits for the browser, light and dark.
  await handlers(`() => new Promise(() => undefined)`)
  for (const theme of ["light", "dark"]) {
    await openStep(1, theme)
    await assertText("Sign in with Microsoft", 30000)
    await click("Sign in with Microsoft")
    await assertText("Still waiting for Microsoft?")
    await click("Copy sign-in link")
    await assertText("Copied the sign-in link.")
    await evaluate(`document.querySelector("[data-sign-in-recovery]").scrollIntoView({ block: "center" })`)
    await screenshot(`recovery-panel-${theme}`, true)
  }

  // The same panel on the setup sign-in of the Connect step.
  await openStep(0, "light")
  await assertText("Set up with Microsoft sign-in", 30000)
  await click("Set up with Microsoft sign-in")
  await assertText("Still waiting for Microsoft?")
  await evaluate(`document.querySelector("[data-sign-in-recovery]").scrollIntoView({ block: "center" })`)
  await screenshot("setup-recovery-panel-light", true)

  // The 15 minute timeout and a Conditional Access refusal, each with its actions.
  for (const [name, message] of [["timeout", TIMEOUT], ["aadsts53003", BLOCKED]]) {
    await handlers(`() => { throw new Error(${JSON.stringify(message)}) }`)
    await openStep(1, "light")
    await assertText("Sign in with Microsoft", 30000)
    await click("Sign in with Microsoft")
    await assertText("Copy instructions for your admin")
    await evaluate(`document.querySelector('[role="alert"]')?.scrollIntoView({ block: "center" })`)
    await screenshot(`${name}-light`, true)
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
