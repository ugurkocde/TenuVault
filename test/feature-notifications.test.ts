import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { routes } from "../src/main/features/notifications"
import { DOMAINS } from "../src/main/features/domains"
import { channelsOf, flushOutbox, outboxOf, pollAuditWatch, saveAuditWatch, signBody } from "../src/main/features/notifications/service"
import { emitBackupOutcome } from "../src/main/features/notifications/producers"
import type { ChannelRecord } from "../src/main/features/notifications/model"
import { call, fakeDeps, TENANT_A, TENANT_B } from "./feature-helpers"
import fixture from "./fixtures/notifications/audit-digest.json"

const PATH = "/api/notifications"
let NOW = new Date("2026-10-17T12:00:00Z")

function world(options: { webhookStatus?: number | number[]; graph?: unknown } = {}) {
  NOW = new Date("2026-10-17T12:00:00Z")
  const posts: Array<{ url: string; init: RequestInit }> = []
  const statuses = Array.isArray(options.webhookStatus) ? [...options.webhookStatus] : null
  let status = typeof options.webhookStatus === "number" ? options.webhookStatus : 204
  const deps = fakeDeps({
    plans: { [TENANT_A]: "pro", [TENANT_B]: "community" },
    now: () => NOW,
    graph: options.graph as never,
    externalFetch: (async (url: string, init: RequestInit) => {
      posts.push({ url, init })
      return new Response(null, { status: statuses?.shift() ?? status })
    }) as unknown as typeof fetch,
  })
  return { deps, routes: routes(deps), posts, setStatus: (value: number) => void (status = value), advance: (ms: number) => void (NOW = new Date(NOW.getTime() + ms)) }
}

async function addWebhook(w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
  const created = await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-channel", kind: "webhook", url: "https://hooks.example.test/secret-path?token=abc", ...extra })
  expect(created.status).toBe(200)
  return created.body.channel
}

async function addRule(w: ReturnType<typeof world>, channelIds: string[], extra: Record<string, unknown> = {}) {
  const created = await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-rule", eventTypes: ["backup.failed", "backup.warning", "backup.succeeded", "drift.detected", "intune.change", "test"], minSeverity: "info", channelIds, ...extra })
  expect(created.status).toBe(200)
  return created.body.rule
}

