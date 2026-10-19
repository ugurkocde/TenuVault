import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SignInRequiredEvent } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  listener: null as ((event: SignInRequiredEvent) => void) | null,
  reauthenticate: vi.fn(async () => ({ username: "admin@contoso.com" })),
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    auth: {
      onSignInRequired: (listener: (event: SignInRequiredEvent) => void) => {
        state.listener = listener
        return () => { state.listener = null }
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
