import { useEffect, useState } from "react"
import type { BackupRefusal, BackupSchedule } from "../../shared/ipc"
import { bridge } from "./bridge"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface SchedulesState {
  schedules: BackupSchedule[]
  /** The last read failure. While set, `schedules` may be stale or empty, never "no schedules". */
  error: string | null
  /** True until the first read (or change event) settles. Callers must not save over unknown state. */
  loading: boolean
  reload: () => void
}

/** Live list of backup schedules from the main process. */
export function useSchedules(): SchedulesState {
  const [schedules, setSchedules] = useState<BackupSchedule[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloads, setReloads] = useState(0)
  useEffect(() => {
    let cancelled = false
    // A change event carries fresher data than a read still in flight, so it supersedes it:
    // the older read must then neither overwrite the list nor resurrect an error.
    let generation = 0
    const mine = ++generation
    bridge.schedules.list().then(
      (next) => { if (!cancelled && generation === mine) { setSchedules(next); setError(null); setLoading(false) } },
      (failure: unknown) => { if (!cancelled && generation === mine) { setError(errorMessage(failure)); setLoading(false) } },
    )
    const unsubscribe = bridge.schedules.onChanged((next) => { generation++; setSchedules(next); setError(null); setLoading(false) })
    return () => { cancelled = true; unsubscribe() }
  }, [reloads])
  return { schedules, error, loading, reload: () => setReloads((count) => count + 1) }
}

export interface RefusalsState {
  refusals: BackupRefusal[]
  /** The last read failure. While set, `refusals` may be stale or empty, never "none". */
  error: string | null
  reload: () => void
}

/** Backups refused for the tenant's license, newest first, kept on this device. */
export function useRefusals(tenantId: string): RefusalsState {
  const [refusals, setRefusals] = useState<BackupRefusal[]>([])
  const [error, setError] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  useEffect(() => {
    let cancelled = false
    // Only the newest read may settle state: an older read finishing after a change-triggered
    // one must neither overwrite its result nor resurrect its error.
    let generation = 0
    const load = () => {
      const mine = ++generation
      bridge.schedules.refusals(tenantId).then(
        (next) => { if (!cancelled && generation === mine) { setRefusals(next); setError(null) } },
        (failure: unknown) => { if (!cancelled && generation === mine) setError(errorMessage(failure)) },
      )
    }
    load()
    const unsubscribe = bridge.schedules.onRefusalsChanged(load)
    return () => { cancelled = true; unsubscribe() }
  }, [tenantId, reloads])
  return { refusals, error, reload: () => setReloads((count) => count + 1) }
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

export function describeSchedule(schedule: BackupSchedule): string {
  if (!schedule.enabled) return "Off"
  return schedule.frequency === "daily"
    ? `Daily at ${schedule.time}`
    : `Every ${WEEKDAYS[schedule.weekday ?? 0]} at ${schedule.time}`
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(new Date(iso).getTime())) return "Not scheduled"
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })
}
