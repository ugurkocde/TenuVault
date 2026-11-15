/**
 * Nightly verification, real Microsoft sign-in: the installed app signs in to the test tenant
 * the way an admin who uses another browser does.
 *
 *   NIGHTLY_VERIFY_APP=<installed executable> TENUVAULT_E2E_TENANT_ID=... TENUVAULT_E2E_CLIENT_ID=... \
 *   TENUVAULT_E2E_USERNAME=... TENUVAULT_E2E_PASSWORD=... \
 *   node scripts/nightly-verification/sign-in.mjs <browser>[,<browser>...] [screenshot-dir]
 *
 * Browsers: chromium, firefox, webkit, msedge (installed Microsoft Edge). For each one, a fresh
 * throwaway profile: the welcome screen, Connect your tenant, I already have an app
 * registration, the tenant and client IDs, Sign in with Microsoft. The app opens the system
 * browser as it always does; the harness copies the sign-in link the app offers ("Copy sign-in
 * link"), completes Microsoft's login page in the Playwright browser, answers "Stay signed in?"
 * and checks the app shows "Signed in as" the test user. The test user has no MFA and is outside
 * Conditional Access. Without the four secrets the run fails and says so.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { assert, checker, launch, sleep } from "./app.mjs"
import { hidden, hide, maskedCapture, maskPage, matchesTestAccount } from "./secrets.mjs"

const SECRETS = ["TENUVAULT_E2E_TENANT_ID", "TENUVAULT_E2E_CLIENT_ID", "TENUVAULT_E2E_USERNAME", "TENUVAULT_E2E_PASSWORD"]
const BROWSERS = ["chromium", "firefox", "webkit", "msedge"]

const appPath = process.env.NIGHTLY_VERIFY_APP
const browsers = (process.argv[2] ?? "chromium").split(",").map((name) => name.trim()).filter(Boolean)
const shotsDir = resolve(process.argv[3] ?? join(process.cwd(), "out", "nightly-sign-in"))
const { check, failures } = checker()

/** The text on the clipboard, read the way the operating system offers it. */
function clipboard() {
  if (process.platform === "darwin") return execFileSync("pbpaste", { encoding: "utf8" }).trim()
  if (process.platform === "win32") return execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8" }).trim()
  return execFileSync("xclip", ["-selection", "clipboard", "-o"], { encoding: "utf8" }).trim()
}

/** The visible error text on Microsoft's login page, if any. */
async function loginError(page) {
  for (const selector of ["#usernameError", "#passwordError", "#service_exception_message", "#idTD_Error", "div[role='alert']"]) {
    const text = await page.locator(selector).first().innerText({ timeout: 200 }).catch(() => "")
    if (text.trim()) return text.trim().slice(0, 300)
  }
  return ""
}

/** Completes Microsoft's login page until it redirects to the app's loopback address. */
async function completeLogin(page, username, password) {
  const atApp = () => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(page.url())
  await page.locator('input[name="loginfmt"]').fill(username, { timeout: 60_000 })
  await page.locator("#idSIButton9").click()
  const passwordField = page.locator('input[name="passwd"]')
  await passwordField.waitFor({ state: "visible", timeout: 30_000 }).catch(async () => {
    throw new Error(`Microsoft did not ask for the password: ${(await loginError(page)) || page.url().split("?")[0]}`)
  })
  await passwordField.fill(password)
  await page.locator("#idSIButton9").click()
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (atApp()) return
    const body = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "")
    if (/Stay signed in\?/i.test(body) && (await page.locator("#idBtn_Back").isVisible().catch(() => false))) {
      // "No": the test browser keeps nothing, and the answer does not change the sign-in.
      await page.locator("#idBtn_Back").click().catch(() => {})
    } else if (/Permissions requested|Need admin approval/i.test(body)) {
      throw new Error("Microsoft asks for consent. Grant tenant-wide admin consent to the E2E app registration (RELEASING.md).")
    } else if (/More information required|Let's keep your account secure|Action Required/i.test(body)) {
      throw new Error("Microsoft asks the test user for more information, such as MFA registration. The test user must have no MFA and be outside Conditional Access.")
    } else {
      const error = await loginError(page)
      if (error) throw new Error(`Microsoft refused the sign-in: ${error}`)
    }
    await sleep(500)
  }
  throw new Error(`Microsoft's login did not return to the app within 90 seconds (stopped at ${page.url().split("?")[0]}).`)
}

