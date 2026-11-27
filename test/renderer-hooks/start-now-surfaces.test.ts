import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Tenant } from "../../src/portal/contexts/TenantContext"
import type { DashboardBackup, TenantDashboardStats } from "../../src/portal/hooks/dashboard/useDashboardStats"
import type { BackupSchedule } from "../../src/shared/ipc"
import type { TenantConnection } from "../../src/shared/tenant-connection"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TENANT = "aaaaaaaa-1111-4111-8111-111111111111"
const OWN = "bbbbbbbb-2222-4222-8222-222222222222"

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  connection: vi.fn<() => Promise<TenantConnection | null>>(async () => null),
  accounts: vi.fn(async () => []),
  schedules: [] as BackupSchedule[],
  stats: null as TenantDashboardStats | null,
}))

const tenant = {
  id: 1,
  name: "Contoso Ltd",
  domain: "contoso.onmicrosoft.com",
  status: "healthy",
  tags: [],
  configCount: 0,
  users: 0,
  devices: 0,
  policies: { compliance: 0, configuration: 0, apps: 0 },
  credentials: { tenantId: TENANT, appId: "", clientSecret: "" },
  resources: { storageAccountName: `tvlocal-${TENANT}` },
} as unknown as Tenant

const sampleBackup = {
  id: "backup-1",
  tenantId: 1,
  tenantName: "Contoso Ltd",
  timestamp: new Date("2026-11-26T03:00:00Z"),
  policiesBackedUp: 148,
  status: "success",
  duration: 12,
  size: 1024,
} as DashboardBackup

const sampleStats: TenantDashboardStats = {
  tenants: { total: 1, healthy: 0, warning: 1, critical: 0 },
  backups: { scheduled: 1, trend: 0 },
  nextBackup: null,
  recentActivity: [],
  latestBackup: sampleBackup,
  latestCompleteBackup: sampleBackup,
  backupHistory: [sampleBackup],
  failedAttempts: [],
  liveRuns: [],
  periodStart: new Date("2026-11-20T00:00:00Z"),
  backupsError: null,
  lastDriftCheck: null,
}

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock("@desktop/components/ServiceBackupNotice", () => ({ ServiceBackupNotice: () => null }))
vi.mock("@desktop/components/TrialOfferCard", () => ({ TrialOfferCard: () => null }))
vi.mock("@desktop/components/UpgradeNote", () => ({ PlanBadge: () => null, UpgradeNote: () => null }))
vi.mock("~/components/ConfirmDialog", () => ({ useConfirm: () => ({ confirm: async () => true, confirmDialog: null }) }))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => [tenant],
  useSelectedTenant: () => ({ selectedTenant: tenant, setSelectedTenantId: vi.fn() }),
  useTenantOperations: () => ({ updateTenant: vi.fn() }),
}))
vi.mock("~/contexts/BackupProgressContext", () => ({ useBackupProgress: () => ({ activeJobs: [], addJob: vi.fn() }) }))
vi.mock("~/hooks/dashboard/useDashboardStats", () => ({ useDashboardStats: () => ({ data: mocks.stats, isLoading: false, isFetching: false, refetch: vi.fn(), error: null, dataUpdatedAt: Date.now() }) }))
vi.mock("~/hooks/dashboard/useBaselineScore", () => ({ useBaselineScore: () => ({ enabled: false, latest: null }) }))
vi.mock("@desktop/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: null, error: null, refresh: async () => undefined }),
}))
vi.mock("@desktop/lib/schedules", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/schedules")>()),
  useSchedules: () => ({ schedules: mocks.schedules, error: null, loading: false, reload: vi.fn() }),
  useRefusals: () => ({ refusals: [], error: null, reload: vi.fn() }),
}))
vi.mock("@desktop/lib/bridge", () => ({
  bridge: {
    auth: {
      accounts: mocks.accounts,
      connection: mocks.connection,
      onAccountsChanged: () => () => undefined,
    },
    preferences: {
      get: async () => ({ startAtLogin: false, keepRunningInTray: true, retentionDays: 30, autoUpdate: true, nightlyUpdates: false }),
      set: async (next: unknown) => next,
    },
    backgroundLaunch: { status: async () => ({ supported: true, installed: false }) },
    backupReader: { status: async () => ({ supported: true, available: false, reader: null }) },
    backups: {
      scope: async () => ({ scope: { excluded: [] }, saved: true }),
      settings: async () => ({ localFolder: "TenuVault Backups", keyFingerprint: "7F3A-91C2-4D0E", recoveryExported: true, hasLocalBackups: true }),
    },
    cloudBackup: { status: async () => ({ config: null, supported: false }) },
    storage: { getItemSync: () => null, setItem: async () => undefined, removeItem: async () => undefined },
  },
}))

