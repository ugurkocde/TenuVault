import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({ tenant: 0, damagedFiles: 3, sealed: 0 }))
vi.mock("react-router-dom", () => ({ useSearchParams: () => [new URLSearchParams(), vi.fn()] }))
const tenants = vi.hoisted(() => [
  { id: 1, name: "Contoso", status: "healthy", credentials: { tenantId: "11111111-1111-1111-1111-111111111111", appId: "app" }, resources: { storageAccountName: "tvlocal-11111111-1111-1111-1111-111111111111" } },
  { id: 2, name: "Fabrikam", status: "healthy", credentials: { tenantId: "22222222-2222-2222-2222-222222222222", appId: "app" }, resources: { storageAccountName: "tvlocal-22222222-2222-2222-2222-222222222222" } },
])
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => tenants,
  useSelectedTenant: () => ({ selectedTenantId: tenants[state.tenant]!.id, selectedTenant: tenants[state.tenant], setSelectedTenantId: vi.fn() }),
  useTenantOperations: () => ({ updateTenant: vi.fn() }),
}))
vi.mock("@desktop/lib/license", () => ({ useTenantPlan: () => null }))
vi.mock("@desktop/lib/bridge", () => ({ bridge: { license: { open: vi.fn() } } }))
vi.mock("@desktop/lib/backup-list", () => ({
  useBackupList: () => ({ backups: [], loading: false, error: "", unresolved: 0, sealed: state.sealed, damagedFiles: state.damagedFiles, damagedFileNames: [], damagedKinds: { counts: { key: state.damagedFiles, os: 0, duplicate: 0, damaged: 0 }, codes: [], names: { key: [], os: [], duplicate: [], damaged: [] } }, refresh: vi.fn(async () => "updated") }),
}))
vi.mock("@desktop/components/BackupSchedulePanel", () => ({ BackupSchedulePanel: () => null }))
vi.mock("@desktop/components/RunBackupDialog", () => ({ RunBackupDialog: () => null }))
vi.mock("~/components/tenants/backup-progress-modal", () => ({ BackupProgressModal: () => null }))
vi.mock("~/components/backup/backup-changes-dialog", () => ({ BackupChangesDialog: () => null }))
vi.mock("~/components/backup/restore-wizard", () => ({ RestoreWizard: () => null }))

import BackupRestorePage from "../../src/portal/app/portal/backup/page"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
})

const cards = (container: HTMLElement, title: string) => [...container.querySelectorAll("[role=status]")].filter((card) => card.querySelector("p.font-medium")?.textContent?.includes(title)).length

describe("Backup History notices", () => {
  it("shows one card per notice for each tenant, also when both notices are shown and the tenant changes", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    state.tenant = 0
    state.sealed = 2
    act(() => root.render(createElement(BackupRestorePage)))
    expect(cards(container, "Some backups may be missing from this list")).toBe(1)
    expect(cards(container, "older Azure backups need a recovery key")).toBe(1)
    state.tenant = 1
    state.damagedFiles = 4
    act(() => root.render(createElement(BackupRestorePage)))
    expect(cards(container, "Some backups may be missing from this list")).toBe(1)
    expect(cards(container, "older Azure backups need a recovery key")).toBe(1)
    expect(container.textContent).toContain("TenuVault cannot read 4 files")
  })
})
