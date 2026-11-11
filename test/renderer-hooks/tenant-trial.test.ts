import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LicenseStatus, TenantLicenseStatus } from "../../src/shared/ipc"
import { formatDate, licenseChipState, trialReminder } from "../../src/renderer/lib/license"
const state = vi.hoisted(() => ({ status: null as LicenseStatus | null, action: vi.fn(async () => undefined), start: vi.fn(async () => undefined), emailTrial: vi.fn(async () => undefined), update: vi.fn(), open: vi.fn(async () => undefined), configured: vi.fn(async () => true), usage: vi.fn(async (): Promise<string | null> => null), refresh: vi.fn(async () => undefined) }))
vi.mock("../../src/renderer/lib/license", async original => ({ ...(await original<typeof import("../../src/renderer/lib/license")>()), useLicense: () => ({ status: state.status, refresh: state.refresh }) }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { app: { openExternal: state.open }, auth: { accounts: async () => [{ tenantId: "tenant", username: "admin@contoso.example" }] }, license: { trialWorkflowsConfigured: state.configured, trialUsage: state.usage, tenantTrialAction: state.action, startTenantTrial: state.start, startTrial: state.emailTrial, open: state.open }, schedules: { list: async () => [{ tenantId: "tenant", enabled: true, frequency: "daily" }] }, preferences: { get: async () => ({ retentionDays: 90 }) } } }))
vi.mock("~/contexts/TenantContext", () => ({ useTenantOperations: () => ({ updateTenant: state.update }), useTenants: () => [{ id: 1, name: "Contoso", credentials: { tenantId: "tenant" }, resources: { storageAccountName: "contosobackups" } }, { id: 2, name: "Fabrikam", credentials: { tenantId: "ended" } }] }))
import { TenantTrialCard, TenantTrialNotices, TenantTrialOptions, TrialActions, TrialChanges, TrialResume } from "../../src/renderer/components/TenantTrial"
import { TrialReminderBanner } from "../../src/renderer/components/DesktopLayout"
import { TrialOrKey } from "../../src/renderer/components/PlanChoice"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const day = 86400_000
let tenant: TenantLicenseStatus
beforeEach(() => {
  state.configured.mockReset().mockResolvedValue(true)
  state.usage.mockReset().mockResolvedValue(null)
  state.action.mockReset().mockResolvedValue(undefined)
  state.start.mockReset().mockResolvedValue(undefined)
  state.open.mockReset().mockResolvedValue(undefined)
  state.refresh.mockReset().mockResolvedValue(undefined)
  state.update.mockReset()
  tenant = { tenantId: "tenant", signedIn: true, entitled: true, activated: true, plan: "pro", source: "trial", tenants: 2, expiresAt: null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null, trial: true, trialEndsAt: new Date(Date.now() + 5 * day).toISOString(), canEnd: true, trialCanExtend: true }
  state.status = { hasKey: false, keyState: "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan: "pro", tenantLimit: 2, validUntil: null, communityTenantId: null, tenants: [tenant], tenantTrialsEnabled: true, trial: true, trialEndsAt: tenant.trialEndsAt }
  container = document.createElement("div"); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks() })
async function render(element: ReturnType<typeof createElement>) { await act(async () => root.render(createElement(MemoryRouter, null, element))) }
async function click(text: string) { const button = [...container.querySelectorAll("button")].find(b => b.textContent === text); expect(button).toBeTruthy(); await act(async () => button!.click()) }
describe("tenant trial UI", () => {
  it.each(["Continue on Community", "Buy Pro"])("shows a rejecting %s action and refreshes without losing the error", async label => {
    tenant.entitled = false; tenant.trial = false; tenant.source = null; tenant.trialEndsAt = new Date(Date.now() - day).toISOString()
    const failure = new Error(`${label} failed`)
    if (label === "Buy Pro") state.open.mockRejectedValueOnce(failure)
    else state.action.mockRejectedValueOnce(failure)
    state.refresh.mockRejectedValueOnce(new Error("Status refresh failed"))
    await render(createElement(TenantTrialNotices))
    await click(label)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(failure.message)
    expect(container.textContent).toContain("Pro trial ended")
    expect(state.refresh).toHaveBeenCalledTimes(1)
    expect([...container.querySelectorAll("button")].find(b => b.textContent === label)?.disabled).toBe(false)
  })
  it.each([
    ["Got it", "acknowledge"], ["Extend your trial", "extend_trial"],
  ] as const)("handles a rejected %s action and a rejected refresh", async (label, action) => {
    state.action.mockRejectedValueOnce(new Error("Trial action failed"))
    state.refresh.mockRejectedValueOnce(new Error("Status refresh failed"))
    await render(createElement(TenantTrialCard, { tenant, welcome: action !== "extend_trial" }))
    await click(label)
    expect(state.action).toHaveBeenCalledWith("tenant", action)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Trial action failed")
    expect(state.refresh).toHaveBeenCalledTimes(1)
  })
  describe("ending the trial early", () => {
    const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')
    const inDialog = async (text: string) => {
      const button = [...dialog()!.querySelectorAll("button")].find(b => b.textContent === text)
      expect(button).toBeTruthy()
      await act(async () => button!.click())
    }
    it("asks first and keeps the trial when the admin backs out", async () => {
      await render(createElement(TenantTrialCard, { tenant, welcome: true }))
      expect(dialog()).toBeNull()
      await click("Use Community instead")
      expect(state.action).not.toHaveBeenCalled()
      expect(dialog()?.textContent).toContain("End the Pro trial now?")
      // Ending is not final: the dialog says until when the admin can switch back.
      expect(dialog()?.textContent).toContain(`You can switch back to the Pro trial on the License page until ${formatDate(tenant.trialEndsAt!)}. After that it cannot be started again.`)
      expect(dialog()?.textContent).not.toContain("The trial cannot be started again for this tenant.")
      expect(dialog()?.textContent).toContain("Community keeps 30 days of backup history.")
      // The safe choice comes first, so it takes the focus when the dialog opens.
      expect([...dialog()!.querySelectorAll("button")].map(b => b.textContent).slice(0, 2)).toEqual(["Keep the trial", "End trial and use Community"])
      await inDialog("Keep the trial")
      expect(dialog()).toBeNull()
      expect(state.action).not.toHaveBeenCalled()
      expect(state.refresh).not.toHaveBeenCalled()
      expect(container.textContent).toContain("Pro trial started")
    })
    it("closes on Escape without ending the trial", async () => {
      await render(createElement(TenantTrialCard, { tenant, welcome: true }))
      await click("Use Community instead")
      await act(async () => { dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) })
      expect(dialog()).toBeNull()
      expect(state.action).not.toHaveBeenCalled()
    })
    it("ends the trial once after confirmation", async () => {
      await render(createElement(TenantTrialCard, { tenant, welcome: true }))
      await click("Use Community instead")
      await inDialog("End trial and use Community")
      expect(state.action).toHaveBeenCalledTimes(1)
      expect(state.action).toHaveBeenCalledWith("tenant", "end_trial")
      expect(state.refresh).toHaveBeenCalledTimes(1)
      expect(dialog()).toBeNull()
    })
    it("keeps the trial and shows the error in the dialog when ending fails", async () => {
      state.action.mockRejectedValueOnce(new Error("The licensing service could not be reached."))
      await render(createElement(TenantTrialCard, { tenant, welcome: true }))
      await click("Use Community instead")
      await inDialog("End trial and use Community")
      expect(state.action).toHaveBeenCalledTimes(1)
      const alert = dialog()?.querySelector('[role="alert"]')
      expect(alert?.textContent).toContain("The licensing service could not be reached.")
      expect(alert?.textContent).toContain("The trial is still running.")
      expect(container.textContent).toContain("Pro trial started")
      await inDialog("Keep the trial")
      expect(dialog()).toBeNull()
      expect(state.action).toHaveBeenCalledTimes(1)
      // Opening it again starts without the earlier error.
      await click("Use Community instead")
      expect(dialog()?.querySelector('[role="alert"]')).toBeNull()
    })
    it("keeps the end failure in the dialog when the status refresh fails too", async () => {
      state.action.mockRejectedValueOnce(new Error("Trial action failed"))
      state.refresh.mockRejectedValueOnce(new Error("Status refresh failed"))
      await render(createElement(TenantTrialCard, { tenant, welcome: true }))
      await click("Use Community instead")
      await inDialog("End trial and use Community")
      expect(state.action).toHaveBeenCalledWith("tenant", "end_trial")
      expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("Trial action failed")
      expect(state.refresh).toHaveBeenCalledTimes(1)
    })
    it("shows a failed status refresh in the dialog", async () => {
      state.refresh.mockRejectedValueOnce(new Error("Status refresh failed"))
      await render(createElement(TenantTrialCard, { tenant, welcome: true }))
      await click("Use Community instead")
      await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Got it")!.click())
      expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("Status refresh failed")
    })
    it("ignores a second confirmation that arrives before the first one is handled", async () => {
      let finish!: () => void
      state.action.mockImplementationOnce(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined) }))
      await render(createElement(TenantTrialCard, { tenant, welcome: true }))
      await click("Use Community instead")
      const confirm = [...dialog()!.querySelectorAll("button")].find(b => b.textContent === "End trial and use Community")!
      await act(async () => { confirm.click(); confirm.click() })
      expect(state.action).toHaveBeenCalledTimes(1)
      await act(async () => { finish() })
      expect(state.refresh).toHaveBeenCalledTimes(1)
    })
    it("cannot be closed while the trial is ending", async () => {
      let finish!: () => void
      state.action.mockImplementationOnce(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined) }))
      await render(createElement(TenantTrialCard, { tenant, welcome: true }))
      await click("Use Community instead")
      expect([...dialog()!.querySelectorAll("button")].some(b => b.textContent === "Close")).toBe(true)
      await inDialog("End trial and use Community")
      expect([...dialog()!.querySelectorAll("button")].some(b => b.textContent === "Close")).toBe(false)
      await act(async () => { dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) })
      expect(dialog()?.textContent).toContain("End the Pro trial now?")
      await act(async () => { finish() })
      expect(dialog()).toBeNull()
    })
    it("shows the busy state while the trial is ending", async () => {
      let finish!: () => void
      state.action.mockImplementationOnce(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined) }))
      await render(createElement(TenantTrialCard, { tenant, welcome: true }))
      await click("Use Community instead")
      await inDialog("End trial and use Community")
      const buttons = [...dialog()!.querySelectorAll("button")]
      expect(buttons.find(b => b.textContent === "Ending trial...")?.disabled).toBe(true)
      expect(buttons.find(b => b.textContent === "Keep the trial")?.disabled).toBe(true)
      await act(async () => { finish() })
      expect(dialog()).toBeNull()
    })
  })
  it.each(["save", "remove"])("handles a rejected contact %s and refreshes", async action => {
    state.action.mockRejectedValueOnce(new Error("Contact action failed"))
    state.refresh.mockRejectedValueOnce(new Error("Status refresh failed"))
    await render(createElement(TenantTrialCard, { tenant, allowUnknownContactRemoval: true }))
    await click(action === "save" ? "Email me setup tips and a reminder before the trial ends" : "Remove the saved email address for this trial")
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Contact action failed")
    expect(state.refresh).toHaveBeenCalledTimes(1)
  })
  it("handles a rejected opt-in and refresh", async () => {
    tenant.entitled = false; tenant.activated = false; tenant.source = null; tenant.trial = false; tenant.plan = "community"
    state.start.mockRejectedValueOnce(new Error("Trial start failed"))
    state.refresh.mockRejectedValueOnce(new Error("Status refresh failed"))
    await render(createElement(TenantTrialOptions))
    await click("Try Pro free")
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Trial start failed")
    expect(state.refresh).toHaveBeenCalledTimes(1)
  })
  it("handles a rejected Azure switch after real confirmation", async () => {
    tenant.entitled = false; tenant.trial = false; tenant.source = null; tenant.trialEndsAt = new Date(Date.now() - day).toISOString()
    state.update.mockImplementationOnce(async () => { throw new Error("Storage switch failed") })
    state.refresh.mockRejectedValueOnce(new Error("Status refresh failed"))
    await render(createElement(TenantTrialNotices))
    await click("Switch Contoso to weekly local backups")
    await act(async () => [...document.body.querySelectorAll("button")].find(b => b.textContent === "Switch to local backups")!.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Storage switch failed")
    expect(state.refresh).toHaveBeenCalledTimes(1)
  })
  describe("resuming a trial that was ended early", () => {
    const until = () => new Date(Date.now() + 5 * day).toISOString()
    beforeEach(() => {
      Object.assign(tenant, { entitled: false, activated: false, trial: false, source: null, plan: "community", canEnd: false, trialCanExtend: false, trialRefusal: "This tenant already had a Pro trial.", trialRefusalPermanent: true, trialEndsAt: new Date(Date.now() - day).toISOString(), trialCanResume: true, trialResumeUntil: until() })
      Object.assign(state.status!, { plan: null, trial: false, trialEndsAt: null, communityTenantId: "tenant" })
    })
    it("offers the resume in place of the used trial message, with the date and the days left", async () => {
      await render(createElement(TenantTrialOptions))
      expect(container.textContent).not.toContain("This tenant already had a Pro trial.")
      expect(container.textContent).not.toContain("Try Pro free")
      expect(container.textContent).toContain(`You ended the Pro trial for this tenant early. You can switch back until ${formatDate(tenant.trialResumeUntil!)} (5 days left). No card, no email.`)
      await click("Resume Pro trial")
      expect(state.action).toHaveBeenCalledTimes(1)
      expect(state.action).toHaveBeenCalledWith("tenant", "resume_trial")
      expect(state.refresh).toHaveBeenCalledTimes(1)
    })
    it("counts the last day as one day", async () => {
      tenant.trialResumeUntil = new Date(Date.now() + 3600_000).toISOString()
      await render(createElement(TrialResume, { tenant }))
      expect(container.textContent).toContain("(1 day left)")
    })
    it("shows why a resume failed and keeps the button", async () => {
      state.action.mockRejectedValueOnce(new Error("This trial can no longer be resumed."))
      await render(createElement(TenantTrialOptions))
      await click("Resume Pro trial")
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("This trial can no longer be resumed.")
      expect([...container.querySelectorAll("button")].find(b => b.textContent === "Resume Pro trial")?.disabled).toBe(false)
    })
    it("keeps the reason on screen when a refusal ends the offer", async () => {
      // The service refuses for good: the status that follows no longer offers the resume.
      state.action.mockImplementationOnce(async () => {
        Object.assign(tenant, { trialCanResume: false, trialResumeUntil: undefined })
        state.status = { ...state.status!, tenants: [{ ...tenant }] }
        throw new Error("This trial can no longer be resumed.")
      })
      await render(createElement(TenantTrialOptions))
      await click("Resume Pro trial")
      expect(container.textContent).not.toContain("Resume Pro trial")
      expect(container.textContent).toContain("This tenant already had a Pro trial.")
      expect([...container.querySelectorAll('[role="alert"]')].map(e => e.textContent)).toEqual(["This trial can no longer be resumed."])
    })
    it("goes back to the used trial message once the trial cannot be resumed", async () => {
      Object.assign(tenant, { trialCanResume: false, trialResumeUntil: undefined })
      await render(createElement(TenantTrialOptions))
      expect(container.textContent).toContain("This tenant already had a Pro trial.")
      expect(container.textContent).not.toContain("Resume Pro trial")
    })
    it("renders nothing for a tenant that cannot resume", async () => {
      Object.assign(tenant, { trialCanResume: false })
      await render(createElement(TrialResume, { tenant }))
      expect(container.textContent).toBe("")
    })
  })
  it("says on a running trial that nothing is charged and what happens at its end", async () => {
    await render(createElement(TenantTrialCard, { tenant, welcome: true }))
    expect(container.textContent).toContain("Nothing is charged and no card is on file. When the trial ends, this tenant continues on Community Free by itself. Backups and settings are kept. Community keeps 30 days of backup history.")
  })
  it("says with several tenants that the admin chooses the one that continues", async () => {
    state.status!.tenants = [tenant, { ...tenant, tenantId: "ended" }]
    await render(createElement(TenantTrialCard, { tenant, welcome: true }))
    expect(container.textContent).toContain("Nothing is charged and no card is on file. When the trial ends, you choose which one tenant continues on Community Free. Backups and settings are kept.")
    expect(container.textContent).not.toContain("by itself")
  })
  it("shows a refresh failure without retrying or rejecting the handler", async () => {
    state.refresh.mockRejectedValueOnce(new Error("Status refresh failed"))
    await render(createElement(TenantTrialCard, { tenant, welcome: true }))
    await click("Got it")
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Status refresh failed")
    expect(state.refresh).toHaveBeenCalledTimes(1)
  })
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
    await render(createElement(TenantTrialCard, { tenant, welcome: true }))
    expect(container.querySelector("input")?.value).toBe("admin@contoso.example")
    expect(state.action).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain("Remove the saved email address for this trial")
    await click("Email me setup tips and a reminder before the trial ends")
    expect(state.action).toHaveBeenCalledWith("tenant", "trial_contact", "admin@contoso.example")
    expect(container.textContent).toContain("Email address saved")
    await click("Remove the saved email address for this trial")
    expect(state.action).toHaveBeenLastCalledWith("tenant", "trial_contact", undefined)
    expect(container.textContent).not.toContain("Remove the saved email address for this trial")
  })
  it("allows removing a saved contact", async () => {
    tenant.trialEmail = "admin@contoso.example"
    await render(createElement(TenantTrialCard, { tenant }))
    await click("Remove the saved email address for this trial")
    expect(state.action).toHaveBeenCalledWith("tenant", "trial_contact", undefined)
  })
  it("removes the tenant contact from a joining installation without a locally saved address", async () => {
    tenant.canEnd = false
    await render(createElement(TenantTrialCard, { tenant, allowUnknownContactRemoval: true }))
    await click("Remove the saved email address for this trial")
    expect(state.action).toHaveBeenCalledWith("tenant", "trial_contact", undefined)
    expect(container.textContent).toContain("Email address removed.")
  })
  it("opens the real storage confirmation and switches only after confirmation", async () => {
    tenant.entitled = false; tenant.trial = false; tenant.source = null; tenant.trialEndsAt = new Date(Date.now() - day).toISOString()
    await render(createElement(TenantTrialNotices))
    await click("Switch Contoso to weekly local backups")
    expect(document.body.textContent).toContain("Save new backups on this computer?")
    expect(state.update).not.toHaveBeenCalled()
    await act(async () => [...document.body.querySelectorAll("button")].find(b => b.textContent === "Switch to local backups")!.click())
    expect(state.update).toHaveBeenCalledWith(1, expect.objectContaining({ resources: expect.objectContaining({ storageAccountName: "tvlocal-tenant" }) }))
  })
  it("lets a page own the welcome card without hiding an independent end notice", async () => {
    await render(createElement(TenantTrialNotices, { showWelcome: false }))
    expect(container.textContent).not.toContain("Pro trial started")
    state.status!.tenants.push({ ...tenant, tenantId: "ended", entitled: false, trial: false, source: null, trialEndsAt: new Date(Date.now() - day).toISOString() })
    await render(createElement(TenantTrialNotices, { showWelcome: false }))
    expect(container.textContent).toContain("Pro trial ended")
    expect(container.textContent).not.toContain("Pro trial started")
  })
  it("extends explicitly", async () => {
    await render(createElement(TenantTrialCard, { tenant }))
    await click("Extend your trial")
    expect(state.action).toHaveBeenCalledWith("tenant", "extend_trial")
  })
  it.each([5, 1])("has the %s-day reminder and computed changes", async days => {
    state.status!.trialEndsAt = new Date(Date.now() + days * day).toISOString()
    tenant.trialEndsAt = state.status!.trialEndsAt
    expect(trialReminder(state.status!, undefined)?.daysLeft).toBe(days)
    await render(createElement(TrialChanges))
    for (const text of ["runs weekly", "Azure storage backups pause", "health review", "history returns to 30 days"]) expect(container.textContent).toContain(text)
    expect(licenseChipState(state.status!)).toEqual({ label: "Pro trial", tone: "trial", daysLeft: days })
  })
  it.each([1, 2])("shows the end screen for %s tenants", async count => {
    tenant.entitled = false; tenant.source = null; tenant.trial = false; tenant.trialEndsAt = new Date(Date.now() - day).toISOString()
    state.status!.tenants = Array.from({ length: count }, (_, i) => ({ ...tenant, tenantId: i ? "second" : "tenant" }))
    await render(createElement(TenantTrialNotices))
    expect(container.textContent).toContain("Pro trial ended")
    expect(container.textContent).toContain("Community keeps 30 days of backup history.")
    expect(container.textContent).not.toMatch(/\b30[- ]days? (?:free )?(?:Pro )?trial\b/i)
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
  it.each([
    ["trial", 8, null], ["trial", 5, "day-20"], ["trial", 1, "day-27"], ["key", 8, "day-20"],
  ] as const)("distinguishes the %s reminder at %s days (%s)", (source, days, stage) => {
    const now = Date.now()
    const end = new Date(now + days * day).toISOString()
    state.status!.trialEndsAt = end
    state.status!.tenants = [{ ...tenant, source, trialEndsAt: end, validUntil: end }]
    const reminder = trialReminder(state.status!, undefined, now)
    if (stage === null) expect(reminder).toBeNull()
    else expect(reminder).toMatchObject({ stage, daysLeft: days, endsAt: end, ...(source === "trial" ? { tenantTrial: true } : {}) })
  })
  it("hides removal on a joined start card without a known saved contact", async () => {
    tenant.canEnd = false
    await render(createElement(TenantTrialCard, { tenant, welcome: true }))
    expect(container.textContent).not.toContain("Remove the saved email address for this trial")
    expect(state.action).not.toHaveBeenCalled()
  })
  it("hides unknown contact removal on a welcome even on the License page", async () => {
    await render(createElement(TenantTrialCard, { tenant, welcome: true, allowUnknownContactRemoval: true }))
    expect(container.textContent).not.toContain("Remove the saved email address for this trial")
  })
  it("shows a known saved contact on the start card", async () => {
    tenant.trialEmail = "admin@contoso.example"
    await render(createElement(TenantTrialCard, { tenant, welcome: true }))
    await click("Remove the saved email address for this trial")
    expect(state.action).toHaveBeenCalledWith("tenant", "trial_contact", undefined)
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
    await click("Extend your trial")
    expect(container.textContent).toContain("Trial extended. Ends on")
    expect(container.textContent).toContain(new Date(nextEnd).toLocaleDateString(undefined, { dateStyle: "medium" }))
  })

  it("keeps the trial badge tied to its tenant beside paid coverage", () => {
    tenant.trialEndsAt = new Date(Date.now() + 4 * day).toISOString()
    state.status = { ...state.status!, hasKey: true, trial: false, trialEndsAt: null, tenants: [tenant, { ...tenant, tenantId: "paid", source: "key", trial: false, trialEndsAt: null }] }
    expect(licenseChipState(state.status)).toEqual({ label: "Pro trial", tone: "trial", daysLeft: 4 })
  })

})