import DashboardPage from "../../src/portal/app/portal/dashboard/page"
import { BackupSchedulePanel } from "../../src/renderer/components/BackupSchedulePanel"

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  localStorage.clear()
  mocks.push.mockReset()
  mocks.connection.mockReset()
  mocks.connection.mockResolvedValue(null)
  mocks.accounts.mockReset()
  mocks.accounts.mockResolvedValue([])
  mocks.schedules = []
  mocks.stats = null
})

async function render(element: ReturnType<typeof createElement>): Promise<HTMLDivElement> {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(createElement(MemoryRouter, null, element)))
  return container
}

describe("Start now removal surfaces on Dashboard and Schedule status", () => {
  it("shows a neutral Paused badge, one pause line, and a choose-method action on Dashboard when a tenant needs a sign-in method", async () => {
    mocks.stats = sampleStats
    mocks.connection.mockResolvedValue({
      version: 1,
      method: null,
      clientId: "",
      origin: "wizard",
      needsSignInMethod: true,
      createdAt: "2026-11-27T00:00:00Z",
      updatedAt: "2026-11-27T00:00:00Z",
    })
    mocks.schedules = [{
      tenantId: TENANT,
      enabled: true,
      frequency: "daily",
      time: "02:00",
      since: "2026-11-20T00:00:00Z",
      attempts: 0,
      nextRunAt: null,
      pausedReason: "Paused: Start now was removed in 0.6. Choose a sign-in method",
    }]

    const container = await render(createElement(DashboardPage))

    const nextBackup = container.querySelector('[aria-label="Next Backup"]')!
    const badge = [...nextBackup.querySelectorAll("span")].find(el => el.textContent?.trim() === "Paused")
    expect(badge).toBeDefined()
    expect(badge?.className).toContain("bg-gray-100")
    expect(nextBackup.textContent).not.toContain("On")
    expect(nextBackup.textContent).not.toContain("Not scheduled")
    expect(nextBackup.textContent).toContain("Paused until you choose a sign-in method")

    const lastBackup = container.querySelector('[aria-label="Last backup"]')!
    const buttons = [...lastBackup.querySelectorAll<HTMLButtonElement>("button")]
    expect(buttons.map(b => b.textContent?.trim())).not.toContain("Sign in")
    const chooseButton = buttons.find(b => b.textContent?.trim() === "Choose a sign-in method")
    expect(chooseButton).toBeDefined()
    await act(async () => chooseButton!.click())
    expect(mocks.push).toHaveBeenCalledWith(`/portal/settings?section=signin#sign-in-${TENANT}`)
  })

  it("shows Choose a sign-in method instead of You (your sign-in) in Schedule status when a tenant needs a sign-in method", async () => {
    mocks.connection.mockResolvedValue({
      version: 1,
      method: null,
      clientId: "",
      origin: "wizard",
      needsSignInMethod: true,
      createdAt: "2026-11-27T00:00:00Z",
      updatedAt: "2026-11-27T00:00:00Z",
    })
    mocks.schedules = [{
      tenantId: TENANT,
      enabled: true,
      frequency: "daily",
      time: "02:00",
      since: "2026-11-20T00:00:00Z",
      attempts: 0,
      nextRunAt: null,
      pausedReason: "Paused: Start now was removed in 0.6. Choose a sign-in method",
    }]

    const container = await render(createElement(BackupSchedulePanel, { tenantId: TENANT, tenantName: "Contoso Ltd", tenant }))
    const dt = [...container.querySelectorAll("dt")].find(el => el.textContent?.trim() === "Scheduled backups run as")!
    const dd = dt.parentElement!.querySelector("dd")!
    expect(dd.textContent?.trim()).toBe("Choose a sign-in method")
    expect(dd.textContent).not.toContain("You (your sign-in)")
    expect(dd.querySelector("a")?.getAttribute("href")).toBe(`/portal/settings?section=signin#sign-in-${TENANT}`)

    // An own-registration tenant still displays You (your sign-in).
    mocks.connection.mockResolvedValue({
      version: 1,
      method: "ownApp",
      clientId: OWN,
      origin: "wizard",
      createdAt: "2026-11-27T00:00:00Z",
      updatedAt: "2026-11-27T00:00:00Z",
    })
    mocks.schedules = [{
      tenantId: TENANT,
      enabled: true,
      frequency: "daily",
      time: "02:00",
      since: "2026-11-20T00:00:00Z",
      attempts: 0,
      nextRunAt: "2026-11-28T02:00:00Z",
    }]
    const normal = await render(createElement(BackupSchedulePanel, { tenantId: TENANT, tenantName: "Contoso Ltd", tenant }))
    const normalDt = [...normal.querySelectorAll("dt")].find(el => el.textContent?.trim() === "Scheduled backups run as")!
    const normalDd = normalDt.parentElement!.querySelector("dd")!
    expect(normalDd.textContent).toContain("You (your sign-in)")
  })
})
