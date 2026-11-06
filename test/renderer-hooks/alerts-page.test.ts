import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Tenant } from "../../src/portal/contexts/TenantContext"
import type { NotificationsStatus, PublicChannel } from "../../src/renderer/features/notifications/api"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({ status: null as unknown as NotificationsStatus }))

vi.mock("../../src/renderer/features/notifications/api", async (original) => ({
  ...(await original<typeof import("../../src/renderer/features/notifications/api")>()),
  notificationsApi: { status: async () => state.status },
}))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: () => undefined }))
vi.mock("../../src/renderer/features/notifications/optional-permissions", () => ({ useOptionalPermission: () => null }))

import { AlertsTab, ChannelsTab, DeliveriesTab } from "../../src/renderer/features/notifications/NotificationsPanel"
import { HUBS } from "../../src/renderer/features/hubs"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
})

const empty: NotificationsStatus = { channels: [], rules: [], auditWatch: null, deliveries: [], licensed: true, runtimeNote: "Runs while TenuVault runs." }
const teams: PublicChannel = { id: "c1", kind: "teams", title: "IT Ops", enabled: true, urlHost: "contoso.webhook.office.com", headerName: null, hasSecret: false, signRequests: false, recipients: [], lastDelivery: null }
const tenant = { id: 1, name: "Contoso", credentials: { tenantId: "tenant" } } as unknown as Tenant

async function render(component: typeof AlertsTab, allowed: boolean): Promise<HTMLElement> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => root.render(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client }, createElement(component, { tenant, plan: allowed ? "pro" : "community", allowed })))))
  for (let attempt = 0; attempt < 20 && container.textContent?.includes("Loading"); attempt++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return container
}

describe("the Alerts page", () => {
  it("is a hub with alerts, channels, change watching and deliveries, all on the notifications plan", () => {
    const hub = HUBS.find((entry) => entry.id === "alerts")!
    expect(hub.tabs.map((tab) => tab.id)).toEqual(["alerts", "channels", "watching", "deliveries"])
    expect(new Set(hub.tabs.map((tab) => tab.feature))).toEqual(new Set(["notifications"]))
  })

  it("points to the Channels tab while there is no channel", async () => {
    state.status = empty
    const container = await render(AlertsTab, true)
    expect(container.textContent).toContain("Runs while TenuVault runs.")
    expect(container.querySelector('a[href="/portal/alerts/channels"]')?.textContent).toBe("Open Channels")
  })

  it("points from channels without an alert to the Alerts tab", async () => {
    state.status = { ...empty, channels: [teams] }
    const container = await render(ChannelsTab, true)
    expect(container.querySelector('a[href="/portal/alerts/alerts"]')?.textContent).toBe("Add an alert")
  })

  it("shows nothing below the locked preview when nothing was set up on an earlier plan", async () => {
    state.status = { ...empty, licensed: false }
    expect((await render(AlertsTab, false)).textContent).toBe("")
    expect((await render(DeliveriesTab, false)).textContent).toBe("")
  })

  it("keeps channels from an earlier plan visible so they can be turned off", async () => {
    state.status = { ...empty, licensed: false, channels: [teams] }
    const container = await render(ChannelsTab, false)
    expect(container.textContent).toContain("IT Ops")
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Turn off" && !button.disabled)).toBe(true)
  })
})
