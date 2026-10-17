/**
 * Rendering of one envelope per channel kind. Every tenant controlled string is escaped
 * for its target format, and no link is ever derived from tenant data, so a hostile
 * policy name cannot turn an alert into a phishing message.
 */
import type { NotificationEnvelope } from "./envelope"

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

const SEVERITY_STYLE: Record<NotificationEnvelope["severity"], string> = { info: "default", warning: "warning", critical: "attention" }

/** Adaptive Card TextBlocks render a Markdown subset; tenant text must stay literal. */
export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+-.!>])/g, "\\$1")
}

function footer(envelope: NotificationEnvelope): string {
  const where = envelope.source === "azure-watcher" ? "Azure watcher" : "TenuVault desktop"
  return `${where} · ${envelope.occurredAt} · Event ${envelope.eventId.slice(0, 12)}`
}

/** The local system notification text. Tenant data stays in the title only. */
export function localText(envelope: NotificationEnvelope): { title: string; body: string } {
  return { title: envelope.title, body: envelope.summary }
}

/** The Teams Workflows payload: a message with one Adaptive Card attachment. */
export function teamsWorkflowsPayload(envelope: NotificationEnvelope): Record<string, unknown> {
  const facts = envelope.details.map((entry) => ({ title: escapeMarkdown(entry.label), value: escapeMarkdown(entry.value) }))
  const body: Array<Record<string, unknown>> = [
    { type: "TextBlock", size: "Medium", weight: "Bolder", text: escapeMarkdown(envelope.title), wrap: true, style: SEVERITY_STYLE[envelope.severity] },
    { type: "TextBlock", text: escapeMarkdown(envelope.summary), wrap: true },
  ]
  if (facts.length) body.push({ type: "FactSet", facts })
  for (const item of envelope.items) {
    body.push({ type: "TextBlock", text: escapeMarkdown(itemLine(item)), wrap: true, spacing: "Small" })
  }
  if (envelope.moreCount > 0) body.push({ type: "TextBlock", text: `And ${envelope.moreCount} more. Open TenuVault for the full list.`, wrap: true, isSubtle: true })
  body.push({ type: "TextBlock", text: escapeMarkdown(footer(envelope)), wrap: true, isSubtle: true, size: "Small" })
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body },
      },
    ],
  }
}

function itemLine(item: NotificationEnvelope["items"][number]): string {
  const parts = [`• ${item.title}`]
  if (item.detail) parts.push(item.detail)
  if (item.actor) parts.push(`by ${item.actor}`)
  if (item.at) parts.push(item.at)
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

export function emailHtml(envelope: NotificationEnvelope): string {
  const color = envelope.severity === "critical" ? "#b42318" : envelope.severity === "warning" ? "#b54708" : "#175cd3"
  const details = envelope.details.map((entry) => `<tr><td style="padding:4px 12px 4px 0;color:#475467">${escapeHtml(entry.label)}</td><td style="padding:4px 0">${escapeHtml(entry.value)}</td></tr>`).join("")
  const items = envelope.items.map((item) => `<li style="margin:4px 0">${escapeHtml(itemLine(item))}</li>`).join("")
  return [
    `<div style="font-family:Segoe UI,Arial,sans-serif;color:#101828;max-width:640px">`,
    `<h2 style="color:${color};font-size:18px;margin:0 0 8px">${escapeHtml(envelope.title)}</h2>`,
    `<p style="margin:0 0 12px">${escapeHtml(envelope.summary)}</p>`,
    details ? `<table style="border-collapse:collapse;margin:0 0 12px">${details}</table>` : "",
    items ? `<ul style="margin:0 0 12px;padding-left:20px">${items}</ul>` : "",
    envelope.moreCount > 0 ? `<p style="color:#475467">And ${envelope.moreCount} more. Open TenuVault for the full list.</p>` : "",
    `<p style="color:#98a2b3;font-size:12px;border-top:1px solid #eaecf0;padding-top:8px">${escapeHtml(footer(envelope))}</p>`,
    `</div>`,
  ].join("")
}
