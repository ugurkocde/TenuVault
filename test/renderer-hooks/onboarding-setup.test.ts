import { act, createElement, useEffect, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SignedInAccount } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  createRegistration: vi.fn(),
  cancelCreateRegistration: vi.fn(async () => undefined),
  progress: null as null | ((value: import("../../src/shared/ipc").SetupProgress) => void),
  clipboardIds: vi.fn(async (): Promise<{ tenantId: string; clientId: string } | null> => null),
  store: new Map<string, string>(),
  signIn: vi.fn<(tenant: string, clientId: string) => Promise<SignedInAccount>>(),
  cancelSignIn: vi.fn(async () => undefined),
  accounts: vi.fn(async (): Promise<SignedInAccount[]> => []),
  releaseTenant: vi.fn(async () => undefined),
  tenants: [] as { credentials?: { tenantId?: string } }[],
  storageChoice: null as unknown,
  checkNewTenant: vi.fn(async (): Promise<unknown> => undefined),
  addTenant: vi.fn(),
  trialAction: vi.fn(async () => undefined),
  license: null as unknown,
  updateJob: vi.fn(),
  addJob: vi.fn(),
  activeJobs: [] as { jobId: string; isComplete: boolean; isSuccessful: boolean; status: string; progress: number }[],
  openExternal: vi.fn(async (_url: string) => undefined),
  record: vi.fn(async (_event: unknown) => undefined),
  diagnostics: { state: "ineligible", policy: false, reminder: { setup: false, signin: false } } as import("../../src/shared/ipc").SetupDiagnosticsStatus,
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    storage: {
      getItemSync: (key: string) => state.store.get(key) ?? null,
      setItem: async (key: string, value: string) => void state.store.set(key, value),
      removeItem: async (key: string) => void state.store.delete(key),
    },
    auth: { signIn: state.signIn, cancelSignIn: state.cancelSignIn, accounts: state.accounts },
    license: { releaseTenant: state.releaseTenant, clipboardKey: async () => null, checkNewTenant: state.checkNewTenant, tenantTrialAction: state.trialAction },
    setup: { createRegistration: state.createRegistration, cancelCreateRegistration: state.cancelCreateRegistration, onProgress: (listener: typeof state.progress) => { state.progress = listener; return () => { state.progress = null } }, clipboardIds: state.clipboardIds, saveScript: async () => ({ saved: false }) },
    preferences: { get: async () => ({ firstBackupNoteSeen: true }) },
    schedules: { list: async () => [] },
    backups: { settings: async () => ({ recoveryExported: true }) },
    app: { openExternal: state.openExternal },
    diagnostics: { record: state.record, status: async () => state.diagnostics, reminderShown: async () => undefined, consent: async () => state.diagnostics, decline: async () => state.diagnostics },
  },
}))
vi.mock("../../src/renderer/lib/license", () => ({
  useTenantPlan: () => "community",
  useLicense: () => ({ status: state.license, error: null, refresh: async () => undefined }),
  tenantLicense: (status: { tenants?: unknown[] } | undefined) => status?.tenants?.[0],
  tenantPlan: (tenant: { plan?: string } | undefined) => tenant?.plan ?? null,
  formatDate: (value: string) => value,
}))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => state.tenants,
  useTenantOperations: () => ({ addTenant: state.addTenant, updateTenant: vi.fn() }),
  useSelectedTenant: () => ({ setSelectedTenantId: vi.fn() }),
}))
vi.mock("~/contexts/BackupProgressContext", () => ({
  useBackupProgress: () => ({ addJob: state.addJob, removeJob: vi.fn(), updateJob: state.updateJob, activeJobs: state.activeJobs }),
}))
vi.mock("../../src/renderer/components/StorageChooser", () => ({
  StorageChooser: ({ onChange }: { onChange: (choice: unknown) => void }) => {
    useEffect(() => { if (state.storageChoice) onChange(state.storageChoice) }, [])
    return createElement("p", null, "Storage chooser")
  },
}))

import OnboardingPage from "../../src/renderer/pages/OnboardingPage"
import { setupCommand, TenantSignInForm } from "../../src/renderer/components/TenantSignInForm"
import { loadOnboardingDraft, pendingSignInTenant, PENDING_SIGN_IN_MAX_AGE_MS, saveOnboardingDraft } from "../../src/renderer/lib/onboarding-draft"
import { AddTenantModal } from "../../src/renderer/overrides/add-tenant-modal"

const TENANT = "8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14"
const CLIENT = "5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3"
const DRAFT_KEY = "tenuvault.onboarding.draft"
const OUTPUT = `Done. Copy the two lines below and paste them into the Sign in step of Set up TenuVault:\n  Tenant id:                ${TENANT}\n  Application (client) id:  ${CLIENT}`

const roots: Root[] = []

beforeEach(() => {
  state.accounts.mockReset()
  state.accounts.mockResolvedValue([])
  state.signIn.mockReset()
  state.createRegistration.mockReset()
  state.clipboardIds.mockReset()
  state.clipboardIds.mockResolvedValue(null)
  state.store.clear()
  state.tenants = []
  state.storageChoice = null
  state.license = null
  state.activeJobs = []
  state.diagnostics = { state: "ineligible", policy: false, reminder: { setup: false, signin: false } }
})

