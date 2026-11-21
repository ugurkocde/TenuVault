/**
 * Drives an installed TenuVault over the Chrome DevTools Protocol with a throwaway profile, as
 * scripts/smoke.mjs drives a packaged build. Used by the nightly verification harness
 * (.github/workflows/nightly-verification.yml); nothing here changes the app or its settings.
 */
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { maskedCapture } from "./secrets.mjs"

export const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** The text an installed app logs when the OS credential store cannot encrypt (src/main/index.ts). */
export const NO_ENCRYPTION = "OS encryption is not available"

export function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Starts the installed app with `profile` as its user data folder and connects to its window.
 * Rejects with the app log when the window never appears, naming the credential store when the
 * app reported that it could not encrypt, and when it is not NIGHTLY_VERIFY_VERSION (unless
 * checkVersion is false, as for releasing an activation whatever runs).
 */
export async function launch(appPath, profile, shotsDir, { checkVersion = true } = {}) {
  mkdirSync(shotsDir, { recursive: true })
  const port = 9300 + Math.floor(Math.random() * 500)
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`]
  if (process.platform === "darwin" && process.env.NIGHTLY_VERIFY_MOCK_KEYCHAIN === "1") args.push("--use-mock-keychain")
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" }
  delete env.ELECTRON_RUN_AS_NODE
  // Secrets of the harness are not the app's business.
  for (const name of Object.keys(env)) if (/^(LICENSING_|TENUVAULT_E2E_|GH_TOKEN|GITHUB_TOKEN)/.test(name)) delete env[name]
  const child = spawn(appPath, args, { stdio: ["ignore", "pipe", "pipe"], env })
  let log = ""
  let exited = null
  child.stdout.on("data", (data) => (log += data))
  child.stderr.on("data", (data) => (log += data))
  const pending = new Map()
  child.once("exit", (code, signal) => {
    exited = { code, signal }
    // Nothing answers once the app is gone; every waiting request fails at once.
    for (const settle of pending.values()) settle({ error: { message: explain(`The app exited (${JSON.stringify(exited)}).`) } })
    pending.clear()
  })

  const explain = (what) => {
    const keychain = log.includes(NO_ENCRYPTION)
      ? "\nThe app could not use the operating system credential store. On macOS that is the login keychain, which must exist and be unlocked; on Windows it is DPAPI for the runner user."
      : ""
    return `${what}${keychain}\nApp log:\n${log.slice(-4000)}`
  }

  let url = null
  for (let attempt = 0; attempt < 90 && !url; attempt++) {
    if (exited) throw new Error(explain(`The app exited before it opened a window (${JSON.stringify(exited)}).`))
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json()
      url = targets.find((target) => target.type === "page" && !target.url.startsWith("devtools:"))?.webSocketDebuggerUrl ?? null
    } catch {
      /* not up yet */
    }
    if (!url) await sleep(500)
  }
  if (!url) {
    child.kill()
    throw new Error(explain("The app did not expose a window over the DevTools protocol."))
  }

  const ws = new WebSocket(url)
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error(explain("Connecting to the app window timed out."))), 30_000)
    ws.addEventListener("open", () => { clearTimeout(timer); resolveOpen() }, { once: true })
    ws.addEventListener("error", () => { clearTimeout(timer); rejectOpen(new Error(explain("Could not connect to the app window."))) }, { once: true })
  })
  let nextId = 1
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolveSend, rejectSend) => {
      if (exited) {
        rejectSend(new Error(explain(`The app exited (${JSON.stringify(exited)}).`)))
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectSend(new Error(explain(`${method} timed out.`)))
      }, 60_000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolveSend(message)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })

  /** Evaluates in the window. Errors carry the page's message only, never the expression. */
  const evaluate = async (expression) => {
    const { result, error } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (error) throw new Error(error.message)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.split("\n")[0] ?? "evaluation failed")
    return result.result.value
  }
  const waitFor = async (expression, timeout = 30_000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (exited) throw new Error(explain(`The app exited (${JSON.stringify(exited)}).`))
      if (await evaluate(expression).catch(() => false)) return true
      await sleep(250)
    }
    return false
  }
  const waitForText = (text, timeout) => waitFor(`document.body?.innerText.includes(${JSON.stringify(text)})`, timeout)
  /**
   * Saves a screenshot. Every text and field value that contains one of `secrets`, or its last
   * four characters (as a masked key shows them), is replaced before the capture; when that
   * fails, nothing is captured.
   */
  const screenshot = async (name, secrets = []) => {
    const fragments = [...new Set(secrets.filter(Boolean).flatMap((secret) => [secret, secret.slice(-4)]))].filter((part) => part.length >= 4)
    const mask = async () => {
      if (fragments.length === 0) return
      const masked = await evaluate(`(() => {
        const parts = ${JSON.stringify(fragments.map((part) => part.toLowerCase()))}
        const hit = (text) => parts.some((part) => String(text).toLowerCase().includes(part))
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (hit(node.nodeValue)) node.nodeValue = "[hidden]"
        for (const field of document.querySelectorAll("input, textarea")) if (hit(field.value)) field.value = "[hidden]"
        return true
      })()`)
      if (masked !== true) throw new Error("The page was not masked.")
    }
    return maskedCapture(mask, async () => {
      const { result } = await send("Page.captureScreenshot", { format: "png" })
      if (result?.data) writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(result.data, "base64"))
    })
  }
  /** Clicks the first button whose text is exactly `label`. */
  const click = async (label) => {
    const clicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === ${JSON.stringify(label)} && !b.disabled)
      if (!button) return false
      button.click()
      return true
    })()`)
    assert(clicked, `There is no "${label}" button.`)
  }
  /** Types into an input the way React sees it. The value is never logged. */
  const fill = async (selector, value) => {
    const filled = await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)})
      if (!input) return false
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new Event("input", { bubbles: true }))
      return true
    })()`)
    assert(filled, `There is no ${selector} field.`)
  }
  /**
   * Quits the app the way a normal quit does, through the DevTools protocol's Browser.close, so
   * it writes its state first. A forced kill can end it before Chromium has saved the key that
   * protects the encrypted stores (on Windows, Local State), and the next start then cannot read
   * them. Only an app that does not quit in time is killed, with its whole process tree.
   */
  const close = async () => {
    try {
      ws.close()
    } catch {
      /* already closed */
    }
    if (exited) return
    const done = new Promise((resolveExit) => child.once("exit", resolveExit))
    try {
      const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })).json()
      const browser = new WebSocket(webSocketDebuggerUrl)
      await new Promise((resolveOpen, rejectOpen) => {
        browser.addEventListener("open", resolveOpen, { once: true })
        browser.addEventListener("error", rejectOpen, { once: true })
        setTimeout(rejectOpen, 5000)
      })
      browser.send(JSON.stringify({ id: 1, method: "Browser.close" }))
    } catch {
      /* the forced kill below handles an app that does not answer */
    }
    if ((await Promise.race([done.then(() => "quit"), sleep(20_000)])) !== "quit") {
      console.warn("The app did not quit within 20 seconds and is killed.")
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
      else child.kill()
      await Promise.race([done, sleep(10_000)])
    }
    // Helper processes can hold the profile for a moment, mostly on Windows.
    await sleep(1500)
  }

  await send("Page.enable")
  await send("Runtime.enable")
  // The nightly under test, not an update it may have installed (the workflow sets the
  // DisableAutoUpdate policy, as managed deployments do).
  const expected = process.env.NIGHTLY_VERIFY_VERSION
  if (expected && checkVersion) {
    let version = null
    for (let attempt = 0; attempt < 60 && !version && !exited; attempt++) {
      version = (await evaluate("window.tenuvault?.app?.info?.()").catch(() => null))?.version ?? null
      if (!version) await sleep(500)
    }
    if (version !== expected) {
      child.kill()
      throw new Error(`The running app is version ${version ?? "unknown"}, not the nightly under test ${expected}.`)
    }
    // And the policy the workflow set is the one the app sees, so it cannot update itself.
    const managed = (await evaluate("window.tenuvault?.preferences?.get?.()").catch(() => null))?.autoUpdateManaged
    if (managed !== true) {
      child.kill()
      throw new Error(`The app does not report updates as managed by the DisableAutoUpdate policy (autoUpdateManaged is ${managed}).`)
    }
  }
  return { evaluate, waitFor, waitForText, screenshot, click, fill, close, log: () => log, send }
}

/** Runs the named checks in order, prints ok or FAIL for each and returns the failures. */
export function checker() {
  const failures = []
  const check = async (name, run) => {
    const started = Date.now()
    try {
      const detail = await run()
      console.log(`ok   ${name} (${Date.now() - started} ms)${detail ? `: ${detail}` : ""}`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${name}: ${message.split("\nApp log:")[0]}`)
      console.log(`FAIL ${name} (${Date.now() - started} ms): ${message}`)
      return false
    }
  }
  return { check, failures }
}
