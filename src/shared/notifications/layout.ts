/**
 * The Teams card layout: plain settings, never card JSON. The desktop app and the Azure
 * watcher both build the Adaptive Card from these settings (teamsWorkflowsPayload in
 * render.ts and New-TvTeamsPayload in the runbook), so a layout looks the same whoever sends.
 *
 * Safety rules the builder enforces whatever the layout says: tenant text is always escaped
 * plain text, no tenant value ever becomes part of a link, buttons only open the fixed
 * Microsoft destinations below, and the card stays at Adaptive Card 1.4.
 */
import type { NotificationEventType, NotificationSeverity } from "./envelope"

/** Blocks that can be reordered. The header is always first and buttons sit at the bottom of a card. */
export const MOVABLE_BLOCKS = ["summary", "details", "items", "note", "footer"] as const
export type MovableBlock = (typeof MOVABLE_BLOCKS)[number]
/** Blocks that can be hidden. The header always shows. */
export const HIDEABLE_BLOCKS = ["summary", "details", "items", "note", "footer", "button"] as const
export type HideableBlock = (typeof HIDEABLE_BLOCKS)[number]

export type SeverityStyle = "both" | "tint" | "label"
export type CardAccent = "severity" | "accent" | "emphasis" | "good"
export type ButtonDestination = "auto" | "intune" | "entra"
export type ItemStyle = "line" | "stacked"
export type Density = "comfortable" | "compact"
export type TimeFormat = "friendly" | "iso"

export interface CardStyle {
  order: MovableBlock[]
  hidden: HideableBlock[]
  severityStyle: SeverityStyle
  accent: CardAccent
  /** Put before the title, for example "[Production] ". Placeholders allowed. */
  titlePrefix: string
  /** Replaces the generated summary when set. Placeholders allowed. */
  summaryText: string
  /** Detail rows to leave out, by label. */
  hiddenDetails: string[]
  maxItems: 3 | 5 | 10 | 20
  itemStyle: ItemStyle
  itemDetail: boolean
  itemActor: boolean
  itemTime: boolean
  /** A fixed note, for example who to call. Placeholders allowed. */
  noteText: string
  noteMinSeverity: NotificationSeverity
  buttonDestination: ButtonDestination
  /** Replaces the button's default label when set. */
  buttonLabel: string
  footerSource: boolean
  footerTime: boolean
  footerEventId: boolean
  density: Density
  timeFormat: TimeFormat
}

/** Event types grouped for per type layouts. Types outside every group use the base layout. */
export const EVENT_GROUPS = {
  backups: ["backup.failed", "backup.warning", "backup.succeeded", "backup.missed"],
  restores: ["restore.completed", "restore.partial", "restore.failed"],
  drift: ["drift.detected"],
  changes: ["intune.change", "entra.change"],
  alerts: ["credential.expiring", "watcher.stale", "health.finding"],
} as const satisfies Record<string, readonly NotificationEventType[]>

export type EventGroup = keyof typeof EVENT_GROUPS
export const EVENT_GROUP_IDS = Object.keys(EVENT_GROUPS) as EventGroup[]

export interface CardLayout {
  version: 1
  base: CardStyle
  overrides: Partial<Record<EventGroup, CardStyle>>
}

export const DEFAULT_CARD_STYLE: CardStyle = {
  order: ["summary", "details", "items", "note", "footer"],
  hidden: ["note"],
  severityStyle: "both",
  accent: "severity",
  titlePrefix: "",
  summaryText: "",
  hiddenDetails: [],
  maxItems: 20,
  itemStyle: "line",
  itemDetail: true,
  itemActor: true,
  itemTime: true,
  noteText: "",
  noteMinSeverity: "warning",
  buttonDestination: "auto",
  buttonLabel: "",
  footerSource: true,
  footerTime: true,
  footerEventId: true,
  density: "comfortable",
  timeFormat: "friendly",
}

export const DEFAULT_CARD_LAYOUT: CardLayout = { version: 1, base: DEFAULT_CARD_STYLE, overrides: {} }

export const PLACEHOLDERS = ["tenant", "title", "severity", "eventType", "count", "occurredAt"] as const
export type Placeholder = (typeof PLACEHOLDERS)[number]

export const TEXT_LIMITS = { titlePrefix: 40, summaryText: 300, noteText: 300, buttonLabel: 40 } as const

/** Fixed Microsoft destinations a button may open. Never built from tenant data. */
export const BUTTON_TARGETS = {
  intune: { href: "https://intune.microsoft.com", label: "Open the Intune admin center" },
  entra: { href: "https://entra.microsoft.com/#view/Microsoft_AAD_ConditionalAccess/ConditionalAccessBlade/~/Policies", label: "Open Conditional Access in Entra" },
} as const

export function groupOf(type: NotificationEventType): EventGroup | null {
  for (const group of EVENT_GROUP_IDS) if ((EVENT_GROUPS[group] as readonly string[]).includes(type)) return group
  return null
}

/** The style an event uses: its group's override, else the base layout. */
export function styleFor(layout: CardLayout | null | undefined, type: NotificationEventType): CardStyle {
  if (!layout) return DEFAULT_CARD_STYLE
  const group = groupOf(type)
  return (group && layout.overrides[group]) || layout.base
}

