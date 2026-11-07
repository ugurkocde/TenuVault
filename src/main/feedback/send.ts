import type { LicenseStatus } from "../../shared/ipc"
import {
  FEEDBACK_EMAIL_MAX,
  FEEDBACK_OS_VERSION_MAX,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  FEEDBACK_TEXT_MAX,
  feedbackTextProblem,
  isValidFeedbackEmail,
  type FeedbackContext,
  type FeedbackField,
  type FeedbackFieldErrors,
  type FeedbackInput,
  type FeedbackOs,
  type FeedbackPlan,
  type FeedbackSendResult,
} from "../../shared/feedback"
import { networkFailure } from "../api/network-error"

export const FEEDBACK_REQUEST_TIMEOUT_MS = 20_000

/** The body of POST /api/desktop-feedback. The service rejects any other key. */
export interface FeedbackPayload {
  submissionId: string
  goal: string
  blocker: string
  replyTo?: string
  appVersion: string
  os: FeedbackOs
  osVersion?: string
  plan: FeedbackPlan
  page?: string
  screenshot?: { mime: "image/jpeg"; data: string }
}

export interface ValidFeedbackInput {
  submissionId: string
  goal: string
  blocker: string
  replyTo?: string
  includeScreenshot: boolean
}

/** A draft the main process refuses; `field` names the answer to mark in the dialog. */
export class FeedbackInputError extends Error {
  constructor(message: string, readonly field?: FeedbackField) {
    super(message)
  }
}

const UNREADABLE = "The feedback could not be read. Try again."
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const INPUT_KEYS = new Set(["submissionId", "goal", "blocker", "replyTo", "includeScreenshot"])

function answer(value: unknown, field: "goal" | "blocker", question: string): string {
  if (typeof value !== "string" || !value.trim()) throw new FeedbackInputError(`Answer "${question}" first.`, field)
  const text = value.trim()
  if (text.length > FEEDBACK_TEXT_MAX) throw new FeedbackInputError(`Keep "${question}" to ${FEEDBACK_TEXT_MAX} characters.`, field)
  const problem = feedbackTextProblem(text)
  if (problem) throw new FeedbackInputError(problem, field)
  return text
}

/** Checks what the renderer sent; nothing from it is trusted beyond these fields. */
export function validateFeedbackInput(raw: unknown): ValidFeedbackInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FeedbackInputError(UNREADABLE)
  const input = raw as Partial<Record<keyof FeedbackInput, unknown>>
  // The page and the context come from the main process's snapshot, never from the renderer.
  if (Object.keys(input).some((key) => !INPUT_KEYS.has(key))) throw new FeedbackInputError(UNREADABLE)
  if (typeof input.submissionId !== "string" || !UUID.test(input.submissionId)) throw new FeedbackInputError(UNREADABLE)
  if (typeof input.includeScreenshot !== "boolean") throw new FeedbackInputError(UNREADABLE)
  const goal = answer(input.goal, "goal", "What were you trying to do?")
  const blocker = answer(input.blocker, "blocker", "What got in your way, and what would help?")
  let replyTo: string | undefined
  if (input.replyTo !== undefined) {
    const invalid = new FeedbackInputError("Enter a valid email address, or leave it empty.", "replyTo")
    if (typeof input.replyTo !== "string") throw invalid
    const email = input.replyTo.trim()
    if (email && (email.length > FEEDBACK_EMAIL_MAX || !isValidFeedbackEmail(email))) throw invalid
    replyTo = email || undefined
  }
  return { submissionId: input.submissionId.toLowerCase(), goal, blocker, replyTo, includeScreenshot: input.includeScreenshot }
}

/**
 * The plan to report, in the order the License chip in the sidebar names it: the plan of this
 * machine's key, else a paid license shared with a tenant (MSP over Pro), else none while the key
 * failed or is pending or a signed-in tenant is not covered, else Community.
 */
