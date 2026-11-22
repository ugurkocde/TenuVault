import { isGuid } from "../../shared/security"
import { SETTINGS_FILE_KIND, SETTINGS_FILE_LIMIT, SETTINGS_SCHEMA_VERSION } from "../../shared/settings-transfer"

/**
 * The structure of a settings file. Checks here decide whether the file can be read at all; each
 * setting's value is checked later, on its own, so one bad value only blocks that setting.
 */

/** Thrown for a file that cannot be read as a whole; the message says why and nothing is applied. */
export class SettingsFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SettingsFileError"
  }
}

export interface SettingsFileTenant {
  /** Lowercase tenant ID. */
  tenantId: string
  name?: string
  domain?: string
  services?: unknown
  backupScope?: unknown
  schedule?: unknown
  cloudBackup?: unknown
  connection?: unknown
  /** Fields this version does not know, listed in the preview under the tenant's name. */
  unknown: string[]
}

export interface SettingsFileApp {
  preferences?: unknown
  appearance?: unknown
  pdfBranding?: unknown
}

export interface SettingsFile {
  exportedAt: string
  appVersion: string
  app?: SettingsFileApp
  tenants: SettingsFileTenant[]
  /** Parts this version does not know; listed in the preview and never applied. */
  skipped: string[]
}

const TOP_LEVEL = new Set(["kind", "schemaVersion", "exportedAt", "appVersion", "app", "tenants"])
const APP_FIELDS = new Set(["preferences", "appearance", "pdfBranding"])
const TENANT_FIELDS = new Set(["tenantId", "name", "domain", "services", "backupScope", "schedule", "cloudBackup", "connection"])
/** More tenants than any license covers; keeps a crafted file from building a huge preview. */
const MAX_TENANTS = 1000
const LABEL_LIMIT = 256

const NOT_A_SETTINGS_FILE = "This file is not a TenuVault settings file."

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A short label from the file, without control characters. */
function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  // Control characters are intentionally replaced in labels shown in the preview.
  // oxlint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, LABEL_LIMIT)
  return text || undefined
}

/** Reads a settings file. Throws SettingsFileError when the file as a whole cannot be used. */
export function parseSettingsFile(text: string): SettingsFile {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > SETTINGS_FILE_LIMIT) throw new SettingsFileError("The settings file is larger than 5 MB.")
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new SettingsFileError(NOT_A_SETTINGS_FILE)
  }
  if (!isObject(raw) || raw.kind !== SETTINGS_FILE_KIND) throw new SettingsFileError(NOT_A_SETTINGS_FILE)
  const version = raw.schemaVersion
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new SettingsFileError("The settings file has no valid version.")
  if (version > SETTINGS_SCHEMA_VERSION) {
    const made = label(raw.appVersion)
    throw new SettingsFileError(`This file was made by a newer version of TenuVault${made ? ` (${made})` : ""}. Update TenuVault to import it.`)
  }

  const skipped: string[] = []
  for (const key of Object.keys(raw)) if (!TOP_LEVEL.has(key)) skipped.push(`Section "${label(key) ?? "unnamed"}"`)

  let app: SettingsFileApp | undefined
  if (raw.app !== undefined) {
    if (!isObject(raw.app)) throw new SettingsFileError("The settings of this computer in the file are not valid.")
    app = {}
    for (const [key, value] of Object.entries(raw.app)) {
      if (APP_FIELDS.has(key)) app[key as keyof SettingsFileApp] = value
      else skipped.push(`This computer: "${label(key) ?? "unnamed"}"`)
    }
  }

  const tenants: SettingsFileTenant[] = []
  if (raw.tenants !== undefined) {
    if (!Array.isArray(raw.tenants)) throw new SettingsFileError("The tenants in the file are not a list.")
    if (raw.tenants.length > MAX_TENANTS) throw new SettingsFileError("The settings file lists too many tenants.")
    const seen = new Set<string>()
    for (const entry of raw.tenants) {
      if (!isObject(entry) || !isGuid(entry.tenantId)) throw new SettingsFileError("A tenant in the file has no valid tenant ID.")
      const tenantId = entry.tenantId.toLowerCase()
      if (seen.has(tenantId)) throw new SettingsFileError(`The tenant ${tenantId} is listed twice in the file.`)
      seen.add(tenantId)
      const tenant: SettingsFileTenant = { tenantId, name: label(entry.name), domain: label(entry.domain), unknown: [] }
      for (const [key, value] of Object.entries(entry)) {
        if (!TENANT_FIELDS.has(key)) tenant.unknown.push(label(key) ?? "unnamed")
        else if (key !== "tenantId" && key !== "name" && key !== "domain") tenant[key as "services"] = value
      }
      tenants.push(tenant)
    }
  }

  const exportedAt = typeof raw.exportedAt === "string" && Number.isFinite(Date.parse(raw.exportedAt)) ? new Date(raw.exportedAt).toISOString() : ""
  return { exportedAt, appVersion: label(raw.appVersion) ?? "", ...(app && { app }), tenants, skipped }
}

/** The JSON text of a settings file, indented so it stays readable. */
export function writeSettingsFile(content: { exportedAt: string; appVersion: string; app?: Record<string, unknown>; tenants: Array<Record<string, unknown>> }): string {
  return `${JSON.stringify({ kind: SETTINGS_FILE_KIND, schemaVersion: SETTINGS_SCHEMA_VERSION, exportedAt: content.exportedAt, appVersion: content.appVersion, ...(content.app && { app: content.app }), tenants: content.tenants }, null, 2)}\n`
}
