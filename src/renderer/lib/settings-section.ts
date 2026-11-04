export const SETTINGS_SECTION_IDS = ["signin", "services", "storage", "background", "notifications", "branding", "updates", "appearance", "about"] as const

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "signin"

const KNOWN_SECTIONS = new Set<string>(SETTINGS_SECTION_IDS)

/** Resolves the `section` query parameter to a known section, defaulting to sign-in. */
export function parseSettingsSection(value: string | null | undefined): SettingsSectionId {
  return value && KNOWN_SECTIONS.has(value) ? (value as SettingsSectionId) : DEFAULT_SETTINGS_SECTION
}

/** Deep link to one settings section, optionally with an in-section anchor such as `recovery-key`. */
export function settingsHref(section: SettingsSectionId, anchor?: string): string {
  return `/portal/settings?section=${section}${anchor ? `#${anchor}` : ""}`
}

/**
 * The section a Settings address opens. Older links carry only an anchor: `#recovery-key` means the storage
 * section, and `#services` (with or without `section=signin`) means Services and permissions, which used
 * to sit under sign-in.
 */
export function resolveSettingsSection(section: string | null | undefined, hash: string): SettingsSectionId {
  if (hash === "#recovery-key" && !section) return "storage"
  if (hash === "#services" && (!section || section === "signin")) return "services"
  return parseSettingsSection(section)
}