afterEach(async () => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  // A form left with a sign-in open cancels it a tick after unmounting.
  await new Promise((resolve) => setTimeout(resolve, 0))
  document.body.innerHTML = ""
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function render(element: ReactElement) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MemoryRouter, { initialEntries: ["/portal/onboarding"] }, element)))
  await flush()
  return container
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim().includes(label))

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!
  act(() => {
    setter.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("TenantSignInForm", () => {
  it("fills both IDs from the pasted script output", async () => {
    const container = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn() }))
    type(container.querySelector<HTMLTextAreaElement>("#setup-output")!, OUTPUT)
    expect(container.querySelector<HTMLInputElement>("#tenant")!.value).toBe(TENANT)
    expect(container.querySelector<HTMLInputElement>("#clientId")!.value).toBe(CLIENT)
    expect(container.textContent).toContain("Filled in the tenant ID and the client ID.")
  })

  it("says what to paste when the text has no IDs", async () => {
    const container = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn() }))
    type(container.querySelector<HTMLTextAreaElement>("#setup-output")!, "PS C:\\> ./New-TenuVaultDesktopApp.ps1")
    expect(container.textContent).toContain("No IDs found.")
  })

  it("lets the admin cancel a sign-in that waits for the browser, without an error", async () => {
    let reject: (error: Error) => void = () => undefined
    state.signIn.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    state.cancelSignIn.mockImplementationOnce(async () => { reject(new Error("Sign-in cancelled.")) })
    const container = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn(), initial: { tenant: TENANT, clientId: CLIENT } }))
    await act(async () => { button(container, "Sign in with Microsoft")!.click() })
    expect(container.textContent).toContain("Complete the sign-in in your browser.")
    await act(async () => { button(container, "Cancel sign-in")!.click() })
    await flush()
    expect(state.cancelSignIn).toHaveBeenCalled()
    expect(button(container, "Sign in with Microsoft")!.disabled).toBe(false)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it("shows the error Microsoft's refusal maps to", async () => {
    state.signIn.mockRejectedValueOnce(new Error("No app registration with this client ID exists in this tenant. (AADSTS700016)"))
    const container = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn(), initial: { tenant: TENANT, clientId: CLIENT } }))
    await act(async () => { button(container, "Sign in with Microsoft")!.click() })
    await flush()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("AADSTS700016")
  })
})

describe("setupCommand", () => {
  it("changes to the folder the script was saved in, quoted for PowerShell", () => {
    expect(setupCommand()).toBe("./New-TenuVaultDesktopApp.ps1")
    expect(setupCommand("C:\\Users\\Megan O'Neil\\Documents")).toBe("cd 'C:\\Users\\Megan O''Neil\\Documents'\n./New-TenuVaultDesktopApp.ps1")
    expect(setupCommand("/Users/megan", "TenuVault setup.ps1")).toBe("cd '/Users/megan'\n& './TenuVault setup.ps1'")
    // Typographic apostrophes, common in macOS folder names, also end a PowerShell string.
    expect(setupCommand("/Users/Megan\u2019s Docs")).toBe("cd '/Users/Megan\u2019\u2019s Docs'\n./New-TenuVaultDesktopApp.ps1")
  })
})

describe("onboarding draft", () => {
  it("keeps progress and drops an empty or broken draft", async () => {
    saveOnboardingDraft({ step: 1, tenant: TENANT, clientId: CLIENT, displayName: "Contoso", account: null })
    await flush()
    expect(loadOnboardingDraft()).toEqual({ step: 1, tenant: TENANT, clientId: CLIENT, displayName: "Contoso", account: null })
    saveOnboardingDraft({ step: 0, tenant: "", clientId: "", displayName: "", account: null })
    await flush()
    expect(state.store.has(DRAFT_KEY)).toBe(false)
    state.store.set(DRAFT_KEY, "{not json")
    expect(loadOnboardingDraft()).toBeNull()
    // The storage step needs a sign-in; without one setup resumes at the sign-in.
    state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT }))
    expect(loadOnboardingDraft()?.step).toBe(1)
  })

  it("counts a sign-in's age from when it was first saved, and drops it after three days", async () => {
    const account = { tenantId: TENANT, clientId: CLIENT, username: "admin" }
    const signedInAt = () => JSON.parse(state.store.get(DRAFT_KEY)!).signedInAt
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000)
    saveOnboardingDraft({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account })
    await flush()
    expect(signedInAt()).toBe(1_000)
    // Opening the setup again saves again; that does not extend the sign-in.
    now.mockReturnValue(2_000)
    saveOnboardingDraft({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "Contoso", account })
    await flush()
    expect(signedInAt()).toBe(1_000)
    expect(pendingSignInTenant(1_000 + PENDING_SIGN_IN_MAX_AGE_MS - 1)).toBe(TENANT.toLowerCase())
    // Past three days, resume and startup cleanup agree that the sign-in is gone.
    now.mockReturnValue(1_000 + PENDING_SIGN_IN_MAX_AGE_MS)
    expect(pendingSignInTenant()).toBeNull()
    expect(loadOnboardingDraft()).toMatchObject({ step: 1, account: null })
    // A sign-in to another tenant starts its own time.
    saveOnboardingDraft({ step: 2, tenant: "other", clientId: CLIENT, displayName: "", account: { ...account, tenantId: "other" } })
    await flush()
    expect(signedInAt()).toBe(1_000 + PENDING_SIGN_IN_MAX_AGE_MS)
    // Setup left open past three days: saving the same sign-in again does not renew it.
    const other = { ...account, tenantId: "other" }
    now.mockReturnValue(1_000 + 2 * PENDING_SIGN_IN_MAX_AGE_MS)
    saveOnboardingDraft({ step: 1, tenant: "other", clientId: CLIENT, displayName: "", account: other })
    await flush()
    expect(signedInAt()).toBe(1_000 + PENDING_SIGN_IN_MAX_AGE_MS)
    expect(pendingSignInTenant()).toBeNull()
    // A time in the future, after the clock was set back, does not keep a sign-in.
    now.mockReturnValue(500)
    expect(pendingSignInTenant()).toBeNull()
    now.mockRestore()
  })
})

