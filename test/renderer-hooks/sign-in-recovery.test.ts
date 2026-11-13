import { act, createElement, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SignedInAccount } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  signIn: vi.fn<(tenant: string, clientId: string, options?: { loginHint?: string }) => Promise<SignedInAccount>>(),
  cancelSignIn: vi.fn(async () => false),
  setupCancelSignIn: vi.fn(async () => false),
  phase: null as null | ((phase: "license") => void),
  copySignInLink: vi.fn(async (_kind: "signin" | "setup") => true),
  createRegistration: vi.fn(),
  cancelCreateRegistration: vi.fn(async () => undefined),
  openExternal: vi.fn(async (_url: string) => undefined),
  record: vi.fn(async (_event: unknown) => undefined),
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    auth: { signIn: state.signIn, cancelSignIn: state.cancelSignIn, copySignInLink: state.copySignInLink, accounts: async () => [], onSignInPhase: (listener: (phase: "license") => void) => { state.phase = listener; return () => { state.phase = null } } },
    setup: { createRegistration: state.createRegistration, cancelCreateRegistration: state.cancelCreateRegistration, cancelSignIn: state.setupCancelSignIn, onProgress: () => () => undefined, clipboardIds: async () => null, saveScript: async () => ({ saved: false }) },
    license: { clipboardKey: async () => null },
    app: { openExternal: state.openExternal },
    diagnostics: { record: state.record, status: async () => ({ state: "ineligible", policy: false, reminder: { setup: false, signin: false } }), reminderShown: async () => undefined, consent: async () => undefined, decline: async () => undefined },
  },
}))
vi.mock("../../src/renderer/lib/license", () => ({
  useTenantPlan: () => "community",
  useLicense: () => ({ status: null, error: null, refresh: async () => undefined }),
  tenantLicense: () => undefined,
  tenantPlan: () => null,
  formatDate: (value: string) => value,
}))

import { TenantSignInForm } from "../../src/renderer/components/TenantSignInForm"
import { ConnectTenantSetup } from "../../src/renderer/components/ConnectTenantSetup"
import { RECOVERY_DELAY_MS } from "../../src/renderer/components/SignInRecovery"
import { FIRST_SIGN_IN_TIMEOUT_MESSAGE, MANUAL_APP_REGISTRATION_URL, setupHandoffText } from "../../src/shared/app-registration"

const TENANT = "8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14"
const CLIENT = "5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3"
const PANEL = "Still waiting for Microsoft?"
const roots: Root[] = []
const writeText = vi.fn(async (_text: string) => undefined)

beforeEach(() => {
  // Leftover one-time answers from an earlier test must not reach the next one.
  for (const mock of [state.signIn, state.cancelSignIn, state.setupCancelSignIn, state.copySignInLink, state.createRegistration, state.cancelCreateRegistration]) mock.mockReset()
  state.cancelSignIn.mockResolvedValue(false)
  state.setupCancelSignIn.mockResolvedValue(false)
  state.copySignInLink.mockResolvedValue(true)
  state.cancelCreateRegistration.mockResolvedValue(undefined)
  vi.useFakeTimers()
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
})

afterEach(async () => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  await act(async () => { await vi.runOnlyPendingTimersAsync() })
  vi.useRealTimers()
  document.body.innerHTML = ""
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function render(element: ReactElement) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MemoryRouter, null, element)))
  await advance(0)
  return container
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)

/** A sign-in that waits until it is cancelled, as the main process answers a cancel. */
function waitingSignIn() {
  let reject: (error: Error) => void = () => undefined
  state.signIn.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  state.cancelSignIn.mockImplementationOnce(async () => { reject(new Error("Sign-in cancelled.")); return true })
}

async function startSignIn() {
  const container = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn(), initial: { tenant: TENANT, clientId: CLIENT } }))
  await act(async () => { button(container, "Sign in with Microsoft")!.click() })
  return container
}

