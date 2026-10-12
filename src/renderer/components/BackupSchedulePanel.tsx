import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { AlertCircle, AlertTriangle, CalendarClock, CheckCircle2, Info, Layers, Loader2, ShieldAlert } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Label } from "~/components/ui/label"
import type { AppPreferences } from "../../shared/ipc"
import { COMMUNITY_RETENTION_DAYS } from "../../shared/plans"
import { bridge } from "../lib/bridge"
import { tenantLicense, tenantPlan, useLicense } from "../lib/license"
import { describeSchedule, formatWhen, useRefusals, useSchedules, WEEKDAYS } from "../lib/schedules"
import { toast } from "../lib/toast"
import { weeklyScheduleNote } from "../lib/plan-notes"
import { PlanBadge, UpgradeNote } from "./UpgradeNote"
import { BackupScopePicker } from "./BackupScopePicker"
import { describeScope, includedTypes, normalizeScope, type BackupScope } from "../../shared/intune/scope"

const REFUSALS_SHOWN = 5

interface BackupSchedulePanelProps {
  tenantId: string
  tenantName: string
}

/** Automatic backups for one tenant, run by TenuVault itself (window or tray). */
type Draft = { enabled: boolean; frequency: "daily" | "weekly"; time: string; weekday: number }
const drafts = new Map<string, Draft>()

export function BackupSchedulePanel(props: BackupSchedulePanelProps) {
  return <TenantSchedule key={props.tenantId.toLowerCase()} {...props} />
}

