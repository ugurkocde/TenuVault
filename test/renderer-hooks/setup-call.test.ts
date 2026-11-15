import { act, createElement, useEffect, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LicenseStatus, SignedInAccount, TenantLicenseStatus } from "../../src/shared/ipc"
import type { SetupCallSource } from "../../src/shared/setup-call"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver

const state = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string) => undefined),
  license: null as unknown,
  tenants: [] as { id?: number; name?: string; credentials?: { tenantId?: string } }[],
  store: new Map<string, string>(),
  signIn: vi.fn<(tenant: string, clientId: string) => Promise<unknown>>(),
  createRegistration: vi.fn<() => Promise<unknown>>(),
  accounts: vi.fn(async (): Promise<unknown[]> => []),
  checkNewTenant: vi.fn(async (): Promise<unknown> => undefined),
  cancelBackup: vi.fn(async (_jobId: string): Promise<void> => undefined),
  cancelSetup: vi.fn(async (): Promise<void> => undefined),
  cancelSignIn: vi.fn(async (): Promise<boolean> => false),
  record: vi.fn(async (_event: unknown): Promise<void> => undefined),
  storageChoice: { kind: "local" } as unknown,
  activeJobs: [] as unknown[],
  diagnostics: "unasked",
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    app: { openExternal: state.openExternal, info: async () => ({}) },
    storage: {
      getItemSync: (key: string) => state.store.get(key) ?? null,
      setItem: async (key: string, value: string) => void state.store.set(key, value),
      removeItem: async (key: string) => void state.store.delete(key),
    },
    auth: { signIn: state.signIn, cancelSignIn: state.cancelSignIn, copySignInLink: async () => true, accounts: state.accounts, onSignInPhase: () => () => undefined },
    setup: { createRegistration: state.createRegistration, cancelCreateRegistration: state.cancelSetup, cancelSignIn: async () => false, onProgress: () => () => undefined, clipboardIds: async () => null, saveScript: async () => ({ saved: false }) },
    license: { open: async () => undefined, clipboardKey: async () => null, checkNewTenant: state.checkNewTenant, releaseTenant: async () => undefined, tenantTrialAction: async () => undefined, trialUsage: async () => null, trialWorkflowsConfigured: async () => false },
    diagnostics: { record: state.record, status: async () => ({ state: state.diagnostics, policy: false, reminder: { setup: false, signin: false } }), reminderShown: async () => undefined, consent: async () => undefined, decline: async () => undefined },
    preferences: { get: async () => ({ firstBackupNoteSeen: true }), set: async () => ({}) },
    schedules: { list: async () => [] },
    backups: { settings: async () => ({ recoveryExported: true }), cancel: state.cancelBackup },
    feedback: { capture: async () => null },
  },
}))
// The real license helpers, fed with the status of each test. Both hooks read it from here.
vi.mock("../../src/renderer/lib/license", async (original) => {
  const actual = await original<typeof import("../../src/renderer/lib/license")>()
  return {
    ...actual,
    useLicense: () => ({ status: state.license, signedInTenantIds: new Set<string>(), error: null, refresh: async () => undefined }),
    useTenantPlan: (tenantId: string | undefined) => actual.tenantPlan(actual.tenantLicense(state.license as LicenseStatus | null, tenantId)),
  }
})
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => state.tenants,
  useTenantOperations: () => ({ addTenant: (tenant: { credentials?: { tenantId?: string } }) => void state.tenants.push(tenant), updateTenant: () => undefined }),
  useSelectedTenant: () => ({ selectedTenant: null, selectedTenantId: null, setSelectedTenantId: () => undefined }),
}))
vi.mock("~/contexts/BackupProgressContext", () => ({
  useBackupProgress: () => ({ addJob: () => undefined, removeJob: () => undefined, updateJob: () => undefined, activeJobs: state.activeJobs }),
}))
vi.mock("../../src/renderer/components/StorageChooser", () => ({
  StorageChooser: ({ onChange }: { onChange: (choice: unknown) => void }) => {
    useEffect(() => { onChange(state.storageChoice) }, [])
    return createElement("p", null, "Storage chooser")
  },
}))
// The parts of the app layout these tests do not look at.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }))
vi.mock("~/components/backup/floating-progress", () => ({ FloatingProgress: () => null }))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: () => undefined, Toaster: () => null }))
vi.mock("../../src/renderer/lib/framework-jobs", () => ({ useFrameworkJobs: () => [], FrameworkJobNotifier: () => null }))
vi.mock("../../src/renderer/lib/cis-jobs", () => ({ CisJobNotifier: () => null }))
vi.mock("../../src/renderer/lib/drift-jobs", () => ({ DriftScanIndicator: () => null, DriftScanNotifier: () => null }))
vi.mock("../../src/renderer/features/scores/invalidate", () => ({ useScoreInvalidation: () => undefined }))
vi.mock("../../src/renderer/lib/whats-new", () => ({ useWhatsNew: () => ({ state: null }) }))
vi.mock("../../src/renderer/components/BackgroundTasksPanel", () => ({ BackgroundTasksPanel: () => null }))
vi.mock("../../src/renderer/components/SignInBanner", () => ({ SignInBanner: () => null }))
vi.mock("../../src/renderer/components/TenantSwitcher", () => ({ TenantSwitcher: () => null }))
vi.mock("../../src/renderer/components/UpdateSidebarLabel", () => ({ UpdateSidebarLabel: () => null }))
vi.mock("../../src/renderer/components/WhatsNewDialog", () => ({ WhatsNewAnnouncement: () => null, WhatsNewDialog: () => null }))
vi.mock("../../src/renderer/components/TenantAccessNotice", () => ({ TenantAccessNotice: () => null }))
vi.mock("../../src/renderer/components/oib/JobIndicator", () => ({ OibJobIndicator: () => null, OibJobCard: () => null }))
vi.mock("../../src/renderer/lib/appearance", () => ({ getAppearance: () => "light", setAppearance: () => undefined }))