describe("OnboardingPage", () => {
  it("resumes at the sign-in with the IDs entered before the restart", async () => {
    state.store.set(DRAFT_KEY, JSON.stringify({ step: 1, tenant: TENANT, clientId: CLIENT, displayName: "", account: null }))
    const container = await render(createElement(OnboardingPage))
    expect(container.textContent).toContain("Welcome back.")
    expect(container.querySelector<HTMLInputElement>("#tenant")!.value).toBe(TENANT)
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Sign in")
    // No tenant yet: there is no dashboard to go back to.
    expect(container.textContent).not.toContain("Back to dashboard")
  })

  it("resumes at storage while the sign-in is still there, and signs in again when it is gone", async () => {
    const account = { tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.com" }
    state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account, signedInAt: Date.now() }))
    state.accounts.mockResolvedValueOnce([account])
    let container = await render(createElement(OnboardingPage))
    expect(container.textContent).toContain("Choose where backups are stored")
    expect(container.textContent).toContain("signed in as admin@contoso.com")
    for (const root of roots.splice(0)) act(() => root.unmount())

    state.accounts.mockResolvedValueOnce([])
    container = await render(createElement(OnboardingPage))
    expect(container.textContent).toContain("Sign in to your tenant")
    expect(container.querySelector<HTMLInputElement>("#clientId")!.value).toBe(CLIENT)
  })

  it("frees the sign-in of an unsaved tenant before signing in to another one", async () => {
    const account = { tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.com" }
    state.store.set(DRAFT_KEY, JSON.stringify({ step: 1, tenant: TENANT, clientId: CLIENT, displayName: "", account, signedInAt: Date.now() }))
    state.accounts.mockResolvedValueOnce([account])
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Use a different tenant or account")!.click() })
    await flush()
    expect(state.releaseTenant).toHaveBeenCalledWith(TENANT)
    expect(container.querySelector("#tenant")).not.toBeNull()
  })

  it("keeps an Azure choice from being saved when the tenant turned out to be on Community", async () => {
    const account = { tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.com" }
    state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account, signedInAt: Date.now() }))
    state.accounts.mockResolvedValueOnce([account])
    state.storageChoice = { kind: "azure", storageAccountName: "contosobackups", subscriptionId: "sub", resourceGroupName: "rg", location: "westeurope" }
    state.checkNewTenant.mockResolvedValueOnce({ tenants: [{ tenantId: TENANT, plan: "community" }] })
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Continue")!.click() })
    await flush()
    expect(state.checkNewTenant).toHaveBeenCalledWith(TENANT)
    expect(state.addTenant).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("This tenant is on Community now")
    expect(button(container, "Continue")!.disabled).toBe(true)
  })

  it.each([
    ["a new trial shown on the Storage step", { source: "trial", trial: true, trialAcknowledged: false }, { source: "trial", trial: true, trialAcknowledged: false }, true],
    ["a trial already seen", { source: "trial", trial: true, trialAcknowledged: true }, { source: "trial", trial: true, trialAcknowledged: true }, false],
    ["a license key", { source: "key", trial: false }, { source: "key", trial: false }, false],
    // The automatic trial can start only during the check at Continue: it was never shown.
    ["a trial that starts at Continue", { source: null, trial: false, plan: "community" }, { source: "trial", trial: true, trialAcknowledged: false }, false],
  ] as const)("marks %s as seen once the Storage step is done", async (_label, shown, checked, acknowledged) => {
    const account = { tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.com" }
    state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account, signedInAt: Date.now() }))
    state.accounts.mockResolvedValueOnce([account])
    state.storageChoice = { kind: "local" }
    state.trialAction.mockClear()
    state.addTenant.mockClear()
    state.license = { tenants: [{ tenantId: TENANT, plan: "pro", ...shown }] }
    state.checkNewTenant.mockResolvedValueOnce({ tenants: [{ tenantId: TENANT, plan: "pro", ...checked }] })
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Continue")!.click() })
    await flush()
    expect(state.addTenant).toHaveBeenCalled()
    if (acknowledged) expect(state.trialAction).toHaveBeenCalledWith(TENANT, "acknowledge")
    else expect(state.trialAction).not.toHaveBeenCalled()
  })

  it("reaches the first backup step when marking the trial as seen fails", async () => {
    const account = { tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.com" }
    state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account, signedInAt: Date.now() }))
    state.accounts.mockResolvedValueOnce([account])
    state.storageChoice = { kind: "local" }
    state.trialAction.mockClear()
    state.trialAction.mockRejectedValueOnce(new Error("offline"))
    state.license = { tenants: [{ tenantId: TENANT, plan: "pro", source: "trial", trial: true, trialAcknowledged: false }] }
    state.checkNewTenant.mockResolvedValueOnce(state.license)
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Continue")!.click() })
    await flush()
    expect(state.trialAction).toHaveBeenCalledWith(TENANT, "acknowledge")
    expect(container.textContent).toContain("Take a first backup")
  })

  it("does not mark the trial as seen when the tenant cannot be saved", async () => {
    const account = { tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.com" }
    state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account, signedInAt: Date.now() }))
    state.accounts.mockResolvedValueOnce([account])
    state.storageChoice = { kind: "local" }
    state.trialAction.mockClear()
    state.license = { tenants: [{ tenantId: TENANT, plan: "pro", source: "trial", trial: true, trialAcknowledged: false }] }
    state.checkNewTenant.mockRejectedValueOnce(new Error("The licensing service could not be reached."))
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Continue")!.click() })
    await flush()
    expect(state.trialAction).not.toHaveBeenCalled()
  })

  it("shows the Connect checklist with the permissions and the handoff", async () => {
    const container = await render(createElement(OnboardingPage))
    expect(button(container, "Set up with Microsoft sign-in")).toBeDefined()
    expect(container.textContent).toContain("Connect your tenant")
    expect(container.textContent).toContain("Microsoft Graph Command Line Tools")
    expect(container.textContent).toContain("Application Administrator")
    expect(container.textContent).not.toContain("Privileged Role Administrator")
    expect(container.textContent).toContain("Permissions the app registration gets")
    expect(button(container, "Someone else is the admin? Copy instructions")).toBeDefined()
    // The script route, and creating the registration by hand, sit behind one more click.
    expect(button(container, "Create it by hand instead")).toBeUndefined()
    await act(async () => button(container, "Use the setup script instead")!.click())
    expect(button(container, "Save setup script")).toBeDefined()
    expect(button(container, "Create it by hand instead")).toBeDefined()
  })
})

describe("Connect tenant on the desktop", () => {
  it("opens the guided setup instead of a dialog", async () => {
    const onOpenChange = vi.fn()
    let path = ""
    function Where() {
      path = useLocation().pathname
      return null
    }
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(MemoryRouter, { initialEntries: ["/portal/tenants"] },
      createElement(Routes, null, createElement(Route, { path: "*", element: createElement("div", null, createElement(AddTenantModal, { open: true, onOpenChange, onTenantAdded: vi.fn() }), createElement(Where)) })))))
    await flush()
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(path).toBe("/portal/onboarding")
  })
})

