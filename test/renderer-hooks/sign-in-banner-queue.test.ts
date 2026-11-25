import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { GRAPH_CLI_CLIENT_ID } from "../../src/shared/tenant-connection"
import type { SignInRequiredEvent } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  listener: null as ((event: SignInRequiredEvent) => void) | null,
  accountChanged: null as ((tenantId: string) => void) | null,
  reauthenticate: vi.fn().mockResolvedValue({ username: "admin@contoso.com" }),
  openExternal: vi.fn(async () => undefined),
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    app: { openExternal: state.openExternal },
    auth: {
      onSignInRequired: (listener: (event: SignInRequiredEvent) => void) => {
        state.listener = listener
        return () => { state.listener = null }
      },
      onAccountsChanged: (listener: (tenantId: string) => void) => {
        state.accountChanged = listener
        return () => { state.accountChanged = null }
      },
      reauthenticate: state.reauthenticate,
    },
  },
}))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: () => undefined }))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => [
    { id: 1, name: "Contoso", credentials: { tenantId: "tenant-a" } },
    { id: 2, name: "Fabrikam", credentials: { tenantId: "tenant-b" } },
  ],
}))

import { SignInBanner } from "../../src/renderer/components/SignInBanner"

const event = (tenantId: string): SignInRequiredEvent => ({ tenantId, clientId: "app", message: "Sign in again to continue.", scope: "graph" })

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function mount(): HTMLDivElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(SignInBanner)))
  return container
}

describe("Sign-in banner", () => {
  it("retains queued prompts and receives new requests while its content is hidden", () => {
    const container = mount(), root = roots.at(-1)!, listener = state.listener
    act(() => state.listener!(event("tenant-a")))
    expect(container.textContent).toContain("Contoso")
    act(() => root.render(createElement(SignInBanner, { hidden: true })))
    expect(container.textContent).toBe("")
    expect(state.listener).toBe(listener)
    act(() => state.listener!(event("tenant-b")))
    expect(container.textContent).toBe("")
    act(() => root.render(createElement(SignInBanner, { hidden: false })))
    expect(container.textContent).toContain("Contoso")
    expect(container.textContent).toContain("1 more sign-in is waiting.")
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click())
    expect(container.textContent).toContain("Fabrikam")
  })
  it("shows the next tenant's prompt after the first is dismissed", () => {
    const container = mount()
    act(() => {
      state.listener!(event("tenant-a"))
      state.listener!(event("tenant-b"))
      state.listener!(event("tenant-a"))
    })
    expect(container.textContent).toContain("Contoso")
    expect(container.textContent).toContain("1 more sign-in is waiting.")
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click())
    expect(container.textContent).toContain("Fabrikam")
    expect(container.textContent).not.toContain("more sign-in")
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click())
    expect(container.textContent).toBe("")
  })

  it("clears stale prompts for the account that signed in and keeps other tenants queued", () => {
    const container = mount()
    act(() => {
      state.listener!(event("tenant-a"))
      state.listener!({ ...event("tenant-a"), scope: "storage" })
      state.listener!(event("tenant-b"))
      state.accountChanged?.("TENANT-A")
    })
    expect(container.textContent).toContain("Fabrikam")
    expect(container.textContent).not.toContain("more sign-in")
    expect(container.textContent).not.toContain("Contoso")
  })

  it("recovers a Start now session for the scheduled backup prompt and keeps later prompts", async () => {
    state.reauthenticate.mockClear().mockResolvedValueOnce({ error: {
      code: "browser_sign_in_required", message: "Sign in to Microsoft in your browser first, then try again.",
    } })
    const container = mount()
    const scheduled = { ...event("tenant-a"), clientId: GRAPH_CLI_CLIENT_ID }
    act(() => {
      state.listener!(scheduled)
      state.listener!(event("tenant-b"))
    })
    const click = (label: string) => act(async () => {
      [...container.querySelectorAll("button")].find(button => button.textContent === label)!.click()
    })
    await click("Sign in")
    expect(container.textContent).toContain("Sign in to Microsoft in your browser first, then try again.")
    await click("Open Microsoft sign-in")
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith("https://intune.microsoft.com")
    expect(state.reauthenticate).toHaveBeenCalledExactlyOnceWith(scheduled.tenantId, GRAPH_CLI_CLIENT_ID, scheduled.scope)
    await click("Try again")
    expect(state.reauthenticate).toHaveBeenCalledTimes(2)
    expect(state.reauthenticate).toHaveBeenLastCalledWith(scheduled.tenantId, GRAPH_CLI_CLIENT_ID, scheduled.scope)
    expect(container.textContent).toContain("Fabrikam")
    expect(container.textContent).not.toContain("Open Microsoft sign-in")
  })

  it("keeps later prompts after signing in to the first tenant", async () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    vi.stubGlobal("location", { ...window.location, reload })
    const container = mount()
    act(() => {
      state.listener!(event("tenant-a"))
      state.listener!(event("tenant-b"))
    })
    const signIn = () => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Sign in"))!
    await act(async () => { signIn().click() })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(reload).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Fabrikam")
    await act(async () => { signIn().click() })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
