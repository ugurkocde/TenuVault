import { act, createElement } from "react"
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

const roots: Root[] = []
const containers: HTMLDivElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  vi.clearAllMocks()
})

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function renderPage(): HTMLDivElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MemoryRouter, null, createElement(LicensePage))))
  return container
}

describe("License page license check on open", () => {
  it("asks the licensing service for fresh entitlements once when the page opens", async () => {
    state.status = proStatus
    state.refreshLicenses.mockResolvedValue(proStatus)
    renderPage()
    await flush()
    await flush()
    expect(state.refreshLicenses).toHaveBeenCalledTimes(1)
  })

  it("keeps showing the cached status when the check on open fails", async () => {
    state.status = proStatus
    state.refreshLicenses.mockRejectedValue(new Error("The licensing service could not be reached."))
    const container = renderPage()
    await flush()
    expect(state.refreshLicenses).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("Your license covers 2 tenants")
  })
})
