import { randomUUID } from "node:crypto"
import type { SetupDiagnosticsStatus } from "../../shared/ipc"
import type { KeyValueStore } from "../storage/secure-store"
import { validEvent, type ConsentPlace, type ReminderStep, type SetupEvent, type SetupEventInput, type SetupEventName, type SetupEventProps } from "./events"

const KEY = "setupDiagnostics.state"
const DAY_MS = 86_400_000
/** Diagnostics cover 30 days from the moment the admin agreed, then the ID and queue are deleted. */
export const WINDOW_MS = 30 * DAY_MS
/** Events that could not be sent within a week are dropped. */
export const MAX_EVENT_AGE_MS = 7 * DAY_MS
export const QUEUE_LIMIT = 100
export const BATCH_LIMIT = 50
/** The endpoint refuses bodies over 16 KB. */
const BODY_LIMIT = 16_000
const SEQ_LIMIT = 10_000
/** Events sent once per funnel ID. */
const ONCE = new Set<SetupEventName>(["consent", "first_launch", "welcome_continue", "script_saved", "tenant_added"])
/** Events sent per attempt, at most this many times per funnel ID (contract: repeat reporting). */
export const ATTEMPT_LIMITS: Partial<Record<SetupEventName, number>> = {
  setup_signin: 10,
  registration: 10,
  signin: 10,
  setup_route: 10,
  license: 10,
  storage: 5,
  first_backup: 5,
}
/** The step whose setup error each event can be, for the reminder next to that error. */
const STEP: Partial<Record<SetupEventName, ReminderStep>> = { setup_signin: "setup", registration: "setup", signin: "signin", license: "signin" }
export const SEND_DELAY_MS = 5_000
export const REQUEST_TIMEOUT_MS = 10_000
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 60 * 60_000
const RETRY_AFTER_MAX_MS = 6 * 60 * 60_000
/** setTimeout fires at once for delays above about 24.8 days, so long waits are made in steps. */
const MAX_TIMER_MS = 2_147_483_647

type State = SetupDiagnosticsStatus["state"]

/** What is kept on disk. Before consent only `state`; `pendingErase` only after a withdrawal. */
interface Saved {
  state: State
  /** Funnel IDs whose events the server is still asked to delete. Nothing else is kept for them. */
  pendingErase?: string[]
  /** Only while sharing. */
  funnelId?: string
  consentAt?: number
  nextSeq?: number
  queue?: SetupEvent[]
  /** Recorded events per name for this funnel ID, for the one-time events and the caps. */
  counts?: Record<string, number>
  firstBackupOk?: boolean
  lastActiveDay?: number
}

export interface SetupDiagnosticsOptions {
  store: KeyValueStore
  /** True when the app had no saved state at all before this launch, so this is a new install. */
  freshInstall: boolean
  /** The DisableSetupDiagnostics policy is set: nothing is asked, kept or sent. */
  policy: boolean
  /** Where events are sent (erase requests go to `${url}/erase`), or null for a build that sends nothing. */
  url: string | null
  fetch: typeof fetch
  envelope: { appVersion: string; os: string; channel: "stable" | "nightly" }
  /** The props of first_launch, read when sharing starts. */
  firstLaunch: () => SetupEventProps
  now?: () => number
}

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

type Outcome = "done" | "retry" | "aborted"

/** One request with the contract's answer rules: 2xx done, 400 and 413 dropped, everything else retried. */
async function post(fetchImpl: typeof fetch, url: string, body: string, abort: AbortSignal, now: () => number, label: string): Promise<{ outcome: Outcome; retryAfter: number | null }> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.any([abort, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
    void response.body?.cancel().catch(() => undefined)
    if (response.ok) return { outcome: "done", retryAfter: null }
    // A 400 or 413 is never accepted on a retry either.
    if (response.status === 400 || response.status === 413) {
      console.warn(`[diagnostics] ${label} was refused (${response.status}) and dropped.`)
      return { outcome: "done", retryAfter: null }
    }
    return { outcome: "retry", retryAfter: response.status === 429 ? retryAfterMs(response.headers.get("retry-after"), now()) : null }
  } catch {
    return { outcome: abort.aborted ? "aborted" : "retry", retryAfter: null }
  }
}

/** A timer with exponential backoff, for one kind of request. */
class Retrier {
  private timer: ReturnType<typeof setTimeout> | undefined
  private due = 0
  private until = 0
  private failures = 0
  constructor(private readonly now: () => number, private readonly run: () => void) {}