import { ActivationScreen } from "../../src/renderer/components/ActivationScreen"
import { ConnectTenantSetup } from "../../src/renderer/components/ConnectTenantSetup"
import { DesktopLayout } from "../../src/renderer/components/DesktopLayout"
import { SetupCallLink } from "../../src/renderer/components/SetupCallLink"
import { RECOVERY_DELAY_MS } from "../../src/renderer/components/SignInRecovery"
import { SupportDialog } from "../../src/renderer/components/SupportDialog"
import { TenantSignInForm } from "../../src/renderer/components/TenantSignInForm"
import OnboardingPage from "../../src/renderer/pages/OnboardingPage"
import { FIRST_SIGN_IN_TIMEOUT_MESSAGE } from "../../src/shared/app-registration"
import setupCallLinkSource from "../../src/renderer/components/SetupCallLink.tsx?raw"

const TENANT = "8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14"
const CLIENT = "5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3"
const ACCOUNT: SignedInAccount = { tenantId: TENANT, clientId: CLIENT, username: "admin@contoso.example" }
const LABEL = "Book a free setup call"
const HINT = "Stuck here? Book a free setup call and we sort it out together."
const urlFor = (source: SetupCallSource) => `https://www.tenuvault.com/setup-call?src=app-${source}`
const roots: Root[] = []

beforeEach(() => {
  vi.useFakeTimers()
  state.license = null
  state.tenants = []
  state.activeJobs = []
  state.diagnostics = "unasked"
  state.storageChoice = { kind: "local" }
  state.store.clear()
  for (const mock of [state.signIn, state.createRegistration, state.accounts, state.checkNewTenant, state.cancelBackup, state.cancelSetup, state.cancelSignIn, state.record]) mock.mockReset()
  state.cancelBackup.mockResolvedValue(undefined)
  state.cancelSetup.mockResolvedValue(undefined)
  state.cancelSignIn.mockResolvedValue(false)
  state.record.mockResolvedValue(undefined)
  state.accounts.mockResolvedValue([])
  state.checkNewTenant.mockResolvedValue({ tenants: [] })
})

afterEach(async () => {
  await unmount()
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function advance(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function unmount() {
  for (const root of roots.splice(0)) act(() => root.unmount())
  await act(async () => { await vi.runOnlyPendingTimersAsync() })
  document.body.replaceChildren()
}

async function render(element: ReactElement, route = "/portal/onboarding") {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MemoryRouter, { initialEntries: [route] }, element)))
  await advance()
  return container
}

/** Renders the page again in the root of the last render, as the job store does when a job changes. */
async function rerender(element: ReactElement, route = "/portal/onboarding") {
  act(() => roots.at(-1)!.render(createElement(MemoryRouter, { initialEntries: [route] }, element)))
  await advance()
}

