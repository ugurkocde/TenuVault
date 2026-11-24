import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import { healthScene, HEALTH_TENANT } from "../fixtures/services-health"
import type { Tenant } from "../../src/portal/contexts/TenantContext"

import type { DashboardBackup, TenantDashboardStats } from "../../src/portal/hooks/dashboard/useDashboardStats"
import { GRAPH_CLI_CLIENT_ID } from "../../src/shared/tenant-connection"

const mocks = vi.hoisted(() => ({ report: vi.fn(), stats: null as TenantDashboardStats | null, scheduled: true }))
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
  useSchedules: () => ({ schedules: [{ tenantId: HEALTH_TENANT, enabled: mocks.scheduled, nextRunAt: "2026-11-16T02:00:00Z" }], error: null, reload: vi.fn() }),
  describeSchedule: () => "Daily at 02:00", formatWhen: () => "Tomorrow at 02:00",
}))
vi.mock("@desktop/lib/license", () => ({ useLicense: () => ({ status: null }), tenantLicense: () => null, tenantPlan: () => null, planName: () => "Community" }))
vi.mock("@desktop/lib/local-inventory", () => ({ useBackupSettings: () => [null, vi.fn()], useLocalInventoryProblems: () => ({ affected: [], checking: false }), localTenantIds: () => [] }))
vi.mock("~/hooks/dashboard/useDashboardStats", () => ({ useDashboardStats: () => ({ data: mocks.stats, isLoading: false }) }))
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
afterEach(() => { if (root) act(() => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); localStorage.clear(); mocks.stats = null; mocks.scheduled = true; tenant.credentials!.appId = "app" })
it.each([["Overview", OverviewPage], ["Dashboard", DashboardPage], ["Tenant summaries", TenantsPage]] as const)("shows Intune excluded beside the schedule on %s", async (name, Page) => {
  mocks.report.mockResolvedValue(healthScene("intune-off"))
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})))
  const container = document.body.appendChild(document.createElement("div"))
  root = createRoot(container)
  await act(async () => { root.render(createElement(MemoryRouter, null, createElement(Page))) })
  const surface = name === "Dashboard" ? container.querySelector('[aria-label="Next Backup"]')! : container
  expect(surface.textContent).toContain("Intune is off for new backups.")
  expect(surface.textContent).toContain("New manual and scheduled backups leave out Intune.")
  expect(surface.textContent).toContain("Tomorrow at 02:00")
  expect(surface.querySelector('a[href^="/portal/settings?section=services"]')).not.toBeNull()
})

it("keeps the Intune exclusion visible in tenant summary list view", async () => {
  mocks.report.mockResolvedValue(healthScene("intune-off"))
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})))
  const container = document.body.appendChild(document.createElement("div"))
  root = createRoot(container)
  await act(async () => root.render(createElement(MemoryRouter, null, createElement(TenantsPage))))
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click())
  const row = container.querySelector('[data-tenant-row="1"]')!
  expect(row.textContent).toContain("Intune is off for new backups.")
  expect(row.textContent).toContain("New manual and scheduled backups leave out Intune.")
  expect(row.querySelector('a[href^="/portal/settings?section=services"]')).not.toBeNull()
})