export function feedbackPlan(status: LicenseStatus): FeedbackPlan {
  if (status.plan) return status.plan
  const paid = status.tenants.filter((tenant) => tenant.entitled && (tenant.plan === "pro" || tenant.plan === "msp"))
  if (paid.some((tenant) => tenant.plan === "msp")) return "msp"
  if (paid.length) return "pro"
  const uncovered = status.tenants.some((tenant) => tenant.signedIn && !tenant.entitled && tenant.plan !== "community")
  return status.keyState === "failed" || status.keyState === "pending" || uncovered ? "none" : "community"
}

export function feedbackOs(platform: string): FeedbackOs {
  return platform === "win32" || platform === "darwin" ? platform : "linux"
}

export function feedbackContext(options: { appVersion: string; platform: string; systemVersion: string; status: LicenseStatus }): FeedbackContext {
  const osVersion = options.systemVersion.trim().slice(0, FEEDBACK_OS_VERSION_MAX)
  return {
    appVersion: options.appVersion,
    os: feedbackOs(options.platform),
    ...(osVersion ? { osVersion } : {}),
    plan: feedbackPlan(options.status),
  }
}

/**
 * Builds the request body with exactly the contract's keys from the draft and the snapshot taken
 * when the dialog opened; the screenshot only when ticked.
 */
export function buildFeedbackPayload(input: ValidFeedbackInput, snapshot: { context: FeedbackContext; page?: string; screenshot: Uint8Array | null }): FeedbackPayload {
  const { context, page } = snapshot
  const screenshot = input.includeScreenshot ? snapshot.screenshot : null
  if (input.includeScreenshot && !screenshot) throw new FeedbackInputError("The screenshot is no longer available. Untick it, or close and reopen Share feedback.")
  if (screenshot && screenshot.byteLength > FEEDBACK_SCREENSHOT_MAX_BYTES) throw new FeedbackInputError("The screenshot is too large. Untick it and try again.")
  return {
    submissionId: input.submissionId,
    goal: input.goal,
    blocker: input.blocker,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    appVersion: context.appVersion,
    os: context.os,
    ...(context.osVersion ? { osVersion: context.osVersion } : {}),
    plan: context.plan,
    ...(page ? { page } : {}),
    ...(screenshot ? { screenshot: { mime: "image/jpeg" as const, data: Buffer.from(screenshot).toString("base64") } } : {}),
  }
}

/** Seconds from a Retry-After header (seconds or an HTTP date), or undefined. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const text = value.trim()
  if (/^\d+$/.test(text)) return Number(text)
  const at = Date.parse(text)
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : undefined
}

function waitText(seconds: number | undefined): string {
  if (seconds === undefined) return "in a few minutes"
  if (seconds <= 1) return "in 1 second"
  if (seconds < 60) return `in ${seconds} seconds`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 120) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`
  return `in ${Math.ceil(minutes / 60)} hours`
}

/** A short, printable message from the service, or undefined. */
function serviceMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  const error = (body as { error?: unknown }).error
  if (typeof error !== "string") return undefined
  const text = error.replace(/\p{Cc}+/gu, " ").trim().slice(0, 300)
  return text || undefined
}

const FIELDS: readonly FeedbackField[] = ["goal", "blocker", "replyTo"]

/** The service's per-field messages from a 400, for the answers the dialog can mark. */
function fieldMessages(body: unknown): FeedbackFieldErrors | undefined {
  const fields = body && typeof body === "object" ? (body as { fields?: unknown }).fields : undefined
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return undefined
  const result: FeedbackFieldErrors = {}
  for (const field of FIELDS) {
    const message = serviceMessage({ error: (fields as Record<string, unknown>)[field] })
    if (message) result[field] = message.slice(0, 200)
  }
  return Object.keys(result).length ? result : undefined
}

const UNAVAILABLE = "The feedback service is not available right now. Try again later, or use Copy as email."

