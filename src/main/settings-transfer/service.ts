import { createHash, randomUUID } from "node:crypto"
import { parseCloudSetup, type CloudBackupConfig } from "../../shared/cloud-backup"
import { LOCAL_STORAGE_PREFIX } from "../../shared/constants"
import type { AppPreferences, BackupSchedule, ScheduleInput } from "../../shared/ipc"
import { INTUNE_TYPES } from "../../shared/intune/registry"
import { includedTypes, normalizeScope, presetOf, type BackupScope } from "../../shared/intune/scope"
import type { PdfBranding } from "../../shared/pdf/theme"
import { allows, COMMUNITY_RETENTION_DAYS, type Plan } from "../../shared/plans"
import { isGuid } from "../../shared/security"
import { MODULES, type ModuleId } from "../../shared/services/modules"
import type { AppearanceSetting, SettingsExportOptions, SetupConnection, SetupStorage, TransferApplyResult, TransferGroup, TransferItem, TransferPreview } from "../../shared/settings-transfer"
import { VALID_TIME, validWeekday } from "../backup/scheduler"
import type { KeyValueStore } from "../storage/secure-store"
import { parseSettingsFile, writeSettingsFile, type SettingsFile, type SettingsFileTenant } from "./file"

/**
 * Export, preview and apply of settings files. Every value comes from the stores through the same
 * classes the Settings page uses, and every applied value goes back through their setters, so a
 * file can never write what the Settings page could not. Nothing secret is read: no license, sign-in,
 * key, certificate, proxy password or client secret is part of a settings file.
 */

/** Preferences a settings file carries. Dismissed notices and one-time notes stay on each computer. */
const EXPORTED_PREFERENCES = ["retentionDays", "keepRunningInTray", "startAtLogin", "autoUpdate", "nightlyUpdates"] as const
type ExportedPreference = (typeof EXPORTED_PREFERENCES)[number]

/** Where the tray icon lives, as the Settings labels name it. */
const ICON_LOCATION = process.platform === "darwin" ? "menu bar" : "tray"
const PREFERENCE_LABELS: Record<ExportedPreference, string> = {
  retentionDays: "Keep backups for",
  keepRunningInTray: `Keep running in the ${ICON_LOCATION} when I close the window`,
  startAtLogin: `Start TenuVault in the ${ICON_LOCATION} when I sign in to this computer`,
  autoUpdate: "Download and install updates automatically",
  nightlyUpdates: "Get nightly builds",
}

/** Preferences that change how this computer behaves, so they start unselected. */
const PREFERENCE_WARNINGS: Partial<Record<ExportedPreference, string>> = {
  startAtLogin: "This changes how TenuVault starts on this computer.",
  nightlyUpdates: "This switches this computer between stable releases and nightly builds.",
}

const SCHEDULE_WARNING = "If another computer also runs this schedule, the tenant is backed up twice. Usually one computer, or cloud backups, runs the schedule."
const NOT_VALID = "The value in the file is not valid."
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const APPEARANCES: Record<AppearanceSetting, string> = { system: "Same as the system", light: "Light", dark: "Dark" }

const TENANTS_KEY = "renderer.tenuvault_tenants"
const cloudKey = (tenantId: string) => `renderer.tenuvault_cloud_backup_${tenantId.toLowerCase()}`

/** Import sessions last as long as a setup through onboarding may take. */
const SESSION_MS = 60 * 60 * 1000
const MAX_SESSIONS = 5
/** More item IDs than any preview has; a larger request is refused before any work. */
const MAX_ITEMS = 5000
/** Unknown parts the review lists by name. */
const MAX_SKIPPED = 50

export interface SettingsTransferDeps {
  store: KeyValueStore
  preferences: {
    get(): Omit<AppPreferences, "autoUpdateManaged">
    saved(): Partial<Omit<AppPreferences, "autoUpdateManaged">>
    set(changes: Partial<Omit<AppPreferences, "autoUpdateManaged">>): unknown
  }
  /** Updates are managed by the organization (policy or MSI install); the preference is then not applied. */
  autoUpdateManaged: () => boolean
  branding: {
    get(): PdfBranding | null
    /** Saves branding; throws PlanRequired when no tenant on this computer may use it. */
    set(value: unknown): unknown
    /** Whether a tenant on this computer is on a plan with PDF branding. */
    available(): boolean
    /** Structural check of branding, without saving it. */
    validate(value: unknown): PdfBranding
  }
  modules: {
    enabled(tenantId: string): ModuleId[]
    set(tenantId: string, id: unknown, enabled: unknown): unknown
  }
  scopes: {
    get(tenantId: string): { scope: BackupScope }
    set(tenantId: string, scope: BackupScope): unknown
  }
  schedules: {
    /** The saved schedules as they are, read without any side effect (no fallback write, no notice). */
    list(): BackupSchedule[]
    set(input: ScheduleInput): unknown
  }
  /** The tenant's plan as the license knows it offline, or null when unknown. */
  plan: (tenantId: string) => Plan | null
  appVersion: string
  now?: () => Date
}

interface LocalTenant {
  tenantId: string
  name: string
  domain?: string
  clientId: string
  storage: SetupStorage | null
}

