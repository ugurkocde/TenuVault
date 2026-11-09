import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LicenseStatus, TenantLicenseStatus } from "../../src/shared/ipc"
import { licenseChipState, trialReminder } from "../../src/renderer/lib/license"
const state = vi.hoisted(() => ({ status: null as LicenseStatus | null, action: vi.fn(async () => undefined), start: vi.fn(async () => undefined), emailTrial: vi.fn(async () => undefined) }))
vi.mock("../../src/renderer/lib/license", async original => ({ ...(await original<typeof import("../../src/renderer/lib/license")>()), useLicense: () => ({ status: state.status, refresh: async () => {} }) }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { auth: { accounts: async () => [{ tenantId: "tenant", username: "admin@contoso.example" }] }, license: { tenantTrialAction: state.action, startTenantTrial: state.start, startTrial: state.emailTrial }, schedules: { list: async () => [{ tenantId: "tenant", enabled: true, frequency: "daily" }] }, preferences: { get: async () => ({ retentionDays: 90 }) } } }))
vi.mock("~/contexts/TenantContext", () => ({ useTenantOperations: () => ({ updateTenant: vi.fn() }), useTenants: () => [{ credentials: { tenantId: "tenant" }, resources: { storageAccountName: "contosobackups" } }] }))
vi.mock("~/components/ConfirmDialog", () => ({ useConfirm: () => ({ confirm: async () => false }) }))
import { TenantTrialCard, TenantTrialNotices, TenantTrialOptions, TrialChanges } from "../../src/renderer/components/TenantTrial"
import { TrialOrKey } from "../../src/renderer/components/PlanChoice"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const day = 86400_000
let tenant: TenantLicenseStatus
beforeEach(() => {
  tenant = { tenantId: "tenant", signedIn: true, entitled: true, activated: true, plan: "pro", source: "trial", tenants: 2, expiresAt: null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null, trial: true, trialEndsAt: new Date(Date.now() + 5 * day).toISOString(), canEnd: true, trialCanExtend: true }
  state.status = { hasKey: false, keyState: "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan: "pro", tenantLimit: 2, validUntil: null, communityTenantId: null, tenants: [tenant], tenantTrialsEnabled: true, trial: true, trialEndsAt: tenant.trialEndsAt }
  container = document.createElement("div"); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks() })
async function render(element: ReturnType<typeof createElement>) { await act(async () => root.render(createElement(MemoryRouter, null, element))) }
async function click(text: string) { const button = [...container.querySelectorAll("button")].find(b => b.textContent === text); expect(button).toBeTruthy(); await act(async () => button!.click()) }
describe("tenant trial UI", () => {
  it.each([true, false])("shows the start card, correct days and starter controls (%s)", async starter => {
    tenant.canEnd = starter
    await render(createElement(TenantTrialCard, { tenant, welcome: true }))
    expect(container.textContent).toContain("Pro trial started")
    expect(container.textContent).toContain("5 days left")
    expect(container.textContent?.includes("Use Community instead")).toBe(starter)
    expect(container.textContent).toContain("30 days of backup history")
    await click("Got it")
    expect(state.action).toHaveBeenCalledWith("tenant", "acknowledge")
  })
  it("prefills contact without sending and submits only on click", async () => {
    await render(createElement(TenantTrialCard, { tenant }))
    expect(container.querySelector("input")?.value).toBe("admin@contoso.example")
    expect(state.action).not.toHaveBeenCalled()
    await click("Email me setup tips and a reminder before the trial ends")
    expect(state.action).toHaveBeenCalledWith("tenant", "trial_contact", "admin@contoso.example")
    expect(container.textContent).toContain("Email address saved")
  })
  it("allows removing a saved contact", async () => {
    tenant.trialEmail = "admin@contoso.example"
    await render(createElement(TenantTrialCard, { tenant }))
    await click("Remove email address")
    expect(state.action).toHaveBeenCalledWith("tenant", "trial_contact", undefined)
  })
  it("extends explicitly", async () => {
    await render(createElement(TenantTrialCard, { tenant }))
    await click("Need more time? Extend 14 days")
    expect(state.action).toHaveBeenCalledWith("tenant", "extend_trial")
  })
  it.each([5, 1])("has the %s-day reminder and computed changes", async days => {
    state.status!.trialEndsAt = new Date(Date.now() + days * day).toISOString()
    expect(trialReminder(state.status!, undefined)?.daysLeft).toBe(days)
    await render(createElement(TrialChanges))
    for (const text of ["runs weekly", "Azure storage backups pause", "health review", "history returns to 30 days"]) expect(container.textContent).toContain(text)
    expect(licenseChipState(state.status!).label).toBe(`Pro trial · ${days} days`)
  })
  it.each([1, 2])("shows the end screen for %s tenants", async count => {
    tenant.entitled = false; tenant.source = null; tenant.trial = false; tenant.trialEndsAt = new Date(Date.now() - day).toISOString()
    state.status!.tenants = Array.from({ length: count }, (_, i) => ({ ...tenant, tenantId: i ? "second" : "tenant" }))
    await render(createElement(TenantTrialNotices))
    expect(container.textContent).toContain("Pro trial ended")
    expect(container.textContent).toContain(count === 2 ? "You choose which" : "This tenant continues")
    await click("Continue on Community")
    expect(state.action).toHaveBeenCalledWith("tenant", "acknowledge")
  })
  it("offers opt-in and shows a refusal", async () => {
    tenant.entitled = false
    await render(createElement(TenantTrialOptions))
    await click("Try Pro free")
    expect(state.start).toHaveBeenCalledWith("tenant")
    tenant.trialRefusal = "This tenant already had a Pro trial."
    await render(createElement(TenantTrialOptions))
    expect(container.textContent).toContain(tenant.trialRefusal)
    expect(container.querySelector("button")).toBeNull()
  })
  it.each([true, false])("keeps the email form only when trials are off (%s)", async enabled => {
    state.status!.tenantTrialsEnabled = enabled
    await render(createElement(TrialOrKey, { source: "test" }))
    expect(container.textContent?.includes("Try Pro free for 30 days")).toBe(!enabled)
    expect(container.textContent).toContain("I have a license key")
    if (!enabled) { await click("Try Pro free for 30 days, no card"); expect(container.querySelector('input[type="email"]')).toBeTruthy() }
  })
})
