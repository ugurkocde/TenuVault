import type { BackupSchedule, ScheduleInput } from "../../shared/ipc"
import type { KeyValueStore } from "../storage/secure-store"
import type { BackupJob } from "./engine"

const KEY = "backup.schedules"
const TICK_MS = 60 * 1000
const RETRY_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 3
const VALID_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export interface ScheduledRunResult {
  status: "Completed" | "Failed" | "Cancelled"
  message: string
  /** Failed only: Microsoft or the storage account could not be reached, so the attempt is not counted. */
  unreachable?: boolean
}

/**
 * The outcome a finished backup job counts as for its scheduled slot. A backup that saved some
 * policies but could not read others stays on disk, yet it does not satisfy the slot: the slot
 * keeps its attempt and is retried instead of being recorded as a success.
 */
export function scheduledResult(job: BackupJob): ScheduledRunResult {
  const message = job.exception ?? job.progressMessage
  if (job.status === "Cancelled") return { status: "Cancelled", message }
  if (job.status === "Completed" && !job.failures) return { status: "Completed", message }
  return job.unreachable ? { status: "Failed", message, unreachable: true } : { status: "Failed", message }
}

/**
 * Whether a scheduled result is notified and written to the audit log. A sleeping computer that
 * wakes briefly fails with the same connection error every 15 minutes, so such a failure is
 * reported only when the previous attempt of the same slot did not already fail (`afterFailure`).
 */
export function reportsResult(afterFailure: boolean, result: ScheduledRunResult): boolean {
  return !(afterFailure && result.status === "Failed" && result.unreachable)
}