const button = (container: ParentNode, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)
const link = (source: SetupCallSource, container: ParentNode = document) => container.querySelector<HTMLButtonElement>(`[data-setup-call="${source}"]`)
const links = () => [...document.querySelectorAll<HTMLElement>("[data-setup-call]")].map((item) => item.dataset.setupCall)

/** Clicks the link of a screen and checks that the browser, and nothing else, was asked to open its page. */
async function expectOpens(source: SetupCallSource, container: ParentNode = document) {
  const element = link(source, container)
  expect(element, `the ${source} link`).not.toBeNull()
  state.openExternal.mockClear()
  await act(async () => { element!.click() })
  expect(state.openExternal.mock.calls).toEqual([[urlFor(source)]])
}

function tenantEntry(plan: "community" | "pro" | "msp", extra: Partial<TenantLicenseStatus> = {}): TenantLicenseStatus {
  const paid = plan !== "community"
  return { tenantId: TENANT, signedIn: true, activated: paid, entitled: paid, source: paid ? "key" : null, plan, tenants: paid ? 2 : null, expiresAt: paid ? "2030-01-01T00:00:00.000Z" : null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null, ...extra }
}

function licenseStatus(plan: "pro" | "msp" | null, tenants: TenantLicenseStatus[], extra: Partial<LicenseStatus> = {}): LicenseStatus {
  return { hasKey: plan !== null, keyState: plan ? "active" : "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan, tenantLimit: plan ? 2 : null, validUntil: null, communityTenantId: null, tenants, tenantTrialsEnabled: true, ...extra }
}

const COMMUNITY = licenseStatus(null, [tenantEntry("community")], { communityTenantId: TENANT })
const TRIAL = licenseStatus(null, [tenantEntry("pro", { source: "trial", trial: true, trialEndsAt: "2030-01-01T00:00:00.000Z", trialAcknowledged: true })])
const PRO = licenseStatus("pro", [tenantEntry("pro")])
const MSP = licenseStatus("msp", [tenantEntry("msp")])

/** A first sign-in that waits for the browser. */
async function waitingSignIn() {
  state.signIn.mockImplementationOnce(() => new Promise(() => undefined))
  const container = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn(), initial: { tenant: TENANT, clientId: CLIENT } }))
  await act(async () => { button(container, "Sign in with Microsoft")!.click() })
  return container
}

/** A setup sign-in that waits for the browser. */
async function waitingSetup(trials = false) {
  state.createRegistration.mockImplementationOnce(() => new Promise(() => undefined))
  const container = await render(createElement(ConnectTenantSetup, { trials, onManual: vi.fn(), onRegistered: vi.fn() }))
  await act(async () => { button(container, "Set up with Microsoft sign-in")!.click() })
  return container
}

async function failedSetup(message: string, trials = false) {
  state.createRegistration.mockRejectedValueOnce(new Error(message))
  const container = await render(createElement(ConnectTenantSetup, { trials, onManual: vi.fn(), onRegistered: vi.fn() }))
  await act(async () => { button(container, "Set up with Microsoft sign-in")!.click() })
  await advance()
  return container
}

async function failedSignIn(message: string) {
  state.signIn.mockRejectedValueOnce(new Error(message))
  const container = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn(), initial: { tenant: TENANT, clientId: CLIENT } }))
  await act(async () => { button(container, "Sign in with Microsoft")!.click() })
  await advance()
  return container
}

/** The guided setup on its First backup step, for a tenant that was signed in and saved just now. */
async function firstBackupStep() {
  state.store.set("tenuvault.onboarding.draft", JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "Contoso", account: ACCOUNT, signedInAt: Date.now() }))
  state.accounts.mockResolvedValue([ACCOUNT])
  const container = await render(createElement(OnboardingPage))
  await act(async () => { button(container, "Continue")!.click() })
  await advance()
  expect(container.textContent).toContain("Take a first backup")
  return container
}

/** The guided setup back on its Sign in step, after the license check refused the tenant on Continue. */
async function refusedAfterContinue() {
  state.store.set("tenuvault.onboarding.draft", JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "Contoso", account: ACCOUNT, signedInAt: Date.now() }))
  state.accounts.mockResolvedValue([ACCOUNT])
  state.checkNewTenant.mockRejectedValueOnce(new Error("This license does not cover another tenant."))
  const container = await render(createElement(OnboardingPage))
  await act(async () => { button(container, "Continue")!.click() })
  await advance()
  expect(container.textContent).toContain("Sign in to your tenant")
  return container
}

