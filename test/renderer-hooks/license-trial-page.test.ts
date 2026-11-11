import { ORGANIZATION_LICENSE_MESSAGE, ORGANIZATION_LICENSE_GUIDANCE } from "../../src/shared/constants"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LicenseStatus } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  open: vi.fn(async () => undefined),
  startTrial: vi.fn(async () => undefined),
  deactivate: vi.fn(async () => undefined),
  setKey: vi.fn(async (): Promise<LicenseStatus | undefined> => undefined),
  replaceKey: vi.fn(async (): Promise<LicenseStatus | undefined> => undefined),
  openExternal: vi.fn(async () => undefined),
  clipboardKey: vi.fn(async (): Promise<string | null> => null),
  status: null as LicenseStatus | null,
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    auth: { accounts: async () => [] },
    license: {
      refresh: async () => undefined,
      open: state.open,
      startTrial: state.startTrial,
      deactivate: state.deactivate,
      setKey: state.setKey,
      replaceKey: state.replaceKey,
      clipboardKey: state.clipboardKey,
      status: async () => state.status,
    },
    app: { openExternal: state.openExternal },
  },
}))
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: state.status, error: null, refresh: async () => undefined }),
}))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [] }))
vi.mock("~/components/ConfirmDialog", () => ({ useConfirm: () => ({ confirm: async () => true, confirmDialog: null }) }))
vi.mock("@desktop/components/LicenseAgreementDialog", () => ({ LicenseAgreementLink: () => null }))

import LicensePage from "../../src/renderer/pages/LicensePage"

const community: LicenseStatus = {
  hasKey: false, keyState: "none", keyMessage: null, keyHint: null, persisted: true,
  offline: false, message: null, plan: null, tenantLimit: null, validUntil: null, trial: false,
  communityTenantId: null, tenants: [],
}

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  vi.clearAllMocks()
})

