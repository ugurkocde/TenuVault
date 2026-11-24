vi.mock("@desktop/components/ServiceBackupNotice", () => ({ ServiceBackupNotice: () => null }))
import { act, createElement, useState, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppMetadataRemoval } from "../../src/shared/app-metadata-removal"
import type { Tenant } from "../../src/portal/contexts/TenantContext"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const removalStatus = vi.hoisted(() => vi.fn<(_tenant: string, _retry?: boolean) => Promise<AppMetadataRemoval | undefined>>())
vi.mock("@desktop/lib/bridge", () => ({ bridge: { auth: { appMetadataRemoval: removalStatus } } }))

const tenant: Tenant = {
  id: 1, name: "Contoso", domain: "contoso.onmicrosoft.com", status: "active", lastBackup: "", configCount: 0, storageUsed: "", client: "", license: "", region: "",
  tags: [], users: 0, devices: 0, complianceRate: 0, industry: "", environment: "", lastSync: "", syncStatus: "idle", policies: { compliance: 0, configuration: 0, apps: 0 },
  credentials: { tenantId: "tenant", appId: "app", clientSecret: "" },
  resources: { subscriptionId: "local", subscriptionName: "local", resourceGroupName: "local", storageAccountName: "tvlocal-tenant", automationAccountName: "" } as Tenant["resources"],
}

// An in-memory tenant store with the operations the Tenants page and the backup progress provider use.
const store = vi.hoisted(() => ({ tenants: [] as Tenant[], set: null as null | ((tenants: Tenant[]) => void) }))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => store.tenants,
  useTenantOperations: () => ({
    addTenant: vi.fn(), deleteTenant: vi.fn(), getTenant: (id: number) => store.tenants.find((item) => item.id === id),
    updateTenant: (id: number, updates: Partial<Tenant>) => store.set!(store.tenants.map((item) => item.id === id ? { ...item, ...updates } : item)),
  }),
  useTenantAzureSync: () => ({ loadTenantFromAzure: vi.fn(), syncTenantToAzureDirect: vi.fn() }),
}))
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }))
vi.mock("@desktop/lib/schedules", () => ({ useSchedules: () => ({ schedules: [], error: null, loading: false, reload: () => undefined }), formatWhen: () => "" }))
vi.mock("@desktop/lib/license", () => ({ useLicense: () => ({ status: null }), tenantLicense: () => null, tenantPlan: () => null, planName: () => "Community" }))
vi.mock("@desktop/components/PlanGate", () => ({ GatedButton: () => null }))
vi.mock("@desktop/components/UpgradeNote", () => ({ PlanBadge: () => null }))
// Choosing what to back up starts the job at once.
vi.mock("@desktop/components/RunBackupDialog", () => ({
  RunBackupDialog: ({ open, onStarted }: { open: boolean; onStarted: (jobId: string) => void }) => open ? createElement("button", { type: "button", onClick: () => onStarted("job-1") }, "Start chosen backup") : null,
}))
vi.mock("~/components/tenants/backup-progress-modal", () => ({ BackupProgressModal: () => null }))
vi.mock("~/components/tenants/add-tenant-modal-redesigned", () => ({ AddTenantModal: () => null }))
vi.mock("~/components/tenants/tag-management-modal", () => ({ TagManagementModal: () => null }))

import TenantsPage from "../../src/portal/app/portal/tenants/page"
import { BackupProgressProvider } from "../../src/portal/contexts/BackupProgressContext"

function Harness({ children }: { children: ReactNode }) {
  const [tenants, setTenants] = useState<Tenant[]>([tenant])
  store.tenants = tenants
  store.set = (next) => { store.tenants = next; setTenants(next) }
  return createElement(BackupProgressProvider, null, children)
}

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  removalStatus.mockReset()
})

const backupNow = () => [...document.querySelectorAll("button")].find((button) => /Backup Now|Backing up|Backup queued|Backup running/.test(button.textContent ?? "")) as HTMLButtonElement

describe("Tenants page after a backup the user cancelled", () => {
  it("enables Backup Now again once the cancelled job ends", async () => {
    vi.useFakeTimers()
    // The job runs until the user cancels it.
    let cancelled = false
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/api/backup/status")
      ? Response.json(cancelled
        ? { status: "Cancelled", progress: 100, progressMessage: "Backup cancelled", endTime: "2026-10-17T10:00:00Z", exception: "Backup cancelled by you. This run is never offered as a complete backup.", isComplete: true, isSuccessful: false }
        : { status: "Running", progress: 40, progressMessage: "Backing up", isComplete: false, isSuccessful: false })
      : Response.json({})))
    const container = document.body.appendChild(document.createElement("div"))
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(createElement(Harness, null, createElement(MemoryRouter, null, createElement(TenantsPage)))))
    expect(backupNow().disabled).toBe(false)

    await act(async () => backupNow().click())
    const start = [...document.querySelectorAll("button")].find((button) => button.textContent === "Start chosen backup")!
    await act(async () => start.click())
    expect(store.tenants[0]!.syncStatus).toBe("pending")
    expect(backupNow().disabled).toBe(true)
    expect(backupNow().textContent).toContain("Backing up... 40%")

    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    expect(backupNow().disabled).toBe(true)
    expect(backupNow().textContent).toContain("Backing up... 40%")
    // The shared poller reads the job's end: cancelled by the user.
    cancelled = true
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    expect(store.tenants[0]).toMatchObject({ syncStatus: "idle", lastSync: "2026-10-17T10:00:00Z" })
    expect(backupNow().disabled).toBe(false)
    expect(backupNow().textContent).toContain("Backup Now")
  })

  it("shows saved permission removal on the tenant card and reports a verified retry", async () => {
    const pending: AppMetadataRemoval = {
      runId: "directory-page",
      status: "pending",
      scopes: [{ consentType: "AllPrincipals", principalId: null, scope: "DelegatedPermissionGrant.ReadWrite.All" }],
      missingPriorScopes: [{ consentType: "AllPrincipals", principalId: null, scope: "User.Read" }],
    }
    removalStatus.mockImplementation(async (_tenant, retry) => retry ? { ...pending, status: "verified" } : pending)
    const container = document.body.appendChild(document.createElement("div"))
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(createElement(Harness, null, createElement(MemoryRouter, null, createElement(TenantsPage)))))
    const notice = container.querySelector('[aria-label="Temporary permission removal pending"]')
    expect(notice?.textContent).toContain("DelegatedPermissionGrant.ReadWrite.All")
    expect(notice?.textContent).toContain("Previously granted User.Read is now missing from admin consent. TenuVault left it revoked.")
    const retry = [...notice!.querySelectorAll("button")].find(button => button.textContent === "Retry removal")
    await act(async () => retry!.click())
    expect(removalStatus).toHaveBeenCalledWith(tenant.credentials!.tenantId, true)
    expect(container.textContent).toContain("Temporary permission removal verified")
    expect(container.textContent).toContain("Previously granted User.Read is now missing from admin consent. TenuVault left it revoked.")
    expect(container.querySelector('[aria-label="Temporary permission removal pending"]')).toBeNull()
  })

})