/**
 * Runs backups on a schedule while TenuVault is running (in the window or the tray).
 * No Azure resources are involved: backups run in the app as the signed-in admin.
 *
 * A schedule is due when its most recent slot (for example today 02:00) has passed and
 * the backup has not run since that slot. Slots missed while the app was closed are
 * caught up when it starts. Failed slots have up to three attempts, 15 minutes apart.
 * Backups run one at a time.
 *
 * A failure because Microsoft or the storage account could not be reached is retried 15 minutes
 * later without counting toward the three attempts: a sleeping Mac wakes for a few seconds at a
 * time for network upkeep, runs timers then, and its requests time out.
 */
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null

  constructor(
    private readonly store: KeyValueStore,
    /** `afterFailure`: the previous attempt of this slot ended as Failed, read from the stored schedule before this attempt. */
    private readonly run: (tenantId: string, afterFailure: boolean) => Promise<ScheduledRunResult>,
    private readonly onChange: () => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): BackupSchedule[] {
    return Object.values(this.read()).map((schedule) => ({ ...schedule, nextRunAt: this.nextRun(schedule)?.toISOString() ?? null }))
  }

  set(input: ScheduleInput): BackupSchedule {
    if (!VALID_TIME.test(input.time)) throw new Error("Choose a time such as 02:00.")
    if (input.frequency === "weekly" && !validWeekday(input.weekday)) {
      throw new Error("Choose a day of the week.")
    }
    const all = this.read()
    const id = input.tenantId.toLowerCase()
    const previous = all[id]
    all[id] = {
      tenantId: id,
      enabled: input.enabled,
      frequency: input.frequency,
      time: input.time,
      weekday: input.frequency === "weekly" ? input.weekday : undefined,
      // Changing a schedule does not trigger a catch-up run for slots before the change.
      since: this.now().toISOString(),
      lastRunAt: previous?.lastRunAt,
      lastAttemptAt: previous?.lastAttemptAt,
      attempts: 0,
      lastStatus: previous?.lastStatus,
      lastMessage: previous?.lastMessage,
      nextRunAt: null,
    }
    this.write(all)
    return this.list().find((s) => s.tenantId === id)!
  }

  remove(tenantId: string): void {
    const all = this.read()
    delete all[tenantId.toLowerCase()]
    this.write(all)
  }

  hasEnabled(): boolean {
    return Object.values(this.read()).some((s) => s.enabled)
  }

  /** The next scheduled backup across all tenants. */
  next(): { tenantId: string; at: Date } | null {
    let best: { tenantId: string; at: Date } | null = null
    for (const schedule of Object.values(this.read())) {
      const at = this.nextRun(schedule)
      if (at && (!best || at < best.at)) best = { tenantId: schedule.tenantId, at }
    }
    return best
  }

  start(): void {
    if (this.timer) return
    // Give sign-in caches and the window a moment before catching up missed backups.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      void this.tick()
    }, 30 * 1000)
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.timer = null
    this.startupTimer = null
  }

  /** Runs every due backup, one after another. Returns when they are done. */
  tick(): Promise<void> {
    if (this.running) return this.running
    this.running = (async () => {
      for (const tenantId of Object.keys(this.read())) {
        const schedule = this.read()[tenantId]
        if (!schedule || !this.isDue(schedule)) continue
        const slot = this.lastSlot(schedule)
        const attempts = this.slotAttempts(schedule, slot) + 1
        const afterFailure = this.attempted(schedule, slot) && schedule.lastStatus === "Failed"
        // A cancellation belongs to its finished slot, and so does any result of an earlier slot: neither
        // describes the new unfinished attempt, including after a restart during it.
        const keepStatus = schedule.lastStatus !== "Cancelled" && this.attempted(schedule, slot)
        // Reserve the attempt before starting work, so quitting during a request cannot reset the budget.
        this.write({
          ...this.read(),
          [tenantId]: {
            ...schedule,
            lastAttemptAt: this.now().toISOString(),
            attemptSlot: slot.toISOString(),
            attempts,
            lastStatus: keepStatus ? schedule.lastStatus : undefined,
            lastMessage: keepStatus ? schedule.lastMessage : undefined,
          },
        })
        const result: ScheduledRunResult = await this.run(schedule.tenantId, afterFailure).catch((error: unknown) => ({
          status: "Failed" as const,
          message: error instanceof Error ? error.message : String(error),
        }))
        const all = this.read()
        const current = all[schedule.tenantId]
        if (current) {
          const at = this.now().toISOString()
          all[schedule.tenantId] = {
            ...current,
            lastRunAt: result.status === "Completed" ? at : current.lastRunAt,
            lastAttemptAt: at,
            attemptSlot: current.since === schedule.since ? slot.toISOString() : current.attemptSlot,
            // Edits made during a backup start a new schedule with a fresh attempt budget.
            attempts: result.status === "Completed" || current.since !== schedule.since ? 0
              : result.status === "Cancelled" || (result.status === "Failed" && result.unreachable) ? attempts - 1 : attempts,
            lastStatus: result.status,
            lastMessage: result.message,
          }
          this.write(all)
        }
      }
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  isDue(schedule: BackupSchedule): boolean {
    if (!schedule.enabled) return false
    const slot = this.lastSlot(schedule)
    if (!this.owed(schedule, slot)) return false
    if (schedule.lastStatus === "Cancelled" && schedule.attemptSlot === slot.toISOString()) return false
    return this.slotAttempts(schedule, slot) < MAX_ATTEMPTS
      && (!this.waitsForRetry(schedule, slot) || this.now().getTime() >= Date.parse(schedule.lastAttemptAt!) + RETRY_MS)
  }

  nextRun(schedule: BackupSchedule): Date | null {
    if (!schedule.enabled) return null
    if (this.isDue(schedule)) return this.now()
    const now = this.now()
    let next = this.slotOn(schedule, now)
    if (next <= now) {
      const reference = new Date(now)
      reference.setDate(reference.getDate() + (schedule.frequency === "weekly" ? 7 : 1))
      next = this.slotOn(schedule, reference)
    }
    const slot = this.lastSlot(schedule)
    if (schedule.lastStatus !== "Cancelled" && this.owed(schedule, slot) && this.slotAttempts(schedule, slot) < MAX_ATTEMPTS && this.waitsForRetry(schedule, slot)) {
      const retry = new Date(Date.parse(schedule.lastAttemptAt!) + RETRY_MS)
      if (retry < next) return retry
    }
    return next
  }

  /** Whether `slot` still needs a backup: it is after the last change to the schedule and the last successful run. */
  private owed(schedule: BackupSchedule, slot: Date): boolean {
    const lastRun = schedule.lastRunAt ? Date.parse(schedule.lastRunAt) : 0
    return slot.getTime() > Date.parse(schedule.since) && slot.getTime() > lastRun
  }

  /** Whether the latest attempt, since the schedule was last changed, belongs to `slot`. */
  private attempted(schedule: BackupSchedule, slot: Date): boolean {
    const lastAttempt = schedule.lastAttemptAt ? Date.parse(schedule.lastAttemptAt) : 0
    return schedule.attemptSlot === slot.toISOString() && lastAttempt > Date.parse(schedule.since)
  }

  private slotAttempts(schedule: BackupSchedule, slot: Date): number {
    return this.attempted(schedule, slot) ? schedule.attempts : 0
  }

  /** A retry waits 15 minutes after a counted attempt, and after a failure that was not counted. */
  private waitsForRetry(schedule: BackupSchedule, slot: Date): boolean {
    return this.slotAttempts(schedule, slot) > 0 || (this.attempted(schedule, slot) && schedule.lastStatus === "Failed")
  }

  /** The most recent slot at or before now, in local time. */
  private lastSlot(schedule: BackupSchedule, reference = this.now()): Date {
    const slot = this.slotOn(schedule, reference)
    if (slot <= reference) return slot
    const previous = new Date(reference)
    previous.setDate(previous.getDate() - (schedule.frequency === "weekly" ? 7 : 1))
    return this.slotOn(schedule, previous)
  }

  /** The slot in the week (weekly) or on the day (daily) of `reference`. */
  private slotOn(schedule: BackupSchedule, reference: Date): Date {
    const [hours, minutes] = schedule.time.split(":").map(Number) as [number, number]
    const slot = new Date(reference)
    if (schedule.frequency === "weekly") slot.setDate(slot.getDate() + ((schedule.weekday ?? 0) - slot.getDay()))
    slot.setHours(hours, minutes, 0, 0)
    return slot
  }

  private read(): Record<string, BackupSchedule> {
    try {
      const parsed: unknown = JSON.parse(this.store.get(KEY) ?? "{}")
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid schedule store")
      const schedules: Record<string, BackupSchedule> = {}
      for (const [id, value] of Object.entries(parsed)) {
        const schedule = parseSchedule(id, value)
        if (schedule) {
          // Records without a slot predate slot tracking; infer it once from their attempt timestamp.
          if (!schedule.attemptSlot && schedule.lastAttemptAt) schedule.attemptSlot = this.lastSlot(schedule, new Date(schedule.lastAttemptAt)).toISOString()
          schedules[id] = schedule
        }
        else console.warn(`[backup-scheduler] Skipping malformed schedule: ${id}`)
      }
      return schedules
    } catch {
      console.warn("[backup-scheduler] Could not read stored schedules.")
      return {}
    }
  }

  private write(all: Record<string, BackupSchedule>): void {
    this.store.set(KEY, JSON.stringify(all))
    this.onChange()
  }
}

const validWeekday = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6
const validDate = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value))

