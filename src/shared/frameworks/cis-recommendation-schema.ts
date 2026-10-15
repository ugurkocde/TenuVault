/**
 * The recommendation list a delivered benchmark pack may carry, and its strict
 * validator. Kept free of other imports so the policy parser and the
 * recommendation evaluation can both use it without importing each other.
 */

export interface PackRecommendation { id: string; title: string; level: 1 | 2; settings: string[] }

export const MAX_PACK_RECOMMENDATIONS = 2000
export const MAX_RECOMMENDATION_TITLE_LENGTH = 300
export const MAX_RECOMMENDATION_SETTINGS = 200
const ID_PATTERN = /^\d{1,4}(?:\.\d{1,4}){1,9}$/
const FIELDS = new Set(["id", "title", "level", "settings"])

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Validates a recommendation list strictly: known fields only, dotted numeric ids, bounded titles and settings, no repeated id. */
export function validatePackRecommendations(input: unknown, label = "Recommendations"): PackRecommendation[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array.`)
  if (input.length > MAX_PACK_RECOMMENDATIONS) throw new Error(`${label} must contain at most ${MAX_PACK_RECOMMENDATIONS} entries.`)
  const seen = new Set<string>()
  return input.map((entry, index) => {
    const at = `${label} entry ${index + 1}`
    if (!isRecord(entry)) throw new Error(`${at}: expected an object with id, title, level and settings.`)
    for (const key of Object.keys(entry)) if (!FIELDS.has(key)) throw new Error(`${at}: unknown field: ${key}. Expected id, title, level and settings.`)
    if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id)) throw new Error(`${at}: id must be a dotted numeric identifier such as 1.2.3.`)
    if (seen.has(entry.id)) throw new Error(`${at}: duplicate recommendation ${entry.id}.`)
    seen.add(entry.id)
    if (typeof entry.title !== "string" || !entry.title.trim() || entry.title.length > MAX_RECOMMENDATION_TITLE_LENGTH) throw new Error(`${at}: title must be a non-empty string of at most ${MAX_RECOMMENDATION_TITLE_LENGTH} characters.`)
    if (entry.level !== 1 && entry.level !== 2) throw new Error(`${at}: level must be 1 or 2.`)
    if (!Array.isArray(entry.settings) || !entry.settings.length || entry.settings.length > MAX_RECOMMENDATION_SETTINGS ||
        entry.settings.some(setting => typeof setting !== "string" || !setting || setting.length > 500)) {
      throw new Error(`${at}: settings must list between 1 and ${MAX_RECOMMENDATION_SETTINGS} setting definition IDs.`)
    }
    const repeated = (entry.settings as string[]).find((setting, position, all) => all.indexOf(setting) !== position)
    if (repeated) throw new Error(`${at}: setting ${repeated} is listed twice. List each setting definition once.`)
    return { id: entry.id, title: entry.title.trim(), level: entry.level, settings: [...(entry.settings as string[])] }
  })
}
