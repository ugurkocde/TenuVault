/**
 * End-to-end test of the first browser sign-in in the built or packaged app.
 *
 *   npm ci --prefix scripts/sign-in-e2e        # the harness has its own package and lockfile
 *   node scripts/sign-in-e2e/run.mjs [output-dir]
 *   node scripts/sign-in-e2e/runner.mjs cleanup # in a step that always runs
 *
 * Set TENUVAULT_SMOKE_APP to a packaged executable to test an installer build, as for the smoke
 * test; without it, the development build in out/ of the current directory is started. This
 * changes the whole machine for its duration (hosts file and trust store, see runner.mjs), so it
 * runs only where CI=true, on a throwaway runner.
 *
 * For every browser engine, with a fresh profile: the app is started, the tenant and client ID
 * are typed into the first sign-in and the sign-in is started. The app opens the system browser
 * as always; the harness takes the same Microsoft sign-in address with Copy sign-in link (the
 * bridge call behind the button) and follows it in the engine. The local stand-in for
 * login.microsoftonline.com answers, the browser posts the answer to the app's listener on
 * 127.0.0.1, the app redeems the code through MSAL and must show the next setup step with the
 * signed-in account. Then: the listener is closed. One more run checks that an answer with
 * another state is refused and leaves the sign-in waiting, and that a refusal from Microsoft
 * shows the app's error.
 *
 * The licensing requests after the sign-in are answered by the stand-in too, so nothing reaches
 * the production licensing service.
 *
 * Screenshots, app logs, results.txt and the stand-in log are written to output-dir, after every
 * engine, so a step that times out still leaves them.
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { chromium, firefox, webkit } from "playwright"
import { LOGIN_HOST, startStandIn } from "./stand-in.mjs"
import { cleanup, install, makeCertificates } from "./runner.mjs"

// The app checkout is the current directory: the release workflow runs a harness from another
// checkout against the release target's build.
const desktopDir = process.cwd()
const require = createRequire(join(desktopDir, "package.json"))
const outDir = resolve(process.argv[2] ?? join(desktopDir, "out", "sign-in-e2e"))
const packagedApp = process.env.TENUVAULT_SMOKE_APP
mkdirSync(outDir, { recursive: true })

if (process.env.CI !== "true") {
  console.error("This test changes the hosts file and the trust store of this machine. It runs only in CI (CI=true).")
  process.exit(2)
}

const TENANT_ID = "4c1e5b0a-7d3f-4e2a-9b61-0f8d2c7a9e15"
const CLIENT_ID = "9a2f6c41-3b8e-4d07-a5c2-6e1f0b9d8c73"
const ACCOUNT = { username: "admin@signin-e2e.example", name: "Sign-in Test Admin" }

/** Every engine Playwright runs on this OS, and Microsoft Edge on Windows. */
const ENGINES = [
  { name: "chromium", type: chromium },
  { name: "firefox", type: firefox },
  { name: "webkit", type: webkit },
  ...(process.platform === "win32" ? [{ name: "msedge", type: chromium, channel: "msedge" }] : []),
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const results = []

let standIn

/** Writes what is known so far, so a step that times out still leaves its diagnostics. */
function flush() {
  writeFileSync(join(outDir, "stand-in.log"), `${(standIn?.log ?? []).join("\n")}\n`)
  writeFileSync(join(outDir, "results.txt"), `${results.join("\n")}\n`)
}

/** The app did not start: every later check would fail the same way, slowly. */
class LaunchError extends Error {}

async function check(name, fn) {
  const started = Date.now()
  try {
    await fn()
    results.push(`ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    console.log(results.at(-1))
  } catch (error) {
    failures++
    results.push(`FAIL ${name}: ${error.message}`)
    console.log(results.at(-1))
    if (error instanceof LaunchError) throw error
  } finally {
    flush()
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Starts the app with a throwaway profile and connects to its window over CDP. */
async function launchApp(label) {
  const port = 9800 + Math.floor(Math.random() * 1000)
  const profile = mkdtempSync(join(tmpdir(), "tenuvault-sign-in-e2e-"))
  const args = [...(packagedApp ? [] : [desktopDir]), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`]
  if (process.platform === "linux") args.push("--no-sandbox")
  if (process.platform === "linux" && process.env.DISPLAY) args.push("--ozone-platform=x11")
  // The app keeps its secrets in the operating system's credential store: on macOS the
  // disposable keychain runner.mjs makes the default, on Linux the keyring the workflow starts.
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(packagedApp ?? require("electron"), args, { stdio: ["ignore", "pipe", "pipe"], env })
  let log = ""
  child.stdout.on("data", (d) => (log += d))
  child.stderr.on("data", (d) => (log += d))
  let browser
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined)
    if (!browser) await sleep(500)
  }
  if (!browser) {
    child.kill()
    writeFileSync(join(outDir, `app-${label}.log`), log)
    throw new LaunchError(`the app did not open its debugging port. App log:\n${log.slice(-3000)}`)
  }
  let page
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((context) => context.pages()).find((p) => !p.url().startsWith("devtools:"))
    if (!page) await sleep(250)
  }
  if (!page) {
    child.kill()
    writeFileSync(join(outDir, `app-${label}.log`), log)
    throw new LaunchError("the app opened no window")
  }
  return {
    page,
    log: () => log,
    async close() {
      writeFileSync(join(outDir, `app-${label}.log`), log)
      await browser.close().catch(() => undefined)
      const exited = new Promise((r) => child.once("exit", r))
      child.kill()
      await Promise.race([exited, sleep(5000)])
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* Windows may hold it briefly */ }
    },
  }
}