it.each(["", "The tenant was not added. "])("offers Pro and support when signing in refuses an emailed trial key (%s)", async prefix => {
  const message = `${prefix}This tenant already had a Pro trial. Buy Pro to continue, or write to support@tenuvault.com for a quote or an invoice.`
  state.signIn.mockRejectedValueOnce(new Error(message))
  const container = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn() }))
  type(container.querySelector<HTMLInputElement>("#tenant")!, TENANT)
  type(container.querySelector<HTMLInputElement>("#clientId")!, CLIENT)
  await act(async () => { button(container, "Sign in")!.click() })
  const alert = container.querySelector('[role="alert"]')!
  expect(alert.textContent).toContain("This tenant already had a Pro trial.")
  expect(alert.textContent).not.toContain(message)
  expect(button(alert as HTMLElement, "Buy Pro")).toBeTruthy()
  expect(alert.querySelector('a[href^="mailto:support@tenuvault.com?subject=TenuVault%20Pro"]')).toBeTruthy()
  expect(button(alert as HTMLElement, "Extend your trial")).toBeUndefined()
})

it("offers purchasing help when saving a connected tenant refuses its trial key", async () => {
  const account = { tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.com" }
  state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account, signedInAt: Date.now() }))
  state.accounts.mockResolvedValueOnce([account])
  state.storageChoice = { kind: "local" }
  state.checkNewTenant.mockRejectedValueOnce(new Error("This tenant already had a Pro trial. Buy Pro to continue, or write to support@tenuvault.com for a quote or an invoice."))
  const container = await render(createElement(OnboardingPage))
  await act(async () => button(container, "Continue")!.click())
  await flush()
  const alert = container.querySelector('[role="alert"]')!
  expect(alert.textContent).toContain("This tenant already had a Pro trial.")
  expect(button(alert as HTMLElement, "Buy Pro")).toBeTruthy()
  expect(alert.querySelector('a[href^="mailto:support@tenuvault.com"]')).toBeTruthy()
  expect(button(alert as HTMLElement, "Try Pro free")).toBeUndefined()
  expect(alert.querySelector('a[href="/license"]')).toBeTruthy()
})

it("fills empty IDs from the clipboard on mount and focus", async () => {
  state.clipboardIds.mockResolvedValueOnce({ tenantId: TENANT, clientId: CLIENT })
  const mounted = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn() }))
  expect(mounted.querySelector<HTMLInputElement>("#tenant")!.value).toBe(TENANT)
  expect(mounted.textContent).toContain("Filled in the tenant ID and the client ID from your clipboard.")
  const focused = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn() }))
  state.clipboardIds.mockResolvedValue({ tenantId: TENANT, clientId: CLIENT })
  await act(async () => { window.dispatchEvent(new Event("focus")) })
  expect(focused.querySelector<HTMLInputElement>("#clientId")!.value).toBe(CLIENT)
})

it("preserves typed and initial fields and ignores bridge failure", async () => {
  state.clipboardIds.mockRejectedValueOnce(new Error("unavailable"))
  const container = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn() }))
  type(container.querySelector<HTMLInputElement>("#tenant")!, "typed.example")
  state.clipboardIds.mockResolvedValue({ tenantId: TENANT, clientId: CLIENT })
  await act(async () => { window.dispatchEvent(new Event("focus")) })
  expect(container.querySelector<HTMLInputElement>("#tenant")!.value).toBe("typed.example")
  const initial = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn(), initial: { clientId: CLIENT } }))
  expect(initial.querySelector<HTMLInputElement>("#tenant")!.value).toBe("")
})

it("preserves input typed while a clipboard read is pending", async () => {
  let finish!: (value: { tenantId: string; clientId: string }) => void
  state.clipboardIds.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const container = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn() }))
  type(container.querySelector<HTMLInputElement>("#clientId")!, "typing")
  await act(async () => { finish({ tenantId: TENANT, clientId: CLIENT }) })
  expect(container.querySelector<HTMLInputElement>("#clientId")!.value).toBe("typing")
})

it("does not bring the same clipboard IDs back after the admin cleared the fields", async () => {
  state.clipboardIds.mockResolvedValue({ tenantId: TENANT, clientId: CLIENT })
  const container = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn() }))
  expect(container.querySelector<HTMLInputElement>("#tenant")!.value).toBe(TENANT)
  type(container.querySelector<HTMLInputElement>("#tenant")!, "")
  type(container.querySelector<HTMLInputElement>("#clientId")!, "")
  await act(async () => { window.dispatchEvent(new Event("focus")) })
  expect(container.querySelector<HTMLInputElement>("#tenant")!.value).toBe("")
  expect(container.querySelector<HTMLInputElement>("#clientId")!.value).toBe("")
})


