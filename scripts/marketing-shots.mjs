/**
 * Marketing screenshots of the built app with fictional demo data (run `npm run build` first).
 *
 *   node scripts/marketing-shots.mjs [outDir] [assetsDir]
 *
 * outDir defaults to out/marketing and receives the PNG captures. When assetsDir is given
 * (for example design/landing-mockup/assets), JPEG copies are written there as well with
 * macOS `sips`, under the file names the landing page mockup uses.
 *
 * Launches Electron with a throwaway profile, like scripts/smoke.mjs. Demo data is injected at
 * the process boundary only: over the Node inspector of the main process, the IPC handlers the
 * preload bridge calls (license, sign-ins, schedules, preferences, and the "api" channel that
 * carries every renderer fetch("/api/...")) are replaced with handlers that answer from the
 * fixtures below. No Microsoft or licensing service is ever called and app source is unchanged.
 *
 * The OpenIntuneBaseline screens are the exception: the app's own handler loads the public
 * baseline from GitHub (oib-versions, oib-load), so they show real policy names. Comparisons,
 * validations and runs are demo data built on that catalog. These captures need network access.
 */
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const require = createRequire(import.meta.url)
const electronPath = require("electron")
const desktopDir = resolve(import.meta.dirname, "..")
const shotsDir = resolve(process.argv[2] ?? join(desktopDir, "out", "marketing"))
const assetsDir = process.argv[3] ? resolve(process.argv[3]) : null

// ---------------------------------------------------------------------------------------------
// Demo data: a fictional MSP with six customer tenants.
// ---------------------------------------------------------------------------------------------

const NOW = Date.now()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const CLIENT_ID = "5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3"
const DELEGATED_CLIENT_SECRET = "tenuvault-desktop-delegated-auth"

// Deterministic pseudo random numbers, so every run produces the same data.
let seed = 20260929
const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
const between = (min, max) => Math.floor(min + random() * (max - min + 1))

const TENANTS = [
  { id: 1, name: "Contoso Ltd", domain: "contoso.onmicrosoft.com", guid: "8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14", admin: "Megan Bowen", storage: "local", schedule: { frequency: "daily", time: "02:00" }, users: 1840, devices: 2315 },
  { id: 2, name: "Fabrikam Inc", domain: "fabrikam.onmicrosoft.com", guid: "2f9d4a7c-1b6e-4c3d-8a5f-9e0b7c2d4a61", admin: "Alex Wilber", storage: "stfabrikamintune", schedule: { frequency: "daily", time: "01:30" }, users: 960, devices: 1204 },
  { id: 3, name: "Northwind Traders", domain: "northwindtraders.onmicrosoft.com", guid: "7a1c5e9b-3f2d-4b8a-a6c4-1d7e9f0b3c52", admin: "Lidia Holloway", storage: "local", schedule: { frequency: "daily", time: "02:30" }, users: 412, devices: 538 },
  { id: 4, name: "Woodgrove Bank", domain: "woodgrovebank.onmicrosoft.com", guid: "4e8b2d6f-9a1c-4e7d-b3f5-8c2a6d9e1b07", admin: "Isaiah Langer", storage: "stwoodgrovevault", schedule: { frequency: "daily", time: "03:00" }, users: 3120, devices: 4077 },
  { id: 5, name: "Tailspin Toys", domain: "tailspintoys.onmicrosoft.com", guid: "9b3f7c1a-6d4e-4a2b-8f9c-3e5d1a7b6c28", admin: "Diego Siciliani", storage: "sttailspinbackup", schedule: { frequency: "weekly", time: "22:00", weekday: 0 }, users: 275, devices: 331 },
  { id: 6, name: "Adatum Corporation", domain: "adatum.onmicrosoft.com", guid: "1d5a9e3c-8b7f-4c6a-9d2e-7f4b0c8a5e93", admin: "Joni Sherman", storage: "local", schedule: null, users: 690, devices: 812 },
]

