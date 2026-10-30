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

  it("fetches only page 1 after a filter changes on a later page", async () => {
    state.selected = tenant(1, "11111111-1111-1111-1111-111111111111")
    const calls = stubApi((call) => Math.min(call.filter.limit, 200 - call.filter.offset))
    await render()
    await act(async () => button("Next").click())
    await act(async () => button("Next").click())
    expect(calls.at(-1)!.filter.offset).toBe(100)

    await act(async () => button("Filters").click())
    const before = calls.length
    const select = document.querySelector("select")!
    await act(async () => {
      ;[...select.options].find((option) => option.value === "BACKUP_FAILED")!.selected = true
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(calls.slice(before).map((call) => call.filter)).toEqual([expect.objectContaining({ offset: 0, eventTypes: ["BACKUP_FAILED"] })])
    expect(text()).toContain("Showing 1 to 50")
  })

  it("starts a search at page 1", async () => {
    state.selected = tenant(1, "11111111-1111-1111-1111-111111111111")
    const calls = stubApi((call) => Math.min(call.filter.limit, 200 - call.filter.offset))
    await render()
    await act(async () => button("Next").click())
    const input = document.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "firewall")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const before = calls.length
    await act(async () => input.form!.requestSubmit())
    expect(calls.slice(before).map((call) => call.filter)).toEqual([expect.objectContaining({ offset: 0, searchQuery: "firewall" })])
    expect(text()).toContain("Showing 1 to 50")
  })

  it("exports with the submitted search, not the text typed after it", async () => {
    state.selected = tenant(1, "11111111-1111-1111-1111-111111111111")
    const exported: Array<{ searchQuery?: string }> = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (String(input) === "/api/audit/stats") return Response.json({ data: { summary: { totalEvents: 0, successRate: "0%" } } })
      if (String(input) === "/api/audit/export") {
        exported.push(body.exportOptions.filter)
        return new Response("[]", { headers: { "content-type": "application/json" } })
      }
      return Response.json({ data: [entry(0)], pendingCount: 0 })
    }))
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:export"), revokeObjectURL: vi.fn() })
    await render()
    const input = document.querySelector<HTMLInputElement>('input[type="search"]')!
    const type = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
    }
    await type("alpha")
    await act(async () => input.form!.requestSubmit())
    await type("beta")

    const trigger = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Export"))!
    await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.click() })
    const item = [...document.querySelectorAll("[role=menuitem]")].find((entry) => entry.textContent?.includes("Export as JSON")) as HTMLElement
    await act(async () => { item.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })); item.click() })
    expect(exported.length).toBeGreaterThan(0)
    for (const filter of exported) expect(filter).toMatchObject({ searchQuery: "alpha" })
  })

  it("keeps the page when the selected tenant object is replaced by a background update", async () => {
    state.selected = tenant(1, "11111111-1111-1111-1111-111111111111")
    const calls = stubApi((call) => Math.min(call.filter.limit, 200 - call.filter.offset))
    const root = await render()
    await act(async () => button("Next").click())
    const before = calls.length
    state.selected = { ...state.selected, name: "Tenant 1 after backup" }
    await act(async () => root.render(createElement(AuditPage)))
    expect(calls.length).toBe(before)
    expect(text()).toContain("Showing 51 to 100")
  })

  it("shows the real count when everything fits on one page", async () => {
    state.selected = tenant(1, "11111111-1111-1111-1111-111111111111")
    stubApi(() => 3)
    await render()
    expect(text()).toContain("Showing 1 to 3 of 3 entries")
    expect(button("Next").disabled).toBe(true)
  })
})

describe("Audit log after switching tenants", () => {
  it("ignores a slower response for the previous tenant", async () => {
    const a = tenant(1, "11111111-1111-1111-1111-111111111111")
    const b = tenant(2, "22222222-2222-2222-2222-222222222222")
    state.selected = a
    const pending: Array<{ tenantId: string; resolve: () => void }> = []
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
      const body = JSON.parse(String(init?.body))
      const tag = body.tenantId === a.credentials.tenantId ? "a-" : "b-"
      const stats = String(input) === "/api/audit/stats"
      pending.push({ tenantId: body.tenantId, resolve: () => resolve(stats
        ? Response.json({ data: { summary: { totalEvents: tag === "a-" ? 111 : 222, successRate: "100%" } } })
        : Response.json({ data: [entry(1, tag)], pendingCount: 0 })) })
    })))
    const root = await render()
    state.selected = b
    await act(async () => root.render(createElement(AuditPage)))
    // Tenant B answers first, then tenant A's slow query arrives.
    for (const request of pending.filter((item) => item.tenantId === b.credentials.tenantId)) await act(async () => request.resolve())
    for (const request of pending.filter((item) => item.tenantId === a.credentials.tenantId)) await act(async () => request.resolve())
    expect(text()).toContain("b-action 1")
    expect(text()).not.toContain("a-action 1")
    expect(text()).toContain("222")
    expect(text()).not.toContain("111")
  })
})
