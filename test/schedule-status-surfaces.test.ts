import { createElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import OverviewPage from "../src/renderer/pages/OverviewPage"
import DashboardPage from "../src/portal/app/portal/dashboard/page"
import { useDashboardStats, type TenantDashboardStats } from "../src/portal/hooks/dashboard/useDashboardStats"
import { describeSchedule, formatWhen } from "../src/renderer/lib/schedules"
import type { BackupSchedule, FailedBackupAttempt } from "../src/shared/ipc"

const state = vi.hoisted(() => ({
  tenants: [{ id: 42, name: "Contoso", domain: "contoso.onmicrosoft.com", lastBackup: "", credentials: { tenantId: "tenant", appId: "app" }, resources: { storageAccountName: "tvlocal-tenant" } }],
  schedules: [] as BackupSchedule[],
  failedAttempts: [] as FailedBackupAttempt[],
  liveRuns: [] as string[],
  activeJobs: [] as Array<{ tenantId: string; isComplete: boolean; status: string; jobId?: string }>,
  stats: null as TenantDashboardStats | null,
  dataUpdatedAt: 0,
  queryFn: null as (() => Promise<TenantDashboardStats>) | null,
  navigate: vi.fn(),
  selectTenant: vi.fn(),
  plan: null as string | null,
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
vi.mock("~/contexts/BackupProgressContext", () => ({ useBackupProgress: () => ({ activeJobs: state.activeJobs, addJob: vi.fn() }) }))
vi.mock("@desktop/lib/bridge", () => ({ bridge: {
  schedules: { list: async () => state.schedules },
  backups: {
    failedAttempts: async (tenantId: string) => state.failedAttempts.filter((attempt) => attempt.tenantId === tenantId),
    liveRuns: async (tenantId: string) => tenantId === "tenant" ? state.liveRuns : [],
  },
} }))
vi.mock("@desktop/lib/schedules", async (original) => ({ ...await original<typeof import("../src/renderer/lib/schedules")>(), useSchedules: () => state.schedules }))
vi.mock("@desktop/lib/license", () => ({ useLicense: () => ({ status: null }), tenantLicense: () => null, tenantPlan: () => state.plan, planName: () => "Community" }))
vi.mock("@desktop/components/RunBackupDialog", () => ({ RunBackupDialog: () => null }))
vi.mock("@desktop/components/RecoveryKeyNotice", () => ({ RecoveryKeyNotice: () => null }))
vi.mock("@desktop/components/UnreadableBackupsNotice", () => ({ UnreadableBackupsNotice: () => null }))
vi.mock("@desktop/lib/local-inventory", () => ({ useBackupSettings: () => [null, vi.fn()], useLocalInventoryProblems: () => ({ affected: [], checking: false }), localTenantIds: () => [] }))
vi.mock("@desktop/components/UpgradeNote", () => ({ PlanBadge: () => null }))
vi.mock("~/hooks/dashboard/useBaselineScore", () => ({ useBaselineScore: () => ({ enabled: false }) }))
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: { queryFn: () => Promise<TenantDashboardStats> }) => {
  state.queryFn = options.queryFn
  return { data: state.stats, isLoading: !state.stats, isFetching: false, dataUpdatedAt: state.dataUpdatedAt }
} }))

const schedule: BackupSchedule = { tenantId: "tenant", enabled: true, frequency: "weekly", weekday: 0, time: "19:48", since: "2026-10-01T00:00:00Z", nextRunAt: "2026-10-18T17:48:00Z", lastRunAt: "2026-10-04T17:48:00Z", lastAttemptAt: "2026-10-11T17:48:00Z", attempts: 1, lastStatus: "Failed" }
const emptyStats: TenantDashboardStats = {
  tenants: { total: 1, healthy: 0, warning: 1, critical: 0 },
  backups: { scheduled: 1, trend: 0 },
  nextBackup: null, recentActivity: [], latestBackup: null, latestCompleteBackup: null,
  backupHistory: [], failedAttempts: [], liveRuns: [], periodStart: new Date(0), backupsError: null, lastDriftCheck: null,
}
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000)
const storedBackup = (status: "success" | "failed" | "cancelled", timestamp: Date) => ({
  id: `backup-${timestamp.getTime()}`, tenantId: 42, tenantName: "Contoso", timestamp, status, policiesBackedUp: 3, duration: 0, size: 0,
})

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
  state.failedAttempts = []
  state.liveRuns = []
  state.activeJobs = []
  state.stats = { ...emptyStats }
  state.dataUpdatedAt = 0
  state.plan = null
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

