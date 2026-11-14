/**
 * How each type a backup was asked to cover ended, and whether the run covered all of them.
 *
 * Every selected type ends in exactly one outcome. The manifest status says whether the backup can
 * be used; the outcomes say what it holds. A type of a service that is off, or that the backup scope
 * leaves out, is not selected and has no outcome.
 *
 * Pure, so the engine, the result views and tests read the same rules.
 */

import type { AnswerPattern } from "./intune/registry"
import type { ModuleId } from "./services/modules"

/**
 * Why a selected type was left out:
 * - permission: the app registration or the Backup Reader lacks the permission or its admin consent.
 * - role: the permission is granted, but the signed-in account has no role that may read the type.
 * - license: the tenant has no license for the product, or never set it up (not onboarded).
 * - signedIn: Microsoft Graph lets only a signed-in admin read the type, and the run had none.
 */
export type SkipCause = "permission" | "role" | "license" | "signedIn"

interface OutcomeOf<Kind extends string> {
  folder: string
  /** The service the type belongs to. */
  service: ModuleId | null
  outcome: Kind
}

/** What Microsoft Graph answered, when an answer decided the outcome. */
interface Answered {
  status?: number
  code?: string
}

export type TypeOutcome =
  /** Every object of the type was saved; `saved` is 0 for a type the tenant has none of. */
  | (OutcomeOf<"saved"> & { saved: number })
  /** The tenant never set the type up, which is a complete answer. */
  | OutcomeOf<"notConfigured">
  | (OutcomeOf<"skipped"> & Answered & {
      cause: SkipCause
      reason: string
      /** Left out before any request, because the Backup Reader does not read the type. */
      reader?: true
      /** Objects saved before a read was refused; they stay in the backup. */
      saved?: number
    })
  /** The type, or some of its objects, could not be read; `saved` is what the backup holds of it. */
  | (OutcomeOf<"failed"> & Answered & { error: string; saved: number })

/** Whether every selected type was read: saved, or found not configured. */
export type Coverage = "complete" | "incomplete"

/** The outcomes of one backup run. The run ID is the one in the backup's manifest and ownership marker. */
export interface RunOutcomes {
  runId: string
  tenantId: string
  /** Whose sign-in read the tenant, so outcomes of an admin and of the Backup Reader are never compared. */
  authMode: "delegated" | "app-only"
  trigger: "manual" | "scheduled" | "tray"
  startedAt: string
  endedAt: string
  /** The manifest status, or the status of a run that stopped before its manifest. */
  status: string
  coverage: Coverage
  types: TypeOutcome[]
}

export function coverageOf(types: readonly TypeOutcome[]): Coverage {
  return types.every((type) => type.outcome === "saved" || type.outcome === "notConfigured") ? "complete" : "incomplete"
}

/** The outcomes as a backup's manifest records them, in the manifest's own naming. */
export function manifestOutcomes(types: readonly TypeOutcome[]): Array<Record<string, unknown>> {
  return types.map((type) => ({
    Folder: type.folder,
    Outcome: type.outcome,
    ...("saved" in type && type.saved !== undefined ? { Saved: type.saved } : {}),
    ...(type.outcome === "skipped" ? { Cause: type.cause, Reason: type.reason, ...(type.reader ? { Reader: true } : {}) } : {}),
    ...(type.outcome === "failed" ? { Error: type.error } : {}),
    ...((type.outcome === "skipped" || type.outcome === "failed") && type.status !== undefined ? { Status: type.status } : {}),
    ...((type.outcome === "skipped" || type.outcome === "failed") && type.code ? { Code: type.code } : {}),
  }))
}

/**
 * What a backup's manifest says about its coverage: null for a backup of a version that did not
 * record it, and the folders of the selected types that were not read in full.
 */
export function manifestCoverage(metadata: { Coverage?: unknown; Outcomes?: unknown } | null | undefined): { coverage: Coverage | null; notRead: string[] } {
  const coverage = metadata?.Coverage === "Complete" ? "complete" : metadata?.Coverage === "Incomplete" ? "incomplete" : null
  const entries = Array.isArray(metadata?.Outcomes) ? metadata.Outcomes : []
  const notRead = entries.flatMap((entry) => {
    const { Folder, Outcome } = entry && typeof entry === "object" ? (entry as { Folder?: unknown; Outcome?: unknown }) : {}
    return typeof Folder === "string" && (Outcome === "skipped" || Outcome === "failed") ? [Folder] : []
  })
  return { coverage, notRead }
}