/** Runs the first backup with the answer of the start request and, when it started, the job the store reports. */
async function runFirstBackup(start: () => Response, job?: { isComplete: boolean; isSuccessful: boolean; status: string; progressMessage: string; exception?: string }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === "/api/backup/start" ? start() : Response.json({}))))
  if (job) state.activeJobs = [{ jobId: "first", progress: 100, ...job }]
  const container = await firstBackupStep()
  await act(async () => { button(container, "Run first backup")!.click() })
  await advance()
  return container
}

const startFails = () => Response.json({ error: "The backup could not start." }, { status: 500 })
const started = () => Response.json({ jobId: "first" })

describe("the shared setup call component", () => {
  it.each([
    ["row", "Rather do it together? Book a free setup call30 minutes, free on every plan. You share your screen and we set it up in your tenant.", LABEL],
    ["nav", "Free setup call", "Free setup call"],
    ["button", LABEL, LABEL],
    ["hint", HINT, LABEL],
  ] as const)("the %s variant shows its text and opens the page for its screen in the browser", async (variant, text, label) => {
    const container = await render(createElement(SetupCallLink, { source: "welcome", variant }))
    expect(container.textContent).toBe(text)
    expect(link("welcome", container)!.textContent).toBe(label)
    expect(container.querySelectorAll("button")).toHaveLength(1)
    await expectOpens("welcome", container)
    // Opening the page is not a setup diagnostics event.
    expect(state.record).not.toHaveBeenCalled()
  })

  it.each(["welcome", "setup-header", "signin-waiting", "setup-error", "signin-error", "first-backup-error", "support"] as const)("names the screen %s in the link", async (source) => {
    const container = await render(createElement(SetupCallLink, { source, variant: "button" }))
    await expectOpens(source, container)
  })

  it("tells a dialog that the link was opened, and stays quiet when the browser cannot be opened", async () => {
    const onOpened = vi.fn()
    state.openExternal.mockRejectedValueOnce(new Error("No browser"))
    const container = await render(createElement(SetupCallLink, { source: "support", variant: "button", onOpened }))
    await expectOpens("support", container)
    await advance()
    expect(onOpened).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it("reads no license state and keeps no state of its own", () => {
    expect(setupCallLinkSource).not.toMatch(/lib\/license|useLicense|useTenantPlan|hasPaidLicense|useState|useEffect/)
    expect(setupCallLinkSource.match(/bridge\.[a-zA-Z]+\.[a-zA-Z]+/g)).toEqual(["bridge.app.openExternal"])
  })
})

describe("welcome screen", () => {
  it("offers the call between the helper text of Connect your tenant and the setup diagnostics question", async () => {
    state.license = licenseStatus(null, [])
    const container = await render(createElement(ActivationScreen, { onSignIn: vi.fn() }))
    const helper = [...container.querySelectorAll("p")].find((item) => item.textContent?.startsWith("New tenants start with a Pro trial"))!
    const diagnostics = container.querySelector('section[aria-labelledby="setup-diagnostics-title"]')!
    const row = link("welcome", container)!
    expect(helper.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row.compareDocumentPosition(diagnostics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.textContent).toContain("Rather do it together? Book a free setup call")
    expect(container.textContent).toContain("30 minutes, free on every plan. You share your screen and we set it up in your tenant.")
    await expectOpens("welcome", container)
  })

  it("keeps Connect your tenant as the first action and leaves it working", async () => {
    const onSignIn = vi.fn()
    const container = await render(createElement(ActivationScreen, { onSignIn }))
    const buttons = [...container.querySelectorAll("button")]
    expect(buttons[0]!.textContent).toContain("Connect your tenant")
    expect(buttons.indexOf(link("welcome", container)!)).toBe(1)
    await act(async () => { buttons[0]!.click() })
    expect(onSignIn).toHaveBeenCalledTimes(1)
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it("shows the row when the diagnostics question is not asked", async () => {
    state.diagnostics = "declined"
    const container = await render(createElement(ActivationScreen, { onSignIn: vi.fn() }))
    expect(container.querySelector('section[aria-labelledby="setup-diagnostics-title"]')).toBeNull()
    await expectOpens("welcome", container)
  })
})

describe("first-run header", () => {
  it("lists Free setup call next to License, Share feedback and Support while no tenant is connected", async () => {
    const container = await render(createElement(DesktopLayout), "/portal/onboarding")
    expect([...container.querySelectorAll('nav[aria-label="Help"] > *')].map((item) => item.textContent)).toEqual(["Free setup call", "License", "Share feedback", "Support"])
    await expectOpens("setup-header", container)
  })

  it("belongs to the first-run header only: the sidebar of a connected tenant has no such entry", async () => {
    state.tenants = [{ id: 1, name: "Contoso", credentials: { tenantId: TENANT } }]
    state.license = COMMUNITY
    const container = await render(createElement(DesktopLayout), "/portal/onboarding")
    expect(container.querySelector('nav[aria-label="Help"]')).toBeNull()
    expect(container.querySelector('nav[aria-label="Main navigation"]')).not.toBeNull()
    expect(links()).toEqual([])
  })

  it("opens the Support dialog with the call as its third button", async () => {
    const container = await render(createElement(DesktopLayout), "/portal/onboarding")
    await act(async () => { button(container, "Support")!.click() })
    await advance()
    const dialog = document.querySelector('[role="dialog"]')!
    expect([...dialog.querySelectorAll("button")].map((item) => item.textContent?.trim()).filter((label) => label !== "Close")).toEqual(["Documentation", "Open GitHub issue", LABEL])
    await expectOpens("support", dialog)
  })
})

describe("waiting panel", () => {
  it.each([
    ["first sign-in", waitingSignIn],
    ["setup sign-in", waitingSetup],
  ] as const)("offers the call beside the other ways on, after 3 minutes of the %s", async (_kind, start) => {
    const container = await start()
    await advance(RECOVERY_DELAY_MS - 1)
    expect(links()).toEqual([])
    await advance(1)
    const panel = container.querySelector("[data-sign-in-recovery]")!
    expect([...panel.querySelectorAll("button")].map((item) => item.textContent?.trim())).toEqual(["Try again", "Copy sign-in link", "Copy instructions for your admin", LABEL])
    await expectOpens("signin-waiting", panel)
    // Opening the page leaves the waiting sign-in alone.
    expect(container.querySelector("[data-sign-in-recovery]")).not.toBeNull()
  })
})

describe("setup sign-in and provisioning errors", () => {
  it.each([
    ["an error with its own actions", "Microsoft Graph Command Line Tools is blocked in this tenant. Create the app registration by hand instead. (AADSTS7000112)", ["Create it by hand", "I already have an app registration", LABEL]],
    ["an error that offers no other action", "Microsoft Graph refused to create the app registration: Insufficient privileges to complete the operation.", [LABEL]],
    ["an error after the app registration was created", "Could not grant admin consent: the request timed out.", [LABEL]],
  ] as const)("offers the call under %s", async (_name, message, buttons) => {
    const container = await failedSetup(message)
    const alert = container.querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.textContent).toContain(message)
    expect(alert.textContent).toContain(HINT)
    expect([...alert.querySelectorAll("button")].map((item) => item.textContent?.trim())).toEqual(buttons)
    await expectOpens("setup-error", alert)
  })

  it("shows nothing before an error and nothing after a cancelled setup", async () => {
    const container = await render(createElement(ConnectTenantSetup, { trials: false, onManual: vi.fn(), onRegistered: vi.fn() }))
    expect(links()).toEqual([])
    state.createRegistration.mockRejectedValueOnce(new Error("Sign-in cancelled."))
    await act(async () => { button(container, "Set up with Microsoft sign-in")!.click() })
    await advance()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(links()).toEqual([])
  })

  it("offers nothing next to a cancel that failed while the setup still runs", async () => {
    state.cancelSetup.mockRejectedValueOnce(new Error("Could not cancel the setup."))
    const container = await waitingSetup()
    await act(async () => { button(container, "Cancel")!.click() })
    await advance()
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("Could not cancel the setup.")
    expect(links()).toEqual([])
  })

  it("offers nothing next to a copy of the admin instructions that failed, also after a failed setup", async () => {
    const container = await failedSetup("Microsoft Graph refused to create the app registration.")
    expect(links()).toEqual(["setup-error"])
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("The clipboard is blocked.") } } })
    try {
      await act(async () => { button(container, "Someone else is the admin? Copy instructions")!.click() })
      await advance()
    } finally {
      Reflect.deleteProperty(navigator, "clipboard")
    }
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("Could not copy: The clipboard is blocked.")
    expect(links()).toEqual([])
  })
})

