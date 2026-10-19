import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tenant = (id: number, tenantId: string) => ({
  id, name: `Tenant ${id}`,
  credentials: { tenantId, appId: "app", clientSecret: "secret" },
  resources: { storageAccountName: `storage${id}` },
})
const state = vi.hoisted(() => ({ selected: null as null | ReturnType<typeof tenant> }))
vi.mock("~/contexts/TenantContext", () => ({ useSelectedTenant: () => ({ selectedTenant: state.selected }) }))
vi.mock("@desktop/lib/license", () => ({ useTenantPlan: () => "pro" }))
vi.mock("@desktop/lib/toast", () => ({ toast: vi.fn() }))
vi.mock("@desktop/components/PlanGate", () => ({ canUse: () => true, GatedButton: () => null, LockedPreview: () => null }))

import AuditPage from "../../src/portal/app/portal/audit/page"

const entry = (index: number, tag = "") => ({
  id: `event-${tag}${index}`, timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(), eventType: "BACKUP_COMPLETED", severity: "INFO", result: "SUCCESS",
  action: `${tag}action ${index}`, user: { name: "Admin", email: "admin@example.test" }, resource: { type: "backup", name: `${tag}backup ${index}` },
})

type LogsCall = { tenantId: string; filter: { limit: number; offset: number; searchQuery?: string; eventTypes?: string[] } }

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

/** Answers each logs request with `count(call)` entries; stats are empty. */
function stubApi(count: (call: LogsCall) => number) {
  const calls: LogsCall[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (String(input) === "/api/audit/stats") return Response.json({ data: { summary: { totalEvents: 0, successRate: "0%" } } })
    calls.push(body)
    return Response.json({ data: Array.from({ length: count(body) }, (_, index) => entry(body.filter.offset + index)), pendingCount: 0 })
  }))
  return calls
}

async function render() {
  const root = createRoot(document.body.appendChild(document.createElement("div")))
  roots.push(root)
  await act(async () => root.render(createElement(AuditPage)))
  return root
}

const text = () => document.body.textContent ?? ""
const button = (label: string) => [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label) as HTMLButtonElement

describe("Audit log paging", () => {
  it("shows more available instead of a made-up total while another page exists", async () => {
    state.selected = tenant(1, "11111111-1111-1111-1111-111111111111")
    const calls = stubApi((call) => Math.min(call.filter.limit, 51 - call.filter.offset))
    await render()
    expect(calls.at(-1)!.filter).toMatchObject({ limit: 51, offset: 0 })
    expect(text()).toContain("Showing 1 to 50, more available")
    expect(text()).not.toContain("1000")
    expect(button("Next").disabled).toBe(false)

    await act(async () => button("Next").click())
    expect(calls.at(-1)!.filter).toMatchObject({ offset: 50 })
    expect(text()).toContain("Showing 51 to 51 of 51 entries")
    expect(button("Next").disabled).toBe(true)
  })

  it("shows the real count when everything fits on one page", async () => {
    state.selected = tenant(1, "11111111-1111-1111-1111-111111111111")
    stubApi(() => 3)
    await render()
    expect(text()).toContain("Showing 1 to 3 of 3 entries")
    expect(button("Next").disabled).toBe(true)
  })
})