async function render(status: LicenseStatus) {
  state.status = status
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MemoryRouter, null, createElement(LicensePage))))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return container
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("License page trial", () => {
  it("starts the no-card trial in the app and keeps Buy now secondary", async () => {
    const container = await render(community)
    expect(container.textContent).toContain("Try Pro free for 30 days, no card needed.")
    expect(container.textContent).not.toContain("on request")
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!
    type(email, "admin@contoso.com")
    await act(async () => { button(container, "Start free trial")!.click() })
    expect(state.startTrial).toHaveBeenCalledWith("admin@contoso.com", { source: "license-page" })
    expect(container.textContent).toContain("Check your inbox at admin@contoso.com")
    expect(container.textContent).toContain("Copy the key from your email and return to TenuVault: it activates by itself.")

    await act(async () => { button(container, "Buy now")!.click() })
    expect(state.open).toHaveBeenCalledWith("checkout", { source: "license-page" })
  })

  it("activates a trial key copied from the email when TenuVault gets focus", async () => {
    const container = await render(community)
    // Before a trial was requested the clipboard is never read.
    await act(async () => { window.dispatchEvent(new Event("focus")) })
    expect(state.clipboardKey).not.toHaveBeenCalled()

    type(container.querySelector<HTMLInputElement>('input[type="email"]')!, "admin@contoso.com")
    await act(async () => { button(container, "Start free trial")!.click() })
    state.clipboardKey.mockResolvedValueOnce("TENU-TRIAL-KEY-0001")
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(state.setKey).toHaveBeenCalledWith("TENU-TRIAL-KEY-0001")
  })

  it("offers an invoice for buyers who cannot pay by card", async () => {
    for (const status of [
      community,
      { ...community, hasKey: true, keyState: "active" as const, plan: "pro" as const, tenantLimit: 2, trial: true, trialEndsAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
      { ...community, hasKey: true, keyState: "failed" as const },
    ]) {
      const container = await render(status)
      expect(container.textContent).toContain("Need an invoice instead of a card?")
      const link = container.querySelector<HTMLAnchorElement>('a[href^="mailto:support@tenuvault.com"]')!
      expect(link.textContent).toBe("support@tenuvault.com")
      await act(async () => { link.click() })
      expect(state.openExternal).toHaveBeenLastCalledWith("mailto:support@tenuvault.com?subject=TenuVault%20invoice%20or%20quote%20request")
      for (const root of roots.splice(0)) act(() => root.unmount())
      document.body.innerHTML = ""
    }
  })

  it("shows when the trial ends and buys Pro without another trial", async () => {
    const validUntil = new Date(Date.now() + 9.5 * 24 * 60 * 60_000).toISOString()
    const container = await render({ ...community, hasKey: true, keyState: "active", keyHint: "****ABCD", plan: "pro", tenantLimit: 2, trialEndsAt: validUntil, trial: true })
    expect(container.textContent).not.toContain("so this key is not needed on this computer")
    expect(container.textContent).toContain("Pro trial active")
    expect(container.textContent).toContain("in 10 days")
    expect(container.querySelector('input[type="email"]')).toBeNull()
    await act(async () => { button(container, "Buy Pro")!.click() })
    expect(state.open).toHaveBeenCalledWith("checkout", { source: "license-page-trial" })
  })

  it("counts an active tenant trial without a saved key", async () => {
    const trialEndsAt = new Date(Date.now() + 5 * 86_400_000).toISOString()
    const container = await render({ ...community, tenantTrialsEnabled: true, plan: "pro", tenantLimit: 2, trial: true, trialEndsAt,
      tenants: [{ tenantId: "11111111-2222-4333-8444-555555555555", signedIn: true, activated: true, entitled: true, source: "trial", plan: "pro", tenants: 2, expiresAt: trialEndsAt, validUntil: trialEndsAt, trial: true, trialEndsAt, trialAcknowledged: true, shared: null, shareNeedsSignIn: false, displayKey: null, message: null }],
    })
    expect(container.textContent).toContain("1 is active on this machine")
    expect(container.textContent).toContain("Pro trial")
    expect(container.textContent).toContain("Trial ends")
    expect(container.textContent).not.toContain("Active, Pro")
    expect(container.textContent).not.toContain("Valid until")
    expect(container.textContent).not.toContain("so this key is not needed on this computer")
    expect(container.textContent).toContain("Pro trial active")
    expect(container.textContent).not.toContain("Try Pro free for 30 days")
  })

  it("offers the key swap for a saved key that is no longer active", async () => {
    const container = await render({ ...community, hasKey: true, keyState: "failed", keyHint: "****ABCD", keyMessage: "This license key has expired." })
    expect(container.textContent).toContain("Your saved key is not active")
    await act(async () => { button(container, "Enter a new key")!.click() })
    type(container.querySelector<HTMLInputElement>("#replacement-key")!, "TENU-PAID-0001")
    await act(async () => { button(container, "Use this key")!.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(state.replaceKey).toHaveBeenCalledWith("TENU-PAID-0001")
    expect(state.deactivate).not.toHaveBeenCalled()
  })

  it("swaps the trial key for the paid key", async () => {
    const validUntil = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString()
    const container = await render({ ...community, hasKey: true, keyState: "active", keyHint: "****ABCD", plan: "pro", tenantLimit: 2, trialEndsAt: validUntil, trial: true })
    await act(async () => { button(container, "Enter your new key")!.click() })
    type(container.querySelector<HTMLInputElement>("#replacement-key")!, "TENU-PAID-0001")
    await act(async () => { button(container, "Use this key")!.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    // One call in the main process keeps the trial key until the new key is accepted.
    expect(state.replaceKey).toHaveBeenCalledWith("TENU-PAID-0001")
    expect(state.deactivate).not.toHaveBeenCalled()
    expect(state.setKey).not.toHaveBeenCalled()
  })
})

it.each([false, true])("shows a tenant trial key refusal with purchasing actions (extension %s)", async canExtend => {
  const message = "This tenant already had a Pro trial. Buy Pro to continue, or write to support@tenuvault.com for a quote or an invoice."
  const tenant = { tenantId: "11111111-2222-4333-8444-555555555555", signedIn: true, activated: false, entitled: false, source: null, plan: null, tenants: null, expiresAt: null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message, trialCanExtend: canExtend }
  const container = await render({ ...community, tenantTrialsEnabled: true, hasKey: true, keyState: "pending", tenants: [tenant] })
  expect(container.textContent).toContain("This tenant already had a Pro trial.")
  expect(container.textContent).not.toContain(message)
  expect(container.textContent?.match(/support@tenuvault\.com/g)).toHaveLength(1)
  expect(container.textContent).not.toContain("Need an invoice instead of a card?")
  expect(button(container, "Try Pro free")).toBeUndefined()
  expect(Boolean(button(container, "Extend your trial"))).toBe(canExtend)
  const buy = button(container, "Buy Pro")!
  const mailto = container.querySelector<HTMLAnchorElement>('a[href^="mailto:support@tenuvault.com?subject=TenuVault%20Pro"]')!
  expect(buy).toBeTruthy()
  expect(mailto).toBeTruthy()
  expect(buy.compareDocumentPosition(mailto) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(new URL(mailto.href).searchParams.get("subject")).toBe("TenuVault Pro: quote or invoice")
  expect(new URL(mailto.href).searchParams.has("body")).toBe(false)
  expect(mailto.href).not.toContain(tenant.tenantId)
  await act(async () => { buy.click(); mailto.click() })
  expect(state.open).toHaveBeenCalledWith("checkout", { source: "license-page-trial-key-refused" })
  expect(state.openExternal).toHaveBeenCalledWith(mailto.href)
})

it("shows the shared purchasing actions for a thrown trial key activation error", async () => {
  const message = "This tenant already had a Pro trial. Buy Pro to continue, or write to support@tenuvault.com for a quote or an invoice."
  state.setKey.mockRejectedValueOnce(new Error(message))
  const container = await render(community)
  type(container.querySelector<HTMLInputElement>('#license-key')!, "TENU-TRIAL-KEY-0001")
  await act(async () => button(container, "Activate")!.click())
  const alert = [...container.querySelectorAll('[role="alert"]')].find(node => node.textContent?.includes("This tenant already had a Pro trial."))!
  expect(alert.textContent).toContain("This tenant already had a Pro trial.")
  expect(alert.textContent).not.toContain(message)
  expect(button(alert as HTMLElement, "Buy Pro")).toBeTruthy()
  expect(alert.querySelector('a[href^="mailto:support@tenuvault.com"]')).toBeTruthy()
  expect(button(alert as HTMLElement, "Extend your trial")).toBeUndefined()
})

const organizationCovered: LicenseStatus = {
  ...community, hasKey: true, keyState: "pending", keyHint: "****TEST",
  tenants: ["contoso", "fabrikam"].map(tenantId => ({
    tenantId, signedIn: true, activated: true, entitled: true, source: "tenant", plan: "msp",
    tenants: 10, expiresAt: null, validUntil: null, shared: null, shareNeedsSignIn: false,
    displayKey: null, message: null,
  })),
}
const neutralSavedKeyNote = "Your signed-in tenants are licensed through your organization, so this key is not needed on this computer. It stays saved and activates for a tenant that is not covered yet."
const organizationSaveConfirmation = "License key saved. Your signed-in tenants are already licensed through your organization."

it("explains a saved key is not needed when signed-in tenants have organization coverage", async () => {
  const container = await render(organizationCovered)
  expect(container.textContent).toContain(neutralSavedKeyNote)
  expect(container.textContent).toContain("Licensed through your organization")
  expect(container.textContent).not.toContain("not active")
  expect(container.textContent).not.toContain("Buy Pro")
  expect(container.textContent).not.toContain("Need an invoice instead of a card?")
  const { licenseChipState } = await import("../../src/renderer/lib/license")
  expect(licenseChipState(organizationCovered)).toEqual({ label: "Organization", tone: "neutral" })
})

it.each(["failed", "uncovered", "signed-out"])("keeps the saved key replacement for %s", async scenario => {
  const status: LicenseStatus = {
    ...organizationCovered,
    keyState: scenario === "failed" ? "failed" : "pending",
    tenants: organizationCovered.tenants.map(tenant => ({ ...tenant,
      entitled: scenario === "uncovered" && tenant.tenantId === "fabrikam" ? false : tenant.entitled,
      signedIn: scenario === "signed-out" ? false : tenant.signedIn,
    })),
  }
  const container = await render(status)
  expect(container.textContent).toContain("Your saved key is not active")
  expect(container.textContent).toContain("Buy Pro")
  expect(container.textContent).toContain("Need an invoice instead of a card?")
  expect(container.textContent).not.toContain(neutralSavedKeyNote)
})

it.each(["activate", "replace"])("confirms organization coverage after %s", async action => {
  const container = await render(action === "activate" ? community : { ...organizationCovered, keyState: "failed" })
  if (action === "activate") {
    state.setKey.mockResolvedValueOnce(organizationCovered)
    type(container.querySelector<HTMLInputElement>("#license-key")!, "TENU-CONTOSO-TEST")
    await act(async () => { button(container, "Activate")!.click() })
  } else {
    state.replaceKey.mockResolvedValueOnce(organizationCovered)
    await act(async () => { button(container, "Enter a new key")!.click() })
    type(container.querySelector<HTMLInputElement>("#replacement-key")!, "TENU-CONTOSO-TEST")
    await act(async () => { button(container, "Use this key")!.click() })
  }
  expect(container.textContent).toContain(organizationSaveConfirmation)
  expect(container.textContent).not.toContain("It activates for a tenant when you sign in to it.")
})

it("keeps the save confirmation when a signed-in tenant is uncovered", async () => {
  state.setKey.mockResolvedValueOnce({ ...organizationCovered, tenants: organizationCovered.tenants.map(t => ({ ...t, entitled: t.tenantId === "contoso" })) })
  const container = await render(community)
  type(container.querySelector<HTMLInputElement>("#license-key")!, "TENU-CONTOSO-TEST")
  await act(async () => { button(container, "Activate")!.click() })
  expect(container.textContent).toContain("License key saved. It activates for a tenant when you sign in to it.")
})

describe("License page after a used tenant trial", () => {
  const DAY = 86_400_000
  const used = (overrides: Record<string, unknown> = {}) => ({
    tenantId: "11111111-2222-4333-8444-555555555555", signedIn: true, activated: false, entitled: false, source: null, plan: "community" as const,
    tenants: null, expiresAt: null, validUntil: null, trial: false, shared: null, shareNeedsSignIn: false, displayKey: null, message: null,
    trialEndsAt: new Date(Date.now() - DAY).toISOString(), trialAcknowledged: true, trialRefusalPermanent: true,
    trialRefusal: "This tenant already had a Pro trial.", trialCanExtend: false, trialExtensionUnavailable: true, ...overrides,
  })
  const elsewhere = (overrides: Record<string, unknown> = {}) => used({ trialEndsAt: null, trialRefusal: ORGANIZATION_LICENSE_MESSAGE, trialRefusalPermanent: false, ...overrides })
  const occurrences = (container: HTMLElement, text: string) => container.textContent!.split(text).length - 1

  it("explains once that the tenant's license was shared through another app registration, with no trial and no purchase", async () => {
    const container = await render({ ...community, tenantTrialsEnabled: true, tenants: [elsewhere()] })
    expect(occurrences(container, ORGANIZATION_LICENSE_GUIDANCE)).toBe(1)
    expect(container.textContent).toContain("connect the tenant through the app registration its organization license was shared from")
    expect(container.textContent).not.toMatch(/start a free trial/i)
    expect(button(container, "Try Pro free")).toBeUndefined()
    // The tenant has a license: buying another one is not the next step.
    expect(button(container, "Buy Pro")).toBeUndefined()
    expect(button(container, "Retry")).toBeTruthy()
  })

  it("explains it in the row of each tenant it is about, and not for the others", async () => {
    const other = "22222222-2222-4222-8222-222222222222"
    const container = await render({ ...community, tenantTrialsEnabled: true, tenants: [elsewhere(), used({ tenantId: other, trialEndsAt: null, trialRefusal: undefined, trialRefusalPermanent: false, trialAcknowledged: false })] })
    expect(occurrences(container, ORGANIZATION_LICENSE_GUIDANCE)).toBe(1)
    const rows = [...container.querySelectorAll("div")].filter(row => row.textContent!.includes(ORGANIZATION_LICENSE_GUIDANCE) && row.textContent!.includes("11111111-2222-4333-8444-555555555555"))
    // The innermost element holding both is the tenant's own row: it does not hold the other tenant.
    expect(rows.at(-1)!.textContent).not.toContain(other)
    const both = await render({ ...community, tenantTrialsEnabled: true, tenants: [elsewhere(), elsewhere({ tenantId: other })] })
    expect(occurrences(both, ORGANIZATION_LICENSE_GUIDANCE)).toBe(2)
  })

  it("still shows the tenant's own license message next to the guidance", async () => {
    const container = await render({ ...community, tenantTrialsEnabled: true, tenants: [elsewhere({ message: "The licensing service could not be reached." })] })
    expect(occurrences(container, ORGANIZATION_LICENSE_GUIDANCE)).toBe(1)
    expect(container.textContent).toContain("The licensing service could not be reached.")
  })

  it("keeps the emailed trial available: it belongs to the installation, not to the refused tenant", async () => {
    const container = await render({ ...community, tenantTrialsEnabled: false, tenants: [elsewhere(), used({ tenantId: "22222222-2222-4222-8222-222222222222", trialEndsAt: null, trialRefusal: undefined, trialRefusalPermanent: false, trialAcknowledged: false })] })
    expect(occurrences(container, ORGANIZATION_LICENSE_GUIDANCE)).toBe(1)
    expect(container.textContent).toContain("Try Pro free for 30 days, no card needed.")
    expect(button(container, "Retry")).toBeTruthy()
  })

  const buyButtons = (container: HTMLElement) => [...container.querySelectorAll("button")].filter(item => item.textContent?.trim() === "Buy Pro")

  it.each([
    ["ended early by the admin", { trialEndsAt: new Date(Date.now() - 60_000).toISOString() }],
    ["ran out with the extension used", { trialEndsAt: new Date(Date.now() - 3 * DAY).toISOString() }],
    ["ran out past the extension window", { trialEndsAt: new Date(Date.now() - 30 * DAY).toISOString(), trialExtensionUnavailable: false }],
    ["was refused because this installation reached its trial limit", { trialEndsAt: null, trialAcknowledged: undefined, trialRefusal: "This installation has already started its available tenant trials.", trialExtensionUnavailable: false }],
  ])("offers Buy Pro and no further trial when the trial %s", async (_name, overrides) => {
    const container = await render({ ...community, tenantTrialsEnabled: true, communityTenantId: used().tenantId, tenants: [used(overrides)] })
    expect(container.textContent).toContain("Add your license")
    expect(container.textContent).toContain("Paste your license key, or buy Pro for daily backups, full restore and drift revert.")
    expect(container.textContent).not.toMatch(/start a free trial/i)
    expect(button(container, "Try Pro free")).toBeUndefined()
    expect(button(container, "Start free trial")).toBeUndefined()
    expect(buyButtons(container)).toHaveLength(1)
    const mailto = container.querySelector<HTMLAnchorElement>('a[href^="mailto:support@tenuvault.com?subject=TenuVault%20Pro"]')
    expect(mailto).toBeTruthy()
    await act(async () => { buyButtons(container)[0]!.click() })
    expect(state.open).toHaveBeenCalledTimes(1)
    expect(state.open).toHaveBeenCalledWith("checkout", { source: "license-page-trial-used" })
  })

  it("keeps the extension offer and shows one Buy Pro when the trial ran out with the extension available", async () => {
    const container = await render({ ...community, tenantTrialsEnabled: true, tenantTrialPolicy: { days: 14, extensionDays: 14 }, tenants: [used({ trialCanExtend: true, trialExtensionUnavailable: false })] })
    expect(container.textContent).toContain("Pro trial ended")
    expect(container.textContent).not.toMatch(/start a free trial/i)
    expect(button(container, "Extend trial by 14 days")).toBeTruthy()
    expect(buyButtons(container)).toHaveLength(1)
    await act(async () => { buyButtons(container)[0]!.click() })
    expect(state.open).toHaveBeenCalledWith("checkout", { source: "trial-end" })
  })

  it("leaves Buy Pro to the ended notice above the page until it is acknowledged", async () => {
    const container = await render({ ...community, tenantTrialsEnabled: true, tenants: [used({ trialAcknowledged: false, trialCanExtend: true, trialExtensionUnavailable: false })] })
    expect(container.textContent).not.toMatch(/start a free trial/i)
    expect(buyButtons(container)).toHaveLength(0)
  })

  it("shows one Buy Pro when a trial key is refused for the tenant", async () => {
    const refused = "This tenant already had a Pro trial. Buy Pro to continue, or write to support@tenuvault.com for a quote or an invoice."
    const before: LicenseStatus = { ...community, tenantTrialsEnabled: true, tenants: [used()] }
    // The main process keeps the refused key and records the refusal on the tenant before it rejects.
    state.setKey.mockImplementationOnce(async () => {
      state.status = { ...before, hasKey: true, keyState: "pending", keyHint: "****0001", tenants: [used({ message: refused })] }
      throw new Error(refused)
    })
    const container = await render(before)
    expect(buyButtons(container)).toHaveLength(1)
    type(container.querySelector<HTMLInputElement>("#license-key")!, "TENU-TRIAL-KEY-0001")
    await act(async () => button(container, "Activate")!.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("This tenant already had a Pro trial.")
    expect(container.textContent).not.toContain(refused)
    expect(buyButtons(container)).toHaveLength(1)
    expect(container.querySelectorAll('a[href^="mailto:support@tenuvault.com"]')).toHaveLength(1)
    await act(async () => { buyButtons(container)[0]!.click() })
    expect(state.open).toHaveBeenCalledWith("checkout", { source: "license-page-trial-key-refused" })
  })

  it("shows one Buy Pro when a refusal is recorded on the tenant without a saved key", async () => {
    const refused = "This tenant already had a Pro trial. Buy Pro to continue, or write to support@tenuvault.com for a quote or an invoice."
    const container = await render({ ...community, tenantTrialsEnabled: true, tenants: [used({ message: refused })] })
    expect(buyButtons(container)).toHaveLength(1)
  })

  it("offers Buy Pro while a trial that ran out still has its saved activation", async () => {
    // Before the next online check drops it, the main process still reports the expired trial's activation.
    const container = await render({ ...community, tenantTrialsEnabled: true, tenants: [used({ activated: true, trialEndsAt: new Date(Date.now() - 20 * DAY).toISOString() })] })
    expect(container.textContent).not.toMatch(/start a free trial/i)
    expect(buyButtons(container)).toHaveLength(1)
    await act(async () => { buyButtons(container)[0]!.click() })
    expect(state.open).toHaveBeenCalledWith("checkout", { source: "license-page-trial-used" })
  })

  it("still offers the trial to a tenant that can start one", async () => {
    const container = await render({ ...community, tenantTrialsEnabled: true, tenants: [used(), used({ tenantId: "99999999-2222-4333-8444-555555555555", trialEndsAt: null, trialAcknowledged: undefined, trialRefusalPermanent: false, trialRefusal: undefined, trialExtensionUnavailable: false })] })
    expect(container.textContent).toContain("Paste the license key from your email, or start a free trial.")
    expect(button(container, "Try Pro free")).toBeTruthy()
    expect(buyButtons(container)).toHaveLength(0)
  })

  it("is unchanged when tenant trials are switched off", async () => {
    const container = await render({ ...community, tenantTrialsEnabled: false, tenants: [used()] })
    expect(container.textContent).toContain("Paste the license key from your email, or start a free trial.")
    expect(container.textContent).not.toContain("Paste your license key, or buy Pro")
    expect(button(container, "Start free trial")).toBeTruthy()
    expect(buyButtons(container)).toHaveLength(0)
    await act(async () => { button(container, "Buy now")!.click() })
    expect(state.open).toHaveBeenCalledWith("checkout", { source: "license-page" })
  })
})
