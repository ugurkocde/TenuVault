import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LicenseStatus } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({ open: vi.fn(async () => undefined), status: null as LicenseStatus | null }))

vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { license: { open: state.open } } }))
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: state.status, error: null, refresh: async () => undefined }),
}))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [] }))

import { PlanDialogs } from "../../src/renderer/components/PlanDialogs"
import { closePlanDialog, showCommunityLimitError } from "../../src/renderer/lib/plan-dialog"
import { CommunityLimitError } from "../../src/shared/plan-errors"

const community: LicenseStatus = {
  hasKey: false, keyState: "none", keyMessage: null, keyHint: null, persisted: true,
  offline: false, message: null, plan: null, tenantLimit: null, validUntil: null,
  communityTenantId: "11111111-2222-4333-8444-555555555555", tenants: [],
}

const roots: Root[] = []
afterEach(() => {
  act(() => closePlanDialog())
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  vi.clearAllMocks()
})

function render(status: LicenseStatus) {
  state.status = status
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MemoryRouter, null, createElement(PlanDialogs))))
  act(() => { showCommunityLimitError(new CommunityLimitError("66666666-7777-4888-8999-aaaaaaaaaaaa", "Community covers one tenant.")) })
  return [...document.body.querySelectorAll("button")].map((button) => button.textContent?.trim())
}

describe("second tenant dialog", () => {
  it("offers the no-card trial without a license on this machine", () => {
    expect(render(community)).toContain("Start 30 day free trial")
  })

  it("offers the plans instead when a key or organization license is present", async () => {
    const buttons = render({ ...community, hasKey: true, keyState: "failed" })
    expect(buttons).not.toContain("Start 30 day free trial")
    expect(buttons).toContain("See plans")
    const plans = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === "See plans")!
    await act(async () => { plans.click() })
    expect(state.open).toHaveBeenCalledWith("buy", { source: "second-tenant" })
  })
})
