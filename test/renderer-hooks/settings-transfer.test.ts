import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TransferPreview } from "../../src/shared/settings-transfer"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TENANT = "aaaaaaaa-1111-4111-8111-111111111111"
const settingsTransfer = vi.hoisted(() => ({ export: vi.fn(), import: vi.fn(), preview: vi.fn(), apply: vi.fn() }))
const services = vi.hoisted(() => ({ status: vi.fn() }))

vi.mock("../../src/renderer/lib/appearance", () => ({ getAppearance: () => "system", setAppearance: vi.fn() }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { settingsTransfer, services } }))
vi.mock("../../src/portal/contexts/TenantContext", () => ({
  useTenants: () => [{ id: 1, name: "Contoso", domain: "contoso.onmicrosoft.com", credentials: { tenantId: TENANT, appId: "client" } }],
}))

import { ImportDialog, missingPermissions } from "../../src/renderer/components/SettingsTransfer"

const PREVIEW: TransferPreview = {
  importId: "import-1",
  exportedAt: "2026-11-20T08:00:00.000Z",
  appVersion: "0.6.0",
  skipped: ['Section "alerts"'],
  groups: [
    {
      id: "app", title: "This computer", connected: true, items: [
        { id: "app:retentionDays", label: "Keep backups for", current: "30 days", next: "90 days", status: "change", selected: true },
        { id: "app:nightlyUpdates", label: "Get nightly builds", current: "Off", next: "On", status: "change", warning: "This switches this computer between stable releases and nightly builds.", selected: false },
        { id: "app:pdfBranding", label: "PDF branding", current: "TenuVault design", next: "Contoso", status: "blocked", reason: "PDF branding is included in Pro and MSP.", feature: "pdfBranding", selected: false },
        { id: "app:keepRunningInTray", label: "Keep running when I close the window", current: "On", next: "On", status: "same", selected: false },
      ],
    },
    { id: TENANT, title: "Contoso", connected: true, items: [{ id: `${TENANT}:service:conditionalAccess`, label: "Entra Conditional Access", current: "Off", next: "On", status: "change", selected: true }] },
    { id: "bbbbbbbb-2222-4222-8222-222222222222", title: "Fabrikam", connected: false, notice: "This tenant is not connected on this computer, so its settings are skipped.", items: [], setup: { tenantId: "bbbbbbbb-2222-4222-8222-222222222222", name: "Fabrikam", clientId: "c" } },
  ],
}

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  vi.resetAllMocks()
})

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function render(onApplied = vi.fn()) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const client = new QueryClient()
  act(() => root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(ImportDialog, { preview: PREVIEW, onClose: vi.fn(), onApplied, onExportFirst: vi.fn() })))))
  return { onApplied }
}

const checkbox = (label: string) => document.querySelector<HTMLButtonElement>(`button[role="checkbox"][id="${[...document.querySelectorAll("label")].find((entry) => entry.textContent?.startsWith(label))?.htmlFor}"]`)
const button = (text: string) => [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === text)

describe("settings import preview", () => {
  it("selects plain changes, leaves warned items unticked, blocks the rest and hides what is the same", () => {
    render()
    expect(checkbox("Keep backups for")?.getAttribute("data-state")).toBe("checked")
    expect(checkbox("Get nightly builds")?.getAttribute("data-state")).toBe("unchecked")
    expect(checkbox("PDF branding")?.disabled).toBe(true)
    expect(document.body.textContent).toContain("PDF branding is included in Pro and MSP.")
    expect(document.body.textContent).not.toContain("Keep running when I close the window")
    expect(document.body.textContent).toContain("Connect this tenant")
    expect(document.body.textContent).toContain('Section "alerts"')
    expect(button("Apply 2 settings")).toBeDefined()

    act(() => checkbox("Show settings that are already the same")!.click())
    expect(document.body.textContent).toContain("Keep running when I close the window")
    expect(checkbox("Keep running when I close the window")?.disabled).toBe(true)
  })

  it("applies only the chosen items, then shows the result and the permission check", async () => {
    settingsTransfer.apply.mockResolvedValue({
      items: [
        { id: "app:retentionDays", group: "app", label: "Keep backups for", outcome: "applied" },
        { id: "app:nightlyUpdates", group: "app", label: "Get nightly builds", outcome: "applied" },
        { id: `${TENANT}:service:conditionalAccess`, group: TENANT, label: "Entra Conditional Access", outcome: "applied" },
      ],
      servicesEnabled: { [TENANT]: ["conditionalAccess"] },
    })
    services.status.mockResolvedValue({
      tenantId: TENANT, checkedAt: null,
      modules: [{ id: "conditionalAccess", label: "Entra Conditional Access", description: "", switchable: true, enabled: true, access: "restore", roles: "", check: { id: "conditionalAccess", label: "Entra Conditional Access", backup: "ready", restore: "missing", areas: [] } }],
    })
    const { onApplied } = render()
    act(() => checkbox("Get nightly builds")!.click())
    await act(async () => button("Apply 3 settings")!.click())
    await flush()
    expect(settingsTransfer.apply).toHaveBeenCalledWith("import-1", ["app:retentionDays", "app:nightlyUpdates", `${TENANT}:service:conditionalAccess`], "system")
    expect(onApplied).toHaveBeenCalled()
    expect(services.status).toHaveBeenCalledWith(TENANT, "client")
    expect(document.body.textContent).toContain("Settings applied")
    expect(document.body.textContent).toContain("Entra ID: Conditional Access: permissions for restores are missing.")
  })
})

describe("missingPermissions", () => {
  it("names enabled modules without the permissions they need, and check failures", () => {
    expect(missingPermissions({ tenantId: TENANT, checkedAt: null, modules: [], error: "Sign in again." })).toEqual(["The permissions could not be checked: Sign in again."])
    expect(missingPermissions({ tenantId: TENANT, checkedAt: null, modules: [
      { id: "intune", label: "Intune", description: "", switchable: true, enabled: true, access: "backup", roles: "", check: { id: "intune", label: "Intune", backup: "ready", restore: "ready", areas: [] } },
      { id: "conditionalAccess", label: "Entra Conditional Access", description: "", switchable: true, enabled: false, access: "restore", roles: "", check: { id: "conditionalAccess", label: "Entra Conditional Access", backup: "missing", restore: "missing", areas: [] } },
    ] })).toEqual([])
    const modules = [
      { id: "conditionalAccess", label: "Entra Conditional Access", description: "", switchable: true, enabled: true, access: "restore", roles: "", check: { id: "conditionalAccess", label: "Entra Conditional Access", backup: "missing", restore: "ready", areas: [] } },
      { id: "intune", label: "Intune", description: "", switchable: true, enabled: true, access: "backup", roles: "", check: { id: "intune", label: "Intune", backup: "missing", restore: "missing", areas: [] } },
    ] as Parameters<typeof missingPermissions>[0]["modules"]
    // Only the services the import turned on are checked.
    expect(missingPermissions({ tenantId: TENANT, checkedAt: null, modules }, ["conditionalAccess"])).toEqual(["Entra ID: Conditional Access: permissions for backups are missing."])
    // A service set to backup only is not expected to have restore permissions.
    expect(missingPermissions({ tenantId: TENANT, checkedAt: null, modules: [
      { id: "entra", label: "Entra ID", description: "", switchable: true, enabled: true, access: "backup", roles: "", check: { id: "entra", label: "Entra ID", backup: "ready", restore: "missing", areas: [] } },
    ] })).toEqual([])
  })
})
