import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { BackupSettings, LicenseStatus, SignedInAccount } from "../../src/shared/ipc"
import type { Tenant } from "../../src/portal/contexts/TenantContext"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  store: new Map<string, string>(),
  status: null as LicenseStatus | null,
  accounts: [] as SignedInAccount[],
  setItem: vi.fn<(...args: [string, string]) => Promise<void>>(),
  releaseTenant: vi.fn(),
  verifyAzureStorage: vi.fn(async () => undefined),
  addJob: vi.fn(), updateJob: vi.fn(), removeJob: vi.fn(),
  fetch: vi.fn(),
}))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: {
  storage: {
    getItemSync: (key: string) => state.store.get(key) ?? null,
    setItem: state.setItem,
    removeItem: async (key: string) => { state.store.delete(key) },
  },
  license: { status: async () => state.status, checkNewTenant: async () => state.status, releaseTenant: state.releaseTenant, trialWorkflowsConfigured: async () => false },
  auth: { accounts: async () => state.accounts },
  backups: {
    settings: async (): Promise<BackupSettings> => ({ localFolder: "/backups", keyFingerprint: "fixture", recoveryExported: true, hasLocalBackups: false }),
    inventoryProblem: async () => null, verifyAzureStorage: state.verifyAzureStorage,
  },
} }))
vi.mock("../../src/renderer/lib/license", async original => ({
  ...await original<typeof import("../../src/renderer/lib/license")>(),
  useLicense: () => ({ status: state.status, refresh: async () => undefined }),
  useTenantPlan: () => "pro",
}))
vi.mock("~/contexts/BackupProgressContext", () => ({ useBackupProgress: () => ({
  activeJobs: [], addJob: state.addJob, updateJob: state.updateJob, removeJob: state.removeJob,
}) }))
vi.mock("../../src/renderer/lib/desktop-tenant", () => ({ buildTenantProfile: async (credentials: Record<string, string>) => ({
  id: 1, name: "Contoso", credentials, policies: { compliance: 0, configuration: 0, apps: 0 }, tags: [],
}) }))

let OnboardingPage: typeof import("../../src/renderer/pages/OnboardingPage").default
let TenantProvider: typeof import("../../src/portal/contexts/TenantContext").TenantProvider
let useTenantOperations: typeof import("../../src/portal/contexts/TenantContext").useTenantOperations
let operations: ReturnType<typeof useTenantOperations>
let useTenants: typeof import("../../src/portal/contexts/TenantContext").useTenants
let loadOnboardingDraft: typeof import("../../src/renderer/lib/onboarding-draft").loadOnboardingDraft

