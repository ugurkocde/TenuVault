import { act, createElement, useEffect, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SignedInAccount } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
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
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    storage: {
      getItemSync: (key: string) => state.store.get(key) ?? null,
      setItem: async (key: string, value: string) => void state.store.set(key, value),
      removeItem: async (key: string) => void state.store.delete(key),
    },
    auth: { signIn: state.signIn, cancelSignIn: state.cancelSignIn, accounts: state.accounts },
    license: { releaseTenant: state.releaseTenant, clipboardKey: async () => null, checkNewTenant: state.checkNewTenant },
    setup: { clipboardIds: state.clipboardIds, saveScript: async () => ({ saved: false }) },
    app: { openExternal: async () => undefined },
  },
}))
vi.mock("../../src/renderer/lib/license", () => ({
  useTenantPlan: () => "community",
  useLicense: () => ({ status: null, error: null, refresh: async () => undefined }),
  tenantLicense: (status: { tenants?: unknown[] } | undefined) => status?.tenants?.[0],
  tenantPlan: (tenant: { plan?: string } | undefined) => tenant?.plan ?? null,
}))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => state.tenants,
  useTenantOperations: () => ({ addTenant: state.addTenant, updateTenant: vi.fn() }),
  useSelectedTenant: () => ({ setSelectedTenantId: vi.fn() }),
}))
vi.mock("~/contexts/BackupProgressContext", () => ({
  useBackupProgress: () => ({ addJob: vi.fn(), removeJob: vi.fn(), activeJobs: [] }),
}))
vi.mock("../../src/renderer/components/StorageChooser", () => ({
  StorageChooser: ({ onChange }: { onChange: (choice: unknown) => void }) => {
    useEffect(() => { if (state.storageChoice) onChange(state.storageChoice) }, [])
    return createElement("p", null, "Storage chooser")
  },
}))

import OnboardingPage from "../../src/renderer/pages/OnboardingPage"
import { setupCommand, TenantSignInForm } from "../../src/renderer/components/TenantSignInForm"
import { loadOnboardingDraft, saveOnboardingDraft } from "../../src/renderer/lib/onboarding-draft"
import { AddTenantModal } from "../../src/renderer/overrides/add-tenant-modal"

const TENANT = "8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14"
const CLIENT = "5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3"
const DRAFT_KEY = "tenuvault.onboarding.draft"
const OUTPUT = `Done. Copy the two lines below and paste them into the Sign in step of Set up TenuVault:\n  Tenant id:                ${TENANT}\n  Application (client) id:  ${CLIENT}`

const roots: Root[] = []

beforeEach(() => {
  state.clipboardIds.mockReset()
  state.clipboardIds.mockResolvedValue(null)
  state.store.clear()
  state.tenants = []
  state.storageChoice = null
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  vi.clearAllMocks()
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
    state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account }))
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
    state.store.set(DRAFT_KEY, JSON.stringify({ step: 1, tenant: TENANT, clientId: CLIENT, displayName: "", account }))
    state.accounts.mockResolvedValueOnce([account])
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Use a different tenant or account")!.click() })
    await flush()
    expect(state.releaseTenant).toHaveBeenCalledWith(TENANT)
    expect(container.querySelector("#tenant")).not.toBeNull()
  })

  it("keeps an Azure choice from being saved when the tenant turned out to be on Community", async () => {
    const account = { tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.com" }
    state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account }))
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

  it("shows the Prepare checklist with the permissions and the handoff", async () => {
    const container = await render(createElement(OnboardingPage))
    expect(button(container, "Save setup script")).toBeDefined()
    expect(container.textContent).toContain("Privileged Role Administrator")
    expect(container.textContent).toContain("Permissions the app registration gets")
    expect(button(container, "Someone else is the admin? Copy instructions")).toBeDefined()
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
  state.store.set(DRAFT_KEY, JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "", account }))
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
