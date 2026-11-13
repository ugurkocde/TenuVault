import { useEffect, useState } from "react"
import { CalendarClock, CheckCircle2, KeyRound, Loader2 } from "lucide-react"
import { Button } from "~/components/ui/button"
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

function NextStep({ icon, title, done, children }: { icon: React.ReactNode; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-4 rounded-3xl bg-gray-50 p-5">
      <span className={done ? "flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-green-100 text-green-700" : "flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-card"} aria-hidden="true">
        {done ? <CheckCircle2 className="h-4 w-4" /> : icon}
      </span>
      <div className="min-w-0 flex-1 space-y-2 text-sm text-gray-700">
        <p className="font-medium text-gray-900">{title}</p>
        {children}
      </div>
    </li>
  )
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

  const label = suggestion.frequency === "daily" ? "Back up daily at 02:00" : "Back up every Sunday at 02:00"

  return (
    <section aria-labelledby="next-steps-heading" className="space-y-3">
      <h3 id="next-steps-heading" className="text-base font-medium text-gray-900">Next steps</h3>
      <ul className="space-y-3">
        <NextStep icon={<CalendarClock className="h-4 w-4" />} title="Turn on automatic backups" done={schedule !== null}>
          {schedule ? (
            <p role="status">Automatic backups are on: {schedule}. Change the day and time in Backup &amp; Restore, Schedule.</p>
          ) : (
            <>
              <p>
                Set up a scheduled backup so you have a restore point for the next loss. TenuVault backs up while it is open or in the tray. A backup missed while the computer was off runs the next
                time TenuVault starts.
              </p>
              {/* Until the plan is known the suggestion could be weekly for a tenant that gets daily backups. */}
              <Button type="button" size="sm" onClick={() => void turnOn()} disabled={scheduling || plan === null}>
                {scheduling && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {label}
              </Button>
            </>
          )}
          {scheduleError && <p role="alert" className="text-red-700">{scheduleError}</p>}
        </NextStep>
        {local && recoverySaved !== null && (
          <NextStep icon={<KeyRound className="h-4 w-4" />} title="Save your recovery key" done={recoverySaved}>
            {recoverySaved ? (
              <p role="status">Your recovery key is saved. Keep it somewhere safe, such as your password manager.</p>
            ) : (
              <>
                <p>
                  Backups on this device are encrypted with a key protected by your Windows or macOS account. Without the recovery key, they
                  cannot be read after a reinstall or on another computer.
                </p>
                <Button type="button" size="sm" variant="outline" onClick={() => void saveKey()} disabled={savingKey}>
                  {savingKey && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                  Save recovery key
                </Button>
              </>
            )}
            {keyError && <p role="alert" className="text-red-700">{keyError}</p>}
          </NextStep>
        )}
      </ul>
    </section>
  )
}
