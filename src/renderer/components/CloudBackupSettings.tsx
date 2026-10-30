import { useEffect, useMemo, useState } from "react"
import { CalendarClock, Check, CheckCircle2, Cloud, Copy, ExternalLink, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "~/components/ui/button"
import type { Tenant } from "~/contexts/TenantContext"
import setupScript from "../../../resources/New-TenuVaultCloudBackup.ps1?raw"
import runbookScript from "../../../resources/runbooks/Invoke-TenuVaultBackup.ps1?raw"
import {
  CLOUD_BACKUP_GUIDE_URL,
  cloudSchedulePortalUrl,
  cloudSetupCommand,
  deployToAzureUrl,
  describeCloudSchedule,
  nextRunsInZone,
  parseCloudSetup,
} from "../../shared/cloud-backup"
import { LOCAL_STORAGE_PREFIX } from "../../shared/constants"
import { normalizeScope, presetOf } from "../../shared/intune/scope"
import { bridge } from "../lib/bridge"
import type { CloudBackupState } from "../lib/cloud-backup"
import { formatWhen } from "../lib/schedules"
import { toast } from "../lib/toast"
import { UpgradeNote } from "./UpgradeNote"

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`

/** One month with the days a backup runs marked, starting with the month of the next run. */
function RunsCalendar({ runs }: { runs: Date[] }) {
  const first = runs[0] ?? new Date()
  const year = first.getFullYear()
  const month = first.getMonth()
  const start = new Date(year, month, 1)
  const cells: Array<Date | null> = [
    ...Array.from({ length: start.getDay() }, () => null),
    ...Array.from({ length: new Date(year, month + 1, 0).getDate() }, (_, i) => new Date(year, month, i + 1)),
  ]
  const runDays = new Set(runs.map(dayKey))
  const today = dayKey(new Date())
  return (
    <div className="rounded-2xl border border-gray-100 p-4">
      <p className="text-sm font-medium text-gray-900">
        {start.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
      </p>
      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-xs">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
          <span key={day} className="py-1 text-gray-400">{day}</span>
        ))}
        {cells.map((date, index) =>
          date ? (
            <span
              key={index}
              className={[
                "flex aspect-square items-center justify-center rounded-full",
                runDays.has(dayKey(date)) ? "bg-coral-500 font-medium text-white" : "text-gray-600",
                dayKey(date) === today ? "ring-2 ring-gray-300 ring-inset" : "",
              ].join(" ")}
            >
              {date.getDate()}
            </span>
          ) : (
            <span key={index} />
          ),
        )}
      </div>
      <ul className="mt-3 space-y-1 text-xs text-gray-500">
        {runs.slice(0, 3).map((run) => (
          <li key={run.toISOString()}>
            Next: {run.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The Azure half of "Where backups run": setup hand-off (Deploy to Azure, setup script, paste
 * the printed result back), then the recorded schedule, its next runs and the runbook's last
 * reported result. The app itself never creates or edits the Azure resources.
 */
export function CloudBackupSettings({ tenant, community, cloud }: { tenant: Tenant | null | undefined; community: boolean; cloud: CloudBackupState }) {
  const tenantId = tenant?.credentials?.tenantId ?? ""
  const tenantName = tenant?.name ?? "this tenant"
  const storageAccount = tenant?.resources?.storageAccountName ?? ""
  const localStorage = !storageAccount || storageAccount.startsWith(LOCAL_STORAGE_PREFIX)
  const [pasted, setPasted] = useState("")
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [frequency, setFrequency] = useState<"daily" | "weekly">("daily")
  const [time, setTime] = useState("02:00")
  const [weekday, setWeekday] = useState(0)
  const [excluded, setExcluded] = useState<string[]>(["Apps"])
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  useEffect(() => {
    if (!tenantId) return
    void bridge.backups.scope(tenantId).then((setting) => setExcluded(normalizeScope(setting.scope).excluded)).catch(() => undefined)
  }, [tenantId])

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 2000)
    } catch (error) {
      toast(`Copying failed: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }
  const copyButton = (key: string, label: string, text: string) => (
    <Button variant="outline" size="sm" onClick={() => void copy(key, text)}>
      {copied === key ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
      {copied === key ? "Copied" : label}
    </Button>
  )

  const preset = presetOf({ excluded })
  const command = useMemo(() => {
    const base = cloudSetupCommand({
      tenantId,
      storageAccount,
      frequency,
      time,
      weekday,
      timeZone,
      scope: preset === "everything" ? "everything" : "policies",
      resourceGroup: tenant?.resources?.resourceGroupName || undefined,
      location: tenant?.resources?.resourceGroupLocation || undefined,
    })
    return preset === "custom" ? `${base} -ExcludedFolders "${excluded.join(",")}"` : base
  }, [tenantId, storageAccount, frequency, time, weekday, timeZone, preset, excluded, tenant])

  const applyPaste = async () => {
    const config = parseCloudSetup(pasted)
    if (!config) {
      setPasteError("That does not look like the setup output. Copy the whole block between the two marker lines, or the template's pasteIntoTenuVault output.")
      return
    }
    if (config.tenantId !== tenantId.toLowerCase()) {
      setPasteError(`That setup is for another tenant (${config.tenantId}), not ${tenantName}.`)
      return
    }
    setPasteError(null)
    try {
      await cloud.save(config)
    } catch (error) {
      setPasteError(`The setup could not be saved on this computer: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    setReplacing(false)
    setPasted("")
    toast(config.linked ? "Cloud backups recorded for this tenant." : "Cloud setup recorded. Its schedule is not linked yet.", "success")
  }

  const forget = async () => {
    try {
      await cloud.clear()
    } catch (error) {
      toast(`The cloud setup could not be removed: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }

  const config = cloud.config
  const runs = useMemo(
    () => (config?.linked && config.time ? nextRunsInZone(config, config.timeZone || timeZone, new Date(), 40) : []),
    [config, timeZone],
  )
  const previewRuns = useMemo(() => nextRunsInZone({ frequency, time, weekday }, timeZone, new Date(), 40), [frequency, time, weekday, timeZone])
  const select = "h-10 rounded-full border border-gray-300 bg-white px-4 text-sm"

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-700">
        A runbook in an Azure Automation account in your own subscription backs up {tenantName} on a schedule, with a
        managed identity and read-only permissions. No computer has to run, no admin has to stay signed in, and
        Conditional Access sign-in frequency cannot stop it. Backups are sealed with your recovery key (kept in Key
        Vault) and land in the same storage as your other backups, so they appear in Backup History like any backup.
      </p>

      {community && <UpgradeNote feature="azureStorage" />}
      {!community && localStorage && (
        <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Cloud backups write to your Azure storage account, but {tenantName} currently keeps backups on this device.
          Choose your Azure storage account in step 1 first, then set up the cloud runner for that account.
        </p>
      )}

      {config && !replacing ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="space-y-4 text-sm text-gray-700">
            <dl className="space-y-3">
              <div>
                <dt className="text-xs text-gray-500">Runs in Azure</dt>
                <dd className="mt-0.5 text-base text-gray-900">{describeCloudSchedule(config)}</dd>
                <dd className="text-xs text-gray-500">
                  Automation account {config.automationAccount} ({config.resourceGroup}), schedule {config.scheduleName}.
                  Backups go to {config.storageAccount}. The runbook cannot delete backups; retention runs on the next
                  desktop backup made with an admin's sign-in.
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Last cloud backup</dt>
                <dd className="mt-0.5 flex items-start gap-2 text-base text-gray-900">
                  {cloud.status ? (
                    <>
                      <CheckCircle2 className={`mt-0.5 h-4 w-4 flex-shrink-0 ${cloud.status.lastStatus === "Failed" ? "text-red-600" : "text-green-600"}`} />
                      <span>
                        {formatWhen(cloud.status.lastRunAt)}
                        <span className="block text-xs text-gray-500">
                          {cloud.status.lastMessage} Runbook {cloud.status.runbookVersion}.
                        </span>
                      </span>
                    </>
                  ) : cloud.statusError ? (
                    <span role="alert" className="text-sm text-red-600">Could not read the last cloud run: {cloud.statusError}</span>
                  ) : (
                    "None reported yet"
                  )}
                </dd>
              </div>
            </dl>
            {storageAccount && config.storageAccount && storageAccount.toLowerCase() !== config.storageAccount.toLowerCase() && (
              <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
                This tenant's storage is now {storageAccount}, but the cloud runner still writes to {config.storageAccount},
                so its backups and status do not appear here. Run the setup again for the new account and paste its
                output, or change the storage back in step 1.
              </p>
            )}
            {!config.linked && (
              <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
                The Azure resources exist, but the schedule is not linked: the managed identity is still missing its
                Microsoft Graph roles. A Global Administrator assigns them, then the setup is run again. The{" "}
                <button type="button" className="font-medium underline" onClick={() => void bridge.app.openExternal(CLOUD_BACKUP_GUIDE_URL)}>
                  cloud backup guide
                </button>{" "}
                has the request text.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void bridge.app.openExternal(cloudSchedulePortalUrl(config))}>
                <ExternalLink className="mr-2 h-4 w-4" /> Open schedule in Azure
              </Button>
              <Button variant="outline" size="sm" onClick={cloud.refresh}>
                <RefreshCw className="mr-2 h-4 w-4" /> Refresh status
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setReplacing(true)}>Update from setup output</Button>
              <Button variant="ghost" size="sm" onClick={() => void forget()}>
                <Trash2 className="mr-2 h-4 w-4" /> Forget on this computer
              </Button>
            </div>
            <p className="text-xs text-gray-500">
              Changing the time, scope or storage happens in Azure: run the setup script again with the new values and
              paste its output here. Forgetting here only removes this computer's record; the Azure schedule keeps running.
            </p>
          </div>
          {runs.length > 0 ? <RunsCalendar runs={runs} /> : (
            <p className="self-start rounded-2xl border border-gray-100 p-4 text-sm text-gray-500">
              No upcoming runs to show{config.time ? "" : " (the pasted setup did not include the backup time)"}.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <ol className="list-decimal space-y-3 pl-5 text-sm text-gray-700">
            <li>
              Pick when cloud backups run. What they cover follows this tenant's saved choice in step 2
              ({preset === "custom" ? `${excluded.length} types left out` : preset === "everything" ? "Everything" : "Everything except apps"}).
              <div className="mt-3 flex flex-wrap items-end gap-4">
                <div className="space-y-1.5">
                  <label htmlFor="cloud-frequency" className="block text-sm font-medium text-gray-900">Repeat</label>
                  <select id="cloud-frequency" className={select} value={frequency} onChange={(e) => setFrequency(e.target.value as "daily" | "weekly")}>
                    <option value="daily">Every day</option>
                    <option value="weekly">Every week</option>
                  </select>
                </div>
                {frequency === "weekly" && (
                  <div className="space-y-1.5">
                    <label htmlFor="cloud-weekday" className="block text-sm font-medium text-gray-900">Day</label>
                    <div className="flex gap-1" role="group" aria-label="Day of the week">
                      {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day, index) => (
                        <button
                          key={day}
                          type="button"
                          aria-pressed={weekday === index}
                          onClick={() => setWeekday(index)}
                          className={`flex size-10 items-center justify-center rounded-full border text-sm ${weekday === index ? "border-coral-500 bg-coral-500 text-white" : "border-gray-300 bg-white text-gray-700"}`}
                        >
                          {day}
                        </button>
                      ))}
                    </div>
                    <select id="cloud-weekday" className="sr-only" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} tabIndex={-1} aria-hidden="true">
                      {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => (
                        <option key={day} value={index}>{day}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="space-y-1.5">
                  <label htmlFor="cloud-time" className="block text-sm font-medium text-gray-900">Time ({timeZone})</label>
                  <input id="cloud-time" type="time" className={select} value={time} onChange={(e) => setTime(e.target.value)} />
                </div>
              </div>
              {previewRuns.length > 0 && <div className="mt-4 max-w-sm"><RunsCalendar runs={previewRuns} /></div>}
            </li>
            <li>
              Create the Azure resources, in whichever way fits whoever owns Azure. The script also grants the Graph
              roles (as a Global Administrator) and creates the failure alert; the template deploys everything ARM
              can and lists the roles in its outputs. The Deploy to Azure link cannot carry the choices above with
              it: enter frequency, day, time, timezone and scope in the template as well (its defaults are daily,
              everything except apps).
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" disabled={community || localStorage} onClick={() => void bridge.app.openExternal(deployToAzureUrl())}>
                  <Cloud className="mr-2 h-4 w-4" /> Deploy to Azure
                </Button>
                {copyButton("command", "Copy setup command", command)}
                {copyButton("setup", "Copy setup script", `# Save as New-TenuVaultCloudBackup.ps1, next to a runbooks folder holding Invoke-TenuVaultBackup.ps1\n# Guide: ${CLOUD_BACKUP_GUIDE_URL}\n\n${setupScript}`)}
                {copyButton("runbook", "Copy runbook", `# Save as runbooks/Invoke-TenuVaultBackup.ps1 next to New-TenuVaultCloudBackup.ps1\n\n${runbookScript}`)}
                <Button variant="ghost" size="sm" onClick={() => void bridge.app.openExternal(CLOUD_BACKUP_GUIDE_URL)}>
                  <ExternalLink className="mr-2 h-4 w-4" /> Setup guide
                </Button>
              </div>
              <code className="mt-3 block break-all rounded-lg bg-secondary px-3 py-2 font-mono text-xs">{command}</code>
              <p className="mt-2 text-xs text-gray-500">
                Add <span className="font-mono">-AlertEmail you@contoso.com</span> to the command (or{" "}
                <span className="font-mono">-NoFailureAlert</span>). The script asks for the backup recovery key at a
                hidden prompt and stores it in Key Vault. Without it, cloud backups cannot be sealed and do not run.
              </p>
            </li>
            <li>
              Paste the block the setup prints at the end (or the template's <span className="font-mono">pasteIntoTenuVault</span> output).
              TenuVault then shows the schedule, its next runs and the last cloud backup here.
              <textarea
                className="mt-3 w-full rounded-2xl border border-gray-300 bg-white p-3 font-mono text-xs"
                rows={6}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder={"--- TenuVault cloud backup setup (paste into TenuVault) ---\ntenantId=...\n..."}
                aria-label="Setup output"
              />
              {pasteError && <p role="alert" className="mt-2 text-sm text-red-600">{pasteError}</p>}
              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={!pasted.trim()} onClick={() => void applyPaste()}>
                  <CalendarClock className="mr-2 h-4 w-4" /> Save cloud setup
                </Button>
                {replacing && <Button variant="outline" size="sm" onClick={() => setReplacing(false)}>Cancel</Button>}
              </div>
            </li>
          </ol>
        </div>
      )}
    </div>
  )
}
