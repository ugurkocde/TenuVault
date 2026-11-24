import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BackupSummary } from "../../src/portal/components/backup/types"

vi.mock("../../src/renderer/components/ServiceBackupNotice", () => ({ ServiceBackupNotice: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({ backups: [] as unknown[] }))
vi.mock("react-router-dom", () => ({ useSearchParams: () => [new URLSearchParams("tab=history"), vi.fn()], Link: ({ children, to }: { children: string; to: string }) => createElement("a", { href: to }, children) }))
const tenant = vi.hoisted(() => ({ id: 1, name: "Contoso", status: "healthy", credentials: { tenantId: "11111111-1111-1111-1111-111111111111", appId: "app" }, resources: { storageAccountName: "tvlocal-11111111-1111-1111-1111-111111111111" } }))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => [tenant],
  useSelectedTenant: () => ({ selectedTenantId: tenant.id, selectedTenant: tenant, setSelectedTenantId: vi.fn() }),
  useTenantOperations: () => ({ updateTenant: vi.fn() }),
}))
vi.mock("@desktop/lib/license", () => ({ useTenantPlan: () => null }))
vi.mock("@desktop/lib/bridge", () => ({ bridge: { license: { open: vi.fn() }, backups: {} } }))
vi.mock("@desktop/lib/backup-list", () => ({
  useBackupList: () => ({ backups: state.backups, loading: false, error: "", unresolved: 0, sealed: 0, damagedFiles: 0, damagedFileNames: [], damagedKinds: { counts: { key: 0, os: 0, duplicate: 0, damaged: 0 }, codes: [], names: { key: [], os: [], duplicate: [], damaged: [] } }, refresh: async () => "updated" }),
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

const backup = (fields: Partial<BackupSummary>): BackupSummary => ({
  id: "backup-2026-11-10-020000", timestamp: "2026-11-10T02:00:00Z", type: "scheduled", status: "Success", totalPolicies: 12, counts: { DeviceConfigurations: 12 },
  scope: { excluded: [], description: "Everything" }, failures: 0, skippedTypes: [], failedTypes: [], size: 2048, duration: 30, changes: null, comparedWith: null, ...fields,
})

function renderBackup(entry: BackupSummary): HTMLDivElement {
  state.backups = [entry]
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(BackupRestorePage)))
  return container
}

const details = (entry: BackupSummary) => renderBackup(entry).textContent ?? ""

describe("Backup Details and coverage", () => {
  it("qualifies an empty comparison on the history card when some types could not be compared", () => {
    const page = renderBackup(backup({ changes: { added: 0, modified: 0, removed: 0 }, comparedWith: "older", unknownTypes: ["DeviceConfigurations"] }))
    const text = [...page.querySelectorAll("button")].find(button => button.textContent?.includes("Changes") && button.querySelector("h3"))?.textContent
    expect(text).toContain("No changes found in the types compared.")
    expect(text).toContain("1 type not compared")
  })

  it("keeps unknown coverage visible and names each type in Details", () => {
    // A scheduled backup as the Backup Reader: nothing failed and nothing was denied, yet two types are not in it.
    const text = details(backup({ coverage: "incomplete", notRead: ["DeviceCategories", "DeviceCleanupRules"] }))
    expect(text).toContain("Backup Details")
    expect(text).toContain("Coverage unknown for 2 types.")
  })

  it("deduplicates a missing type, keeps failures visible, and shows one action", () => {
    const page = renderBackup(backup({
      coverage: "incomplete", failures: 3, notRead: ["PowerShellScripts", "DeviceCategories"], failedTypes: ["DeviceCategories"],
      skippedTypes: ["PowerShellScripts", "PowerShellScripts"], notReadCauses: { PowerShellScripts: "permission" },
    }))
    const card = page.querySelector('[data-notice-tone="error"]')!
    expect(card.querySelector('[role="alert"]')?.textContent).toBe("3 items or types could not be read. Needs access for 1 backup type.")
    const toggle = card.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!
    expect(panel.hidden).toBe(true)
    expect(card.querySelectorAll("a")).toHaveLength(1)
    expect(card.querySelector('[aria-label^="Dismiss"]')).toBeNull()
    act(() => toggle.click())
    expect(panel.hidden).toBe(false)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(panel.textContent).toContain("Intune (2)")
    const entries = [...panel.querySelectorAll("li > p")].map(row => row.textContent?.toLowerCase())
    expect(entries.filter(label => label === "windows powershell scripts")).toHaveLength(1)
    expect(entries).toContain("device categories")
  })

  it("reports only recorded omissions for a legacy backup without a selected scope", () => {
    const text = details(backup({ coverage: null, readableTypes: ["DeviceConfigurations"], skippedTypes: ["PowerShellScripts"] }))
    expect(text).toContain("Needs access for 1 backup type.")
    expect(text).not.toContain("Coverage unknown for")
  })

  it("shows nothing about coverage for a complete backup, or for one made before coverage was recorded", () => {
    expect(details(backup({ coverage: "complete", notRead: [] }))).not.toContain("Coverage incomplete")
    expect(details(backup({ coverage: null, notRead: [] }))).not.toContain("Coverage incomplete")
    expect(details(backup({}))).not.toContain("Coverage incomplete")
  })
})
