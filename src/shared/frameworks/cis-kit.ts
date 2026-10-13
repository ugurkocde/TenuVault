import JSZip from "jszip"
import { comparable, parsePolicies, type BaselinePolicy, type RecordJson } from "./policies"

/**
 * Converts one licensed build kit, supplied as file names and text content, into
 * Settings Catalog policy packs grouped by benchmark Level. The converter is a
 * pure function of its input: callers read zips or folders and pass the files in.
 * Only file names and folder names are inspected for classification. Kit file
 * content is validated through parsePolicies and never copied anywhere else.
 */

export interface KitFile { path: string; content: string }
export interface KitBenchmark { id: string; version?: string }
export type KitLevel = 1 | 2
export interface KitPack { benchmark: string; version: string; level: KitLevel; reference: string; policies: BaselinePolicy[] }
export interface SkippedKitFile { path: string; reason: string }
export interface KitLevelSummary { level: KitLevel; policies: number; settings: number }
export interface KitConversion { packs: KitPack[]; skipped: SkippedKitFile[]; summary: { benchmark: string; version: string; levels: KitLevelSummary[]; skipped: SkippedKitFile[] } }

export class KitConversionError extends Error {
  constructor(message: string, public readonly file?: string) { super(message) }
}

function normalized(path: string): string { return path.replace(/\\/g, "/") }
function baseName(path: string): string { return normalized(path).split("/").pop() ?? path }
function extension(path: string): string {
  const name = baseName(path).toLowerCase()
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot) : ""
}

/** UTF-8 exports may start with a byte order mark, as text or as raw bytes decoded to text. */
export function stripBom(text: string): string { return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text }

type LevelMark = KitLevel | "combined" | "unknown"

/**
 * Level markers seen across kits: Level folders, L1 or L2 markers in file names,
 * Device and User split folders, and one combined L1+L2 file paired with an L1
 * file. Returns "unknown" when no marker exists so callers fail loudly.
 */
export function classifyKitFile(path: string): LevelMark {
  const text = normalized(path)
  if (/\bl1\s*\+\s*l2\b/i.test(text) || /\blevel\s*1\s*\+\s*level\s*2\b/i.test(text)) return "combined"
  const levels = new Set<KitLevel>()
  for (const match of text.matchAll(/\blevel\s*[- ]?([12])\b|\bl([12])\b/gi)) {
    levels.add(Number(match[1] ?? match[2]) as KitLevel)
  }
  if (levels.size === 1) return [...levels][0]!
  return "unknown"
}

function scopeOf(path: string): "device" | "user" | undefined {
  const text = normalized(path).toLowerCase()
  if (/(^|[/_-])device([/_-]|$)/.test(text)) return "device"
  if (/(^|[/_-])user([/_-]|$)/.test(text)) return "user"
  return undefined
}

/** Version marker such as 5.0.0 or v1.1.0 in a file name, when the name carries one. */
export function kitFileVersion(path: string): string | undefined {
  return baseName(path).match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+)(?![0-9])/)?.[1]
}

const MAX_KIT_ZIP_ENTRIES = 2000
const MAX_KIT_ZIP_FILE_BYTES = 8 * 1024 * 1024
const MAX_KIT_ZIP_TOTAL_BYTES = 32 * 1024 * 1024