describe("in-app tenant setup", () => {
  const result = { tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.test", reused: false, ready: true, displayName: "TenuVault Desktop", candidateCount: 0, missingConsent: [] }
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))

  it("explains the setup before it starts", async () => {
    const container = await render(createElement(OnboardingPage))
    for (const text of ["One Microsoft sign-in.", "It lives in your tenant", "It acts only as you", "No secret to protect", "Backups stay with you", "Microsoft will ask you to approve Microsoft Graph Command Line Tools", "because the setup creates an app registration and grants admin consent", "Your administrator approves once", "Application.ReadWrite.All", "kept in memory only"]) expect(container.textContent).toContain(text)
    // Claims the app cannot stand behind are not made: no time promise, and no "everything stays in your tenant".
    expect(container.textContent).not.toMatch(/about (a|one|two) minutes?|stays in your tenant|no background access/i)
    expect(container.querySelector("#setup-tenant")).not.toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it("shows progress, then signs in by itself as the same account and continues to Storage", async () => {
    let finish!: (value: typeof result) => void
    state.createRegistration.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    state.signIn.mockResolvedValueOnce(result)
    const container = await render(createElement(OnboardingPage))
    await act(async () => button(container, "Set up with Microsoft sign-in")!.click())
    expect(container.textContent).toContain("Setting up your tenant")
    expect(container.textContent).toContain("Nothing is created before you are signed in.")
    expect(button(container, "Cancel")).toBeDefined()
    await act(async () => state.progress?.({ phase: "registration", reused: true }))
    expect(container.textContent).toContain("Use the app registration this tenant already has")
    expect(button(container, "Cancel")).toBeDefined()
    await act(async () => { finish(result); await settle() })
    expect(state.createRegistration).toHaveBeenCalledWith(undefined)
    expect(state.signIn).toHaveBeenCalledTimes(1)
    expect(state.signIn).toHaveBeenLastCalledWith(TENANT, CLIENT, { loginHint: "admin@contoso.test" })
    expect(container.textContent).toContain("Choose where backups are stored")
  })

  it.each([1, 2])("names a reused registration and explains selection among %s candidates", async candidateCount => {
    state.createRegistration.mockResolvedValueOnce({ ...result, reused: true, ready: false, displayName: "TenuVault Desktop (Lab)", candidateCount })
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    expect(container.textContent).toContain('This tenant already had a TenuVault app registration, "TenuVault Desktop (Lab)", so TenuVault uses that one.')
    expect(container.textContent!.includes('To use another one, select Previous')).toBe(candidateCount > 1)
    expect(container.textContent).toContain("Microsoft is still making it available for sign-in")
    expect(state.signIn).not.toHaveBeenCalled()
  })

  it("signs in by itself with the one registration the tenant already had", async () => {
    state.createRegistration.mockResolvedValueOnce({ ...result, reused: true, displayName: "TenuVault Desktop (Lab)", candidateCount: 1 })
    state.signIn.mockResolvedValueOnce(result)
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    expect(state.signIn).toHaveBeenCalledTimes(1)
  })

  it("says what the admin consent of a reused registration lacks, and waits instead of signing in", async () => {
    state.createRegistration.mockResolvedValueOnce({ ...result, reused: true, displayName: "TenuVault Desktop (Lab)", candidateCount: 1, missingConsent: ["DeviceManagementScripts.ReadWrite.All", "user_impersonation (Azure Storage)"] })
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    expect(state.signIn).not.toHaveBeenCalled()
    expect(container.textContent).toContain('It has no tenant-wide admin consent for 2 permissions TenuVault uses by default: DeviceManagementScripts.ReadWrite.All, user_impersonation (Azure Storage). TenuVault did not change it, and what needs these permissions does not work until an administrator grants them under Entra admin center > App registrations > TenuVault Desktop (Lab) > API permissions. To use it, select Sign in with Microsoft.')
    expect(container.textContent).not.toContain("To use another one")
  })

  it("waits for the admin when the tenant has several registrations, so another one can still be chosen", async () => {
    state.createRegistration.mockResolvedValueOnce({ ...result, reused: true, displayName: "TenuVault Desktop (Lab)", candidateCount: 2 })
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    expect(state.signIn).not.toHaveBeenCalled()
    expect(container.textContent).toContain('so TenuVault uses that one. It is one of 2 in this tenant. To use it, select Sign in with Microsoft. To use another one, select Previous, then "I already have an app registration" and enter its client ID.')
    // The IDs are filled in: one click signs in with the registration TenuVault picked.
    state.signIn.mockResolvedValueOnce(result)
    await act(async () => { button(container, "Sign in with Microsoft")!.click(); await settle() })
    expect(state.signIn).toHaveBeenCalledTimes(1)
    expect(state.signIn.mock.calls[0]!.slice(0, 2)).toEqual([TENANT, CLIENT])
  })

  it("passes the optional tenant of a guest or partner admin", async () => {
    state.createRegistration.mockResolvedValueOnce(result)
    state.signIn.mockResolvedValueOnce(result)
    const container = await render(createElement(OnboardingPage))
    type(container.querySelector<HTMLInputElement>("#setup-tenant")!, " fabrikam.onmicrosoft.com ")
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    expect(state.createRegistration).toHaveBeenCalledWith({ tenant: "fabrikam.onmicrosoft.com" })
  })

  it("keeps the IDs on the Sign in step when the last sign-in fails, and a retry asks for the account again", async () => {
    state.createRegistration.mockResolvedValueOnce(result)
    state.signIn.mockRejectedValueOnce(new Error("Conditional Access blocked this sign-in. (AADSTS53003)"))
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    expect(container.textContent).toContain("Sign in to your tenant")
    expect(container.textContent).toContain("The app registration is ready.")
    expect(container.querySelector<HTMLInputElement>("#tenant")!.value).toBe(TENANT)
    expect(container.querySelector<HTMLInputElement>("#clientId")!.value).toBe(CLIENT)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("AADSTS53003")
    await flush()
    expect(loadOnboardingDraft()).toMatchObject({ step: 1, tenant: TENANT, clientId: CLIENT })
    state.signIn.mockResolvedValueOnce(result)
    await act(async () => { button(container, "Sign in with Microsoft")!.click(); await settle() })
    expect(state.createRegistration).toHaveBeenCalledTimes(1)
    expect(state.signIn).toHaveBeenLastCalledWith(TENANT, CLIENT)
    expect(container.textContent).toContain("Choose where backups are stored")
  })

  const MANUAL = "https://docs.tenuvault.com/getting-started/app-registration/#create-the-app-registration-manually"

  it("offers the manual route next to an error that needs it, because the setup script is blocked too", async () => {
    state.createRegistration.mockRejectedValueOnce(new Error("This tenant does not let your account sign in to Microsoft Graph Command Line Tools, the Microsoft app that the setup and the setup script sign in through (AADSTS7000112). Ask your Entra administrator to allow it for your account, or create the app registration by hand in the Entra admin center. Nothing was changed."))
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    const alert = container.querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.textContent).toContain("AADSTS7000112")
    await act(async () => button(alert, "Create it by hand")!.click())
    expect(state.openExternal).toHaveBeenCalledWith(MANUAL)
    // Once it exists, the admin goes on from the same place to enter its IDs.
    await act(async () => { button(alert, "I already have an app registration")!.click(); await settle() })
    expect(container.textContent).toContain("Sign in to your tenant")
  })

  it("says next to the button, not only in the collapsed details, that national cloud tenants are not supported", async () => {
    const container = await render(createElement(OnboardingPage))
    const note = [...container.querySelectorAll("p")].find(item => item.textContent?.includes("GCC High, DoD and 21Vianet tenants are not supported"))
    expect(note).toBeDefined()
    expect(note!.closest("details")).toBeNull()
  })

  it("offers both routes next to the timeout, because Microsoft's own error pages never come back", async () => {
    state.createRegistration.mockRejectedValueOnce(new Error('The sign-in in the browser was not completed within 15 minutes. If Microsoft said that you need admin approval, use "Someone else is the admin?". If it said that Microsoft Graph Command Line Tools is blocked, disabled or not assigned to you, the setup script is blocked too: create the app registration by hand in the Entra admin center. Nothing was changed.'))
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    const alert = container.querySelector<HTMLElement>('[role="alert"]')!
    expect(button(alert, "Create it by hand")).toBeDefined()
    expect(button(alert, "I already have an app registration")).toBeDefined()
    expect(button(container, "Someone else is the admin? Copy instructions")).toBeDefined()
  })

  it("does not offer the manual route next to an error it does not help with", async () => {
    state.createRegistration.mockRejectedValueOnce(new Error("Graph POST failed: Request rate is too high."))
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    const alert = container.querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.textContent).toContain("Request rate is too high")
    expect(button(alert, "Create it by hand")).toBeUndefined()
  })

  it("says while it waits which refusal in the browser needs which route", async () => {
    state.createRegistration.mockImplementationOnce(() => new Promise(() => {}))
    const container = await render(createElement(OnboardingPage))
    await act(async () => button(container, "Set up with Microsoft sign-in")!.click())
    expect(container.textContent).toContain('If Microsoft says that you need admin approval, this account cannot approve the setup. Select Cancel and use "Someone else is the admin?" below.')
    expect(container.textContent).toContain("the setup script is blocked too")
    await act(async () => button(container, "create the app registration by hand")!.click())
    expect(state.openExternal).toHaveBeenCalledWith(MANUAL)
  })

  it("does not report a cancelled last sign-in as an error", async () => {
    state.createRegistration.mockResolvedValueOnce(result)
    state.signIn.mockRejectedValueOnce(new Error("Sign-in cancelled."))
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    expect(container.querySelector<HTMLInputElement>("#clientId")!.value).toBe(CLIENT)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(button(container, "Sign in with Microsoft")!.disabled).toBe(false)
  })

  it("leaves the sign-in to the admin while Microsoft does not accept sign-ins to the registration yet", async () => {
    state.createRegistration.mockResolvedValueOnce({ ...result, ready: false })
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    expect(container.textContent).toContain("Microsoft is still making it available for sign-in")
    expect(container.querySelector<HTMLInputElement>("#tenant")!.value).toBe(TENANT)
    expect(state.signIn).not.toHaveBeenCalled()
  })

  it("shows why the setup failed and offers to try again", async () => {
    state.createRegistration.mockRejectedValueOnce(new Error("The signed-in account megan@contoso.test lacks a role that can create app registrations and grant admin consent."))
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("lacks a role")
    expect(container.textContent).toContain("Connect your tenant")
    state.createRegistration.mockResolvedValueOnce(result)
    state.signIn.mockResolvedValueOnce(result)
    await act(async () => { button(container, "Try again")!.click(); await settle() })
    expect(container.textContent).toContain("Choose where backups are stored")
  })

  it.each(["signingIn", "registration", "consent", "publishing"] as const)("cancels %s without an error and keeps the other ways open", async phase => {
    let reject!: (error: Error) => void
    state.createRegistration.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    state.cancelCreateRegistration.mockImplementationOnce(async () => { reject(new Error("Sign-in cancelled.")); return undefined })
    const container = await render(createElement(OnboardingPage))
    await act(async () => button(container, "Set up with Microsoft sign-in")!.click())
    await act(async () => state.progress?.({ phase }))
    await act(async () => { button(container, "Cancel")!.click(); await settle() })
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(button(container, "Set up with Microsoft sign-in")).toBeDefined()
    await act(async () => button(container, "Use the setup script instead")!.click())
    expect(button(container, "Save setup script")).toBeDefined()
    await act(async () => button(container, "I already have an app registration")!.click())
    expect(container.querySelector("#clientId")).not.toBeNull()
    expect(state.signIn).not.toHaveBeenCalled()
  })

  it("gives up an earlier, unsaved sign-in when the setup runs again, and connects the new tenant", async () => {
    const earlier = "2f9d4a7c-1b6e-4c3d-8a5f-9e0b7c2d4a61"
    // A sign-in to another tenant that was never saved, as after signing in by hand.
    state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: earlier, clientId: CLIENT, displayName: "", account: { tenantId: earlier, clientId: CLIENT, username: "alex@fabrikam.test" }, signedInAt: Date.now() }))
    state.accounts.mockResolvedValueOnce([{ tenantId: earlier, clientId: CLIENT, username: "alex@fabrikam.test" }])
    const container = await render(createElement(OnboardingPage))
    expect(container.textContent).toContain("Signed in as alex@fabrikam.test")
    await act(async () => button(container, "Previous")!.click())
    await act(async () => button(container, "Previous")!.click())
    expect(container.textContent).toContain("Connect your tenant")

    state.createRegistration.mockResolvedValueOnce(result)
    state.signIn.mockResolvedValueOnce(result)
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    expect(state.releaseTenant).toHaveBeenCalledWith(earlier)
    expect(state.signIn).toHaveBeenLastCalledWith(TENANT, CLIENT, { loginHint: "admin@contoso.test" })
    expect(container.textContent).toContain("Choose where backups are stored")
    expect(container.textContent).toContain("Signed in as admin@contoso.test")
    expect(container.textContent).not.toContain("alex@fabrikam.test")
    await flush()
    expect(loadOnboardingDraft()).toMatchObject({ tenant: TENANT, clientId: CLIENT, account: { tenantId: TENANT, username: "admin@contoso.test" } })
  })

  it("says how long Microsoft may take while it waits, and what to do if the browser reports a missing application", async () => {
    let finish!: (value: typeof result) => void
    state.createRegistration.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    state.signIn.mockImplementationOnce(() => new Promise(() => {}))
    const container = await render(createElement(OnboardingPage))
    await act(async () => button(container, "Set up with Microsoft sign-in")!.click())
    await act(async () => state.progress?.({ phase: "consent" }))
    const progress = () => container.querySelector('[role="status"]')!.textContent
    expect(progress()).toContain("This takes a few seconds.")
    expect(progress()).not.toContain("your browser opens once more")
    await act(async () => state.progress?.({ phase: "publishing" }))
    expect(progress()).toContain("at most a minute and a half")
    expect(progress()).toContain("your browser opens once more")
    await act(async () => { finish(result); await settle() })
    expect(container.textContent).toContain("There is nothing to enter this time.")
    expect(container.textContent).toContain("If Microsoft says it cannot find the application")
    expect(button(container, "Cancel sign-in")).toBeDefined()
  })
})

