import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import BackupRestorePage from "../src/portal/app/portal/backup/page"

const state = vi.hoisted(() => ({ unresolved: 0, backups: [] as Array<Record<string, unknown>> }))
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined,
}))
vi.mock("react-router-dom", () => ({ useSearchParams: () => [new URLSearchParams(), vi.fn()] }))
const tenant = { id: 1, name: "Contoso", credentials: { tenantId: "tenant-a", appId: "app" }, resources: { storageAccountName: "tvlocal-tenant-a" } }
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => [tenant],
  useSelectedTenant: () => ({ selectedTenantId: 1, selectedTenant: tenant, setSelectedTenantId: vi.fn() }),
  useTenantOperations: () => ({ updateTenant: vi.fn() }),
}))
vi.mock("@desktop/lib/license", () => ({ useTenantPlan: () => null }))
vi.mock("@desktop/lib/bridge", () => ({ bridge: { license: { open: vi.fn() } } }))
vi.mock("@desktop/lib/backup-list", () => ({ useBackupList: () => ({ backups: state.backups, loading: false, error: "", unresolved: state.unresolved, refresh: vi.fn() }) }))
vi.mock("@desktop/components/BackupSchedulePanel", () => ({ BackupSchedulePanel: () => null }))
vi.mock("@desktop/components/RunBackupDialog", () => ({ RunBackupDialog: () => null }))
vi.mock("~/components/tenants/backup-progress-modal", () => ({ BackupProgressModal: () => null }))
vi.mock("~/components/backup/backup-changes-dialog", () => ({ BackupChangesDialog: () => null }))
vi.mock("~/components/backup/restore-wizard", () => ({ RestoreWizard: () => null }))

const cancelled = { id: "backup-2026-10-16-020000", timestamp: "2026-10-16T02:00:00Z", type: "manual", status: "Cancelled", totalPolicies: 2, counts: {}, scope: null, size: 1, duration: 4, changes: null, comparedWith: null }

describe("Backup History", () => {
  it("says how many backups could not be read, and nothing when all could", () => {
    state.unresolved = 2
    expect(renderToStaticMarkup(createElement(BackupRestorePage))).toContain("2 backups could not be read. Select Refresh to try again.")
    state.unresolved = 0
    expect(renderToStaticMarkup(createElement(BackupRestorePage))).not.toContain("could not be read. Select Refresh")
  })

  it("shows a cancelled backup like a failed one, labelled Cancelled", () => {
    state.backups = [cancelled]
    const markup = renderToStaticMarkup(createElement(BackupRestorePage))
    expect(markup).toContain('<span class="rounded-full px-2.5 py-1 text-xs font-medium bg-red-50 text-red-700">Cancelled</span>')
    state.backups = []
  })
})
