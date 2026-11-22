import type { Feature } from "./plans"

/**
 * Settings files: a readable JSON copy of the app's settings, to keep as a backup or to set up
 * another admin's TenuVault the same way. The main process builds, reads and applies them; the
 * renderer only shows the preview and sends back which items to apply.
 */

/** The `kind` every settings file carries. */
export const SETTINGS_FILE_KIND = "tenuvault-settings"

/** The newest file version this build reads. Additive fields keep the version; only breaking changes raise it. */
export const SETTINGS_SCHEMA_VERSION = 1

/** Largest settings file accepted, in bytes. A logo is at most 1 MB, about 1.4 MB as base64. */
export const SETTINGS_FILE_LIMIT = 5 * 1024 * 1024

/** The renderer's theme setting, kept in its own storage; passed in for export, preview and apply. */
export type AppearanceSetting = "system" | "light" | "dark"

/** Where a tenant's backups are stored, as a setup file names it. */
export type SetupStorage =
  | { kind: "local" }
  | { kind: "azure"; storageAccountName: string; subscriptionId: string; resourceGroupName: string; location: string }

/** What a setup file holds for a tenant that is not connected yet: public identifiers only, never a secret. */
export interface SetupConnection {
  tenantId: string
  name: string
  clientId: string
  storage?: SetupStorage
}

export interface SettingsExportOptions {
  /** Include the settings of this computer: retention, tray, updates, appearance and PDF branding. */
  app: boolean
  /** Connected tenants whose settings are included. */
  tenantIds: string[]
  /** Add each tenant's client ID and storage target, so another admin can connect it from the file. */
  connection: boolean
  /** The current theme, which lives in the renderer. */
  appearance: AppearanceSetting
}

/**
 * - change: the file's value differs and can be applied.
 * - same: the value already matches.
 * - blocked: it cannot be applied here; `reason` says why.
 */
export type TransferItemStatus = "change" | "same" | "blocked"

export interface TransferItem {
  /** Stable within a preview; the renderer sends it back to apply the item. */
  id: string
  label: string
  /** The value on this computer, as text. */
  current: string
  /** The value in the file, as text. */
  next: string
  status: TransferItemStatus
  reason?: string
  /** The plan feature that keeps it from applying, or limits what applies; shown as a plan badge. */
  feature?: Feature
  /** A note to read before applying, such as two computers running one schedule. */
  warning?: string
  /** Something to know that does not keep the item from applying, such as what a plan applies. */
  note?: string
  /** Whether the item starts selected. Items with a warning start unselected. */
  selected: boolean
}

export interface TransferGroup {
  /** "app" for this computer, otherwise the tenant ID. */
  id: string
  title: string
  detail?: string
  /** For tenant groups: whether the tenant is connected on this computer. */
  connected: boolean
  /** Something to know about the whole group, such as a different app registration. */
  notice?: string
  items: TransferItem[]
  /** Connection details from a setup file for a tenant that is not connected on this computer. */
  setup?: SetupConnection
}

export interface TransferPreview {
  importId: string
  exportedAt: string
  appVersion: string
  groups: TransferGroup[]
  /** Parts of the file this version does not know, which are never applied. */
  skipped: string[]
}

export type TransferOutcome = "applied" | "skipped" | "failed"

export interface TransferApplyResult {
  items: Array<{ id: string; group: string; label: string; outcome: TransferOutcome; message?: string }>
  /** The theme to set in the renderer, when that item was applied. */
  appearance?: AppearanceSetting
  /** Tenants whose services were changed, so their permissions can be checked. */
  servicesChanged: string[]
}

/** Default file name of an export made on `date`. */
export function settingsFileName(date: Date): string {
  return `tenuvault-settings-${date.toISOString().slice(0, 10)}.json`
}