interface Candidate {
  group: string
  item: TransferItem
  /** Applies the file's value; returns what the renderer has to do itself. */
  apply?: () => { appearance?: AppearanceSetting; services?: { tenantId: string; moduleId: string } } | void
  /** A digest of the value stored on this computer now, so a change after the review is noticed in full. */
  state: string
}

interface Session {
  file: SettingsFile
  createdAt: number
  /** What each item of the last preview showed; apply accepts no other item, and none whose effect changed since. */
  reviewed: Map<string, string>
}

/**
 * What an item does as reviewed: what it showed the admin and the full value stored now. Display text
 * shortens values and names a logo only, so the stored value is compared as a digest too.
 */
const reviewKey = (candidate: Pick<Candidate, "item" | "state">) => JSON.stringify([candidate.item.current, candidate.item.next, candidate.item.warning ?? "", candidate.item.note ?? "", candidate.state])
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex")

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const onOff = (value: boolean) => (value ? "On" : "Off")
const days = (value: number) => (value === 0 ? "Keep everything" : value === 1 ? "1 day" : `${value} days`)
const isAppearance = (value: unknown): value is AppearanceSetting => value === "system" || value === "light" || value === "dark"
/** How a value from the file shows in the preview: plain values as text, anything else as not valid. */
const shown = (value: unknown) => (typeof value === "string" ? value.slice(0, 64) : typeof value === "number" || typeof value === "boolean" ? String(value) : "Not valid")
/** The branding fields this version knows; others in a file are listed as skipped. */
const BRANDING_FIELDS = ["companyName", "logo", "colors", "preparedBy", "classification", "footerText"]

function describeScope(scope: BackupScope): string {
  const preset = presetOf(scope)
  if (preset === "everything") return "Everything"
  if (preset === "policies") return "Everything except apps"
  return `${includedTypes(scope).length} of ${INTUNE_TYPES.length} types`
}

function describeSchedule(schedule: ScheduleInput | undefined): string {
  if (!schedule) return "No schedule"
  const when = schedule.frequency === "daily" ? `Daily at ${schedule.time}` : `Weekly on ${WEEKDAYS[schedule.weekday ?? 0]} at ${schedule.time}`
  return schedule.enabled ? when : `${when}, paused`
}

function describeCloud(config: CloudBackupConfig | null): string {
  if (!config) return "Not set up"
  const when = !config.time ? "" : config.frequency === "weekly" ? `, weekly on ${WEEKDAYS[config.weekday] ?? WEEKDAYS[0]} at ${config.time}` : `, daily at ${config.time}`
  return `${config.automationAccount} in ${config.resourceGroup}, storage account ${config.storageAccount}${when}${config.linked ? "" : ", schedule not linked yet"}`
}

function describeStorage(storage: SetupStorage | null | undefined): string {
  if (!storage) return "Not set"
  return storage.kind === "local" ? "This computer" : `Azure storage account ${storage.storageAccountName}`
}

function describeBranding(branding: PdfBranding | null): string {
  if (!branding) return "TenuVault design"
  const parts = [branding.logo && "logo", branding.colors && "colors", branding.preparedBy && "prepared by", branding.classification && "classification", branding.footerText && "footer text"].filter(Boolean)
  const name = branding.companyName ?? "Custom branding"
  return parts.length ? `${name}, with ${parts.join(", ")}` : name
}

/** The names of the fields that differ, so a change that reads the same as before still says what changes. */
function changedFields<T extends object>(current: T | null, next: T, names: Partial<Record<keyof T, string>>): string[] {
  return (Object.entries(names) as Array<[keyof T, string]>)
    .filter(([key]) => JSON.stringify(current?.[key]) !== JSON.stringify(next[key]))
    .map(([key, name]) => {
      const before = current?.[key]
      const after = next[key]
      // A logo is named, not printed; other values show what they are now and what they become.
      if (key === "logo") return before === undefined ? "logo (added)" : after === undefined ? "logo (removed)" : "logo (replaced)"
      return `${name} from ${valueText(before)} to ${valueText(after)}`
    })
}

/** A value of a branding or cloud setup field as the preview names it. */
function valueText(value: unknown): string {
  if (value === undefined || value === null || value === "") return "none"
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (isObject(value)) return Object.entries(value).map(([key, entry]) => `${key} ${valueText(entry)}`).join(", ") || "none"
  return `"${String(value).slice(0, 80)}"`
}
const BRANDING_NAMES: Partial<Record<keyof PdfBranding, string>> = { companyName: "company name", logo: "logo", colors: "colors", preparedBy: "prepared by", classification: "classification", footerText: "footer text" }
const CLOUD_NAMES: Partial<Record<keyof CloudBackupConfig, string>> = { subscriptionId: "subscription", resourceGroup: "resource group", automationAccount: "Automation account", storageAccount: "storage account", secondaryStorageAccount: "secondary storage account", secondaryContainer: "secondary container", keyVault: "key vault", scheduleName: "schedule name", frequency: "frequency", time: "time", weekday: "weekday", timeZone: "time zone", linked: "linked schedule" }
const changeNote = (fields: string[]) => (fields.length ? `Changes the ${fields.join("; the ")}.` : undefined)