it("cancels a sign-in left behind and ignores its late result", async () => {
  let finish!: (account: SignedInAccount) => void
  state.signIn.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  state.store.set(DRAFT_KEY, JSON.stringify({ step: 1, tenant: TENANT, clientId: CLIENT, displayName: "", account: null }))
  const container = await render(createElement(OnboardingPage))
  await act(async () => button(container, "Sign in with Microsoft")!.click())
  await act(async () => button(container, "Previous")!.click())
  await flush()
  expect(state.cancelSignIn).toHaveBeenCalledOnce()
  await act(async () => finish({ tenantId: TENANT, clientId: CLIENT, username: "late" }))
  expect(container.textContent).toContain("Connect your tenant")
  expect(container.textContent).not.toContain("Choose where backups are stored")
  await act(async () => button(container, "I already have an app registration")!.click())
  state.signIn.mockResolvedValueOnce({ tenantId: TENANT, clientId: CLIENT, username: "current" })
  await act(async () => button(container, "Sign in with Microsoft")!.click())
  expect(state.signIn).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain("Signed in as current")
})

it.each([false, true])("refuses a connected tenant without releasing it, resumed: %s", async resumed => {
  const account = { tenantId: TENANT, clientId: CLIENT, username: "admin" }
  state.tenants = [{ credentials: { tenantId: TENANT.toUpperCase() } }]
  state.store.set(DRAFT_KEY, JSON.stringify({ step: resumed ? 2 : 1, tenant: TENANT, clientId: CLIENT, displayName: "", account: resumed ? account : null, signedInAt: Date.now() }))
  state.storageChoice = { kind: "local" }
  state.accounts.mockResolvedValueOnce([account])
  if (!resumed) state.signIn.mockResolvedValueOnce(account)
  const container = await render(createElement(OnboardingPage))
  await act(async () => button(container, resumed ? "Continue" : "Sign in with Microsoft")!.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("This tenant is already connected to TenuVault.")
  expect(container.querySelector('[role="alert"] a')?.getAttribute("href")).toBe("/portal/dashboard")
  expect(container.querySelector("#tenant")).not.toBeNull()
  expect(button(container, "Sign in with Microsoft")!.disabled).toBe(false)
  expect(state.releaseTenant).not.toHaveBeenCalled()
  expect(state.addTenant).not.toHaveBeenCalled()
})

it("does not bring back a resumed account the admin switched away from while it was being checked", async () => {
  const account = { tenantId: TENANT, clientId: CLIENT, username: "saved" }
  state.store.set(DRAFT_KEY, JSON.stringify({ step: 1, tenant: TENANT, clientId: CLIENT, displayName: "", account, signedInAt: Date.now() }))
  let answer!: (accounts: SignedInAccount[]) => void
  state.accounts.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
  const container = await render(createElement(OnboardingPage))
  expect(container.textContent).toContain("Signed in as saved")
  await act(async () => button(container, "Use a different tenant or account")!.click())
  await flush()
  expect(state.releaseTenant).toHaveBeenCalledWith(TENANT)
  await act(async () => { answer([account]); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(container.textContent).not.toContain("Signed in as saved")
  expect(container.querySelector("#tenant")).not.toBeNull()
})

it("requires sign-in again when checking the saved session fails", async () => {
  const account = { tenantId: TENANT, clientId: CLIENT, username: "saved" }
  state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account, signedInAt: Date.now() }))
  state.accounts.mockRejectedValueOnce(new Error("unavailable"))
  const container = await render(createElement(OnboardingPage))
  expect(container.textContent).toContain("Sign in to your tenant")
  expect(container.querySelector("#tenant")).not.toBeNull()
  await flush()
  expect(loadOnboardingDraft()).toMatchObject({ step: 1, account: null })
})

