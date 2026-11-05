import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
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

import { PurchaseKeyWatcher } from "../../src/renderer/components/PurchaseKeyWatcher"
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

function mount() {
  const root = createRoot(document.createElement("div"))
  roots.push(root)
  act(() => root.render(createElement(PurchaseKeyWatcher)))
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
    await act(async () => { await openCheckout("trial-day-27", { status: trial }) })
    expect(state.open).toHaveBeenCalledWith("checkout", { source: "trial-day-27", interval: "yearly" })
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

  it("saves the key when none is saved, and says why a key was refused", async () => {
    state.status = { ...trial, hasKey: false, trial: false, plan: null }
    state.clipboard = "TENU-PAID-0002"
    state.setKey.mockRejectedValue(new Error("This license key was not found."))
    mount()
    await act(async () => { await openCheckout("license-page") })
    expect(state.open).toHaveBeenCalledWith("checkout", { source: "license-page" })
    await focus()
    expect(state.setKey).toHaveBeenCalledWith("TENU-PAID-0002")
    expect(state.toast).toHaveBeenCalledWith("This license key was not found.", "error")
  })
})
