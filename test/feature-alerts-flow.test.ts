import { describe, expect, it } from "vitest"
import { routes } from "../src/main/features/notifications"
import { DOMAINS } from "../src/main/features/domains"
import { checkWatcher, outboxOf, saveAuditWatch } from "../src/main/features/notifications/service"
import { watcherAlertsHash } from "../src/shared/notifications/alerts"
import type { OutboxRecord, RuleRecord } from "../src/main/features/notifications/model"
import { call, fakeDeps, TENANT_A, TENANT_B, TENANT_C } from "./feature-helpers"
import fixture from "./fixtures/notifications/audit-digest.json"

const PATH = "/api/notifications"
const NOW = new Date("2026-10-17T12:00:00Z")

function world(options: { plans?: Record<string, "pro" | "msp" | "community">; webhookStatus?: () => number; api?: (path: string, body?: Record<string, unknown>) => Response } = {}) {
  const posts: string[] = []
  const graphPaths: string[] = []
  const deps = fakeDeps({
    plans: options.plans ?? { [TENANT_A]: "pro" },
    now: () => NOW,
    externalFetch: (async (_url: string, init: RequestInit) => {
      posts.push(String(init.body))
      return new Response(null, { status: options.webhookStatus?.() ?? 204 })
    }) as unknown as typeof fetch,
    graph: () => async (_method: string, path: string) => {
      graphPaths.push(path)
      return (path.startsWith("deviceManagement/auditEvents") ? { status: 200, body: { value: fixture.events } } : { status: 404, body: {} }) as never
    },
    ...(options.api ? { api: async (path: string, _tenant: string, body?: Record<string, unknown>) => options.api!(path, body) } : {}),
  })
  return { deps, api: routes(deps), posts, graphPaths }
}

async function webhook(w: ReturnType<typeof world>, tenantId = TENANT_A) {
  return (await call(w.api, PATH, { tenantId, action: "add-channel", kind: "webhook", url: "https://hooks.example.test/a" })).body.channel.id as string
}

describe("checking an alert against the last days", () => {
  it("reads the audit log and shows what the alert would have sent, sending and remembering nothing", async () => {
    const w = world()
    await webhook(w)
    const preview = await call(w.api, PATH, { tenantId: TENANT_A, action: "preview-rule", eventTypes: ["intune.change"], delivery: "each", conditions: { policyNames: ["wifi"] } })
    expect(preview.status).toBe(200)
    expect(preview.body).toMatchObject({ days: 7, total: 2, services: [{ service: "intune", read: 3, changes: 3, capped: false, error: null }] })
    expect(preview.body.messages.map((message: { title: string }) => message.title)).toEqual(["Intune change: WiFi Corp updated", "Intune change: WiFi Corp updated"])
    expect(decodeURIComponent(w.graphPaths[0]!)).toContain("activityDateTime gt 2026-10-10T12:00:00.000Z")
    expect(w.posts).toHaveLength(0)
    expect(outboxOf(w.deps, TENANT_A)).toHaveLength(0)
  })

  it("plans each check interval on its own, as watching does", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ ...fixture.events[0]!, id: `bulk-${index}`, activityDateTime: new Date(Date.parse("2026-10-16T08:00:00Z") + index * 60 * 60_000).toISOString(), resources: [{ ...fixture.events[0]!.resources[0]!, displayName: `Policy ${index}`, resourceId: `id-${index}` }] }))
    const w = world()
    w.deps.graph = async () => (async () => ({ status: 200, body: { value: many } })) as never
    // One change per hour with a 15 minute interval: 30 checks, so each change goes on its own,
    // past the per-check limit of 20 that one big plan would apply.
    const each = await call(w.api, PATH, { tenantId: TENANT_A, action: "preview-rule", eventTypes: ["intune.change"], delivery: "each" })
    expect(each.body.total).toBe(30)
    const digest = await call(w.api, PATH, { tenantId: TENANT_A, action: "preview-rule", eventTypes: ["intune.change"], delivery: "digest" })
    expect(digest.body.total).toBe(30)
  })

  it("explains that only change alerts can be checked", async () => {
    const w = world()
    const refused = await call(w.api, PATH, { tenantId: TENANT_A, action: "preview-rule", eventTypes: ["backup.failed"] })
    expect(refused.status).toBe(400)
  })
})