/** From the welcome screen to a started first sign-in; returns the Microsoft sign-in address. */
async function startSignIn(page) {
  await page.getByRole("button", { name: "Connect your tenant" }).click({ timeout: 30_000 })
  await page.getByRole("button", { name: "I already have an app registration" }).click()
  await page.getByText("Sign in to your tenant").waitFor()
  await page.locator("#tenant").fill(TENANT_ID)
  await page.locator("#clientId").fill(CLIENT_ID)
  await page.getByRole("button", { name: "Sign in with Microsoft" }).click()
  await page.getByText("Waiting for sign-in...").waitFor()
  // What Copy sign-in link does: the main process puts the address on the clipboard.
  let copied = false
  for (let i = 0; i < 40 && !copied; i++) {
    copied = await page.evaluate(() => window.tenuvault.auth.copySignInLink("signin"))
    if (!copied) await sleep(250)
  }
  assert(copied, "Copy sign-in link had no address to copy")
  await page.bringToFront()
  const url = await page.evaluate(() => navigator.clipboard.readText())
  const parsed = new URL(url)
  assert(parsed.origin === `https://${LOGIN_HOST}` && parsed.pathname === `/${TENANT_ID}/oauth2/v2.0/authorize`, `unexpected sign-in address ${parsed.origin}${parsed.pathname}`)
  return parsed
}

/** Whether something still accepts connections on 127.0.0.1:`port`. */
function listening(port) {
  return new Promise((resolveListening) => {
    const socket = connect({ host: "127.0.0.1", port })
    socket.once("connect", () => { socket.destroy(); resolveListening(true) })
    socket.once("error", () => resolveListening(false))
  })
}

const redirectPort = (url) => Number(new URL(url.searchParams.get("redirect_uri")).port)

async function openBrowser(engine, standIn) {
  const browser = await engine.type.launch(engine.channel ? { channel: engine.channel } : {})
  // The stand-in's root is in the operating system's trust store for the app. Every browser
  // context here skips its own certificate check (Firefox and WebKit keep trust stores of their
  // own); the app's certificate checks stay real and are the ones under test.
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies([standIn.cookie])
  return { browser, context, page: await context.newPage() }
}

async function signInWith(engine, standIn) {
  const app = await launchApp(engine.name)
  let browser
  try {
    await app.page.getByText("Welcome to TenuVault").waitFor({ timeout: 30_000 })
    const url = await startSignIn(app.page)
    const port = redirectPort(url)
    assert(await listening(port), "the app's listener is not open while the sign-in waits")
    standIn.setMode("code")
    const opened = await openBrowser(engine, standIn)
    browser = opened.browser
    await opened.page.goto(url.href)
    // The stand-in's form posts to http://localhost:<port>; the app answers with its own page.
    await opened.page.waitForURL(`http://localhost:${port}/`, { timeout: 20_000 })
    await opened.page.getByText("Go back to TenuVault").waitFor({ timeout: 10_000 })
    await opened.page.screenshot({ path: join(outDir, `${engine.name}-browser.png`) })
    await app.page.getByText("Choose where backups are stored").waitFor({ timeout: 30_000 })
    await app.page.getByText(`Signed in as ${ACCOUNT.username}`).waitFor()
    assert(standIn.log.some((line) => line.includes("licensing: tenant route")), "the license check after the sign-in did not reach the local stand-in")
    await app.page.screenshot({ path: join(outDir, `${engine.name}-app.png`) })
    // The listener takes one answer and closes.
    let closed = false
    for (let i = 0; i < 20 && !closed; i++) {
      closed = !(await listening(port))
      if (!closed) await sleep(250)
    }
    assert(closed, "the app's listener is still open after the sign-in")
  } catch (error) {
    if (error instanceof LaunchError) throw error
    await app.page.screenshot({ path: join(outDir, `fail-${engine.name}-app.png`) }).catch(() => undefined)
    throw new Error(`${error.message}\nApp log:\n${app.log().slice(-3000)}`)
  } finally {
    await browser?.close().catch(() => undefined)
    await app.close()
  }
}

