import { networkFailureKind } from "../api/network-error"

/**
 * Setup diagnostics events, schema version 1. The names, props and allowed values are fixed by the
 * contract with the ingest endpoint (POST /api/desktop-events): the endpoint rejects a whole
 * request with anything else, so every event is checked here before it is queued.
 */
export const SETUP_EVENT_NAMES = [
  "consent",
  "first_launch",
  "welcome_continue",
  "setup_route",
  "setup_signin",
  "registration",
  "script_saved",
  "signin",
  "license",
  "storage",
  "tenant_added",
  "first_backup",
  "active_day",
] as const

export type SetupEventName = (typeof SETUP_EVENT_NAMES)[number]
export type SetupEventProps = Record<string, string | number | boolean>

/** An event as a hook reports it, before it gets its sequence number and time. */
export interface SetupEventInput {
  name: SetupEventName
  props?: SetupEventProps
}

/** An event as it is queued and sent. */
export interface SetupEvent extends SetupEventInput {
  seq: number
  at: string
}

/** Where the admin agreed: the welcome screen card, the reminder next to a setup error, or Settings. */
export type ConsentPlace = "welcome" | "error" | "settings"

/** The step whose error a reminder offers to share: the in-app setup or the first sign-in. */
export type ReminderStep = "setup" | "signin"

const CODE = /^(AADSTS\d{4,9}|HTTP_\d{3}|[a-z_]{1,40})$/
const WORD = /^[a-z_]{1,40}$/

type Check = (value: unknown) => boolean
const oneOf = (...values: string[]): Check => (value) => typeof value === "string" && values.includes(value)
const matches = (pattern: RegExp): Check => (value) => typeof value === "string" && pattern.test(value)
const isBoolean: Check = (value) => typeof value === "boolean"
const RESULT = oneOf("ok", "failed", "cancelled", "timeout")

/** Every prop each event may carry, with its check, and which of them it must carry. */
const SCHEMA: Record<SetupEventName, { props: Record<string, Check>; required: string[] }> = {
  consent: { props: { where: oneOf("welcome", "error", "settings") }, required: ["where"] },
  first_launch: {
    props: { osVersion: matches(/^\d{1,3}(\.\d{1,5})?$/), arch: oneOf("x64", "arm64", "ia32", "other"), managedInstall: isBoolean },
    required: ["osVersion", "arch", "managedInstall"],
  },
  welcome_continue: { props: {}, required: [] },
  setup_route: { props: { route: oneOf("auto", "script", "manual", "handoff") }, required: ["route"] },
  setup_signin: { props: { result: RESULT, code: matches(CODE) }, required: ["result"] },
  registration: {
    props: {
      result: oneOf("created", "reused", "failed", "not_ready", "missing_consent", "cancelled"),
      phase: oneOf("signingIn", "registration", "consent", "publishing"),
      code: matches(CODE),
    },
    required: ["result"],
  },
  script_saved: { props: {}, required: [] },
  signin: { props: { result: RESULT, code: matches(CODE), explained: isBoolean }, required: ["result"] },
  license: { props: { outcome: oneOf("trial_started", "community", "licensed", "refused", "unreachable"), reason: matches(WORD) }, required: ["outcome"] },
  storage: { props: { kind: oneOf("local", "share", "azure") }, required: ["kind"] },
  tenant_added: { props: {}, required: [] },
  first_backup: { props: { result: oneOf("ok", "partial", "failed"), errorClass: oneOf("network", "permission", "throttled", "storage", "cancelled", "other") }, required: ["result"] },
  active_day: { props: { day: (value) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 30 }, required: ["day"] },
}

/** Whether an event matches the contract exactly: a known name, only its own props, each valid. */
export function validEvent(event: SetupEventInput): boolean {
  const schema = SCHEMA[event.name as SetupEventName]
  if (!schema) return false
  const props = event.props ?? {}
  if (typeof props !== "object" || props === null || Array.isArray(props)) return false
  for (const [key, value] of Object.entries(props)) {
    if (!Object.hasOwn(schema.props, key) || !schema.props[key]!(value)) return false
  }
  return schema.required.every((key) => Object.hasOwn(props, key))
}

