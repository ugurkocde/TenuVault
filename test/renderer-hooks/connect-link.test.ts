import { act, createElement, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useLocation } from "react-router-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PendingConnectLink } from "../../src/shared/deep-link"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const state = vi.hoisted(() => ({
  pending: null as PendingConnectLink | null, rejected: false,
  notify: null as (() => void) | null,
  tenants: [] as { id: number; credentials: { tenantId: string; appId: string } }[],
  jobs: [] as { isComplete: boolean }[], select: vi.fn(), dismiss: vi.fn(),
}))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { connectLink: {
  takePending: async () => { return { pending: state.pending, rejected: state.rejected } },
  dismissRejection: async () => { state.rejected = false },
  dismiss: async (id: number) => { state.dismiss(id); if (state.pending?.id === id) state.pending = null },
  onAvailable: (fn: () => void) => { state.notify = fn; return () => { state.notify = null } },
} } }))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => state.tenants, useSelectedTenant: () => ({ setSelectedTenantId: state.select }) }))
vi.mock("~/contexts/BackupProgressContext", () => ({ useBackupProgress: () => ({ activeJobs: state.jobs }) }))

import { ConnectLinkHost } from "../../src/renderer/components/ConnectLinkHost"
import { holdConnectLinks } from "../../src/renderer/lib/connect-link-holds"
import { takeOnboardingConnect } from "../../src/renderer/lib/connect-link-onboarding"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../../src/portal/components/ui/dialog"

const tenantId = "11111111-1111-4111-8111-111111111111", clientId = "22222222-2222-4222-8222-222222222222"
let root: Root | null = null
let otherModal = false
function View() {
  const route = useLocation()
  return createElement("div", null, createElement("p", { id: "route" }, route.pathname),
    createElement(Dialog, { open: otherModal }, createElement(DialogContent, null, createElement(DialogTitle, null, "Other dialog"), createElement(DialogDescription, null, "Finish this first."))),
    createElement(ConnectLinkHost))
}
const draw = () => act(async () => { root!.render(createElement(StrictMode, null, createElement(MemoryRouter, null, createElement(View)))) })
const click = async (label: string) => act(async () => { [...document.querySelectorAll("button")].find(button => button.textContent === label)!.click() })
beforeEach(() => {
  state.pending = { id: 1, details: { tenantId, clientId, displayName: "Contoso & Co" } }; state.rejected = false; state.jobs = []; state.tenants = []; otherModal = false
  state.dismiss.mockClear(); state.select.mockClear(); takeOnboardingConnect()
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root?.unmount()); root = null; takeOnboardingConnect(); document.body.innerHTML = "" })

it("shows both IDs and a plain text name, and Cancel leaves no onboarding request", async () => {
  await draw()
  for (const text of ["Connect a tenant?", tenantId, clientId, "Contoso & Co", "You sign in with Microsoft next. Nothing is saved until you do."]) expect(document.body.textContent).toContain(text)
  expect(takeOnboardingConnect()).toBeNull()
  await click("Cancel")
  expect(state.dismiss).toHaveBeenCalledWith(1)
  expect(takeOnboardingConnect()).toBeNull()
  expect(document.querySelector("#route")?.textContent).toBe("/")
})
it("Continue hands IDs to onboarding without starting sign-in", async () => {
  await draw(); await click("Continue to sign in")
  expect(takeOnboardingConnect()).toEqual({ tenantId, clientId, displayName: "Contoso & Co" })
  expect(document.querySelector("#route")?.textContent).toBe("/portal/onboarding")
})
it("opens an already connected tenant with the same registration", async () => {
  state.tenants = [{ id: 7, credentials: { tenantId: tenantId.toUpperCase(), appId: clientId.toUpperCase() } }]
  await draw()
  expect(document.body.textContent).toContain("already connected with this app registration")
  await click("Continue to sign in")
  expect(state.select).toHaveBeenCalledWith(7)
  expect(document.querySelector("#route")?.textContent).toBe("/portal/dashboard")
  expect(takeOnboardingConnect()).toBeNull()
})
it("explains a different registration and offers sign-in without replacing the saved tenant", async () => {
  state.tenants = [{ id: 7, credentials: { tenantId, appId: tenantId } }]
  await draw()
  expect(document.body.textContent).toContain("already connected with a different app registration")
  await click("Continue to sign in")
  expect(state.select).not.toHaveBeenCalled()
  expect(state.tenants[0]!.credentials.appId).toBe(tenantId)
  expect(takeOnboardingConnect()?.clientId).toBe(clientId)
})
it("waits for every explicit setup, sign-in or restore hold to end", async () => {
  const releaseSetup = holdConnectLinks(), releaseRestore = holdConnectLinks()
  try {
    await draw(); expect(document.body.textContent).not.toContain("Connect a tenant?")
    await act(async () => releaseSetup()); expect(document.body.textContent).not.toContain("Connect a tenant?")
    await act(async () => releaseRestore()); expect(document.body.textContent).toContain("Connect a tenant?")
  } finally { releaseSetup(); releaseRestore() }
})
it("waits for a backup and shows the newest pending link afterwards", async () => {
  state.jobs = [{ isComplete: false }]; await draw()
  state.pending = { id: 2, details: { tenantId, clientId, displayName: "Newest" } }
  await act(async () => state.notify?.())
  expect(document.body.textContent).not.toContain("Connect a tenant?")
  state.jobs = [{ isComplete: true }]; await draw()
  expect(document.body.textContent).toContain("Newest")
  expect(document.body.textContent).not.toContain("Contoso & Co")
})
it("waits for another modal to close without DOM polling", async () => {
  otherModal = true; await draw()
  expect(document.body.textContent).not.toContain("Connect a tenant?")
  otherModal = false; await draw()
  expect(document.body.textContent).toContain("Connect a tenant?")
})
it("retains a cold start rejection through StrictMode without navigating or losing a valid link", async () => {
  state.rejected = true; await draw()
  expect(document.body.textContent).toContain("This TenuVault link is not valid.")
  expect(document.body.textContent).not.toContain("Connect a tenant?")
  await click("Close")
  expect(document.body.textContent).toContain("Connect a tenant?")
  expect(state.dismiss).not.toHaveBeenCalled()
  expect(document.querySelector("#route")?.textContent).toBe("/")
})
