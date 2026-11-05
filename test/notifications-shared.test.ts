import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { collapseAuditChanges, filterAuditChanges, intuneChangeDigest, mapAuditEvent, type AuditEventRaw } from "../src/shared/notifications/audit"
import { backupEvent, buildEnvelope, canonicalJson, driftEvent, eventId, sha256Hex, testEvent } from "../src/shared/notifications/envelope"
import { emailHtml, emailSubject, emailText, escapeMarkdown, friendlyTime, teamsWorkflowsPayload } from "../src/shared/notifications/render"
import fixture from "./fixtures/notifications/audit-digest.json"
import liveFixture from "./fixtures/notifications/audit-live.json"
import entraFixture from "./fixtures/notifications/entra-audit.json"
import { entraChangeDigest } from "../src/shared/notifications/audit"
import { mapEntraAuditEvent, type EntraAuditRaw } from "../src/shared/notifications/entra"
import { DEFAULT_CARD_LAYOUT, DEFAULT_CARD_STYLE, isDefaultLayout, parseCardLayout, parseCardStyle, styleFor, styleIssues } from "../src/shared/notifications/layout"
import { cardOf, fillPlaceholders, fitTeamsPayload, TEAMS_MESSAGE_BUDGET_BYTES, teamsPayloadBytes } from "../src/shared/notifications/render"

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

  it("shows severity with a container style and a colored label, never a TextBlock style", () => {
    type Block = { type: string; style?: string; color?: string; text?: string; items?: Block[] }
    const cardOf = (severity: "info" | "warning" | "critical") => (teamsWorkflowsPayload({ ...envelope, severity }) as { attachments: Array<{ content: { body: Block[] } }> }).attachments[0]!.content.body
    const expected = { info: ["emphasis", "Accent", "Info"], warning: ["warning", "Warning", "Warning"], critical: ["attention", "Attention", "Critical"] } as const
    for (const severity of ["info", "warning", "critical"] as const) {
      const [header] = cardOf(severity)
      expect(header?.type).toBe("Container")
      expect(header?.style).toBe(expected[severity][0])
      expect(header?.items?.[0]).toMatchObject({ color: expected[severity][1], text: expected[severity][2] })
      const blocks = (function flatten(list: Block[]): Block[] { return list.flatMap((block) => [block, ...flatten(block.items ?? [])]) })(cardOf(severity))
      // TextBlock style only accepts default and heading; severity values there are ignored by Teams.
      expect(blocks.filter((block) => block.type === "TextBlock" && block.style !== undefined)).toEqual([])
    }
  })

  it("Teams cards use friendly times and the fixed admin center action for Intune changes only", () => {
    const changes = fixture.events.map((event) => mapAuditEvent(event as AuditEventRaw)!)
    const digest = intuneChangeDigest({ tenantId: TENANT, tenantName: "Contoso", changes, includeActor: false, source: "desktop" })
    type Card = { body: Array<{ text?: string }>; actions?: Array<{ type: string; url: string; title: string }> }
    const card = (teamsWorkflowsPayload(digest) as { attachments: Array<{ content: Card }> }).attachments[0]!.content
    const texts = card.body.map((block) => block.text ?? "").join(" ")
    expect(texts).toContain("2026\\-10\\-17 10:00 UTC")
    expect(texts).not.toMatch(/T10:00:00/)
    expect(card.actions).toEqual([{ type: "Action.OpenUrl", title: "Open the Intune admin center", url: "https://intune.microsoft.com" }])
    const testCard = (teamsWorkflowsPayload(envelope) as { attachments: Array<{ content: Card }> }).attachments[0]!.content
    expect(testCard.actions).toBeUndefined()
  })

  it("escapes markdown punctuation but leaves commas alone", () => {
    expect(escapeMarkdown("2 updated, 1 deleted - done.")).toBe("2 updated, 1 deleted \\- done\\.")
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

describe("Conditional Access change digests", () => {
  const changes = entraFixture.events.map((event) => mapEntraAuditEvent(event as EntraAuditRaw)).filter((change) => change !== null)

  it("keeps successful Conditional Access, named location and strength changes only", () => {
    // The failed strength create and the Core Directory event are dropped.
    expect(changes.map((change) => [change.changeType, change.resourceType, change.resourceName])).toEqual([
      ["created", "Named location", "Head office"],
      ["updated", "Authentication strength", null],
      ["updated", "Authentication strength", null],
      ["created", "Conditional Access policy", "Require MFA for admins"],
      ["deleted", "Conditional Access policy", "Block legacy authentication"],
    ])
    expect(changes[4]).toMatchObject({ actorUpn: null, actorAppId: "33333333-0000-0000-0000-000000000003", actorAppName: "Contoso Automation" })
  })

  it("never carries policy content or the actor IP address", () => {
    const digest = entraChangeDigest({ tenantId: entraFixture.tenantId, tenantName: entraFixture.tenantName, changes, includeActor: true, source: "desktop" })
    const everything = JSON.stringify([changes, digest, teamsWorkflowsPayload(digest), emailHtml(digest)])
    expect(everything).not.toContain("SECRET_MARKER")
    expect(everything).not.toContain("198.51.100.23")
    expect(everything).not.toContain("Phishing resistant")
  })

  it("builds an entra.change digest that warns on deletions and links to Conditional Access", () => {
    const digest = entraChangeDigest({ tenantId: entraFixture.tenantId, tenantName: entraFixture.tenantName, changes, includeActor: false, source: "desktop" })
    expect(digest).toMatchObject({ type: "entra.change", severity: "warning", title: "Conditional Access changes: Contoso" })
    expect(digest.summary).toBe("5 changes in Conditional Access (2 created, 2 updated, 1 deleted), shown as 4 lines.")
    expect(digest.items.map((item) => item.title)).toEqual(["Created: Head office", "Updated: Authentication strength (2 times)", "Created: Require MFA for admins", "Deleted: Block legacy authentication"])
    const card = (teamsWorkflowsPayload(digest) as { attachments: Array<{ content: { actions?: Array<{ url: string }> } }> }).attachments[0]!.content
    expect(card.actions?.[0]?.url).toBe("https://entra.microsoft.com/#view/Microsoft_AAD_ConditionalAccess/ConditionalAccessBlade/~/Policies")
    expect(emailHtml(digest)).toContain("Open Conditional Access in Entra")
  })
})

describe("Teams card layouts", () => {
  const changes = fixture.events.map((event) => mapAuditEvent(event as AuditEventRaw)!)
  const digest = intuneChangeDigest({ tenantId: TENANT, tenantName: "Contoso](https://evil.example)", changes, includeActor: true, source: "desktop" })
  type Block = { type: string; text?: string; items?: Block[]; facts?: Array<{ title: string }>; style?: string }
  const blocks = (style = DEFAULT_CARD_STYLE) => (cardOf(teamsWorkflowsPayload(digest, style)).body as Block[])
  const texts = (style = DEFAULT_CARD_STYLE) => JSON.stringify(blocks(style))

  it("the default layout is the standard card", () => {
    expect(canonicalJson(teamsWorkflowsPayload(digest, DEFAULT_CARD_STYLE))).toBe(canonicalJson(teamsWorkflowsPayload(digest)))
    expect(parseCardStyle({})).toEqual(DEFAULT_CARD_STYLE)
    expect(isDefaultLayout(parseCardLayout(undefined))).toBe(true)
  })

  it("orders, hides and limits blocks", () => {
    const style = parseCardStyle({ order: ["footer", "items", "summary", "details", "note"], hidden: ["details", "button"], maxItems: 3 })
    const kinds = blocks(style).map((block) => block.type)
    expect(kinds[0]).toBe("Container")
    expect(blocks(style).some((block) => block.type === "FactSet")).toBe(false)
    expect(blocks(style)[1]!.text).toContain("TenuVault desktop")
    expect(cardOf(teamsWorkflowsPayload(digest, style)).actions).toBeUndefined()
  })

  it("keeps tenant text out of links and formatting whatever the layout says", () => {
    const style = parseCardStyle({ titlePrefix: "{tenant} ", summaryText: "[click]({tenant})", noteText: "{title}", hidden: [], buttonLabel: "{tenant}", buttonDestination: "auto" })
    const card = cardOf(teamsWorkflowsPayload(digest, style)) as { actions: Array<{ url: string; title: string }> }
    expect(card.actions[0]!.url).toBe("https://intune.microsoft.com")
    expect(texts(style)).not.toContain("](https://evil.example)")
    expect(blocks(style)[1]!.text).toBe(String.raw`\[click\]\(Contoso\]\(https://evil\.example\)\)`)
  })

  it("fills known placeholders and leaves unknown ones, which block saving", () => {
    expect(fillPlaceholders("{tenant}: {count} at {occurredAt} {nope}", digest)).toBe("Contoso](https://evil.example): 2 at 2026-10-17 10:02 UTC {nope}")
    expect(styleIssues(parseCardStyle({ noteText: "Call {oncall}" }))).toEqual([{ field: "noteText", message: expect.stringContaining("{oncall}") }])
    expect(styleIssues(DEFAULT_CARD_STYLE)).toEqual([])
  })

  it("repairs damaged layouts instead of failing", () => {
    const style = parseCardStyle({ order: ["items", "items", "bogus"], hidden: "note", maxItems: 7, severityStyle: "loud", itemDetail: "yes", titlePrefix: "\u0007 x".repeat(30) })
    expect(style.order).toEqual(["items", "summary", "details", "note", "footer"])
    expect(style.hidden).toEqual(["note"])
    expect(style.maxItems).toBe(20)
    expect(style.severityStyle).toBe("both")
    expect(style.itemDetail).toBe(true)
    expect(style.titlePrefix.length).toBeLessThanOrEqual(40)
  })

  it("uses a group's override for its event types only", () => {
    const layout = parseCardLayout({ base: { density: "compact" }, overrides: { changes: { maxItems: 5 }, bogus: { maxItems: 3 } } })
    expect(Object.keys(layout.overrides)).toEqual(["changes"])
    expect(styleFor(layout, "intune.change").maxItems).toBe(5)
    expect(styleFor(layout, "entra.change").maxItems).toBe(5)
    expect(styleFor(layout, "backup.failed")).toMatchObject({ density: "compact", maxItems: 20 })
    expect(styleFor(layout, "test").density).toBe("compact")
    expect(styleFor(null, "test")).toEqual(DEFAULT_CARD_LAYOUT.base)
  })

  it("shows the note only at or above its severity", () => {
    const style = parseCardStyle({ hidden: [], noteText: "Call ext. 4411", noteMinSeverity: "critical" })
    expect(texts(style)).not.toContain("4411")
    expect(JSON.stringify(cardOf(teamsWorkflowsPayload({ ...digest, severity: "critical" }, style)))).toContain("4411")
  })
})

describe("Teams message size", () => {
  const big = (count: number) => buildEnvelope({
    type: "intune.change", severity: "warning", tenantId: TENANT, tenantName: "Contoso", occurredAt: "2026-11-05T08:42:00.000Z", naturalKey: `big-${count}`,
    title: "Intune changes: Contoso", summary: "Many changes.",
    details: [{ label: "Changes", value: String(count) }],
    items: Array.from({ length: count }, (_, index) => ({ title: `Updated: ${"Policy name ".repeat(24)}${index}`, detail: "Settings catalog ".repeat(17), actor: `admin${index}@contoso.com`, at: "2026-11-05T08:42:00.000Z" })),
    moreCount: 0, source: "desktop",
  })

  it("leaves cards that fit untouched", () => {
    const small = big(3)
    expect(fitTeamsPayload(small).shortened).toBe(false)
    expect(teamsPayloadBytes(teamsWorkflowsPayload(small))).toBeLessThan(TEAMS_MESSAGE_BUDGET_BYTES)
  })

  it("drops a note that expands past the limit on its own, as the last step", () => {
    const envelope = buildEnvelope({ type: "test", severity: "info", tenantId: TENANT, occurredAt: "2026-11-05T08:42:00.000Z", naturalKey: "note", title: ".".repeat(200), summary: "Test.", source: "desktop" })
    const style = parseCardStyle({ hidden: [], noteText: "{title}".repeat(42), noteMinSeverity: "info" })
    const { payload, shortened } = fitTeamsPayload(envelope, style)
    expect(shortened).toBe(true)
    expect(teamsPayloadBytes(payload)).toBeLessThanOrEqual(TEAMS_MESSAGE_BUDGET_BYTES)
    expect(JSON.stringify(payload)).not.toContain('"style":"emphasis","items"')
  })

  it("drops change lines into And N more until the card fits", () => {
    const envelope = big(20)
    const { payload, shortened } = fitTeamsPayload(envelope)
    expect(shortened).toBe(true)
    expect(teamsPayloadBytes(payload)).toBeLessThanOrEqual(TEAMS_MESSAGE_BUDGET_BYTES)
    const texts = (cardOf(payload).body as Array<{ text?: string }>).map((block) => block.text ?? "")
    const lines = texts.filter((text) => text.startsWith("•")).length
    expect(lines).toBeLessThan(20)
    expect(texts).toContain(`And ${20 - lines} more. Open TenuVault for the full list.`)
    // The header, summary and details stay.
    expect(JSON.stringify((cardOf(payload).body as unknown[])[0])).toContain("Intune changes: Contoso")
  })
})
