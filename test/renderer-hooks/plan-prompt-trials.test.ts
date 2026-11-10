import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LicenseStatus, TenantLicenseStatus } from "../../src/shared/ipc"
import { FEATURE_PLAN } from "../../src/shared/plans"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const state = vi.hoisted(() => ({ status: null as LicenseStatus | null, selected: "tenant", start: vi.fn(async () => undefined), open: vi.fn(async () => undefined) }))
vi.mock("../../src/renderer/lib/license", async original => ({ ...(await original<typeof import("../../src/renderer/lib/license")>()), useLicense: () => ({ status: state.status, refresh: async () => {} }) }))
vi.mock("~/contexts/TenantContext", () => ({ useSelectedTenant: () => ({ selectedTenant: { credentials: { tenantId: state.selected } } }) }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { license: { open: state.open, startTenantTrial: state.start } } }))
import { PlanPromptButton } from "../../src/renderer/components/PlanPromptButton"
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.clearAllMocks(); state.selected = "tenant" })
const sources = Object.entries(FEATURE_PLAN).flatMap(([feature, plan]) => ["note", "locked", "plan-dialog"].map(prefix => ({ source: `${prefix}-${feature.toLowerCase()}`, plan }))).concat([{ source: "not-covered", plan: "pro" }])
function status(mode: string): LicenseStatus {
  const tenant = { tenantId: "tenant", signedIn: true, activated: false, entitled: false, source: null, plan: "community", tenants: null, expiresAt: null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null } as TenantLicenseStatus
  if (mode === "running") Object.assign(tenant, { source: "trial", trial: true, plan: "pro", entitled: true, activated: true })
  if (mode === "ended") Object.assign(tenant, { trialRefusal: "This tenant already had a Pro trial.", trialRefusalPermanent: true, trialEndsAt: new Date(Date.now() - 86400_000).toISOString() })
  if (mode === "key" || mode === "organization") Object.assign(tenant, { source: mode === "key" ? "key" : "tenant", plan: "pro", entitled: true, activated: true })
  return { hasKey: mode === "key", keyState: mode === "key" ? "active" : "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan: tenant.entitled ? "pro" : null, tenantLimit: null, validUntil: null, communityTenantId: tenant.entitled ? null : "tenant", tenantTrialsEnabled: true, trial: mode === "running", trialEndedAt: mode === "ended" ? tenant.trialEndsAt : null, tenants: [tenant] }
}
describe("plan prompt trial and purchase actions", () => {
  it.each(sources)("keeps purchase and contextual eligibility for $source", async ({ source, plan }) => {
    container = document.body.appendChild(document.createElement("div")); root = createRoot(container)
    for (const mode of ["never", "running", "ended", "key", "organization", "msp"]) {
      state.status = status(mode)
      const requested = mode === "msp" ? "msp" : plan
      await act(async () => root!.render(createElement(MemoryRouter, null, createElement("span", null, createElement(PlanPromptButton, { plan: requested, source, variant: "outline", size: "sm" })))))
      const buttons = [...container.querySelectorAll("button")]
      const purchase = buttons.find(button => /^(Buy Pro|Buy MSP|See plans)$/.test(button.textContent!.trim()))
      expect(purchase, mode).toBeTruthy()
      expect(purchase!.className).toContain("border")
      expect(purchase!.className).toContain("h-8")
      const trial = buttons.find(button => button.textContent === "Try Pro free")
      expect(Boolean(trial), mode).toBe(mode === "never" && requested === "pro")
      if (trial) {
        expect(trial.className).toContain("border"); expect(trial.className).toContain("h-8")
        await act(async () => trial.click())
        expect(state.start).toHaveBeenLastCalledWith("tenant")
      }
      expect(container.querySelector("div, p")).toBeNull()
      await act(async () => purchase!.click())
      expect(state.open).toHaveBeenLastCalledWith(purchase!.textContent?.trim() === "See plans" ? "buy" : "checkout", expect.objectContaining({ source }))
    }
  })
  it("uses the explicitly uncovered tenant in a banner rather than the selected tenant", async () => {
    state.status = status("running")
    state.status.tenants.push({ ...status("never").tenants[0]!, tenantId: "uncovered" })
    container = document.body.appendChild(document.createElement("div")); root = createRoot(container)
    await act(async () => root!.render(createElement(MemoryRouter, null, createElement(PlanPromptButton, { plan: "pro", source: "not-covered", tenantId: "uncovered" }))))
    const trial = [...container.querySelectorAll("button")].find(b => b.textContent === "Try Pro free")!
    expect(trial).toBeTruthy()
    await act(async () => trial.click())
    expect(state.start).toHaveBeenLastCalledWith("uncovered")
    expect(container.textContent).toContain("Buy Pro")
  })
  it("never offers another tenant's trial in the current tenant's prompt", async () => {
    state.status = status("organization")
    state.status.tenants.push({ ...status("never").tenants[0]!, tenantId: "other" })
    container = document.body.appendChild(document.createElement("div")); root = createRoot(container)
    await act(async () => root!.render(createElement(MemoryRouter, null, createElement(PlanPromptButton, { plan: "pro", source: "not-covered" }))))
    expect(container.textContent).not.toContain("Try Pro free")
    expect(container.textContent).toContain("See plans")
  })
})
