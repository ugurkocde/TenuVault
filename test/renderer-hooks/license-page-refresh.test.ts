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
  selectedTenantId: undefined as string | undefined,
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    license: { refresh: state.refreshLicenses, open: async () => undefined, status: async () => state.status, trialUsage: async () => null, trialWorkflowsConfigured: async () => false },
    auth: { accounts: async () => [] },
    schedules: { list: async () => [] },
    preferences: { get: async () => ({}), set: async () => ({}) },
  },
}))
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: state.status, error: null, refresh: state.refreshStatus }),
}))
vi.mock("~/contexts/TenantContext", () => ({
  useSelectedTenant: () => ({ selectedTenantId: null, selectedTenant: state.selectedTenantId ? { id: 1, name: "Selected", credentials: { tenantId: state.selectedTenantId } } : undefined, setSelectedTenantId: () => {} }),
  useTenants: () => [],
}))
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
  state.selectedTenantId = undefined
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

it.each([
  ["coverage ended", true, null, true],
  ["paid verification failed", false, "pro", false],
  ["choice pending", true, null, false],
  ["never covered", undefined, null, false],
] as const)("uses the ended-coverage sentence only for %s", async (_label, coverageEnded, plan, shown) => {
  state.status = { ...proStatus, tenants: [{ tenantId: "contoso", signedIn: true, entitled: false, activated: plan === "pro", coverageEnded, plan: null, source: plan === "pro" ? "key" : null, tenants: null, expiresAt: null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null }], communityChoicePendingTenantIds: _label === "choice pending" ? ["contoso", "fabrikam"] : [] }
  state.refreshLicenses.mockResolvedValue(state.status)
  const { container } = renderPage()
  await flush()
  expect(container.textContent?.includes("Backups of this tenant are kept. Add a license to use it again.")).toBe(shown)
})

describe("License page heading", () => {
  const TRIAL_ENDS = new Date(Date.now() + 13.5 * 86_400_000).toISOString()
  const entry = { signedIn: true, activated: true, entitled: true, expiresAt: TRIAL_ENDS, shared: null, shareNeedsSignIn: false, message: null }
  const mixed: LicenseStatus = {
    ...proStatus, hasKey: false, keyState: "none", keyHint: null, trial: true, trialEndsAt: TRIAL_ENDS,
    tenants: [
      { ...entry, tenantId: "t-trial", source: "trial", plan: "pro", tenants: 2, trial: true, trialEndsAt: TRIAL_ENDS, validUntil: TRIAL_ENDS, displayKey: null },
      { ...entry, tenantId: "t-org", source: "tenant", plan: "msp", tenants: 10, validUntil: null, displayKey: "****ABCDEF" },
    ],
  }
  const heading = (container: HTMLElement) => container.querySelector(".text-2xl")?.textContent

  it("describes the selected organization-licensed tenant, not the other tenant's trial", async () => {
    state.status = mixed
    state.refreshLicenses.mockResolvedValue(mixed)
    state.selectedTenantId = "t-org"
    const { container } = renderPage()
    await flush()
    expect(heading(container)).toBe("Licensed through your organization")
    expect(container.textContent).toContain("A tenant admin shared their TenuVault license with your tenant.")
    expect(container.textContent).not.toContain("Your license covers 2 tenants")
  })

  it("describes the trial when the tenant that runs it is selected", async () => {
    state.status = mixed
    state.refreshLicenses.mockResolvedValue(mixed)
    state.selectedTenantId = "t-trial"
    const { container } = renderPage()
    await flush()
    expect(heading(container)).toBe("Pro trial active")
  })
})
