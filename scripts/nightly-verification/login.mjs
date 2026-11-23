/**
 * Completes Microsoft's login page in a Playwright page for the nightly sign-in verification
 * (sign-in.mjs). Kept apart so its retry rules can be tested without a browser.
 *
 * Microsoft's page is a single-page app that reuses one Next/Sign in button for every step and can
 * re-render a field it just showed. On a slow night a value typed too early is wiped (the page then
 * says "Enter a valid email address"), or a submit is lost while the step changes (the password
 * stays typed and nothing happens). So each step is submitted from its own field with Enter, typed
 * again when its field lost the value, and submitted again when nothing happened for a while, a
 * few times at most. Any other refusal, such as a wrong password, ends the run at once: retrying
 * it could lock the test account.
 */

const defaultSleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** Errors Microsoft shows when a step was submitted with an empty field. */
const EMPTY_FIELD_ERROR = /Enter a valid email address|Please enter your password|Enter your password/i

/** The visible error text on Microsoft's login page, if any. */
export async function loginError(page) {
  for (const selector of ["#usernameError", "#passwordError", "#service_exception_message", "#idTD_Error", "div[role='alert']"]) {
    const text = await page.locator(selector).first().innerText({ timeout: 200 }).catch(() => "")
    if (text.trim()) return text.trim().slice(0, 300)
  }
  return ""
}

/**
 * Completes Microsoft's login page until it redirects to the app's loopback address.
 * `options` exist for tests: the clock, the wait between checks and the limits.
 */
export async function completeLogin(page, username, password, options = {}) {
  const { now = Date.now, sleep = defaultSleep, timeoutMs = 120_000, resubmitAfterMs = 15_000, maxSubmits = 3 } = options
  const atApp = () => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(page.url())
  const steps = {
    username: { field: page.locator('input[name="loginfmt"]'), value: username, submits: 0 },
    password: { field: page.locator('input[name="passwd"]'), value: password, submits: 0 },
  }
  await steps.username.field.waitFor({ state: "visible", timeout: 60_000 })
  let lastSubmit = -Infinity
  const deadline = now() + timeoutMs
  while (now() < deadline) {
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
      // The password step first: its field stays in the page, hidden, while the username shows.
      const name = (await steps.password.field.isVisible().catch(() => false))
        ? "password"
        : (await steps.username.field.isVisible().catch(() => false)) ? "username" : null
      const error = await loginError(page)
      if (!name) {
        if (error) throw new Error(`Microsoft refused the sign-in: ${error}`)
      } else {
        const step = steps[name]
        // The test values are never empty, so an empty-field error can only mean the page wiped
        // the field; it stays on screen until the next submit. Any other error is a real refusal.
        if (error && !EMPTY_FIELD_ERROR.test(error)) throw new Error(`Microsoft refused the sign-in: ${error}`)
        const holds = (await step.field.inputValue({ timeout: 1000 }).catch(() => "")) === step.value
        if (!holds || now() - lastSubmit >= resubmitAfterMs) {
          if (step.submits >= maxSubmits) {
            throw new Error(`Microsoft's login page did not take the ${name} after ${maxSubmits} attempts${error ? `: ${error}` : ""} (stopped at ${page.url().split("?")[0]}).`)
          }
          if (!holds) await step.field.fill(step.value)
          await step.field.press("Enter")
          step.submits++
          lastSubmit = now()
        }
      }
    }
    await sleep(500)
  }
  throw new Error(`Microsoft's login did not return to the app within ${Math.round(timeoutMs / 1000)} seconds (stopped at ${page.url().split("?")[0]}).`)
}
