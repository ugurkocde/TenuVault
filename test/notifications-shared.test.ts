import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { collapseAuditChanges, filterAuditChanges, intuneChangeDigest, mapAuditEvent, type AuditEventRaw } from "../src/shared/notifications/audit"
import { backupEvent, buildEnvelope, canonicalJson, driftEvent, eventId, sha256Hex, testEvent } from "../src/shared/notifications/envelope"
import { emailHtml, emailSubject, emailText, friendlyTime, teamsWorkflowsPayload } from "../src/shared/notifications/render"
import fixture from "./fixtures/notifications/audit-digest.json"
import liveFixture from "./fixtures/notifications/audit-live.json"

const TENANT = "11111111-1111-1111-1111-111111111111"

describe("notification envelope", () => {
  it("sha256 matches published vectors and node crypto", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(sha256Hex("tenuvault-✓-longer-value".repeat(30))).toBe(createHash("sha256").update("tenuvault-✓-longer-value".repeat(30)).digest("hex"))
  })

  it("canonical JSON sorts keys recursively without whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}')
  })

  it("eventId is deterministic and tenant scoped", () => {
    expect(eventId(TENANT, "backup.failed", "backup-2026-10-17-010000")).toBe(eventId(TENANT.toUpperCase(), "backup.failed", "backup-2026-10-17-010000"))
    expect(eventId(TENANT, "backup.failed", "x")).not.toBe(eventId("22222222-2222-2222-2222-222222222222", "backup.failed", "x"))
  })

  it("backup events map manifest status to type and severity", () => {
    const base = { tenantId: TENANT, backupFolder: "backup-2026-10-17-010000", occurredAt: "2026-10-17T01:00:00Z", source: "desktop" as const }
    expect(backupEvent({ ...base, status: "Failed" })).toMatchObject({ type: "backup.failed", severity: "critical" })
    expect(backupEvent({ ...base, status: "CompletedWithWarnings" })).toMatchObject({ type: "backup.warning", severity: "warning" })
    expect(backupEvent({ ...base, status: "Success" })).toMatchObject({ type: "backup.succeeded", severity: "info" })
  })

  it("bounds and cleans fields", () => {
    const envelope = buildEnvelope({
      type: "test", severity: "info", tenantId: TENANT, occurredAt: "2026-10-17T00:00:00Z", naturalKey: "k",
      title: `  a\n\nb  ${"x".repeat(500)}`, summary: "s".repeat(3000), source: "desktop",
      details: Array.from({ length: 40 }, (_, i) => ({ label: `l${i}`, value: "v".repeat(900) })),
      items: Array.from({ length: 40 }, (_, i) => ({ title: `i${i}` })),
    })
    expect(envelope.title.length).toBeLessThanOrEqual(200)
    expect(envelope.title).not.toContain("\n")
    expect(envelope.summary.length).toBeLessThanOrEqual(1000)
    expect(envelope.details).toHaveLength(20)
    expect(envelope.items).toHaveLength(20)
  })

  it("drift zero-change builds an envelope the service can choose not to send", () => {
    const envelope = driftEvent({ tenantId: TENANT, occurredAt: "2026-10-17T00:00:00Z", jobId: "j1", added: 0, modified: 0, deleted: 0, source: "desktop" })
    expect(envelope.type).toBe("drift.detected")
    expect(envelope.summary).toContain("0 changes")
  })
})

