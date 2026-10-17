import { act, createElement, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LicenseStatus } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  refreshLicenses: vi.fn(),
  refreshStatus: vi.fn(async () => undefined),
  status: null as LicenseStatus | null,
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: { license: { refresh: state.refreshLicenses, open: async () => undefined, status: async () => state.status } },
}))
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: state.status, error: null, refresh: state.refreshStatus }),
}))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [] }))
vi.mock("~/components/ConfirmDialog", () => ({ useConfirm: () => ({ confirm: async () => true, confirmDialog: null }) }))
vi.mock("@desktop/components/LicenseAgreementDialog", () => ({ LicenseAgreementLink: () => null }))

import LicensePage from "../../src/renderer/pages/LicensePage"

const proStatus: LicenseStatus = {
  hasKey: true, keyState: "active", keyMessage: null, keyHint: "****ABCD", persisted: true,
  offline: false, message: null, plan: "pro", tenantLimit: 2, validUntil: null,
  communityTenantId: null, tenants: [],
}
const mspStatus: LicenseStatus = { ...proStatus, plan: "msp", tenantLimit: 5 }

const roots: Root[] = []
const containers: HTMLDivElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  vi.clearAllMocks()
  state.refreshStatus = vi.fn(async () => undefined)
})

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function renderPage(): { container: HTMLDivElement; rerender: () => void } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  const rerender = () => act(() => root.render(createElement(StrictMode, null, createElement(MemoryRouter, null, createElement(LicensePage)))))
  rerender()
  return { container, rerender }
}

describe("License page license check on open", () => {
  it("asks the licensing service once per open, even when the effect reruns", async () => {
    state.status = proStatus
    state.refreshLicenses.mockResolvedValue(proStatus)
    const { rerender } = renderPage()
    await flush()
    // A new refresh identity reruns the effect, as a provider remount would. The guard
    // must keep the service check to one call per page open.
    state.refreshStatus = vi.fn(async () => undefined)
    rerender()
    await flush()
    expect(state.refreshLicenses).toHaveBeenCalledTimes(1)
  })

  it("shows the plan the check on open delivers", async () => {
    state.status = proStatus
    let deliver: (status: LicenseStatus) => void = () => undefined
    state.refreshLicenses.mockImplementation(() => new Promise<LicenseStatus>((resolve) => { deliver = resolve }))
    const { container, rerender } = renderPage()
    await flush()
    expect(state.refreshLicenses).toHaveBeenCalledTimes(1)
    const readsBeforeDelivery = state.refreshStatus.mock.calls.length
    deliver(mspStatus)
    await flush()
    // Resolving the service check makes the page re-read the status exactly once more.
    // Publishing that status the way the real provider does must update the render.
    expect(state.refreshStatus.mock.calls.length).toBe(readsBeforeDelivery + 1)
    state.status = mspStatus
    rerender()
    expect(container.textContent).toContain("Your license covers 5 tenants")
  })

  it("keeps showing the cached status and no error when the check on open rejects", async () => {
    state.status = proStatus
    state.refreshLicenses.mockRejectedValue(new Error("The licensing service could not be reached."))
    const { container } = renderPage()
    await flush()
    expect(state.refreshLicenses).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("Your license covers 2 tenants")
    expect(container.textContent).not.toContain("could not be reached")
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it("keeps the cached plan and shows the offline notice when the service is unreachable", async () => {
    state.status = proStatus
    const offlineStatus = { ...proStatus, offline: true }
    state.refreshLicenses.mockResolvedValue(offlineStatus)
    const { container, rerender } = renderPage()
    await flush()
    state.status = offlineStatus
    rerender()
    expect(container.textContent).toContain("Your license covers 2 tenants")
    expect(container.textContent).toContain("The licensing service could not be reached. Tenants that are already active keep working")
  })
})