function TenantSchedule({ tenantId, tenantName }: BackupSchedulePanelProps) {
  const schedules = useSchedules()
  const { status } = useLicense()
  const license = tenantLicense(status, tenantId)
  const plan = tenantPlan(license)
  const planKnown = plan !== null
  // Community schedules weekly backups only and keeps 30 days of history.
  const community = plan === "community"
  const current = schedules.find((s) => s.tenantId === tenantId.toLowerCase())
  const refusals = useRefusals(tenantId)
  const [enabled, setEnabled] = useState(false)
  const [frequency, setFrequency] = useState<"daily" | "weekly">("weekly")
  const [time, setTime] = useState("02:00")
  const [weekday, setWeekday] = useState(0)
  const [saving, setSaving] = useState(false)
  const [prefs, setPrefs] = useState<AppPreferences | null>(null)
  const [runner, setRunner] = useState<{ installed: boolean } | null>(null)
  const [timeError, setTimeError] = useState(false)
  const timeInput = useRef<HTMLInputElement>(null)

  useEffect(() => void bridge.preferences.get().then(setPrefs), [])
  useEffect(() => void bridge.backgroundLaunch.status().then(setRunner).catch(() => undefined), [])
  useEffect(() => {
    const draft = drafts.get(tenantId)
    setEnabled(draft?.enabled ?? current?.enabled ?? false)
    setFrequency(draft?.frequency ?? current?.frequency ?? (planKnown && !community ? "daily" : "weekly"))
    setTime(draft?.time ?? current?.time ?? "02:00")
    setWeekday(draft?.weekday ?? current?.weekday ?? 0)
  }, [tenantId, community, planKnown, current?.enabled, current?.frequency, current?.time, current?.weekday])

  const dirty =
    enabled !== (current?.enabled ?? false) ||
    (enabled && (frequency !== current?.frequency || time !== current?.time || (frequency === "weekly" && weekday !== current?.weekday)))

  const save = async () => {
    if (enabled && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      setTimeError(true)
      timeInput.current?.focus()
      return
    }
    setTimeError(false)
    setSaving(true)
    try {
      await bridge.schedules.set({ tenantId, enabled, frequency, time, weekday: frequency === "weekly" ? weekday : undefined })
      drafts.delete(tenantId)
      toast(enabled ? "Schedule saved" : "Automatic backups paused", "success")
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error")
    } finally {
      setSaving(false)
    }
  }

  const setPreference = async (changes: Partial<AppPreferences>) => setPrefs(await bridge.preferences.set(changes))

  const select = "h-10 rounded-full border border-gray-300 bg-white px-4 text-sm"

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
      <div className="space-y-5 rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        <div className="flex items-center gap-3">
          <span className="flex size-10 flex-shrink-0 items-center justify-center rounded-full bg-coral-500 text-white" aria-hidden="true">
            <CalendarClock className="h-[18px] w-[18px]" />
          </span>
          <h2 className="text-2xl font-medium tracking-tight text-gray-900">Automatic backups</h2>
        </div>

        <label className="flex items-center gap-3 text-sm text-gray-800">
          <input type="checkbox" className="h-4 w-4" checked={enabled} onChange={(e) => (drafts.set(tenantId, { enabled: e.target.checked, frequency, time, weekday }), setEnabled(e.target.checked))} />
          Back up {tenantName} automatically
        </label>

        {enabled && (
          <div className="flex flex-wrap items-start gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="schedule-frequency" className="flex items-center gap-2">Repeat{!planKnown && <span className="text-xs text-gray-500">{license ? "Plan not verified" : "Checking plan"}</span>}{community && <PlanBadge feature="dailySchedule" />}</Label>
              {!planKnown && frequency === "daily" ? <output id="schedule-frequency" className="block text-sm text-gray-700">Every day</output> : <select id="schedule-frequency" className={select} value={frequency} onChange={(e) => (drafts.set(tenantId, { enabled, frequency: e.target.value as "daily" | "weekly", time, weekday }), setFrequency(e.target.value as "daily" | "weekly"))}>
                {planKnown && <option value="daily" disabled={community}>{community ? "Every day (Pro)" : "Every day"}</option>}
                <option value="weekly">Every week</option>
              </select>}
            </div>
            {frequency === "weekly" && (
              <div className="space-y-1.5">
                <Label htmlFor="schedule-weekday" className="block">Day</Label>
                <select id="schedule-weekday" className={select} value={weekday} onChange={(e) => (drafts.set(tenantId, { enabled, frequency, time, weekday: Number(e.target.value) }), setWeekday(Number(e.target.value)))}>
                  {WEEKDAYS.map((day, index) => (
                    <option key={day} value={index}>
                      {day}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="schedule-time" className="block">Time ({Intl.DateTimeFormat().resolvedOptions().timeZone})</Label>
              <input ref={timeInput} id="schedule-time" type="time" className={select} value={time} aria-invalid={timeError || undefined} aria-describedby={timeError ? "schedule-time-error" : undefined} onChange={(e) => (drafts.set(tenantId, { enabled, frequency, time: e.target.value, weekday }), setTime(e.target.value), setTimeError(false))} />
              {timeError && <p id="schedule-time-error" className="text-xs text-red-600">Choose a time, for example 07:45.</p>}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <Button disabled={!dirty || saving || (enabled && frequency === "daily" && !planKnown)} onClick={() => void save()}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
            {current && (!dirty || !enabled) && <span className="text-sm text-gray-500">{describeSchedule(!enabled ? { ...current, enabled: true } : current)}</span>}
          </div>
          {current && runner?.installed === false && <p className="text-xs text-gray-500">Background restart is not installed. Backups run while TenuVault is running.</p>}
        </div>

        {community && (current?.frequency === "daily" || enabled) && (
          <div className="space-y-2">
            <UpgradeNote feature="dailySchedule" />
            <p className="text-sm text-gray-500">{weeklyScheduleNote(plan)}</p>
          </div>
        )}

        {license && !license.entitled && (
          <div className="flex gap-3 rounded-3xl bg-amber-50 px-5 py-4 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p>
              Your license does not cover {tenantName} right now, so its automatic backups do not run.{" "}
              <Link to="/license" className="font-medium underline">
                Open License
              </Link>
            </p>
          </div>
        )}

        <div className="flex gap-3 rounded-3xl bg-gray-50 px-5 py-4 text-sm text-gray-700">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <p>
            Backups run while TenuVault is running: in the window or in the system tray after you close it. A backup missed
            while the computer was off runs as soon as TenuVault starts again. Times follow this computer’s local timezone, including daylight saving and timezone changes.
          </p>
        </div>
        <div className="space-y-2 border-t border-gray-100 pt-5 text-sm text-gray-700">
          <h3 className="font-medium text-gray-900">Background runner</h3>
          <Link to="/portal/settings" className="font-medium underline">Settings &gt; Background runner</Link>
          {prefs && <>
            <p className="text-xs text-gray-500">Saved automatically for all tenants.</p>
            <label className="flex items-center gap-3">
              <input type="checkbox" className="h-4 w-4" checked={prefs.startAtLogin} onChange={(e) => void setPreference({ startAtLogin: e.target.checked })} />
              Start TenuVault in the tray when I sign in to this computer
            </label>
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={prefs.keepRunningInTray}
                onChange={(e) => void setPreference({ keepRunningInTray: e.target.checked })}
              />
              Keep running in the tray when I close the window
            </label>
          </>}
        </div>
      </div>
      <BackupScopeSettings tenantId={tenantId} tenantName={tenantName} />
      </div>

      <div className="space-y-5 self-start rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        <h3 className="text-xl font-medium tracking-tight text-gray-900">Status</h3>
        <dl className="space-y-4 text-sm">
          <div>
            <dt className="text-xs text-gray-500">Next backup</dt>
            <dd className="mt-0.5 text-base text-gray-900">{formatWhen(current?.nextRunAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">{current?.lastStatus === "Failed" ? "Last automatic backup attempt failed" : "Last automatic backup"}</dt>
            <dd className="mt-0.5 flex items-start gap-2 text-base text-gray-900">
              {current?.lastAttemptAt ? (
                <>
                  {current.lastStatus === "Completed" ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" />
                  ) : (
                    <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600" />
                  )}
                  <span>
                    {formatWhen(current.lastAttemptAt)}
                    {current.lastMessage && <span className="block text-xs text-gray-500">{current.lastMessage}</span>}
                  </span>
                </>
              ) : (
                "None yet"
              )}
            </dd>
          </div>
          {prefs && (
            <div>
              <dt className="text-xs text-gray-500">Kept for</dt>
              <dd className="mt-0.5 text-base text-gray-900">
                {community
                  ? `${prefs.retentionDays === 0 ? COMMUNITY_RETENTION_DAYS : Math.min(prefs.retentionDays, COMMUNITY_RETENTION_DAYS)} days (Community)`
                  : prefs.retentionDays === 0 ? "Forever" : `${prefs.retentionDays} days (change in Settings)`}
              </dd>
            </div>
          )}
          {refusals.length > 0 && (
            <div>
              <dt className="text-xs text-gray-500">Not backed up because of the license</dt>
              <dd>
                <ul className="mt-1 space-y-2">
                  {refusals.slice(0, REFUSALS_SHOWN).map((refusal) => (
                    <li key={`${refusal.at}-${refusal.trigger}`} className="flex items-start gap-2 text-gray-900">
                      <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
                      <span>
                        {formatWhen(refusal.at)}, {refusal.trigger === "tray" ? "from the tray" : "scheduled"}
                        <span className="block text-xs text-gray-500">{refusal.reason}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {refusals.length > REFUSALS_SHOWN && (
                  <p className="mt-1 text-xs text-gray-500">and {refusals.length - REFUSALS_SHOWN} earlier</p>
                )}
              </dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  )
}

/** What the tenant backs up automatically, and the starting point of manual backups. */
function BackupScopeSettings({ tenantId, tenantName }: BackupSchedulePanelProps) {
  const [saved, setSaved] = useState<BackupScope | null>(null)
  const [isSaved, setIsSaved] = useState(false)
  const [scope, setScope] = useState<BackupScope | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void bridge.backups.scope(tenantId).then((setting) => {
      setSaved(setting.scope)
      setScope(setting.scope)
      setIsSaved(setting.saved)
    })
  }, [tenantId])

  if (!scope || !saved) return null
  const dirty = normalizeScope(scope).excluded.join() !== normalizeScope(saved).excluded.join()
  const empty = includedTypes(scope).length === 0

  const save = async () => {
    setSaving(true)
    try {
      const setting = await bridge.backups.setScope(tenantId, scope)
      setSaved(setting.scope)
      setIsSaved(true)
      toast(`${tenantName} now backs up: ${describeScope(setting.scope).toLowerCase()}.`, "success")
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5 rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div className="flex items-center gap-3">
        <span className="flex size-10 flex-shrink-0 items-center justify-center rounded-full bg-coral-500 text-white" aria-hidden="true">
          <Layers className="h-[18px] w-[18px]" />
        </span>
        <div>
          <h2 className="text-2xl font-medium tracking-tight text-gray-900">What to back up</h2>
          <p className="text-sm text-gray-500">
            Used by automatic backups and "Back up all tenants now", and preselected when you run a backup by hand.
          </p>
        </div>
      </div>
      <BackupScopePicker value={scope} onChange={setScope} disabled={saving} />
      <div className="flex items-center gap-3">
        <Button disabled={!dirty || empty || saving} onClick={() => void save()}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save
        </Button>
        {!dirty && <span className="text-sm text-gray-500">{isSaved ? describeScope(saved) : `${describeScope(saved)} (default)`}</span>}
        {empty && <span className="text-sm text-red-600">Choose at least one type.</span>}
      </div>
    </div>
  )
}
