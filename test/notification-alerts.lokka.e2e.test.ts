import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { routes } from "../src/main/features/notifications"
import { DOMAINS } from "../src/main/features/domains"
import { pollAuditWatch, saveAuditWatch } from "../src/main/features/notifications/service"
import { canonicalJson } from "../src/shared/notifications/envelope"
import { call, fakeDeps, TENANT_A } from "./feature-helpers"

/**
 * Replays Intune and Entra audit pages observed in a lab tenant through Lokka (Graph
 * responses as returned, permission lists may be stripped) through the real desktop poller
 * with real alerts, and through the Azure watcher runbook with the same alerts copied for
 * it. Both must plan the same envelopes. What each channel would receive is written to
 * TENUVAULT_ALERTS_OUT when set, for review.
 *
 *   TENUVAULT_LOKKA_AUDIT=observed.json [TENUVAULT_ALERTS_OUT=dir] npm run test:e2e -- notification-alerts
 *
 * observed.json: { "observedAt": "...", "intune": { "value": [...] }, "entra": { "value": [...] } }
 */
const file = process.env.TENUVAULT_LOKKA_AUDIT
const out = process.env.TENUVAULT_ALERTS_OUT
const pwsh = ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh", ...(process.env.HOME ? [`${process.env.HOME}/.local/bin/pwsh`] : [])].find((candidate) => existsSync(candidate))
const PATH = "/api/notifications"

