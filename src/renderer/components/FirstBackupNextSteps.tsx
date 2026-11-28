import { useEffect, useState } from "react"
import { onboardingLink } from "./OnboardingCard"
import type { Plan } from "../../shared/plans"
import type { ScheduleInput } from "../../shared/ipc"
import { bridge } from "../lib/bridge"
import { showFeaturePlanError } from "../lib/plan-dialog"
import { describeSchedule } from "../lib/schedules"

/** The schedule the guided setup offers: weekly on Community, daily on the paid plans, at 02:00. */
export function suggestedSchedule(tenantId: string, plan: Plan | null): ScheduleInput {
  return plan && plan !== "community"
    ? { tenantId, enabled: true, frequency: "daily", time: "02:00" }
    : { tenantId, enabled: true, frequency: "weekly", time: "02:00", weekday: 0 }
}

/**
 * After the first successful backup: turn on automatic backups and, for backups on this device,
 * save the recovery key so they stay readable after a reinstall or on another computer. Azure
 * backups do not depend on the key, so that step is left out for them.
 */
export function FirstBackupNextSteps({ tenantId, plan, local }: { tenantId: string; plan: Plan | null; local: boolean }) {
  const [schedule, setSchedule] = useState<string | null>(null)
  const [scheduling, setScheduling] = useState(false)
  const [scheduleError, setScheduleError] = useState("")
  const [recoverySaved, setRecoverySaved] = useState<boolean | null>(null)
  const [savingKey, setSavingKey] = useState(false)
  const [keyError, setKeyError] = useState("")
  const suggestion = suggestedSchedule(tenantId, plan)

  useEffect(() => {
    let active = true
    void bridge.schedules.list().then((list) => {
      const current = list.find((item) => item.tenantId === tenantId.toLowerCase())
      if (active && current?.enabled) setSchedule(describeSchedule(current))
    }).catch(() => undefined)
    if (local) {
      void bridge.backups.settings().then((settings) => {
        if (active) setRecoverySaved(settings.recoveryExported)
      }).catch(() => { if (active) setRecoverySaved(false) })
    }
    return () => { active = false }
  }, [tenantId, local])

  const turnOn = async () => {
    setScheduling(true)
    setScheduleError("")
    try {
      const list = await bridge.schedules.set(suggestion)
      const saved = list.find((item) => item.tenantId === tenantId.toLowerCase())
      setSchedule(saved ? describeSchedule(saved) : suggestion.frequency === "daily" ? "Daily at 02:00" : "Every Sunday at 02:00")
    } catch (error) {
      showFeaturePlanError(error, [])
      setScheduleError(error instanceof Error ? error.message : String(error))
    } finally {
      setScheduling(false)
    }
  }

  const saveKey = async () => {
    setSavingKey(true)
    setKeyError("")
    try {
      const result = await bridge.backups.exportRecoveryKey()
      if (result.saved) setRecoverySaved(true)
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingKey(false)
    }
  }

  return (
    <section aria-label="Next steps" className="space-y-2">
      <div className="flex flex-wrap justify-center gap-x-5 gap-y-2">
        {schedule
          ? <p role="status" className="text-xs text-green-700 dark:text-green-400">Automatic backups are on. {schedule}.</p>
          : <button type="button" className={onboardingLink} onClick={() => void turnOn()} disabled={scheduling || plan === null}>
              {scheduling ? "Turning on backups…" : suggestion.frequency === "daily" ? "Turn on daily backups" : "Turn on weekly backups"}
            </button>}
        {local && recoverySaved !== null && (recoverySaved
          ? <p role="status" className="text-xs text-green-700 dark:text-green-400">Your recovery key is saved.</p>
          : <button type="button" className={onboardingLink} onClick={() => void saveKey()} disabled={savingKey}>
              {savingKey ? "Saving recovery key…" : "Save your recovery key"}
            </button>)}
      </div>
      {scheduleError && <p role="alert" className="text-sm text-red-700">{scheduleError}</p>}
      {keyError && <p role="alert" className="text-sm text-red-700">{keyError}</p>}
    </section>
  )
}
