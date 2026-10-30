import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { AlertCircle, AlertTriangle, CalendarClock, CheckCircle2, Cloud, Database, HardDrive, Info, Layers, Loader2, Monitor, ShieldAlert } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { Label } from "~/components/ui/label"
import type { Tenant } from "~/contexts/TenantContext"
import { storageLabel } from "~/lib/storage-label"
import type { AppPreferences, BackupReaderState, BackupSettings } from "../../shared/ipc"
import { LOCAL_STORAGE_PREFIX } from "../../shared/constants"
import { describeCloudSchedule, nextRunsInZone } from "../../shared/cloud-backup"
import { COMMUNITY_RETENTION_DAYS } from "../../shared/plans"
import { bridge } from "../lib/bridge"
import { useCloudBackup } from "../lib/cloud-backup"
import { tenantLicense, tenantPlan, useLicense } from "../lib/license"
import { describeSchedule, formatWhen, useRefusals, useSchedules, WEEKDAYS } from "../lib/schedules"
import { settingsHref } from "../lib/settings-section"
import { scheduledIdentity } from "../lib/backup-reader-view"
import { showFeaturePlanError } from "../lib/plan-dialog"
import type { StorageChoice } from "../lib/storage"
import { toast } from "../lib/toast"
import { weeklyScheduleNote } from "../lib/plan-notes"
import { PlanBadge, UpgradeNote } from "./UpgradeNote"
import { BackupScopePicker } from "./BackupScopePicker"
import { CloudBackupSettings } from "./CloudBackupSettings"
import { StorageChooser, type StorageChooserDraft } from "./StorageChooser"
import { describeScope, includedTypes, normalizeScope, type BackupScope } from "../../shared/intune/scope"

const REFUSALS_SHOWN = 5

interface BackupSchedulePanelProps {
  tenantId: string
  tenantName: string
  /** The tenant profile, for its storage choice and cloud status reads. */
  tenant?: Tenant | null
  /** Persists a new storage choice on the tenant profile (the page owns tenant state). */
  onStorageChange?: (tenant: Tenant, choice: StorageChoice) => void
}

/** Automatic backups for one tenant, run by TenuVault itself (window or tray). */
type Draft = { enabled: boolean; frequency: "daily" | "weekly"; time: string; weekday: number }
const drafts = new Map<string, Draft>()

export function BackupSchedulePanel(props: BackupSchedulePanelProps) {
  return <TenantSchedule key={props.tenantId.toLowerCase()} {...props} />
}

