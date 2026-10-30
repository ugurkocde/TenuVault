/**
 * Cloud backups: scheduled Intune backups that run in an Azure Automation account in the
 * customer's own tenant instead of on an admin's computer (see
 * resources/runbooks/Invoke-TenuVaultBackup.ps1). The desktop app never creates or edits the
 * Azure resources itself: setup happens through New-TenuVaultCloudBackup.ps1 or the Deploy to
 * Azure template, both print a setup block, and the admin pastes that block into the app so it
 * can show where backups run, when the next one is due, and how the last one ended.
 */

export interface CloudBackupConfig {
  tenantId: string
  subscriptionId: string
  resourceGroup: string
  automationAccount: string
  storageAccount: string
  keyVault: string
  scheduleName: string
  frequency: "daily" | "weekly"
  /** Local time in `timeZone`, "HH:MM". Empty when the template path could not report it. */
  time: string
  /** 0 = Sunday, for weekly schedules. */
  weekday: number
  timeZone: string
  tenantKey: string
  /** False while the Graph roles are still missing and no schedule is linked in Azure. */
  linked: boolean
}

export interface CloudBackupStatus {
  lastRunAt: string
  lastStatus: string
  lastMessage: string
  backupFolder: string | null
  runbookVersion: string
}

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/** The per tenant suffix setup uses for Automation variables and the schedule name. */
export function cloudTenantKey(tenantId: string): string {
  return tenantId.slice(0, 8).toLowerCase()
}

/** The status blob the runbook writes at the end of every run. */
export function cloudStatusBlobName(tenantId: string): string {
  return `cloud-backup-status-${cloudTenantKey(tenantId)}.json`
}

const TEMPLATE_URL =
  "https://raw.githubusercontent.com/ugurkocde/TenuVault/main/resources/cloud-backup/azuredeploy.json"

/** The Deploy to Azure portal link for the checked in template. */
export function deployToAzureUrl(): string {
  return `https://portal.azure.com/#create/Microsoft.Template/uri/${encodeURIComponent(TEMPLATE_URL)}`
}

export const CLOUD_BACKUP_GUIDE_URL = "https://docs.tenuvault.com/backups/cloud/"

/**
 * Parses the setup block printed by New-TenuVaultCloudBackup.ps1 or the template outputs.
 * Returns null when the pasted text cannot be a cloud backup setup, so the caller can say so
 * instead of storing half a configuration.
 */
export function parseCloudSetup(text: string): CloudBackupConfig | null {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(.+?)\s*$/.exec(line)
    if (match) fields.set(match[1]!.toLowerCase(), match[2]!.replace(/^"|"$/g, ""))
  }
  const get = (name: string) => fields.get(name) ?? ""
  const tenantId = get("tenantid")
  const storageAccount = get("storageaccount")
  const automationAccount = get("automationaccount")
  const resourceGroup = get("resourcegroup")
  if (!GUID.test(tenantId) || !/^[a-z0-9]{3,24}$/.test(storageAccount) || !automationAccount || !resourceGroup) return null
  const frequency = get("frequency").toLowerCase() === "weekly" || get("frequency").toLowerCase() === "week" ? "weekly" : "daily"
  const weekdayName = get("weekday")
  // The stored configuration round trips through this parser with a numeric weekday.
  const weekdayIndex = /^[0-6]$/.test(weekdayName)
    ? Number(weekdayName)
    : WEEKDAYS.findIndex((day) => day.toLowerCase() === weekdayName.toLowerCase())
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(get("time")) ? get("time") : ""
  return {
    tenantId: tenantId.toLowerCase(),
    subscriptionId: GUID.test(get("subscriptionid")) ? get("subscriptionid").toLowerCase() : "",
    resourceGroup,
    automationAccount,
    storageAccount,
    keyVault: get("keyvault"),
    scheduleName: get("schedulename") || `TenuVaultBackup-${cloudTenantKey(tenantId)}`,
    frequency,
    time,
    weekday: weekdayIndex >= 0 ? weekdayIndex : 0,
    timeZone: get("timezone") || "UTC",
    tenantKey: get("tenantkey") || cloudTenantKey(tenantId),
    linked: get("linked").toLowerCase() !== "false",
  }
}

/** Reads the runbook's status blob body, or null when it does not describe this tenant. */
export function parseCloudStatus(value: unknown, tenantId: string): CloudBackupStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.TenantId !== "string" || record.TenantId.toLowerCase() !== tenantId.toLowerCase()) return null
  if (record.Source !== "TenuVault Cloud Backup") return null
  const text = (name: string) => (typeof record[name] === "string" ? record[name] : "")
  return {
    lastRunAt: text("LastRunAt"),
    lastStatus: text("LastStatus"),
    lastMessage: text("LastMessage"),
    backupFolder: typeof record.BackupFolder === "string" ? record.BackupFolder : null,
    runbookVersion: text("RunbookVersion"),
  }
}

/** Deep link to the tenant's schedule in the Azure portal. */
export function cloudSchedulePortalUrl(config: CloudBackupConfig): string {
  const path = [
    "subscriptions", config.subscriptionId,
    "resourceGroups", config.resourceGroup,
    "providers/Microsoft.Automation/automationAccounts", config.automationAccount,
  ].map(encodeURIComponent).join("/")
  return `https://portal.azure.com/#@/resource/${path}/schedules`
}