it("resumes with the current live account instead of the saved admin", async () => {
  const account = { tenantId: TENANT, clientId: CLIENT, username: "saved", name: "Saved" }
  const live = { ...account, username: "current", name: "Current" }
  state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account, signedInAt: Date.now() }))
  state.accounts.mockResolvedValueOnce([live])
  const container = await render(createElement(OnboardingPage))
  expect(container.textContent).toContain("Signed in as current")
  await flush()
  expect(loadOnboardingDraft()?.account).toEqual(live)
})

it.each([false, true])("reveals only an unfinished first backup when leaving, complete: %s", async complete => {
  const account = { tenantId: TENANT, clientId: CLIENT, username: "admin" }
  state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account, signedInAt: Date.now() }))
  state.accounts.mockResolvedValueOnce([account])
  state.storageChoice = { kind: "local" }
  state.checkNewTenant.mockResolvedValueOnce({ tenants: [{ plan: "community" }] })
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url === "/api/backup/start" ? { jobId: "first" } : {})))
  state.activeJobs = [{ jobId: "first", isComplete: complete, isSuccessful: complete, status: complete ? "Completed" : "Running", progress: complete ? 100 : 5 }]
  const container = await render(createElement(OnboardingPage))
  await act(async () => button(container, "Continue")!.click())
  await act(async () => button(container, "Run first backup")!.click())
  expect(state.addJob).toHaveBeenCalledWith(expect.objectContaining({ isHidden: true, quiet: true }))
  for (const root of roots.splice(0)) act(() => root.unmount())
  if (complete) expect(state.updateJob).not.toHaveBeenCalled()
  else expect(state.updateJob).toHaveBeenCalledWith("first", { isHidden: false })
})

