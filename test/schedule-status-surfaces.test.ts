import { createElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import OverviewPage from "../src/renderer/pages/OverviewPage"
import DashboardPage from "../src/portal/app/portal/dashboard/page"
import { useDashboardStats, type TenantDashboardStats } from "../src/portal/hooks/dashboard/useDashboardStats"
import { describeSchedule, formatWhen } from "../src/renderer/lib/schedules"
import type { BackupSchedule } from "../src/shared/ipc"

const state = vi.hoisted(() => ({
  tenants: [{ id: 42, name: "Contoso", domain: "contoso.onmicrosoft.com", lastBackup: "", credentials: { tenantId: "tenant", appId: "app" }, resources: { storageAccountName: "tvlocal-tenant" } }],
  schedules: [] as BackupSchedule[],
  stats: null as TenantDashboardStats | null,
  queryFn: null as (() => Promise<TenantDashboardStats>) | null,
  navigate: vi.fn(),
  selectTenant: vi.fn(),
}))
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined,
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, vi.fn()],
}))
vi.mock("react-router-dom", async (original) => ({ ...await original<typeof import("react-router-dom")>(), useNavigate: () => state.navigate }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.navigate }) }))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => state.tenants,
  useSelectedTenant: () => ({ selectedTenant: state.tenants[0], setSelectedTenantId: state.selectTenant }),
}))
vi.mock("~/contexts/BackupProgressContext", () => ({ useBackupProgress: () => ({ activeJobs: [], addJob: vi.fn() }) }))
vi.mock("@desktop/lib/bridge", () => ({ bridge: { schedules: { list: async () => state.schedules } } }))
vi.mock("@desktop/lib/schedules", async (original) => ({ ...await original<typeof import("../src/renderer/lib/schedules")>(), useSchedules: () => state.schedules }))
vi.mock("@desktop/lib/license", () => ({ useLicense: () => ({ status: null }), tenantLicense: () => null, tenantPlan: () => null, planName: () => "Community" }))
vi.mock("@desktop/components/RunBackupDialog", () => ({ RunBackupDialog: () => null }))
vi.mock("@desktop/components/RecoveryKeyNotice", () => ({ RecoveryKeyNotice: () => null }))
vi.mock("@desktop/components/UpgradeNote", () => ({ PlanBadge: () => null }))
vi.mock("~/hooks/dashboard/useBaselineScore", () => ({ useBaselineScore: () => ({ enabled: false }) }))
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: { queryFn: () => Promise<TenantDashboardStats> }) => {
  state.queryFn = options.queryFn
  return { data: state.stats, isLoading: !state.stats, isFetching: false }
} }))

const schedule: BackupSchedule = { tenantId: "tenant", enabled: true, frequency: "weekly", weekday: 0, time: "19:48", since: "2026-10-01T00:00:00Z", nextRunAt: "2026-10-18T17:48:00Z", lastRunAt: "2026-10-04T17:48:00Z", lastAttemptAt: "2026-10-11T17:48:00Z", attempts: 1, lastStatus: "Failed" }
const emptyStats: TenantDashboardStats = {
  tenants: { total: 1, healthy: 0, warning: 1, critical: 0 },
  backups: { successful: 0, failed: 0, inProgress: 0, scheduled: 1, successRate: 100, trend: 0 },
  nextBackup: null, recentActivity: [], latestBackup: null, latestCompleteBackup: null,
  totalBackups: 0, backupsError: null, lastDriftCheck: null,
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}

function renderDashboard(): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DashboardPage)))
}

beforeEach(() => {
  state.schedules = [{ ...schedule }]
  state.stats = { ...emptyStats }
  state.navigate.mockClear()
  state.selectTenant.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

describe("Overview schedule status", () => {
  it("renders recurrence, next time and the full failure timestamp in wrapping rows", () => {
    const markup = renderToStaticMarkup(createElement(OverviewPage))
    expect(markup).toContain(`<span class="block break-words">${describeSchedule(schedule)}</span>`)
    expect(markup).toContain(`Next ${formatWhen(schedule.nextRunAt)}</span>`)
    expect(markup).toContain(`Last automatic backup attempt failed ${formatWhen(schedule.lastAttemptAt)}</span>`)
    const facts = [...markup.matchAll(/<dt[^>]*>(Automatic backups|Last backup)<\/dt><dd class="([^"]*)">/g)]
    expect(facts).toHaveLength(2)
    for (const fact of facts) expect(fact[2]).not.toContain("truncate")
    expect(markup).toContain("Action required")
  })

  it("selects the affected tenant and opens Schedule from the failure row", () => {
    const button = elements(OverviewPage()).find(element => element.type === "button" && renderToStaticMarkup(element).includes("Last automatic backup attempt failed"))!
    expect(button.props.type).toBe("button")
    const click = button.props.onClick as () => void
    click()
    expect(state.selectTenant).toHaveBeenCalledWith(42)
    expect(state.navigate).toHaveBeenCalledWith("/portal/backup?tab=schedule")
  })

  it("shows the failure action without a timestamp and removes it after success", () => {
    state.schedules = [{ ...schedule, lastAttemptAt: undefined }]
    expect(renderToStaticMarkup(createElement(OverviewPage))).toContain("Last automatic backup attempt failed")
    state.schedules = [{ ...schedule, lastStatus: "Completed" }]
    const markup = renderToStaticMarkup(createElement(OverviewPage))
    expect(markup).not.toContain("Action required")
    expect(markup).not.toContain("Last automatic backup attempt failed")
    expect(markup).toContain(`Last automatic backup ${formatWhen(schedule.lastAttemptAt)}`)
  })
})

describe("Dashboard stored backup status", () => {
  it("explains an automatic failure with zero stored backups without increasing the Failed count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])))
    useDashboardStats("7d", 42)
    state.stats = await state.queryFn!()
    expect(state.stats.totalBackups).toBe(0)
    expect(state.stats.backups.failed).toBe(0)
    const markup = renderDashboard()
    expect(markup).toContain('aria-label="Stored backups"')
    expect(markup).toContain("Successful and failed counts use stored backup history.")
    expect(markup).toContain("Automatic backup failed before a backup was saved.")
    expect(markup).toMatch(/>0<\/p><p[^>]*>Failed<\/p>/)
  })

  it.each([
    { totalBackups: 1, backupsError: null, lastStatus: "Failed" },
    { totalBackups: 0, backupsError: "Storage unavailable.", lastStatus: "Failed" },
    { totalBackups: 0, backupsError: null, lastStatus: "Completed" },
  ] as const)("does not claim an unsaved failure for %j", ({ totalBackups, backupsError, lastStatus }) => {
    state.stats = { ...emptyStats, totalBackups, backupsError }
    state.schedules = [{ ...schedule, lastStatus }]
    expect(renderDashboard()).not.toContain("Automatic backup failed before a backup was saved.")
  })

  it("waits for backup history before describing an unsaved failure", () => {
    state.stats = null
    expect(renderDashboard()).not.toContain("Automatic backup failed before a backup was saved.")
  })
})