describe("first sign-in errors", () => {
  it.each([
    ["the 15 minute timeout", FIRST_SIGN_IN_TIMEOUT_MESSAGE, ["Try again", "Copy instructions for your admin", LABEL]],
    ["a Conditional Access refusal", "Conditional Access blocked this sign-in. (AADSTS53003)", ["Copy instructions for your admin", "Create it by hand", LABEL]],
    ["an error that had no action before", "Microsoft could not find this application in the tenant. (AADSTS700016)", [LABEL]],
    ["an error without a Microsoft code", "The sign-in could not be completed.", [LABEL]],
  ] as const)("offers the call under %s", async (_name, message, buttons) => {
    const container = await failedSignIn(message)
    const alert = container.querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.textContent).toContain(HINT)
    expect([...alert.querySelectorAll("button")].map((item) => item.textContent?.trim())).toEqual(buttons)
    await expectOpens("signin-error", alert)
  })

  it("shows nothing while there is no error", async () => {
    await render(createElement(TenantSignInForm, { onSignedIn: vi.fn(), initial: { tenant: TENANT, clientId: CLIENT } }))
    expect(links()).toEqual([])
  })

  it("offers nothing under messages about a value that was entered", async () => {
    const container = await render(createElement(TenantSignInForm, { onSignedIn: vi.fn(), initial: { tenant: "not a tenant", clientId: "not-a-guid" } }))
    await act(async () => { button(container, "Sign in with Microsoft")!.click() })
    await advance()
    expect(container.textContent).toContain("Enter a tenant id or a domain such as contoso.onmicrosoft.com.")
    expect(container.textContent).toContain("The client id is a GUID, printed by the setup script.")
    expect(state.signIn).not.toHaveBeenCalled()
    expect(links()).toEqual([])
  })

  it("offers nothing next to a cancel that failed while the sign-in still runs", async () => {
    state.cancelSignIn.mockRejectedValueOnce(new Error("Could not cancel the sign-in."))
    const container = await waitingSignIn()
    await act(async () => { button(container, "Cancel sign-in")!.click() })
    await advance()
    expect([...container.querySelectorAll('[role="alert"]')].some((alert) => alert.textContent?.includes("Could not cancel the sign-in."))).toBe(true)
    expect(links()).toEqual([])
  })
})

