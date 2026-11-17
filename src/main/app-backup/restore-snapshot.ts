import { createHash } from "node:crypto"
import type { CaptureIdentity } from "../../shared/app-sources/types"
import { appMetadataGet } from "./graph-read"

export interface AppRestoreSnapshot {
  schema: 1
  tenantId: string
  appId: string
  contentVersion: string
  observedAt: string
  origin: "capture" | "current-settings"
  app: Record<string, unknown>
  relationships: Record<string, unknown>[]
}
export const SNAPSHOT_LIMIT = 4 * 1024 * 1024
const TYPE = "#microsoft.graph.win32LobApp"
const BASE = "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps"
const fields = ["displayName", "description", "publisher", "largeIcon", "isFeatured", "privacyInformationUrl", "informationUrl", "owner", "developer", "notes", "fileName", "installCommandLine", "uninstallCommandLine", "applicableArchitectures", "allowedArchitectures", "minimumFreeDiskSpaceInMB", "minimumMemoryInMB", "minimumNumberOfProcessors", "minimumCpuSpeedInMHz", "msiInformation", "setupFilePath", "minimumSupportedWindowsRelease", "displayVersion", "allowAvailableUninstall", "minimumSupportedOperatingSystem", "rules", "installExperience", "returnCodes"] as const

export function snapshotHash(value: AppRestoreSnapshot): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
export function validateSnapshot(value: AppRestoreSnapshot, identity: CaptureIdentity): AppRestoreSnapshot {
  if (!value || value.schema !== 1 || value.tenantId !== identity.tenantId || value.appId !== identity.appId || value.contentVersion !== identity.contentVersion || !Number.isFinite(Date.parse(value.observedAt)) || !["capture", "current-settings"].includes(value.origin) || !value.app || value.app.id !== identity.appId || value.app["@odata.type"] !== TYPE || value.app.committedContentVersion !== identity.contentVersion || !Array.isArray(value.relationships) || Buffer.byteLength(JSON.stringify(value)) > SNAPSHOT_LIMIT - 32) throw new Error("The app settings do not match this captured installer.")
  return value
}
/** Preserve the raw settings, separately from the deliberately shortened display DTO. */
export async function readRestoreSnapshot(tenantId: string, appId: string, token: string, fetchImpl: typeof fetch, origin: AppRestoreSnapshot["origin"]): Promise<AppRestoreSnapshot> {
  const app = await appMetadataGet(`${BASE}/${appId}`, token, fetchImpl)
  if (app["@odata.type"] !== TYPE || app.id !== appId || typeof app.committedContentVersion !== "string" || !/^\d+$/.test(app.committedContentVersion)) throw new Error("This app has no restorable Win32 content version.")
  const relationships: Record<string, unknown>[] = []
  let next: string | null = `${BASE}/${appId}/relationships`, pages = 0
  while (next) {
    if (++pages > 100) throw new Error("The app relationship list exceeds the supported limit.")
    if (!next.startsWith(`${BASE}/${appId}/relationships`)) throw new Error("Intune returned an invalid relationships continuation.")
    const page = await appMetadataGet(next, token, fetchImpl)
    if (!Array.isArray(page.value) || page.value.some(v => !v || typeof v !== "object")) throw new Error("Intune returned invalid app relationships.")
    relationships.push(...page.value)
    next = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : null
  }
  return validateSnapshot({ schema: 1, tenantId, appId, contentVersion: app.committedContentVersion, observedAt: new Date().toISOString(), origin, app, relationships }, { tenantId, appId, contentVersion: app.committedContentVersion, appType: TYPE, contentFileId: "" })
}
export function sameRestoreSettings(a: AppRestoreSnapshot, b: AppRestoreSnapshot): boolean {
  return JSON.stringify(a.app) === JSON.stringify(b.app) && JSON.stringify(a.relationships) === JSON.stringify(b.relationships)
}
/** Destination IDs and assignments are never copied. Unsupported dependencies fail before writes. */
export function restoreBody(snapshot: AppRestoreSnapshot, name: string): Record<string, unknown> {
  const app = snapshot.app
  if (snapshot.relationships.length || Number(app.dependentAppCount) > 0 || Number(app.supersedingAppCount) > 0 || Number(app.supersededAppCount) > 0) throw new Error("This backup has app dependencies or supersedence. Destination mapping is required and is not supported by this restore version.")
  if (app.activeInstallScript || app.activeUninstallScript) throw new Error("This app uses Intune-hosted install or uninstall scripts. Restoring those script references is not supported yet.")
  if (!name.trim() || name.trim().length > 200 || Array.from(name).some(char => char.charCodeAt(0) < 32)) throw new Error("Enter an app name of 1–200 characters.")
  for (const required of ["fileName", "setupFilePath", "installCommandLine", "uninstallCommandLine"]) {
    if (typeof app[required] !== "string" || !(app[required] as string).trim()) throw new Error(`The backup is missing ${required}. Capture complete app settings before restoring.`)
  }
  if (!Array.isArray(app.rules) || !app.rules.length || !Array.isArray(app.returnCodes) || !app.returnCodes.length || !app.installExperience || typeof app.installExperience !== "object") throw new Error("The backup is missing detection rules, return codes or installation settings.")
  const body: Record<string, unknown> = { "@odata.type": TYPE }
  for (const field of fields) if (app[field] !== undefined) body[field] = structuredClone(app[field])
  body.displayName = name.trim()
  body.roleScopeTagIds = ["0"]
  return body
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([key, v]) => (!key.startsWith("@odata.") || key === "@odata.type") && v !== null).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}
/** Check what Intune retained, including scripts/rules; a file commit alone is not app success. */
export function assertRestoredSettings(expected: Record<string, unknown>, actual: Record<string, unknown>): void {
  for (const field of [...fields, "roleScopeTagIds"]) {
    if (expected[field] === undefined || expected[field] === null) continue
    // These older projections are derived from their newer counterparts by Intune.
    if (field === "applicableArchitectures" && expected.allowedArchitectures) continue
    if (field === "minimumSupportedOperatingSystem" && expected.minimumSupportedWindowsRelease) continue
    if (canonical(expected[field]) !== canonical(actual[field])) throw new Error(`Intune did not retain the reviewed ${field} settings. Review the destination app before continuing.`)
  }
}
