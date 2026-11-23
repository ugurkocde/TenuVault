import { describe, expect, it } from "vitest"

// The nightly verification runs this module with plain Node in a Playwright browser.
type Options = { now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; sentWithinMs?: number; maxSubmits?: number }
const load = async () => (await import("../scripts/nightly-verification/login.mjs" as string)) as {
  completeLogin: (page: unknown, username: string, password: string, options?: Options) => Promise<void>
}

const USER = "e2e@contoso.example"
const PASSWORD = "correct horse"
const LOGIN = "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize"

type Scenario = {
  /** The page re-renders the username field after the first fill, so the first submit is empty. */
  wipeFirstUsername?: boolean
  /** Password submits the page loses while it changes steps: nothing is posted. */
  lostPasswordSubmits?: number
  /** Microsoft refuses the password. */
  wrongPassword?: boolean
  /** Microsoft answers the posted password only after this long, then refuses it. */
  refuseAfterMs?: number
  /** The screen after the password. */
  after?: "kmsi" | "mfa" | "approve" | "consent"
  /** A hidden error left over from the username step. */
  staleHiddenError?: string
}

type Request = { method: () => string; url: () => string; isNavigationRequest: () => boolean }

/** A stand-in for Microsoft's login page: the parts of a Playwright page completeLogin uses. */
function fakeLogin(scenario: Scenario = {}) {
  let time = 0
  let step: "username" | "password" | "kmsi" | "mfa" | "approve" | "consent" | "app" = "username"
  const values = { loginfmt: "", passwd: "" }
  const errors = { usernameError: "", passwordError: "" }
  const submits = { username: [] as string[], password: [] as string[] }
  const posts: string[] = []
  let wipe = scenario.wipeFirstUsername ?? false
  let lost = scenario.lostPasswordSubmits ?? 0
  let refusalAt: number | null = null
  let waiters: { match: (request: Request) => boolean; resolve: () => void }[] = []

  const post = (url: string, navigation: boolean) => {
    posts.push(url)
    const request: Request = { method: () => "POST", url: () => url, isNavigationRequest: () => navigation }
    waiters = waiters.filter((waiter) => (waiter.match(request) ? (waiter.resolve(), false) : true))
  }
  const refuse = () => {
    errors.passwordError = "Your account or password is incorrect."
    values.passwd = ""
  }

  const submit = (field: "loginfmt" | "passwd") => {
    if (field === "loginfmt" && step === "username") {
      submits.username.push(values.loginfmt)
      // An empty field is refused by the page itself, without a request.
      if (!values.loginfmt) return void (errors.usernameError = "Enter a valid email address, phone number, or Skype name.")
      post("https://login.microsoftonline.com/common/GetCredentialType?mkt=en-US", false)
      errors.usernameError = scenario.staleHiddenError ?? ""
      step = "password"
    } else if (field === "passwd" && step === "password") {
      submits.password.push(values.passwd)
      if (lost > 0) return void lost--
      if (!values.passwd) return void (errors.passwordError = "Please enter your password.")
      post("https://login.microsoftonline.com/tenant/login", true)
      if (scenario.refuseAfterMs !== undefined) refusalAt = time + scenario.refuseAfterMs
      else if (scenario.wrongPassword) refuse()
      else step = scenario.after ?? "kmsi"
    }
  }

  // The username screen carries an off-screen password field for password managers, which a
  // plain selector finds and Playwright counts as visible; only the step's own fields count here.
  const USERNAME = 'input[name="loginfmt"]:not(.moveOffScreen):not([aria-hidden="true"])'
  const PASSWORD = 'input[name="passwd"]:not(.moveOffScreen):not([aria-hidden="true"])'
  const visible = (selector: string) =>
    (selector === USERNAME && step === "username") ||
    (selector === PASSWORD && step === "password") ||
    (selector === 'input[name="passwd"]' && (step === "username" || step === "password")) ||
    (selector === "#idBtn_Back" && step === "kmsi") ||
    (selector === "#usernameError" && step === "username" && errors.usernameError !== "") ||
    (selector === "#passwordError" && step === "password" && errors.passwordError !== "")

  const BODY = { kmsi: "Stay signed in?", mfa: "More information required", approve: "Approve sign in request", consent: "Permissions requested" } as Record<string, string>

  const locator = (selector: string) => {
    if (selector === 'input[name="passwd"]' || selector === 'input[name="loginfmt"]') throw new Error(`${selector} also matches the off-screen password manager fields`)
    const field = selector === USERNAME ? "loginfmt" : selector === PASSWORD ? "passwd" : null
    const self = {
      first: () => self,
      waitFor: async () => {},
      isVisible: async () => visible(selector),
      inputValue: async () => (field ? values[field] : ""),
      fill: async (value: string) => {
        if (!field) throw new Error(`fill on ${selector}`)
        values[field] = value
        if (field === "loginfmt" && wipe) {
          wipe = false
          values.loginfmt = ""
        }
      },
      press: async (key: string) => {
        if (!field || key !== "Enter") throw new Error(`press ${key} on ${selector}`)
        submit(field)
      },
      click: async () => {
        if (selector === "#idBtn_Back" && step === "kmsi") step = "app"
      },
      // innerText also reads hidden elements, as in a browser.
      innerText: async () => {
        if (selector === "body") return BODY[step] ?? "Sign in"
        if (selector === "#usernameError") return errors.usernameError
        if (selector === "#passwordError") return errors.passwordError
        return ""
      },
    }
    return self
  }

  const page = {
    url: () => (step === "app" ? "http://localhost:51234/?code=redacted" : `${LOGIN}?client_id=x`),
    locator,
    // Resolves when a matching request is posted during the next action, else times out.
    waitForRequest: (match: (request: Request) => boolean) =>
      new Promise<void>((resolve, reject) => {
        waiters.push({ match, resolve })
        setTimeout(() => reject(new Error("Timeout waiting for request")), 0)
      }),
  }
  const options: Options = {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms
      if (refusalAt !== null && time >= refusalAt) {
        refusalAt = null
        refuse()
      }
    },
  }
  return { page, options, submits, posts, step: () => step }
}