  /** Runs after `ms`, never before a backoff ends, and keeps an earlier run that is already due. */
  schedule(ms: number): void {
    const due = Math.max(this.now() + ms, this.until)
    if (this.timer && this.due <= due) return
    clearTimeout(this.timer)
    this.due = due
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.run()
    }, due - this.now())
    this.timer.unref?.()
  }

  succeeded(): void {
    this.failures = 0
    this.until = 0
  }

  failed(retryAfter: number | null): void {
    this.failures++
    const delay = retryAfter ?? Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.failures - 1))
    this.until = this.now() + delay
    this.schedule(delay)
  }

  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.succeeded()
  }
}

/**
 * Setup diagnostics for new installs that agree to share them: which setup steps worked and
 * which Microsoft error codes stopped them, for 30 days after the admin agreed.
 *
 * Before the admin agrees only the answer state is kept: no funnel ID, no date, no queue. The
 * one exception is the last setup error, held in memory only so that the reminder next to it
 * can offer to share it; it is never written and is dropped with any answer. An install that
 * already had saved state before this version is never asked. Declining, turning it off, the
 * policy and the end of the 30 days delete the funnel ID and the queue and stop any upload.
 * Turning it off and the policy also ask the server to delete what it stored for the ID.
 */
export class SetupDiagnostics {
  private saved: Saved
  private readonly now: () => number
  private pending: Partial<Record<ReminderStep, { event: SetupEventInput; at: number }>> = {}
  /** The reminder is shown once per session; it is not stored, since nothing is stored before an answer. */
  private reminded = false
  private upload: AbortController | undefined
  private erasing = false
  private readonly uploads: Retrier
  private readonly erasure: Retrier
  private expiryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: SetupDiagnosticsOptions) {
    this.now = options.now ?? Date.now
    this.uploads = new Retrier(this.now, () => void this.flush())
    this.erasure = new Retrier(this.now, () => void this.flushErase())
    this.saved = this.load()
    if (options.policy && this.saved.state === "granted") this.withdraw("declined")
    this.checkExpiry()
  }

  /** At launch: counts a later day, sends what is still queued and repeats a pending erase. */
  start(): void {
    this.checkExpiry()
    if (this.saved.pendingErase?.length) this.erasure.schedule(SEND_DELAY_MS)
    if (!this.active()) return
    const day = calendarDays(this.saved.consentAt!, this.now())
    if (day >= 1 && day <= 30 && day > (this.saved.lastActiveDay ?? 0)) {
      this.saved.lastActiveDay = day
      this.enqueue({ name: "active_day", props: { day } })
    } else if (this.saved.queue?.length) {
      this.schedule(SEND_DELAY_MS)
    }
  }

  stop(): void {
    this.uploads.stop()
    this.erasure.stop()
    clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
  }

  status(): SetupDiagnosticsStatus {
    this.checkExpiry()
    const { state } = this.saved
    const reminder = (step: ReminderStep) => !this.options.policy && state === "unasked" && !this.reminded && Boolean(this.pending[step])
    return { state, policy: this.options.policy, reminder: { setup: reminder("setup"), signin: reminder("signin") } }
  }

  /**
   * The admin agreed. A new funnel ID is created, then `consent` and `first_launch` are recorded
   * and, when the answer came from the reminder next to an error, that error.
   */
  consent(where: unknown, step?: unknown): SetupDiagnosticsStatus {
    if (where !== "welcome" && where !== "error" && where !== "settings") throw new Error("Unknown consent place.")
    if (step !== undefined && step !== null && step !== "setup" && step !== "signin") throw new Error("Unknown setup step.")
    this.checkExpiry()
    if (this.options.policy) throw new Error("Your organization turned setup diagnostics off.")
    if (this.saved.state === "granted") return this.status()
    if (this.saved.state !== "unasked" && this.saved.state !== "declined") throw new Error("Setup diagnostics are no longer available for this install.")
    const shared = where === "error" && typeof step === "string" ? this.pending[step as ReminderStep] : undefined
    this.pending = {}
    this.saved = {
      state: "granted",
      ...(this.saved.pendingErase?.length ? { pendingErase: this.saved.pendingErase } : {}),
      funnelId: randomUUID(),
      consentAt: this.now(),
      nextSeq: 1,
      queue: [],
      counts: {},
    }
    this.enqueue({ name: "consent", props: { where: where as ConsentPlace } })
    this.enqueue({ name: "first_launch", props: this.options.firstLaunch() })
    if (shared) this.enqueue(shared.event, shared.at)
    this.scheduleExpiry()
    return this.status()
  }

  /**
   * "Don't share", or turned off in Settings. While sharing, the upload is stopped, the funnel
   * ID and queue are deleted, and the server is asked to delete the events it stored.
   */
  decline(): SetupDiagnosticsStatus {
    this.checkExpiry()
    this.pending = {}
    if (this.saved.state === "granted") this.withdraw("declined")
    else if (this.saved.state === "unasked") this.replace({ state: "declined", ...(this.saved.pendingErase?.length ? { pendingErase: this.saved.pendingErase } : {}) })
    return this.status()
  }

  /** The reminder next to a setup error was shown; it is not shown again in this session. */
  reminderShown(): void {
    this.reminded = true
  }

  /**
   * Records an event while sharing. Before an answer, a setup error (`pendingFor`) is held in
   * memory only, for the reminder next to it; a later outcome of the same step without an error
   * drops it; every other event is dropped.
   */
  record(event: SetupEventInput, pendingFor?: ReminderStep): void {
    this.checkExpiry()
    if (this.options.policy) return
    if (this.saved.state === "granted") {
      this.enqueue(event)
      return
    }
    if (this.saved.state !== "unasked") return
    const step = pendingFor ?? STEP[event.name]
    if (!step) return
    if (pendingFor && !this.reminded && validEvent(event)) this.pending[step] = { event, at: this.now() }
    else if (!pendingFor) delete this.pending[step]
  }

  /** Deletes the funnel ID and queue at the end of the 30 days, also when nothing else happens. Safe to call any time. */
  checkExpiry(): void {
    if (this.saved.state !== "granted" || this.saved.consentAt === undefined) return
    if (this.now() - this.saved.consentAt < WINDOW_MS) {
      if (!this.expiryTimer) this.scheduleExpiry()
      return
    }
    this.pending = {}
    // The events already sent stay until the server deletes them after 180 days.
    this.abortUpload()
    this.replace({ state: "ended", ...(this.saved.pendingErase?.length ? { pendingErase: this.saved.pendingErase } : {}) })
  }

  /** Sends up to 50 queued events. Resolves when the attempt is over; a failure schedules a retry. */
  async flush(): Promise<void> {
    if (this.upload || !this.active() || !this.options.url) return
    const now = this.now()
    const queue = this.saved.queue!
    const fresh = queue.filter((event) => now - Date.parse(event.at) <= MAX_EVENT_AGE_MS)
    if (fresh.length !== queue.length) {
      this.saved.queue = fresh
      this.save()
    }
    if (!fresh.length) return
    const funnelId = this.saved.funnelId!
    const body = (events: SetupEvent[]) => JSON.stringify({ schema: 1, funnelId, ...this.options.envelope, events })
    let batch = fresh.slice(0, BATCH_LIMIT)
    while (batch.length > 1 && Buffer.byteLength(body(batch)) > BODY_LIMIT) batch = batch.slice(0, Math.ceil(batch.length / 2))
    const controller = new AbortController()
    this.upload = controller
    const { outcome, retryAfter } = await post(this.options.fetch, this.options.url, body(batch), controller.signal, this.now, "Setup diagnostics")
    if (this.upload === controller) this.upload = undefined
    // Withdrawn, ended or restarted with a new funnel ID while the request ran: nothing is kept.
    if (outcome === "aborted" || controller.signal.aborted || !this.active() || this.saved.funnelId !== funnelId) return
    if (outcome === "done") {
      const sent = new Set(batch.map((event) => event.seq))
      this.saved.queue = this.saved.queue!.filter((event) => !sent.has(event.seq))
      this.save()
      this.uploads.succeeded()
      if (this.saved.queue.length) this.schedule(0)
      return
    }
    this.uploads.failed(retryAfter)
  }

  /** Asks the server to delete the events of a withdrawn funnel ID, until it answers 202. */
  async flushErase(): Promise<void> {
    const funnelId = this.saved.pendingErase?.[0]
    if (this.erasing || !funnelId || !this.options.url) return
    this.erasing = true
    const { outcome, retryAfter } = await post(this.options.fetch, `${this.options.url}/erase`, JSON.stringify({ schema: 1, funnelId }), new AbortController().signal, this.now, "The erase request")
    this.erasing = false
    if (outcome !== "done") {
      this.erasure.failed(retryAfter)
      return
    }
    const remaining = (this.saved.pendingErase ?? []).filter((id) => id !== funnelId)
    if (remaining.length) this.saved.pendingErase = remaining
    else delete this.saved.pendingErase
    this.save()
    this.erasure.succeeded()
    if (remaining.length) this.erasure.schedule(0)
  }

  private active(): boolean {
    this.checkExpiry()
    return !this.options.policy && this.saved.state === "granted" && Boolean(this.saved.funnelId)
  }

  private enqueue(event: SetupEventInput, at = this.now()): void {
    const saved = this.saved
    const counts = (saved.counts ??= {})
    const queue = (saved.queue ??= [])
    const seq = saved.nextSeq ?? 1
    if (seq > SEQ_LIMIT) return
    const count = counts[event.name] ?? 0
    const limit = ATTEMPT_LIMITS[event.name]
    if (ONCE.has(event.name) && count >= 1) return
    if (limit !== undefined && count >= limit) return
    // The first backup is reported until one works.
    if (event.name === "first_backup" && saved.firstBackupOk) return
    if (!validEvent(event)) {
      console.warn(`[diagnostics] Dropped an invalid ${event.name} event.`)
      return
    }
    queue.push({ seq, name: event.name, at: new Date(at).toISOString(), ...(event.props && Object.keys(event.props).length ? { props: event.props } : {}) })
    saved.nextSeq = seq + 1
    if (queue.length > QUEUE_LIMIT) queue.splice(0, queue.length - QUEUE_LIMIT)
    counts[event.name] = count + 1
    if (event.name === "first_backup" && event.props?.result === "ok") saved.firstBackupOk = true
    this.save()
    this.schedule(SEND_DELAY_MS)
  }

  private schedule(ms: number): void {
    if (this.options.url) this.uploads.schedule(ms)
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    if (this.saved.state !== "granted" || this.saved.consentAt === undefined) return
    const remaining = Math.max(0, this.saved.consentAt + WINDOW_MS - this.now())
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined
      this.checkExpiry()
    }, Math.min(Math.max(remaining, 1000), MAX_TIMER_MS))
    this.expiryTimer.unref?.()
  }

  private abortUpload(): void {
    this.upload?.abort()
    this.upload = undefined
    this.uploads.stop()
  }

  /** Stops sharing: the upload is aborted, the funnel ID and queue are deleted, the server is asked to erase them. */
  private withdraw(state: State): void {
    const funnelId = this.saved.funnelId
    this.abortUpload()
    const pendingErase = [...(this.saved.pendingErase ?? []), ...(funnelId ? [funnelId] : [])]
    this.replace({ state, ...(pendingErase.length ? { pendingErase } : {}) })
    if (funnelId) this.erasure.schedule(0)
  }

  private replace(saved: Saved): void {
    clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    this.saved = saved
    this.save()
  }

  private load(): Saved {
    try {
      const raw = this.options.store.get(KEY)
      if (raw) {
        const saved = JSON.parse(raw) as Saved
        const state = saved?.state
        if (["unasked", "granted", "declined", "ineligible", "ended"].includes(state)) {
          const pendingErase = Array.isArray(saved.pendingErase) ? saved.pendingErase.filter((id) => typeof id === "string") : []
          const erase = pendingErase.length ? { pendingErase } : {}
          if (state !== "granted") return { state, ...erase }
          if (typeof saved.funnelId !== "string" || typeof saved.consentAt !== "number") return { state: "declined", ...erase }
          return {
            state,
            ...erase,
            funnelId: saved.funnelId,
            consentAt: saved.consentAt,
            nextSeq: Number.isInteger(saved.nextSeq) && saved.nextSeq! > 0 ? saved.nextSeq : 1,
            queue: Array.isArray(saved.queue) ? saved.queue.filter((event) => event && Number.isInteger(event.seq) && typeof event.at === "string" && validEvent(event)) : [],
            counts: saved.counts && typeof saved.counts === "object" ? saved.counts : {},
            ...(saved.firstBackupOk === true ? { firstBackupOk: true } : {}),
            ...(typeof saved.lastActiveDay === "number" ? { lastActiveDay: saved.lastActiveDay } : {}),
          }
        }
      }
    } catch {
      // An unreadable answer counts as none: the install is not asked again.
      return { state: "ineligible" }
    }
    // Decided once, at the first launch of this version: only an install without any saved state is asked.
    const decided: Saved = { state: this.options.freshInstall ? "unasked" : "ineligible" }
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