describe("shared trial actions", () => {
  it.each([undefined, 12])("orders purchase, extension and contact with length %s", async length => {
    state.status!.tenantTrialPolicy = { extensionDays: length }
    await render(createElement(TrialActions, { tenant, source: "trial-test" }))
    const text = container.textContent!
    const label = length ? `Extend trial by ${length} days` : "Extend your trial"
    expect(text.indexOf("Buy Pro")).toBeLessThan(text.indexOf(label))
    expect(text.indexOf(label)).toBeLessThan(text.indexOf("Questions,"))
    const link = container.querySelector<HTMLAnchorElement>('a[href^="mailto:"]')!
    expect(link.getAttribute("href")).toBe("mailto:support@tenuvault.com?subject=TenuVault%20Pro%3A%20quote%20or%20invoice")
    expect(link.href).not.toContain("body=")
    expect(link.href).not.toContain("contoso")
    await act(async () => link.click())
    expect(state.open).toHaveBeenCalledWith(link.getAttribute("href"))
  })
  it("shows availability before the window, and hides it once used or refused", async () => {
    tenant.trialCanExtend = false
    tenant.trialExtensionAvailableAt = new Date(Date.now() + day).toISOString()
    await render(createElement(TrialActions, { tenant, source: "trial-test" }))
    expect(container.textContent).toContain("You can extend once, from")
    expect(container.textContent).not.toContain("Extend your trial")
    delete tenant.trialExtensionAvailableAt
    tenant.trialExtensionUnavailable = true
    await render(createElement(TrialActions, { tenant, source: "trial-test" }))
    expect(container.textContent).not.toContain("extend")
    expect(container.textContent).toContain("Buy Pro")
    expect(container.textContent).toContain("Questions,")
  })
  it("keeps the start card focused on Got it with contact and availability", async () => {
    tenant.trialCanExtend = false
    tenant.trialExtensionAvailableAt = new Date(Date.now() + day).toISOString()
    await render(createElement(TenantTrialCard, { tenant, welcome: true }))
    expect(container.textContent).toContain("Got it")
    expect(container.textContent).toContain("Questions,")
    expect(container.textContent).toContain("You can extend once, from")
    expect(container.textContent).not.toContain("Buy Pro")
  })
})