const TENANT = "8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14"
const SECOND_TENANT = "11111111-1111-4111-8111-111111111111"
const CLIENT = "5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3"
const DRAFT = "tenuvault.onboarding.draft"
const TENANTS = "tenuvault_tenants"
const account = { tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.example" }
const azure = { name: "contosobackups", subscriptionId: "sub", resourceGroup: "rg", location: "westeurope" }
let root: Root | undefined
let container: HTMLDivElement

beforeEach(async () => {
  vi.resetModules()
  vi.doMock("~/lib/tenant-storage", async () => import("../../src/renderer/overrides/tenant-storage"))
  vi.clearAllMocks()
  state.store.clear()
  state.accounts = [account]
  state.status = { tenants: [{ ...account, activated: true, entitled: true, plan: "pro", source: "trial", trial: true, trialAcknowledged: false, trialEndsAt: new Date(Date.now() + 86400_000).toISOString() }] } as unknown as LicenseStatus
  state.store.set(DRAFT, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "Contoso", account }))
  state.setItem.mockImplementation(async (key, value) => { state.store.set(key, value) })
  state.releaseTenant.mockImplementation(async (tenantId: string) => { state.accounts = state.accounts.filter(account => account.tenantId !== tenantId) })
  state.fetch.mockImplementation(async () => Response.json({ storageAccounts: [azure] }))
  vi.stubGlobal("fetch", state.fetch)
  container = document.createElement("div")
  document.body.appendChild(container)
  ;({ default: OnboardingPage } = await import("../../src/renderer/pages/OnboardingPage"))
  ;({ TenantProvider, useTenants, useTenantOperations } = await import("../../src/portal/contexts/TenantContext"))
  ;({ loadOnboardingDraft } = await import("../../src/renderer/lib/onboarding-draft"))
})
afterEach(async () => {
  if (root) act(() => root!.unmount())
  root = undefined
  await flush()
  container.remove()
  vi.unstubAllGlobals()
})
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
function TenantCount() { operations = useTenantOperations(); return createElement("output", { "data-testid": "tenants" }, useTenants().length) }
async function render() {
  root = createRoot(container)
  await act(async () => root!.render(createElement(MemoryRouter, { initialEntries: ["/portal/onboarding"] },
    createElement(TenantProvider, null, createElement(TenantCount), createElement(Routes, null,
      createElement(Route, { path: "/portal/onboarding", element: createElement(OnboardingPage) }),
      createElement(Route, { path: "/portal/dashboard", element: createElement("p", null, "Dashboard") }),
    )),
  )))
  await flush()
}
const button = (label: string) => [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === label)!
async function click(label: string) { expect(button(label)).toBeTruthy(); await act(async () => button(label).click()); await flush() }
async function chooseAzure() {
  const choice = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Your Azure storage account"))!
  await act(async () => choice.click())
  await flush()
  const select = container.querySelector("select")!
  await act(async () => {
    select.value = azure.name
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await click("Check access")
}

it("preserves an unfinished tenant sign-in during real provider startup cleanup", async () => {
  await render()
  expect(state.releaseTenant).not.toHaveBeenCalled()
  expect(state.accounts).toEqual([account])
  expect(container.textContent).toContain("Choose where backups are stored")
})

it("keeps verified Azure storage when going back to sign-in and returning", async () => {
  await render()
  await chooseAzure()
  await click("Previous")
  await click("Continue")
  expect(container.querySelector("select")?.value).toBe(azure.name)
  expect(button("Access confirmed")).toBeTruthy()
  await click("Continue")
  const saved = JSON.parse(state.store.get(TENANTS)!) as Tenant[]
  expect(saved[0]?.credentials?.storageAccountName).toBe(azure.name)
})

it("restores the selected Azure account after a remount but requires a new access check", async () => {
  await render()
  await chooseAzure()
  act(() => root!.unmount())
  root = undefined
  await render()
  expect(container.querySelector("select")?.value).toBe(azure.name)
  expect(button("Check access").disabled).toBe(false)
  expect(button("Continue").disabled).toBe(true)
  expect(state.verifyAzureStorage).toHaveBeenCalledOnce()
})

it("does not offer feature shortcuts before the profile is saved", async () => {
  await render()
  expect(container.textContent).toContain("Pro trial started")
  expect(container.querySelector('a[href*="/portal/backup"]')).toBeNull()
  expect(container.querySelector('a[href*="/portal/drift"]')).toBeNull()
  expect(container.querySelector('a[href*="/portal/frameworks"]')).toBeNull()
})

it("keeps the draft and Storage step until the profile write is acknowledged", async () => {
  await render()
  let acknowledge!: () => void
  let waiting = true
  state.setItem.mockImplementation(async (key, value) => {
    if (key === TENANTS && value.includes(TENANT) && waiting) {
      waiting = false
      await new Promise<void>(resolve => { acknowledge = resolve })
    }
    state.store.set(key, value)
  })
  await click("Continue")
  expect(container.textContent).toContain("Saving tenant")
  expect(container.querySelector('[data-testid="tenants"]')?.textContent).toBe("0")
  expect(state.store.has(DRAFT)).toBe(true)
  await act(async () => acknowledge())
  await flush()
  expect(container.textContent).toContain("Take a first backup")
  expect(container.querySelector('[data-testid="tenants"]')?.textContent).toBe("1")
  expect(state.store.has(DRAFT)).toBe(false)
})

it("shows a rejected profile save and preserves the draft for retry", async () => {
  await render()
  state.setItem.mockImplementation(async (key, value) => {
    if (key === TENANTS && value.includes(TENANT)) throw new Error("The disk is full. Free space and try again.")
    state.store.set(key, value)
  })
  await click("Continue")
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("The disk is full")
  expect(container.querySelector('[data-testid="tenants"]')?.textContent).toBe("0")
  expect(loadOnboardingDraft()?.account).toEqual(account)
  state.setItem.mockImplementation(async (key, value) => { state.store.set(key, value) })
  await click("Continue")
  expect(container.textContent).toContain("Take a first backup")
  expect(container.querySelector('[data-testid="tenants"]')?.textContent).toBe("1")
})

it.each([{ when: "after starting", pendingStart: false }, { when: "during a pending start", pendingStart: true }])("keeps the first backup visible when leaving $when", async ({ pendingStart }) => {
  await render()
  await click("Continue")
  let finishStart!: (response: Response) => void
  if (pendingStart) state.fetch.mockImplementation(() => new Promise(resolve => { finishStart = resolve }))
  else state.fetch.mockResolvedValue(Response.json({ jobId: "first-backup" }))
  await click("Run first backup")
  if (!pendingStart) {
    expect(state.addJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: "first-backup", isHidden: true }))
    const progress = container.querySelector('[role="progressbar"]')!
    expect(progress.getAttribute("aria-label")).toBe("First backup progress")
    expect(progress.getAttribute("aria-valuenow")).toBe("5")
  }
  await act(async () => (container.querySelector('a[href="/portal/dashboard"]') as HTMLAnchorElement).click())
  if (pendingStart) {
    await act(async () => finishStart(Response.json({ jobId: "first-backup" })))
    expect(state.addJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: "first-backup", isHidden: false, quiet: false, tenantName: "Contoso" }))
  } else {
    expect(state.updateJob).toHaveBeenCalledWith("first-backup", { isHidden: false, quiet: false })
  }
  expect(container.textContent).toContain("Dashboard")
})


