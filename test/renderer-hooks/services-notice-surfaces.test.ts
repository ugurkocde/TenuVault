import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, expect, it, vi } from "vitest"
import { healthScene, HEALTH_TENANT } from "../fixtures/services-health"
import type { Tenant } from "../../src/portal/contexts/TenantContext"

const mocks = vi.hoisted(() => ({ report: vi.fn() }))
const tenant = {
  id: 1, name: "Contoso", domain: "contoso.onmicrosoft.com", status: "healthy", tags: [], configCount: 0, users: 0, devices: 0, policies: { compliance: 0, configuration: 0, apps: 0 },
  credentials: { tenantId: HEALTH_TENANT, appId: "app", clientSecret: "" },
  resources: { storageAccountName: "tvlocal-tenant" },
} as unknown as Tenant
vi.mock("@desktop/lib/bridge", () => ({ bridge: { health: { report: mocks.report, onChanged: () => () => {} }, auth: { accounts: async () => [] } } }))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => [tenant],
  useSelectedTenant: () => ({ selectedTenant: tenant, setSelectedTenantId: vi.fn() }),
  useTenantOperations: () => ({ addTenant: vi.fn(), deleteTenant: vi.fn(), getTenant: () => tenant, updateTenant: vi.fn() }),
  useTenantAzureSync: () => ({ loadTenantFromAzure: vi.fn(), syncTenantToAzureDirect: vi.fn() }),
}))
vi.mock("~/contexts/BackupProgressContext", () => ({ useBackupProgress: () => ({ addJob: vi.fn(), activeJobs: [] }) }))
vi.mock("@desktop/lib/schedules", () => ({
  useSchedules: () => ({ schedules: [{ tenantId: HEALTH_TENANT, enabled: true, nextRunAt: "2026-11-16T02:00:00Z" }], error: null, reload: vi.fn() }),
  describeSchedule: () => "Daily at 02:00", formatWhen: () => "Tomorrow at 02:00",
}))
vi.mock("@desktop/lib/license", () => ({ useLicense: () => ({ status: null }), tenantLicense: () => null, tenantPlan: () => null, planName: () => "Community" }))
vi.mock("@desktop/lib/local-inventory", () => ({ useBackupSettings: () => [null, vi.fn()], useLocalInventoryProblems: () => ({ affected: [], checking: false }), localTenantIds: () => [] }))
vi.mock("~/hooks/dashboard/useDashboardStats", () => ({ useDashboardStats: () => ({ data: null, isLoading: false }) }))
vi.mock("~/hooks/dashboard/useBaselineScore", () => ({ useBaselineScore: () => ({ enabled: false, latest: null }) }))
vi.mock("@desktop/components/TrialOfferCard", () => ({ TrialOfferCard: () => null }))
vi.mock("@desktop/components/RunBackupDialog", () => ({ RunBackupDialog: () => null }))
vi.mock("@desktop/components/RecoveryKeyNotice", () => ({ RecoveryKeyNotice: () => null }))
vi.mock("@desktop/components/UnreadableBackupsNotice", () => ({ UnreadableBackupsNotice: () => null }))
vi.mock("@desktop/components/PlanGate", () => ({ GatedButton: () => null }))
vi.mock("@desktop/components/UpgradeNote", () => ({ PlanBadge: () => null }))
vi.mock("~/components/tenants/backup-progress-modal", () => ({ BackupProgressModal: () => null }))
vi.mock("~/components/tenants/add-tenant-modal-redesigned", () => ({ AddTenantModal: () => null }))
vi.mock("~/components/tenants/tag-management-modal", () => ({ TagManagementModal: () => null }))

import OverviewPage from "../../src/renderer/pages/OverviewPage"
import DashboardPage from "../../src/portal/app/portal/dashboard/page"
import TenantsPage from "../../src/portal/app/portal/tenants/page"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
afterEach(() => { if (root) act(() => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })
it.each([["Overview", OverviewPage], ["Dashboard", DashboardPage], ["Tenant summaries", TenantsPage]] as const)("shows Intune excluded beside the schedule on %s", async (name, Page) => {
  mocks.report.mockResolvedValue(healthScene("intune-off"))
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})))
  const container = document.body.appendChild(document.createElement("div"))
  root = createRoot(container)
  await act(async () => { root.render(createElement(MemoryRouter, null, createElement(Page))) })
  const surface = name === "Dashboard" ? container.querySelector('[aria-label="Next Backup"]')! : container
  expect(surface.textContent).toContain("Intune is off.")
  expect(surface.textContent).toContain("New manual and scheduled backups leave out Intune.")
  expect(surface.textContent).toContain("Tomorrow at 02:00")
  expect(surface.querySelector('a[href="/portal/settings?section=services"]')).not.toBeNull()
})

it("keeps the Intune exclusion visible in tenant summary list view", async () => {
  mocks.report.mockResolvedValue(healthScene("intune-off"))
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})))
  const container = document.body.appendChild(document.createElement("div"))
  root = createRoot(container)
  await act(async () => root.render(createElement(MemoryRouter, null, createElement(TenantsPage))))
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click())
  const row = container.querySelector('[data-tenant-row="1"]')!
  expect(row.textContent).toContain("Intune is off.")
  expect(row.textContent).toContain("New manual and scheduled backups leave out Intune.")
  expect(row.querySelector('a[href="/portal/settings?section=services"]')).not.toBeNull()
})