it.each([5, 1])("offers ordered actions in the %s day banner", async days => {
  tenant.trialEndsAt = new Date(Date.now() + days * day).toISOString()
  const reminder = trialReminder(state.status!, undefined)!
  await render(createElement(TrialReminderBanner, { reminder, onDismiss: vi.fn(), dismissing: false }))
  const text = container.textContent!
  expect(text.indexOf("Buy Pro")).toBeLessThan(text.indexOf("Extend your trial"))
  expect(text.indexOf("Extend your trial")).toBeLessThan(text.indexOf("Questions,"))
  expect(text).toContain("Details")
  expect(text).toContain("Dismiss")
})

it.each(["reminder", "ended", "license", "welcome", "empty", "unreadable"])("shows local usage only on the %s notice when available", async place => {
  state.usage.mockResolvedValue("During your trial: 2 CIS Benchmarks assessments.")
  if (place === "empty") state.usage.mockResolvedValue(null)
  if (place === "unreadable") state.usage.mockRejectedValue(new Error("Unreadable"))
  if (place === "ended") { tenant.trial = false; tenant.entitled = false; tenant.source = null; tenant.trialEndsAt = new Date(Date.now() - day).toISOString() }
  if (place === "reminder") await render(createElement(TrialReminderBanner, { reminder: trialReminder(state.status!, undefined)!, onDismiss: vi.fn(), dismissing: false }))
  else if (place === "ended") await render(createElement(TenantTrialNotices))
  else await render(createElement(TenantTrialCard, { tenant, welcome: place === "welcome" }))
  expect(container.textContent!.includes("During your trial:")).toBe(!["welcome", "empty", "unreadable"].includes(place))
  if (place === "welcome") expect(state.usage).not.toHaveBeenCalled()
})

