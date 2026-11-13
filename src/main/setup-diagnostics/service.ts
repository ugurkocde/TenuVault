import { randomUUID } from "node:crypto"
import type { SetupDiagnosticsStatus } from "../../shared/ipc"
import type { KeyValueStore } from "../storage/secure-store"
import { validEvent, type ConsentPlace, type ReminderStep, type SetupEvent, type SetupEventInput, type SetupEventName, type SetupEventProps } from "./events"

const KEY = "setupDiagnostics.state"
const DAY_MS = 86_400_000
/** Diagnostics cover the first 30 days after install, then everything is deleted. */
export const WINDOW_MS = 30 * DAY_MS
/** Events that could not be sent within a week are dropped. */
export const MAX_EVENT_AGE_MS = 7 * DAY_MS
export const QUEUE_LIMIT = 100
export const BATCH_LIMIT = 50
/** The endpoint refuses bodies over 16 KB. */
const BODY_LIMIT = 16_000
const SEQ_LIMIT = 10_000
/** Sign-in and registration attempts are reported up to this many times, so a later success is seen. */
export const ATTEMPT_LIMIT = 10
const ATTEMPT_EVENTS = new Set<SetupEventName>(["setup_signin", "registration", "signin"])
export const SEND_DELAY_MS = 5_000
export const REQUEST_TIMEOUT_MS = 10_000
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 60 * 60_000
const RETRY_AFTER_MAX_MS = 6 * 60 * 60_000

type State = SetupDiagnosticsStatus["state"]

interface Saved {
  state: State
  /** The first launch, saved with the question so the 30 days end at the same time for every answer. */
  installedAt?: number
  /** Only while sharing: the random ID that links this install's events, and when sharing started. */
  funnelId?: string
  firstLaunchAt?: number
  nextSeq: number
  queue: SetupEvent[]
  /** One-time events already recorded for this funnel ID. */
  sentOnce: string[]
  /** How often each sign-in and registration event was recorded for this funnel ID. */
  attempts: Record<string, number>
  lastActiveDay?: number
  /** Whether the reminder next to a setup error was shown; it is shown once. */
  reminded?: boolean
}

export interface SetupDiagnosticsOptions {
  store: KeyValueStore
  /** True when the app had no saved state at all before this launch, so this is a new install. */
  freshInstall: boolean
  /** The DisableSetupDiagnostics policy is set: nothing is asked, kept or sent. */
  policy: boolean
  /** Where events are sent, or null for a build that sends nothing (an unpackaged build without a test endpoint). */
  url: string | null
  fetch: typeof fetch
  envelope: { appVersion: string; os: string; channel: "stable" | "nightly" }
  /** The props of first_launch, read when sharing starts. */
  firstLaunch: () => SetupEventProps
  now?: () => number
}

const empty = (state: State, installedAt?: number, reminded?: boolean): Saved => ({
  state,
  ...(installedAt === undefined ? {} : { installedAt }),
  nextSeq: 1,
  queue: [],
  sentOnce: [],
  attempts: {},
  ...(reminded ? { reminded } : {}),
})

/** Calendar days between two times, counted in local dates, so a launch after midnight is a new day. */
function calendarDays(from: number, to: number): number {
  const day = (time: number) => {
    const date = new Date(time)
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS
  }
  return day(to) - day(from)
}

function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null
  const delay = /^\d+$/.test(header.trim()) ? Number(header.trim()) * 1000 : Date.parse(header) - now
  return Number.isFinite(delay) ? Math.min(RETRY_AFTER_MAX_MS, Math.max(1000, delay)) : null
}

/**
 * Setup diagnostics for new installs that agree to share them: which setup steps worked and
 * which Microsoft error codes stopped them, for 30 days after install.
 *
 * Nothing is kept or sent before the admin agrees, except the answer itself: no funnel ID, no
 * queue. The one exception is the last setup error, held in memory only so that the reminder next
 * to it can offer to share it; it is never written and is dropped with any answer. An install
 * that already had saved state before this version is never asked. Declining, turning it off in
 * Settings, the policy and the end of the 30 days delete the funnel ID and the queue.
 */
export class SetupDiagnostics {
  private saved: Saved
  private readonly now: () => number
  private pending: Partial<Record<ReminderStep, { event: SetupEventInput; at: number }>> = {}
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerDue = 0
  private backoffUntil = 0
  private failures = 0
  private sending = false

  constructor(private readonly options: SetupDiagnosticsOptions) {
    this.now = options.now ?? Date.now
    this.saved = this.load()
    if (options.policy && this.saved.state === "granted") this.wipe("declined")
    this.checkWindow()
  }

