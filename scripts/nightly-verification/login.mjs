/**
 * Completes Microsoft's login page in a Playwright page for the nightly sign-in verification
 * (sign-in.mjs). Kept apart so its retry rules can be tested without a browser.
 *
 * Microsoft's page is a single-page app that reuses one Next/Sign in button for every step and can
 * re-render a field it just showed. On a slow night a value typed too early is wiped (the page then
 * says "Enter a valid email address"), or a submit is lost while the step changes (the password
 * stays typed and nothing happens). So each step is submitted from its own field with Enter and
 * counts as sent as soon as the browser posts it to Microsoft, however late. A step with no post
 * for a while after its last attempt is typed again if the page wiped it and submitted again, a
 * few times at most. A sent step is never submitted again, however slow the answer: retrying
 * credentials Microsoft may already have refused could lock the test account. Any refusal ends
 * the run at once.
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

/** Microsoft stopped the test account's sign-in: a refusal, consent or MFA. Other browsers must not send the credentials again. */
export class LoginStopped extends Error {
  constructor(message) {
    super(message)
    this.stopped = true
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
  const { now = Date.now, sleep = defaultSleep, timeoutMs = 120_000, sentWithinMs = 15_000, maxSubmits = 3 } = options
  const deadline = now() + timeoutMs
  const left = () => Math.max(1, deadline - now())
  // Every browser action is bounded, so a field the page replaces mid-action cannot outlast the deadline.
  const actionTimeout = () => Math.min(10_000, left())
  const stoppedAt = () => `stopped at ${page.url().split(/[?#]/)[0]}`
  const atApp = () => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(page.url())
  // One listener for the whole login: a post that arrives late, after a slow Enter, still counts.
  let posts = 0
  const onRequest = (request) => {
    if (isCredentialPost(request)) posts++
  }
  page.on("request", onRequest)
  const steps = {
    username: { field: page.locator(USERNAME_FIELD), value: username, submits: 0, sent: false, postsBefore: 0, triedAt: 0 },
    password: { field: page.locator(PASSWORD_FIELD), value: password, submits: 0, sent: false, postsBefore: 0, triedAt: 0 },
  }
  try {
    await steps.username.field.waitFor({ state: "visible", timeout: Math.min(60_000, left()) }).catch(() => {
      throw new Error(`Microsoft's login page did not ask for the username (${stoppedAt()}).`)
    })
    while (now() < deadline) {
      if (atApp()) return
      // A post since a step's last attempt means Microsoft has it: that step is never submitted again.
      for (const step of Object.values(steps)) if (step.submits > 0 && posts > step.postsBefore) step.sent = true
      const body = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "")
      if (/Stay signed in\?/i.test(body) && (await page.locator("#idBtn_Back").isVisible().catch(() => false))) {
        // "No": the test browser keeps nothing, and the answer does not change the sign-in.
        await page.locator("#idBtn_Back").click({ timeout: actionTimeout() }).catch(() => {})
      } else if (CONSENT.test(body)) {
        throw new LoginStopped(`Microsoft asks for consent. Grant tenant-wide admin consent to the E2E app registration (RELEASING.md) (${stoppedAt()}).`)
      } else if (MFA.test(body)) {
        throw new LoginStopped(`Microsoft asks the test user for MFA or more information. The test user must have no MFA method and be outside Conditional Access (${stoppedAt()}).`)
      } else {
        const error = await loginError(page)
        if (error && !EMPTY_FIELD_ERROR.test(error)) throw new LoginStopped(`Microsoft refused the sign-in: ${error} (${stoppedAt()})`)
        const name = (await steps.password.field.isVisible().catch(() => false))
          ? "password"
          : (await steps.username.field.isVisible().catch(() => false)) ? "username" : null
        const step = name ? steps[name] : null
        // A sent step waits for Microsoft's answer. A step is submitted again only when the browser
        // posted nothing for 15 seconds after its last attempt: a request counts when it is sent, not
        // when it is answered, so a slow answer never looks like a lost submit.
        if (step && !step.sent && (step.submits === 0 || now() - step.triedAt >= sentWithinMs)) {
          if (step.submits >= maxSubmits) {
            throw new Error(`Microsoft's login page did not take the ${name} after ${maxSubmits} attempts${error ? `: ${error}` : ""} (${stoppedAt()}).`)
          }
          step.submits++
          step.postsBefore = posts
          try {
            if ((await step.field.inputValue({ timeout: actionTimeout() })) !== step.value) await step.field.fill(step.value, { timeout: actionTimeout() })
            await step.field.press("Enter", { timeout: actionTimeout() })
          } catch {
            // The page replaced the field mid-action: look at the page again.
          }
          step.triedAt = now()
        }
      }
      await sleep(Math.min(500, left()))
    }
    if (atApp()) return
    throw new Error(`Microsoft's login did not return to the app within ${Math.round(timeoutMs / 1000)} seconds (${stoppedAt()}).`)
  } finally {
    page.off("request", onRequest)
  }
}

/**
 * Runs the sign-in check once per browser. After Microsoft stopped the test account's sign-in
 * (a refusal, consent, MFA), the remaining browsers do not send the credentials again: repeated
 * refusals could lock the account.
 */
export async function signInEach(browsers, check, signIn) {
  let stoppedIn = ""
  for (const name of browsers) {
    await check(`the installed app signs in to the test tenant through ${name}`, async () => {
      if (stoppedIn) throw new Error(`Not tried: Microsoft stopped the test account's sign-in in ${stoppedIn}, so the credentials are not sent again.`)
      try {
        return await signIn(name)
      } catch (error) {
        if (error?.stopped === true) stoppedIn = name
        throw error
      }
    })
  }
}