describe("notification channels and rules", () => {
  it("rejects private webhook URLs and hides secrets and URL paths", async () => {
    const w = world()
    const rejected = await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-channel", kind: "webhook", url: "https://169.254.169.254/hook" })
    expect(rejected.status).toBe(400)
    const channel = await addWebhook(w, { headerName: "X-Key", headerValue: "s3cr3t-value" })
    expect(channel.urlHost).toBe("hooks.example.test")
    expect(channel.hasSecret).toBe(true)
    expect(JSON.stringify(channel)).not.toContain("s3cr3t-value")
    expect(JSON.stringify(channel)).not.toContain("secret-path")
    expect(JSON.stringify(channel.history)).not.toContain("s3cr3t-value")
  })

  it("plan gates creation but never revocation", async () => {
    const w = world()
    const denied = await call(w.routes, PATH, { tenantId: TENANT_B, action: "add-channel", kind: "local" })
    expect(denied.status).toBe(402)
    const seeded = w.deps.records.create<ChannelRecord>(DOMAINS.notificationChannels, TENANT_B, {
      kind: "webhook", title: "Old", status: "enabled", summary: "", enabled: true, url: "https://hooks.example.test/x", headerName: null, headerValue: null, signRequests: false, recipients: [], lastDelivery: null, deliveries: [],
    }, { actor: null, reason: "seed" })
    const revoked = await call(w.routes, PATH, { tenantId: TENANT_B, action: "revoke-channel", channelId: seeded.id })
    expect(revoked.status).toBe(200)
    expect(channelsOf(w.deps, TENANT_B)).toHaveLength(0)
  })

  it("delivers a backup failure to a signed webhook with the canonical envelope", async () => {
    const w = world()
    const channel = await addWebhook(w, { headerValue: "signing-secret", signRequests: true })
    await addRule(w, [channel.id])
    const created = await emitBackupOutcome(w.deps, TENANT_A, { status: "Failed", backupFolder: "backup-2026-10-17-010000", finishedAt: NOW.toISOString(), failures: 3, trigger: "scheduled" })
    expect(created).toEqual({ created: 1, localCreated: false })
    expect(w.posts).toHaveLength(1)
    const init = w.posts[0]!.init
    const body = String(init.body)
    const envelope = JSON.parse(body) as { eventId: string; type: string; severity: string }
    expect(envelope).toMatchObject({ type: "backup.failed", severity: "critical" })
    const headers = init.headers as Record<string, string>
    expect(headers["x-tenuvault-event-id"]).toBe(envelope.eventId)
    const timestamp = Number(headers["x-tenuvault-timestamp"])
    expect(headers["x-tenuvault-signature"]).toBe(signBody("signing-secret", timestamp, body))
    expect(headers["x-tenuvault-signature"]).toBe(createHmac("sha256", "signing-secret").update(`${timestamp}.${body}`).digest("hex"))
    expect(outboxOf(w.deps, TENANT_A)[0]?.state).toBe("sent")
  })

  it("dedupes the same event and retries failures from the outbox", async () => {
    const w = world({ webhookStatus: [500, 204] })
    const channel = await addWebhook(w)
    await addRule(w, [channel.id])
    const outcome = { status: "Failed" as const, backupFolder: "backup-2026-10-17-020000", finishedAt: NOW.toISOString(), failures: 1, trigger: "scheduled" }
    await emitBackupOutcome(w.deps, TENANT_A, outcome)
    expect(w.posts).toHaveLength(1)
    expect(outboxOf(w.deps, TENANT_A)[0]?.state).toBe("pending")
    // Same event again while pending: no new intent, no new send.
    expect((await emitBackupOutcome(w.deps, TENANT_A, outcome)).created).toBe(0)
    expect(w.posts).toHaveLength(1)
    w.advance(31_000)
    const flushed = await flushOutbox(w.deps, TENANT_A)
    expect(flushed.sent).toBe(1)
    expect(w.posts).toHaveLength(2)
    expect(outboxOf(w.deps, TENANT_A)[0]).toMatchObject({ state: "sent", attempts: 2 })
  })

  it("marks an intent failed after a non-retryable answer", async () => {
    const w = world({ webhookStatus: 400 })
    const channel = await addWebhook(w)
    await addRule(w, [channel.id])
    await emitBackupOutcome(w.deps, TENANT_A, { status: "Failed", backupFolder: "backup-x", finishedAt: NOW.toISOString(), trigger: "tray" })
    expect(outboxOf(w.deps, TENANT_A)[0]?.state).toBe("failed")
  })

  it("severity rules filter events", async () => {
    const w = world()
    const channel = await addWebhook(w)
    await addRule(w, [channel.id], { minSeverity: "critical" })
    expect((await emitBackupOutcome(w.deps, TENANT_A, { status: "Success", backupFolder: "backup-ok", finishedAt: NOW.toISOString(), trigger: "manual" })).created).toBe(0)
    expect(w.posts).toHaveLength(0)
  })

  it("test send delivers once and records the result", async () => {
    const w = world()
    const channel = await addWebhook(w)
    const tested = await call(w.routes, PATH, { tenantId: TENANT_A, action: "test-channel", channelId: channel.id })
    expect(tested.status).toBe(200)
    expect(tested.body.delivery.ok).toBe(true)
    expect(w.posts).toHaveLength(1)
    expect(JSON.parse(String(w.posts[0]!.init.body)).type).toBe("test")
  })
})

