import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Tenant } from "../../src/portal/contexts/TenantContext"
import type { NotificationRule, NotificationsStatus, PublicChannel } from "../../src/renderer/features/notifications/api"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({ status: null as unknown as NotificationsStatus, watchUpdates: [] as unknown[], pushes: [] as unknown[], added: [] as unknown[] }))

vi.mock("../../src/renderer/features/notifications/api", async (original) => ({
  ...(await original<typeof import("../../src/renderer/features/notifications/api")>()),
  notificationsApi: {
    status: async () => state.status,
    updateAuditWatch: async (_tenant: unknown, body: unknown) => { state.watchUpdates.push(body); return { auditWatch: null } },
    listAuditCategories: async () => ({ categories: ["Compliance"], source: "known" }),
    listAlertSuggestions: async () => ({ policies: [], settings: [], backup: null, error: null }),
    pushWatcherAlerts: async (_tenant: unknown, body: unknown = {}) => { state.pushes.push(body); return { watcherAlerts: state.status.watcherAlerts, skipped: [], uncovered: [] } },
    addRule: async (_tenant: unknown, body: unknown) => { state.added.push(body); return { rule: body } },
  },
}))
vi.mock("../../src/portal/contexts/TenantContext", () => ({ useTenants: () => [] }))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: () => undefined }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { license: { open: vi.fn() } } }))
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

async function render(component: typeof AlertsTab, allowed: boolean, url = "/portal/alerts"): Promise<HTMLElement> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => root.render(createElement(MemoryRouter, { initialEntries: [url] }, createElement(QueryClientProvider, { client }, createElement(component, { tenant, plan: allowed ? "pro" : "community", allowed })))))
  for (let attempt = 0; attempt < 20 && container.textContent?.includes("Loading"); attempt++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return container
}