describe("first backup", () => {
  it("offers the call when the backup could not start", async () => {
    const container = await runFirstBackup(startFails)
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("The backup could not start.")
    expect(container.textContent).toContain(HINT)
    expect(links()).toEqual(["first-backup-error"])
    await expectOpens("first-backup-error", container)
  })

  it("offers the call when the backup ended with an error", async () => {
    const container = await runFirstBackup(started, { isComplete: true, isSuccessful: false, status: "Failed", progressMessage: "Backup failed", exception: "Microsoft Graph refused the request." })
    expect(container.textContent).toContain("Microsoft Graph refused the request.")
    expect(button(container, "Try again")).toBeDefined()
    expect(links()).toEqual(["first-backup-error"])
    await expectOpens("first-backup-error", container)
  })

  it.each([
    ["before the backup runs", undefined],
    ["while the backup runs", { isComplete: false, isSuccessful: false, status: "Running", progressMessage: "Reading policies..." }],
    ["after a backup the admin cancelled", { isComplete: true, isSuccessful: false, status: "Cancelled", progressMessage: "Backup cancelled", exception: "Backup cancelled by you." }],
    ["after a successful backup", { isComplete: true, isSuccessful: true, status: "Completed", progressMessage: "Backup completed" }],
  ] as const)("offers nothing %s", async (_name, job) => {
    if (job) await runFirstBackup(started, job)
    else await firstBackupStep()
    expect(links()).toEqual([])
  })
})