describe.skipIf(!file)("Lokka lab audit replay through alerts", () => {
  it("sends the alerts the observed changes call for, the same from the desktop and the watcher", async () => {
    const live = JSON.parse(readFileSync(file!, "utf8")) as { observedAt: string; intune: { value: unknown[] }; entra: { value: unknown[] } }
    const posts: Array<{ url: string; body: string }> = []
    const mails: Array<{ subject: string; html: string; to: string[] }> = []
    const deps = fakeDeps({
      plans: { [TENANT_A]: "pro" },
      now: () => new Date(live.observedAt),
      externalFetch: (async (url: string, init: RequestInit) => {
        posts.push({ url, body: String(init.body) })
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch,
      graph: () => async (method: string, path: string, body?: unknown) => {
        if (method === "GET" && path.startsWith("deviceManagement/auditEvents")) return { status: 200, body: live.intune as never }
        if (method === "GET" && path.startsWith("auditLogs/directoryAudits")) return { status: 200, body: live.entra as never }
        if (method === "POST" && path === "me/sendMail") {
          const message = (body as { message: { subject: string; body: { content: string }; toRecipients: Array<{ emailAddress: { address: string } }> } }).message
          mails.push({ subject: message.subject, html: message.body.content, to: message.toRecipients.map((entry) => entry.emailAddress.address) })
          return { status: 202, body: {} }
        }
        return { status: 404, body: {} }
      },
    })
    const api = routes(deps)
    const channel = async (body: Record<string, unknown>) => (await call(api, PATH, { tenantId: TENANT_A, action: "add-channel", ...body })).body.channel.id as string
    const webhook = await channel({ kind: "webhook", title: "Automation", url: "https://hooks.example.test/tenuvault" })
    const teams = await channel({ kind: "teams", title: "IT Ops", url: "https://contoso.webhook.office.com/workflows/alerts" })
    const email = await channel({ kind: "email", title: "Security team", recipients: [{ type: "address", address: "security@contoso.test" }] })
    const alert = async (body: Record<string, unknown>) => {
      const created = await call(api, PATH, { tenantId: TENANT_A, action: "add-rule", minSeverity: "info", ...body })
      expect(created.status).toBe(200)
    }
    await alert({ title: "Compliance policy changes", eventTypes: ["intune.change"], channelIds: [email, webhook], delivery: "each", conditions: { categories: ["Compliance"], changeTypes: ["updated", "deleted"] } })
    await alert({ title: "All Intune changes", eventTypes: ["intune.change"], channelIds: [teams] })
    await alert({ title: "Conditional Access grant changes", eventTypes: ["entra.change"], channelIds: [teams, email], delivery: "each", conditions: { settingNames: ["grantControls", "state"] } })
    saveAuditWatch(deps, TENANT_A, { enabled: true, ignoreOwnChanges: false, conditionalAccess: { enabled: true, watermark: null, recent: [], continuation: null, lastPollAt: null, lastError: null } }, { actor: null, reason: "replay" })
    const result = await pollAuditWatch(deps, TENANT_A)
    expect(result.error).toBeNull()

    const exported = await call(api, PATH, { tenantId: TENANT_A, action: "export-watcher-alerts" })
    if (out) mkdirSync(out, { recursive: true })
    const desktopEnvelopes = posts.filter((post) => post.url.includes("hooks.example")).map((post) => JSON.parse(post.body))
    const desktopTeams = posts.filter((post) => post.url.includes("office.com")).map((post) => JSON.parse(post.body))

    // Nothing a channel receives may carry a setting value from the observed events.
    const everything = JSON.stringify({ posts, mails })
    for (const value of ["5026-07-07", "5026-06-20", "enabledForReportingButNotEnforced"]) expect(everything).not.toContain(value)

    if (pwsh) {
      const runbook = fileURLToPath(new URL("../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1", import.meta.url))
      const script = [
        `. '${runbook}' -LibraryOnly`,
        `$live = Get-Content -Raw '${file}' | ConvertFrom-Json`,
        `$alerts = ConvertFrom-TvWatcherAlerts ([Console]::In.ReadToEnd())`,
        `$intune = @($live.intune.value | ForEach-Object { ConvertFrom-TenuVaultAuditEvent $_ } | Where-Object { $_ })`,
        `$entra = @($live.entra.value | ForEach-Object { ConvertFrom-TenuVaultEntraAuditEvent $_ } | Where-Object { $_ })`,
        `$rows = [System.Collections.Generic.List[object]]::new()`,
        `if ($intune.Count) { foreach ($p in (Get-TvChangeAlertPlan -Service intune -Changes $intune -Alerts $alerts -TenantId '${TENANT_A}' -TenantName 'Tenant 1111')) { $rows.Add($p.envelope) } }`,
        `if ($entra.Count) { foreach ($p in (Get-TvChangeAlertPlan -Service conditionalAccess -Changes $entra -Alerts $alerts -TenantId '${TENANT_A}' -TenantName 'Tenant 1111')) { $rows.Add($p.envelope) } }`,
        `ConvertTo-TenuVaultCanonicalJson @($rows.ToArray())`,
      ].join("\n")
      const watcher = JSON.parse(execFileSync(pwsh, ["-NoProfile", "-Command", script], { input: exported.body.json, encoding: "utf8" })) as Array<{ eventId: string; source: string }>
      // Same events, same content; only the source differs.
      const outbox = deps.records.list<{ envelope: { eventId: string } }>(DOMAINS.notificationOutbox, TENANT_A)
      const desktopIds = [...new Set(outbox.map((entry) => entry.envelope.eventId))].sort()
      expect(watcher.map((envelope) => envelope.eventId).sort()).toEqual(desktopIds)
      for (const envelope of watcher) {
        const desktop = outbox.find((entry) => entry.envelope.eventId === envelope.eventId)!.envelope
        expect(canonicalJson({ ...envelope, source: "desktop" })).toBe(canonicalJson(desktop))
      }
      if (out) writeFileSync(join(out, "watcher-envelopes.json"), JSON.stringify(watcher, null, 2))
    }

    if (out) {
      writeFileSync(join(out, "summary.json"), JSON.stringify({ poll: result, webhook: desktopEnvelopes.map((envelope) => ({ title: envelope.title, items: envelope.items })), teams: desktopTeams.length, mails: mails.map((mail) => mail.subject), watcherAlerts: exported.body.document }, null, 2))
      writeFileSync(join(out, "webhook.json"), JSON.stringify(desktopEnvelopes, null, 2))
      writeFileSync(join(out, "teams.json"), JSON.stringify(desktopTeams, null, 2))
      mails.forEach((mail, index) => writeFileSync(join(out, `mail-${index + 1}.html`), `<!doctype html><meta charset="utf-8"><title>${mail.subject.replace(/</g, "&lt;")}</title>${mail.html}`))
    }
    expect(mails.length + posts.length).toBeGreaterThan(0)
  })
})