it("registers a first backup that starts after the admin left as visible", async () => {
  const account = { tenantId: TENANT, clientId: CLIENT, username: "admin" }
  state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account, signedInAt: Date.now() }))
  state.accounts.mockResolvedValueOnce([account])
  state.storageChoice = { kind: "local" }
  state.checkNewTenant.mockResolvedValueOnce({ tenants: [{ plan: "community" }] })
  let started!: (response: Response) => void
  vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/backup/start" ? new Promise<Response>(resolve => { started = resolve }) : Promise.resolve(Response.json({}))))
  const container = await render(createElement(OnboardingPage))
  await act(async () => button(container, "Continue")!.click())
  await act(async () => button(container, "Run first backup")!.click())
  for (const root of roots.splice(0)) act(() => root.unmount())
  await act(async () => { started(Response.json({ jobId: "late" })); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(state.addJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: "late", isHidden: false, quiet: true }))
})

it("refuses an already connected tenant after the in-app setup with one automatic sign-in", async () => {
  const account = { tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.test" }
  state.tenants = [{ credentials: { tenantId: TENANT } }]
  state.createRegistration.mockResolvedValueOnce({ tenantId: TENANT, clientId: CLIENT, username: account.username, reused: true, ready: true, displayName: "TenuVault Desktop", candidateCount: 1, missingConsent: [] })
  state.signIn.mockResolvedValue(account)
  const container = await render(createElement(OnboardingPage))
  await act(async () => button(container, "Set up with Microsoft sign-in")!.click())
  await flush()
  await flush()
  expect(state.signIn).toHaveBeenCalledOnce()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("This tenant is already connected to TenuVault.")
  expect(container.querySelector('[role="alert"] a')?.getAttribute("href")).toBe("/portal/dashboard")
  expect(container.textContent).not.toContain("Choose where backups are stored")
  expect(state.releaseTenant).not.toHaveBeenCalled()
  expect(state.addTenant).not.toHaveBeenCalled()
})

it("says when a cancelled setup keeps the app registration it created", async () => {
  const kept = 'Setup was cancelled. The app registration "TenuVault Desktop" (client id client) stays in your tenant, and the next setup uses it.'
  state.createRegistration.mockRejectedValueOnce(new Error(kept))
  const container = await render(createElement(OnboardingPage))
  await act(async () => button(container, "Set up with Microsoft sign-in")!.click())
  await flush()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(kept)
  expect(button(container, "Try again")).toBeDefined()
})

it("explains the consent checkbox in both setup notes", async () => {
  const container = await render(createElement(OnboardingPage))
  const text = (container.textContent ?? "").replace(/\s+/g, " ")
  expect(text).toContain('Leave "Consent on behalf of your organization" unticked; the setup does not need it.')
  expect(text).toContain('stays with your account, as long as you leave "Consent on behalf of your organization" unticked; the setup does not need it.')
})

describe("setup diagnostics hooks", () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  it("reports each setup route the admin chooses", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async () => undefined } })
    state.createRegistration.mockRejectedValueOnce(new Error("Graph POST failed. Nothing was changed."))
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    await act(async () => { button(container, "Someone else is the admin? Copy instructions")!.click(); await settle() })
    await act(async () => { button(container, "Use the setup script instead")!.click(); await settle() })
    await act(async () => { [...container.querySelectorAll("button")].filter((item) => item.textContent?.trim() === "I already have an app registration").at(-1)!.click(); await settle() })
    expect(state.record.mock.calls.map(([event]) => event)).toEqual([
      { name: "setup_route", props: { route: "auto" } },
      { name: "setup_route", props: { route: "handoff" } },
      { name: "setup_route", props: { route: "script" } },
      { name: "setup_route", props: { route: "manual" } },
    ])
  })

  it("offers the reminder next to a setup error main holds for it", async () => {
    state.diagnostics = { state: "unasked", policy: false, reminder: { setup: true, signin: false } }
    state.createRegistration.mockRejectedValueOnce(new Error("Conditional Access blocked the sign-in (AADSTS53003). Nothing was changed."))
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    await flush()
    expect(container.textContent).toContain("Share this error and the next setup steps with TenuVault")
  })

  it("offers the reminder next to the notice of a reused registration that lacks admin consent", async () => {
    state.diagnostics = { state: "unasked", policy: false, reminder: { setup: true, signin: false } }
    state.createRegistration.mockResolvedValueOnce({ tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.com", reused: true, ready: true, displayName: "TenuVault Desktop", candidateCount: 1, missingConsent: ["DeviceManagementApps.ReadWrite.All"] })
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click(); await settle() })
    await flush()
    expect(container.textContent).toContain("has no tenant-wide admin consent")
    expect(container.textContent).toContain("Share this error and the next setup steps with TenuVault")
  })

  it("reports the storage kind before the tenant is saved", async () => {
    const account = { tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.com" }
    state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account, signedInAt: Date.now() }))
    state.accounts.mockResolvedValueOnce([account])
    state.storageChoice = { kind: "local" }
    state.checkNewTenant.mockResolvedValueOnce({ tenants: [{ tenantId: TENANT, plan: "community" }] })
    const order: string[] = []
    state.record.mockImplementation(async () => { order.push("record") })
    state.addTenant.mockImplementation(() => { order.push("addTenant") })
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Continue")!.click() })
    await flush()
    expect(state.record).toHaveBeenCalledWith({ name: "storage", props: { kind: "local" } })
    expect(order).toEqual(["record", "addTenant"])
    state.record.mockImplementation(async () => undefined)
    state.addTenant.mockImplementation(() => undefined)
  })
})