  /** At launch: counts a later day and sends what is still queued. */
  start(): void {
    if (!this.active()) return
    const firstLaunchAt = this.saved.firstLaunchAt ?? this.now()
    const day = calendarDays(firstLaunchAt, this.now())
    if (day >= 1 && day <= 30 && day > (this.saved.lastActiveDay ?? 0)) {
      this.saved.lastActiveDay = day
      this.enqueue({ name: "active_day", props: { day } })
    } else if (this.saved.queue.length) {
      this.schedule(SEND_DELAY_MS)
    }
  }

  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  status(): SetupDiagnosticsStatus {
    this.checkWindow()
    const { state, reminded } = this.saved
    const reminder = (step: ReminderStep) => !this.options.policy && state === "unasked" && !reminded && Boolean(this.pending[step])
    return { state, policy: this.options.policy, reminder: { setup: reminder("setup"), signin: reminder("signin") } }
  }

  /**
   * The admin agreed. A new funnel ID is created, then `consent` and `first_launch` are recorded
   * and, when the answer came from the reminder next to an error, that error.
   */
  consent(where: unknown, step?: unknown): SetupDiagnosticsStatus {
    if (where !== "welcome" && where !== "error" && where !== "settings") throw new Error("Unknown consent place.")
    if (step !== undefined && step !== null && step !== "setup" && step !== "signin") throw new Error("Unknown setup step.")
    this.checkWindow()
    if (this.options.policy) throw new Error("Your organization turned setup diagnostics off.")
    if (this.saved.state === "granted") return this.status()
    if (this.saved.state !== "unasked" && this.saved.state !== "declined") throw new Error("Setup diagnostics are no longer available for this install.")
    const shared = where === "error" && typeof step === "string" ? this.pending[step as ReminderStep] : undefined
    this.pending = {}
    const now = this.now()
    this.saved = { ...empty("granted", this.saved.installedAt ?? now, this.saved.reminded), funnelId: randomUUID(), firstLaunchAt: now }
    this.enqueue({ name: "consent", props: { where: where as ConsentPlace } })
    this.enqueue({ name: "first_launch", props: this.options.firstLaunch() })
    if (shared) this.enqueue(shared.event, shared.at)
    return this.status()
  }

  /** "Don't share" or turned off in Settings: the funnel ID and the queue are deleted, nothing more is sent. */
  decline(): SetupDiagnosticsStatus {
    this.checkWindow()
    this.pending = {}
    if (this.saved.state === "unasked" || this.saved.state === "granted") this.wipe("declined")
    return this.status()
  }

  /** The reminder next to a setup error was shown; it is not shown again. */
  reminderShown(): void {
    if (this.saved.reminded) return
    this.saved.reminded = true
    this.save()
  }

  /**
   * Records an event while sharing. Before an answer, a setup error (`pendingFor`) is held in
   * memory only, for the reminder next to it; every other event is dropped.
   */
  record(event: SetupEventInput, pendingFor?: ReminderStep): void {
    this.checkWindow()
    if (this.options.policy) return
    if (this.saved.state === "granted") {
      this.enqueue(event)
      return
    }
    if (pendingFor && this.saved.state === "unasked" && !this.saved.reminded && validEvent(event)) {
      this.pending[pendingFor] = { event, at: this.now() }
    }
  }

