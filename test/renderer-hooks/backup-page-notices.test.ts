import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({ tenant: 0, damagedFiles: 3, sealed: 0, refresh: (() => Promise.resolve("updated")) as () => Promise<string> }))
const backups = vi.hoisted(() => ({ importRecoveryKey: vi.fn(), openFolder: vi.fn() }))
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
vi.mock("@desktop/lib/bridge", () => ({ bridge: { license: { open: vi.fn() }, backups } }))
vi.mock("@desktop/lib/backup-list", () => ({
  useBackupList: () => ({ backups: [], loading: false, error: "", unresolved: 0, sealed: state.sealed, damagedFiles: state.damagedFiles, damagedFileNames: [], damagedKinds: { counts: { key: state.damagedFiles, os: 0, duplicate: 0, damaged: 0 }, codes: [], names: { key: [], os: [], duplicate: [], damaged: [] } }, refresh: () => state.refresh() }),
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

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)
  if (!button) throw new Error(`No button ${label}`)
  await act(async () => button.click())
  await flush()
}

const cards = (container: HTMLElement, title: string) => [...container.querySelectorAll("[role=status]")].filter((card) => card.querySelector("p.font-medium")?.textContent?.includes(title)).length

describe("Backup History notices", () => {
  it("shows one card per notice for each tenant, also when both notices are shown and the tenant changes", () => {
    state.damagedFiles = 3
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

  it.each(["updated", "failed"])("keeps a key import check started for one tenant off the next tenant's card when it ends %s after the switch", async (outcome) => {
    backups.importRecoveryKey.mockResolvedValue({ localFolder: "/backups", keyFingerprint: "BBBB", recoveryExported: true, hasLocalBackups: true })
    let finish!: () => void
    state.refresh = () => new Promise((resolve) => { finish = () => resolve(outcome) })
    state.tenant = 0
    state.sealed = 0
    state.damagedFiles = 3
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(BackupRestorePage)))
    await click(container, "Show file names (3)")
    await click(container, "Import recovery key")
    const textarea = container.querySelector("textarea")!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    act(() => {
      setter.call(textarea, "TVK2.example")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await click(container, "Import")
    expect(container.textContent).toContain("Checking the backups again...")

    // The admin selects the second tenant while the first tenant's list is still read again.
    state.tenant = 1
    state.damagedFiles = 4
    act(() => root.render(createElement(BackupRestorePage)))
    await act(async () => finish())
    await flush()

    expect(container.textContent).toContain("TenuVault cannot read 4 files")
    const toggle = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("file names"))!
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(toggle.textContent?.trim()).toBe("Show file names (4)")
    expect(container.querySelector("textarea")).toBeNull()
    expect(container.textContent).not.toContain("Checking the backups again...")
    expect(container.textContent).not.toContain("still cannot read")
    expect(container.textContent).not.toContain("could not be checked again")
    state.refresh = () => Promise.resolve("updated")
  })
})
