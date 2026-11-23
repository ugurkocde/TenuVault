/**
 * Completes Microsoft's login page in a Playwright page for the nightly sign-in verification
 * (sign-in.mjs). Kept apart so its retry rules can be tested without a browser.
 *
 * Microsoft's page is a single-page app that reuses one Next/Sign in button for every step and can
 * re-render a field it just showed. On a slow night a value typed too early is wiped (the page then
 * says "Enter a valid email address"), or a submit is lost while the step changes (the password
 * stays typed and nothing happens). So each step is submitted from its own field with Enter and
 * counts as sent only when the browser posts it to Microsoft. A step that was not sent is typed
 * again if the page wiped it and submitted again, a few times at most. A sent step is never
 * submitted again, however slow the answer: retrying credentials Microsoft may already have
 * refused could lock the test account. Any refusal ends the run at once.
 */

const defaultSleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** Errors Microsoft's page shows itself, without a request, when a step is submitted empty. */
const EMPTY_FIELD_ERROR = /Enter a valid email address|Please enter your password|Enter your password/i
/**
 * The fields of the step on screen. Every screen also carries off-screen copies for password
 * managers (`moveOffScreen`, aria-hidden): the username screen has an off-screen password field
 * that Playwright counts as visible. Typing into it and pressing Enter submits an empty username.
 */
const USERNAME_FIELD = 'input[name="loginfmt"]:not(.moveOffScreen):not([aria-hidden="true"])'
const PASSWORD_FIELD = 'input[name="passwd"]:not(.moveOffScreen):not([aria-hidden="true"])'
/** Screens that need a person: consent, MFA registration or an MFA challenge. */
const CONSENT = /Permissions requested|Need admin approval/i
const MFA = /More information required|Let's keep your account secure|Action Required|Approve sign in request|Verify your identity|Enter code|Open your Authenticator app/i

/** Microsoft refused the test account's credentials. Other browsers must not send them again. */
export class LoginRefused extends Error {
  constructor(message) {
    super(message)
    this.refused = true
  }
}

/** The text of the first visible error on Microsoft's login page, if any. */
export async function loginError(page) {
  for (const selector of ["#usernameError", "#passwordError", "#service_exception_message", "#idTD_Error", "div[role='alert']"]) {
    const element = page.locator(selector).first()
    // A hidden error is left over from an earlier step.
    if (!(await element.isVisible().catch(() => false))) continue
    const text = await element.innerText({ timeout: 200 }).catch(() => "")
    if (text.trim()) return text.trim().slice(0, 300)
  }
  return ""
}

/** A credential submit: the username lookup or the form post of a step. Not page telemetry. */
function isCredentialPost(request) {
  if (request.method() !== "POST") return false
  let url
  try {
    url = new URL(request.url())
  } catch {
    return false
  }
  return /(^|\.)login\.microsoftonline\.com$/i.test(url.hostname) && (request.isNavigationRequest() || /GetCredentialType/i.test(url.pathname))
}

/**
 * Completes Microsoft's login page until it redirects to the app's loopback address.
 * `options` exist for tests: the clock, the wait between checks and the limits.
 */
export async function completeLogin(page, username, password, options = {}) {
  const { now = Date.now, sleep = defaultSleep, timeoutMs = 120_000, sentWithinMs = 5_000, maxSubmits = 3 } = options
  const deadline = now() + timeoutMs
  const left = () => Math.max(1, deadline - now())
  // Every browser action is bounded, so a field the page replaces mid-action cannot outlast the deadline.
  const actionTimeout = () => Math.min(10_000, left())
  const stoppedAt = () => `stopped at ${page.url().split("?")[0]}`
  const atApp = () => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(page.url())
  const steps = {
    username: { field: page.locator(USERNAME_FIELD), value: username, submits: 0, sent: false },
    password: { field: page.locator(PASSWORD_FIELD), value: password, submits: 0, sent: false },
  }
  await steps.username.field.waitFor({ state: "visible", timeout: Math.min(60_000, left()) }).catch(() => {
    throw new Error(`Microsoft's login page did not ask for the username (${stoppedAt()}).`)
  })
  while (now() < deadline) {
    if (atApp()) return
    const body = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "")
    if (/Stay signed in\?/i.test(body) && (await page.locator("#idBtn_Back").isVisible().catch(() => false))) {
      // "No": the test browser keeps nothing, and the answer does not change the sign-in.
      await page.locator("#idBtn_Back").click({ timeout: actionTimeout() }).catch(() => {})
    } else if (CONSENT.test(body)) {
      throw new Error("Microsoft asks for consent. Grant tenant-wide admin consent to the E2E app registration (RELEASING.md).")
    } else if (MFA.test(body)) {
      throw new Error("Microsoft asks the test user for MFA or more information. The test user must have no MFA method and be outside Conditional Access.")
    } else {
      const error = await loginError(page)
      if (error && !EMPTY_FIELD_ERROR.test(error)) throw new LoginRefused(`Microsoft refused the sign-in: ${error}`)
      const name = (await steps.password.field.isVisible().catch(() => false))
        ? "password"
        : (await steps.username.field.isVisible().catch(() => false)) ? "username" : null
      const step = name ? steps[name] : null
      // A sent step waits for Microsoft's answer; only a step the browser never posted is submitted again.
      if (step && !step.sent) {
        if (step.submits >= maxSubmits) {
          throw new Error(`Microsoft's login page did not take the ${name} after ${maxSubmits} attempts${error ? `: ${error}` : ""} (${stoppedAt()}).`)
        }
        step.submits++
        let posted = null
        try {
          if ((await step.field.inputValue({ timeout: actionTimeout() })) !== step.value) await step.field.fill(step.value, { timeout: actionTimeout() })
          posted = page.waitForRequest(isCredentialPost, { timeout: sentWithinMs }).then(() => true, () => false)
          await step.field.press("Enter", { timeout: actionTimeout() })
        } catch {
          // The page replaced the field mid-action: look at the page again.
        }
        // Even a press that timed out may have submitted; only a post decides.
        if (posted) step.sent = await posted
      }
    }
    await sleep(500)
  }
  throw new Error(`Microsoft's login did not return to the app within ${Math.round(timeoutMs / 1000)} seconds (${stoppedAt()}).`)
}
