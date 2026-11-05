import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Tenant } from "../../src/portal/contexts/TenantContext"
import type { CardLayout } from "../../src/shared/notifications/layout"
import type { PublicChannel } from "../../src/renderer/features/notifications/api"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({ saved: null as unknown, tested: null as unknown, layout: { version: 1, base: {}, overrides: {} } as unknown }))

vi.mock("../../src/renderer/features/notifications/api", async (original) => ({
  ...(await original<typeof import("../../src/renderer/features/notifications/api")>()),
  notificationsApi: {
    getCardLayout: async () => ({ layout: state.layout, updatedAt: null }),
    saveCardLayout: async (_tenant: unknown, layout: CardLayout) => { state.saved = layout; return { layout, updatedAt: "2026-11-05T10:00:00Z" } },
    testChannel: async (_tenant: unknown, channelId: string, layout: CardLayout) => { state.tested = { channelId, layout }; return { delivery: { ok: true }, channel: {} } },
    resetCardLayout: async () => ({ layout: state.layout, updatedAt: null }),
  },
}))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: () => undefined }))

import { TeamsCardTile } from "../../src/renderer/features/notifications/CardLayoutEditor"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  state.saved = null
  state.tested = null
})

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

async function waitFor<T>(find: () => T | null | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const found = find()
    if (found) return found
    await flush()
  }
  throw new Error(`Timed out waiting for the editor: ${document.body.innerHTML.slice(0, 600)}`)
}

const button = (root: ParentNode, text: string) => [...root.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === text || entry.getAttribute("aria-label") === text)
const channel = { id: "teams-1", kind: "teams", title: "IT Ops alerts", enabled: true, urlHost: "contoso.webhook.office.com", headerName: null, hasSecret: false, signRequests: false, recipients: [], lastDelivery: null } as PublicChannel

function typeInto(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
}

async function openEditor() {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tenant = { id: 1, name: "Contoso", credentials: { tenantId: "tenant" } } as unknown as Tenant
  act(() => root.render(createElement(QueryClientProvider, { client }, createElement(TeamsCardTile, { tenant, channels: [channel], licensed: true, active: true }))))
  // Disabled until the saved layout has loaded.
  const customize = await waitFor(() => { const found = button(container, "Customize card"); return found && !found.disabled ? found : null })
  await act(async () => { customize.click() })
  return waitFor(() => document.querySelector('[role="dialog"]'))
}

describe("Teams card editor", () => {
  it("turns on a note, writes it, moves it, previews it and saves the layout", async () => {
    const dialog = await openEditor()
    const preview = () => dialog.querySelector('[aria-label="Teams card preview"]')!.textContent ?? ""
    expect(preview()).toContain("Intune changes: Contoso")
    await act(async () => { button(dialog, "Show Note")!.click() })
    await act(async () => { button(dialog, "NoteYour own text, for example who to call")!.click() })
    await act(async () => { typeInto(dialog.querySelector<HTMLTextAreaElement>("#card-note")!, "Call extension 4411") })
    expect(preview()).toContain("Call extension 4411")
    await act(async () => { button(dialog, "Move Note up")!.click() })
    await act(async () => { button(dialog, "Save card")!.click() })
    await waitFor(() => state.saved)
    const saved = state.saved as CardLayout
    expect(saved.base.hidden).not.toContain("note")
    expect(saved.base.noteText).toBe("Call extension 4411")
    expect(saved.base.order).toEqual(["summary", "details", "note", "items", "footer"])
  })

  it("blocks saving and testing while a text has an unknown placeholder", async () => {
    const dialog = await openEditor()
    await act(async () => { button(dialog, "SummaryOne sentence about what happened")!.click() })
    await act(async () => { typeInto(dialog.querySelector<HTMLTextAreaElement>("#card-summary")!, "Hi {oncall}") })
    expect(dialog.textContent).toContain("Unknown placeholder {oncall}")
    expect(button(dialog, "Save card")!.disabled).toBe(true)
    expect(button(dialog, "Send test to IT Ops alerts")!.disabled).toBe(true)
  })

  it("keeps a group on the default layout until it is customized, and tests the unsaved layout", async () => {
    const dialog = await openEditor()
    await act(async () => { button(dialog, "Backups")!.click() })
    expect(dialog.textContent).toContain("Backups use the default layout.")
    expect(dialog.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true)
    await act(async () => { button(dialog, "Customize backups")!.click() })
    expect(dialog.textContent).toContain("Own layout for backups")
    await act(async () => { button(dialog, "Send test to IT Ops alerts")!.click() })
    await waitFor(() => state.tested)
    expect((state.tested as { channelId: string; layout: CardLayout }).layout.overrides.backups).toBeTruthy()
  })
})