/**
 * The setup command an admin copies for whoever can create Azure resources, with the choices
 * made in the app already filled in. The recovery key is pasted at the script's hidden prompt,
 * never on a command line.
 */
export function cloudSetupCommand(options: {
  tenantId: string
  storageAccount: string
  frequency: "daily" | "weekly"
  time: string
  weekday: number
  timeZone: string
  scope: "everything" | "policies"
  /** The tenant's known Azure placement, when the app has it; first setup needs one of these. */
  resourceGroup?: string
  location?: string
}): string {
  const parts = [
    "./New-TenuVaultCloudBackup.ps1",
    `-TenantId ${options.tenantId}`,
    `-StorageAccountName ${options.storageAccount}`,
    `-Frequency ${options.frequency === "weekly" ? "Weekly" : "Daily"}`,
    `-Time ${options.time}`,
  ]
  if (options.resourceGroup) parts.push(`-ResourceGroupName ${options.resourceGroup}`)
  if (options.location) parts.push(`-Location ${options.location}`)
  if (options.frequency === "weekly") parts.push(`-WeekDay ${WEEKDAYS[options.weekday] ?? "Sunday"}`)
  parts.push(`-TimeZone ${options.timeZone}`, `-Scope ${options.scope}`, "-GrantGraphRoles")
  return parts.join(" ")
}

// ---------------------------------------------------------------------------
// Next runs in a named timezone, for the calendar preview. Wall clock times in
// an IANA zone are resolved through Intl, the same source the schedule label
// already uses for the local zone.
// ---------------------------------------------------------------------------

function zoneParts(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date)
  return Object.fromEntries(parts.map((part) => [part.type, part.value]))
}

/** The offset of `timeZone` at `date`, as milliseconds to add to UTC for wall clock time. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zoneParts(date, timeZone)
  const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!, +p.second!)
  return wall - Math.floor(date.getTime() / 1000) * 1000
}

/**
 * The instant a wall clock time (year, month 0 based, day, HH:mm) falls in `timeZone`.
 * A repeated autumn time uses its first occurrence, like the desktop scheduler; a time the
 * spring clock change skips moves forward by the change (no candidate matches, the later one wins).
 */
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month, day, hour, minute)
  const offsets = new Set([
    zoneOffsetMs(new Date(guess), timeZone),
    zoneOffsetMs(new Date(guess - 6 * 3600_000), timeZone),
    zoneOffsetMs(new Date(guess + 6 * 3600_000), timeZone),
  ])
  const candidates = [...offsets].map((offset) => guess - offset).sort((a, b) => a - b)
  for (const candidate of candidates) {
    const p = zoneParts(new Date(candidate), timeZone)
    if (+p.year! === year && +p.month! === month + 1 && +p.day! === day && +p.hour! % 24 === hour && +p.minute! === minute) {
      return new Date(candidate)
    }
  }
  return new Date(candidates[candidates.length - 1]!)
}

/**
 * The next `count` runs of a daily or weekly schedule at `time` wall clock in `timeZone`,
 * strictly after `from`. A time skipped by the spring clock change resolves to the instant
 * the same duration after midnight, which is what Azure Automation does with the zone.
 */
export function nextRunsInZone(
  schedule: { frequency: "daily" | "weekly"; time: string; weekday: number },
  timeZone: string,
  from: Date,
  count: number,
): Date[] {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule.time)
  if (!match) return []
  const hour = +match[1]!
  const minute = +match[2]!
  const runs: Date[] = []
  try {
    const start = zoneParts(from, timeZone)
    let year = +start.year!
    let month = +start.month! - 1
    let day = +start.day!
    for (let scanned = 0; scanned < 400 && runs.length < count; scanned++) {
      const candidate = zonedInstant(year, month, day, hour, minute, timeZone)
      const weekday = new Date(Date.UTC(year, month, day)).getUTCDay()
      if (candidate > from && (schedule.frequency === "daily" || weekday === schedule.weekday)) runs.push(candidate)
      const next = new Date(Date.UTC(year, month, day + 1))
      year = next.getUTCFullYear()
      month = next.getUTCMonth()
      day = next.getUTCDate()
    }
  } catch {
    return []
  }
  return runs
}

/** One sentence an admin can check against the Azure schedule, for example "Daily at 02:00 (Europe/Berlin)". */
export function describeCloudSchedule(config: Pick<CloudBackupConfig, "frequency" | "time" | "weekday" | "timeZone" | "linked">): string {
  if (!config.linked) return "Set up in Azure, schedule not linked yet"
  const zone = config.timeZone ? ` (${config.timeZone})` : ""
  if (!config.time) return config.frequency === "weekly" ? `Weekly in Azure${zone}` : `Daily in Azure${zone}`
  return config.frequency === "weekly"
    ? `Weekly on ${WEEKDAYS[config.weekday] ?? WEEKDAYS[0]} at ${config.time}${zone}`
    : `Daily at ${config.time}${zone}`
}