describe("the Alerts page", () => {
  it("is a hub with alerts, channels, change watching and deliveries, all on the notifications plan", () => {
    const hub = HUBS.find((entry) => entry.id === "alerts")!
    expect(hub.tabs.map((tab) => tab.id)).toEqual(["alerts", "channels", "watching", "deliveries"])
    expect(new Set(hub.tabs.map((tab) => tab.feature))).toEqual(new Set(["notifications"]))
  })

  it("lets a first alert start without a channel: the dialog adds one", async () => {
    state.status = empty
    const container = await render(AlertsTab, true)
    expect(container.textContent).toContain("Runs while TenuVault runs.")
    expect(container.textContent).toContain("you can add its channel in the same dialog")
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent === "Add alert")!
    expect(add.disabled).toBe(false)
    act(() => add.click())
    expect([...document.body.querySelectorAll('[role="dialog"] button')].some((button) => button.textContent === "Add a channel")).toBe(true)
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

  it("says when a change alert cannot send and turns watching on from the row", async () => {
    state.watchUpdates = []
    const rule: NotificationRule = { id: "r1", title: "Compliance", enabled: true, eventTypes: ["intune.change"], minSeverity: "info", channelIds: ["c1"], mode: "immediate", conditions: null, delivery: "each" }
    state.status = { ...empty, channels: [teams], rules: [rule], signedIn: true, auditWatch: { enabled: false, intervalMinutes: 15, categories: [], ignoreOwnChanges: true, includeActor: false, externalWatcher: false, lastPollAt: null, lastError: null, watermark: null, conditionalAccess: { enabled: false, watermark: null, lastPollAt: null, lastError: null } } }
    const container = await render(AlertsTab, true)
    expect(container.textContent).toContain("Not sending changes")
    expect(container.textContent).toContain("Intune change watching is off")
    const fix = [...container.querySelectorAll("button")].find((button) => button.textContent === "Turn on Intune watching")!
    await act(async () => { fix.click() })
    expect(state.watchUpdates).toEqual([{ enabled: true }])
  })

  it("starts a new alert from a template, and opens one prefilled for a policy from elsewhere in the app", async () => {
    state.status = { ...empty, channels: [teams], signedIn: true }
    const container = await render(AlertsTab, true)
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent === "Add alert")!
    act(() => add.click())
    const template = [...document.body.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Compliance policy changes") as HTMLButtonElement
    act(() => template.click())
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect((dialog.querySelector('input[placeholder="For example: Compliance policy changes"]') as HTMLInputElement).value).toBe("Compliance policy changes")
    expect((dialog.querySelectorAll('input[name="alert-delivery"]')[1] as HTMLInputElement).checked).toBe(true)
    expect(dialog.textContent).toContain("Also turn on Intune change watching")
    for (const root of roots.splice(0)) act(() => root.unmount())
    document.body.innerHTML = ""

    await render(AlertsTab, true, "/portal/alerts/alerts?alertFor=Windows%20baseline&service=intune")
    const prefilled = document.body.querySelector('[role="dialog"]')!
    expect((prefilled.querySelector('input[placeholder="For example: Compliance policy changes"]') as HTMLInputElement).value).toBe("Changes to Windows baseline")
    expect((prefilled.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Windows baseline")
    // A policy picked elsewhere means only that policy: exact name matching is on.
    const exact = [...prefilled.querySelectorAll('[role="radio"]')].find((radio) => radio.textContent === "Exact name")!
    expect(exact.getAttribute("aria-checked")).toBe("true")
    expect(prefilled.textContent).toContain("Policy names are exactly")
    state.added = []
    const save = [...prefilled.querySelectorAll("button")].find((button) => button.textContent === "Add alert" || button.textContent === "Save alert") as HTMLButtonElement
    await act(async () => { save.click() })
    expect(state.added).toMatchObject([{ conditions: { policyNames: ["Windows baseline"], policyNameMatch: "exact" } }])
  })

  it("switches a policy filter between contains and exact name", async () => {
    state.status = { ...empty, channels: [teams], signedIn: true }
    const container = await render(AlertsTab, true)
    act(() => ([...container.querySelectorAll("button")].find((button) => button.textContent === "Add alert")!).click())
    act(() => ([...document.body.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Compliance policy changes") as HTMLButtonElement).click())
    const dialog = document.body.querySelector('[role="dialog"]')!
    const radio = (label: string) => [...dialog.querySelectorAll('[role="radio"]')].find((entry) => entry.textContent === label) as HTMLButtonElement
    expect(radio("Contains").getAttribute("aria-checked")).toBe("true")
    expect(dialog.textContent).toContain("Choose Exact name for only that policy")
    act(() => radio("Exact name").click())
    expect(radio("Exact name").getAttribute("aria-checked")).toBe("true")
    expect(dialog.textContent).toContain("Renaming the policy stops its alerts")
  })

  it("filters deliveries and offers Retry on failed ones", async () => {
    state.status = { ...empty, deliveries: [
      { id: "d1", eventType: "intune.change", title: "Sent one", channelTitle: "IT Ops", state: "sent", attempts: 1, lastError: null, at: "2026-11-06T09:00:00Z" },
      { id: "d2", eventType: "backup.failed", title: "Failed one", channelTitle: "IT Ops", state: "failed", attempts: 5, lastError: "HTTP 500", at: "2026-11-06T09:00:00Z" },
    ] }
    const container = await render(DeliveriesTab, true)
    const failedFilter = [...container.querySelectorAll("button")].find((button) => button.textContent === "Failed (1)")!
    act(() => failedFilter.click())
    expect(container.textContent).toContain("Failed one")
    expect(container.textContent).not.toContain("Sent one")
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true)
  })
})

describe("the Azure watcher card", () => {
  const watched = (watcherAlerts: Partial<NonNullable<NotificationsStatus["watcherAlerts"]>>, runbookVersion: string | null = "1.2.0"): NotificationsStatus => ({
    ...empty,
    channels: [teams],
    signedIn: true,
    auditWatch: { enabled: false, intervalMinutes: 15, categories: [], ignoreOwnChanges: true, includeActor: false, externalWatcher: true, lastPollAt: null, lastError: null, watermark: null, conditionalAccess: { enabled: false, watermark: null, lastPollAt: null, lastError: null }, watcherCheck: { checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(), lastRunAt: new Date(Date.now() - 10 * 60_000).toISOString(), stale: false, error: null, alertsHash: "old", runbookVersion } },
    watcherAlerts: { current: "new", reported: "old", source: "storage", runbookVersion, readsAlertsFile: runbookVersion === null ? null : runbookVersion >= "1.2.0", auto: false, pushedAt: null, pushedHash: null, error: null, errorAt: null, ...watcherAlerts },
  })
  const card = (container: HTMLElement) => container.querySelector('[aria-labelledby="notifications-watcher-sync-heading"]') as HTMLElement

  it("updates the watcher from the app and can do so on every change", async () => {
    state.pushes = []
    state.status = watched({})
    const container = await render(AlertsTab, true)
    expect(card(container).textContent).toContain("Needs an update")
    const update = [...card(container).querySelectorAll("button")].find((button) => button.textContent === "Update watcher")!
    await act(async () => { update.click() })
    expect(state.pushes).toEqual([{}])
    const auto = card(container).querySelector('input[type="checkbox"]') as HTMLInputElement
    await act(async () => { auto.click() })
    expect(state.pushes).toEqual([{}, { auto: true, write: true }])
  })

  it("says when the update waits for the next run, failed, or needs a setup rerun first", async () => {
    state.status = watched({ pushedHash: "new", pushedAt: new Date(Date.now() - 60_000).toISOString() })
    let container = await render(AlertsTab, true)
    expect(card(container).textContent).toContain("Waiting for its next run")
    for (const root of roots.splice(0)) act(() => root.unmount())
    // The watcher ran after the update but still reports the old alerts: a warning, not waiting.
    const ran = watched({ pushedHash: "new", pushedAt: new Date(Date.now() - 60 * 60_000).toISOString(), source: "setup" })
    state.status = ran
    container = await render(AlertsTab, true)
    expect(card(container).textContent).toContain("Not using the update")
    expect(card(container).textContent).toContain("the alerts from its setup")
    for (const root of roots.splice(0)) act(() => root.unmount())
    state.status = watched({ error: "Your account cannot write to the watcher's state container.", errorAt: new Date().toISOString() })
    container = await render(AlertsTab, true)
    expect(card(container).querySelector('[role="alert"]')?.textContent).toContain("cannot write")
    for (const root of roots.splice(0)) act(() => root.unmount())
    state.status = watched({}, "1.1.0")
    container = await render(AlertsTab, true)
    expect(card(container).textContent).toContain("Needs a setup rerun")
    expect(card(container).textContent).toContain("runbook 1.1.0")
    for (const root of roots.splice(0)) act(() => root.unmount())
    // A stale heartbeat comes first: what it reported may no longer hold.
    const stale = watched({ reported: "new" })
    stale.auditWatch!.watcherCheck = { ...stale.auditWatch!.watcherCheck!, stale: true }
    state.status = stale
    container = await render(AlertsTab, true)
    expect(card(container).textContent).toContain("Not running")
    expect(card(container).textContent).not.toContain("Up to date")
    for (const root of roots.splice(0)) act(() => root.unmount())
    // Checks stopped (signed out) while the saved check still says fresh: the old run time decides.
    const old = watched({ reported: "new" })
    old.auditWatch!.watcherCheck = { ...old.auditWatch!.watcherCheck!, stale: false, lastRunAt: new Date(Date.now() - 4 * 3_600_000).toISOString() }
    state.status = old
    container = await render(AlertsTab, true)
    expect(card(container).textContent).toContain("Not running")
  })
})

describe("alert me about this policy", () => {
  it("opens a Conditional Access alert from Drift detection labels and backup folders alike", async () => {
    const { alertForPolicyHref } = await import("../../src/renderer/lib/alert-links")
    for (const type of ["Conditional Access policies", "Named locations", "Authentication strengths", "ConditionalAccessPolicies"]) expect(alertForPolicyHref("X", type)).toContain("service=conditionalAccess")
    expect(alertForPolicyHref("X", "Compliance policies")).toContain("service=intune")
  })
})
