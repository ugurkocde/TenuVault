import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LicenseStatus } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  open: vi.fn(async () => undefined),
  startTrial: vi.fn(async () => undefined),
  deactivate: vi.fn(async () => undefined),
  setKey: vi.fn(async () => undefined),
  replaceKey: vi.fn(async () => undefined),
  openExternal: vi.fn(async () => undefined),
  clipboardKey: vi.fn(async (): Promise<string | null> => null),
  status: null as LicenseStatus | null,
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    license: {
      refresh: async () => undefined,
      open: state.open,
      startTrial: state.startTrial,
      deactivate: state.deactivate,
      setKey: state.setKey,
      replaceKey: state.replaceKey,
      clipboardKey: state.clipboardKey,
      status: async () => state.status,
    },
    app: { openExternal: state.openExternal },
  },
}))
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: state.status, error: null, refresh: async () => undefined }),
}))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [] }))
vi.mock("~/components/ConfirmDialog", () => ({ useConfirm: () => ({ confirm: async () => true, confirmDialog: null }) }))
vi.mock("@desktop/components/LicenseAgreementDialog", () => ({ LicenseAgreementLink: () => null }))

import LicensePage from "../../src/renderer/pages/LicensePage"

const community: LicenseStatus = {
  hasKey: false, keyState: "none", keyMessage: null, keyHint: null, persisted: true,
  offline: false, message: null, plan: null, tenantLimit: null, validUntil: null, trial: false,
  communityTenantId: null, tenants: [],
}

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  vi.clearAllMocks()
})

async function render(status: LicenseStatus) {
  state.status = status
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MemoryRouter, null, createElement(LicensePage))))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return container
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("License page trial", () => {
  it("starts the no-card trial in the app and keeps Buy now secondary", async () => {
    const container = await render(community)
    expect(container.textContent).toContain("Try Pro free for 30 days, no card needed.")
    expect(container.textContent).not.toContain("on request")
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!
    type(email, "admin@contoso.com")
    await act(async () => { button(container, "Start free trial")!.click() })
    expect(state.startTrial).toHaveBeenCalledWith("admin@contoso.com", { source: "license-page" })
    expect(container.textContent).toContain("Check your inbox at admin@contoso.com")
    expect(container.textContent).toContain("Copy the key from your email and return to TenuVault: it activates by itself.")

    await act(async () => { button(container, "Buy now")!.click() })
    expect(state.open).toHaveBeenCalledWith("checkout", { source: "license-page" })
  })

  it("activates a trial key copied from the email when TenuVault gets focus", async () => {
    const container = await render(community)
    // Before a trial was requested the clipboard is never read.
    await act(async () => { window.dispatchEvent(new Event("focus")) })
    expect(state.clipboardKey).not.toHaveBeenCalled()

    type(container.querySelector<HTMLInputElement>('input[type="email"]')!, "admin@contoso.com")
    await act(async () => { button(container, "Start free trial")!.click() })
    state.clipboardKey.mockResolvedValueOnce("TENU-TRIAL-KEY-0001")
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(state.setKey).toHaveBeenCalledWith("TENU-TRIAL-KEY-0001")
  })

  it("offers an invoice for buyers who cannot pay by card", async () => {
    for (const status of [
      community,
      { ...community, hasKey: true, keyState: "active" as const, plan: "pro" as const, tenantLimit: 2, trial: true, trialEndsAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
      { ...community, hasKey: true, keyState: "failed" as const },
    ]) {
      const container = await render(status)
      expect(container.textContent).toContain("Need an invoice instead of a card?")
      const link = container.querySelector<HTMLAnchorElement>('a[href^="mailto:support@tenuvault.com"]')!
      expect(link.textContent).toBe("support@tenuvault.com")
      await act(async () => { link.click() })
      expect(state.openExternal).toHaveBeenLastCalledWith("mailto:support@tenuvault.com?subject=TenuVault%20invoice%20or%20quote%20request")
      for (const root of roots.splice(0)) act(() => root.unmount())
      document.body.innerHTML = ""
    }
  })

  it("shows when the trial ends and buys Pro without another trial", async () => {
    const validUntil = new Date(Date.now() + 9.5 * 24 * 60 * 60_000).toISOString()
    const container = await render({ ...community, hasKey: true, keyState: "active", keyHint: "****ABCD", plan: "pro", tenantLimit: 2, trialEndsAt: validUntil, trial: true })
    expect(container.textContent).toContain("Pro trial active")
    expect(container.textContent).toContain("in 10 days")
    expect(container.querySelector('input[type="email"]')).toBeNull()
    await act(async () => { button(container, "Buy Pro")!.click() })
    expect(state.open).toHaveBeenCalledWith("checkout", { source: "license-page-trial" })
  })

  it("offers the key swap for a saved key that is no longer active", async () => {
    const container = await render({ ...community, hasKey: true, keyState: "failed", keyHint: "****ABCD", keyMessage: "This license key has expired." })
    expect(container.textContent).toContain("Your saved key is not active")
    await act(async () => { button(container, "Enter a new key")!.click() })
    type(container.querySelector<HTMLInputElement>("#replacement-key")!, "TENU-PAID-0001")
    await act(async () => { button(container, "Use this key")!.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(state.replaceKey).toHaveBeenCalledWith("TENU-PAID-0001")
    expect(state.deactivate).not.toHaveBeenCalled()
  })

  it("swaps the trial key for the paid key", async () => {
    const validUntil = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString()
    const container = await render({ ...community, hasKey: true, keyState: "active", keyHint: "****ABCD", plan: "pro", tenantLimit: 2, trialEndsAt: validUntil, trial: true })
    await act(async () => { button(container, "Enter your new key")!.click() })
    type(container.querySelector<HTMLInputElement>("#replacement-key")!, "TENU-PAID-0001")
    await act(async () => { button(container, "Use this key")!.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    // One call in the main process keeps the trial key until the new key is accepted.
    expect(state.replaceKey).toHaveBeenCalledWith("TENU-PAID-0001")
    expect(state.deactivate).not.toHaveBeenCalled()
    expect(state.setKey).not.toHaveBeenCalled()
  })
})