describe("a cancel of the first backup that failed", () => {
  const running = { isComplete: false, isSuccessful: false, status: "Running", progressMessage: "Reading policies..." }

  async function failedCancel() {
    state.cancelBackup.mockRejectedValueOnce(new Error("Could not cancel the backup. Try again."))
    const container = await runFirstBackup(started, running)
    await act(async () => { button(container, "Cancel backup")!.click() })
    await advance()
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("Could not cancel the backup. Try again.")
    return container
  }

  it("is not a failed backup: nothing is offered while the backup still runs", async () => {
    await failedCancel()
    expect(links()).toEqual([])
  })

  it("leaves no error and no offer behind when the backup then succeeds", async () => {
    const container = await failedCancel()
    state.activeJobs = [{ jobId: "first", progress: 100, isComplete: true, isSuccessful: true, status: "Completed", progressMessage: "Backup completed" }]
    await rerender(createElement(OnboardingPage))
    expect(container.textContent).toContain("Your first backup is done")
    expect(container.textContent).not.toContain("Could not cancel the backup")
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(links()).toEqual([])
  })

  it("leaves no error and no offer behind when a second cancel then ends the backup", async () => {
    const container = await failedCancel()
    await act(async () => { button(container, "Cancel backup")!.click() })
    await advance()
    expect(state.cancelBackup).toHaveBeenCalledTimes(2)
    state.activeJobs = [{ jobId: "first", progress: 100, isComplete: true, isSuccessful: false, status: "Cancelled", progressMessage: "Backup cancelled", exception: "Backup cancelled by you." }]
    await rerender(createElement(OnboardingPage))
    expect(container.textContent).toContain("Backup cancelled by you.")
    expect(container.textContent).not.toContain("Could not cancel the backup")
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(links()).toEqual([])
  })

  it("ignores the answer to a cancel that arrives after the backup ended", async () => {
    let fail!: (error: Error) => void
    state.cancelBackup.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    const container = await runFirstBackup(started, running)
    await act(async () => { button(container, "Cancel backup")!.click() })
    state.activeJobs = [{ jobId: "first", progress: 100, isComplete: true, isSuccessful: true, status: "Completed", progressMessage: "Backup completed" }]
    await rerender(createElement(OnboardingPage))
    expect(container.textContent).toContain("Your first backup is done")
    await act(async () => { fail(new Error("Could not cancel the backup. Try again.")) })
    await advance()
    expect(container.textContent).not.toContain("Could not cancel the backup")
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(links()).toEqual([])
  })

  it("still offers the call when the backup then ends with an error", async () => {
    const container = await failedCancel()
    state.activeJobs = [{ jobId: "first", progress: 100, isComplete: true, isSuccessful: false, status: "Failed", progressMessage: "Backup failed", exception: "Microsoft Graph refused the request." }]
    await rerender(createElement(OnboardingPage))
    expect(container.textContent).not.toContain("Could not cancel the backup")
    expect(links()).toEqual(["first-backup-error"])
  })
})

describe("errors the Sign in step shows after a later step sent the admin back", () => {
  it("offers the call once under a license refusal, also when the sign-in form then shows an error of its own", async () => {
    const container = await refusedAfterContinue()
    const refusal = container.querySelector<HTMLElement>('[role="alert"]')!
    expect(refusal.textContent).toContain("This license does not cover another tenant. TenuVault signed you out of this tenant.")
    expect(refusal.textContent).toContain(HINT)
    expect(links()).toEqual(["signin-error"])
    await expectOpens("signin-error", refusal)

    state.signIn.mockRejectedValueOnce(new Error("Conditional Access blocked this sign-in. (AADSTS53003)"))
    await act(async () => { button(container, "Sign in with Microsoft")!.click() })
    await advance()
    const alerts = [...container.querySelectorAll<HTMLElement>('[role="alert"]')]
    expect(alerts.some((alert) => alert !== refusal && alert.textContent?.includes("AADSTS53003"))).toBe(true)
    expect(links()).toEqual(["signin-error"])
    expect(link("signin-error", refusal)).not.toBeNull()
  })

  it("offers nothing for a tenant that is already connected, and the sign-in form keeps its own offer", async () => {
    state.tenants = [{ id: 1, name: "Contoso", credentials: { tenantId: TENANT } }]
    state.store.set("tenuvault.onboarding.draft", JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "Contoso", account: ACCOUNT, signedInAt: Date.now() }))
    state.accounts.mockResolvedValue([ACCOUNT])
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Continue")!.click() })
    await advance()
    const connected = container.querySelector<HTMLElement>('[role="alert"]')!
    expect(connected.textContent).toContain("This tenant is already connected to TenuVault.")
    expect(connected.textContent).toContain("Go to dashboard")
    expect(links()).toEqual([])

    state.signIn.mockRejectedValueOnce(new Error("Microsoft could not find this application in the tenant. (AADSTS700016)"))
    await act(async () => { button(container, "Sign in with Microsoft")!.click() })
    await advance()
    expect(links()).toEqual(["signin-error"])
    expect(link("signin-error", connected)).toBeNull()
  })

  it("leaves the plain error line of the Storage step as it is, also when Previous shows it on the Sign in step", async () => {
    state.store.set("tenuvault.onboarding.draft", JSON.stringify({ step: 2, tenant: TENANT, clientId: CLIENT, displayName: "Contoso", account: ACCOUNT, signedInAt: Date.now() }))
    state.accounts.mockResolvedValue([ACCOUNT])
    // The plan changed between the storage choice and the check: the page stays on Storage.
    state.storageChoice = { kind: "azure", storageAccountName: "contosobackups", subscriptionId: "sub", resourceGroupName: "rg", location: "westeurope" }
    state.checkNewTenant.mockResolvedValueOnce(COMMUNITY)
    const container = await render(createElement(OnboardingPage))
    await act(async () => { button(container, "Continue")!.click() })
    await advance()
    expect(container.textContent).toContain("Choose where backups are stored")
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("This tenant is on Community now, which keeps backups on this device. Choose This device to continue.")
    expect(links()).toEqual([])

    await act(async () => { button(container, "Previous")!.click() })
    await advance()
    expect(container.textContent).toContain("Sign in to your tenant")
    expect(container.textContent).toContain("This tenant is on Community now, which keeps backups on this device.")
    expect(links()).toEqual([])
  })
})

