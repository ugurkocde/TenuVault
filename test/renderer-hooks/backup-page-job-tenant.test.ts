import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Tenant } from "../../src/portal/contexts/TenantContext"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const make = (id: number, name: string, tenantId: string): Tenant => ({
  id, name, domain: `${name}.onmicrosoft.com`, status: "active", lastBackup: "", configCount: 0, storageUsed: "", client: "", license: "", region: "",
  tags: [], users: 0, devices: 0, complianceRate: 0, industry: "", environment: "", lastSync: "", syncStatus: "idle", policies: { compliance: 0, configuration: 0, apps: 0 },
  credentials: { tenantId, appId: "app", clientSecret: "" },
  resources: { subscriptionId: "local", subscriptionName: "local", resourceGroupName: "local", storageAccountName: `tvlocal-${tenantId}`, automationAccountName: "" } as Tenant["resources"],
})
const tenantA = make(1, "Contoso", "tenant-a")
const tenantB = make(2, "Fabrikam", "tenant-b")

const state = vi.hoisted(() => ({
  selected: null as Tenant | null,
  updateTenant: vi.fn(),
  onStarted: null as null | ((jobId: string) => void),
  modal: null as null | { tenantName: string; credentials: { tenantId: string } | null; jobId: string; onComplete: (success: boolean) => void },
}))
vi.mock("react-router-dom", () => ({ useSearchParams: () => [new URLSearchParams(), vi.fn()] }))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => [tenantA, tenantB],
  useSelectedTenant: () => ({ selectedTenantId: state.selected?.id ?? null, selectedTenant: state.selected, setSelectedTenantId: vi.fn() }),
  useTenantOperations: () => ({ updateTenant: state.updateTenant }),
}))
vi.mock("@desktop/lib/license", () => ({ useTenantPlan: () => null }))
vi.mock("@desktop/lib/bridge", () => ({ bridge: { license: { open: vi.fn() } } }))
vi.mock("@desktop/lib/backup-list", () => ({ useBackupList: () => ({ backups: [], loading: false, error: "", unresolved: 0, refresh: vi.fn() }) }))
vi.mock("@desktop/components/BackupSchedulePanel", () => ({ BackupSchedulePanel: () => null }))
vi.mock("@desktop/components/FirstBackupNote", () => ({ FirstBackupNote: () => createElement("p", null, "First backup note") }))
vi.mock("@desktop/components/RunBackupDialog", () => ({
  RunBackupDialog: ({ onStarted }: { onStarted: (jobId: string) => void }) => { state.onStarted = onStarted; return null },
}))
vi.mock("~/components/tenants/backup-progress-modal", () => ({
  BackupProgressModal: (props: NonNullable<typeof state.modal>) => { state.modal = props; return null },
}))
vi.mock("~/components/backup/backup-changes-dialog", () => ({ BackupChangesDialog: () => null }))
vi.mock("~/components/backup/restore-wizard", () => ({ RestoreWizard: () => null }))

import BackupRestorePage from "../../src/portal/app/portal/backup/page"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
})

describe("Backup page after switching tenants during a backup", () => {
  it("keeps the job on the tenant that ran it and never stamps the newly selected tenant", async () => {
    state.selected = tenantA
    const root = createRoot(document.body.appendChild(document.createElement("div")))
    roots.push(root)
    await act(async () => root.render(createElement(BackupRestorePage)))
    await act(async () => state.onStarted!("job-a"))
    expect(state.modal).toMatchObject({ tenantName: "Contoso", credentials: { tenantId: "tenant-a" }, jobId: "job-a" })

    state.selected = tenantB
    await act(async () => root.render(createElement(BackupRestorePage)))
    expect(state.modal).toMatchObject({ tenantName: "Contoso", credentials: { tenantId: "tenant-a" }, jobId: "job-a" })

    await act(async () => state.modal!.onComplete(true))
    expect(state.updateTenant).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain("First backup note")

    state.selected = tenantA
    await act(async () => root.render(createElement(BackupRestorePage)))
    expect(document.body.textContent).toContain("First backup note")
  })
})