describe("email delivery and group resolution", () => {
  it("expands group recipients without guests and sends through Graph", async () => {
    const graphCalls: Array<{ method: string; path: string; body?: unknown }> = []
    const w = world({
      graph: () => async (method: string, path: string, body?: unknown) => {
        graphCalls.push({ method, path, body })
        if (path.startsWith("groups/")) {
          return { status: 200, body: { value: [
            { mail: "one@contoso.test", userType: "Member" },
            { mail: "guest@vendor.test", userType: "Guest" },
            { mail: "nested-group@contoso.test", displayName: "Nested group", "@odata.type": "#microsoft.graph.group" },
            { userPrincipalName: "two@contoso.test", userType: "Member" },
            { displayName: "No mail" },
          ] } }
        }
        return { status: 202, body: {} }
      },
    })
    const created = await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-channel", kind: "email", recipients: [{ type: "group", groupId: "44444444-4444-4444-4444-444444444444" }, { type: "address", address: "john.doe@contoso.test" }, { type: "address", address: "ops@alerts.contoso.test" }] })
    expect(created.status).toBe(200)
    await addRule(w, [created.body.channel.id])
    await emitBackupOutcome(w.deps, TENANT_A, { status: "Failed", backupFolder: "backup-mail", finishedAt: NOW.toISOString(), trigger: "scheduled" })
    const send = graphCalls.find((entry) => entry.path === "me/sendMail")
    expect(send).toBeTruthy()
    const recipients = (send!.body as { message: { toRecipients: Array<{ emailAddress: { address: string } }> } }).message.toRecipients.map((entry) => entry.emailAddress.address)
    expect(recipients.sort()).toEqual(["john.doe@contoso.test", "one@contoso.test", "ops@alerts.contoso.test", "two@contoso.test"])
    expect(outboxOf(w.deps, TENANT_A)[0]?.state).toBe("sent")
  })

  it("fails closed when group paging cannot finish", async () => {
    const w = world({
      graph: () => async (method: string, path: string) => {
        if (path.startsWith("groups/")) return { status: 200, body: { value: [{ mail: "a@contoso.test", userType: "Member", "@odata.type": "#microsoft.graph.user" }], "@odata.nextLink": "https://graph.microsoft.com/beta/groups/x/transitiveMembers?$skiptoken=more" } }
        return { status: 202, body: {} }
      },
    })
    const created = await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-channel", kind: "email", recipients: [{ type: "group", groupId: "44444444-4444-4444-4444-444444444444" }] })
    await addRule(w, [created.body.channel.id])
    await emitBackupOutcome(w.deps, TENANT_A, { status: "Failed", backupFolder: "backup-paging", finishedAt: NOW.toISOString(), trigger: "scheduled" })
    const entry = outboxOf(w.deps, TENANT_A)[0]
    expect(entry?.state).toBe("pending")
    expect(entry?.lastError).toContain("too large")
  })

  it("rejects malformed recipients at setup", async () => {
    const w = world()
    const created = await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-channel", kind: "email", recipients: [{ type: "address", address: "not-an-address" }] })
    expect(created.status).toBe(400)
  })
})

