import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import type { LicenseStatus, SignedInAccount, TenantLicenseStatus } from "../src/shared/ipc"

const TENANT = "11111111-1111-1111-1111-111111111111"

const state = vi.hoisted(() => ({
  status: null as LicenseStatus | null,
  accounts: [] as SignedInAccount[],
}))

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined,
  // OverviewPage keeps the signed-in accounts in its only array state.
  useState: (initial: unknown) => [Array.isArray(initial) ? state.accounts : typeof initial === "function" ? initial() : initial, vi.fn()],
}))
vi.mock("react-router-dom", async (original) => ({ ...await original<typeof import("react-router-dom")>(), useNavigate: () => vi.fn() }))
vi.mock("~/contexts/TenantContext", () => {
  const tenant = { id: 1, name: "Contoso", domain: "contoso.onmicrosoft.com", lastBackup: "", credentials: { tenantId: "11111111-1111-1111-1111-111111111111", appId: "app" }, resources: { storageAccountName: "tvlocal-a" } }
  return {
    useTenants: () => [tenant],
    useSelectedTenant: () => ({ selectedTenant: tenant, setSelectedTenantId: vi.fn() }),
  }
})
vi.mock("~/contexts/BackupProgressContext", () => ({ useBackupProgress: () => ({ addJob: vi.fn() }) }))
vi.mock("@desktop/lib/bridge", () => ({ bridge: {} }))
vi.mock("@desktop/lib/schedules", async (original) => ({
  ...await original<typeof import("../src/renderer/lib/schedules")>(),
  useSchedules: () => [],
  useRefusals: () => [],
}))
vi.mock("@desktop/lib/license", async (original) => ({
  ...await original<typeof import("../src/renderer/lib/license")>(),
  useLicense: () => ({ status: state.status, error: null, refresh: async () => undefined }),
}))
vi.mock("@desktop/components/RunBackupDialog", () => ({ RunBackupDialog: () => null }))
vi.mock("@desktop/components/RecoveryKeyNotice", () => ({ RecoveryKeyNotice: () => null }))
vi.mock("@desktop/components/UnreadableBackupsNotice", () => ({ UnreadableBackupsNotice: () => null }))
vi.mock("@desktop/lib/local-inventory", () => ({ useBackupSettings: () => [null, vi.fn()], useLocalInventoryProblems: () => ({ affected: [], checking: false }), localTenantIds: () => [] }))

import OverviewPage from "../src/renderer/pages/OverviewPage"
import { TenantSwitcher } from "../src/renderer/components/TenantSwitcher"
import { TenantAccessNotice } from "../src/renderer/components/TenantAccessNotice"
import { BackupSchedulePanel } from "../src/renderer/components/BackupSchedulePanel"

const tenantStatus = (overrides: Partial<TenantLicenseStatus>): TenantLicenseStatus => ({
  tenantId: TENANT, signedIn: true, activated: false, entitled: false, source: null, plan: "community",
  tenants: null, expiresAt: null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null,
  ...overrides,
})

const licenseStatus = (tenant: TenantLicenseStatus): LicenseStatus => ({
  hasKey: false, keyState: "none", keyMessage: null, keyHint: null, persisted: true,
  offline: false, message: null, plan: null, tenantLimit: null, validUntil: null,
  communityTenantId: tenant.plan === "community" ? TENANT : null, tenants: [tenant],
})

/** Whether the Back up now button carries the disabled attribute. */
function backUpDisabled(markup: string): boolean {
  const start = markup.lastIndexOf("<button", markup.indexOf("Back up now"))
  return /\sdisabled=""/.test(markup.slice(start, markup.indexOf(">", start)))
}

const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, null, element))

describe("Community tenant surfaces", () => {
  // Community tenants have no entitlement token, yet the main process allows their backups.
  const community = licenseStatus(tenantStatus({}))
  const uncovered = licenseStatus(tenantStatus({ plan: null }))

  it("counts the Community tenant as licensed and lets it back up", () => {
    state.status = community
    state.accounts = [{ tenantId: TENANT, clientId: "app", username: "admin@contoso.com" }]
    const markup = render(createElement(OverviewPage))
    expect(markup).toMatch(/Licensed<\/[^>]+>\s*<p[^>]*>1<span/)
    expect(markup).not.toContain("Check license")
    expect(backUpDisabled(markup)).toBe(false)

    state.status = uncovered
    const blocked = render(createElement(OverviewPage))
    expect(blocked).toContain("Check license")
    expect(backUpDisabled(blocked)).toBe(true)
  })

  it("does not label the Community tenant as not licensed in the switcher", () => {
    state.status = community
    expect(render(createElement(TenantSwitcher))).not.toContain("Not licensed")
    state.status = uncovered
    expect(render(createElement(TenantSwitcher))).toContain("Not licensed")
  })

  it("shows no license notice for a signed-in Community tenant", () => {
    state.status = community
    expect(render(createElement(TenantAccessNotice))).toBe("")
    state.status = uncovered
    expect(render(createElement(TenantAccessNotice))).toContain("An active license is required")
  })

  it("does not claim the Community tenant's automatic backups are off", () => {
    state.status = community
    const props = { tenantId: TENANT, tenantName: "Contoso" }
    expect(render(createElement(BackupSchedulePanel, props))).not.toContain("does not cover")
    state.status = uncovered
    expect(render(createElement(BackupSchedulePanel, props))).toContain("does not cover")
  })
})