/** Lists fields inside a known part that this version does not know; the known fields still apply. */
function unknownFields(value: unknown, known: readonly string[], where: string, skipped: string[]): void {
  if (!isObject(value)) return
  for (const key of Object.keys(value)) if (!known.includes(key)) skipped.push(`${where}: "${key.slice(0, 64)}"`)
}

// eslint-disable-next-line no-control-regex
const CLOUD_TEXT = /^[^\u0000-\u001f\u007f]{1,256}$/
const CLOUD_FIELDS = ["tenantId", "subscriptionId", "resourceGroup", "automationAccount", "storageAccount", "secondaryStorageAccount", "secondaryContainer", "keyVault", "scheduleName", "frequency", "time", "weekday", "timeZone", "tenantKey", "linked"]

/**
 * A cloud backup setup as the renderer stores it. Each known field is checked for its type and
 * allowed values first, because the setup parser fills in defaults for values it cannot read (an
 * unknown frequency becomes daily, any linked text other than false becomes linked). Then the
 * known fields go through that parser, one single-line value each; other fields are left out.
 */
function cloudConfig(value: unknown): CloudBackupConfig | null {
  if (!isObject(value)) return null
  const text = (field: unknown, optional: boolean) => (field === undefined || field === "" ? optional : typeof field === "string" && CLOUD_TEXT.test(field))
  const { tenantId, subscriptionId, storageAccount, frequency, time, weekday, linked } = value
  if (!isGuid(tenantId) || !(subscriptionId === undefined || subscriptionId === "" || isGuid(subscriptionId))) return null
  if (typeof storageAccount !== "string" || !/^[a-z0-9]{3,24}$/.test(storageAccount) || !text(value.resourceGroup, false) || !text(value.automationAccount, false)) return null
  if (!text(value.keyVault, true) || !text(value.scheduleName, true) || !text(value.timeZone, true) || !text(value.tenantKey, true)) return null
  if (!text(value.secondaryStorageAccount, true) || !text(value.secondaryContainer, true)) return null
  if (frequency !== undefined && frequency !== "daily" && frequency !== "weekly") return null
  if (time !== undefined && time !== "" && (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) return null
  if (weekday !== undefined && !(typeof weekday === "number" && Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)) return null
  if (linked !== undefined && typeof linked !== "boolean") return null
  const config = parseCloudSetup(CLOUD_FIELDS.filter((name) => value[name] !== undefined && value[name] !== "").map((name) => `${name}=${String(value[name])}`).join("\n"))
  if (config?.secondaryStorageAccount !== (value.secondaryStorageAccount || undefined) || config?.secondaryContainer !== (value.secondaryContainer || undefined)) return null
  return config
}

/** What a new scope changes, by type: what starts and what stops being backed up. */
function scopeChanges(current: BackupScope, next: BackupScope): { added: string[]; removed: string[] } {
  const before = new Set(includedTypes(current).map((type) => type.folder))
  const after = new Set(includedTypes(next).map((type) => type.folder))
  return {
    added: INTUNE_TYPES.filter((type) => after.has(type.folder) && !before.has(type.folder)).map((type) => type.label),
    removed: INTUNE_TYPES.filter((type) => before.has(type.folder) && !after.has(type.folder)).map((type) => type.label),
  }
}

function sameCloud(a: CloudBackupConfig | null, b: CloudBackupConfig | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function scheduleConfig(schedule: BackupSchedule | undefined): ScheduleInput | undefined {
  return schedule && { tenantId: schedule.tenantId, enabled: schedule.enabled, frequency: schedule.frequency, time: schedule.time, ...(schedule.frequency === "weekly" && { weekday: schedule.weekday }) }
}

function sameSchedule(a: ScheduleInput | undefined, b: ScheduleInput): boolean {
  return !!a && a.enabled === b.enabled && a.frequency === b.frequency && a.time === b.time && (b.frequency === "daily" || a.weekday === b.weekday)
}

/** The schedule in a file, or null when any field is not valid. */
function fileSchedule(value: unknown, tenantId: string): ScheduleInput | null {
  if (!isObject(value)) return null
  const { enabled, frequency, time, weekday } = value
  if (typeof enabled !== "boolean" || (frequency !== "daily" && frequency !== "weekly") || typeof time !== "string" || !VALID_TIME.test(time)) return null
  if (frequency === "weekly" && !validWeekday(weekday)) return null
  return { tenantId, enabled, frequency, time, ...(frequency === "weekly" && { weekday: weekday as number }) }
}

const STORAGE_ACCOUNT = /^[a-z0-9]{3,24}$/
/** Azure's rule for resource group names: Unicode letters and digits, hyphens, underscores, periods and parentheses, not ending in a period. */
const AZURE_RESOURCE_GROUP = /^[-\p{L}\p{N}_.()]{0,89}[-\p{L}\p{N}_()]$/u

/** Connection details in a file, or null when they are missing or not valid. */
function fileConnection(value: unknown, tenant: SettingsFileTenant): SetupConnection | null {
  if (!isObject(value) || !isGuid(value.clientId)) return null
  const storage = value.storage
  let parsed: SetupStorage | undefined
  if (isObject(storage) && storage.kind === "local") parsed = { kind: "local" }
  else if (isObject(storage) && storage.kind === "azure") {
    const { storageAccountName, subscriptionId, resourceGroupName, location } = storage
    if (typeof storageAccountName !== "string" || !STORAGE_ACCOUNT.test(storageAccountName) || !isGuid(subscriptionId) || typeof resourceGroupName !== "string" || !AZURE_RESOURCE_GROUP.test(resourceGroupName)) return null
    parsed = { kind: "azure", storageAccountName, subscriptionId: subscriptionId.toLowerCase(), resourceGroupName, location: typeof location === "string" ? location.slice(0, 64) : "" }
  } else if (storage !== undefined) return null
  return { tenantId: tenant.tenantId, name: tenant.name ?? tenant.domain ?? tenant.tenantId, clientId: value.clientId.toLowerCase(), ...(parsed && { storage: parsed }) }
}

function sameStorage(a: SetupStorage | null, b: SetupStorage): boolean {
  if (!a || a.kind !== b.kind) return false
  return a.kind === "local" || (b.kind === "azure" && a.storageAccountName === b.storageAccountName && a.subscriptionId.toLowerCase() === b.subscriptionId && a.resourceGroupName === b.resourceGroupName)
}

export class SettingsTransfer {
  private readonly sessions = new Map<string, Session>()
  private readonly now: () => Date

  constructor(private readonly deps: SettingsTransferDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** The settings file text for the chosen parts. Throws for options the renderer cannot have meant. */
  exportFile(options: unknown): string {
    const chosen = this.exportOptions(options)
    const tenants = this.localTenants()
    const app = chosen.app ? this.exportApp(chosen.appearance) : undefined
    const exported = chosen.tenantIds.map((tenantId) => {
      const tenant = tenants.find((entry) => entry.tenantId === tenantId)
      if (!tenant) throw new Error("Choose tenants that are connected on this computer.")
      return this.exportTenant(tenant, chosen.connection)
    })
    return writeSettingsFile({ exportedAt: this.now().toISOString(), appVersion: this.deps.appVersion, ...(app && { app }), tenants: exported })
  }

  /** Reads a settings file and keeps it for preview and apply. Throws SettingsFileError for a file that cannot be used. */
  open(text: string, appearance: unknown): TransferPreview {
    const file = parseSettingsFile(text)
    this.prune()
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!)
    const importId = randomUUID()
    this.sessions.set(importId, { file, createdAt: this.now().getTime(), reviewed: new Map() })
    return this.preview(importId, appearance)
  }

  /** The preview of an open file against the current settings, for example after a tenant was connected. */
  preview(importId: unknown, appearance: unknown): TransferPreview {
    const session = this.session(importId)
    const { groups, skipped, candidates } = this.candidates(session.file, appearance)
    session.reviewed = new Map([...candidates].map(([id, candidate]) => [id, reviewKey(candidate)] as const))
    const all = [...session.file.skipped, ...skipped]
    // A file can name any number of unknown parts; the review lists the first ones and counts the rest.
    const listed = all.length > MAX_SKIPPED ? [...all.slice(0, MAX_SKIPPED), `And ${all.length - MAX_SKIPPED} more`] : all
    return { importId: importId as string, exportedAt: session.file.exportedAt, appVersion: session.file.appVersion, groups, skipped: listed }
  }

  /**
   * Applies the chosen items of an open file and closes it. Every item is checked again against the
   * current settings, so one that became the same or blocked since the preview is reported, not
   * applied. IDs that were not part of the last preview are refused before anything is applied, also
   * when the file would offer them now, for example for a tenant connected after the preview.
   */
  apply(importId: unknown, itemIds: unknown, appearance: unknown): TransferApplyResult {
    const session = this.session(importId)
    if (!Array.isArray(itemIds) || itemIds.length > MAX_ITEMS || !itemIds.every((id) => typeof id === "string")) throw new Error("Choose the settings to apply.")
    const { candidates } = this.candidates(session.file, appearance)
    const unknown = itemIds.find((id) => !session.reviewed.has(id) || !candidates.has(id))
    if (unknown !== undefined) throw new Error("A chosen setting is not part of this file.")
    this.sessions.delete(importId as string)

    const result: TransferApplyResult = { items: [], servicesEnabled: {} }
    for (const id of new Set(itemIds as string[])) {
      const candidate = candidates.get(id)!
      const { group, item, apply } = candidate
      const entry = { id, group, label: item.label }
      if (item.status === "same") { result.items.push({ ...entry, outcome: "skipped", message: "Already the same." }); continue }
      if (item.status === "blocked" || !apply) { result.items.push({ ...entry, outcome: "failed", message: item.reason ?? NOT_VALID }); continue }
      // The setting changed on this computer since the review, so the file's value would now do something else.
      if (session.reviewed.get(id) !== reviewKey(candidate)) { result.items.push({ ...entry, outcome: "failed", message: "This setting changed since you reviewed it. Import the file again to review it." }); continue }
      try {
        const effect = apply()
        if (effect?.appearance) result.appearance = effect.appearance
        if (effect?.services) (result.servicesEnabled[effect.services.tenantId] ??= []).push(effect.services.moduleId)
        result.items.push({ ...entry, outcome: "applied" })
      } catch (error) {
        result.items.push({ ...entry, outcome: "failed", message: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  }

  private exportOptions(value: unknown): SettingsExportOptions {
    if (!isObject(value)) throw new Error("Choose what to export.")
    const { app, tenantIds, connection, appearance } = value
    if (typeof app !== "boolean" || typeof connection !== "boolean" || !Array.isArray(tenantIds) || tenantIds.length > 1000 || !tenantIds.every(isGuid)) throw new Error("Choose what to export.")
    if (!app && tenantIds.length === 0) throw new Error("Choose what to export.")
    return { app, tenantIds: [...new Set(tenantIds.map((id) => id.toLowerCase()))], connection, appearance: isAppearance(appearance) ? appearance : "system" }
  }

  private exportApp(appearance: AppearanceSetting): Record<string, unknown> {
    const saved = this.deps.preferences.saved()
    const preferences = Object.fromEntries(EXPORTED_PREFERENCES.filter((key) => saved[key] !== undefined).map((key) => [key, saved[key]]))
    const branding = this.deps.branding.get()
    return { preferences, appearance, ...(branding && { pdfBranding: branding }) }
  }

  private exportTenant(tenant: LocalTenant, connection: boolean): Record<string, unknown> {
    const enabled = new Set(this.deps.modules.enabled(tenant.tenantId))
    const services = Object.fromEntries(MODULES.filter((module) => module.optIn).map((module) => [module.id, { enabled: enabled.has(module.id) }]))
    const schedule = scheduleConfig(this.deps.schedules.list().find((entry) => entry.tenantId === tenant.tenantId))
    const cloud = this.cloud(tenant.tenantId)
    return {
      tenantId: tenant.tenantId,
      name: tenant.name,
      ...(tenant.domain && { domain: tenant.domain }),
      services,
      backupScope: this.deps.scopes.get(tenant.tenantId).scope,
      ...(schedule && { schedule: { enabled: schedule.enabled, frequency: schedule.frequency, time: schedule.time, ...(schedule.weekday !== undefined && { weekday: schedule.weekday }) } }),
      ...(cloud && { cloudBackup: cloud }),
      ...(connection && { connection: { clientId: tenant.clientId, ...(tenant.storage && { storage: tenant.storage }) } }),
    }
  }

  private session(importId: unknown): Session {
    this.prune()
    const session = typeof importId === "string" ? this.sessions.get(importId) : undefined
    if (!session) throw new Error("This settings file is no longer open. Import it again.")
    return session
  }

  private prune(): void {
    const now = this.now().getTime()
    for (const [id, session] of this.sessions) if (now - session.createdAt > SESSION_MS) this.sessions.delete(id)
  }

  /** The tenants connected on this computer, from the tenant list the renderer keeps. Client secrets are never read. */
  private localTenants(): LocalTenant[] {
    try {
      const parsed: unknown = JSON.parse(this.deps.store.get(TENANTS_KEY) ?? "[]")
      if (!Array.isArray(parsed)) return []
      return parsed.flatMap((entry): LocalTenant[] => {
        if (!isObject(entry) || !isObject(entry.credentials) || !isGuid(entry.credentials.tenantId) || typeof entry.credentials.appId !== "string") return []
        const tenantId = entry.credentials.tenantId.toLowerCase()
        const resources = isObject(entry.resources) ? entry.resources : {}
        const account = typeof resources.storageAccountName === "string" ? resources.storageAccountName : ""
        const storage: SetupStorage | null = !account ? null
          : account.startsWith(LOCAL_STORAGE_PREFIX) ? { kind: "local" }
          : { kind: "azure", storageAccountName: account, subscriptionId: String(resources.subscriptionId ?? ""), resourceGroupName: String(resources.resourceGroupName ?? ""), location: String(resources.resourceGroupLocation ?? "") }
        return [{
          tenantId,
          name: typeof entry.name === "string" && entry.name ? entry.name : tenantId,
          ...(typeof entry.domain === "string" && entry.domain && { domain: entry.domain }),
          clientId: entry.credentials.appId.toLowerCase(),
          storage,
        }]
      })
    } catch {
      return []
    }
  }

  private cloud(tenantId: string): CloudBackupConfig | null {
    try {
      const config = cloudConfig(JSON.parse(this.deps.store.get(cloudKey(tenantId)) ?? "null"))
      return config && config.tenantId === tenantId ? config : null
    } catch {
      return null
    }
  }

  /** Every item of the file with its state against the current settings, and how to apply it. */
  private candidates(file: SettingsFile, appearance: unknown): { groups: TransferGroup[]; candidates: Map<string, Candidate>; skipped: string[] } {
    const candidates = new Map<string, Candidate>()
    const groups: TransferGroup[] = []
    const skipped: string[] = []
    const add = (group: TransferGroup, candidate: Omit<Candidate, "group">) => {
      group.items.push(candidate.item)
      candidates.set(candidate.item.id, { ...candidate, group: group.id })
    }
    if (file.app) {
      const group: TransferGroup = { id: "app", title: "This computer", connected: true, items: [] }
      this.appItems(file.app, appearance, skipped).forEach((candidate) => add(group, candidate))
      groups.push(group)
    }
    const local = this.localTenants()
    for (const tenant of file.tenants) {
      const here = local.find((entry) => entry.tenantId === tenant.tenantId)
      const connection = tenant.connection === undefined ? null : fileConnection(tenant.connection, tenant)
      const group: TransferGroup = {
        id: tenant.tenantId,
        title: here?.name ?? tenant.name ?? tenant.domain ?? tenant.tenantId,
        detail: tenant.domain ?? here?.domain ?? tenant.tenantId,
        connected: !!here,
        items: [],
      }
      for (const key of tenant.unknown) skipped.push(`${group.title}: "${key}"`)
      this.unknownTenantFields(tenant, group.title, skipped)
      if (tenant.connection !== undefined && !connection) {
        add(group, this.item(`${tenant.tenantId}:connection`, "Connection details", "", "Not valid", false, "The connection details in the file are not valid, so this tenant cannot be connected from it."))
      }
      if (!here) {
        group.notice = "This tenant is not connected on this computer, so its settings are skipped."
        if (connection) group.setup = connection
      } else {
        if (connection && connection.clientId !== here.clientId) {
          group.notice = `The file was exported with the app registration ${connection.clientId}. This computer signs in to this tenant with ${here.clientId}, so permissions can differ. Check Services and permissions after applying.`
        }
        this.tenantItems(tenant, here, connection).forEach((candidate) => add(group, candidate))
      }
      groups.push(group)
    }
    return { groups, candidates, skipped }
  }

  /** Fields of a tenant's parts that this version does not know, for connected tenants and others alike. */
  private unknownTenantFields(tenant: SettingsFileTenant, title: string, skipped: string[]): void {
    if (isObject(tenant.services)) {
      for (const [id, value] of Object.entries(tenant.services)) {
        const module = MODULES.find((entry) => entry.id === id)
        if (!module) skipped.push(`${title}: the service "${id.slice(0, 64)}"`)
        else unknownFields(value, ["enabled"], `${title}: ${module.label}`, skipped)
      }
    }
    unknownFields(tenant.backupScope, ["excluded"], `${title}: what is backed up`, skipped)
    unknownFields(tenant.schedule, ["enabled", "frequency", "time", "weekday"], `${title}: backup schedule`, skipped)
    unknownFields(tenant.cloudBackup, CLOUD_FIELDS, `${title}: cloud backup setup`, skipped)
    unknownFields(tenant.connection, ["clientId", "storage"], `${title}: connection details`, skipped)
    if (isObject(tenant.connection)) unknownFields(tenant.connection.storage, ["kind", "storageAccountName", "subscriptionId", "resourceGroupName", "location"], `${title}: storage`, skipped)
  }

  private appItems(app: NonNullable<SettingsFile["app"]>, appearance: unknown, skipped: string[]): Array<Omit<Candidate, "group">> {
    const items: Array<Omit<Candidate, "group">> = []
    const current = this.deps.preferences.get()
    const preferences = isObject(app.preferences) ? app.preferences : {}
    if (app.preferences !== undefined && !isObject(app.preferences)) items.push(this.item("app:preferences", "Preferences", "", "Not valid", false, NOT_VALID))
    for (const key of Object.keys(preferences)) {
      if (!(EXPORTED_PREFERENCES as readonly string[]).includes(key)) skipped.push(`This computer: "${key.slice(0, 64)}"`)
    }
    const plans = this.localTenants().map((tenant) => this.deps.plan(tenant.tenantId))
    const customRetention = plans.some((plan) => plan !== null && allows(plan, "customRetention"))
    const communityHere = plans.includes("community") || !customRetention
    const saved = this.deps.preferences.saved()
    // A value the file sets on purpose that only matches this computer's default is saved as a choice,
    // so it does not follow a different default of a later version.
    const DEFAULT_NOTE = "Same as now, which is the default here. Applying it keeps it as a choice when a later version changes the default."
    for (const key of EXPORTED_PREFERENCES) {
      if (!Object.hasOwn(preferences, key)) continue
      const value = preferences[key]
      const id = `app:${key}`
      const label = PREFERENCE_LABELS[key]
      if (key === "retentionDays") {
        const valid = typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3650
        const limited = valid && !customRetention && (value === 0 || value > COMMUNITY_RETENTION_DAYS)
        const capped = valid && communityHere && (value === 0 || value > COMMUNITY_RETENTION_DAYS)
        // A shorter period deletes backups, of every tenant on this computer, so it starts unticked.
        const shorter = valid && value > 0 && (current.retentionDays === 0 || value < current.retentionDays)
        const asDefault = valid && value === current.retentionDays && saved.retentionDays === undefined
        const note = [
          "Applies to every tenant on this computer.",
          capped && `On Community, TenuVault keeps at most ${COMMUNITY_RETENTION_DAYS} days.`,
          asDefault && DEFAULT_NOTE,
        ].filter(Boolean).join(" ")
        items.push(this.item(id, label, days(current.retentionDays), valid ? days(value) : shown(value), valid && value === current.retentionDays && !asDefault, valid ? null : NOT_VALID, {
          ...(limited && { feature: "customRetention" as const }),
          note,
          state: [current.retentionDays, saved.retentionDays],
          ...(shorter && { warning: `Keeps backups for a shorter time, for every tenant on this computer, also those not in the file. After the next complete backup of a tenant, its backups older than ${days(value as number)} are deleted.` }),
          apply: () => void this.deps.preferences.set({ retentionDays: value as number }),
        }))
        continue
      }
      const valid = typeof value === "boolean"
      const now = key === "autoUpdate" ? current.autoUpdate && !this.deps.autoUpdateManaged() : current[key]
      // Settings locks both update settings while the organization manages updates.
      const managed = (key === "autoUpdate" || key === "nightlyUpdates") && this.deps.autoUpdateManaged()
      const asDefault = valid && value === now && saved[key] === undefined && !managed
      // Turning automatic updates back on follows the channel this computer is set to, which can be nightly.
      const resumesNightly = key === "autoUpdate" && value === true && !now && current.nightlyUpdates
      const warning = resumesNightly ? "This computer is set to get nightly builds, so it downloads and installs nightly builds again." : PREFERENCE_WARNINGS[key]
      items.push(this.item(id, label, onOff(now), valid ? onOff(value) : shown(value), valid && value === now && !managed && !asDefault, !valid ? NOT_VALID : managed ? "Updates on this computer are managed by your organization." : null, {
        ...(warning && { warning }),
        ...(asDefault && { note: DEFAULT_NOTE }),
        state: [now, saved[key], managed, current.nightlyUpdates],
        apply: () => void this.deps.preferences.set({ [key]: value as boolean }),
      }))
    }
    if (app.appearance !== undefined) {
      const now = isAppearance(appearance) ? appearance : "system"
      const valid = isAppearance(app.appearance)
      const next = app.appearance as AppearanceSetting
      items.push(this.item("app:appearance", "Appearance", APPEARANCES[now], valid ? APPEARANCES[next] : shown(app.appearance), valid && next === now, valid ? null : NOT_VALID, {
        apply: () => ({ appearance: next }),
        state: now,
      }))
    }
    if (app.pdfBranding !== undefined) {
      const current = this.deps.branding.get()
      // Fields from a newer version are listed as skipped and left out, so they do not block the rest.
      const known = isObject(app.pdfBranding) ? Object.fromEntries(Object.entries(app.pdfBranding).filter(([key]) => BRANDING_FIELDS.includes(key))) : app.pdfBranding
      if (isObject(app.pdfBranding)) for (const key of Object.keys(app.pdfBranding)) if (!BRANDING_FIELDS.includes(key)) skipped.push(`PDF branding: "${key.slice(0, 64)}"`)
      if (isObject(app.pdfBranding)) unknownFields(app.pdfBranding.colors, ["primary", "accent"], "PDF branding colors", skipped)
      let branding: PdfBranding | null = null
      let invalid: string | null = null
      try {
        branding = this.deps.branding.validate(known)
      } catch (error) {
        invalid = error instanceof Error ? error.message : NOT_VALID
      }
      const available = this.deps.branding.available()
      const brandingNote = branding && current ? changeNote(changedFields(current, branding, BRANDING_NAMES)) : undefined
      items.push(this.item("app:pdfBranding", "PDF branding", describeBranding(current), branding ? describeBranding(branding) : "Not valid", !!branding && JSON.stringify(branding) === JSON.stringify(current), invalid ?? (available || (!!branding && JSON.stringify(branding) === JSON.stringify(current)) ? null : "PDF branding is included in Pro and MSP. No tenant on this computer has one of these plans."), {
        ...(!invalid && !available && { feature: "pdfBranding" as const }),
        ...(brandingNote && { note: brandingNote }),
        state: [current, available],
        apply: () => void this.deps.branding.set(known),
      }))
    }
    return items
  }

  private tenantItems(tenant: SettingsFileTenant, here: LocalTenant, connection: SetupConnection | null): Array<Omit<Candidate, "group">> {
    const items: Array<Omit<Candidate, "group">> = []
    const tenantId = tenant.tenantId
    const prefix = `${tenantId}:`

    if (tenant.services !== undefined) {
      const enabled = new Set(this.deps.modules.enabled(tenantId))
      const services = isObject(tenant.services) ? tenant.services : null
      if (!services) {
        items.push(this.item(`${prefix}services`, "Services", "", "Not valid", false, NOT_VALID))
      } else {
        for (const [id, value] of Object.entries(services)) {
          const module = MODULES.find((entry) => entry.id === id)
          // Modules that are always on (Intune) have nothing to apply; unknown ones are listed by name.
          if (!module || !module.optIn) continue
          const next = isObject(value) && typeof value.enabled === "boolean" ? value.enabled : null
          const now = enabled.has(module.id)
          items.push(this.item(`${prefix}service:${module.id}`, module.label, onOff(now), next === null ? "Not valid" : onOff(next), next === now, next === null ? NOT_VALID : null, {
            // Turning a service off removes it from this tenant's backups, so it starts unticked.
            ...(now && next === false && { warning: `Turns off ${module.label}: its settings are no longer backed up for this tenant.` }),
            state: now,
            apply: () => {
              this.deps.modules.set(tenantId, module.id, next)
              // Only a service turned on can need permissions this sign-in lacks.
              return next ? { services: { tenantId, moduleId: module.id } } : undefined
            },
          }))
        }
      }
    }

    if (tenant.backupScope !== undefined) {
      const raw = isObject(tenant.backupScope) && Array.isArray(tenant.backupScope.excluded) && tenant.backupScope.excluded.every((folder) => typeof folder === "string") ? tenant.backupScope.excluded as string[] : null
      const scope = raw ? normalizeScope({ excluded: raw }) : null
      const unknown = raw ? raw.filter((folder) => !INTUNE_TYPES.some((type) => type.folder === folder)).length : 0
      const empty = !!scope && includedTypes(scope).length === 0
      const current = this.deps.scopes.get(tenantId).scope
      const changes = scope ? scopeChanges(current, scope) : { added: [], removed: [] }
      // Each type that starts or stops being backed up is named; one that stops starts unticked.
      const notes = [
        changes.added.length > 0 && `Starts backing up ${changes.added.join(", ")}.`,
        unknown > 0 && `${unknown === 1 ? "One type" : `${unknown} types`} in the file ${unknown === 1 ? "is" : "are"} not known to this version and ${unknown === 1 ? "is" : "are"} left out.`,
      ].filter(Boolean).join(" ")
      items.push(this.item(`${prefix}backupScope`, "What is backed up", describeScope(current), scope ? describeScope(scope) : "Not valid", !!scope && scope.excluded.join(",") === normalizeScope(current).excluded.join(","), !scope ? NOT_VALID : empty ? "The file backs up no type this version knows." : null, {
        ...(notes && { note: notes }),
        ...(changes.removed.length > 0 && { warning: `Stops backing up ${changes.removed.join(", ")}.` }),
        state: current,
        apply: () => void this.deps.scopes.set(tenantId, scope!),
      }))
    }

    if (tenant.schedule !== undefined) {
      const schedule = fileSchedule(tenant.schedule, tenantId)
      const current = scheduleConfig(this.deps.schedules.list().find((entry) => entry.tenantId === tenantId))
      // The rules of the schedule settings: a Community tenant keeps a daily schedule it has, but cannot
      // start one, and while the plan is not known yet no daily schedule is turned on.
      const plan = this.deps.plan(tenantId)
      const newDaily = !!schedule && schedule.frequency === "daily" && current?.frequency !== "daily"
      const planBlocked = newDaily && plan === "community"
      // As in the schedule editor, which saves no enabled daily schedule while the plan is unknown, even
      // over a paused daily one.
      const planUnknown = !!schedule && schedule.frequency === "daily" && schedule.enabled && plan === null && !sameSchedule(current, schedule)
      items.push(this.item(`${prefix}schedule`, "Backup schedule", describeSchedule(current), schedule ? describeSchedule(schedule) : "Not valid", !!schedule && sameSchedule(current, schedule), !schedule ? NOT_VALID
        : planBlocked ? "Daily schedules are included in Pro and MSP. Weekly schedules are included in every plan."
        : planUnknown ? "The plan of this tenant is not known yet, so a daily schedule cannot be turned on. Import the file again once TenuVault has checked the license." : null, {
        ...(planBlocked && { feature: "dailySchedule" as const }),
        // How the scheduler runs it on Community, so the preview does not promise more than happens.
        ...(plan === "community" && schedule && { note: here.storage?.kind === "azure"
          ? "On Community, schedules of a tenant whose backups are in Azure storage are paused until it is on Pro or MSP."
          : schedule.frequency === "daily" ? "On Community, a daily schedule runs once a week." : undefined }),
        warning: SCHEDULE_WARNING,
        state: [current, plan, here.storage?.kind],
        apply: () => void this.deps.schedules.set(schedule!),
      }))
    }

    if (tenant.cloudBackup !== undefined) {
      const config = cloudConfig(tenant.cloudBackup)
      const current = this.cloud(tenantId)
      const otherTenant = !!config && config.tenantId !== tenantId
      const fields = config && current ? changeNote(changedFields(current, config, CLOUD_NAMES)) : undefined
      items.push(this.item(`${prefix}cloudBackup`, "Cloud backup setup", describeCloud(current), config ? describeCloud(config) : "Not valid", !otherTenant && sameCloud(config, current), !config ? NOT_VALID : otherTenant ? "The cloud backup setup in the file belongs to another tenant." : null, {
        note: [fields, "A record of the Azure resources an Azure administrator created. Applying it changes nothing in Azure."].filter(Boolean).join(" "),
        state: current,
        apply: () => void this.deps.store.set(cloudKey(tenantId), JSON.stringify(config)),
      }))
    }

    if (connection?.storage && !sameStorage(here.storage, connection.storage)) {
      items.push(this.item(`${prefix}storage`, "Backup storage", describeStorage(here.storage), describeStorage(connection.storage), false, "Change it in Settings > Sign-in with Change storage, which checks your access first."))
    }
    return items
  }

  private item(id: string, label: string, current: string, next: string, same: boolean, blocked: string | null, extra: Partial<Pick<TransferItem, "feature" | "warning" | "note">> & { apply?: Candidate["apply"]; state?: unknown } = {}): Omit<Candidate, "group"> {
    const { apply, state, ...rest } = extra
    const status = blocked ? "blocked" : same ? "same" : "change"
    return {
      item: { id, label, current, next, status, ...(blocked && { reason: blocked }), ...rest, selected: status === "change" && !rest.warning },
      ...(apply && { apply }),
      state: digest(state),
    }
  }
}