it.each(["license", "welcome", "ended", "reminder"])("keeps the existing %s interface while tenant trials are off", async place => {
  state.status!.tenantTrialsEnabled = false
  if (place === "ended") { tenant.trial = false; tenant.entitled = false; tenant.source = null; tenant.trialEndsAt = new Date(Date.now() - day).toISOString() }
  if (place === "reminder") await render(createElement(TrialReminderBanner, { reminder: trialReminder(state.status!, undefined)!, onDismiss: vi.fn(), dismissing: false }))
  else if (place === "ended") await render(createElement(TenantTrialNotices))
  else await render(createElement(TenantTrialCard, { tenant, welcome: place === "welcome" }))
  expect(container.textContent).not.toContain("Questions, or need a quote")
  expect(state.usage).not.toHaveBeenCalled()
  if (place !== "reminder") expect(container.textContent).toContain("Need more time? Extend your trial")
})


it("keeps the next tenant's reminder extension available after extending the first", async () => {
  const props = () => ({ reminder: trialReminder(state.status!, undefined)!, onDismiss: vi.fn(), dismissing: false })
  await render(createElement(TrialReminderBanner, props()))
  await click("Extend your trial")
  expect(container.textContent).toContain("Trial extended.")
  tenant = { ...tenant, tenantId: "second" }
  state.status!.tenants = [tenant]
  await render(createElement(TrialReminderBanner, props()))
  expect(container.textContent).toContain("Extend your trial")
  expect(container.textContent).not.toContain("Trial extended.")
  await click("Extend your trial")
  expect(state.action).toHaveBeenLastCalledWith("second", "extend_trial")
})