describe("Intune audit watching", () => {
  function auditWorld(events = fixture.events) {
    return world({
      graph: () => async (method: string, path: string) => {
        if (path.startsWith("deviceManagement/auditEvents")) {
          expect(path).toContain("activityDateTime")
          expect(path).toContain("activityOperationType")
          expect(decodeURIComponent(path)).toContain("activityOperationType ne 'Get'")
          expect(decodeURIComponent(path)).toContain("activityOperationType ne 'Search'")
          return { status: 200, body: { value: events } }
        }
        return { status: 404, body: {} }
      },
    })
  }

  it("polls once per new event, digests, and never repeats after restart state", async () => {
    const w = auditWorld()
    const local = await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-channel", kind: "local" })
    await addRule(w, [local.body.channel.id])
    saveAuditWatch(w.deps, TENANT_A, { enabled: true }, { actor: null, reason: "test" })
    const first = await pollAuditWatch(w.deps, TENANT_A)
    expect(first).toMatchObject({ changes: 3, enqueued: 1, error: null })
    expect(w.deps.notifications.some((text) => text.includes("Intune changes"))).toBe(true)
    const second = await pollAuditWatch(w.deps, TENANT_A)
    expect(second.changes).toBe(0)
    expect(second.enqueued).toBe(0)
  })

  it("excludes changes made through TenuVault itself by default", async () => {
    const own = fixture.events.map((event) => ({ ...event, actor: { ...event.actor, applicationId: "99999999-9999-9999-9999-999999999999" } }))
    const w = auditWorld(own)
    saveAuditWatch(w.deps, TENANT_A, { enabled: true }, { actor: null, reason: "test" })
    const result = await pollAuditWatch(w.deps, TENANT_A)
    expect(result.changes).toBe(0)
  })

  it("records Graph failure on the watch instead of throwing", async () => {
    const w = world({ graph: () => async () => ({ status: 403, body: { error: { message: "Forbidden" } } }) })
    saveAuditWatch(w.deps, TENANT_A, { enabled: true }, { actor: null, reason: "test" })
    const result = await pollAuditWatch(w.deps, TENANT_A)
    expect(result.error).toContain("403")
    const status = await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-status" })
    expect(status.body.auditWatch.lastError).toContain("403")
  })
})

describe("review round regressions", () => {
  it("a busy overlap window cannot stall the audit poller", async () => {
    const many = Array.from({ length: 2501 }, (_, i) => ({
      id: `bulk-${i}`,
      displayName: "Update policy",
      componentName: "Policy",
      activity: "Update",
      activityOperationType: "Update",
      activityResult: "Success",
      activityDateTime: new Date(Date.parse("2026-10-17T11:00:00Z") + i * 600).toISOString(),
      category: "Policy",
      actor: { applicationId: "app-portal", userPrincipalName: "admin@contoso.test" },
      resources: [{ displayName: `Policy ${i}`, type: "Policy" }],
    }))
    const w = world({ graph: () => async (_method: string, path: string) => {
      // Honor the $filter and page like Graph: 200 per page with a nextLink skiptoken.
      const decoded = decodeURIComponent(path)
      const since = decoded.match(/activityDateTime gt ([^&]+)/)?.[1]
      const offset = Number(decoded.match(/\$skiptoken=(\d+)/)?.[1] ?? 0)
      const filtered = since ? many.filter((event) => event.activityDateTime > since) : many
      const value = filtered.slice(offset, offset + 200)
      const next = offset + 200 < filtered.length ? { "@odata.nextLink": `https://graph.microsoft.com/beta/deviceManagement/auditEvents?$skiptoken=${offset + 200}` } : {}
      return { status: 200, body: { value, ...next } }
    } })
    saveAuditWatch(w.deps, TENANT_A, { enabled: true }, { actor: null, reason: "test" })
    const counts: number[] = []
    for (let poll = 0; poll < 7; poll++) counts.push((await pollAuditWatch(w.deps, TENANT_A)).changes)
    expect(counts).toEqual([500, 500, 500, 500, 500, 1, 0])
  })

  it("does not resend events already processed on a continuation page after a capped poll", async () => {
    // 600 events two minutes apart: the cap is hit inside page 3, whose earlier events are
    // more than the overlap older than the last one processed.
    const many = Array.from({ length: 600 }, (_, i) => ({
      id: `spread-${i}`,
      displayName: "Update policy",
      componentName: "Policy",
      activity: "Update",
      activityOperationType: "Update",
      activityResult: "Success",
      activityDateTime: new Date(Date.parse("2026-10-16T13:00:00Z") + i * 120_000).toISOString(),
      category: "Policy",
      actor: { applicationId: "app-portal", userPrincipalName: "admin@contoso.test" },
      resources: [{ displayName: `Policy ${i}`, type: "Policy" }],
    }))
    const w = world({ graph: () => async (_method: string, path: string) => {
      const decoded = decodeURIComponent(path)
      const since = decoded.match(/activityDateTime gt ([^&]+)/)?.[1]
      const offset = Number(decoded.match(/\$skiptoken=(\d+)/)?.[1] ?? 0)
      const filtered = since ? many.filter((event) => event.activityDateTime > since) : many
      const value = filtered.slice(offset, offset + 200)
      const next = offset + 200 < filtered.length ? { "@odata.nextLink": `https://graph.microsoft.com/beta/deviceManagement/auditEvents?$skiptoken=${offset + 200}` } : {}
      return { status: 200, body: { value, ...next } }
    } })
    saveAuditWatch(w.deps, TENANT_A, { enabled: true }, { actor: null, reason: "test" })
    const counts: number[] = []
    for (let poll = 0; poll < 3; poll++) counts.push((await pollAuditWatch(w.deps, TENANT_A)).changes)
    expect(counts).toEqual([500, 100, 0])
  })

  it("signed out sessions pause email deliveries without burning attempts", async () => {
    const graphCalls: string[] = []
    const deps = fakeDeps({
      plans: { [TENANT_A]: "pro" },
      now: () => NOW,
      actor: () => null,
      graph: () => async (method: string, path: string) => { graphCalls.push(path); return { status: 202, body: {} } },
    })
    const r = routes(deps)
    const created = await call(r, PATH, { tenantId: TENANT_A, action: "add-channel", kind: "email", recipients: [{ type: "address", address: "ops@contoso.test" }] })
    expect(created.status).toBe(200)
    const rule = await call(r, PATH, { tenantId: TENANT_A, action: "add-rule", eventTypes: ["backup.failed"], minSeverity: "info", channelIds: [created.body.channel.id] })
    expect(rule.status).toBe(200)
    await emitBackupOutcome(deps, TENANT_A, { status: "Failed", backupFolder: "backup-signedout", finishedAt: NOW.toISOString(), trigger: "scheduled" })
    const entry = outboxOf(deps, TENANT_A)[0]
    expect(entry).toMatchObject({ state: "pending", attempts: 0 })
    expect(graphCalls).toHaveLength(0)
  })
})