describe("recovery panel on the first sign-in", () => {
  it("appears after 3 minutes of waiting and not before", async () => {
    waitingSignIn()
    const container = await startSignIn()
    expect(RECOVERY_DELAY_MS).toBe(3 * 60_000)
    await advance(RECOVERY_DELAY_MS - 1000)
    expect(container.textContent).not.toContain(PANEL)
    await advance(999)
    expect(container.textContent).not.toContain(PANEL)
    await advance(1)
    expect(container.textContent).toContain(PANEL)
    expect(container.textContent).toContain("If the browser tab closed or showed an error, try again. You can also open the sign-in link in another browser, or send the setup to your admin.")
    for (const label of ["Try again", "Copy sign-in link", "Copy instructions for your admin"]) expect(button(container, label)).toBeDefined()
  })

  it("Try again cancels the waiting sign-in and starts the same one again, with a new 3 minute wait", async () => {
    waitingSignIn()
    const container = await startSignIn()
    await advance(RECOVERY_DELAY_MS)
    waitingSignIn()
    await act(async () => { button(container, "Try again")!.click() })
    await advance(0)
    expect(state.cancelSignIn).toHaveBeenCalledTimes(1)
    expect(state.signIn).toHaveBeenCalledTimes(2)
    expect(state.signIn).toHaveBeenLastCalledWith(TENANT, CLIENT)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain("Complete the sign-in in your browser.")
    expect(container.textContent).not.toContain(PANEL)
    await advance(RECOVERY_DELAY_MS)
    expect(container.textContent).toContain(PANEL)
  })

  it("Try again leaves a sign-in alone whose browser step ended just before", async () => {
    let finish: (account: SignedInAccount) => void = () => undefined
    state.signIn.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    // The browser step ended: the main process has nothing to cancel.
    state.cancelSignIn.mockResolvedValueOnce(false)
    const onSignedIn = vi.fn()
    const container = await render(createElement(TenantSignInForm, { onSignedIn, initial: { tenant: TENANT, clientId: CLIENT } }))
    await act(async () => { button(container, "Sign in with Microsoft")!.click() })
    await advance(RECOVERY_DELAY_MS)
    await act(async () => { button(container, "Try again")!.click() })
    await advance(0)
    expect(state.cancelSignIn).toHaveBeenCalledTimes(1)
    expect(button(container, "Try again")!.disabled).toBe(false)
    finish({ tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.example" })
    await advance(0)
    expect(onSignedIn).toHaveBeenCalledTimes(1)
    expect(state.signIn).toHaveBeenCalledTimes(1)
  })

  it("shows no panel while a slow license check runs after the browser step", async () => {
    state.signIn.mockImplementationOnce(() => new Promise(() => undefined))
    const container = await startSignIn()
    await advance(1000)
    act(() => state.phase?.("license"))
    await advance(RECOVERY_DELAY_MS * 2)
    expect(container.textContent).not.toContain(PANEL)
    expect(container.textContent).toContain("Waiting for sign-in...")
  })

  it("hides the panel when the browser step ends while it shows", async () => {
    state.signIn.mockImplementationOnce(() => new Promise(() => undefined))
    const container = await startSignIn()
    await advance(RECOVERY_DELAY_MS)
    expect(container.textContent).toContain(PANEL)
    act(() => state.phase?.("license"))
    expect(container.textContent).not.toContain(PANEL)
  })

  it("copies the sign-in link through the main process and the handoff text", async () => {
    waitingSignIn()
    const container = await startSignIn()
    await advance(RECOVERY_DELAY_MS)
    await act(async () => { button(container, "Copy sign-in link")!.click() })
    expect(state.copySignInLink).toHaveBeenCalledWith("signin")
    expect(container.textContent).toContain("Copied the sign-in link.")
    // The link itself is written in the main process; the renderer never sees it.
    expect(writeText).not.toHaveBeenCalled()

    state.copySignInLink.mockResolvedValueOnce(false)
    await act(async () => { button(container, "Copied")!.click() })
    expect(container.textContent).toContain("The sign-in link is no longer available.")

    await act(async () => { button(container, "Copy instructions for your admin")!.click() })
    expect(writeText).toHaveBeenCalledWith(setupHandoffText())
  })
})

describe("first sign-in error actions", () => {
  async function failWith(message: string) {
    state.signIn.mockRejectedValueOnce(new Error(message))
    const container = await startSignIn()
    await advance(0)
    return container.querySelector<HTMLElement>('[role="alert"]')!
  }

  it("offers Try again and the handoff after the 15 minute timeout", async () => {
    const alert = await failWith(FIRST_SIGN_IN_TIMEOUT_MESSAGE)
    expect(alert.textContent).toContain("not completed within 15 minutes")
    expect(button(alert, "Try again")).toBeDefined()
    expect(button(alert, "Copy instructions for your admin")).toBeDefined()
    waitingSignIn()
    await act(async () => { button(alert, "Try again")!.click() })
    expect(state.signIn).toHaveBeenCalledTimes(2)
  })

  it.each(["AADSTS53000", "AADSTS53001", "AADSTS53003", "AADSTS65001", "AADSTS90094", "AADSTS50076", "AADSTS50079"])("offers the handoff and the manual setup for %s", async (code) => {
    const alert = await failWith(`Microsoft refused the sign-in. (${code})`)
    expect(button(alert, "Copy instructions for your admin")).toBeDefined()
    await act(async () => { button(alert, "Create it by hand")!.click() })
    expect(state.openExternal).toHaveBeenCalledWith(MANUAL_APP_REGISTRATION_URL)
    expect(button(alert, "Try again")).toBeUndefined()
  })

  it.each(["AADSTS700016", "AADSTS50105", "AADSTS65004"])("offers neither for %s", async (code) => {
    const alert = await failWith(`Microsoft refused the sign-in. (${code})`)
    expect(button(alert, "Copy instructions for your admin")).toBeUndefined()
    expect(button(alert, "Create it by hand")).toBeUndefined()
  })
})

describe("recovery panel on the setup sign-in", () => {
  it("appears after 3 minutes, copies the setup link and Try again restarts the setup", async () => {
    let reject: (error: Error) => void = () => undefined
    const waiting = () => {
      state.createRegistration.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
      state.setupCancelSignIn.mockImplementationOnce(async () => { reject(new Error("Sign-in cancelled.")); return true })
    }
    waiting()
    const container = await render(createElement(ConnectTenantSetup, { trials: false, onManual: vi.fn(), onRegistered: vi.fn() }))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click() })
    await advance(RECOVERY_DELAY_MS - 1)
    expect(container.textContent).not.toContain(PANEL)
    await advance(1)
    expect(container.textContent).toContain(PANEL)

    await act(async () => { button(container, "Copy sign-in link")!.click() })
    expect(state.copySignInLink).toHaveBeenCalledWith("setup")

    waiting()
    await act(async () => { button(container, "Try again")!.click() })
    await advance(0)
    expect(state.setupCancelSignIn).toHaveBeenCalledTimes(1)
    expect(state.cancelCreateRegistration).not.toHaveBeenCalled()
    expect(state.createRegistration).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).not.toContain(PANEL)
    // The restart is the same route, so it is counted once.
    expect(state.record.mock.calls.filter(([event]) => (event as { props?: { route?: string } }).props?.route === "auto")).toHaveLength(1)
  })
})

describe("Try again on the setup sign-in after the browser step", () => {
  it("does not stop a setup whose sign-in came back just before", async () => {
    state.createRegistration.mockImplementationOnce(() => new Promise(() => undefined))
    state.setupCancelSignIn.mockResolvedValueOnce(false)
    const container = await render(createElement(ConnectTenantSetup, { trials: false, onManual: vi.fn(), onRegistered: vi.fn() }))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click() })
    await advance(RECOVERY_DELAY_MS)
    await act(async () => { button(container, "Try again")!.click() })
    await advance(0)
    expect(state.setupCancelSignIn).toHaveBeenCalledTimes(1)
    expect(state.cancelCreateRegistration).not.toHaveBeenCalled()
    expect(state.createRegistration).toHaveBeenCalledTimes(1)
    expect(button(container, "Try again")!.disabled).toBe(false)
  })
})
