import { describe, expect, it } from "vitest"

// The nightly verification runs this module with plain Node in a Playwright browser.
type Options = { now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; resubmitAfterMs?: number; maxSubmits?: number }
const load = async () => (await import("../scripts/nightly-verification/login.mjs" as string)) as {
  completeLogin: (page: unknown, username: string, password: string, options?: Options) => Promise<void>
}

const USER = "e2e@contoso.example"
const PASSWORD = "correct horse"
const EMPTY_EMAIL = "Enter a valid email address, phone number, or Skype name."

type Scenario = {
  /** The page re-renders the username field after the first fill, so the first submit is empty. */
  wipeFirstUsername?: boolean
  /** Password submits the page loses while it changes steps. */
  lostPasswordSubmits?: number
  /** Microsoft refuses the password. */
  wrongPassword?: boolean
  /** Microsoft asks for MFA registration after the password. */
  mfa?: boolean
}

/** A stand-in for Microsoft's login page: the parts of a Playwright page completeLogin uses. */
function fakeLogin(scenario: Scenario = {}) {
  let time = 0
  let step: "username" | "password" | "kmsi" | "app" | "mfa" = "username"
  const values = { loginfmt: "", passwd: "" }
  const errors = { usernameError: "", passwordError: "" }
  const submits = { username: [] as string[], password: [] as string[] }
  let wipe = scenario.wipeFirstUsername ?? false
  let lost = scenario.lostPasswordSubmits ?? 0

  const submit = (field: "loginfmt" | "passwd") => {
    if (field === "loginfmt" && step === "username") {
      submits.username.push(values.loginfmt)
      if (!values.loginfmt) errors.usernameError = EMPTY_EMAIL
      else {
        errors.usernameError = ""
        step = "password"
      }
    } else if (field === "passwd" && step === "password") {
      submits.password.push(values.passwd)
      if (lost > 0) {
        lost--
        return
      }
      if (scenario.wrongPassword) {
        errors.passwordError = "Your account or password is incorrect."
        values.passwd = ""
      } else step = scenario.mfa ? "mfa" : "kmsi"
    }
  }

  const visible = (selector: string) =>
    (selector === 'input[name="loginfmt"]' && step === "username") ||
    (selector === 'input[name="passwd"]' && step === "password") ||
    (selector === "#idBtn_Back" && step === "kmsi")

  const locator = (selector: string) => {
    const field = selector === 'input[name="loginfmt"]' ? "loginfmt" : selector === 'input[name="passwd"]' ? "passwd" : null
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
      innerText: async () => {
        if (selector === "body") return step === "kmsi" ? "Stay signed in?" : step === "mfa" ? "More information required" : "Sign in"
        if (selector === "#usernameError") return step === "username" ? errors.usernameError : ""
        if (selector === "#passwordError") return step === "password" ? errors.passwordError : ""
        return ""
      },
    }
    return self
  }

  const page = {
    url: () => (step === "app" ? "http://localhost:51234/?code=redacted" : "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?client_id=x"),
    locator,
  }
  const options: Options = {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms
    },
  }
  return { page, options, submits, step: () => step }
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

  it("submits the password again when a submit was lost", async () => {
    const { completeLogin } = await load()
    const login = fakeLogin({ lostPasswordSubmits: 1 })
    await completeLogin(login.page, USER, PASSWORD, login.options)
    expect(login.step()).toBe("app")
    expect(login.submits.password).toEqual([PASSWORD, PASSWORD])
  })

  it("gives up after the attempt limit instead of waiting for the timeout", async () => {
    const { completeLogin } = await load()
    const login = fakeLogin({ lostPasswordSubmits: 10 })
    await expect(completeLogin(login.page, USER, PASSWORD, login.options)).rejects.toThrow(/did not take the password after 3 attempts/)
    expect(login.submits.password).toHaveLength(3)
  })

  it("stops at once on a wrong password, without trying it again", async () => {
    const { completeLogin } = await load()
    const login = fakeLogin({ wrongPassword: true })
    await expect(completeLogin(login.page, USER, PASSWORD, login.options)).rejects.toThrow("Microsoft refused the sign-in: Your account or password is incorrect.")
    expect(login.submits.password).toEqual([PASSWORD])
  })

  it("reports an MFA prompt", async () => {
    const { completeLogin } = await load()
    const login = fakeLogin({ mfa: true })
    await expect(completeLogin(login.page, USER, PASSWORD, login.options)).rejects.toThrow(/MFA registration/)
  })

  it("times out with the page it stopped at", async () => {
    const { completeLogin } = await load()
    const login = fakeLogin({ lostPasswordSubmits: 10 })
    await expect(completeLogin(login.page, USER, PASSWORD, { ...login.options, maxSubmits: 100, timeoutMs: 30_000 }))
      .rejects.toThrow("Microsoft's login did not return to the app within 30 seconds (stopped at https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize).")
  })
})
