import { DOMParser } from "@xmldom/xmldom"
import JSZip from "jszip"
import type { KitLevel, KitPack } from "./cis-kit"
import { recommendationListFromBreakout, type RecommendationList } from "./cis-manual"

/**
 * Computes recommendation coverage for converted build kits. A recommendation
 * identifier is a dotted-decimal token enumerated in a converted policy
 * description. Coverage is the share of distinct automated identifiers from an
 * authoritative denominator list that the converted policies enumerate, per
 * benchmark and Level. Identifier lists live in the returned detail object;
 * callers decide whether to print counts only or the lists as well.
 */

// A whole dotted-decimal token: never the tail of a word such as v1.0.0 (whose "0.0" is no
// identifier) and never cut short before more letters or digits.
const IDENTIFIER_PATTERN = /(?<![\w.])\d+(?:\.\d+)+(?!\.?\w)/g
const DATE_LIKE = /^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/

/**
 * Distinct dotted-decimal identifiers in one text. The kit version token and
 * date-like export timestamps are never identifiers, so both are excluded.
 */
export function extractRecommendationIds(text: string, options?: { kitVersion?: string }): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    const token = match[0]
    if (options?.kitVersion && token === options.kitVersion) continue
    if (DATE_LIKE.test(token)) continue
    found.add(token)
  }
  return [...found].sort()
}

export interface BreakoutRow { identifier: string; level: KitLevel | null; buildKitName: string; title?: string }

function profileLevel(profile: string): KitLevel | null {
  if (/\blevel\s*1\b/i.test(profile) || /\(\s*l1\s*\)/i.test(profile)) return 1
  if (/\blevel\s*2\b/i.test(profile) || /\(\s*l2\s*\)/i.test(profile)) return 2
  return null
}

function columnOf(ref: string): string { return ref.replace(/[0-9]/g, "") }

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return []
  const doc = new DOMParser().parseFromString(xml, "text/xml")
  const values: string[] = []
  for (const item of Array.from(doc.getElementsByTagName("si"))) {
    let text = ""
    for (const node of Array.from(item.getElementsByTagName("t"))) text += node.textContent ?? ""
    values.push(text)
  }
  return values
}

type XmlCell = { getAttribute(name: string): string | null; getElementsByTagName(name: string): ArrayLike<{ textContent: string | null }> }

function cellText(cell: XmlCell, shared: string[]): string {
  const kind = cell.getAttribute("t")
  if (kind === "inlineStr") {
    let text = ""
    for (const node of Array.from(cell.getElementsByTagName("t"))) text += node.textContent ?? ""
    return text
  }
  const raw = cell.getElementsByTagName("v")[0]?.textContent ?? ""
  if (kind === "s") return shared[Number(raw)] ?? ""
  return raw
}

function rowsOf(xml: string, shared: string[]): Map<string, string>[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml")
  return Array.from(doc.getElementsByTagName("row")).map(row => {
    const cells = new Map<string, string>()
    for (const cell of Array.from(row.getElementsByTagName("c"))) {
      const ref = cell.getAttribute("r")
      if (ref) cells.set(columnOf(ref), cellText(cell as unknown as XmlCell, shared))
    }
    return cells
  })
}

/**
 * Reads one breakout workbook from its bytes. Only the recommendation
 * identifier, profile and build kit name columns are extracted, located by
 * their header text. Every other column is ignored.
 */
export async function parseBreakoutWorkbook(data: Uint8Array | ArrayBuffer, options?: { includeTitle?: boolean }): Promise<BreakoutRow[]> {
  const zip = await JSZip.loadAsync(data)
  const shared = sharedStrings(await zip.file("xl/sharedStrings.xml")?.async("string"))
  const sheetNames = Object.keys(zip.files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()
  for (const name of sheetNames) {
    const xml = await zip.file(name)?.async("string")
    if (!xml) continue
    const rows = rowsOf(xml, shared)
    const header = rows[0]
    if (!header) continue
    const columns = new Map<string, string>()
    for (const [column, text] of header) columns.set(text.trim().toLowerCase(), column)
    const identifierColumn = [...columns.entries()].find(([text]) => text.includes("recommendation"))?.[1]
    const profileColumn = [...columns.entries()].find(([text]) => text === "profile")?.[1]
    const kitColumn = [...columns.entries()].find(([text]) => text.includes("build kit"))?.[1]
    const titleColumn = [...columns.entries()].find(([text]) => text === "title")?.[1]
    if (!identifierColumn || !profileColumn || !kitColumn) continue
    const parsed: BreakoutRow[] = []
    for (const row of rows.slice(1)) {
      const identifier = (row.get(identifierColumn) ?? "").trim()
      if (!identifier) continue
      const title = titleColumn ? (row.get(titleColumn) ?? "").trim() : ""
      parsed.push({ identifier, level: profileLevel(row.get(profileColumn) ?? ""), buildKitName: (row.get(kitColumn) ?? "").trim(), ...(options?.includeTitle && title ? { title } : {}) })
    }
    return parsed
  }
  throw new Error("The breakout workbook has no sheet with recommendation, profile and build kit columns.")
}

export interface DenominatorEntry { identifier: string; level: KitLevel; automated: boolean }

/** Parses the authoritative denominator list supplied alongside a kit. */
export function parseDenominatorList(text: string): DenominatorEntry[] {
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw new Error("The denominator file is not valid JSON.") }
  if (!Array.isArray(value)) throw new Error("The denominator file must be a JSON array.")
  return value.map((entry, index) => {
    const record = entry as { identifier?: unknown; level?: unknown; automated?: unknown } | null
    if (!record || typeof record.identifier !== "string" || !record.identifier ||
        (record.level !== 1 && record.level !== 2) || typeof record.automated !== "boolean") {
      throw new Error(`Denominator entry ${index + 1}: expected identifier, level 1 or 2 and an automated flag.`)
    }
    return { identifier: record.identifier, level: record.level, automated: record.automated }
  })
}

