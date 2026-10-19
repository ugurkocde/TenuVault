import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Tenant } from "../../src/portal/contexts/TenantContext"
import type { AuditWatch, NotificationsStatus } from "../../src/renderer/features/notifications/api"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({ auditWatch: null as AuditWatch | null }))

vi.mock("../../src/renderer/features/notifications/api", async (original) => ({
  ...(await original<typeof import("../../src/renderer/features/notifications/api")>()),
  notificationsApi: {
    status: async (): Promise<NotificationsStatus> => ({ channels: [], rules: [], auditWatch: state.auditWatch, deliveries: [], licensed: true, runtimeNote: "" }),
    runAuditWatch: async () => {
      // A poll only moves the poll time and the watermark.
      state.auditWatch = { ...state.auditWatch!, lastPollAt: "2026-10-19T08:00:00Z", watermark: "2026-10-19T07:59:00Z" }
      return { auditWatch: state.auditWatch, enqueued: 0, changes: 0, error: null }
    },
  },
}))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: () => undefined }))
vi.mock("../../src/renderer/components/UpgradeNote", () => ({ UpgradeNote: () => null }))

import { NotificationsPanel } from "../../src/renderer/features/notifications/NotificationsPanel"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
})

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

describe("Intune change watching form", () => {
  it("keeps unsaved edits through Poll now", async () => {
    state.auditWatch = { enabled: true, intervalMinutes: 60, categories: [], ignoreOwnChanges: true, includeActor: false, externalWatcher: false, lastPollAt: null, lastError: null, watermark: null }
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const tenant = { id: 1, name: "Contoso", credentials: { tenantId: "tenant" } } as unknown as Tenant
    act(() => root.render(createElement(QueryClientProvider, { client }, createElement(NotificationsPanel, { tenant }))))
    await flush()

    const tile = container.querySelector('[aria-labelledby="notifications-audit-heading"]')!
    const interval = tile.querySelector("select")!
    act(() => {
      interval.value = "15"
      interval.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(interval.value).toBe("15")

    const pollNow = [...tile.querySelectorAll("button")].find((button) => button.textContent === "Poll now")!
    await act(async () => { pollNow.click() })
    await flush()
    await flush()
    expect(tile.textContent).not.toContain("Last poll: Never")
    expect(tile.querySelector("select")!.value).toBe("15")
  })
})