describe("nightly sign-in: Microsoft's login page", () => {
  it("signs in when the page takes every step at once", async () => {
    const { completeLogin } = await load()
    const login = fakeLogin()
    await completeLogin(login.page, USER, PASSWORD, login.options)
    expect(login.step()).toBe("app")
    expect(login.submits).toEqual({ username: [USER], password: [PASSWORD] })
  })

  it("types the username again when the page wiped it before the submit", async () => {
    const { completeLogin } = await load()
    const login = fakeLogin({ wipeFirstUsername: true })
    await completeLogin(login.page, USER, PASSWORD, login.options)
    expect(login.step()).toBe("app")
    expect(login.submits.username).toEqual(["", USER])
  })

  it("submits the password again when the browser never posted it", async () => {
    const { completeLogin } = await load()
    const login = fakeLogin({ lostPasswordSubmits: 1 })
    await completeLogin(login.page, USER, PASSWORD, login.options)
    expect(login.step()).toBe("app")
    expect(login.submits.password).toEqual([PASSWORD, PASSWORD])
    expect(login.posts.filter((url) => url.endsWith("/login"))).toHaveLength(1)
  })

  it("gives up after the attempt limit instead of waiting for the timeout", async () => {
    const { completeLogin } = await load()
    const login = fakeLogin({ lostPasswordSubmits: 10 })
    await expect(completeLogin(login.page, USER, PASSWORD, login.options)).rejects.toThrow(
      `Microsoft's login page did not take the password after 3 attempts (stopped at ${LOGIN}).`,
    )
    expect(login.submits.password).toHaveLength(3)
  })

  it("stops at once on a wrong password, without trying it again", async () => {
    const { completeLogin } = await load()
    const login = fakeLogin({ wrongPassword: true })
    const error = await completeLogin(login.page, USER, PASSWORD, login.options).catch((caught: Error & { refused?: boolean }) => caught)
    expect(error).toMatchObject({ message: "Microsoft refused the sign-in: Your account or password is incorrect.", refused: true })
    expect(login.submits.password).toEqual([PASSWORD])
  })

  it("never sends a posted password again while Microsoft is slow to answer", async () => {
    const { completeLogin } = await load()
    const login = fakeLogin({ refuseAfterMs: 20_000 })
    await expect(completeLogin(login.page, USER, PASSWORD, login.options)).rejects.toThrow("Microsoft refused the sign-in: Your account or password is incorrect.")
    expect(login.submits.password).toEqual([PASSWORD])
  })

  it("ignores a hidden error left over from the username step", async () => {
    const { completeLogin } = await load()
    const login = fakeLogin({ staleHiddenError: "This username may be incorrect." })
    await completeLogin(login.page, USER, PASSWORD, login.options)
    expect(login.step()).toBe("app")
  })

  it.each([
    ["mfa", /MFA or more information/],
    ["approve", /MFA or more information/],
    ["consent", /asks for consent/],
  ] as const)("reports the %s screen at once", async (after, message) => {
    const { completeLogin } = await load()
    const login = fakeLogin({ after })
    await expect(completeLogin(login.page, USER, PASSWORD, login.options)).rejects.toThrow(message)
  })

  it("times out with the page it stopped at", async () => {
    const { completeLogin } = await load()
    const login = fakeLogin({ refuseAfterMs: 60_000 })
    await expect(completeLogin(login.page, USER, PASSWORD, { ...login.options, timeoutMs: 30_000 })).rejects.toThrow(
      `Microsoft's login did not return to the app within 30 seconds (stopped at ${LOGIN}).`,
    )
    expect(login.submits.password).toEqual([PASSWORD])
  })
})