/** Turns the service's answer into a result the dialog can show. */
export function mapFeedbackResponse(status: number, retryAfter: string | null, body: unknown): FeedbackSendResult {
  const message = serviceMessage(body)
  if (status === 200) {
    return body && typeof body === "object" && (body as { ok?: unknown }).ok === true
      ? { ok: true }
      : { ok: false, kind: "server", message: "The feedback service returned an unexpected response. Check for a firewall block or network sign-in page, then try again." }
  }
  if (status === 429) {
    const seconds = retryAfterSeconds(retryAfter)
    return { ok: false, kind: "rate_limited", message: `Too much feedback was sent from this network. Try again ${waitText(seconds)}.`, ...(seconds !== undefined ? { retryAfterSeconds: seconds } : {}) }
  }
  if (status === 400) {
    const fields = fieldMessages(body)
    return { ok: false, kind: "rejected", message: message ?? "The feedback service did not accept this feedback. Check your answers and try again.", ...(fields ? { fields } : {}) }
  }
  if (status === 413) return { ok: false, kind: "rejected", message: message ?? "The feedback is too large. Untick the screenshot and try again." }
  if (status === 415) return { ok: false, kind: "rejected", message: message ?? "The feedback service did not accept the request. Update TenuVault and try again." }
  if (status === 404) return { ok: false, kind: "server", message: UNAVAILABLE }
  return { ok: false, kind: "server", message: status >= 500 && message ? message : UNAVAILABLE }
}

export const FEEDBACK_SNAPSHOT_EXPIRED = "This feedback window has expired. Close Share feedback and open it again; your answers are kept."

/**
 * Sends a draft with the snapshot recorded when the dialog opened. Without a snapshot (for
 * example after it was discarded) it fails instead of reading fresh details, which could differ
 * from what the dialog showed.
 */
export async function sendFeedbackDraft(
  raw: unknown,
  snapshot: { context: FeedbackContext; page?: string; screenshot: Uint8Array | null } | null,
  post: (payload: FeedbackPayload) => Promise<FeedbackSendResult>,
): Promise<FeedbackSendResult> {
  if (!snapshot) return { ok: false, kind: "rejected", message: FEEDBACK_SNAPSHOT_EXPIRED }
  let payload: FeedbackPayload
  try {
    payload = buildFeedbackPayload(validateFeedbackInput(raw), snapshot)
  } catch (error) {
    const message = error instanceof Error ? error.message : UNREADABLE
    const field = error instanceof FeedbackInputError ? error.field : undefined
    return { ok: false, kind: "rejected", message, ...(field ? { fields: { [field]: message } } : {}) }
  }
  return post(payload)
}

/** Posts the feedback once. Never throws: every failure becomes a result the dialog can show. */
export async function postFeedback(fetchImpl: typeof fetch, apiBase: string, payload: FeedbackPayload): Promise<FeedbackSendResult> {
  let response: Response
  try {
    response = await fetchImpl(`${apiBase}/api/desktop-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // The body can carry a screenshot of the window: never replay it to another origin.
      redirect: "error",
      signal: AbortSignal.timeout(FEEDBACK_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const { guidance } = networkFailure(error, new URL(apiBase).host)
    return { ok: false, kind: "network", message: `TenuVault could not reach the feedback service. ${guidance}` }
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  // A proxy or captive portal can answer with an HTML page; only a JSON body is read.
  let body: unknown = null
  if (contentType === "application/json") {
    try {
      body = await response.json()
    } catch (error) {
      // Invalid JSON is an unexpected answer; a timeout or dropped connection while reading is a network failure.
      if (!(error instanceof SyntaxError)) {
        const { guidance } = networkFailure(error, new URL(apiBase).host)
        return { ok: false, kind: "network", message: `TenuVault could not read the answer of the feedback service. ${guidance}` }
      }
    }
  } else {
    await response.body?.cancel().catch(() => undefined)
  }
  return mapFeedbackResponse(response.status, response.headers.get("retry-after"), body)
}
