import { SUPPORT_EMAIL } from "./constants"

/** Longest answer to each question, in characters, after trimming. */
export const FEEDBACK_TEXT_MAX = 500
export const FEEDBACK_EMAIL_MAX = 254
export const FEEDBACK_PAGE_MAX = 80
export const FEEDBACK_OS_VERSION_MAX = 64
/** Largest screenshot the feedback service accepts, in decoded bytes (1.5 MB). */
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 1_572_864

export type FeedbackPlan = "community" | "pro" | "msp" | "none"
export type FeedbackOs = "win32" | "darwin" | "linux"

/** What the main process adds to every feedback message, shown to the admin before sending. */
export interface FeedbackContext {
  appVersion: string
  os: FeedbackOs
  osVersion?: string
  plan: FeedbackPlan
}

/**
 * What the main process recorded when Share feedback opened: the screenshot (held in main, the
 * renderer only gets a small preview), the context and the page. The dialog shows this snapshot
 * and Send uses the same one, so what is shown is what is sent.
 */
export interface FeedbackSnapshot {
  /** The opening ID made by the main process; send and discard name it. */
  id: string
  /** A small JPEG data URL of the captured window, or null when capture failed. */
  preview: string | null
  context: FeedbackContext
  /** A label from FEEDBACK_PAGES, never a route. */
  page?: string
}

/** What the renderer passes to send feedback. The main process adds its snapshot itself. */
export interface FeedbackInput {
  /** One per draft, reused when the same draft is sent again. */
  submissionId: string
  goal: string
  blocker: string
  replyTo?: string
  includeScreenshot: boolean
}

export type FeedbackFailureKind = "network" | "rate_limited" | "rejected" | "server"

/** Fields the dialog can mark with the service's message after a 400. */
export type FeedbackField = "goal" | "blocker" | "replyTo"
export type FeedbackFieldErrors = Partial<Record<FeedbackField, string>>

export type FeedbackSendResult =
  | { ok: true }
  | { ok: false; kind: FeedbackFailureKind; message: string; retryAfterSeconds?: number; fields?: FeedbackFieldErrors }

/**
 * Human names of the app's sections, matched by route prefix (more specific first). Only these
 * labels are sent as the page, so a route with a tenant, backup or framework ID never leaves the app.
 */
const FEEDBACK_PAGES: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ["/portal/dashboard", "Dashboard"],
  ["/portal/overview", "All tenants"],
  ["/portal/tenants", "Tenants"],
  ["/portal/backup", "Backup & Restore"],
  ["/portal/drift", "Drift Detection"],
  ["/portal/alerts", "Alerts"],
  ["/portal/oib", "OpenIntuneBaseline"],
  ["/portal/reports", "Reports"],
  ["/portal/audit", "Audit Log"],
  ["/portal/governance", "Governance"],
  ["/portal/changes", "Changes"],
  ["/portal/operations", "Operations"],
  ["/portal/frameworks/cis-benchmarks", "CIS Benchmarks"],
  ["/portal/frameworks", "Frameworks"],
  ["/portal/baselines", "My baselines"],
  ["/portal/settings", "Settings"],
  ["/portal/onboarding", "Setup"],
  ["/license", "License"],
]

export const FEEDBACK_PAGE_LABELS: ReadonlySet<string> = new Set(FEEDBACK_PAGES.map(([, label]) => label))

/** The section name for a route, or undefined when the route is not a known section. */
export function feedbackPageLabel(pathname: string): string | undefined {
  return FEEDBACK_PAGES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1]
}

/** The value when it is one of the fixed section names, else undefined. */
export function knownFeedbackPage(value: unknown): string | undefined {
  return typeof value === "string" && FEEDBACK_PAGE_LABELS.has(value) ? value : undefined
}

// The email rule of zod 3.25 (`emailRegex` in zod/src/v3/types.ts), which the feedback service
// validates replyTo with. Same pattern, with the needless escapes inside the classes dropped.
const EMAIL = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+.-]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i

/** The service's email check, so an address that passes here is not refused there. */
export function isValidFeedbackEmail(value: string): boolean {
  return value.length <= FEEDBACK_EMAIL_MAX && EMAIL.test(value)
}

const LONE_SURROGATE = /\p{Cs}/u
const LONE_SURROGATES = /\p{Cs}/gu

/**
 * Why the service would refuse this answer text, or undefined. It stores answers as Postgres text,
 * which holds neither NUL nor unpaired surrogates.
 */
export function feedbackTextProblem(text: string): string | undefined {
  return text.includes("\u0000") || LONE_SURROGATE.test(text) ? "Remove unsupported characters." : undefined
}

export function feedbackPlanLabel(plan: FeedbackPlan): string {
  return plan === "msp" ? "MSP" : plan === "pro" ? "Pro" : plan === "community" ? "Community" : "No license"
}

export function feedbackOsLabel(context: Pick<FeedbackContext, "os" | "osVersion">): string {
  const name = context.os === "win32" ? "Windows" : context.os === "darwin" ? "macOS" : "Linux"
  return context.osVersion ? `${name} ${context.osVersion}` : name
}

/** The rows of the "Sent with your feedback" list, in the order they are shown. */
export function feedbackDiagnostics(context: FeedbackContext, page: string | undefined): Array<{ label: string; value: string }> {
  return [
    { label: "App version", value: context.appVersion },
    { label: "Operating system", value: feedbackOsLabel(context) },
    { label: "Plan", value: feedbackPlanLabel(context.plan) },
    ...(page ? [{ label: "Page", value: page }] : []),
  ]
}

/** Keeps mailto links short enough for every mail client and for Windows' URL length limits. */
export const FEEDBACK_MAILTO_MAX = 1800
export const FEEDBACK_MAILTO_SUBJECT = "TenuVault feedback"

/** Replaces what encodeURIComponent cannot encode (unpaired surrogates) and drops NUL. */
function encodable(text: string): string {
  return text.replace(LONE_SURROGATES, "\uFFFD").replaceAll("\u0000", "")
}

function truncate(text: string, max: number): string {
  // Split by code point so an emoji or other surrogate pair is never cut in half.
  const points = Array.from(text)
  return points.length <= max ? text : `${points.slice(0, Math.max(0, max - 3)).join("")}...`
}

/**
 * A mailto link to support with both answers and the diagnostics, for when sending fails. The
 * screenshot is never included. Long answers are shortened until the link fits FEEDBACK_MAILTO_MAX.
 * Never throws, even for text with unpaired surrogates.
 */
export function feedbackMailto(input: { goal: string; blocker: string; context: FeedbackContext | null; page?: string }): string {
  const diagnostics = input.context
    ? feedbackDiagnostics(input.context, input.page).map((row) => `${row.label}: ${row.value}`)
    : input.page ? [`Page: ${input.page}`] : []
  const build = (max: number) => {
    const body = [
      "What were you trying to do?",
      truncate(encodable(input.goal).trim(), max),
      "",
      "What got in your way, and what would help?",
      truncate(encodable(input.blocker).trim(), max),
      ...(diagnostics.length ? ["", ...diagnostics.map(encodable)] : []),
    ].join("\n")
    return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(FEEDBACK_MAILTO_SUBJECT)}&body=${encodeURIComponent(body)}`
  }
  let max = FEEDBACK_TEXT_MAX
  let url = build(max)
  while (url.length > FEEDBACK_MAILTO_MAX && max > 20) {
    max = Math.floor(max * 0.8)
    url = build(max)
  }
  return url
}
