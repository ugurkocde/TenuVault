import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Tenant } from "../../src/portal/contexts/TenantContext"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tenant: Tenant = {
  id: 1, name: "Contoso", domain: "contoso.onmicrosoft.com", status: "active", lastBackup: "", configCount: 0, storageUsed: "", client: "", license: "", region: "",
  tags: [], users: 0, devices: 0, complianceRate: 0, industry: "", environment: "", lastSync: "", syncStatus: "idle", policies: { compliance: 0, configuration: 0, apps: 0 },
  credentials: { tenantId: "tenant", appId: "app", clientSecret: "" },
  resources: { subscriptionId: "local", subscriptionName: "local", resourceGroupName: "local", storageAccountName: "tvlocal-tenant", automationAccountName: "" } as Tenant["resources"],
}

const licenseStatus = vi.hoisted(() => ({ current: null as unknown }))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => [tenant],
  useTenantOperations: () => ({ addTenant: vi.fn(), deleteTenant: vi.fn(), getTenant: () => tenant, updateTenant: vi.fn() }),
  useTenantAzureSync: () => ({ loadTenantFromAzure: vi.fn(), syncTenantToAzureDirect: vi.fn() }),
}))
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }))
vi.mock("@desktop/lib/bridge", () => ({ bridge: { license: { open: async () => undefined } } }))
vi.mock("@desktop/lib/schedules", () => ({ useSchedules: () => ({ schedules: [], error: null, loading: false, reload: () => undefined }), formatWhen: () => "" }))
vi.mock("@desktop/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: licenseStatus.current, error: null, refresh: async () => undefined }),
}))
vi.mock("@desktop/components/RunBackupDialog", () => ({ RunBackupDialog: () => null }))
vi.mock("~/components/tenants/backup-progress-modal", () => ({ BackupProgressModal: () => null }))
vi.mock("~/components/tenants/add-tenant-modal-redesigned", () => ({ AddTenantModal: () => null }))
vi.mock("~/components/tenants/tag-management-modal", () => ({ TagManagementModal: () => null }))

import TenantsPage from "../../src/portal/app/portal/tenants/page"
import { BackupProgressProvider } from "../../src/portal/contexts/BackupProgressContext"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  licenseStatus.current = null
  vi.unstubAllGlobals()
})

function statusFor(plan: "community" | "pro" | "msp") {
  const paid = plan !== "community"
  const entry = { tenantId: "tenant", signedIn: true, activated: paid, entitled: paid, source: paid ? "key" : null, plan, tenants: paid ? 2 : null, expiresAt: paid ? "2030-01-01T00:00:00.000Z" : null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null }
  return { hasKey: paid, keyState: paid ? "active" : "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan: paid ? plan : null, tenantLimit: paid ? 2 : null, validUntil: null, communityTenantId: paid ? null : "tenant", tenants: [entry] }
}

async function renderPage(): Promise<HTMLElement> {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})))
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(createElement(BackupProgressProvider, null, createElement(TenantsPage))))
  return container
}

const selectionHelp = (container: HTMLElement) => container.querySelector("[data-selection-bar] [aria-live]")!.textContent

describe("Tenants page plan hints", () => {
  it("names MSP next to the bulk selection help for plans without actions across several tenants", async () => {
    for (const plan of ["community", "pro"] as const) {
      licenseStatus.current = statusFor(plan)
      expect(selectionHelp(await renderPage()), plan).toBe("Select tenants to back up or tag several at onceBacking up several at onceMSP")
      document.body.replaceChildren()
    }
  })

  it("shows no hint on MSP or while the plan is not known", async () => {
    for (const status of [statusFor("msp"), null]) {
      licenseStatus.current = status
      expect(selectionHelp(await renderPage())).toBe("Select tenants to back up or tag several at once")
      document.body.replaceChildren()
    }
  })

  it("keeps selecting and tagging available to Community", async () => {
    licenseStatus.current = statusFor("community")
    const container = await renderPage()
    const selectAll = container.querySelector<HTMLButtonElement>('button[aria-label="Select all matching tenants"]')!
    expect(selectAll.disabled).toBe(false)
    await act(async () => selectAll.click())
    const tag = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Tag Selected")!
    expect(tag.disabled).toBe(false)
    expect(tag.getAttribute("aria-disabled")).toBeNull()
  })

  it("explains drift Check all with the feature the server enforces for it", async () => {
    licenseStatus.current = statusFor("pro")
    const container = await renderPage()
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click())
    const checkAll = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.startsWith("Check all"))!
    expect(checkAll.textContent).toBe("Check allMSP")
    expect(checkAll.title).toBe("Actions across several tenants: included in TenuVault MSP. Upgrade on the License page.")
    await act(async () => checkAll.click())
    expect(document.body.textContent).toContain("Actions across several tenants: included in TenuVault MSP.")
  })
})
