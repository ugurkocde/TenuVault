import type { LicenseStatus, TenantLicenseStatus } from "../../src/shared/ipc"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TENANT = "11111111-1111-1111-1111-111111111111"
const state = vi.hoisted(() => ({ accounts: vi.fn(), status: null as LicenseStatus | null }))

vi.mock("@desktop/lib/bridge", () => ({ bridge: { auth: { accounts: state.accounts } } }))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => [{ id: 1, name: "Contoso", domain: "contoso.onmicrosoft.com", lastBackup: "", credentials: { tenantId: TENANT, appId: "app" }, resources: { storageAccountName: "tvlocal-a" } }],
  useSelectedTenant: () => ({ selectedTenant: { id: 1, name: "Contoso", domain: "contoso.onmicrosoft.com", credentials: { tenantId: TENANT } }, setSelectedTenantId: vi.fn() }),
}))
vi.mock("~/contexts/BackupProgressContext", () => ({ useBackupProgress: () => ({ addJob: vi.fn() }) }))
vi.mock("@desktop/lib/schedules", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/schedules")>()),
  useSchedules: () => ({ schedules: [], error: null, loading: false, reload: () => undefined }),
}))
vi.mock("@desktop/lib/license", async original => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: state.status }),
}))

vi.mock("@desktop/components/RunBackupDialog", () => ({ RunBackupDialog: () => null }))
vi.mock("@desktop/components/RecoveryKeyNotice", () => ({ RecoveryKeyNotice: () => null }))
vi.mock("@desktop/components/UnreadableBackupsNotice", () => ({ UnreadableBackupsNotice: () => null }))
vi.mock("@desktop/lib/local-inventory", () => ({
  useBackupSettings: () => [null, vi.fn()],
  useLocalInventoryProblems: () => ({ affected: [], checking: false }),
  localTenantIds: () => [],
}))

import { TenantSwitcher } from "../../src/renderer/components/TenantSwitcher"
import OverviewPage from "../../src/renderer/pages/OverviewPage"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  state.accounts.mockReset()
  state.status = null
})

describe("Overview sign-in load failure", () => {
  it("shows the failure with a retry instead of reporting every tenant signed out", async () => {
    state.accounts
      .mockRejectedValueOnce(new Error("accounts IPC down"))
      .mockResolvedValue([{ tenantId: TENANT, clientId: "app", username: "admin@contoso.com" }])
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(MemoryRouter, null, createElement(OverviewPage))))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    const alerts = [...container.querySelectorAll('[role="alert"]')].map((node) => node.textContent).join(" ")
    expect(alerts).toContain("accounts IPC down")
    expect(container.textContent).toContain("Sign-in unknown")
    // The Signed in summary tile withholds its count instead of showing zero.
    expect(container.textContent).toContain("Signed inUnknown")
    expect(container.textContent).not.toContain("Not signed in")
    expect(container.textContent).not.toContain("No administrator signed in")

    const retry = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes("Try again"))!
    await act(async () => { retry.click() })
    expect(container.textContent).toContain("Signed in")
    expect(container.textContent).toContain("admin@contoso.com")
  })
})


const trialTenant: TenantLicenseStatus = { tenantId: TENANT, signedIn: true, activated: true, entitled: true, source: "trial", plan: "pro", tenants: 2, expiresAt: "2026-12-01T00:00:00Z", validUntil: "2026-12-01T00:00:00Z", trialEndsAt: "2026-12-01T00:00:00Z", trial: true, shared: null, shareNeedsSignIn: false, displayKey: null, message: null }
describe("Overview tenant license labels", () => {
  it.each(["trial", "community", "unlicensed", "pending"])("renders %s coverage without a stale paid expiry", async kind => {
    const tenant = kind === "trial" ? trialTenant : { ...trialTenant, entitled: false, activated: false, trial: false, source: null, plan: kind === "community" || kind === "pending" ? "community" as const : null }
    state.status = { hasKey: false, keyState: "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan: kind === "trial" ? "pro" : null, tenantLimit: 2, validUntil: null, communityTenantId: kind === "community" ? TENANT : null, communityChoicePendingTenantIds: kind === "pending" ? [TENANT, "second"] : [], tenants: [tenant] }
    state.accounts.mockResolvedValue([{ tenantId: TENANT, username: "admin@contoso.example" }])
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container); roots.push(root)
    await act(async () => { root.render(createElement(MemoryRouter, null, createElement(OverviewPage))) })
    expect(container.textContent).not.toContain("Valid until")
    if (kind === "trial") { expect(container.textContent).toContain("Pro trial"); expect(container.textContent).toContain("Trial ends"); expect(container.textContent).not.toContain("Licensed, Pro") }
    else if (kind === "pending") expect(container.textContent).not.toContain("Community (free)")
  })
  it("labels the selected trial and its tooltip in the tenant switcher", async () => {
    state.status = { hasKey: false, keyState: "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan: "pro", tenantLimit: 2, validUntil: null, communityTenantId: null, tenants: [trialTenant] }
    const container = document.createElement("div"); document.body.append(container)
    const root = createRoot(container); roots.push(root)
    await act(async () => { root.render(createElement(MemoryRouter, null, createElement(TenantSwitcher))) })
    const trigger = container.querySelector('button[aria-label^="Switch tenant"]')!
    expect(trigger.textContent).toContain("Pro trial")
    expect(trigger.getAttribute("title")).toContain("Pro trial")
    expect(trigger.getAttribute("aria-label")).toContain("Pro trial")
  })

})