describe("Overview cancelled automatic backup", () => {
  it("shows a cancelled automatic backup in a neutral tone, without Action required", () => {
    state.schedules = [{ ...schedule, lastStatus: "Cancelled" }]
    const markup = renderToStaticMarkup(createElement(OverviewPage))
    expect(markup).toContain(`Last automatic backup cancelled ${formatWhen(schedule.lastAttemptAt)}</span>`)
    expect(markup).toContain("text-gray-400")
    expect(markup).not.toContain("text-red-700")
    expect(markup).not.toContain("Action required")
    expect(markup).not.toContain("attempt failed")
  })
})

describe("Dashboard backup counts", () => {
  it("counts an automatic attempt that saved no backup as failed in the period", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])))
    state.failedAttempts = [
      { at: hoursAgo(2).toISOString(), tenantId: "tenant", runId: "desktop-1", trigger: "scheduled", message: "Sign in again." },
      { at: hoursAgo(24 * 9).toISOString(), tenantId: "tenant", runId: "desktop-2", trigger: "manual", message: "Older than the period." },
      { at: hoursAgo(1).toISOString(), tenantId: "other", runId: "desktop-3", trigger: "manual", message: "Another tenant." },
    ]
    useDashboardStats("7d", 42)
    state.stats = await state.queryFn!()
    expect(state.stats.backupHistory).toEqual([])
    expect(state.stats.failedAttempts.map((attempt) => attempt.message)).toEqual(["Sign in again.", "Older than the period."])
    const markup = renderDashboard()
    expect(markup).toContain('aria-label="Successful backups"')
    expect(markup).toContain("Failed includes attempts that saved no backup.")
    expect(markup).toContain("Automatic backup failed before a backup was saved.")
    expect(markup).toMatch(/>1<\/p><p[^>]*>Failed<\/p>/)
    expect(markup).toContain("0%")
    expect(markup).toContain("Target 95%, 0 of 1 backups succeeded")
    expect(markup).not.toContain("in storage")
  })

  it("keeps the stored, successful, failed and success rate tiles in agreement", () => {
    state.activeJobs = [{ tenantId: "TENANT", isComplete: false, status: "Running" }]
    state.stats = {
      ...emptyStats,
      periodStart: hoursAgo(24 * 7),
      backupHistory: [
        storedBackup("success", hoursAgo(1)),
        storedBackup("failed", hoursAgo(5)),
        ...[10, 11, 12, 13, 15].map((days) => storedBackup("success", hoursAgo(24 * days))),
      ],
      failedAttempts: [{ tenantId: 42, timestamp: hoursAgo(3), runId: "desktop-conflict", message: "A different backup is already running for this tenant." }],
    }
    const markup = renderDashboard()
    expect(markup).toContain("7 backups in storage")
    expect(markup).toMatch(/aria-label="Successful backups"[\s\S]*?>Successful backups<[\s\S]*?>1<\/[\s\S]*?>Last 7 days</)
    expect(markup).toMatch(/>2<\/p><p[^>]*>Failed<\/p>/)
    expect(markup).toMatch(/>1<\/p><p[^>]*>Running<\/p>/)
    expect(markup).toContain("33.3%")
    expect(markup).toContain("Target 95%, 1 of 3 backups succeeded")
    expect(markup).not.toContain("Stored backups")
    expect(markup).not.toContain("backups stored")
  })

  it("does not count a finished job kept in the progress list as running", () => {
    state.activeJobs = [{ tenantId: "TENANT", isComplete: true, status: "Failed" }, { tenantId: "TENANT", isComplete: false, status: "Running" }]
    state.stats = { ...emptyStats, periodStart: hoursAgo(24), failedAttempts: [{ tenantId: 42, timestamp: hoursAgo(1), runId: "desktop-1", message: "Sign in again." }] }
    const markup = renderDashboard()
    expect(markup).toMatch(/>1<\/p><p[^>]*>Failed<\/p>/)
    expect(markup).toMatch(/>1<\/p><p[^>]*>Running<\/p>/)
    state.activeJobs = [{ tenantId: "TENANT", isComplete: true, status: "Failed" }]
    const finished = renderDashboard()
    expect(finished).toMatch(/>0<\/p><p[^>]*>Running<\/p>/)
    expect(finished).not.toContain(">Running</span>")
  })

  // The chips sit in the Last backup tile, before its label.
  const chip = (markup: string) => markup.slice(markup.indexOf('aria-label="Last backup"'), markup.indexOf(">Last backup<")).match(/>(Running|Incomplete|Failed|Completed)</)?.[1] ?? null
  const running = (markup: string) => markup.match(/>(\d+)<\/p><p[^>]*>Running<\/p>/)?.[1]
  const failed = (markup: string) => markup.match(/>(\d+)<\/p><p[^>]*>Failed<\/p>/)?.[1]

  it("shows the same running state on the Last backup chip as in the Running count", () => {
    const recent = { ...storedBackup("success", hoursAgo(1)), status: "running" as const, runId: "desktop-run" }
    const old = { ...recent, status: "incomplete" as const, timestamp: hoursAgo(7) }
    // Older than six hours and not live: incomplete.
    state.stats = { ...emptyStats, periodStart: hoursAgo(24), latestBackup: old, backupHistory: [old] }
    let markup = renderDashboard()
    expect([chip(markup), running(markup), failed(markup)]).toEqual(["Incomplete", "0", "1"])
    // Its run failed: the folder is that failure, counted once.
    state.stats = { ...emptyStats, periodStart: hoursAgo(24), latestBackup: recent, backupHistory: [recent], failedAttempts: [{ tenantId: 42, timestamp: hoursAgo(1), runId: "desktop-run", message: "Backup stopped." }] }
    markup = renderDashboard()
    expect([chip(markup), running(markup), failed(markup)]).toEqual(["Failed", "0", "1"])
    // Recent and not live here, for example running on another device: running.
    state.stats = { ...state.stats, failedAttempts: [] }
    markup = renderDashboard()
    expect([chip(markup), running(markup), failed(markup)]).toEqual(["Running", "1", "0"])
    // A manual job of this window that has no folder yet: running too, counted once with the engine's list.
    state.stats = { ...emptyStats, periodStart: hoursAgo(24), liveRuns: ["desktop-manual"] }
    state.activeJobs = [{ tenantId: "TENANT", isComplete: false, status: "Running", jobId: "desktop-manual" }]
    markup = renderDashboard()
    expect([chip(markup), running(markup), failed(markup)]).toEqual(["Running", "1", "0"])
  })

  it("counts a scheduled backup the engine is running as Running, in the chip, the count and the trend", async () => {
    // The scheduled job is not in this window's progress list; only the engine knows it.
    state.liveRuns = ["desktop-scheduled"]
    const day = 86_400_000
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("list-backups")
      ? Response.json({ backups: [
        { name: "backup-scheduled", timestamp: hoursAgo(0.5).toISOString(), status: "running", runId: "desktop-scheduled" },
        { name: "backup-today", timestamp: hoursAgo(2).toISOString(), status: "Success", runId: "desktop-today" },
        { name: "backup-last-week", timestamp: new Date(Date.now() - 9 * day).toISOString(), status: "Success", runId: "desktop-last-week" },
      ] })
      : Response.json([])))
    useDashboardStats("7d", 42)
    state.stats = await state.queryFn!()
    expect(state.stats.liveRuns).toEqual(["desktop-scheduled"])
    // Both periods are fully successful: the running backup is not a failure.
    expect(state.stats.backups.trend).toBe(0)
    const markup = renderDashboard()
    expect([chip(markup), running(markup), failed(markup)]).toEqual(["Running", "1", "0"])
    expect(markup).toContain("Target 95%, 1 of 1 backups succeeded")
  })

  it("counts a cancelled backup in storage only and shows Cancelled in a neutral chip", () => {
    const cancelled = storedBackup("cancelled", hoursAgo(1))
    state.stats = { ...emptyStats, periodStart: hoursAgo(24), latestBackup: cancelled, backupHistory: [cancelled, storedBackup("success", hoursAgo(2)), storedBackup("failed", hoursAgo(3))] }
    const markup = renderDashboard()
    const tile = markup.slice(markup.indexOf('aria-label="Last backup"'), markup.indexOf(">Last backup<"))
    expect(tile).toMatch(/class="[^"]*bg-gray-100 text-gray-700[^"]*"><span[^>]*bg-gray-400[^>]*><\/span>Cancelled<\/span>/)
    expect(chip(markup)).toBeNull()
    expect(markup).toContain("3 backups in storage")
    expect(failed(markup)).toBe("1")
    expect(markup).toContain("50.0%")
    expect(markup).toContain("Target 95%, 1 of 2 backups succeeded")
  })

  it("names a cancelled automatic backup in a neutral tone in the Next Backup tile", () => {
    state.schedules = [{ ...schedule, lastStatus: "Cancelled" }]
    for (const backupHistory of [[storedBackup("cancelled", hoursAgo(1))], []]) {
      state.stats = { ...emptyStats, backupHistory }
      const markup = renderDashboard()
      expect(markup).toContain(`<p class="mt-2 text-xs text-gray-500">Last automatic backup cancelled ${formatWhen(schedule.lastAttemptAt)}</p>`)
      expect(markup).not.toContain("before a backup was saved")
    }
  })

  it("lists a cancelled backup and a cancel in the audit log in Recent activity in grey, and does not make the tenant critical", async () => {
    state.plan = "pro"
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("list-backups")
      ? Response.json({ backups: [{ name: "backup-cancelled", timestamp: hoursAgo(1).toISOString(), status: "Cancelled", runId: "desktop-cancelled" }] })
      : String(input).includes("audit/logs")
        ? Response.json({ data: [{ id: "audit-1", timestamp: hoursAgo(2).toISOString(), eventType: "BACKUP_CANCELLED", action: "Scheduled backup", result: "PARTIAL", severity: "INFO" }] })
        : Response.json([])))
    useDashboardStats("7d", 42)
    state.stats = await state.queryFn!()
    expect(state.stats.recentActivity).toMatchObject([{ status: "neutral", message: "Backup cancelled" }, { status: "neutral", message: "Scheduled backup" }])
    expect(state.stats.tenants).toMatchObject({ critical: 0, warning: 1 })
    const markup = renderDashboard()
    const icons = [...markup.matchAll(/<span class="mt-0\.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full ([^"]*)">/g)].map((match) => match[1])
    expect(icons).toEqual(["bg-gray-100", "bg-gray-100"])
    expect(markup).toContain("Backup cancelled")
    expect(markup).not.toContain("bg-red-100")
    expect(markup).not.toContain("bg-blue-100")
  })

  it("says how many backups could not be read, and nothing once they can", async () => {
    let unresolved = 2
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("list-backups")
      ? Response.json({ backups: [{ name: "backup-today", timestamp: hoursAgo(2).toISOString(), status: "Success", runId: "desktop-today" }], unresolved })
      : Response.json([])))
    useDashboardStats("7d", 42)
    state.stats = await state.queryFn!()
    expect(state.stats.unresolvedBackups).toBe(2)
    expect(renderDashboard()).toContain("2 backups could not be read. Select Refresh to try again.")
    unresolved = 0
    state.stats = await state.queryFn!()
    expect(renderDashboard()).not.toContain("could not be read. Select Refresh")
  })

  it("shows No data when no backup finished in the period", () => {
    state.stats = { ...emptyStats, periodStart: hoursAgo(24), backupHistory: [storedBackup("success", hoursAgo(48))] }
    const markup = renderDashboard()
    expect(markup).toContain("1 backup in storage")
    expect(markup).toContain("No data")
    expect(markup).toContain("No finished backups in this period")
    expect(markup).not.toContain("100%")
  })

  it("shows No data instead of a rate when the backups could not be read", () => {
    state.stats = { ...emptyStats, periodStart: hoursAgo(24), backupsError: "Storage unavailable.", failedAttempts: [{ tenantId: 42, timestamp: hoursAgo(1), runId: "desktop-1", message: "Sign in again." }] }
    const markup = renderDashboard()
    expect(markup).toContain("No data")
    expect(markup).not.toContain("0%")
    expect(markup).toContain("Backups could not be read")
    expect(markup).not.toContain("No finished backups in this period")
  })

  it.each([
    { stored: 1, backupsError: null, lastStatus: "Failed" },
    { stored: 0, backupsError: "Storage unavailable.", lastStatus: "Failed" },
    { stored: 0, backupsError: null, lastStatus: "Completed" },
  ] as const)("does not claim an unsaved failure for %j", ({ stored, backupsError, lastStatus }) => {
    state.stats = { ...emptyStats, backupHistory: Array.from({ length: stored }, () => storedBackup("success", hoursAgo(1))), backupsError }
    state.schedules = [{ ...schedule, lastStatus }]
    expect(renderDashboard()).not.toContain("Automatic backup failed before a backup was saved.")
  })

  it("waits for backup history before describing an unsaved failure", () => {
    state.stats = null
    expect(renderDashboard()).not.toContain("Automatic backup failed before a backup was saved.")
  })
})

describe("Dashboard last updated label", () => {
  it("reserves the widest label width so the ticking seconds never move the header row", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-18T12:00:09Z"))
    try {
      state.dataUpdatedAt = Date.now() - 9_000
      const markup = renderDashboard()
      // The visible label and every sizer share one grid cell, so the box is
      // held at its widest width on a single row. Without the sizers the 9 to
      // 10 second step widens the span and pushes the whole row left.
      expect(markup).toContain('<span class="col-start-1 row-start-1 whitespace-nowrap">Last updated 9 seconds ago</span>')
      for (const widest of ["Last updated 59 seconds ago", "Last updated 59 minutes ago", "Last updated 99999 days ago"]) {
        expect(markup).toContain(`<span aria-hidden="true" class="invisible col-start-1 row-start-1 whitespace-nowrap">${widest}</span>`)
      }
      expect(markup).toMatch(/<span class="[^"]*\bgrid\b[^"]*tabular-nums[^"]*">/)
    } finally {
      vi.useRealTimers()
    }
  })
})
