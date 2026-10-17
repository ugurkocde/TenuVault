import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import OverviewPage from "../src/renderer/pages/OverviewPage"

const state = vi.hoisted(() => ({
  tenants: [
    { id: 1, name: "Contoso", domain: "contoso.onmicrosoft.com", lastBackup: "", credentials: { tenantId: "11111111-1111-1111-1111-111111111111", appId: "app" }, resources: { storageAccountName: "tvlocal-a" } },
    { id: 2, name: "Fabrikam", domain: "fabrikam.onmicrosoft.com", lastBackup: "", credentials: { tenantId: "22222222-2222-2222-2222-222222222222", appId: "app" }, resources: { storageAccountName: "tvlocal-b" } },
  ],
  status: null as Record<string, unknown> | null,
}))

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined,
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, vi.fn()],
}))
vi.mock("react-router-dom", async (original) => ({ ...await original<typeof import("react-router-dom")>(), useNavigate: () => vi.fn() }))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => state.tenants,
  useSelectedTenant: () => ({ setSelectedTenantId: vi.fn() }),
}))
vi.mock("~/contexts/BackupProgressContext", () => ({ useBackupProgress: () => ({ addJob: vi.fn() }) }))
vi.mock("@desktop/lib/bridge", () => ({ bridge: { auth: { accounts: async () => [] } } }))
vi.mock("@desktop/lib/schedules", async (original) => ({ ...await original<typeof import("../src/renderer/lib/schedules")>(), useSchedules: () => [] }))
vi.mock("@desktop/lib/license", () => ({
  useLicense: () => ({ status: state.status }),
  tenantLicense: () => null,
  planName: (plan: string | null) => (plan === "msp" ? "MSP" : plan === "pro" ? "Pro" : "Community"),
  formatDate: () => "",
}))
vi.mock("@desktop/components/RunBackupDialog", () => ({ RunBackupDialog: () => null }))
vi.mock("@desktop/components/RecoveryKeyNotice", () => ({ RecoveryKeyNotice: () => null }))
vi.mock("@desktop/components/UnreadableBackupsNotice", () => ({ UnreadableBackupsNotice: () => null }))
vi.mock("@desktop/lib/local-inventory", () => ({ useBackupSettings: () => [null, vi.fn()], useLocalInventoryProblems: () => ({ affected: [], checking: false }), localTenantIds: () => [] }))

describe("Overview tenant counts", () => {
  it("counts tiles against connected tenants and shows the license allowance separately", () => {
    state.status = { plan: "msp", tenantLimit: 5, tenants: [] }
    const markup = renderToStaticMarkup(createElement(OverviewPage))
    expect(markup).toContain("of 2 connected")
    expect(markup).toContain("MSP covers 5 tenants")
  })

  it("shows no allowance before a key license is known", () => {
    state.status = null
    const markup = renderToStaticMarkup(createElement(OverviewPage))
    expect(markup).toContain("of 2 connected")
    expect(markup).not.toContain("covers")
  })
})
