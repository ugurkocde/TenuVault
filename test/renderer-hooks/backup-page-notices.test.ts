import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BackupSummary } from "../../src/portal/components/backup/types"

vi.mock("../../src/renderer/components/ServiceBackupNotice", () => ({ ServiceBackupNotice: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({ warnings: [] as string[], tenant: 0, damagedFiles: 3, sealed: 0, refresh: (() => Promise.resolve("updated")) as () => Promise<string> }))
const downloadState = vi.hoisted(() => ({ rows: [] as BackupSummary[], storage: "", search: "" }))
const backups = vi.hoisted(() => ({ importRecoveryKey: vi.fn(), openFolder: vi.fn() }))
vi.mock("react-router-dom", () => ({ useSearchParams: () => [new URLSearchParams(downloadState.search), vi.fn()] }))
const tenants = vi.hoisted(() => [
  { id: 1, name: "Contoso", status: "healthy", credentials: { tenantId: "11111111-1111-1111-1111-111111111111", appId: "app" }, resources: { storageAccountName: "tvlocal-11111111-1111-1111-1111-111111111111" } },
  { id: 2, name: "Fabrikam", status: "healthy", credentials: { tenantId: "22222222-2222-2222-2222-222222222222", appId: "app" }, resources: { storageAccountName: "tvlocal-22222222-2222-2222-2222-222222222222" } },
])
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => tenants,
  useSelectedTenant: () => {
    const tenant = tenants[state.tenant]!
    return { selectedTenantId: tenant.id, selectedTenant: downloadState.storage ? { ...tenant, resources: { storageAccountName: downloadState.storage } } : tenant, setSelectedTenantId: vi.fn() }
  },
  useTenantOperations: () => ({ updateTenant: vi.fn() }),
}))
vi.mock("@desktop/lib/license", () => ({ useTenantPlan: () => null }))
vi.mock("@desktop/lib/bridge", () => ({ bridge: { license: { open: vi.fn() }, backups } }))
vi.mock("@desktop/lib/backup-list", () => ({
  useBackupList: () => ({ warnings: state.warnings, backups: downloadState.rows, loading: false, error: "", unresolved: 0, sealed: state.sealed, damagedFiles: state.damagedFiles, damagedFileNames: [], damagedKinds: { counts: { key: state.damagedFiles, os: 0, duplicate: 0, damaged: 0 }, codes: [], names: { key: [], os: [], duplicate: [], damaged: [] } }, refresh: () => state.refresh() }),
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
  downloadState.rows = []
  downloadState.storage = ""
  downloadState.search = ""
  vi.unstubAllGlobals()
})

describe("Backup Details", () => {
  function renderBackup(fields: Record<string, unknown> = {}) {
    state.tenant = 0
    downloadState.rows = [{ id: "backup-2020-01-01-000000", timestamp: "2020-01-01T00:00:00Z", status: "Success", totalPolicies: 1, type: null, scope: null, size: 1, duration: null, changes: null, comparedWith: null, ...fields }]
    const container = document.body.appendChild(document.createElement("div"))
    const root = createRoot(container)
    roots.push(root)
    const render = () => act(() => root.render(createElement(BackupRestorePage)))
    render()
    const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === label)
    return { container, button, render }
  }

  it("shows an Intune-only backup as excluded when opened through the Defender filter", () => {
    downloadState.search = "service=defender"
    const { container } = renderBackup({ scope: { included: ["ConfigurationPolicies"], excluded: [], description: "Everything" } })
    const defender = container.querySelector('section[aria-label="Defender"]')!
    expect(defender.textContent).toContain("Not included in this backup")
    expect(defender.textContent).not.toContain("None in the tenant")
    expect(defender.querySelector("details")).toBeNull()
  })

  it("shows an unread type with its reason even if the backup holds some of its policies", () => {
    const { container } = renderBackup({
      scope: { included: ["CompliancePolicies"], excluded: [], description: "Custom" },
      counts: { CompliancePolicies: 1 },
      coverage: "incomplete",
      notRead: ["CompliancePolicies"],
      notReadReasons: { CompliancePolicies: "The read timed out." },
    })
    const row = [...container.querySelectorAll("details li")].find(node => node.textContent?.startsWith("Compliance policies"))!
    expect(row.textContent).toContain("Not read: The read timed out.")
    expect(row.textContent).not.toContain("None in the tenant")
  })

  it("labels the result Finished in the list and Run status when coverage is incomplete", () => {
    const { container } = renderBackup({
      coverage: "incomplete",
      scope: { included: ["CompliancePolicies", "DeviceConfigurations"], excluded: [], description: "Custom" },
      readableTypes: ["CompliancePolicies"],
      notRead: ["DeviceConfigurations"],
      notReadCauses: { DeviceConfigurations: "permission" },
    })
    expect([...container.querySelectorAll("button span")].map(node => node.textContent)).toContain("Finished")
    const status = [...container.querySelectorAll("dt")].find(node => node.textContent === "Run status")
    expect(status?.nextElementSibling?.textContent).toBe("Finished")
    expect(container.querySelector('[aria-label="Intune backup coverage"]')?.textContent).toContain("1 of 2")
    expect(container.querySelector('[aria-label="Intune backup coverage"]')?.textContent).toContain("Permission not granted")
  })

  it("shows a type read successfully with zero results as empty even when other reads failed", () => {
    const { container } = renderBackup({
      status: "CompletedWithWarnings",
      scope: { included: ["CompliancePolicies", "ConfigurationPolicies"], excluded: [], description: "Custom" },
      emptyTypes: ["CompliancePolicies"],
      notRead: ["ConfigurationPolicies"],
    })
    const row = [...container.querySelectorAll("details li")].find(node => node.textContent?.startsWith("Compliance policies"))!
    expect(row.textContent).toContain("None in the tenant")
  })

  it("keeps partial counts separate from confirmed empty and unknown coverage", () => {
    const { container } = renderBackup({
      scope: { included: ["ConfigurationPolicies", "CompliancePolicies", "DeviceConfigurations"], excluded: [], description: "Custom" },
      counts: { DeviceConfigurations: 3 },
      readableTypes: ["CompliancePolicies"],
      notRead: ["DeviceConfigurations"],
      notReadCauses: { DeviceConfigurations: "role" },
      emptyTypes: ["CompliancePolicies"],
    })
    const coverage = container.querySelector('[aria-label="Intune backup coverage"]')!
    expect(coverage.textContent).toContain("1 of 3")
    expect(coverage.textContent).toContain("1 unknown")
    expect(coverage.textContent).toContain("Your role can't do this")
    const row = [...container.querySelectorAll("details li")].find(node => node.textContent?.includes("Not read:"))!
    expect(row.textContent).toContain("3")
    expect(row.textContent).toContain("Your role can't do this")
    expect(container.textContent).toContain("None in the tenant")
  })

  it("keeps full Download enabled beside Download ordinary only when the companion is temporarily unreadable", async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({ saved: true }))
    vi.stubGlobal("fetch", fetch)
    const { container, button } = renderBackup({ ordinaryOnlyAvailable: true })
    expect(button("Download")?.disabled).toBe(false)
    expect(button("Download ordinary only")?.disabled).toBe(false)
    await click(container, "Download")
    await click(container, "Download ordinary only")
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      expect.objectContaining({ ordinaryOnly: false, largeInventory: true }),
      expect.objectContaining({ ordinaryOnly: true, largeInventory: true }),
    ])
  })

  it("offers ordinary-only after a 503 only for the backup list that started the download", async () => {
    vi.stubGlobal("alert", vi.fn())
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ordinaryOnlyAvailable: true }, { status: 503 })))
    const { container, button, render } = renderBackup()
    await click(container, "Download")
    expect(button("Download")?.disabled).toBe(false)
    expect(button("Download ordinary only")?.disabled).toBe(false)
    downloadState.rows = [...downloadState.rows]
    render()
    expect(button("Download")?.disabled).toBe(false)
    expect(button("Download ordinary only")).toBeUndefined()
  })

  it.each(["tenant", "storage"])("drops a late ordinary-only offer after switching %s away and back", async scope => {
    vi.stubGlobal("alert", vi.fn())
    let finish!: (response: Response) => void
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const { container, button, render } = renderBackup()
    await click(container, "Download")
    if (scope === "tenant") state.tenant = 1
    else downloadState.storage = "anotheraccount"
    render()
    state.tenant = 0
    downloadState.storage = ""
    render()
    await act(async () => finish(Response.json({ ordinaryOnlyAvailable: true }, { status: 503 })))
    expect(button("Download")?.disabled).toBe(false)
    expect(button("Download ordinary only")).toBeUndefined()
  })
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
  it("shows the large-storage provisioning warning without hiding ordinary history", () => {
    state.warnings = ["Storage not provisioned for large backups. Rerun New-TenuVaultStorage.ps1 -BackupReaderAppId <application ID>."]
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(BackupRestorePage)))
    const warning = [...container.querySelectorAll('[role="status"]')].find(node => node.textContent?.includes("Storage not provisioned for large backups"))!
    expect(warning.textContent).toContain("New-TenuVaultStorage.ps1")
    expect(warning.classList.contains("bg-blue-50")).toBe(true)
    state.warnings = []
  })

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
