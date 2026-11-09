import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { LicenseStatus } from "../../src/shared/ipc"
import type { Plan } from "../../src/shared/plans"
import { TenantProvider, useTenantAzureSync, useTenantOperations, type Tenant } from "../../src/portal/contexts/TenantContext"

const state = vi.hoisted(() => ({ status: null as LicenseStatus | null }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: {} }))
vi.mock("../../src/renderer/lib/license", async (original) => ({ ...await original<typeof import("../../src/renderer/lib/license")>(), useLicense: () => ({ status: state.status }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TENANT = "11111111-1111-1111-1111-111111111111"
const profile = (local = false) => ({ id: 1, name: "Contoso", credentials: { tenantId: TENANT, appId: TENANT, clientSecret: "fixture" }, resources: { storageAccountName: local ? `tvlocal-${TENANT}` : "stcontoso" }, tags: [] }) as unknown as Tenant
const setPlan = (plan: Plan | null) => { state.status = { tenants: [{ tenantId: TENANT, plan, entitled: plan === "pro" || plan === "msp" }] } as LicenseStatus }
let cleanup = () => {}
beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => undefined) })
afterEach(() => { cleanup(); document.body.replaceChildren(); sessionStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function render(tenant = profile()) {
  sessionStorage.setItem("tenuvault_tenants", JSON.stringify([tenant]))
  let api!: ReturnType<typeof useTenantOperations> & ReturnType<typeof useTenantAzureSync>
  function Probe() { api = { ...useTenantOperations(), ...useTenantAzureSync() }; return null }
  const root = createRoot(document.body.appendChild(document.createElement("div")))
  cleanup = () => act(() => root.unmount())
  const rerender = () => act(() => root.render(createElement(TenantProvider, null, createElement(Probe))))
  rerender()
  return { operations: () => api, rerender }
}

it("keeps Community Azure profile edits local, skips direct writes and permits reads", async () => {
  vi.useFakeTimers()
  setPlan("community")
  const fetch = vi.fn(async (_url: string) => Response.json({ exists: false }))
  vi.stubGlobal("fetch", fetch)
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
  const { operations } = render()
  act(() => operations().updateTenant(1, { name: "Contoso updated" }))
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  await operations().syncTenantToAzure(1)
  await operations().syncTenantToAzureDirect(profile())
  await operations().deleteTenantMetadata(1)
  expect(fetch).not.toHaveBeenCalled()
  expect(JSON.parse(sessionStorage.getItem("tenuvault_tenants")!)[0].name).toBe("Contoso updated")
  await operations().loadTenantFromAzure(profile().credentials!, "stcontoso")
  await operations().checkTenantMetadata(profile().credentials!, "stcontoso")
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/tenant-metadata/load", "/api/tenant-metadata/check"])
  expect(error).not.toHaveBeenCalled()
})

it.each(["pro", "msp", "community"] as const)("allows the existing metadata sync on %s with supported storage", async (plan) => {
  vi.useFakeTimers()
  setPlan(plan)
  const fetch = vi.fn(async (_url: string) => Response.json({ saved: true }))
  vi.stubGlobal("fetch", fetch)
  const { operations } = render(profile(plan === "community"))
  act(() => operations().updateTenant(1, { tags: ["Production"] }))
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/tenant-metadata/save")
})

it("uses the current license when a queued sync fires after a downgrade", async () => {
  vi.useFakeTimers()
  setPlan("pro")
  const fetch = vi.fn(async (_url: string) => Response.json({ saved: true }))
  vi.stubGlobal("fetch", fetch)
  const { operations, rerender } = render()
  act(() => operations().updateTenant(1, { tags: ["Production"] }))
  setPlan("community")
  rerender()
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(fetch).not.toHaveBeenCalled()
})

it("silently handles a main-process refusal when coverage changes during a sync", async () => {
  setPlan("pro")
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ upgrade: "azureStorage" }, { status: 402 })))
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
  const { operations } = render()
  await operations().syncTenantToAzureDirect(profile())
  await operations().syncTenantToAzure(1)
  expect(error).not.toHaveBeenCalled()
})


it("silently skips an incomplete restored profile while its license is unknown", async () => {
  vi.useFakeTimers()
  state.status = null
  const fetch = vi.fn(async (_url: string) => Response.json({ saved: true }))
  vi.stubGlobal("fetch", fetch)
  const { operations } = render({ ...profile(), resources: {} } as Tenant)
  act(() => operations().updateTenant(1, { tags: ["Production"] }))
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(fetch).not.toHaveBeenCalled()
})