describe("deliveries", () => {
  it("shows a delivery with its event and sends a failed one again", async () => {
    let status = 500
    const w = world({ webhookStatus: () => status })
    const channelId = await webhook(w)
    await call(w.api, PATH, { tenantId: TENANT_A, action: "add-rule", eventTypes: ["intune.change"], channelIds: [channelId] })
    saveAuditWatch(w.deps, TENANT_A, { enabled: true }, { actor: null, reason: "test" })
    const entry = w.deps.records.create<OutboxRecord>(DOMAINS.notificationOutbox, TENANT_A, { channelId, channelTitle: "hooks", eventId: "e1", envelope: { schema: "tenuvault.notification/v1", eventId: "e1", type: "intune.change", severity: "info", tenant: { id: TENANT_A }, occurredAt: NOW.toISOString(), title: "Intune changes", summary: "s", details: [], items: [], moreCount: 0, source: "desktop" }, state: "failed", attempts: 5, nextAttemptAt: NOW.toISOString(), lastError: "HTTP 500", lastStatus: 500, sentAt: null }, { actor: null, reason: "seed" })
    const shown = await call(w.api, PATH, { tenantId: TENANT_A, action: "get-delivery", deliveryId: entry.id })
    expect(shown.body).toMatchObject({ state: "failed", channelKind: "webhook", envelope: { eventId: "e1" } })
    status = 204
    const retried = await call(w.api, PATH, { tenantId: TENANT_A, action: "retry-delivery", deliveryId: entry.id })
    expect(retried.body).toMatchObject({ state: "sent", lastError: null })
    expect(w.posts).toHaveLength(1)
    const again = await call(w.api, PATH, { tenantId: TENANT_A, action: "retry-delivery", deliveryId: entry.id })
    expect(again.status).toBe(409)
  })
})

describe("suggestions for the alert dialog", () => {
  it("lists policy names of the newest usable backup and setting names seen in alerts", async () => {
    const w = world({
      api: (path, body) => {
        if (path === "/api/list-backups") return Response.json({ backups: [{ id: "b-running", status: "Running" }, { id: "b-gone", status: "Unavailable" }, { id: "b-failed", status: "Failed" }, { id: "b-ok", status: "Success", timestamp: "2026-10-16T02:00:00Z" }] })
        if (path === "/api/list-backup-contents" && body?.backupId === "b-ok") return Response.json({ content: { groups: [
          { folder: "DeviceCompliancePolicies", label: "Compliance policies", policies: [{ displayName: "Windows 11 - Compliance" }, { displayName: "Windows 11 - Compliance" }] },
          { folder: "ConditionalAccessPolicies", label: "Conditional Access policies", policies: [{ displayName: "Block legacy authentication" }] },
        ] } })
        return Response.json({}, { status: 404 })
      },
    })
    const channelId = await webhook(w)
    await call(w.api, PATH, { tenantId: TENANT_A, action: "add-rule", eventTypes: ["intune.change"], channelIds: [channelId], conditions: { settingNames: ["Firewall"] } })
    const suggestions = await call(w.api, PATH, { tenantId: TENANT_A, action: "list-alert-suggestions" })
    expect(suggestions.body).toEqual({
      policies: [
        { name: "Block legacy authentication", type: "Conditional Access policies", service: "conditionalAccess" },
        { name: "Windows 11 - Compliance", type: "Compliance policies", service: "intune" },
      ],
      settings: ["Firewall"],
      backup: { id: "b-ok", at: "2026-10-16T02:00:00Z" },
      error: null,
    })
  })
})

describe("the Azure watcher runs which alerts", () => {
  it("compares the alerts hash from the heartbeat with the alerts now", async () => {
    const w = world()
    let reported: string | null = "none"
    w.deps.watcherHeartbeat = async () => ({ status: "ok", runAt: NOW.toISOString(), lastError: null, alertsHash: reported })
    const channelId = await webhook(w)
    await call(w.api, PATH, { tenantId: TENANT_A, action: "add-rule", title: "Changes", eventTypes: ["intune.change"], channelIds: [channelId] })
    saveAuditWatch(w.deps, TENANT_A, { externalWatcher: true }, { actor: null, reason: "test" })
    await checkWatcher(w.deps, TENANT_A)
    let status = (await call(w.api, PATH, { tenantId: TENANT_A, action: "get-status" })).body
    const exported = (await call(w.api, PATH, { tenantId: TENANT_A, action: "export-watcher-alerts" })).body
    expect(status.watcherAlerts).toEqual({ current: watcherAlertsHash(exported.document), reported: "none" })
    expect(status.signedIn).toBe(true)
    reported = watcherAlertsHash(exported.document)
    await checkWatcher(w.deps, TENANT_A)
    status = (await call(w.api, PATH, { tenantId: TENANT_A, action: "get-status" })).body
    expect(status.watcherAlerts.reported).toBe(status.watcherAlerts.current)
  })
})