it.each([true, false])("shows configured workflow changes with trials enabled %s", async enabled => {
  state.status!.tenantTrialsEnabled = enabled
  await render(createElement(TrialChanges, { tenantId: tenant.tenantId }))
  expect(container.textContent).toContain("Alerts, health review and change reports pause.")
  state.configured.mockResolvedValue(false)
  state.status = { ...state.status! }
  await render(createElement(TrialChanges, { tenantId: tenant.tenantId }))
  expect(state.configured).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain("Alerts, health review and change reports pause.")
  state.status.tenants = [{ ...tenant, tenantId: "second" }]
  await render(createElement(TrialChanges, { tenantId: "second" }))
  expect(state.configured).toHaveBeenCalledTimes(2)
  expect(state.configured).toHaveBeenLastCalledWith("second")
  expect(container.textContent).not.toContain("Alerts, health review and change reports pause.")
})
it("hides unreadable workflow configuration", async () => {
  state.configured.mockRejectedValue(new Error("Store unavailable"))
  await render(createElement(TrialChanges, { tenantId: tenant.tenantId }))
  expect(container.textContent).not.toContain("Alerts, health review and change reports pause.")
})
it("only shows extension progress for the extension action", async () => {
  let finish!: () => void
  state.open.mockImplementationOnce(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined) }))
  await render(createElement(TrialActions, { tenant, source: "trial-test" }))
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Buy Pro")!.click())
  expect(container.textContent).not.toContain("Extending trial...")
  expect(container.textContent).toContain("Extend your trial")
  await act(async () => finish())
})
it("lets the banner extend after a network failure", async () => {
  state.action.mockRejectedValueOnce(new Error("Network unavailable"))
  await render(createElement(TrialReminderBanner, { reminder: trialReminder(state.status!, undefined)!, onDismiss: vi.fn(), dismissing: false }))
  await click("Extend your trial")
  expect(container.textContent).toContain("Network unavailable")
  await click("Extend your trial")
  expect(state.action).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain("Trial extended.")
})
it("uses today for a one-day reminder that ends on the local calendar date", async () => {
  const now = new Date(2026, 10, 10, 9)
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now)
  try {
    tenant.trialEndsAt = new Date(2026, 10, 10, 17).toISOString()
    await render(createElement(TrialReminderBanner, { reminder: trialReminder(state.status!, undefined)!, onDismiss: vi.fn(), dismissing: false }))
    expect(container.textContent).toContain("Your Pro trial ends today")
  } finally { vi.useRealTimers() }
})