/** Placeholder names a text uses that are not known, for validation messages. */
export function unknownPlaceholders(text: string): string[] {
  const found = [...text.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]!)
  return [...new Set(found.filter((name) => !(PLACEHOLDERS as readonly string[]).includes(name)))]
}

export function sameStyle(a: CardStyle, b: CardStyle): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback)
const flag = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback)
// Control characters are dropped: these texts are rendered into cards.
// oxlint-disable-next-line no-control-regex
const cleanText = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "")

export interface StyleIssue {
  field: keyof CardStyle
  message: string
}

/** Issues that block saving: unknown placeholders in the free texts. */
export function styleIssues(style: CardStyle): StyleIssue[] {
  const issues: StyleIssue[] = []
  for (const field of ["titlePrefix", "summaryText", "noteText", "buttonLabel"] as const) {
    const unknown = unknownPlaceholders(style[field])
    if (unknown.length) issues.push({ field, message: `Unknown placeholder ${unknown.map((name) => `{${name}}`).join(", ")}. Use ${PLACEHOLDERS.map((name) => `{${name}}`).join(", ")}.` })
  }
  return issues
}

/** Validates and clamps one style; unknown fields are dropped and invalid values fall back to the default. */
export function parseCardStyle(value: unknown): CardStyle {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const order = Array.isArray(raw.order) ? raw.order.filter((entry): entry is MovableBlock => typeof entry === "string" && (MOVABLE_BLOCKS as readonly string[]).includes(entry)) : []
  const uniqueOrder = [...new Set(order)]
  for (const block of MOVABLE_BLOCKS) if (!uniqueOrder.includes(block)) uniqueOrder.push(block)
  const hidden = Array.isArray(raw.hidden) ? [...new Set(raw.hidden.filter((entry): entry is HideableBlock => typeof entry === "string" && (HIDEABLE_BLOCKS as readonly string[]).includes(entry)))] : [...DEFAULT_CARD_STYLE.hidden]
  const hiddenDetails = Array.isArray(raw.hiddenDetails) ? [...new Set(raw.hiddenDetails.map((entry) => cleanText(entry, 80)).filter(Boolean))].slice(0, 20) : []
  const maxItems = [3, 5, 10, 20].includes(Number(raw.maxItems)) ? (Number(raw.maxItems) as CardStyle["maxItems"]) : DEFAULT_CARD_STYLE.maxItems
  return {
    order: uniqueOrder,
    hidden: HIDEABLE_BLOCKS.filter((block) => hidden.includes(block)),
    severityStyle: oneOf(raw.severityStyle, ["both", "tint", "label"], DEFAULT_CARD_STYLE.severityStyle),
    accent: oneOf(raw.accent, ["severity", "accent", "emphasis", "good"], DEFAULT_CARD_STYLE.accent),
    titlePrefix: cleanText(raw.titlePrefix, TEXT_LIMITS.titlePrefix),
    summaryText: cleanText(raw.summaryText, TEXT_LIMITS.summaryText),
    hiddenDetails,
    maxItems,
    itemStyle: oneOf(raw.itemStyle, ["line", "stacked"], DEFAULT_CARD_STYLE.itemStyle),
    itemDetail: flag(raw.itemDetail, DEFAULT_CARD_STYLE.itemDetail),
    itemActor: flag(raw.itemActor, DEFAULT_CARD_STYLE.itemActor),
    itemTime: flag(raw.itemTime, DEFAULT_CARD_STYLE.itemTime),
    noteText: cleanText(raw.noteText, TEXT_LIMITS.noteText),
    noteMinSeverity: oneOf(raw.noteMinSeverity, ["info", "warning", "critical"], DEFAULT_CARD_STYLE.noteMinSeverity),
    buttonDestination: oneOf(raw.buttonDestination, ["auto", "intune", "entra"], DEFAULT_CARD_STYLE.buttonDestination),
    buttonLabel: cleanText(raw.buttonLabel, TEXT_LIMITS.buttonLabel),
    footerSource: flag(raw.footerSource, DEFAULT_CARD_STYLE.footerSource),
    footerTime: flag(raw.footerTime, DEFAULT_CARD_STYLE.footerTime),
    footerEventId: flag(raw.footerEventId, DEFAULT_CARD_STYLE.footerEventId),
    density: oneOf(raw.density, ["comfortable", "compact"], DEFAULT_CARD_STYLE.density),
    timeFormat: oneOf(raw.timeFormat, ["friendly", "iso"], DEFAULT_CARD_STYLE.timeFormat),
  }
}

/** Validates a whole layout. Anything unusable becomes the default, never an error at send time. */
export function parseCardLayout(value: unknown): CardLayout {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const overridesRaw = raw.overrides && typeof raw.overrides === "object" && !Array.isArray(raw.overrides) ? (raw.overrides as Record<string, unknown>) : {}
  const overrides: CardLayout["overrides"] = {}
  for (const group of EVENT_GROUP_IDS) if (overridesRaw[group] !== undefined && overridesRaw[group] !== null) overrides[group] = parseCardStyle(overridesRaw[group])
  return { version: 1, base: parseCardStyle(raw.base), overrides }
}

export function isDefaultLayout(layout: CardLayout): boolean {
  return sameStyle(layout.base, DEFAULT_CARD_STYLE) && Object.keys(layout.overrides).length === 0
}
