import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppPreferences, LicenseStatus, TenantLicenseStatus } from "../../src/shared/ipc"

const state = vi.hoisted(() => ({
  status: null as LicenseStatus | null,
  saved: {} as Partial<AppPreferences>,
  refresh: vi.fn(async () => undefined),
  start: vi.fn(async (): Promise<unknown> => undefined),
  read: vi.fn(async (): Promise<unknown> => null),
  set: vi.fn(),
  toast: vi.fn(),
}))
vi.mock("../../src/renderer/lib/license", async original => ({ ...(await original<typeof import("../../src/renderer/lib/license")>()), useLicense: () => ({ status: state.status, refresh: state.refresh }) }))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: state.toast }))
vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    preferences: {
      get: async () => ({ ...state.saved }),
      set: async (changes: Partial<AppPreferences>) => { state.set(changes); state.saved = { ...state.saved, ...changes }; return { ...state.saved } },
    },
    license: { startTenantTrial: state.start, status: state.read },
  },
}))
import { TrialOfferCard } from "../../src/renderer/components/TrialOfferCard"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const id = "11111111-2222-4333-8444-555555555555"
let root: Root
let container: HTMLDivElement
let tenant: TenantLicenseStatus

beforeEach(() => {
  tenant = { tenantId: id, signedIn: true, activated: false, entitled: false, source: null, plan: "community", tenants: null, expiresAt: null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null, trialEndsAt: null }
  state.status = { hasKey: false, keyState: "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan: null, tenantLimit: null, validUntil: null, communityTenantId: id, tenants: [tenant], tenantTrialsEnabled: true, tenantTrialPolicy: { days: 14 } }
  state.saved = {}
  state.refresh.mockReset().mockResolvedValue(undefined)
  state.start.mockReset().mockResolvedValue(undefined)
  state.read.mockReset().mockResolvedValue(null)
  state.set.mockReset()
  state.toast.mockReset()
  container = document.createElement("div"); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

async function render(tenantId = id) { await act(async () => root.render(createElement(TrialOfferCard, { tenantId }))) }
async function remount() { act(() => root.unmount()); root = createRoot(container); await render() }
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === text)
  expect(button).toBeTruthy()
  await act(async () => button!.click())
}
const title = "Try Pro free for up to 14 days on this tenant"

describe("dashboard trial card", () => {
  it("offers the trial to an eligible Community tenant with neutral copy", async () => {
    await render()
    expect(container.textContent).toContain(title)
    expect(container.textContent).toContain("Pro adds daily backups, full restore, replace in place, drift revert, Azure storage, the audit log and white-label PDF reports.")
    expect(container.textContent).toContain("Nothing in Community changes. When the trial ends, this tenant continues on Community Free unless another tenant uses Community by then, in which case it needs a license; backups and settings are kept.")
    expect([...container.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Start free trial", "Not now"])
  })

  it.each<[string, () => void]>([
    ["Pro", () => Object.assign(tenant, { plan: "pro", entitled: true, activated: true, source: "key" })],
    ["MSP", () => Object.assign(tenant, { plan: "msp", entitled: true, activated: true, source: "key" })],
    ["a running trial", () => Object.assign(tenant, { plan: "pro", entitled: true, activated: true, source: "trial", trial: true, trialEndsAt: "2026-11-27T00:00:00.000Z" })],
    ["a licensed machine", () => { state.status!.hasKey = true }],
    ["a refused tenant", () => { tenant.trialRefusal = "This tenant already had a Pro trial." }],
    ["a dismissed tenant", () => { state.saved = { trialOfferHiddenTenantIds: [id] } }],
  ])("is not shown for %s", async (_case, setup) => {
    setup()
    await render()
    expect(container.textContent).toBe("")
  })

  it("hides on Not now and stays hidden after a restart", async () => {
    await render()
    await click("Not now")
    expect(container.textContent).toBe("")
    expect(state.set).toHaveBeenCalledWith({ trialOfferHiddenTenantIds: [id] })
    expect(state.start).not.toHaveBeenCalled()
    await remount()
    expect(container.textContent).toBe("")
  })

  it("keeps other dismissed tenants when it saves", async () => {
    const other = "66666666-7777-4888-9999-000000000000"
    state.saved = { trialOfferHiddenTenantIds: [other] }
    await render()
    await click("Not now")
    expect(state.saved.trialOfferHiddenTenantIds).toEqual([other, id])
  })

  it("starts the opt-in trial and goes away once the trial runs", async () => {
    state.refresh.mockImplementation(async () => {
      Object.assign(tenant, { plan: "pro", entitled: true, activated: true, source: "trial", trial: true, trialEndsAt: "2026-11-27T00:00:00.000Z" })
      state.status = { ...state.status!, tenants: [{ ...tenant }] }
    })
    await render()
    await click("Start free trial")
    expect(state.start).toHaveBeenCalledWith(id)
    expect(state.refresh).toHaveBeenCalledTimes(1)
    await render()
    expect(container.textContent).not.toContain(title)
    // Success needs no dismissal: the running trial ends the offer.
    expect(state.set).not.toHaveBeenCalled()
  })

  it("shows a refusal once and hides the card for good", async () => {
    const refusal = "This installation has already started its available tenant trials."
    state.start.mockRejectedValueOnce(new Error(refusal))
    state.read.mockResolvedValueOnce({ ...state.status, tenantTrialInstallLimit: true, tenants: [{ ...tenant, trialRefusal: refusal }] })
    state.refresh.mockImplementation(async () => { state.status = { ...state.status!, tenantTrialInstallLimit: true, tenants: [{ ...tenant, trialRefusal: refusal }] } })
    await render()
    await click("Start free trial")
    await render()
    expect(container.querySelector('[role="status"]')?.textContent).toContain(refusal)
    expect(container.textContent).not.toContain(title)
    expect(state.set).toHaveBeenCalledWith({ trialOfferHiddenTenantIds: [id] })
    await click("Close")
    expect(container.textContent).toBe("")
    // A later refusal reset (another app version, six hours) does not bring the card back.
    state.status = { ...state.status!, tenantTrialInstallLimit: false, tenants: [{ ...tenant, trialRefusal: undefined }] }
    await remount()
    expect(container.textContent).toBe("")
  })

  it("keeps the card with the error after a failure the service did not record", async () => {
    state.start.mockRejectedValueOnce(new Error("The licensing service could not be reached."))
    state.read.mockResolvedValueOnce(state.status)
    await render()
    await click("Start free trial")
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("The licensing service could not be reached.")
    expect(container.textContent).toContain(title)
    expect(state.set).not.toHaveBeenCalled()
    expect([...container.querySelectorAll("button")].find(b => b.textContent === "Start free trial")?.disabled).toBe(false)
  })

  describe("with a tenant switch while a start runs", () => {
    const second = "66666666-7777-4888-9999-000000000000"
    let finish: (error?: Error) => void = () => {}
    beforeEach(() => {
      state.status!.tenants.push({ ...tenant, tenantId: second })
      state.start.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = error => error ? reject(error) : resolve() }))
    })

    it("drops a late error for the tenant that is no longer shown", async () => {
      state.read.mockResolvedValueOnce(state.status)
      await render()
      await click("Start free trial")
      await render(second)
      // The other tenant's card shows no progress of its own and cannot start a second request.
      const button = [...container.querySelectorAll("button")].find(b => b.textContent === "Start free trial")
      expect(button?.disabled).toBe(true)
      await act(async () => finish(new Error("The licensing service could not be reached.")))
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(container.textContent).toContain(title)
      await render()
      expect(container.querySelector('[role="alert"]')).toBeNull()
    })

    it("hides a refused tenant without showing its refusal on another tenant", async () => {
      const refusal = "This tenant already had a Pro trial."
      state.read.mockResolvedValueOnce({ ...state.status, tenants: [{ ...tenant, trialRefusal: refusal }, { ...tenant, tenantId: second }] })
      await render()
      await click("Start free trial")
      await render(second)
      await act(async () => finish(new Error(refusal)))
      expect(container.textContent).not.toContain(refusal)
      expect(container.textContent).toContain(title)
      expect(state.saved.trialOfferHiddenTenantIds).toEqual([id])
      await render()
      expect(container.textContent).toBe("")
    })

    it("clears a refusal notice when another tenant is selected", async () => {
      const refusal = "This tenant already had a Pro trial."
      state.read.mockResolvedValueOnce({ ...state.status, tenants: [{ ...tenant, trialRefusal: refusal }] })
      await render()
      await click("Start free trial")
      await act(async () => finish(new Error(refusal)))
      expect(container.textContent).toContain(refusal)
      await render(second)
      expect(container.textContent).not.toContain(refusal)
      await render()
      expect(container.textContent).toBe("")
    })
  })

  it("starts once for two quick clicks", async () => {
    let finish: () => void = () => {}
    state.start.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    await render()
    const button = [...container.querySelectorAll("button")].find(b => b.textContent === "Start free trial")!
    await act(async () => { button.click(); button.click() })
    expect(container.textContent).toContain("Starting trial...")
    await act(async () => finish())
    expect(state.start).toHaveBeenCalledTimes(1)
  })
})