describe("first-run Dashboard", () => {
  const date = new Date()
  const first = {
    id: "backup-first", tenantId: 1, tenantName: "Contoso", timestamp: date,
    policiesBackedUp: 214, capturedServices: ["intune", "entra"], status: "success",
    duration: 3, size: 123, coverageIncomplete: true, needsAccess: true,
  } as DashboardBackup
  const stats: TenantDashboardStats = {
    tenants: { total: 1, healthy: 1, warning: 0, critical: 0 },
    backups: { scheduled: 0, trend: 0 },
    nextBackup: null, recentActivity: [], latestBackup: first, latestCompleteBackup: first,
    backupHistory: [first], failedAttempts: [], liveRuns: [], periodStart: new Date(0),
    backupsError: null, lastDriftCheck: null,
  }
  const mount = async (container: HTMLElement, key: string) => {
    await act(async () => root.render(createElement(MemoryRouter, { key }, createElement(DashboardPage))))
    return container
  }
  function prepare() {
    mocks.scheduled = false
    mocks.report.mockResolvedValue(healthScene("entra-all-areas"))
    tenant.credentials!.appId = GRAPH_CLI_CLIENT_ID
    mocks.stats = stats
    const container = document.body.appendChild(document.createElement("div"))
    root = createRoot(container)
    return container
  }

  it("shows the first successful run, neutral access and a single schedule action in the hero", async () => {
    const container = await mount(prepare(), "initial")
    const hero = container.querySelector("section[aria-labelledby]")!
    expect(hero?.textContent).toContain("Your first backup is done")
    expect(hero.textContent).toContain("214 policies from Intune and Entra ID")
    expect(hero.querySelector('a[href="/portal/backup?tab=schedule"]')?.textContent).toBe("Turn on daily backups")
    expect(hero.querySelector('a[href="/portal/backup?backup=backup-first"]')?.textContent).toBe("View backup")
    expect(hero.querySelector('a[href^="/portal/settings?section=services"]')?.textContent).toBe("Add more coverage")
    const backup = container.querySelector('[aria-label="Last backup"]')!
    expect(backup.textContent).toContain("Coverage incomplete")
    expect(backup.textContent).toContain("Tenant Health: Needs access")
    expect(backup.textContent).not.toContain("Critical")
    expect(container.querySelector('[aria-label="Next Backup"]')?.textContent).toContain("No schedule yet")
    await act(async () => hero.querySelector<HTMLButtonElement>('[aria-label="Dismiss coverage message"]')!.click())
    expect(hero.textContent).toContain("Your first backup is done")
    expect(hero.textContent).not.toContain("Add more coverage")
    await mount(container, "reopened")
    expect(container.textContent).not.toContain("Add more coverage")
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss first backup message"]')!.click())
    await mount(container, "dismissed")
    expect(container.textContent).not.toContain("Your first backup is done")
  })

  it("offers the backup when the schedule is already on and retires the card after two successes", async () => {
    const container = prepare()
    mocks.scheduled = true
    await mount(container, "scheduled")
    const hero = container.querySelector("section[aria-labelledby]")!
    expect(hero.textContent).toContain("View backup")
    expect(hero.textContent).not.toContain("Turn on daily backups")
    mocks.stats = { ...stats, backupHistory: [{ ...first, id: "backup-second" }, first] }
    await mount(container, "second")
    expect(container.textContent).not.toContain("Your first backup is done")
    mocks.stats = stats
    await mount(container, "after-retention")
    expect(container.textContent).not.toContain("Your first backup is done")
  })

  it("waits for three finished backups or seven days before showing a percentage", async () => {
    const container = await mount(prepare(), "one")
    const rate = () => container.querySelector('[aria-label="Success Rate"]')?.textContent
    expect(rate()).toContain("Not enough data yet")
    const failed = { ...first, id: "backup-failed", status: "failed" } as const
    mocks.stats = { ...stats, backupHistory: [first, failed, { ...failed, id: "another-failure", status: "cancelled" }] }
    await mount(container, "two")
    expect(rate()).toContain("Not enough data yet")
    mocks.stats = { ...stats, backupHistory: [first, failed, { ...failed, id: "another-failure" }] }
    await mount(container, "three")
    expect(rate()).toContain("33.3%")
    mocks.stats = { ...stats, backupHistory: [{ ...first, timestamp: new Date(Date.now() - 7 * 86400_000) }] }
    await mount(container, "seven-days")
    expect(rate()).toContain("100%")
  })

  it("retains Critical health and a warning badge for a real failure", async () => {
    const container = prepare()
    const failure = { ...first, status: "partial" } as const
    mocks.stats = { ...stats, tenants: { total: 1, healthy: 0, warning: 0, critical: 1 }, latestBackup: failure, latestCompleteBackup: null, backupHistory: [failure] }
    await mount(container, "failure")
    expect(container.textContent).toContain("Tenant Health: Critical")
    expect(container.textContent).toContain("Completed with warnings")
    expect(container.textContent).not.toContain("Your first backup is done")
  })
})