  /** Sends up to 50 queued events. Resolves when the attempt is over; a failure schedules a retry. */
  async flush(): Promise<void> {
    if (this.sending || !this.active() || !this.options.url) return
    this.stop()
    const now = this.now()
    const fresh = this.saved.queue.filter((event) => now - Date.parse(event.at) <= MAX_EVENT_AGE_MS)
    if (fresh.length !== this.saved.queue.length) {
      this.saved.queue = fresh
      this.save()
    }
    if (!fresh.length) return
    const funnelId = this.saved.funnelId!
    const body = (events: SetupEvent[]) => JSON.stringify({ schema: 1, funnelId, ...this.options.envelope, events })
    let batch = fresh.slice(0, BATCH_LIMIT)
    while (batch.length > 1 && Buffer.byteLength(body(batch)) > BODY_LIMIT) batch = batch.slice(0, Math.ceil(batch.length / 2))
    this.sending = true
    let outcome: "done" | "retry"
    let retryAfter: number | null = null
    try {
      const response = await this.options.fetch(this.options.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body(batch),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      void response.body?.cancel().catch(() => undefined)
      // A 400 or 413 is never accepted on a retry either, so the batch is dropped.
      outcome = response.ok || response.status === 400 || response.status === 413 ? "done" : "retry"
      if (response.status === 429) retryAfter = retryAfterMs(response.headers.get("retry-after"), this.now())
      if (!response.ok && outcome === "done") console.warn(`[diagnostics] Setup diagnostics were refused (${response.status}) and dropped.`)
    } catch {
      outcome = "retry"
    } finally {
      this.sending = false
    }
    // Declined, ended or restarted with a new funnel ID while the request ran: nothing is kept.
    if (!this.active() || this.saved.funnelId !== funnelId) return
    if (outcome === "done") {
      const sent = new Set(batch.map((event) => event.seq))
      this.saved.queue = this.saved.queue.filter((event) => !sent.has(event.seq))
      this.save()
      this.failures = 0
      this.backoffUntil = 0
      if (this.saved.queue.length) this.schedule(0)
      return
    }
    this.failures++
    const delay = retryAfter ?? Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.failures - 1))
    this.backoffUntil = this.now() + delay
    this.schedule(delay)
  }

  private active(): boolean {
    this.checkWindow()
    return !this.options.policy && this.saved.state === "granted" && Boolean(this.saved.funnelId)
  }

  private enqueue(event: SetupEventInput, at = this.now()): void {
    const saved = this.saved
    if (saved.nextSeq > SEQ_LIMIT) return
    if (ATTEMPT_EVENTS.has(event.name)) {
      if ((saved.attempts[event.name] ?? 0) >= ATTEMPT_LIMIT) return
    } else if (event.name !== "active_day" && saved.sentOnce.includes(event.name)) {
      return
    }
    if (!validEvent(event)) {
      console.warn(`[diagnostics] Dropped an invalid ${event.name} event.`)
      return
    }
    saved.queue.push({ seq: saved.nextSeq++, name: event.name, at: new Date(at).toISOString(), ...(event.props && Object.keys(event.props).length ? { props: event.props } : {}) })
    if (saved.queue.length > QUEUE_LIMIT) saved.queue.splice(0, saved.queue.length - QUEUE_LIMIT)
    if (ATTEMPT_EVENTS.has(event.name)) saved.attempts[event.name] = (saved.attempts[event.name] ?? 0) + 1
    else if (event.name !== "active_day") saved.sentOnce.push(event.name)
    this.save()
    this.schedule(SEND_DELAY_MS)
  }

  /** Flushes after `ms`, but never before a backoff ends, and keeps an earlier flush that is already due. */
  private schedule(ms: number): void {
    if (!this.options.url) return
    const due = Math.max(this.now() + ms, this.backoffUntil)
    if (this.timer && this.timerDue <= due) return
    clearTimeout(this.timer)
    this.timerDue = due
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, due - this.now())
    this.timer.unref?.()
  }

  /** 30 days after install everything is deleted, whatever the answer was. */
  private checkWindow(): void {
    const { state, installedAt } = this.saved
    if (state !== "unasked" && state !== "granted" && state !== "declined") return
    if (installedAt !== undefined && this.now() - installedAt < WINDOW_MS) return
    this.pending = {}
    this.wipe("ended")
  }

  private wipe(state: State): void {
    this.stop()
    this.backoffUntil = 0
    this.failures = 0
    this.saved = empty(state, this.saved.installedAt, this.saved.reminded)
    this.save()
  }

  private load(): Saved {
    try {
      const raw = this.options.store.get(KEY)
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Saved>
        if (saved && ["unasked", "granted", "declined", "ineligible", "ended"].includes(saved.state as string)) {
          const state = saved.state as State
          const installedAt = typeof saved.installedAt === "number" && Number.isFinite(saved.installedAt) ? saved.installedAt : undefined
          if (state !== "granted" || typeof saved.funnelId !== "string") return empty(state === "granted" ? "declined" : state, installedAt, saved.reminded === true)
          return {
            ...empty("granted", installedAt, saved.reminded === true),
            funnelId: saved.funnelId,
            firstLaunchAt: typeof saved.firstLaunchAt === "number" ? saved.firstLaunchAt : installedAt,
            nextSeq: Number.isInteger(saved.nextSeq) && saved.nextSeq! > 0 ? saved.nextSeq! : 1,
            queue: Array.isArray(saved.queue) ? saved.queue.filter((event) => event && Number.isInteger(event.seq) && typeof event.at === "string" && validEvent(event)) : [],
            sentOnce: Array.isArray(saved.sentOnce) ? saved.sentOnce.filter((name) => typeof name === "string") : [],
            attempts: saved.attempts && typeof saved.attempts === "object" ? saved.attempts : {},
            ...(typeof saved.lastActiveDay === "number" ? { lastActiveDay: saved.lastActiveDay } : {}),
          }
        }
      }
    } catch {
      // An unreadable answer counts as none: the install is not asked again.
      return empty("ineligible")
    }
    // Decided once, at the first launch of this version: only an install without any saved state is asked.
    const decided = this.options.freshInstall ? empty("unasked", this.now()) : empty("ineligible")
    this.options.store.set(KEY, JSON.stringify(decided))
    return decided
  }

  private save(): void {
    try {
      this.options.store.set(KEY, JSON.stringify(this.saved))
    } catch (error) {
      console.warn("[diagnostics] Could not save the setup diagnostics state.", error instanceof Error ? error.message : String(error))
    }
  }
}