function TenantSchedule({ tenantId, tenantName, tenant: tenantProp, onStorageChange }: BackupSchedulePanelProps) {
  const tenant = tenantProp ?? null
  const cloud = useCloudBackup(tenant, tenantId)
  const [runnerChoice, setRunnerChoice] = useState<"computer" | "azure" | null>(null)
  const runnerKind = runnerChoice ?? (cloud.config?.linked ? "azure" : "computer")
  const { schedules, error: schedulesError, loading: schedulesLoading, reload: reloadSchedules } = useSchedules()
  const { status } = useLicense()
  const license = tenantLicense(status, tenantId)
  const plan = tenantPlan(license)
  const planKnown = plan !== null
  // Community schedules weekly backups only and keeps 30 days of history.
  const community = plan === "community"
  const current = schedules.find((s) => s.tenantId === tenantId.toLowerCase())
  const { refusals, error: refusalsError } = useRefusals(tenantId)
  const [enabled, setEnabled] = useState(false)
  const [frequency, setFrequency] = useState<"daily" | "weekly">("weekly")
  const [time, setTime] = useState("02:00")
  const [weekday, setWeekday] = useState(0)
  const [saving, setSaving] = useState(false)
  const [prefs, setPrefs] = useState<AppPreferences | null>(null)
  const [prefsError, setPrefsError] = useState<string | null>(null)
  const [prefsSaveError, setPrefsSaveError] = useState<string | null>(null)
  const [runner, setRunner] = useState<{ installed: boolean } | null>(null)
  const [readerState, setReaderState] = useState<BackupReaderState | null>(null)
  const [timeError, setTimeError] = useState(false)
  const timeInput = useRef<HTMLInputElement>(null)

  const loadPrefs = () => {
    setPrefsError(null)
    bridge.preferences.get().then(setPrefs, (error: unknown) => setPrefsError(error instanceof Error ? error.message : String(error)))
  }
  useEffect(loadPrefs, [])
  useEffect(() => void bridge.backgroundLaunch.status().then(setRunner).catch(() => undefined), [])
  useEffect(() => void bridge.backupReader.status(tenantId).then(setReaderState).catch(() => undefined), [tenantId])
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

  const dailyExplained = community && (current?.frequency === "daily" || (enabled && frequency === "daily"))

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
      showFeaturePlanError(error, dailyExplained ? ["dailySchedule"] : [])
      toast(error instanceof Error ? error.message : String(error), "error")
    } finally {
      setSaving(false)
    }
  }

  const setPreference = async (changes: Partial<AppPreferences>) => {
    setPrefsSaveError(null)
    try {
      setPrefs(await bridge.preferences.set(changes))
    } catch (error) {
      setPrefsSaveError(error instanceof Error ? error.message : String(error))
    }
  }

  const weeklyMessage = weeklyScheduleNote(plan, !!(current?.enabled && current.frequency === "weekly") || (enabled && frequency === "weekly"))
  const select = "h-10 rounded-full border border-gray-300 bg-white px-4 text-sm"
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const nextComputerRuns = useMemo(
    () => (enabled ? nextRunsInZone({ frequency, time, weekday }, localTimeZone, new Date(), 4) : []),
    [enabled, frequency, time, weekday, localTimeZone],
  )
  const bothRunners = !!(current?.enabled && cloud.config?.linked)

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
      <TenantStorageSettings tenant={tenant} tenantName={tenantName} prefs={prefs} community={community} onStorageChange={onStorageChange} />
      <BackupScopeSettings tenantId={tenantId} tenantName={tenantName} />
      <div className="space-y-5 rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        <div className="flex items-center gap-3">
          <span className="flex size-10 flex-shrink-0 items-center justify-center rounded-full bg-coral-500 text-white" aria-hidden="true">
            <CalendarClock className="h-[18px] w-[18px]" />
          </span>
          <div>
            <p className="text-xs font-medium tracking-wide text-gray-400 uppercase">Step 3 · Where backups run</p>
            <h2 className="text-2xl font-medium tracking-tight text-gray-900">Automatic backups</h2>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Where automatic backups run">
          <button
            type="button"
            role="radio"
            aria-checked={runnerKind === "computer"}
            onClick={() => setRunnerChoice("computer")}
            className={`flex items-start gap-3 rounded-3xl border-2 p-4 text-left ${runnerKind === "computer" ? "border-coral-500 bg-coral-500/10" : "border-gray-200 bg-white"}`}
          >
            <Monitor className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden="true" />
            <span>
              <span className="block font-medium text-gray-900">On this computer</span>
              <span className="block text-xs text-gray-500">
                TenuVault runs the backup itself, in the window or the tray, signed in as you.
                {current?.enabled ? ` ${describeSchedule(current)}.` : ""}
              </span>
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={runnerKind === "azure"}
            onClick={() => setRunnerChoice("azure")}
            className={`flex items-start gap-3 rounded-3xl border-2 p-4 text-left ${runnerKind === "azure" ? "border-coral-500 bg-coral-500/10" : "border-gray-200 bg-white"}`}
          >
            <Cloud className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden="true" />
            <span>
              <span className="block font-medium text-gray-900">In Azure, no computer needed</span>
              <span className="block text-xs text-gray-500">
                A runbook in your own Azure Automation account, with a read-only managed identity.
                {cloud.config ? ` ${describeCloudSchedule(cloud.config)}.` : " Needs Pro or MSP and Azure storage."}
              </span>
            </span>
          </button>
        </div>

        {bothRunners && (
          <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Both runners are on: this computer ({describeSchedule(current!)}) and Azure
            {cloud.config ? ` (${describeCloudSchedule(cloud.config)})` : ""} each make their own backups into the same
            storage. That is safe, but usually one is enough. Pause the one you do not want.
          </p>
        )}

        {runnerKind === "azure" ? (
          <CloudBackupSettings tenant={tenant} community={community} cloud={cloud} />
        ) : (
        <>

        {schedulesError && (
          <div className="flex flex-wrap items-center gap-3 rounded-3xl bg-red-50 px-5 py-4">
            <p role="alert" className="text-sm text-red-700">Could not load the saved schedule: {schedulesError} Saving is paused so the saved schedule is not overwritten.</p>
            <Button variant="outline" size="sm" onClick={reloadSchedules}>Try again</Button>
          </div>
        )}

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
                <div className="flex gap-1" role="group" aria-label="Day of the week">
                  {WEEKDAYS.map((day, index) => (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={weekday === index}
                      aria-label={day}
                      onClick={() => (drafts.set(tenantId, { enabled, frequency, time, weekday: index }), setWeekday(index))}
                      className={`flex size-10 items-center justify-center rounded-full border text-sm ${weekday === index ? "border-coral-500 bg-coral-500 text-white" : "border-gray-300 bg-white text-gray-700"}`}
                    >
                      {day.slice(0, 2)}
                    </button>
                  ))}
                </div>
                <select id="schedule-weekday" className="sr-only" value={weekday} onChange={(e) => (drafts.set(tenantId, { enabled, frequency, time, weekday: Number(e.target.value) }), setWeekday(Number(e.target.value)))} tabIndex={-1} aria-hidden="true">
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
            <Button disabled={!dirty || saving || schedulesLoading || !!schedulesError || (enabled && frequency === "daily" && !planKnown)} onClick={() => void save()}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
            {current && (!dirty || !enabled) && <span className="text-sm text-gray-500">{describeSchedule(!enabled ? { ...current, enabled: true } : current)}</span>}
          </div>
          {current && runner?.installed === false && <p className="text-xs text-gray-500">Background restart is not installed. Backups run while TenuVault is running.</p>}
        </div>

        {dailyExplained && <UpgradeNote feature="dailySchedule" />}
        {weeklyMessage && <p className="text-sm text-gray-500">{weeklyMessage}</p>}

        {license && !tenantPlan(license) && (
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

        {nextComputerRuns.length > 0 && (
          <div className="rounded-3xl bg-gray-50 px-5 py-4 text-sm text-gray-700">
            <p className="font-medium text-gray-900">Upcoming backups on this computer</p>
            <ul className="mt-1 space-y-0.5">
              {nextComputerRuns.map((run) => (
                <li key={run.toISOString()}>
                  {run.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </li>
              ))}
            </ul>
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
          <h3 className="font-medium text-gray-900">Sign-in at night</h3>
          <p>
            {scheduledIdentity(readerState?.reader ?? null) === "reader"
              ? "Scheduled backups on this computer read Intune as the read-only Backup Reader, so Conditional Access sign-in frequency cannot stop them. Manual backups, restores and every change still use your own sign-in."
              : "Scheduled backups on this computer run as you. When a Conditional Access sign-in frequency policy ends your session at night, they stop until you sign in again. The optional Backup Reader (Pro and MSP) reads Intune for scheduled backups only, with its own read-only app registration and a certificate on this computer."}{" "}
            <Link to={settingsHref("background")} className="font-medium underline">Backup Reader settings</Link>
          </p>
        </div>
        <div className="space-y-2 border-t border-gray-100 pt-5 text-sm text-gray-700">
          <h3 className="font-medium text-gray-900">Background runner</h3>
          <Link to={settingsHref("background")} className="font-medium underline">Settings &gt; Background runner</Link>
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
            {prefsSaveError && <p role="alert" className="text-xs text-red-600">Could not save the background runner setting: {prefsSaveError}</p>}
          </>}
          {prefsError && (
            <div className="flex flex-wrap items-center gap-3">
              <p role="alert" className="text-xs text-red-600">Could not load the background runner settings: {prefsError}</p>
              <Button variant="outline" size="sm" onClick={loadPrefs}>Try again</Button>
            </div>
          )}
        </div>
        </>
        )}
      </div>
      </div>

      <div className="space-y-5 self-start rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        <h3 className="text-xl font-medium tracking-tight text-gray-900">Status</h3>
        <dl className="space-y-4 text-sm">
          <div>
            <dt className="text-xs text-gray-500">Scheduled backups run as</dt>
            <dd className="mt-0.5 text-base text-gray-900">
              {scheduledIdentity(readerState?.reader ?? null) === "reader" ? (
                <>
                  Backup Reader (read-only)
                  <span className="block text-xs text-gray-500">
                    {readerState?.reader?.lastRun
                      ? `Last run with the reader: ${readerState.reader.lastRun.status.toLowerCase()}, ${formatWhen(readerState.reader.lastRun.at)}.`
                      : `Certificate valid until ${formatWhen(readerState?.reader?.notAfter)}.`}{" "}
                    <Link to={settingsHref("background")} className="font-medium underline">Backup Reader settings</Link>
                  </span>
                </>
              ) : scheduledIdentity(readerState?.reader ?? null) === "expired" ? (
                <>
                  You (your sign-in)
                  <span className="block text-xs text-gray-500">
                    The Backup Reader certificate expired. <Link to={settingsHref("background")} className="font-medium underline">Renew it in Settings</Link>
                  </span>
                </>
              ) : scheduledIdentity(readerState?.reader ?? null) === "waiting" ? (
                <>
                  You (your sign-in)
                  <span className="block text-xs text-gray-500">
                    Backup Reader setup is waiting. <Link to={settingsHref("background")} className="font-medium underline">Finish it in Settings</Link>
                  </span>
                </>
              ) : (
                <>
                  You (your sign-in)
                  {readerState?.available && (
                    <span className="block text-xs text-gray-500">
                      If sign-in frequency ends your session at night, the <Link to={settingsHref("background")} className="font-medium underline">Backup Reader</Link> keeps these backups running.
                    </span>
                  )}
                </>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Next backup</dt>
            <dd className="mt-0.5 text-base text-gray-900">{formatWhen(current?.nextRunAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">{current?.lastStatus === "Cancelled" ? "Last automatic backup cancelled" : current?.lastStatus === "Failed" ? "Last automatic backup attempt failed" : "Last automatic backup"}</dt>
            <dd className="mt-0.5 flex items-start gap-2 text-base text-gray-900">
              {current?.lastAttemptAt ? (
                <>
                  {current.lastStatus === "Completed" ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" />
                  ) : (
                    <AlertCircle className={`mt-0.5 h-4 w-4 flex-shrink-0 ${current.lastStatus === "Failed" ? "text-red-600" : "text-gray-500"}`} />
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
          <div>
            <dt className="text-xs text-gray-500">Backups are stored</dt>
            <dd className="mt-0.5 text-base text-gray-900">{storageLabel(tenant?.resources?.storageAccountName)}</dd>
          </div>
          {cloud.config && (
            <div>
              <dt className="text-xs text-gray-500">Cloud backups (Azure)</dt>
              <dd className="mt-0.5 text-base text-gray-900">
                {describeCloudSchedule(cloud.config)}
                <span className="block text-xs text-gray-500">
                  {tenant?.resources?.storageAccountName && cloud.config.storageAccount &&
                  tenant.resources.storageAccountName.toLowerCase() !== cloud.config.storageAccount.toLowerCase()
                    ? `Writes to ${cloud.config.storageAccount}, not this tenant's current storage. Run cloud setup again for the new account.`
                    : cloud.status
                      ? `Last run ${formatWhen(cloud.status.lastRunAt)}: ${cloud.status.lastMessage}`
                      : cloud.statusError
                        ? "Last run could not be read from storage"
                        : "No cloud run reported yet"}
                </span>
              </dd>
            </div>
          )}
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
          {refusalsError && <p role="alert" className="text-xs text-red-600">Could not load the refused backups: {refusalsError}</p>}
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
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = () => {
    setLoadError(null)
    bridge.backups.scope(tenantId).then((setting) => {
      setSaved(setting.scope)
      setScope(setting.scope)
      setIsSaved(setting.saved)
    }, (error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)))
  }
  useEffect(load, [tenantId])

  if (!scope || !saved) {
    if (!loadError) return null
    return (
      <div className="space-y-5 rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        <h2 className="text-2xl font-medium tracking-tight text-gray-900">What to back up</h2>
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-red-600">Could not load what {tenantName} backs up: {loadError}</p>
          <Button variant="outline" size="sm" onClick={load}>Try again</Button>
        </div>
      </div>
    )
  }
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
          <p className="text-xs font-medium tracking-wide text-gray-400 uppercase">Step 2 · What</p>
          <h2 className="text-2xl font-medium tracking-tight text-gray-900">What to back up</h2>
          <p className="text-sm text-gray-500">
            Used by automatic backups (on this computer and in Azure) and "Back up all tenants now", and preselected when you run a backup by hand.
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

/** The tenant's storage choice, edited here and in Settings through the same chooser. */
function TenantStorageSettings({ tenant, tenantName, prefs, community, onStorageChange }: { tenant: Tenant | null; tenantName: string; prefs: AppPreferences | null; community: boolean; onStorageChange?: (tenant: Tenant, choice: StorageChoice) => void }) {
  const [editing, setEditing] = useState(false)
  const [choice, setChoice] = useState<StorageChoice | null>(null)
  const [draft, setDraft] = useState<StorageChooserDraft | null>(null)
  const [settings, setSettings] = useState<BackupSettings | null>(null)

  useEffect(() => {
    void bridge.backups.settings().then(setSettings).catch(() => undefined)
  }, [])

  const account = tenant?.resources?.storageAccountName ?? ""
  const local = !account || account.startsWith(LOCAL_STORAGE_PREFIX)
  const current: StorageChoice | undefined = !account
    ? undefined
    : local
      ? { kind: "local" }
      : {
          kind: "azure",
          storageAccountName: account,
          subscriptionId: tenant?.resources?.subscriptionId ?? "",
          resourceGroupName: tenant?.resources?.resourceGroupName ?? "",
          location: tenant?.resources?.resourceGroupLocation ?? "",
        }

  const save = () => {
    if (!tenant?.credentials || !choice || !onStorageChange) return
    onStorageChange(tenant, choice)
    toast(`Backups for ${tenantName} now go to ${choice.kind === "local" ? "this device" : choice.storageAccountName}.`, "success")
    setDraft(null)
    setEditing(false)
  }

  return (
    <div className="space-y-5 rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div className="flex items-center gap-3">
        <span className="flex size-10 flex-shrink-0 items-center justify-center rounded-full bg-coral-500 text-white" aria-hidden="true">
          <Database className="h-[18px] w-[18px]" />
        </span>
        <div>
          <p className="text-xs font-medium tracking-wide text-gray-400 uppercase">Step 1 · Where backups are stored</p>
          <h2 className="text-2xl font-medium tracking-tight text-gray-900">Backup storage</h2>
        </div>
      </div>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-xs text-gray-500">Backups for {tenantName} go to</dt>
          <dd className="mt-0.5 flex items-center gap-2 text-base text-gray-900">
            {local ? <HardDrive className="h-4 w-4 flex-shrink-0" aria-hidden="true" /> : <Cloud className="h-4 w-4 flex-shrink-0" aria-hidden="true" />}
            {storageLabel(account || undefined)}
          </dd>
          <dd className="text-xs text-gray-500">
            {local
              ? `Encrypted in ${settings?.localFolder ?? "the TenuVault Backups folder"} on this device${settings ? `, recovery key ${settings.keyFingerprint}${settings.recoveryExported ? " saved" : " not saved yet"}` : ""}. Only this computer can make and see these backups until the recovery key is imported elsewhere. Available on every plan.`
              : `Encrypted before upload to your storage account${tenant?.resources?.resourceGroupName ? ` (${tenant.resources.resourceGroupName})` : ""}, container intune-backups. Every admin with access and the recovery key sees the same backups, and it is the storage cloud backups write to.`}
            {prefs ? ` Kept for ${community ? `${prefs.retentionDays === 0 ? COMMUNITY_RETENTION_DAYS : Math.min(prefs.retentionDays, COMMUNITY_RETENTION_DAYS)} days (Community)` : prefs.retentionDays === 0 ? "forever" : `${prefs.retentionDays} days`}.` : ""}
            {" "}Backups never go to a TenuVault server.
          </dd>
        </div>
      </dl>
      {community && local && <UpgradeNote feature="azureStorage" />}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!tenant?.credentials || !onStorageChange} onClick={() => { setChoice(null); setEditing(true) }}>
          Change storage
        </Button>
        <Link to={settingsHref("storage")} className="inline-flex items-center rounded-full px-3 py-1.5 text-sm font-medium underline">
          Folder and recovery key in Settings
        </Link>
      </div>

      <Dialog open={editing} onOpenChange={(open) => { if (!open) { setDraft(null); setEditing(false) } }}>
        <DialogContent className="sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle>Backup storage for {tenantName}</DialogTitle>
            <DialogDescription>
              New backups go to the location you choose. Existing backups stay where they are and are only listed
              while that location is selected.
            </DialogDescription>
          </DialogHeader>
          {tenant?.credentials && (
            <StorageChooser
              tenantId={tenant.credentials.tenantId}
              clientId={tenant.credentials.appId}
              initial={current}
              initialDraft={draft ?? undefined}
              onChange={setChoice}
              onDraftChange={setDraft}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDraft(null); setEditing(false) }}>Cancel</Button>
            <Button disabled={!choice} onClick={save}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
