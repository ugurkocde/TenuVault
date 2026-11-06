import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LicenseStatus } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  status: null as LicenseStatus | null,
  clipboard: null as string | null,
  open: vi.fn(async () => undefined),
  replaceKey: vi.fn(),
  setKey: vi.fn(),
  toast: vi.fn(),
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    license: {
      open: state.open,
      clipboardKey: async () => state.clipboard,
      replaceKey: state.replaceKey,
      setKey: state.setKey,
    },
  },
}))
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: state.status, error: null, refresh: async () => undefined }),
}))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: state.toast }))

import { PurchaseKeyWatcher, watchesPurchaseKey } from "../../src/renderer/components/PurchaseKeyWatcher"
import { clearCheckout, openCheckout } from "../../src/renderer/lib/purchase"

const trial: LicenseStatus = {
  hasKey: true, keyState: "active", keyMessage: null, keyHint: "****0001", persisted: true,
  offline: false, message: null, plan: "pro", tenantLimit: 2, validUntil: null, trial: true,
  trialEndsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), communityTenantId: null, tenants: [],
}
const active = { ...trial, trial: false, trialEndsAt: null, tenants: [{ entitled: true, source: "key" }] } as unknown as LicenseStatus

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  act(() => clearCheckout())
  vi.clearAllMocks()
})

function mount(path = "/portal/dashboard") {
  const root = createRoot(document.createElement("div"))
  roots.push(root)
  act(() => root.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(PurchaseKeyWatcher))))
}

const focus = async () => {
  await act(async () => {
    window.dispatchEvent(new Event("focus"))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("purchase key pickup", () => {
  it("does nothing until a checkout was opened", async () => {
    state.status = trial
    state.clipboard = "TENU-PAID-0002"
    mount()
    await focus()
    expect(state.replaceKey).not.toHaveBeenCalled()
  })

  it("replaces the trial key with a key copied after the checkout, once", async () => {
    state.status = trial
    state.clipboard = null
    state.replaceKey.mockResolvedValue(active)
    mount()
    await act(async () => { await openCheckout("trial-day-27") })
    expect(state.open).toHaveBeenCalledWith("checkout", { source: "trial-day-27" })
    // Nothing usable copied yet (the main process never returns the saved trial key).
    await focus()
    expect(state.replaceKey).not.toHaveBeenCalled()
    state.clipboard = "TENU-PAID-0002"
    await focus()
    expect(state.replaceKey).toHaveBeenCalledWith("TENU-PAID-0002")
    expect(state.toast).toHaveBeenCalledWith("Your new license is active.", "success")
    await focus()
    expect(state.replaceKey).toHaveBeenCalledTimes(1)
  })

  it("saves the key when none is saved, and stops after a refused key", async () => {
    state.status = { ...trial, hasKey: false, trial: false, plan: null }
    state.clipboard = "TENU-PAID-0002"
    state.setKey.mockRejectedValue(new Error("This license key was not found."))
    mount()
    await act(async () => { await openCheckout("license-page") })
    expect(state.open).toHaveBeenCalledWith("checkout", { source: "license-page" })
    await focus()
    expect(state.setKey).toHaveBeenCalledWith("TENU-PAID-0002")
    expect(state.toast).toHaveBeenCalledWith("This license key was not found. Enter the key on the License page.", "error")
    await focus()
    await focus()
    expect(state.setKey).toHaveBeenCalledTimes(1)
  })

  it("does not try a refused key again on the License page", async () => {
    state.status = { ...trial, trial: false, trialEndsAt: null, trialEndedAt: new Date(Date.now() - 86_400_000).toISOString(), keyState: "failed" }
    state.clipboard = "TENU-PAID-0002"
    state.replaceKey.mockRejectedValue(new Error("Sign in to a tenant to switch to the new license key."))
    mount("/license")
    await focus()
    await focus()
    await focus()
    expect(state.replaceKey).toHaveBeenCalledTimes(1)
  })

  it("opens one checkout for repeated clicks while the first is opening", async () => {
    let finish!: () => void
    state.open.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined) }))
    const first = openCheckout("trial-ended")
    const second = openCheckout("trial-ended")
    finish()
    await act(async () => { await Promise.all([first, second]) })
    expect(state.open).toHaveBeenCalledTimes(1)
  })
})

describe("when a copied key counts as the purchase", () => {
  const HOUR = 3_600_000
  const now = Date.now()
  const none = { ...trial, hasKey: false, trial: false, plan: null }
  const ended = { ...trial, trial: false, trialEndsAt: null, trialEndedAt: new Date(now - HOUR).toISOString() }
  const paid = { ...trial, trial: false, trialEndsAt: null }

  it("watches after a recent checkout, and on the License page while a trial key is saved", () => {
    expect(watchesPurchaseKey(trial, now - HOUR, "/portal/dashboard", now)).toBe(true)
    expect(watchesPurchaseKey(trial, now - 7 * HOUR, "/portal/dashboard", now)).toBe(false)
    expect(watchesPurchaseKey(ended, null, "/license", now)).toBe(true)
    expect(watchesPurchaseKey(ended, null, "/portal/dashboard", now)).toBe(false)
  })

  it("never swaps a paid key, and leaves the License page to its own check without a key", () => {
    expect(watchesPurchaseKey(paid, now - HOUR, "/portal/dashboard", now)).toBe(false)
    expect(watchesPurchaseKey(paid, now - HOUR, "/license", now)).toBe(false)
    expect(watchesPurchaseKey(none, now - HOUR, "/portal/dashboard", now)).toBe(true)
    expect(watchesPurchaseKey(none, now - HOUR, "/license", now)).toBe(false)
    expect(watchesPurchaseKey(null, now - HOUR, "/license", now)).toBe(false)
  })
})