async function refusals(standIn) {
  const app = await launchApp("refusals")
  let browser
  try {
    await app.page.getByText("Welcome to TenuVault").waitFor({ timeout: 30_000 })
    const url = await startSignIn(app.page)
    const port = redirectPort(url)
    const opened = await openBrowser({ type: chromium }, standIn)
    browser = opened.browser

    // An answer with a state that is not this attempt's is refused and leaves the sign-in waiting.
    standIn.setMode("wrong-state")
    const refused = new Promise((resolveRefused) => opened.page.on("response", (response) => {
      if (response.url().startsWith(`http://localhost:${port}`)) resolveRefused(response.status())
    }))
    await opened.page.goto(url.href)
    assert(await Promise.race([refused, sleep(15_000).then(() => "none")]) === 400, "the listener did not refuse an answer with another state")
    await sleep(1000)
    assert(await app.page.getByText("Waiting for sign-in...").isVisible(), "the sign-in stopped waiting after an answer with another state")
    assert(!(await app.page.getByText("Signed in as").isVisible()), "an answer with another state signed in")
    assert(await listening(port), "the listener closed after an answer with another state")

    // Microsoft's refusal, with the right state, ends the attempt with the app's own explanation.
    standIn.setMode("deny")
    await opened.page.goto(url.href)
    await opened.page.getByText("Sign-in failed").waitFor({ timeout: 20_000 })
    await app.page.getByRole("alert").filter({ hasText: "The consent was declined in the browser." }).waitFor({ timeout: 20_000 })
    await app.page.screenshot({ path: join(outDir, "refusals-app.png") })
    assert(!(await listening(port)), "the listener is still open after the refusal")
  } catch (error) {
    if (error instanceof LaunchError) throw error
    await app.page.screenshot({ path: join(outDir, "fail-refusals-app.png") }).catch(() => undefined)
    throw new Error(`${error.message}\nApp log:\n${app.log().slice(-3000)}`)
  } finally {
    standIn.setMode("code")
    await browser?.close().catch(() => undefined)
    await app.close()
  }
}

// Undo whatever an earlier, interrupted run left, then the changes of this run.
function undo() {
  const { problems, left } = cleanup()
  for (const problem of problems) console.warn(`Could not undo a change: ${problem}`)
  if (left.length) {
    failures++
    results.push(`FAIL cleanup: still on this machine: ${left.join("; ")}`)
    console.log(results.at(-1))
  }
}
// A cancelled or timed out step stops this process with a signal; the workflow's cleanup step
// runs after it in any case.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    results.push(`FAIL stopped by ${signal}`)
    flush()
    undo()
    process.exit(130)
  })
}

undo()
try {
  const certificates = makeCertificates()
  install(certificates.ca)
  standIn = await startStandIn({ key: certificates.key, cert: certificates.cert, tenantId: TENANT_ID, clientId: CLIENT_ID, account: ACCOUNT })
  for (const engine of ENGINES) await check(`first sign-in completes in ${engine.name}`, () => signInWith(engine, standIn))
  await check("a wrong state is refused and a refusal shows the app's error", () => refusals(standIn))
} catch (error) {
  failures++
  results.push(error instanceof LaunchError ? "FAIL the app did not start; the remaining checks were skipped" : `FAIL setup: ${String(error.stderr || error.message).trim()}`)
  console.log(results.at(-1))
} finally {
  flush()
  await standIn?.close()
  undo()
  flush()
}

if (failures > 0) {
  console.log(`\n${failures} sign-in check(s) failed. Screenshots and the stand-in log: ${outDir}`)
  process.exit(1)
}
console.log(`\nAll sign-in checks passed. Screenshots and the stand-in log: ${outDir}`)
process.exit(0)