/** Builds a recommendation list file shape directly from one breakout workbook. */
export async function recommendationListFromWorkbook(data: Uint8Array | ArrayBuffer, benchmark: { id: string; version: string }): Promise<RecommendationList> {
  const rows = await parseBreakoutWorkbook(data, { includeTitle: true })
  return recommendationListFromBreakout(rows, benchmark)
}

export type DenominatorSource = "authoritative" | "breakout-proxy" | "none"

export interface LevelCoverage {
  level: KitLevel
  denominatorSource: DenominatorSource
  denominator: number | null
  numerator: number
  coverage: number | null
  enumeratedIds: string[]
  numeratorIds: string[]
  notInDenominatorIds: string[]
  mappedNotEnumeratedIds: string[]
  denominatorIds: string[]
  proxy: { total: number; manual: number; automatedProxy: number } | null
}

export interface CoverageReport { benchmark: string; version: string; levels: LevelCoverage[] }

function normalizedName(name: string): string { return name.trim().replace(/\s+/g, " ").toLowerCase() }
function isManualBucket(buildKitName: string): boolean { return /\bmanual\b/i.test(buildKitName) }
function sorted(set: Set<string>): string[] { return [...set].sort() }

/**
 * Per Level coverage for one converted kit. With a denominator list the ratio
 * is authoritative. With only a breakout workbook the ratio uses the breakout
 * counts minus the manual bucket as an illustrative proxy. With neither, the
 * ratio is reported as not computable.
 */
export function computeCoverage(input: {
  benchmark: string
  version: string
  packs: KitPack[]
  breakout?: BreakoutRow[]
  denominator?: DenominatorEntry[]
}): CoverageReport {
  const levels: LevelCoverage[] = []
  for (const pack of [...input.packs].sort((a, b) => a.level - b.level)) {
    const enumeratedByPolicy = new Map<string, Set<string>>()
    const enumerated = new Set<string>()
    for (const policy of pack.policies) {
      const ids = new Set(extractRecommendationIds(policy.description, { kitVersion: input.version }))
      enumeratedByPolicy.set(normalizedName(policy.name), ids)
      for (const id of ids) enumerated.add(id)
    }

    const mappedNotEnumerated = new Set<string>()
    if (input.breakout) {
      for (const row of input.breakout) {
        if (row.level !== null && row.level !== pack.level) continue
        const ids = enumeratedByPolicy.get(normalizedName(row.buildKitName))
        if (ids && !ids.has(row.identifier)) mappedNotEnumerated.add(row.identifier)
      }
    }

    let denominator: number | null = null
    let numeratorIds = sorted(enumerated)
    let notInDenominatorIds: string[] = []
    let denominatorIds: string[] = []
    let coverage: number | null = null
    let source: DenominatorSource = "none"
    let proxy: LevelCoverage["proxy"] = null

    if (input.denominator) {
      source = "authoritative"
      const automated = new Set(input.denominator.filter(entry => entry.level === pack.level && entry.automated).map(entry => entry.identifier))
      denominatorIds = sorted(automated)
      denominator = automated.size
      numeratorIds = sorted(new Set([...enumerated].filter(id => automated.has(id))))
      notInDenominatorIds = sorted(new Set([...enumerated].filter(id => !automated.has(id))))
      coverage = denominator > 0 ? numeratorIds.length / denominator : null
    } else if (input.breakout) {
      source = "breakout-proxy"
      const rows = input.breakout.filter(row => row.level === pack.level && row.identifier)
      const total = new Set(rows.map(row => row.identifier))
      const manual = new Set(rows.filter(row => isManualBucket(row.buildKitName)).map(row => row.identifier))
      const automatedProxy = new Set([...total].filter(id => !manual.has(id)))
      proxy = { total: total.size, manual: manual.size, automatedProxy: automatedProxy.size }
      denominatorIds = sorted(automatedProxy)
      denominator = automatedProxy.size
      numeratorIds = sorted(new Set([...enumerated].filter(id => automatedProxy.has(id))))
      notInDenominatorIds = sorted(new Set([...enumerated].filter(id => !automatedProxy.has(id))))
      coverage = denominator > 0 ? numeratorIds.length / denominator : null
    }

    levels.push({
      level: pack.level, denominatorSource: source, denominator,
      numerator: numeratorIds.length, coverage,
      enumeratedIds: sorted(enumerated), numeratorIds, notInDenominatorIds,
      mappedNotEnumeratedIds: sorted(mappedNotEnumerated), denominatorIds, proxy,
    })
  }
  return { benchmark: input.benchmark, version: input.version, levels }
}