export async function readKitZip(data: Uint8Array | ArrayBuffer): Promise<KitFile[]> {
  let zip: JSZip
  try { zip = await JSZip.loadAsync(data) }
  catch { throw new KitConversionError("The selected file is not a valid zip archive.") }
  const entries = Object.values(zip.files).filter(entry => !entry.dir)
  if (entries.length > MAX_KIT_ZIP_ENTRIES) throw new KitConversionError("The zip contains too many files. Split the kit or remove extra files before importing.")
  const files: KitFile[] = []
  let total = 0
  for (const entry of entries) {
    const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
    if (typeof declared === "number" && declared > MAX_KIT_ZIP_FILE_BYTES) throw new KitConversionError("A file in the zip is larger than 8 MB. Remove it before importing.")
    const content = await entry.async("string")
    const size = new TextEncoder().encode(content).length
    if (size > MAX_KIT_ZIP_FILE_BYTES) throw new KitConversionError("A file in the zip is larger than 8 MB. Remove it before importing.")
    total += size
    if (total > MAX_KIT_ZIP_TOTAL_BYTES) throw new KitConversionError("The zip expands to more than 32 MB. Split the kit before importing.")
    files.push({ path: entry.name, content })
  }
  return files
}

export function suggestedKitBenchmark(paths: string[]): { id: string; version?: string } {
  const cleaned = paths.map(path => normalized(path)).filter(path => path.length > 0)
  if (!cleaned.length) return { id: "" }
  const segments = cleaned.map(path => path.split("/")[0] ?? "")
  const common = segments.every(segment => segment === segments[0]) ? segments[0]! : (segments.find(segment => /\.zip$/i.test(segment)) ?? segments[0]!)
  if (!common) return { id: "" }
  const withoutZip = common.replace(/\.zip$/i, "")
  const segmentVersion = withoutZip.match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+)$/)?.[1] ?? kitFileVersion(withoutZip)
  const version = cleaned.map(path => kitFileVersion(path)).find(item => item !== undefined) ?? segmentVersion
  const withoutVersion = withoutZip.replace(/[\s_-]*v?\d+\.\d+\.\d+$/i, "")
  const slug = withoutVersion
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!slug) return { id: "" }
  return { id: slug, ...(version ? { version } : {}) }
}

function provenanceFor(benchmark: KitBenchmark, version: string, level: KitLevel, path: string, extra?: { [key: string]: string }): RecordJson {
  const scope = scopeOf(path)
  return { schemaVersion: 1, benchmark: benchmark.id, version, level: `Level ${level}`, sourceFile: baseName(path),
    ...(scope ? { scope } : {}), ...extra }
}

function parseKitFile(file: KitFile): BaselinePolicy[] {
  let json: unknown
  try { json = JSON.parse(stripBom(file.content)) }
  catch { throw new KitConversionError(`${file.path}: the file is not valid JSON, so it is not a Settings Catalog export.`, file.path) }
  try { return parsePolicies(json) }
  catch (error) { throw new KitConversionError(`${file.path}: the file is not a Settings Catalog export. ${error instanceof Error ? error.message : ""}`.trim(), file.path) }
}

function settingKey(setting: RecordJson): string {
  const instance = setting.settingInstance as RecordJson | undefined
  return typeof instance?.settingDefinitionId === "string" ? instance.settingDefinitionId : ""
}

/**
 * Derives the Level 2 only remainder of a combined L1+L2 policy: settings that
 * are new in the combined policy or whose recommended value changes there. The
 * derived policy is labelled as derived in its provenance and name.
 */
function deriveLevel2(combined: BaselinePolicy, level1: BaselinePolicy[], file: KitFile, benchmark: KitBenchmark, version: string): BaselinePolicy {
  const known = new Map<string, string>()
  for (const policy of level1) for (const setting of policy.settings) known.set(settingKey(setting), JSON.stringify(comparable(setting.settingInstance as RecordJson)))
  const settings = combined.settings.filter(setting => known.get(settingKey(setting)) !== JSON.stringify(comparable(setting.settingInstance as RecordJson)))
  if (!settings.length) throw new KitConversionError(`${file.path}: no Level 2 only settings could be derived from the combined Level 1 and Level 2 file.`, file.path)
  return { name: `${combined.name} (Level 2 only, derived)`.slice(0, 200), platforms: combined.platforms, technologies: combined.technologies,
    description: combined.description, settings,
    provenance: provenanceFor(benchmark, version, 2, file.path, { derivation: "Settings new in the combined file or with a changed value there; the Level 1 file holds the rest." }) }
}

