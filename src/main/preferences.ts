import type { AppPreferences } from "../shared/ipc"
import type { KeyValueStore } from "./storage/secure-store"

const KEY = "app.preferences"

type StoredPreferences = Omit<AppPreferences, "autoUpdateManaged">

const DEFAULTS: StoredPreferences = {
  startAtLogin: false,
  keepRunningInTray: true,
  retentionDays: 30,
  firstBackupNoteSeen: false,
  autoUpdate: true,
  nightlyUpdates: false,
}

function validDismissalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

// Changes come from the renderer: accept known preferences and validate the optional timestamp.
function checkChanges(changes: unknown): asserts changes is Partial<StoredPreferences> {
  if (typeof changes !== "object" || changes === null || Array.isArray(changes)) throw new Error("Invalid preferences.")
  for (const [key, value] of Object.entries(changes)) {
    if (key === "communityBannerDismissedAt") {
      if (!validDismissalTimestamp(value)) throw new Error(`Invalid value for ${key}.`)
      continue
    }
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`Unknown preference: ${key}.`)
    if (typeof value !== typeof DEFAULTS[key as keyof StoredPreferences]) throw new Error(`Invalid value for ${key}.`)
  }
}

export class Preferences {
  private readonly defaults: StoredPreferences

  /** `defaults` overrides the built-in defaults for preferences the admin never set. */
  constructor(private readonly store: KeyValueStore, defaults: Partial<StoredPreferences> = {}) {
    this.defaults = { ...DEFAULTS, ...defaults }
  }

  get(): StoredPreferences {
    return { ...this.defaults, ...this.stored() }
  }

  set(changes: Partial<StoredPreferences>): StoredPreferences {
    checkChanges(changes)
    // Only the admin's own choices are stored, so a default can still follow the installed build.
    const stored = { ...this.stored(), ...changes }
    const next = { ...this.defaults, ...stored }
    if (!Number.isInteger(next.retentionDays) || next.retentionDays < 0 || next.retentionDays > 3650) {
      throw new Error("Keep backups for 0 (forever) to 3650 days.")
    }
    if (typeof next.nightlyUpdates !== "boolean") throw new Error("Nightly updates must be on or off.")
    this.store.set(KEY, JSON.stringify(stored))
    return next
  }

  private stored(): Partial<StoredPreferences> {
    try {
      const stored: Partial<StoredPreferences> = JSON.parse(this.store.get(KEY) ?? "{}")
      if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {}
      if (!validDismissalTimestamp(stored.communityBannerDismissedAt)) delete stored.communityBannerDismissedAt
      return stored
    } catch {
      return {}
    }
  }
}
