/**
 * Rendering of one envelope per channel kind. Every tenant controlled string is escaped
 * for its target format, and no link is ever derived from tenant data, so a hostile
 * policy name cannot turn an alert into a phishing message.
 */
import { SEVERITY_RANK, type NotificationEnvelope } from "./envelope"
import { BUTTON_TARGETS, DEFAULT_CARD_STYLE, type CardAccent, type CardStyle } from "./layout"

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

/**
 * Adaptive Card severity styling. TextBlock has no severity style, so the header sits in a
 * Container with a named container style, and a small label carries a named text color.
 */
const SEVERITY_CARD: Record<NotificationEnvelope["severity"], { container: string; color: string; label: string }> = {
  info: { container: "emphasis", color: "Accent", label: "Info" },
  warning: { container: "warning", color: "Warning", label: "Warning" },
  critical: { container: "attention", color: "Attention", label: "Critical" },
}

/** Adaptive Card TextBlocks render a Markdown subset; tenant text must stay literal. */
export function escapeMarkdown(value: string): string {
  // The hyphen is escaped inside the class: unescaped, "+-." is a range that also matches commas.
  return value.replace(/([\\`*_{}[\]()#+\-.!>])/g, "\\$1")
}

function footer(envelope: NotificationEnvelope): string {
  const where = envelope.source === "azure-watcher" ? "Azure watcher" : "TenuVault desktop"
  return `${where} · ${friendlyTime(envelope.occurredAt)} · Event ${envelope.eventId.slice(0, 12)}`
}

/** The local system notification text. Tenant data stays in the title only. */
export function localText(envelope: NotificationEnvelope): { title: string; body: string } {
  return { title: envelope.title, body: envelope.summary }
}

const ACCENT_CONTAINER: Record<Exclude<CardAccent, "severity">, string> = { accent: "accent", emphasis: "emphasis", good: "good" }

/** Fills {tenant}, {title}, {severity}, {eventType}, {count} and {occurredAt}. Unknown names stay as written. */
export function fillPlaceholders(text: string, envelope: NotificationEnvelope, timeFormat: CardStyle["timeFormat"] = "friendly"): string {
  const values: Record<string, string> = {
    tenant: envelope.tenant.name ?? envelope.tenant.id,
    title: envelope.title,
    severity: SEVERITY_CARD[envelope.severity].label,
    eventType: envelope.type,
    count: String(envelope.items.length + envelope.moreCount),
    occurredAt: timeFormat === "iso" ? envelope.occurredAt : friendlyTime(envelope.occurredAt),
  }
  return text.replace(/\{([A-Za-z]+)\}/g, (match, name: string) => values[name] ?? match)
}

/** The fixed button an event gets with this style, or null. Never built from tenant data. */
export function cardButton(envelope: NotificationEnvelope, style: CardStyle): { href: string; label: string } | null {
  if (style.hidden.includes("button")) return null
  const target = style.buttonDestination === "auto" ? actionLink(envelope) : BUTTON_TARGETS[style.buttonDestination]
  if (!target) return null
  return { href: target.href, label: style.buttonLabel ? fillPlaceholders(style.buttonLabel, envelope, style.timeFormat) : target.label }
}

/**
 * The Teams Workflows payload: a message with one Adaptive Card attachment, built from a card
 * style (the default reproduces the standard card). The runbook's New-TvTeamsPayload builds
 * the same JSON from the same style; test/notification-watcher-script.test.ts compares them.
 */
export function teamsWorkflowsPayload(envelope: NotificationEnvelope, style: CardStyle = DEFAULT_CARD_STYLE): Record<string, unknown> {
  const severity = SEVERITY_CARD[envelope.severity]
  const time = (iso: string) => (style.timeFormat === "iso" ? iso : friendlyTime(iso))
  const compact = style.density === "compact"
  const headerItems: Array<Record<string, unknown>> = []
  if (style.severityStyle !== "tint") headerItems.push({ type: "TextBlock", size: "Small", weight: "Bolder", color: severity.color, text: severity.label, wrap: true })
  // Prefixes are stored trimmed, so the space before the title is added here.
  const prefix = fillPlaceholders(style.titlePrefix, envelope, style.timeFormat)
  headerItems.push({ type: "TextBlock", size: "Medium", weight: "Bolder", text: escapeMarkdown(prefix ? `${prefix} ${envelope.title}` : envelope.title), wrap: true, spacing: "None" })
  const containerStyle = style.accent !== "severity" ? ACCENT_CONTAINER[style.accent] : style.severityStyle === "label" ? "default" : severity.container
  const body: Array<Record<string, unknown>> = [{ type: "Container", style: containerStyle, bleed: true, items: headerItems }]
  for (const block of style.order) {
    if (style.hidden.includes(block)) continue
    if (block === "summary") {
      const text = style.summaryText ? fillPlaceholders(style.summaryText, envelope, style.timeFormat) : envelope.summary
      body.push({ type: "TextBlock", text: escapeMarkdown(text), wrap: true, ...(compact ? { spacing: "Small" } : {}) })
    } else if (block === "details") {
      const facts = envelope.details.filter((entry) => !style.hiddenDetails.includes(entry.label)).map((entry) => ({ title: escapeMarkdown(entry.label), value: escapeMarkdown(entry.value) }))
      if (facts.length) body.push({ type: "FactSet", facts, ...(compact ? { spacing: "Small" } : {}) })
    } else if (block === "items") {
      const shown = envelope.items.slice(0, style.maxItems)
      for (const item of shown) {
        const meta = [style.itemDetail ? item.detail : undefined, style.itemActor && item.actor ? `by ${item.actor}` : undefined, style.itemTime && item.at ? time(item.at) : undefined].filter((part): part is string => Boolean(part))
        if (style.itemStyle === "stacked") {
          body.push({ type: "TextBlock", text: escapeMarkdown(item.title), wrap: true, weight: "Bolder", spacing: compact ? "Small" : "Medium" })
          if (meta.length) body.push({ type: "TextBlock", text: escapeMarkdown(meta.join(" · ")), wrap: true, isSubtle: true, size: "Small", spacing: "None" })
        } else {
          body.push({ type: "TextBlock", text: escapeMarkdown([`• ${item.title}`, ...meta].join(" · ")), wrap: true, spacing: compact ? "None" : "Small" })
        }
      }
      const more = envelope.moreCount + (envelope.items.length - shown.length)
      if (more > 0) body.push({ type: "TextBlock", text: `And ${more} more. Open TenuVault for the full list.`, wrap: true, isSubtle: true })
    } else if (block === "note") {
      if (style.noteText && SEVERITY_RANK[envelope.severity] >= SEVERITY_RANK[style.noteMinSeverity]) {
        body.push({ type: "Container", style: "emphasis", items: [{ type: "TextBlock", text: escapeMarkdown(fillPlaceholders(style.noteText, envelope, style.timeFormat)), wrap: true }] })
      }
    } else if (block === "footer") {
      const parts = [
        style.footerSource ? (envelope.source === "azure-watcher" ? "Azure watcher" : "TenuVault desktop") : null,
        style.footerTime ? time(envelope.occurredAt) : null,
        style.footerEventId ? `Event ${envelope.eventId.slice(0, 12)}` : null,
      ].filter((part): part is string => part !== null)
      if (parts.length) body.push({ type: "TextBlock", text: escapeMarkdown(parts.join(" · ")), wrap: true, isSubtle: true, size: "Small" })
    }
  }
  const button = cardButton(envelope, style)
  const actions = button ? [{ type: "Action.OpenUrl", title: button.label, url: button.href }] : []
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body, ...(actions.length ? { actions } : {}) },
      },
    ],
  }
}

/** The Adaptive Card inside a Workflows payload. */
export function cardOf(payload: Record<string, unknown>): Record<string, unknown> {
  return ((payload.attachments as Array<{ content: Record<string, unknown> }>)[0]!).content
}

function itemLine(item: NotificationEnvelope["items"][number]): string {
  const parts = [`• ${item.title}`]
  if (item.detail) parts.push(item.detail)
  if (item.actor) parts.push(`by ${item.actor}`)
  if (item.at) parts.push(friendlyTime(item.at))
  return parts.join(" · ")
}

export function emailSubject(envelope: NotificationEnvelope): string {
  const prefix = envelope.severity === "critical" ? "[Critical] " : envelope.severity === "warning" ? "[Warning] " : ""
  return `TenuVault: ${prefix}${envelope.title}`.slice(0, 250)
}

export function emailText(envelope: NotificationEnvelope): string {
  const lines = [envelope.title, "", envelope.summary, ""]
  for (const entry of envelope.details) lines.push(`${entry.label}: ${entry.value}`)
  if (envelope.items.length) {
    lines.push("")
    for (const item of envelope.items) lines.push(itemLine(item))
  }
  if (envelope.moreCount > 0) lines.push(`And ${envelope.moreCount} more. Open TenuVault for the full list.`)
  lines.push("", footer(envelope))
  return lines.join("\n")
}

/** "2026-10-17T18:54:26.033Z" as "2026-10-17 18:54 UTC"; unparsable values pass through unchanged. */
export function friendlyTime(iso: string): string {
  // Offsetless timestamps are read as UTC, never as machine-local time, so the
  // desktop and the PowerShell watcher render the same text for the same input.
  const normalized = /T\d{2}:\d{2}/.test(iso) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso.trim()) ? `${iso.trim()}Z` : iso
  const at = new Date(normalized)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
}

const SEVERITY_BADGE: Record<NotificationEnvelope["severity"], { label: string; color: string; background: string; bar: string }> = {
  info: { label: "Info", color: "#175cd3", background: "#eff4ff", bar: "#2e90fa" },
  warning: { label: "Warning", color: "#b54708", background: "#fffaeb", bar: "#f79009" },
  critical: { label: "Critical", color: "#b42318", background: "#fef3f2", bar: "#f04438" },
}

const VERB_STYLE: Record<string, { color: string; background: string }> = {
  Created: { color: "#067647", background: "#ecfdf3" },
  Updated: { color: "#175cd3", background: "#eff4ff" },
  Changed: { color: "#175cd3", background: "#eff4ff" },
  Assigned: { color: "#6941c6", background: "#f4f3ff" },
  Unassigned: { color: "#b54708", background: "#fffaeb" },
  Deleted: { color: "#b42318", background: "#fef3f2" },
}

/** The Conditional Access policy list in the Entra admin center. */
export const ENTRA_CONDITIONAL_ACCESS = BUTTON_TARGETS.entra.href

/** Fixed Microsoft destinations per event type. Never built from tenant data. */
export function actionLink(envelope: NotificationEnvelope): { href: string; label: string } | null {
  if (envelope.type === "intune.change") return BUTTON_TARGETS.intune
  if (envelope.type === "entra.change") return BUTTON_TARGETS.entra
  return null
}

function itemHtml(item: NotificationEnvelope["items"][number]): string {
  const verb = item.title.split(":")[0]?.trim() ?? ""
  const style = VERB_STYLE[verb]
  const chip = style
    ? `<span style="display:inline-block;padding:1px 8px;border-radius:999px;background:${style.background};color:${style.color};font-size:12px;font-weight:600;margin-right:8px">${escapeHtml(verb)}</span>`
    : ""
  const title = style ? item.title.slice(item.title.indexOf(":") + 1).trim() : item.title
  const meta = [item.detail, item.actor ? `by ${item.actor}` : null, item.at ? friendlyTime(item.at) : null].filter(Boolean).join(" · ")
  return [
    `<tr><td style="padding:10px 16px;border-top:1px solid #eaecf0">`,
    `<div style="font-size:14px;line-height:20px">${chip}<span style="font-weight:600">${escapeHtml(title)}</span></div>`,
    meta ? `<div style="font-size:12px;line-height:18px;color:#475467;margin-top:2px">${escapeHtml(meta)}</div>` : "",
    `</td></tr>`,
  ].join("")
}

export function emailHtml(envelope: NotificationEnvelope): string {
  const badge = SEVERITY_BADGE[envelope.severity]
  const where = envelope.source === "azure-watcher" ? "Azure watcher" : "TenuVault desktop"
  const tenant = envelope.tenant?.name ?? envelope.tenant?.id ?? ""
  const details = envelope.details
    .map((entry) => `<tr><td style="padding:5px 16px 5px 0;color:#475467;font-size:13px;white-space:nowrap;vertical-align:top">${escapeHtml(entry.label)}</td><td style="padding:5px 0;font-size:13px">${escapeHtml(entry.value)}</td></tr>`)
    .join("")
  const items = envelope.items.map(itemHtml).join("")
  const action = actionLink(envelope)
  return [
    `<div style="margin:0;padding:24px 12px;background:#f6f7f9;font-family:'Segoe UI',SegoeUI,Arial,sans-serif;color:#101828">`,
    `<table role="presentation" width="640" align="center" cellspacing="0" cellpadding="0" style="width:640px;max-width:100%;margin:0 auto;background:#ffffff;border:1px solid #e4e7ec;border-radius:8px;border-collapse:separate;overflow:hidden">`,
    `<tr><td style="height:3px;background:${badge.bar};font-size:0;line-height:0">&nbsp;</td></tr>`,
    `<tr><td style="padding:20px 24px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>`,
    `<td style="font-size:12px;font-weight:600;letter-spacing:2px;color:#667085">TENUVAULT</td>`,
    `<td align="right"><span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${badge.background};color:${badge.color};font-size:12px;font-weight:600">${badge.label}</span></td>`,
    `</tr></table></td></tr>`,
    `<tr><td style="padding:14px 24px 0"><div style="font-size:20px;line-height:28px;font-weight:600">${escapeHtml(envelope.title)}</div>`,
    `<div style="font-size:14px;line-height:21px;color:#344054;margin-top:6px">${escapeHtml(envelope.summary)}</div></td></tr>`,
    tenant ? `<tr><td style="padding:14px 24px 0"><div style="font-size:12px;color:#667085">Tenant&nbsp;&nbsp;<span style="color:#101828;font-size:13px">${escapeHtml(tenant)}</span></div></td></tr>` : "",
    details ? `<tr><td style="padding:10px 24px 4px"><table role="presentation" cellspacing="0" cellpadding="0">${details}</table></td></tr>` : "",
    items ? `<tr><td style="padding:12px 8px 4px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${items}</table></td></tr>` : "",
    envelope.moreCount > 0 ? `<tr><td style="padding:8px 24px 0;font-size:13px;color:#475467">And ${envelope.moreCount} more. Open TenuVault for the full list.</td></tr>` : "",
    action ? `<tr><td style="padding:18px 24px 4px"><a href="${action.href}" style="display:inline-block;padding:9px 16px;border-radius:6px;background:#175cd3;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none">${action.label}</a></td></tr>` : "",
    `<tr><td style="padding:18px 24px 20px"><div style="border-top:1px solid #eaecf0;padding-top:12px;font-size:12px;line-height:18px;color:#98a2b3">${escapeHtml(where)} · ${escapeHtml(friendlyTime(envelope.occurredAt))} · Event ${escapeHtml(envelope.eventId.slice(0, 12))}</div></td></tr>`,
    `</table></div>`,
  ].join("")
}