describe("Support dialog", () => {
  it.each([
    ["Community", COMMUNITY, "Open GitHub issue"],
    ["a Pro trial", TRIAL, "Email Support"],
    ["Pro", PRO, "Email Support"],
    ["MSP", MSP, "Email Support"],
    ["no license status", null, "Open GitHub issue"],
  ] as const)("keeps its two buttons and adds the call on %s", async (_name, status, second) => {
    state.license = status
    const onOpenChange = vi.fn()
    await render(createElement(SupportDialog, { open: true, onOpenChange }))
    const dialog = document.querySelector('[role="dialog"]')!
    expect([...dialog.querySelectorAll("button")].map((item) => item.textContent?.trim()).filter((label) => label !== "Close")).toEqual(["Documentation", second, LABEL])
    await expectOpens("support", dialog)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("every placement on every plan", () => {
  const PLACEMENTS: readonly (readonly [string, SetupCallSource, () => Promise<unknown>])[] = [
    ["welcome screen", "welcome", () => render(createElement(ActivationScreen, { onSignIn: vi.fn() }))],
    ["first-run header", "setup-header", () => render(createElement(DesktopLayout), "/portal/onboarding")],
    ["waiting panel of the first sign-in", "signin-waiting", async () => { await waitingSignIn(); await advance(RECOVERY_DELAY_MS) }],
    ["waiting panel of the setup sign-in", "signin-waiting", async () => { await waitingSetup(); await advance(RECOVERY_DELAY_MS) }],
    ["waiting panel of the setup sign-in with tenant trials", "signin-waiting", async () => { await waitingSetup(true); await advance(RECOVERY_DELAY_MS) }],
    ["setup error", "setup-error", () => failedSetup("Microsoft Graph refused to create the app registration.")],
    ["setup error with tenant trials", "setup-error", () => failedSetup("Microsoft Graph refused to create the app registration.", true)],
    ["first sign-in error", "signin-error", () => failedSignIn("Microsoft could not find this application in the tenant. (AADSTS700016)")],
    ["license refusal on the Sign in step", "signin-error", refusedAfterContinue],
    ["first backup failure", "first-backup-error", () => runFirstBackup(startFails)],
    ["Support dialog", "support", () => render(createElement(SupportDialog, { open: true, onOpenChange: vi.fn() }))],
  ]

  it.each([
    ["without a license status", null],
    ["on a fresh install", licenseStatus(null, [])],
    ["on Community", COMMUNITY],
    ["on a Pro trial", TRIAL],
    ["on Pro", PRO],
    ["on MSP", MSP],
    ["with tenant trials switched off", licenseStatus(null, [], { tenantTrialsEnabled: false })],
  ] as const)("shows the same link %s", async (_name, status) => {
    for (const [name, source, show] of PLACEMENTS) {
      state.license = status
      state.checkNewTenant.mockResolvedValue(status ?? { tenants: [] })
      await show()
      expect(links(), name).toEqual([source])
      await expectOpens(source)
      await unmount()
      state.tenants = []
      state.activeJobs = []
      state.store.clear()
    }
  })
})