/** A refused request as the classifier sees it. */
export interface RefusedAnswer {
  status: number
  code?: string
  message?: string
}

export type Verdict = { outcome: "notConfigured" } | { outcome: "skipped"; cause: SkipCause } | { outcome: "failed" }

export interface AnswerContext {
  /** The type's own answers that mean it was never set up. */
  notConfigured?: readonly AnswerPattern[]
  /** Whether the sign-in's token holds the permission the type needs; undefined when the token could not be read. */
  held?: boolean
  mode: "delegated" | "app-only"
}

const matches = (pattern: AnswerPattern, answer: RefusedAnswer) =>
  pattern.status === answer.status &&
  (pattern.code === undefined || pattern.code.toLowerCase() === answer.code?.toLowerCase()) &&
  (pattern.message === undefined || (answer.message ?? "").toLowerCase().includes(pattern.message.toLowerCase()))

/** Microsoft names the permissions a request lacks in several wordings. */
const NAMES_PERMISSION = /required (application )?(roles|permissions|scopes)|missing application roles|missing permission scope|PermissionScopeNotGranted/i
/** A product the tenant has no license for, or never set up. */
const NOT_AVAILABLE = /licen[cs]e|not onboarded|is not active|requires feature|not provisioned/i
/** The sign-in itself was refused, which no permission fixes. */
const TOKEN_REFUSED = /InvalidAuthenticationToken|token (has |is )?expired|token validation/i

/**
 * What a refused read means for the type it belongs to. The rules follow the answers recorded from
 * the lab tenant (test/fixtures/graph-answers.ts): Microsoft Graph does not answer a missing
 * permission the same way everywhere, and it answers a missing license or a setting that was never
 * made with the same status codes.
 */
export function classifyAnswer(answer: RefusedAnswer, context: AnswerContext): Verdict {
  if (context.notConfigured?.some((pattern) => matches(pattern, answer))) return { outcome: "notConfigured" }
  const said = `${answer.code ?? ""} ${answer.message ?? ""}`
  if (answer.status === 401) {
    if (/app-only/i.test(said)) return { outcome: "skipped", cause: "signedIn" }
    // Some endpoints answer a missing permission with 401, one of them with an HTML page.
    return TOKEN_REFUSED.test(said) ? { outcome: "failed" } : { outcome: "skipped", cause: "permission" }
  }
  if ((answer.status === 403 || answer.status === 400) && NOT_AVAILABLE.test(said)) return { outcome: "skipped", cause: "license" }
  if (answer.status !== 403) return { outcome: "failed" }
  if (NAMES_PERMISSION.test(said)) return { outcome: "skipped", cause: "permission" }
  // Refused although the token holds the permission: for a signed-in admin that is the account's role.
  return { outcome: "skipped", cause: context.held && context.mode === "delegated" ? "role" : "permission" }
}

const MAX_QUOTED = 300

/** What Microsoft answered, short enough for a result line. */
function quoted(message: string | undefined): string {
  const text = (message ?? "").replace(/\s+/g, " ").trim()
  if (!text) return ""
  return `: "${text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED).trimEnd()}...` : text}"`
}

export interface ReasonContext {
  /** The service's name, such as "Entra ID". */
  service: string
  /** Guidance on the roles that can read the service. */
  roles?: string
  mode: "delegated" | "app-only"
  /** The name of the Settings card that shows permissions. */
  settingsPage: string
}

/** Why a type was left out, for the backup result. `message` is what Microsoft Graph answered. */
export function skipReason(cause: SkipCause, context: ReasonContext, message?: string): string {
  const who = context.mode === "app-only" ? "Backup Reader" : "TenuVault app registration"
  switch (cause) {
    case "signedIn":
      return "Microsoft Graph lets only a signed-in admin read this type, so the Backup Reader leaves it out. Manual backups include it."
    case "license":
      return `This tenant is not set up for it${quoted(message)}. Microsoft answers this when the product has no license in the tenant or was never set up.`
    case "role":
      return `Microsoft refused the read although the permission is granted${quoted(message)}. Your account may not have a role that can read ${context.service}${context.roles ? ` (${context.roles.split(";")[0]})` : ""}.`
    case "permission":
      return `Microsoft refused the read${quoted(message)}. The ${who} may lack the permission or admin consent for it. ${context.settingsPage} in Settings shows what is missing.`
  }
}
