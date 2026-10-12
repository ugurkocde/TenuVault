import { isValidElement, type ReactNode } from "react"
import { beforeEach, expect, it, vi } from "vitest"
import BackupRestorePage from "../src/portal/app/portal/backup/page"

const state = vi.hoisted(() => ({
  tenants: [
    { id: 1, name: "Contoso", credentials: { tenantId: "tenant-a", appId: "app" }, resources: { storageAccountName: "tvlocal-tenant-a" } },
    { id: 2, name: "Fabrikam", credentials: { tenantId: "tenant-b", appId: "app" }, resources: { storageAccountName: "tvlocal-tenant-b" } },
  ],
  selectedId: 1 as number | null,
  params: new URLSearchParams(),
  effects: [] as Array<() => unknown>,
  select: vi.fn(),
  setParams: vi.fn(),
}))
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useEffect: (effect: () => unknown) => { state.effects.push(effect) },
  useMemo: (value: () => unknown) => value(),
  useRef: (initial: unknown) => ({ current: initial }),
}))
vi.mock("react-router-dom", () => ({ useSearchParams: () => [state.params, state.setParams] }))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => state.tenants,
  useSelectedTenant: () => ({ selectedTenantId: state.selectedId, selectedTenant: state.tenants.find(tenant => tenant.id === state.selectedId), setSelectedTenantId: state.select }),
  useTenantOperations: () => ({ updateTenant: vi.fn() }),
}))
vi.mock("@desktop/lib/license", () => ({ useTenantPlan: () => null }))
vi.mock("@desktop/lib/bridge", () => ({ bridge: { license: { open: vi.fn() } } }))
vi.mock("@desktop/lib/backup-list", () => ({ useBackupList: () => ({ backups: [], loading: false, error: "", refresh: vi.fn() }) }))
vi.mock("@desktop/components/BackupSchedulePanel", () => ({ BackupSchedulePanel: "schedule-panel" }))
vi.mock("@desktop/components/RunBackupDialog", () => ({ RunBackupDialog: () => null }))
vi.mock("~/components/tenants/backup-progress-modal", () => ({ BackupProgressModal: () => null }))
vi.mock("~/components/backup/backup-changes-dialog", () => ({ BackupChangesDialog: () => null }))
vi.mock("~/components/backup/restore-wizard", () => ({ RestoreWizard: () => null }))

function scheduleTenant(node: ReactNode): unknown {
  if (Array.isArray(node)) return node.map(scheduleTenant).find(value => value !== undefined)
  if (!isValidElement<{ children?: ReactNode; tenantId?: string }>(node)) return undefined
  return node.type === "schedule-panel" ? node.props.tenantId : scheduleTenant(node.props.children)
}

beforeEach(() => {
  state.selectedId = 1
  state.params = new URLSearchParams("tab=schedule&tenant=TENANT-B")
  state.effects = []
  state.select.mockReset().mockImplementation((id: number) => { state.selectedId = id })
  state.setParams.mockReset().mockImplementation((params: URLSearchParams) => { state.params = params })
})

it.each([1, null])("opens the notified tenant's Schedule tab from selected tenant %s", (selectedId) => {
  state.selectedId = selectedId
  BackupRestorePage()
  state.effects[0]!()
  state.effects[1]!()
  expect(state.select).toHaveBeenCalledExactlyOnceWith(2)
  expect(state.setParams).toHaveBeenCalledWith(expect.any(URLSearchParams), { replace: true })
  expect(state.params.toString()).toBe("tab=schedule")
  expect(scheduleTenant(BackupRestorePage())).toBe("tenant-b")
})

it("keeps the selected tenant when the notification names a disconnected tenant", () => {
  state.params = new URLSearchParams("tab=schedule&tenant=removed")
  BackupRestorePage()
  state.effects[0]!()
  expect(state.select).not.toHaveBeenCalled()
  expect(state.params.toString()).toBe("tab=schedule")
})