it("serializes concurrent additions without dropping either saved profile", async () => {
  await render()
  const profile = (id: number) => ({ id, name: `Tenant ${id}`, credentials: { tenantId: id === 1 ? TENANT : SECOND_TENANT, appId: CLIENT } }) as Tenant
  await act(async () => { await Promise.all([operations.addTenant(profile(1)), operations.addTenant(profile(2))]) })
  expect((JSON.parse(state.store.get(TENANTS)!) as Tenant[]).map(tenant => tenant.id)).toEqual([1, 2])
  expect(container.querySelector('[data-testid="tenants"]')?.textContent).toBe("2")
})

it.each([false, true])("retains edits and sign-ins when an update shares the acknowledgement batch: %s", async sameBatch => {
  await render()
  const profile = (id: number) => ({ id, name: `Tenant ${id}`, credentials: { tenantId: id === 1 ? TENANT : SECOND_TENANT, appId: CLIENT } }) as Tenant
  await act(async () => { await operations.addTenant(profile(1)) })
  let acknowledge!: () => void
  let waiting = true
  state.setItem.mockImplementation(async (key, value) => {
    if (key === TENANTS && JSON.parse(value).length === 2 && waiting) {
      waiting = false
      await new Promise<void>(resolve => { acknowledge = resolve })
    }
    state.store.set(key, value)
  })
  let saving!: Promise<void>
  await act(async () => { saving = operations.addTenant(profile(2)) })
  if (!sameBatch) act(() => operations.updateTenant(1, { name: "Updated tenant" }))
  await act(async () => {
    if (sameBatch) operations.updateTenant(1, { name: "Updated tenant" })
    acknowledge()
    await saving
  })
  const saved = JSON.parse(state.store.get(TENANTS)!) as Tenant[]
  expect(saved.map(tenant => [tenant.id, tenant.name])).toEqual([[1, "Updated tenant"], [2, "Tenant 2"]])
  expect(state.releaseTenant).not.toHaveBeenCalled()
})

it("releases only the explicitly deleted tenant while an addition is pending", async () => {
  await render()
  const profile = (id: number) => ({ id, name: `Tenant ${id}`, credentials: { tenantId: id === 1 ? TENANT : SECOND_TENANT, appId: CLIENT } }) as Tenant
  await act(async () => { await operations.addTenant(profile(1)) })
  let acknowledge!: () => void
  let waiting = true
  state.setItem.mockImplementation(async (key, value) => {
    if (key === TENANTS && JSON.parse(value).length === 2 && waiting) {
      waiting = false
      await new Promise<void>(resolve => { acknowledge = resolve })
    }
    state.store.set(key, value)
  })
  let saving!: Promise<void>
  await act(async () => { saving = operations.addTenant(profile(2)) })
  await act(async () => { operations.deleteTenant(1); acknowledge(); await saving })
  expect((JSON.parse(state.store.get(TENANTS)!) as Tenant[]).map(tenant => tenant.id)).toEqual([2])
  expect(state.releaseTenant).toHaveBeenCalledExactlyOnceWith(TENANT)
})

it("does not sign out an unsaved addition if persisting a merged edit fails", async () => {
  await render()
  const profile = (id: number) => ({ id, name: `Tenant ${id}`, credentials: { tenantId: id === 1 ? TENANT : SECOND_TENANT, appId: CLIENT } }) as Tenant
  await act(async () => { await operations.addTenant(profile(1)) })
  let acknowledge!: () => void
  let waiting = true
  state.setItem.mockImplementation(async (key, value) => {
    if (key === TENANTS && JSON.parse(value).length === 2) {
      if (!waiting) throw new Error("Merged write failed")
      waiting = false
      await new Promise<void>(resolve => { acknowledge = resolve })
    }
    state.store.set(key, value)
  })
  let saving!: Promise<void>
  let failure!: Promise<void>
  await act(async () => {
    saving = operations.addTenant(profile(2))
    failure = expect(saving).rejects.toThrow("Merged write failed")
  })
  await act(async () => { operations.updateTenant(1, { name: "Updated tenant" }); acknowledge(); await failure })
  expect(state.releaseTenant).not.toHaveBeenCalled()
  expect(container.querySelector('[data-testid="tenants"]')?.textContent).toBe("1")
  state.setItem.mockImplementation(async (key, value) => { state.store.set(key, value) })
  await act(async () => { await operations.addTenant(profile(2)) })
  expect((JSON.parse(state.store.get(TENANTS)!) as Tenant[]).map(tenant => [tenant.id, tenant.name])).toEqual([[1, "Updated tenant"], [2, "Tenant 2"]])
})