describe("turning things off after downgrade", () => {
  it("disables a channel and audit watching without the notifications feature", async () => {
    const w = world()
    const seeded = w.deps.records.create<ChannelRecord>(DOMAINS.notificationChannels, TENANT_B, {
      kind: "webhook", title: "Old", status: "enabled", summary: "", enabled: true, url: "https://hooks.example.test/x", headerName: null, headerValue: null, signRequests: false, recipients: [], lastDelivery: null, deliveries: [],
    }, { actor: null, reason: "seed" })
    const disabled = await call(w.routes, PATH, { tenantId: TENANT_B, action: "revoke-disable-channel", channelId: seeded.id })
    expect(disabled.status).toBe(200)
    expect(disabled.body.channel.enabled).toBe(false)
    const watchOff = await call(w.routes, PATH, { tenantId: TENANT_B, action: "revoke-audit-watch" })
    expect(watchOff.status).toBe(200)
    expect(watchOff.body.auditWatch.enabled).toBe(false)
    const enable = await call(w.routes, PATH, { tenantId: TENANT_B, action: "update-channel", channelId: seeded.id, enabled: true })
    expect(enable.status).toBe(402)
  })
})

describe("concurrent audit polls", () => {
  it("a second poll for the same tenant is a no-op while one is running", async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const w = world({
      graph: () => async (_method: string, _path: string) => {
        calls++
        await gate
        return { status: 200, body: { value: fixture.events } }
      },
    })
    saveAuditWatch(w.deps, TENANT_A, { enabled: true }, { actor: null, reason: "test" })
    const first = pollAuditWatch(w.deps, TENANT_A)
    const second = await pollAuditWatch(w.deps, TENANT_A)
    expect(second).toEqual({ enqueued: 0, changes: 0, error: null })
    release()
    const result = await first
    expect(result.changes).toBe(3)
    expect(calls).toBe(1)
  })
})