describe("audit mapping and digest", () => {
  const changes = fixture.events.map((event) => mapAuditEvent(event as AuditEventRaw)!)

  it("maps verbs, resource names and types, without reading property values", () => {
    expect(changes[0]).toMatchObject({ changeType: "updated", resourceName: "WiFi Corp", resourceType: "DeviceConfiguration", actorUpn: "admin@contoso.test", actorAppId: "app-portal" })
    expect(changes[2]?.changeType).toBe("deleted")
    const digest = intuneChangeDigest({ tenantId: TENANT, tenantName: "Contoso", changes, includeActor: true, source: "desktop" })
    const serialized = canonicalJson(digest)
    expect(serialized).not.toContain("old-secret")
    expect(serialized).not.toContain("new-secret")
    expect(serialized).not.toContain("networkName")
  })

  it("collapses repeated updates by the same actor", () => {
    const { items, collapsed } = collapseAuditChanges(changes, { includeActor: true })
    expect(collapsed).toBe(2)
    expect(items[0]?.title).toContain("(2 times)")
    expect(items[0]?.actor).toBe("admin@contoso.test")
    const withoutActor = collapseAuditChanges(changes, { includeActor: false })
    expect(withoutActor.items[0]?.actor).toBeUndefined()
  })

  it("filters own changes, categories and denied actors", () => {
    expect(filterAuditChanges(changes, { ownAppId: "app-portal", ignoreOwnChanges: true })).toHaveLength(0)
    expect(filterAuditChanges(changes, { categories: ["compliance"] })).toHaveLength(1)
    expect(filterAuditChanges(changes, { deniedActors: ["ADMIN@contoso.test"] })).toHaveLength(1)
  })

  it("drops read operations and classifies assignment events against the parent policy", () => {
    const live = liveFixture.events.map((event) => mapAuditEvent(event as AuditEventRaw))
    expect(live[0]).toBeNull()
    expect(live[1]).toBeNull()
    expect(live[2]).toMatchObject({ changeType: "assigned", resourceName: "WiFi Corp", resourceType: "DeviceConfiguration", actorUpn: null, actorAppName: "Contoso Automation" })
    expect(live[3]).toMatchObject({ changeType: "unassigned", resourceName: "WiFi Corp" })
    expect(live[4]?.changeType).toBe("created")
    const kept = live.filter((change) => change !== null)
    expect(intuneChangeDigest({ tenantId: TENANT, changes: kept, includeActor: true, source: "desktop" }).severity).toBe("warning")
    const { items } = collapseAuditChanges(kept, { includeActor: true })
    expect(items[0]?.actor).toBe("Contoso Automation")
    expect(filterAuditChanges(kept, { deniedActors: ["contoso automation"] })).toHaveLength(1)
  })

  it("digest id depends on the sorted audit ids only", () => {
    const a = intuneChangeDigest({ tenantId: TENANT, changes, includeActor: true, source: "desktop" })
    const b = intuneChangeDigest({ tenantId: TENANT, changes: [...changes].reverse(), includeActor: false, source: "azure-watcher" })
    expect(a.eventId).toBe(b.eventId)
    expect(a.severity).toBe("warning")
  })
})

describe("rendering", () => {
  const envelope = testEvent({ tenantId: TENANT, tenantName: "Contoso", occurredAt: "2026-10-17T00:00:00Z", channelTitle: "Ops <b>webhook</b>", source: "desktop" })

  it("escapes tenant controlled strings in HTML mail", () => {
    const html = emailHtml(envelope)
    expect(html).not.toContain("<b>webhook</b>")
    expect(html).toContain("&lt;b&gt;webhook&lt;/b&gt;")
    expect(emailText(envelope)).toContain("Ops <b>webhook</b>")
    expect(emailSubject(envelope)).toContain("TenuVault:")
  })

  it("builds a Workflows adaptive card payload", () => {
    const payload = teamsWorkflowsPayload(envelope) as { type: string; attachments: Array<{ contentType: string; content: { body: Array<{ text?: string }> } }> }
    expect(payload.type).toBe("message")
    expect(payload.attachments[0]?.contentType).toContain("adaptive")
    expect(payload.attachments[0]?.content.body.some((block) => block.text?.includes("test"))).toBe(true)
  })

  it("escapes markdown links in card text", () => {
    const hostile = testEvent({ tenantId: TENANT, occurredAt: "2026-10-17T00:00:00Z", channelTitle: "[Review required](https://attacker.example)", source: "desktop" })
    const payload = teamsWorkflowsPayload(hostile) as { attachments: Array<{ content: { body: Array<{ text?: string }> } }> }
    const texts = payload.attachments[0]!.content.body.map((block) => block.text ?? "").join(" ")
    expect(texts).toContain("\\[Review required\\]")
    expect(texts).not.toContain("[Review required](https://attacker.example)")
  })

  it("HTML mail has severity badge, verb chips, friendly times and a fixed action link", () => {
    expect(friendlyTime("2026-10-17T18:54:26.033Z")).toBe("2026-10-17 18:54 UTC")
    expect(friendlyTime("2026-10-17T18:54:26")).toBe("2026-10-17 18:54 UTC")
    expect(friendlyTime("2026-10-17T18:54:26+02:00")).toBe("2026-10-17 16:54 UTC")
    expect(friendlyTime("not-a-date")).toBe("not-a-date")
    const changes = fixture.events.map((event) => mapAuditEvent(event as AuditEventRaw)!)
    const digest = intuneChangeDigest({ tenantId: TENANT, tenantName: "Contoso", changes, includeActor: true, source: "azure-watcher" })
    const html = emailHtml(digest)
    expect(html).toContain("Warning")
    expect(html).toContain(">Deleted</span>")
    expect(html).toContain("2026-10-17 10:00 UTC")
    expect(html).not.toContain("2026-10-17T10:00:00")
    expect(html).toContain("https://intune.microsoft.com")
    expect(emailHtml(envelope)).not.toContain("intune.microsoft.com")
  })

  it("hostile policy names stay text in cards and mail", () => {
    const changes = fixture.events.map((event) => mapAuditEvent(event as AuditEventRaw)!)
    const digest = intuneChangeDigest({ tenantId: TENANT, changes, includeActor: true, source: "desktop" })
    expect(emailHtml(digest)).not.toContain("<script>alert(1)</script>")
    expect(emailHtml(digest)).toContain("&lt;script&gt;")
  })
})