function parseSchedule(id: string, value: unknown): BackupSchedule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  if (typeof entry.tenantId !== "string" || !entry.tenantId || entry.tenantId !== id || id !== id.toLowerCase()
    || typeof entry.enabled !== "boolean" || (entry.frequency !== "daily" && entry.frequency !== "weekly")
    || typeof entry.time !== "string" || !VALID_TIME.test(entry.time) || !validDate(entry.since)
    || (entry.frequency === "weekly" && !validWeekday(entry.weekday))
    || (entry.weekday !== undefined && !validWeekday(entry.weekday))
    || (entry.lastRunAt !== undefined && !validDate(entry.lastRunAt))
    || (entry.lastAttemptAt !== undefined && !validDate(entry.lastAttemptAt))
    || (entry.attemptSlot !== undefined && !validDate(entry.attemptSlot))
    || (entry.lastStatus !== undefined && entry.lastStatus !== "Completed" && entry.lastStatus !== "Failed" && entry.lastStatus !== "Cancelled")
    || (entry.lastMessage !== undefined && typeof entry.lastMessage !== "string")
    || (entry.attempts !== undefined && (typeof entry.attempts !== "number" || !Number.isInteger(entry.attempts) || entry.attempts < 0 || entry.attempts > MAX_ATTEMPTS))) return null

  const schedule = entry as unknown as BackupSchedule
  // Older versions recorded failed attempts as lastRunAt. Preserve the failure without calling it a success.
  const legacyFailure = schedule.lastAttemptAt === undefined && schedule.lastStatus === "Failed"
  return {
    ...schedule,
    lastRunAt: legacyFailure ? undefined : schedule.lastRunAt,
    lastAttemptAt: schedule.lastAttemptAt ?? schedule.lastRunAt,
    attempts: schedule.attempts ?? (legacyFailure ? 1 : 0),
    nextRunAt: null,
  }
}
