import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { AppRestoreReview, CapturedAppSource } from "../../src/shared/app-sources/types"
import type { LicenseStatus, TenantLicenseStatus } from "../../src/shared/ipc"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The source is the tenant selected in the sidebar; the plan prompt of the restore dialog must act on the destination.
const source = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", destination = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
const api = vi.hoisted(() => ({ restoreReview: vi.fn(), accounts: vi.fn(), startTenantTrial: vi.fn(), cancel: vi.fn(), restoreProgress: vi.fn(), cancelDeviceSignIn: vi.fn(), open: vi.fn() }))
const license = vi.hoisted(() => ({ status: null as LicenseStatus | null }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { appSources: api, auth: api, license: api, app: api } }))
vi.mock("../../src/renderer/lib/disclaimer", () => ({ requestAcknowledgement: vi.fn() }))
vi.mock("../../src/renderer/lib/license", async importOriginal => ({ ...await importOriginal<typeof import("../../src/renderer/lib/license")>(), useLicense: () => ({ status: license.status, signedInTenantIds: undefined, refresh: async () => undefined }) }))
import { TenantProvider } from "../../src/portal/contexts/TenantContext"
import { RestoreAppDialog } from "../../src/renderer/features/app-backup/RestoreAppDialog"

const captured = { id: "33333333-3333-3333-3333-333333333333", appName: "Finance" } as CapturedAppSource
const review: AppRestoreReview = { settingsHash: "a".repeat(64), observedAt: "2026-11-14T12:00:00Z", currentSettings: false, name: "Finance", version: "1", publisher: "Example", installCommand: "setup.exe", uninstallCommand: "setup.exe /uninstall", runAs: "system", detectionRules: 1, requirementRules: 0, blocker: null }
// Signed in, not licensed and not activated: a trial is offered unless it was refused for good.
const tenantStatus = (tenantId: string, trialUsed: boolean) => ({ tenantId, signedIn: true, activated: false, entitled: false, source: null, plan: null, trialRefusalPermanent: trialUsed, trialRefusal: trialUsed ? "This tenant already had a Pro trial." : undefined }) as unknown as TenantLicenseStatus
let root: Root | undefined
beforeEach(() => {
  api.restoreReview.mockResolvedValue(review); api.accounts.mockResolvedValue([{ tenantId: source }, { tenantId: destination }]); api.startTenantTrial.mockResolvedValue(undefined)
  sessionStorage.setItem("tenuvault_tenants", JSON.stringify([{ id: 1, name: "Source", credentials: { tenantId: source.toUpperCase(), appId: source }, tags: [] }, { id: 2, name: "Destination", credentials: { tenantId: destination, appId: destination }, tags: [] }]))
  sessionStorage.setItem("tenuvault_selected_tenant", "1")
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; sessionStorage.clear(); vi.resetAllMocks() })

async function mount() {
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root!.render(createElement(TenantProvider, null, createElement(RestoreAppDialog, { tenant: source.toUpperCase(), source: captured, onClose: vi.fn(), onBusy: vi.fn() }))))
  const select = document.querySelector("select")!
  await act(async () => { select.value = destination; select.dispatchEvent(new Event("change", { bubbles: true })) })
}
const trialButton = () => [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === "Try Pro free")

it("offers and starts the trial of the destination when only the destination can start one", async () => {
  license.status = { hasKey: false, plan: null, tenantTrialsEnabled: true, tenants: [tenantStatus(source, true), tenantStatus(destination, false)] } as unknown as LicenseStatus
  await mount()
  expect(document.body.textContent).toContain("Restoring into another tenant is included in TenuVault Pro and MSP for that tenant.")
  expect(trialButton()).toBeDefined()
  await act(async () => trialButton()!.click())
  expect(api.startTenantTrial).toHaveBeenCalledExactlyOnceWith(destination)
})

it("does not offer the source tenant's trial when the destination cannot start one", async () => {
  license.status = { hasKey: false, plan: null, tenantTrialsEnabled: true, tenants: [tenantStatus(source, false), tenantStatus(destination, true)] } as unknown as LicenseStatus
  await mount()
  expect(document.body.textContent).toContain("Restoring into another tenant is included in TenuVault Pro and MSP for that tenant.")
  expect(trialButton()).toBeUndefined()
  expect(api.startTenantTrial).not.toHaveBeenCalled()
})