async function signInWith(browserName, playwright, secrets) {
  const profile = mkdtempSync(join(tmpdir(), `tenuvault-nightly-sign-in-${browserName}-`))
  let app = null
  let browser = null
  try {
    app = await launch(appPath, profile, shotsDir)
    assert(await app.waitForText("Welcome to TenuVault", 60_000), "The welcome screen did not appear.")
    await app.click("Connect your tenant")
    assert(await app.waitForText("I already have an app registration"), "The tenant setup did not open.")
    await app.click("I already have an app registration")
    assert(await app.waitFor(`Boolean(document.querySelector("input#tenant"))`), "The sign-in step did not open.")
    await app.fill("input#tenant", secrets.TENUVAULT_E2E_TENANT_ID)
    await app.fill("input#clientId", secrets.TENUVAULT_E2E_CLIENT_ID)
    await app.click("Sign in with Microsoft")
    assert(await app.waitForText("Complete the sign-in in your browser"), "The app did not start the sign-in.")

    // The link the sign-in recovery panel's "Copy sign-in link" copies, for another browser.
    let link = ""
    for (let attempt = 0; attempt < 60 && !link.startsWith("https://login.microsoftonline.com/"); attempt++) {
      if (await app.evaluate(`window.tenuvault.auth.copySignInLink("signin")`)) link = clipboard()
      if (!link.startsWith("https://login.microsoftonline.com/")) await sleep(500)
    }
    assert(link.startsWith("https://login.microsoftonline.com/"), "The app offered no Microsoft sign-in link to copy.")

    const type = browserName === "msedge" ? playwright.chromium : playwright[browserName]
    browser = await type.launch(browserName === "msedge" ? { channel: "msedge" } : {})
    const page = await (await browser.newContext()).newPage()
    await page.goto(link, { timeout: 60_000 })
    try {
      await completeLogin(page, secrets.TENUVAULT_E2E_USERNAME, secrets.TENUVAULT_E2E_PASSWORD)
    } catch (error) {
      // The repository is public: the test account is hidden before the capture.
      await maskedCapture(
        () => page.evaluate(maskPage, hidden(secrets)),
        () => page.screenshot({ path: join(shotsDir, `fail-${browserName}-login.png`) }),
      ).catch(() => {})
      throw error
    }

    const signedIn = `document.body.innerText.toLowerCase().includes(${JSON.stringify(`Signed in as ${secrets.TENUVAULT_E2E_USERNAME}`.toLowerCase())})`
    if (!(await app.waitFor(signedIn, 90_000))) {
      const error = await app.evaluate(`[...document.querySelectorAll('[role="alert"]')].map((e) => e.innerText).join(" ").slice(0, 400)`).catch(() => "")
      await app.screenshot(`fail-${browserName}-app`, hidden(secrets)).catch(() => {})
      throw new Error(`The app does not show the signed-in account${error ? `: ${hide(error, secrets)}` : "."}`)
    }
    const accounts = await app.evaluate("window.tenuvault.auth.accounts()")
    assert(
      accounts.some((account) => matchesTestAccount(account, secrets)),
      `The app has no account for the test user in the test tenant through the test app registration (${accounts.length} account(s)).`,
    )
  } catch (error) {
    await app?.screenshot(`fail-${browserName}-app`, hidden(secrets)).catch(() => {})
    // The logs are public; GitHub masks secrets in them, and so does this.
    throw new Error(hide(error instanceof Error ? error.message : String(error), secrets))
  } finally {
    await browser?.close().catch(() => {})
    await app?.close().catch(() => {})
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    } catch (error) {
      console.warn(`Could not remove the profile: ${error.message}`)
    }
  }
}

async function main() {
  const missing = SECRETS.filter((name) => !process.env[name]?.trim())
  if (missing.length > 0) {
    throw new Error(`The real sign-in needs the repository secrets ${missing.join(", ")} (RELEASING.md, nightly verification). It does not pass without them.`)
  }
  if (!appPath) throw new Error("NIGHTLY_VERIFY_APP is not set to the installed executable.")
  const unknown = browsers.filter((name) => !BROWSERS.includes(name))
  if (unknown.length > 0) throw new Error(`Unknown browser ${unknown.join(", ")}; use ${BROWSERS.join(", ")}.`)
  const secrets = Object.fromEntries(SECRETS.map((name) => [name, process.env[name].trim()]))
  // Playwright comes from this folder's own locked install (npm ci --prefix scripts/nightly-verification).
  const playwright = createRequire(import.meta.url)("playwright")
  for (const name of browsers) {
    await check(`the installed app signs in to the test tenant through ${name}`, () => signInWith(name, playwright, secrets))
  }
}

main()
  .catch((error) => failures.push(error instanceof Error ? error.message : String(error)))
  .finally(() => {
    if (failures.length > 0) {
      for (const failure of failures) console.log(`::error title=Nightly sign-in::${failure.split("\n")[0]}`)
      process.exit(1)
    }
    console.log(`The installed nightly signs in through ${browsers.join(", ")}.`)
    process.exit(0)
  })
