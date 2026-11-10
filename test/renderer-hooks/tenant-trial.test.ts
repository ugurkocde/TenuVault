import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LicenseStatus, TenantLicenseStatus } from "../../src/shared/ipc"
import { licenseChipState, trialReminder } from "../../src/renderer/lib/license"
const state = vi.hoisted(() => ({ status: null as LicenseStatus | null, action: vi.fn(async () => undefined), start: vi.fn(async () => undefined), emailTrial: vi.fn(async () => undefined) }))
vi.mock("../../src/renderer/lib/license", async original => ({ ...(await original<typeof import("../../src/renderer/lib/license")>()), useLicense: () => ({ status: state.status, refresh: async () => {} }) }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { auth: { accounts: async () => [{ tenantId: "tenant", username: "admin@contoso.example" }] }, license: { tenantTrialAction: state.action, startTenantTrial: state.start, startTrial: state.emailTrial }, schedules: { list: async () => [{ tenantId: "tenant", enabled: true, frequency: "daily" }] }, preferences: { get: async () => ({ retentionDays: 90 }) } } }))
vi.mock("~/contexts/TenantContext", () => ({ useTenantOperations: () => ({ updateTenant: vi.fn() }), useTenants: () => [{ id: 1, name: "Contoso", credentials: { tenantId: "tenant" }, resources: { storageAccountName: "contosobackups" } }, { id: 2, name: "Fabrikam", credentials: { tenantId: "ended" } }] }))
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
    expect([...container.querySelectorAll("a")].map(a => a.textContent)).toEqual(expect.arrayContaining(["Daily backup schedule", "Full restore", "Drift revert", "CIS Benchmarks"]))
    expect(container.querySelector('a[href="/portal/backup?tab=restore"]')).toBeTruthy()
    expect([...container.querySelectorAll("button")].find(b => b.textContent === "Email me setup tips and a reminder before the trial ends")?.className).toContain("border")
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
    await click("Need more time? Extend your trial")
    expect(state.action).toHaveBeenCalledWith("tenant", "extend_trial")
  })
  it.each([5, 1])("has the %s-day reminder and computed changes", async days => {
    state.status!.trialEndsAt = new Date(Date.now() + days * day).toISOString()
    tenant.trialEndsAt = state.status!.trialEndsAt
    expect(trialReminder(state.status!, undefined)?.daysLeft).toBe(days)
    await render(createElement(TrialChanges))
    for (const text of ["runs weekly", "Azure storage backups pause", "health review", "history returns to 30 days"]) expect(container.textContent).toContain(text)
    expect(licenseChipState(state.status!).label).toBe(`Pro trial · ${days} ${days === 1 ? "day" : "days"}`)
  })
  it.each([1, 2])("shows the end screen for %s tenants", async count => {
    tenant.entitled = false; tenant.source = null; tenant.trial = false; tenant.trialEndsAt = new Date(Date.now() - day).toISOString()
    state.status!.tenants = Array.from({ length: count }, (_, i) => ({ ...tenant, tenantId: i ? "second" : "tenant" }))
    await render(createElement(TenantTrialNotices))
    expect(container.textContent).toContain("Pro trial ended")
    expect(container.querySelectorAll("section")).toHaveLength(1)
    expect([...container.querySelectorAll("button")][0]?.textContent).toBe("Buy Pro")
    expect(container.textContent).toContain(count === 2 ? "You choose which" : "This tenant continues")
    await click("Continue on Community")
    expect(state.action).toHaveBeenCalledWith("tenant", "acknowledge")
  })
  it("offers opt-in and shows a refusal", async () => {
    tenant.entitled = false
    tenant.activated = false
    await render(createElement(TenantTrialOptions))
    expect(container.textContent).toContain("No card, no email. Starts right away, for this tenant.")
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
  it("acknowledges an ended tenant independently of another tenant's welcome", async () => {
    const ended = { ...tenant, tenantId: "ended", entitled: false, activated: false, source: null, trial: false, trialEndsAt: new Date(Date.now() - day).toISOString() }
    state.status!.tenants = [tenant, ended]
    await render(createElement(TenantTrialNotices))
    expect(container.textContent).toContain("Pro trial startedContoso")
    expect(container.textContent).toContain("Pro trial endedFabrikam")
    await click("Continue on Community")
    expect(state.action).toHaveBeenLastCalledWith("ended", "acknowledge")
    await click("Got it")
    expect(state.action).toHaveBeenLastCalledWith("tenant", "acknowledge")
  })
  it("does not offer a no-op trial when an expired activation is still saved", async () => {
    tenant.entitled = false
    await render(createElement(TenantTrialOptions))
    expect(container.textContent).toContain("Check the saved activation")
    expect([...container.querySelectorAll("button")].some(b => b.textContent === "Try Pro free")).toBe(false)
  })
  it("keeps a temporary refusal visible with a retry", async () => {
    tenant.entitled = false; tenant.activated = false
    tenant.trialRefusal = "Update TenuVault to start a tenant trial."; tenant.trialRefusalPermanent = false
    await render(createElement(TenantTrialOptions))
    expect(container.textContent).toContain(tenant.trialRefusal)
    await click("Try Pro free")
    expect(state.start).toHaveBeenCalledWith("tenant")
  })
  it.each(["email", "tenant"])("uses the %s trial's own reminder days and end", kind => {
    const emailEnd = new Date(Date.now() + (kind === "email" ? 8 : 20) * day).toISOString()
    const tenantEnd = new Date(Date.now() + (kind === "email" ? 12 : 4) * day).toISOString()
    state.status!.trialEndsAt = emailEnd
    state.status!.tenants = [{ ...tenant, source: "key", trialEndsAt: emailEnd, validUntil: emailEnd }, { ...tenant, tenantId: "other", trialEndsAt: tenantEnd, validUntil: tenantEnd }]
    const reminder = trialReminder(state.status!, undefined)
    expect(reminder?.endsAt).toBe(kind === "email" ? emailEnd : tenantEnd)
    expect(reminder?.daysLeft).toBe(kind === "email" ? 8 : 4)
    expect(Boolean(reminder?.tenantTrial)).toBe(kind === "tenant")
  })
  it("shows the server's new end date after extending", async () => {
    const nextEnd = new Date(Date.now() + 23 * day).toISOString()
    state.action.mockResolvedValueOnce({ ...state.status, tenants: [{ ...tenant, trialEndsAt: nextEnd }] } as never)
    await render(createElement(TenantTrialCard, { tenant }))
    await click("Need more time? Extend your trial")
    expect(container.textContent).toContain("Trial extended. Ends on")
    expect(container.textContent).toContain(new Date(nextEnd).toLocaleDateString(undefined, { dateStyle: "medium" }))
  })

  it("keeps the trial badge tied to its tenant beside paid coverage", () => {
    tenant.trialEndsAt = new Date(Date.now() + 4 * day).toISOString()
    state.status = { ...state.status!, hasKey: true, trial: false, trialEndsAt: null, tenants: [tenant, { ...tenant, tenantId: "paid", source: "key", trial: false, trialEndsAt: null }] }
    expect(licenseChipState(state.status).label).toBe("Pro trial · 4 days")
  })

})