const pad = (n) => String(n).padStart(2, "0")
const backupName = (ms) => {
  const d = new Date(ms)
  return `backup-${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
}
const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z")
const localAt = (dayOffset, hhmm) => {
  const [h, m] = hhmm.split(":").map(Number)
  const d = new Date(NOW)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(h, m, between(0, 40), 0)
  return d.getTime()
}

/** Next and previous run of a schedule, in this computer's local time like the app's scheduler. */
function scheduleRuns({ frequency, time, weekday }) {
  const [h, m] = time.split(":").map(Number)
  const next = new Date(NOW)
  next.setHours(h, m, 0, 0)
  if (frequency === "daily") {
    if (next.getTime() <= NOW) next.setDate(next.getDate() + 1)
    return { next: next.getTime(), last: next.getTime() - DAY }
  }
  while (next.getDay() !== weekday || next.getTime() <= NOW) next.setDate(next.getDate() + 1)
  return { next: next.getTime(), last: next.getTime() - 7 * DAY }
}

/** Items per registry folder in Contoso's latest backup: 1,284 in total. */
function contosoCounts() {
  const counts = {
    ConfigurationPolicies: 398, GroupPolicyConfigurations: 14, // Settings catalog 412
    DeviceConfigurations: 287,
    CompliancePolicies: 58, ComplianceSettingsPolicies: 6, // Compliance 64
    AppProtectionIOS: 16, AppProtectionAndroid: 15, AppProtectionWindows: 7, // App protection 38
    ConditionalAccess: 46,
    PowerShellScripts: 41, ShellScripts: 12, Remediations: 23, ComplianceScripts: 5, CustomAttributeScripts: 3,
    FeatureUpdateProfiles: 6, QualityUpdateProfiles: 4, QualityUpdatePolicies: 2, DriverUpdateProfiles: 3,
    AppConfigurationPolicies: 27, ManagedAppConfigurations: 11, AppCategories: 11, PolicySets: 4,
    EnrollmentConfigurations: 17, AutopilotProfiles: 8, AppleEnrollmentProfiles: 3, AppleAutomatedEnrollment: 2, AndroidEnrollmentProfiles: 5,
    DeviceCategories: 12, TermsAndConditions: 2, AssignmentFilters: 38, ScopeTags: 9, RoleDefinitions: 14,
    NotificationTemplates: 9, Branding: 1, DeviceCleanupRules: 1, MultiAdminApprovalPolicies: 2,
    ReusablePolicySettings: 16, HardwareConfigurations: 2,
  }
  const sum = Object.values(counts).reduce((a, b) => a + b, 0)
  counts.EndpointSecurityIntents = 1284 - sum
  return counts
}

function breakdown(counts) {
  const c = (...folders) => folders.reduce((sum, f) => sum + (counts[f] ?? 0), 0)
  return {
    deviceConfigurations: c("DeviceConfigurations"),
    compliancePolicies: c("CompliancePolicies", "ComplianceSettingsPolicies"),
    configurationPolicies: c("ConfigurationPolicies", "GroupPolicyConfigurations"),
    appProtectionPolicies: c("AppProtectionIOS", "AppProtectionAndroid", "AppProtectionWindows", "AppProtectionPolicies"),
    conditionalAccess: c("ConditionalAccess"),
  }
}

/**
 * Backup history of one tenant, newest first, in the /api/list-backups shape. Contoso gets
 * 72 backups in the last 7 days (71 complete, 1 failed: 98.6%), the newest 12 minutes ago.
 */
function backupsFor(tenant, scale) {
  const times = []
  // Automatic backups at the scheduled time, for the last 20 days.
  if (tenant.schedule?.frequency === "daily") {
    for (let day = 0; day < 20; day++) {
      const t = localAt(-day, tenant.schedule.time)
      if (t < NOW - 15 * MIN) times.push({ t, type: "scheduled" })
    }
  }
  // Manual backups during working hours, none in the last three hours except the newest one.
  const manualInPeriod = tenant.id === 1 ? 72 - times.filter((x) => x.t > NOW - 7 * DAY).length - 1 : 9
  const periodStart = NOW - 7 * DAY + HOUR
  while (times.filter((x) => x.type !== "scheduled" && x.t > periodStart).length < manualInPeriod) {
    const t = periodStart + random() * (NOW - 3 * HOUR - periodStart)
    const hour = new Date(t).getHours()
    if (hour < 7 || hour > 19) continue
    times.push({ t, type: random() < 0.12 ? "tray" : "manual" })
  }
  for (let i = 0; i < (tenant.id === 1 ? 12 : 4); i++) times.push({ t: NOW - 7 * DAY - between(2, 300) * HOUR, type: "manual" })
  times.push({ t: NOW - 12 * MIN, type: "manual" })
  times.sort((a, b) => b.t - a.t)

  const baseCounts = tenant.id === 1 ? contosoCounts() : Object.fromEntries(Object.entries(contosoCounts()).map(([k, v]) => [k, Math.max(0, Math.round(v * scale))]))
  // The failed run is about two days ago.
  const failedIndex = times.findIndex((x) => x.t < NOW - 2 * DAY && x.type === "manual")
  let total = Object.values(baseCounts).reduce((a, b) => a + b, 0)
  const backups = times.map(({ t, type }, index) => {
    const failed = index === failedIndex
    const roll = random()
    // The newest Contoso backups get a fixed, varied change history for the timeline.
    const preset = tenant.id === 1 ? [{ added: 0, modified: 2, removed: 0 }, { added: 1, modified: 3, removed: 0 }, { added: 0, modified: 0, removed: 0 }, { added: 0, modified: 1, removed: 1 }, { added: 2, modified: 4, removed: 0 }][index] : undefined
    const changes = preset ?? (roll < 0.35 ? { added: 0, modified: 0, removed: 0 } : roll < 0.8 ? { added: 0, modified: between(1, 4), removed: 0 } : { added: between(1, 3), modified: between(0, 3), removed: between(0, 1) })
    const counts = { ...baseCounts, ConfigurationPolicies: baseCounts.ConfigurationPolicies - (Object.values(baseCounts).reduce((a, b) => a + b, 0) - total) }
    const items = failed ? Math.round(total * 0.57) : total
    const entry = {
      id: backupName(t),
      name: backupName(t),
      timestamp: iso(t),
      timestampPrecision: "second",
      lastModified: iso(t),
      folder: `${backupName(t)}/`,
      type,
      status: failed ? "Failed" : "Completed",
      configs: items + 1,
      policyCount: items,
      totalPolicies: items,
      counts: failed ? undefined : counts,
      policies: failed ? undefined : breakdown(counts),
      scope: { excluded: ["Apps"], description: "Everything except apps" },
      failures: failed ? 1 : 0,
      skippedTypes: [],
      failedTypes: failed ? ["ConfigurationPolicies"] : [],
      size: Math.round(items * between(17800, 18900)),
      duration: failed ? between(70, 110) : Math.round(items * 0.19) + between(-18, 25),
      changes: failed ? null : changes,
      comparedWith: null,
      error: failed ? "Microsoft Graph throttled the request (429 Too Many Requests). Retry the backup later." : undefined,
    }
    if (!failed) total = total - changes.added + changes.removed
    return entry
  })
  // Each complete backup is compared with the next older complete one; the oldest is the first backup.
  const complete = backups.filter((b) => b.status === "Completed")
  complete.forEach((b, i) => {
    b.comparedWith = complete[i + 1]?.id ?? null
    if (!b.comparedWith) b.changes = null
  })
  return backups
}

const BACKUPS = Object.fromEntries(TENANTS.map((t, i) => [t.guid, backupsFor(t, [1, 0.62, 0.38, 1.35, 0.27, 0.49][i])]))

function auditFor(tenant) {
  const contoso = BACKUPS[tenant.guid]
  const restoredFrom = contoso.find((b) => b.timestamp < iso(NOW - DAY) && b.status === "Completed")
  const day = new Date(restoredFrom.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  const entry = (id, ago, eventType, action, result = "SUCCESS", severity = "INFO") => ({
    id: `${tenant.id}-${id}`,
    timestamp: iso(NOW - ago),
    eventType,
    action,
    result,
    severity,
    resource: { type: "tenant", id: tenant.guid, name: tenant.name },
    user: { id: tenant.guid, name: tenant.admin, email: `admin@${tenant.domain}` },
  })
  return [
    entry("drift-1", 65 * MIN, "POLICY_DRIFT_DETECTED", "Drift check found 7 changes across the last 5 backups"),
    entry("restore-1", 2 * HOUR + 10 * MIN, "POLICY_RESTORED", `Restored 3 policies from the backup of ${day}`),
    entry("schedule-1", 26 * HOUR, "SCHEDULE_UPDATED", `Automatic backups set to daily at ${tenant.schedule?.time ?? "02:00"}`),
    entry("drift-2", 29 * HOUR, "POLICY_DRIFT_DETECTED", "Drift check found 2 changes across the last 5 backups"),
    entry("auth-1", 30 * HOUR, "AUTH_SIGN_IN", `${tenant.admin} signed in`),
  ]
}

function driftsFor(tenant) {
  const list = BACKUPS[tenant.guid].filter((b) => b.status === "Completed")
  const pair = (i) => ({ fromBackup: list[i + 1].id, toBackup: list[i].id, fromBackupTimestamp: list[i + 1].timestamp, toBackupTimestamp: list[i].timestamp, detectedAt: list[i].timestamp, comparisonIndex: i })
  // Pick comparisons at different ages so the list and timeline show a spread.
  const at = (hoursAgo) => Math.max(0, list.findIndex((b) => Date.parse(b.timestamp) < NOW - hoursAgo * HOUR))
  const drift = (id, i, fields) => ({ id: `drift-${id}`, configId: `${id}-a3f1c9e2`, affectedPolicies: 1, ...pair(i), ...fields })
  const drifts = [
    drift("defender", at(4), {
      severity: "critical", type: "Configuration Policy", configName: "WIN - Defender Antivirus - Baseline", changeType: "modified",
      description: "Real-time protection and cloud protection settings changed outside of change control.",
      impact: "Devices lose real-time scanning and fall back to the default cloud block level at their next check-in.",
      affectedDevices: 1962,
      changes: [
        { field: "Allow Realtime Monitoring", oldValue: "Allowed", newValue: "Not allowed" },
        { field: "Cloud Block Level", oldValue: "High plus", newValue: "Default" },
        { field: "Submit Samples Consent", oldValue: "Send safe samples automatically", newValue: "Always prompt" },
      ],
    }),
    drift("ca001", at(9), {
      severity: "critical", type: "Conditional Access", configName: "CA001 - Require MFA for admins", changeType: "modified",
      description: "The policy was switched to report-only and a group was excluded.",
      impact: "Administrators can sign in without multifactor authentication while the policy is report-only.",
      affectedDevices: 0,
      changes: [
        { field: "state", oldValue: "enabled", newValue: "enabledForReportingButNotEnforced" },
        { field: "conditions.users.excludeGroups", oldValue: "BreakGlass-Accounts", newValue: "BreakGlass-Accounts, IT-Contractors" },
      ],
    }),
    drift("bitlocker", at(22), {
      severity: "warning", type: "Device Configuration", configName: "WIN - BitLocker - OS Drive", changeType: "modified",
      description: "The encryption method for operating system drives was lowered.",
      impact: "Newly encrypted drives use XTS-AES 128 instead of the required XTS-AES 256.",
      affectedDevices: 1874,
      changes: [{ field: "bitLockerEncryptionMethod", oldValue: "xtsAes256", newValue: "xtsAes128" }],
    }),
    drift("ios-compliance", at(31), {
      severity: "warning", type: "Compliance Policy", configName: "iOS - Compliance - Corporate", changeType: "modified",
      description: "Minimum OS version and passcode length were relaxed.",
      impact: "Older iOS devices and devices with short passcodes are reported as compliant.",
      affectedDevices: 412,
      changes: [
        { field: "osMinimumVersion", oldValue: "17.0", newValue: "16.0" },
        { field: "passcodeMinimumLength", oldValue: 6, newValue: 4 },
      ],
    }),
    drift("filevault", at(47), {
      severity: "critical", type: "Configuration Policy", configName: "macOS - FileVault", changeType: "deleted",
      description: "The policy no longer exists in Intune.",
      impact: "New Macs are no longer required to turn on FileVault disk encryption.",
      affectedDevices: 286,
    }),
    drift("whfb", at(70), {
      severity: "info", type: "Configuration Policy", configName: "WIN - Windows Hello for Business", changeType: "added",
      description: "A new policy was created in Intune.",
      impact: "Review the assignment before it reaches production devices.",
      affectedDevices: 0,
    }),
    drift("outlook-app", at(96), {
      severity: "info", type: "App Protection", configName: "Android - App Protection - Outlook", changeType: "added",
      description: "A new app protection policy was created in Intune.",
      impact: "Review the data transfer settings before assigning it to all users.",
      affectedDevices: 0,
    }),
  ]
  return {
    drifts,
    summary: { total: drifts.length, critical: 3, warning: 2, info: 2, affectedTenants: 1 },
    lastScan: iso(NOW - 65 * MIN),
    backupsAnalyzed: 5,
  }
}

const tenantProfile = (t) => ({
  id: t.id,
  createdAt: iso(NOW - 180 * DAY),
  name: t.name,
  domain: t.domain,
  status: "healthy",
  lastBackup: BACKUPS[t.guid][0].timestamp,
  configCount: BACKUPS[t.guid][0].policies.deviceConfigurations + BACKUPS[t.guid][0].policies.configurationPolicies,
  storageUsed: "",
  client: "",
  license: "",
  region: "",
  tags: [],
  users: t.users,
  devices: t.devices,
  complianceRate: 96,
  industry: "",
  environment: "",
  lastSync: iso(NOW - 12 * MIN),
  syncStatus: "idle",
  policies: {
    compliance: BACKUPS[t.guid][0].policies.compliancePolicies,
    configuration: BACKUPS[t.guid][0].policies.deviceConfigurations,
    apps: BACKUPS[t.guid][0].policies.appProtectionPolicies,
  },
  credentials: { tenantId: t.guid, appId: CLIENT_ID, clientSecret: DELEGATED_CLIENT_SECRET },
  resources:
    t.storage === "local"
      ? { subscriptionId: "local", subscriptionName: "", resourceGroupName: "local", storageAccountName: `tvlocal-${t.guid}`, automationAccountName: "" }
      : { subscriptionId: "3f2a9c4e-6b1d-4e8f-a7c5-2d9e0b4f6a18", subscriptionName: "MSP Backup", resourceGroupName: "rg-tenuvault-backups", resourceGroupLocation: "westeurope", storageAccountName: t.storage, automationAccountName: "" },
})

const MOCK = {
  tenants: TENANTS.map(tenantProfile),
  accounts: TENANTS.map((t) => ({ tenantId: t.guid, clientId: CLIENT_ID, username: `admin@${t.domain}`, name: t.admin })),
  license: {
    hasKey: true,
    keyHint: "****7QXM",
    persisted: true,
    offline: false,
    message: null,
    plan: "msp",
    tenantLimit: 25,
    communityTenantId: null,
    tenants: TENANTS.map((t) => ({
      tenantId: t.guid, signedIn: true, activated: true, entitled: true, source: "key", plan: "msp", tenants: 25,
      expiresAt: iso(NOW + 27 * DAY), shared: true, shareNeedsSignIn: false, displayKey: null, message: null,
    })),
  },
  schedules: TENANTS.filter((t) => t.schedule).map((t) => {
    const { next, last } = scheduleRuns(t.schedule)
    const items = BACKUPS[t.guid].find((b) => b.status === "Completed").totalPolicies
    return {
      tenantId: t.guid, enabled: true, ...t.schedule, since: iso(NOW - 26 * HOUR),
      lastRunAt: iso(last + between(20, 50) * 1000), lastStatus: "Completed", lastMessage: `Backup completed, ${items.toLocaleString("en-US")} items`,
      nextRunAt: iso(next),
    }
  }),
  preferences: { startAtLogin: true, keepRunningInTray: true, retentionDays: 90, autoUpdate: true, nightlyUpdates: false, autoUpdateManaged: false },
  backupSettings: { localFolder: "/Users/megan/Documents/TenuVault Backups", keyFingerprint: "7F3A-91C2-4D0E" },
  backups: BACKUPS,
  audit: Object.fromEntries(TENANTS.map((t) => [t.guid, auditFor(t)])),
  drift: Object.fromEntries(TENANTS.map((t) => [t.guid, driftsFor(t)])),
}

// Runs inside the Electron main process. Replaces the IPC handlers the preload bridge calls.
const MAIN_OVERRIDES = `(() => {
  const req = process.getBuiltinModule("module").createRequire(process.cwd() + "/marketing-shots.cjs")
  const { ipcMain, BrowserWindow } = req("electron")
  const M = globalThis.__marketingMock = ${JSON.stringify(MOCK)}
  const json = (status, value) => ({ status, statusText: status === 200 ? "OK" : "Not Found", headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(value)) })
  const handle = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, (_event, ...args) => fn(...args)) }
  const readBody = (request) => { try { return request.body ? JSON.parse(new TextDecoder().decode(request.body)) : {} } catch { return {} } }
  // OpenIntuneBaseline: the real handler loads the public baseline from GitHub (oib-versions,
  // oib-load); comparisons, validations and runs come from demo data built on that catalog.
  const originalApi = ipcMain._invokeHandlers?.get("api")
  if (typeof originalApi !== "function") throw new Error("The app's api IPC handler was not found; cannot load OpenIntuneBaseline from GitHub")
  // Only these public GitHub reads reach the app's handler. Everything else (deploy, fix, undo)
  // would need a license check or a Microsoft token, so it is answered here or refused.
  const PASS_THROUGH = new Set(["oib-source", "oib-versions", "oib-downloads", "oib-load"])
  const decode = (response) => JSON.parse(new TextDecoder().decode(response.body))
  const forward = async (event, body) => {
    const response = await originalApi(event, { method: "POST", path: "/api/oib", headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) })
    return { status: response.status, value: decode(response) }
  }
  const catalogs = new Map()
  const loadCatalog = async (event, platform, commit, tag) => {
    const key = platform + "@" + commit + "@" + (tag ?? "main")
    if (!catalogs.has(key)) {
      const { status, value } = await forward(event, { action: "oib-load", platform, commit, ...(tag ? { tag } : {}) })
      if (status !== 200) throw new Error(value.error || "oib-load failed")
      catalogs.set(key, value)
    }
    return catalogs.get(key)
  }
  const hash = (text) => { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296 }
  const fakeId = (text) => { const hex = [...Array(32)].map((_, i) => Math.floor(hash(text + i) * 16).toString(16)).join(""); return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) + "-a" + hex.slice(17, 20) + "-" + hex.slice(20, 32) }
  const versionOf = (name) => (String(name).match(/v(\\d+)\\.(\\d+)/) || [])
  // Outdated needs a lower minor version to show, so v1.0 policies are shown as up to date.
  const statusOf = (policy) => {
    const r = hash(policy.source)
    if (r >= 0.8) return "missing"
    return r >= 0.66 && Number(versionOf(policy.name)[2]) >= 1 ? "outdated" : "current"
  }
  // Demo drift per policy area, so a mismatch always belongs to the policy it is shown on.
  const DRIFTS = {
    asr: [
      { settingDefinitionId: "device_vendor_msft_policy_config_defender_attacksurfacereductionrules_blockcredentialstealingfromwindowslocalsecurityauthoritysubsystem", label: "Block credential stealing from the Windows local security authority subsystem", oibValue: "Block", tenantValue: "Audit" },
      { settingDefinitionId: "device_vendor_msft_policy_config_defender_attacksurfacereductionrules_blockexecutablecontentfromemailclientandwebmail", label: "Block executable content from email client and webmail", oibValue: "Block", tenantValue: "Warn" },
    ],
    av: [
      { settingDefinitionId: "device_vendor_msft_policy_config_defender_puaprotection", label: "PUA Protection", oibValue: "PUA Protection on", tenantValue: "Audit mode" },
      { settingDefinitionId: "device_vendor_msft_policy_config_defender_cloudblocklevel", label: "Cloud Block Level", oibValue: "High", tenantValue: "Default State" },
    ],
    bitlocker: [
      { settingDefinitionId: "device_vendor_msft_bitlocker_requiredeviceencryption", label: "Require Device Encryption", oibValue: "Enabled", tenantValue: "Disabled" },
    ],
  }
  // Only policies of these areas drift, every one of them, so the capture always finds one.
  const driftsFor = (name) => /Attack Surface/i.test(name) ? DRIFTS.asr : /Defender Antivirus - D - AV/i.test(name) ? DRIFTS.av : /BitLocker|Encryption/i.test(name) ? DRIFTS.bitlocker : []
  const oib = async (event, body) => {
    const tenant = String(body.tenantId ?? "").toLowerCase()
    if (body.action === "oib-compare") {
      const catalog = await loadCatalog(event, body.platform, body.commit, body.tag)
      const matches = catalog.policies.map((policy) => {
        const status = statusOf(policy)
        if (status === "missing") return { source: policy.source, status, legacy: [] }
        const [, major, minor] = versionOf(policy.name)
        const oibVersion = major ? major + "." + minor : undefined
        const tenantVersion = major ? (status === "outdated" ? major + "." + (Number(minor) - 1) : oibVersion) : undefined
        const name = oibVersion && tenantVersion ? policy.name.replace("v" + oibVersion, "v" + tenantVersion) : policy.name
        return { source: policy.source, status, method: policy.oibId ? "oibid" : "name", tenant: { id: fakeId(tenant + policy.source), name, folder: policy.folder, oibId: policy.oibId }, legacy: [], tenantVersion, oibVersion }
      })
      return json(200, { tenantId: tenant, platform: body.platform, commit: catalog.commit, reference: catalog.reference, comparedAt: new Date().toISOString(), tenantPolicyCount: 142, matches, deprecated: [] })
    }
    if (body.action === "oib-validate") {
      const catalog = await loadCatalog(event, body.platform, body.commit, body.tag)
      const results = (body.items ?? []).map(({ source, targetId }) => {
        const policy = catalog.policies.find((p) => p.source === source) ?? { name: source, folder: "" }
        const total = 6 + Math.floor(hash(source + "n") * 40)
        const mismatches = driftsFor(policy.name)
        const drifted = mismatches.length > 0
        return { source, name: policy.name, folder: policy.folder, tenantPolicyId: targetId, tenantPolicyName: policy.name, status: drifted ? "drifted" : "compliant",
          result: { totalOib: total, totalTenant: total, matched: total - mismatches.length, mismatches, oibOnly: [], tenantOnly: [], compliant: !drifted } }
      })
      return json(200, { runId: fakeId("v" + Date.now()), tenantId: tenant, platform: body.platform, commit: catalog.commit, reference: catalog.reference, validatedAt: new Date().toISOString(), results })
    }
    if (body.action === "oib-runs") {
      const versions = await forward(event, { action: "oib-versions" })
      if (versions.status !== 200) return json(200, { runs: [] })
      const latest = versions.value.releases.find((release) => release.platform === "windows")
      const catalog = await loadCatalog(event, "windows", latest?.commit ?? versions.value.main.commit, latest?.tag)
      const created = catalog.policies.filter((p) => statusOf(p) === "missing").map((p) => ({ folder: p.folder, id: fakeId(tenant + p.source), name: p.name }))
      const createdAt = new Date(Date.now() - 3 * 86400000).toISOString()
      const name = M.tenants.find((t) => t.credentials.tenantId === tenant)?.name ?? "Contoso Ltd"
      const run = { runId: fakeId(tenant + "run"), tenantId: tenant, createdAt, kind: "deploy", platform: "windows", reference: catalog.reference, commit: catalog.commit,
        backupFolder: name + "/" + createdAt.slice(0, 19).replaceAll(":", "-") + "Z", created, updated: [], failed: [], skipped: [] }
      return json(200, { runs: [run] })
    }
    if (body.action === "oib-progress") return json(200, null)
    if (body.action === "oib-validations" || body.action === "oib-validation-delete") return json(200, { runs: [] })
    if (!PASS_THROUGH.has(body.action)) return json(404, { error: "Not available in the demo" })
    const { status, value } = await forward(event, body)
    return json(status, value)
  }
  ipcMain.removeHandler("api")
  ipcMain.handle("api", (event, request) => {
    const path = request.path.split("?")[0]
    const body = readBody(request)
    const tenant = String(body.tenantId ?? "").toLowerCase()
    switch (path) {
      case "/api/oib": return oib(event, body).catch((error) => json(500, { error: String(error.message || error) }))
      case "/api/list-backup-contents": return json(200, { content: { groups: [{ folder: "ConfigurationPolicies", label: "configuration policy", area: "Devices", policies: [{ path: body.backupId + "/ConfigurationPolicies/defender.json", displayName: "WIN - Defender Antivirus - Baseline" }] }] } })
      case "/api/restore-preview": return json(200, { items: (body.paths ?? []).map(path => ({ path, name: "WIN - Defender Antivirus - Baseline", snapshot: { name: "WIN - Defender Antivirus - Baseline", settings: [] } })) })
      case "/api/restore-backup": {
        if (body.approvalAction === "detect") return json(200, { enabled: !M.noMaa })
        if (body.approvalAction === "list") return json(200, { records: M.noMaa ? [] : [{ id: "11111111-1111-4111-8111-111111111111", label: "WIN - Defender Antivirus - Baseline", operation: "create", status: "approved", approverNote: "Reviewed against our change window. Ready to restore.", expiresAt: new Date(Date.now() + 2 * 86400000).toISOString(), stepNumber: 1, totalSteps: 2, canComplete: true, requesterName: "Taylor Morgan" }] })
        return json(200, { success: true, details: { results: (body.selectedPolicies ?? []).map(item => ({ path: item.path, success: false, retryable: false, approvalId: "11111111-1111-4111-8111-111111111111", approvalState: "submitted", approval: { kind: "pending", code: "11111111-1111-4111-8111-111111111111" }, error: "Submitted for approval" })) } })
      }
      case "/api/restore-backup/progress": return json(200, { done: 1, total: 1, current: null, results: [] })
      case "/api/list-backups": return json(200, { backups: M.backups[tenant] ?? [] })
      case "/api/audit/logs": return json(200, { data: M.audit[tenant] ?? [], total: (M.audit[tenant] ?? []).length })
      case "/api/audit/stats": return json(200, { total: 0 })
      case "/api/audit/log": return json(200, { success: true })
      case "/api/detect-drifts": return json(200, M.drift[tenant] ?? { drifts: [], summary: { total: 0, critical: 0, warning: 0, info: 0, affectedTenants: 0 }, lastScan: new Date().toISOString(), backupsAnalyzed: 0 })
      case "/api/tenant-metadata/check": return json(200, { exists: true })
      case "/api/tenant-metadata/save": case "/api/tenant-metadata/delete": return json(200, { success: true })
      case "/api/restore-journal": return json(200, { entries: [] })
      default: return json(404, { error: "Not available in the demo" })
    }
  })
  handle("auth:accounts", () => M.accounts)
  handle("license:status", () => M.license)
  handle("license:retry", () => M.license)
  handle("license:releaseTenant", () => M.license)
  handle("license:checkNewTenant", () => M.license)
  handle("schedules:list", () => M.schedules)
  handle("schedules:refusals", () => [])
  handle("preferences:get", () => M.preferences)
  handle("preferences:set", (changes) => Object.assign(M.preferences, changes))
  handle("backups:settings", () => M.backupSettings)
  handle("backups:scope", () => ({ scope: { excluded: ["Apps"] }, saved: true }))
  handle("updates:status", () => ({ state: "not-available" }))
  // Real background events would replace the demo state in the renderer.
  const blocked = new Set(["license:changed", "schedules:changed", "schedules:refusalsChanged", "updates:changed", "auth:signInRequired"])
  for (const win of BrowserWindow.getAllWindows()) {
    const send = win.webContents.send.bind(win.webContents)
    win.webContents.send = (channel, ...args) => (blocked.has(channel) ? undefined : send(channel, ...args))
  }
  return BrowserWindow.getAllWindows().length
})()`

// ---------------------------------------------------------------------------------------------
// Launch and CDP plumbing (as in scripts/smoke.mjs).
// ---------------------------------------------------------------------------------------------

const port = 9300 + Math.floor(Math.random() * 400)
const inspectPort = port + 400
const profile = mkdtempSync(join(tmpdir(), "tenuvault-marketing-"))
mkdirSync(shotsDir, { recursive: true })

const args = [desktopDir, `--remote-debugging-port=${port}`, `--inspect=${inspectPort}`, `--user-data-dir=${profile}`]
if (process.platform === "linux") args.push("--no-sandbox")
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(electronPath, args, { stdio: ["ignore", "pipe", "pipe"], env })
let appLog = ""
app.stdout.on("data", (d) => (appLog += d))
app.stderr.on("data", (d) => (appLog += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target(url, pick) {
  for (let i = 0; i < 60; i++) {
    try {
      const found = (await (await fetch(url)).json()).find(pick)
      if (found) return found.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error(`No debug target at ${url}. App log:\n${appLog.slice(-4000)}`)
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true })
    ws.addEventListener("error", j, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolveSend, rejectSend) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectSend(new Error(`${method} timed out`))
      }, 30000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) rejectSend(new Error(`${method}: ${message.error.message}`))
        else resolveSend(message.result)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  return { ws, send, evaluate }
}

let exitCode = 0
let main = null
let page = null
try {
  // 1. Main process: wait for the window, then swap in the demo IPC handlers.
  main = await connect(await target(`http://127.0.0.1:${inspectPort}/json/list`, (t) => t.type === "node"))
  const windowsReady = `(() => { try { const r = process.getBuiltinModule("module").createRequire(process.cwd() + "/x.cjs"); return r("electron").BrowserWindow.getAllWindows().length } catch { return 0 } })()`
  for (let i = 0; i < 60 && !(await main.evaluate(windowsReady)); i++) await sleep(500)
  await sleep(1000) // bootstrap registers the IPC handlers before it creates the window
  const windows = await main.evaluate(MAIN_OVERRIDES)
  if (!windows) throw new Error("App window not found in the main process")

  // 2. Renderer: seed the tenant profiles in the app's own store, then reload with the demo data.
  page = await connect(await target(`http://127.0.0.1:${port}/json/list`, (t) => t.type === "page"))
  const { send, evaluate } = page
  await send("Page.enable")
  await send("Runtime.enable")

  const waitFor = async (expression, timeout = 20000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await evaluate(expression).catch(() => false)) return true
      await sleep(250)
    }
    return false
  }
  const waitForText = (text, timeout) => waitFor(`document.body?.innerText.includes(${JSON.stringify(text)})`, timeout)
  const assertText = async (text, timeout) => {
    if (!(await waitForText(text, timeout))) throw new Error(`"${text}" did not appear on ${await evaluate("location.hash")}`)
  }
  const disableAnimations = () =>
    evaluate(`(() => {
      if (document.getElementById("marketing-no-animations")) return
      const style = document.createElement("style")
      style.id = "marketing-no-animations"
      style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }"
      document.head.appendChild(style)
    })()`)
  const setTheme = (theme) =>
    evaluate(`localStorage.setItem("tenuvault-appearance", "${theme}"); document.documentElement.classList.toggle("dark", ${theme === "dark"})`)
  const scrollAll = (to) =>
    evaluate(`[document.scrollingElement, ...document.querySelectorAll("*")].filter(e => e && (e === document.scrollingElement || (e.scrollHeight > e.clientHeight + 4 && getComputedStyle(e).overflowY !== "visible"))).forEach(e => { e.scrollTop = ${to} })`)
  const go = async (hash, text) => {
    await evaluate(`location.hash = ${JSON.stringify(hash)}`)
    await assertText(text)
  }
  // Clicks the enabled page button or link with this text (an exact match first), once it renders.
  const click = async (text) => {
    const find = `(() => {
      const all = [...document.querySelectorAll("button, a")].filter(e => !e.disabled && !e.closest("nav, aside"))
      const text = ${JSON.stringify(text)}
      return all.find(e => e.innerText.trim() === text) ?? all.find(e => e.innerText.trim().includes(text))
    })()`
    if (!(await waitFor(`!!${find}`))) throw new Error(`No enabled button "${text}" on ${await evaluate("location.hash")}`)
    await evaluate(`${find}.click()`)
  }
  const shots = []
  const screenshot = async (name) => {
    await evaluate(`document.activeElement?.blur?.()`)
    await sleep(400)
    const toast = await evaluate(`[...document.querySelectorAll('[role="status"], [role="alert"]')].map(e => e.innerText).join(" | ")`)
    if (/fail|error|could not|unavailable/i.test(toast)) throw new Error(`Error visible before ${name}: ${toast}`)
    const { data } = await send("Page.captureScreenshot", { format: "png" })
    const file = join(shotsDir, `${name}.png`)
    writeFileSync(file, Buffer.from(data, "base64"))
    shots.push(name)
    console.log(`shot ${file}`)
  }

  await waitFor(`typeof window.tenuvault?.storage?.setItem === "function"`, 30000)
  await evaluate(`Promise.all([
    window.tenuvault.storage.setItem("tenuvault_tenants", ${JSON.stringify(JSON.stringify(MOCK.tenants))}),
    window.tenuvault.storage.setItem("tenuvault_selected_tenant", "1"),
  ])`)
  await setTheme("light")
  await evaluate(`location.hash = "#/portal/overview"; location.reload()`)
  await sleep(1500)
  await assertText("All tenants", 30000)
  await disableAnimations()

  if (process.env.MAA_SHOTS === "1") {
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false })
    await go("#/portal/backup?tab=restore", "Choose a backup")
    await evaluate(`document.querySelector('[role="option"]').click()`)
    await assertText("Select all")
    await click("Select all")
    await click("Next")
    await click("Review")
    await assertText("Justification")
    await evaluate(`document.querySelector("textarea[aria-describedby='approval-help']").scrollIntoView({ block: "center" })`)
    await scrollAll(0)
    await screenshot("maa-confirm")
    await click("Restore 1 item")
    await assertText("Submitted for approval")
    await screenshot("maa-submitted")
    await click("Waiting for approval")
    await assertText("Reviewed against our change window")
    await scrollAll(0)
    await screenshot("maa-approved")
    await main.evaluate(`globalThis.__marketingMock.noMaa = true`)
    await go("#/portal/overview", "All tenants")
    await go("#/portal/backup?tab=restore", "Choose a backup")
    await evaluate(`document.querySelector('[role="option"]').click()`)
    await assertText("Select all")
    await click("Select all")
    await click("Next")
    await click("Review")
    await assertText("Restore 1 item")
    const approvalVisible = await evaluate(`!!document.querySelector("textarea[aria-describedby='approval-help'], #restore-approval-list")`)
    if (approvalVisible) throw new Error("Non-MAA tenant shows approval controls")
    await scrollAll(0)
    await screenshot("restore-no-maa-confirm")
  } else {
  // All tenants overview.
  await assertText("Adatum Corporation")
  await assertText("admin@contoso.onmicrosoft.com")
  await sleep(800)
  await screenshot("overview-light")

  // Contoso dashboard, light and dark, top and scrolled to the recent activity.
  await go("#/portal/dashboard", "Policies protected")
  await assertText("1284")
  await assertText("Last comparison of backups")
  await assertText("Drift check found 7 changes")
  // Let "Last updated" read a few seconds instead of "0 second ago".
  await sleep(4000)
  await scrollAll(0)
  await screenshot("dashboard-light")
  await scrollAll(100000)
  await screenshot("dashboard-light-scrolled")
  await scrollAll(0)
  await setTheme("dark")
  await sleep(400)
  await screenshot("dashboard-dark")
  await setTheme("light")

  // Backup history and schedule.
  await go("#/portal/backup", "Backup Timeline")
  await assertText("Everything except apps")
  await sleep(800)
  await scrollAll(0)
  await screenshot("backup-history-light")
  await go("#/portal/backup?tab=schedule", "Automatic backups")
  await assertText("Last automatic backup")
  await assertText("Backup completed, 1,284 items")
  await sleep(800)
  await screenshot("backup-schedule-light")

  // Drift detection: summary and the list of findings.
  await go("#/portal/drift", "WIN - Defender Antivirus - Baseline")
  await assertText("macOS - FileVault")
  await sleep(1000)
  await scrollAll(0)
  await screenshot("drift-light")
  await setTheme("dark")
  await sleep(400)
  await screenshot("drift-dark")

  // Guided setup, dark.
  await go("#/portal/onboarding", "Set up TenuVault")
  await sleep(800)
  await scrollAll(0)
  await screenshot("setup-dark")
  await setTheme("light")

  // OpenIntuneBaseline: the real baseline from GitHub against the demo tenant.
  await go("#/portal/oib", "Deployment history")
  await assertText("Versions: Windows", 60000)
  await assertText("OpenIntuneBaseline Windows", 60000)
  await sleep(800)
  await scrollAll(0)
  await screenshot("oib-home-light")
  await setTheme("dark")
  await sleep(400)
  await screenshot("oib-home-dark")
  await setTheme("light")
  await click("Change versions")
  await assertText("Use latest releases")
  await sleep(300)
  await scrollAll(0)
  await screenshot("oib-versions")
  await click("Done")

  await go("#/portal/oib/new", "Select the operating systems")
  await click("Windows 11 devices")
  await sleep(300)
  await screenshot("oib-new-platforms")
  await click("Continue")
  await assertText("primary licensing")
  await click("Microsoft 365 E3, E5 or E7")
  await click("Defender for Endpoint is the primary antivirus")
  await click("Autopatch manages Windows Update deployment")
  await sleep(300)
  await screenshot("oib-new-licensing")
  await click("Continue")
  await assertText("Choose the policy types", 90000)
  await sleep(300)
  await screenshot("oib-new-types")
  await click("Continue")
  await assertText("Review and select the policies")
  await sleep(500)
  await scrollAll(0)
  await screenshot("oib-new-select")
  await click("Review deployment")
  await sleep(800)
  await scrollAll(100000)
  await screenshot("oib-new-deploy")

  await go("#/portal/oib", "Deployment history")
  await go("#/portal/oib/existing", "All OpenIntuneBaseline workflows")
  await click("Windows 11 devices")
  await click("Compare")
  await assertText("Update available", 90000)
  await sleep(500)
  await scrollAll(0)
  await screenshot("oib-existing")

  await go("#/portal/oib", "Deployment history")
  await go("#/portal/oib/validate", "All OpenIntuneBaseline workflows")
  await click("Windows 11 devices")
  await click("Continue")
  await assertText("Validate all", 90000)
  await click("Validate all")
  // Open the details of the first drifted policy and bring it into view.
  const driftedRow = `[...document.querySelectorAll("li")].find(li => li.innerText.includes("Drift detected") && [...li.querySelectorAll("button")].some(b => b.innerText.trim() === "Details"))`
  if (!(await waitFor(`!!${driftedRow}`, 60000))) throw new Error("No drifted policy with Details after Validate all")
  await evaluate(`[...${driftedRow}.querySelectorAll("button")].find(b => b.innerText.trim() === "Details").click()`)
  await sleep(500)
  await scrollAll(0)
  await screenshot("oib-validate")

  // Frameworks catalog.
  await go("#/portal/frameworks", "Frameworks")
  await sleep(1500)
  await scrollAll(0)
  await screenshot("frameworks-light")

  }

  if (assetsDir) {
    const names = {
      "dashboard-light": "08b-dashboard-tenant-light",
      "dashboard-dark": "08b-dashboard-tenant-dark",
      "dashboard-light-scrolled": "08c-dashboard-tenant-light-end",
      "overview-light": "08d-overview-light",
      "backup-schedule-light": "10-refused-backup",
      "setup-dark": "13-setup-dark",
      "drift-light": "drift-light",
      "drift-dark": "drift-dark",
      "backup-history-light": "backup-history-light",
    }
    mkdirSync(assetsDir, { recursive: true })
    for (const shot of shots) {
      const out = join(assetsDir, `${names[shot] ?? shot}.jpg`)
      execFileSync("sips", ["-Z", "1800", "-s", "format", "jpeg", "-s", "formatOptions", "85", join(shotsDir, `${shot}.png`), "--out", out], { stdio: "ignore" })
      console.log(`jpeg ${out}`)
    }
  }
  console.log(`\n${shots.length} screenshots in ${shotsDir}`)
} catch (error) {
  exitCode = 1
  console.error(`FAILED: ${error.message}`)
  if (page) {
    const { data } = await page.send("Page.captureScreenshot", { format: "png" }).catch(() => ({}))
    if (data) writeFileSync(join(shotsDir, "failure.png"), Buffer.from(data, "base64"))
  }
} finally {
  page?.ws.close()
  main?.ws.close()
  const exited = new Promise((r) => app.once("exit", r))
  app.kill()
  await Promise.race([exited, sleep(5000)])
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (error) {
    console.warn(`Could not remove profile ${profile}: ${error.message}`)
  }
  process.exit(exitCode)
}