const SKIPPED_KINDS: ReadonlyArray<{ extensions: string[]; reason: string }> = [
  { extensions: [".pdf"], reason: "PDF document. Reported for coverage; not a Settings Catalog export." },
  { extensions: [".xlsx", ".xls", ".csv", ".ods"], reason: "Spreadsheet. Reported for coverage; not a Settings Catalog export." },
  { extensions: [".ps1", ".sh", ".bat", ".cmd"], reason: "Script. Reported for coverage; not a Settings Catalog export." },
  { extensions: [".txt", ".md", ".rtf"], reason: "Readme or notes. Reported for coverage; not a Settings Catalog export." },
  { extensions: [".xml"], reason: "XML file. Reported for coverage; not a Settings Catalog export." },
]

export function convertKit(files: KitFile[], benchmark: KitBenchmark): KitConversion {
  if (!/^[a-z0-9-]+$/.test(benchmark.id)) throw new KitConversionError("The benchmark id must use lowercase letters, numbers and hyphens.")
  const skipped: SkippedKitFile[] = []
  const byLevel = new Map<KitLevel, BaselinePolicy[]>()
  const combinedFiles: Array<{ file: KitFile; policies: BaselinePolicy[]; version: string }> = []
  let version = benchmark.version ?? ""
  const addPolicies = (level: KitLevel, policies: BaselinePolicy[]) => byLevel.set(level, [...(byLevel.get(level) ?? []), ...policies])

  for (const file of files) {
    const path = normalized(file.path)
    if (!path || path.endsWith("/")) continue
    const ext = extension(path)
    if (ext !== ".json") {
      const kind = SKIPPED_KINDS.find(item => item.extensions.includes(ext))
      skipped.push({ path, reason: kind ? kind.reason : `Unrecognized file type (${ext || "no extension"}). Reported for coverage; not converted.` })
      continue
    }
    const mark = classifyKitFile(path)
    if (mark === "unknown") throw new KitConversionError(`${path}: the Level 1 or Level 2 profile cannot be determined from the file path or name. Rename the file or folder with an L1 or L2 marker, or remove the file from the kit before converting.`, path)
    const fileVersion = kitFileVersion(path) ?? benchmark.version
    if (!fileVersion) throw new KitConversionError(`${path}: the benchmark version cannot be determined from the file name and no version was supplied.`, path)
    if (!version) version = fileVersion
    const policies = parseKitFile({ path, content: file.content })
    if (mark === "combined") { combinedFiles.push({ file: { path, content: file.content }, policies, version: fileVersion }); continue }
    addPolicies(mark, policies.map(policy => ({ ...policy, provenance: provenanceFor(benchmark, fileVersion, mark, path) })))
  }

  for (const combined of combinedFiles) {
    const level1 = byLevel.get(1) ?? []
    if (!level1.length) throw new KitConversionError(`${combined.file.path}: a combined Level 1 and Level 2 file needs the matching Level 1 file in the same kit to derive the Level 2 only settings.`, combined.file.path)
    for (const policy of combined.policies) addPolicies(2, [deriveLevel2(policy, level1, combined.file, benchmark, combined.version)])
  }

  if (!version) throw new KitConversionError("The benchmark version cannot be determined from the kit files and no version was supplied.")
  const packs: KitPack[] = [...byLevel.entries()].sort(([a], [b]) => a - b).map(([level, policies]) => ({
    benchmark: benchmark.id, version, level, reference: `${benchmark.id} ${version} Level ${level}`, policies,
  }))
  const levels: KitLevelSummary[] = packs.map(pack => ({ level: pack.level, policies: pack.policies.length, settings: pack.policies.reduce((total, policy) => total + policy.settings.length, 0) }))
  return { packs, skipped, summary: { benchmark: benchmark.id, version, levels, skipped } }
}