describe("copying alerts to other tenants", () => {
  it("maps channels by kind, skips names the target has, and turns off copies without a channel", async () => {
    const w = world({ plans: { [TENANT_A]: "msp", [TENANT_B]: "msp", [TENANT_C]: "msp" } })
    const source = await webhook(w)
    const teams = (await call(w.api, PATH, { tenantId: TENANT_A, action: "add-channel", kind: "teams", url: "https://contoso.webhook.office.com/workflows/x" })).body.channel.id
    await call(w.api, PATH, { tenantId: TENANT_A, action: "add-rule", title: "Compliance", eventTypes: ["intune.change"], channelIds: [source], delivery: "each", conditions: { categories: ["Compliance"] } })
    await call(w.api, PATH, { tenantId: TENANT_A, action: "add-rule", title: "Teams only", eventTypes: ["backup.failed"], channelIds: [teams] })
    const targetHook = await webhook(w, TENANT_B)
    await call(w.api, PATH, { tenantId: TENANT_B, action: "add-rule", title: "teams ONLY", eventTypes: ["backup.failed"], channelIds: [targetHook] })
    const rules = (await call(w.api, PATH, { tenantId: TENANT_A, action: "get-status" })).body.rules as Array<{ id: string }>
    const copied = await call(w.api, PATH, { tenantId: TENANT_A, action: "portfolio-copy-rules", ruleIds: rules.map((rule) => rule.id), targetTenants: [{ tenantId: TENANT_B }, { tenantId: TENANT_C }] })
    expect(copied.status).toBe(200)
    expect(copied.body.results).toEqual([
      { tenantId: TENANT_B, tenantName: expect.any(String), created: ["Compliance"], skipped: ["Teams only"], withoutChannels: [], full: [] },
      { tenantId: TENANT_C, tenantName: expect.any(String), created: ["Compliance", "Teams only"], skipped: [], withoutChannels: ["Compliance", "Teams only"], full: [] },
    ])
    const onB = w.deps.records.list<RuleRecord>(DOMAINS.notificationRules, TENANT_B).find((rule) => rule.title === "Compliance")!
    expect(onB).toMatchObject({ enabled: true, channelIds: [targetHook], delivery: "each", conditions: { categories: ["Compliance"] } })
    // The copy describes its own channels, not the original's.
    expect(w.deps.records.list<RuleRecord>(DOMAINS.notificationRules, TENANT_C)[0]!.summary).toContain("to 0 channels")
    expect(w.deps.records.list<RuleRecord>(DOMAINS.notificationRules, TENANT_C).every((rule) => !rule.enabled && rule.channelIds.length === 0)).toBe(true)
  })

  it("stops at the alert limit of the target tenant", async () => {
    const w = world({ plans: { [TENANT_A]: "msp", [TENANT_B]: "msp" } })
    const source = await webhook(w)
    await call(w.api, PATH, { tenantId: TENANT_A, action: "add-rule", title: "One more", eventTypes: ["backup.failed"], channelIds: [source] })
    const target = await webhook(w, TENANT_B)
    for (let index = 0; index < 25; index++) await call(w.api, PATH, { tenantId: TENANT_B, action: "add-rule", title: `Alert ${index}`, eventTypes: ["backup.failed"], channelIds: [target] })
    const rules = (await call(w.api, PATH, { tenantId: TENANT_A, action: "get-status" })).body.rules as Array<{ id: string }>
    const copied = await call(w.api, PATH, { tenantId: TENANT_A, action: "portfolio-copy-rules", ruleIds: rules.map((rule) => rule.id), targetTenants: [{ tenantId: TENANT_B }] })
    expect(copied.body.results[0]).toMatchObject({ created: [], full: ["One more"] })
    expect(w.deps.records.list<RuleRecord>(DOMAINS.notificationRules, TENANT_B)).toHaveLength(25)
  })

  it("needs the MSP plan", async () => {
    const w = world({ plans: { [TENANT_A]: "pro", [TENANT_B]: "pro" } })
    const denied = await call(w.api, PATH, { tenantId: TENANT_A, action: "portfolio-copy-rules", ruleIds: ["x"], targetTenants: [{ tenantId: TENANT_B }] })
    expect(denied.status).toBe(402)
  })
})