/**
 * The code a failure is reported with, never its message: an AADSTS code, an HTTP status, a
 * network failure kind or an MSAL error code. Anything else is reported as `other`, so tenant
 * names, IDs, accounts and other text inside an error message never leave the device.
 */
export function diagnosticCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const aadsts = /AADSTS(\d+)/.exec(message)?.[1]
  if (aadsts) return aadsts.length >= 4 && aadsts.length <= 9 ? `AADSTS${aadsts}` : "other"
  const status = [error, error instanceof Error ? error.cause : undefined]
    .map((value) => (value && typeof value === "object" ? (value as { status?: unknown }).status : undefined))
    .find((value) => value !== undefined)
  if (Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599) return `HTTP_${status}`
  const network = networkFailureKind(error)
  if (network) return network
  const errorCode = error && typeof error === "object" ? (error as { errorCode?: unknown }).errorCode : undefined
  if (typeof errorCode === "string" && WORD.test(errorCode.toLowerCase())) return errorCode.toLowerCase()
  return "other"
}

/** A refusal reason as the licensing service names it, or `other` for anything that is not one word. */
export function reasonCode(reason: unknown): string {
  return typeof reason === "string" && WORD.test(reason) ? reason : "other"
}

/** The events the renderer reports itself; every other event is recorded where the main process knows the outcome. */
const RENDERER_EVENTS = new Set<SetupEventName>(["welcome_continue", "setup_route", "script_saved", "storage"])

/**
 * Checks an event the renderer reports through IPC. Only its own four events, each with its own
 * props; `storage` arrives as local or azure, and `share` is decided here from the backup folder.
 */
export function rendererEvent(name: unknown, props: unknown, localFolderIsShare: () => boolean): SetupEventInput {
  if (typeof name !== "string" || !RENDERER_EVENTS.has(name as SetupEventName)) throw new Error("Unknown setup diagnostics event.")
  const event: SetupEventInput = { name: name as SetupEventName, ...(props === undefined || props === null ? {} : { props: props as SetupEventProps }) }
  if (event.name === "storage" && event.props?.kind === "share") throw new Error("Invalid setup diagnostics event.")
  if (!validEvent(event)) throw new Error("Invalid setup diagnostics event.")
  if (event.name === "storage" && event.props?.kind === "local" && localFolderIsShare()) return { name: "storage", props: { kind: "share" } }
  return event
}

/** A backup folder on another computer: a UNC path on Windows, a mounted volume on macOS. */
export function isNetworkFolder(folder: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return /^(\\\\|\/\/)[^\\/]/.test(folder)
  if (platform === "darwin") return /^\/Volumes\//.test(folder)
  return /^\/(mnt|media)\//.test(folder)
}

/** How a setup sign-in or first sign-in ended, as `setup_signin` or `signin` reports it. */
export function signInResult(error: unknown): "cancelled" | "timeout" | "failed" {
  if (error instanceof Error && (error.name === "SignInCancelledError" || error.message === "Sign-in cancelled." || error.message.startsWith("The sign-in was cancelled in the browser."))) return "cancelled"
  if (error instanceof Error && error.name === "SignInTimeoutError") return "timeout"
  return "failed"
}

/** The props of `first_launch`: the operating system's major.minor version, the CPU and whether IT manages the install. */
export function firstLaunchProps(systemVersion: string, arch: string, managedInstall: boolean): SetupEventProps {
  const version = /^(\d{1,3})(?:\.(\d{1,5}))?/.exec(systemVersion)
  return {
    osVersion: version ? (version[2] ? `${version[1]}.${version[2]}` : version[1]!) : "0",
    arch: ["x64", "arm64", "ia32"].includes(arch) ? arch : "other",
    managedInstall,
  }
}
