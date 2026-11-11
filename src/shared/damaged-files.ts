/**
 * Why files in a tenant's local backup folder cannot be used, decided by the local store where it
 * finds each file. key: no key on this device opens the file; most often it was made with another
 * recovery key, and a damaged file looks the same. os: the file system refused to read it, with an
 * error code such as EACCES. duplicate: another file holds the same backup item. damaged: anything
 * else, such as a damaged or incomplete file.
 */
export const DAMAGE_KINDS = ["key", "os", "duplicate", "damaged"] as const
export type DamageKind = (typeof DAMAGE_KINDS)[number]

/** The damaged files of a tenant's local backup folder by kind, sent with the container properties. */
export interface DamagedFileKinds {
  counts: Record<DamageKind, number>
  /** The distinct OS error codes of the os files, such as EACCES. */
  codes: string[]
  /** The first encrypted file names on disk of each kind; a few in all. */
  names: Record<DamageKind, string[]>
}

/** Container property header with the JSON of DamagedFileKinds. */
export const DAMAGE_KINDS_HEADER = "x-tenuvault-unreadable-file-kinds"

const FILE_NAME = /^[0-9a-f]{1,64}\.tvb$/i
const OS_CODE = /^E[A-Z]+$/

/**
 * DamagedFileKinds from untrusted JSON, or null when it is not one, counts no file, or does not
 * count exactly `total` files when that is given. Unknown names and codes are dropped.
 */
export function damagedFileKindsFrom(value: unknown, total?: number): DamagedFileKinds | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const { counts, codes, names } = value as { counts?: unknown; codes?: unknown; names?: unknown }
  if (!counts || typeof counts !== "object" || !Array.isArray(codes) || !names || typeof names !== "object") return null
  const result: DamagedFileKinds = { counts: { key: 0, os: 0, duplicate: 0, damaged: 0 }, codes: [], names: { key: [], os: [], duplicate: [], damaged: [] } }
  for (const kind of DAMAGE_KINDS) {
    const count = (counts as Record<string, unknown>)[kind]
    if (count !== undefined && (typeof count !== "number" || !Number.isInteger(count) || count < 0)) return null
    result.counts[kind] = count ?? 0
    const listed = (names as Record<string, unknown>)[kind]
    if (Array.isArray(listed)) result.names[kind] = listed.filter((name): name is string => typeof name === "string" && FILE_NAME.test(name))
  }
  const counted = DAMAGE_KINDS.reduce((sum, kind) => sum + result.counts[kind], 0)
  if (counted === 0 || (total !== undefined && counted !== total)) return null
  result.codes = [...new Set(codes.filter((code): code is string => typeof code === "string" && OS_CODE.test(code)))]
  return result
}
