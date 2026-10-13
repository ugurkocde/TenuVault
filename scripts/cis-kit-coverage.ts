/**
 * Prints the conversion coverage of one build kit without writing any kit
 * content to disk or into the repository:
 *   npx jiti scripts/cis-kit-coverage.ts <kit.zip>
 *   npx jiti scripts/cis-kit-coverage.ts <kit folder>
 *   npx jiti scripts/cis-kit-coverage.ts <kit.zip> --breakout <workbook.xlsx> --denominator <list.json>
 *
 * The first table shows one row per benchmark Level with policy and setting
 * counts, then every skipped or unrecognized file with its reason. A JSON file
 * whose Level cannot be determined is reported as failed and the remaining
 * files are still converted, so the counts stay visible; the exit code is 1
 * in that case.
 *
 * The second table shows recommendation coverage per Level: distinct
 * automated identifiers from a denominator list, how many of them the
 * converted policy descriptions enumerate, and the resulting ratio. Without
 * a denominator list a breakout workbook inside the kit (or given with
 * --breakout) supplies an illustrative proxy whose manual bucket is reported
 * separately; with neither, the ratio is labelled not computable. Identifier
 * lists are printed only with --detail.
 *
 * With --export-recommendation-list <path> the breakout workbook is also
 * converted into a recommendation list JSON file at the user chosen local
 * path: an object with benchmark, version and items, where each item has
 * identifier, level, automated and an optional title from the workbook. Rows
 * in the manual bucket build kit become automated false, the rest true. The
 * path must be outside the repository tree; repo-relative paths are refused.
 * Example, for a Windows 11 kit folder and its breakout workbook:
 *   npx jiti scripts/cis-kit-coverage.ts <kit folder> --breakout <workbook.xlsx> --export-recommendation-list /Users/you/Documents/win11-recommendations.json
 * Then import that file in the CIS Benchmarks area of the app.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { convertKit, KitConversionError, type KitFile } from "../src/shared/frameworks/cis-kit"
import { computeCoverage, parseBreakoutWorkbook, parseDenominatorList, recommendationListFromWorkbook, type BreakoutRow, type DenominatorEntry } from "../src/shared/frameworks/cis-coverage"
import { serializeRecommendationList } from "../src/shared/frameworks/cis-manual"

const args = process.argv.slice(2)
const target = args.find(arg => !arg.startsWith("--"))
function optionValue(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const detail = args.includes("--detail")
const exportListPath = optionValue("--export-recommendation-list") ?? optionValue("--export-recommendations") ?? optionValue("--recommendations-out") ?? optionValue("--manual-list-out")
export function repoRootForScript(): string {
  try { return resolve(dirname(fileURLToPath(import.meta.url)), "..") } catch { return resolve(process.cwd()) }
}
export function assertOutsideRepository(outputPath: string, repoRoot = repoRootForScript()): string {
  const resolved = resolve(outputPath)
  const rel = relative(resolve(repoRoot), resolved)
  if (rel === "" || (!rel.startsWith(`..${sep}`) && !rel.startsWith("../") && rel !== "..")) {
    throw new Error(`Refusing to write the recommendation list inside the repository tree: ${outputPath}. Choose a local path outside the repository.`)
  }
  return resolved
}
if (!target) {
  console.error("Usage: npx jiti scripts/cis-kit-coverage.ts <kit.zip | kit folder> [--breakout <workbook.xlsx>] [--denominator <list.json>] [--export-recommendation-list <local path outside the repository>] [--detail]")
  process.exit(2)
}
const root = resolve(target)
const label = basename(root)

function benchmarkOf(name: string): { id: string; version?: string } {
  const version = name.match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+)(?![0-9])/)?.[1]
  const id = name.replace(/\.zip$/i, "").replace(/v?\d+\.\d+\.\d+/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "kit"
  return { id, ...(version ? { version } : {}) }
}

function walk(dir: string, out: KitFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { walk(full, out); continue }
    const path = relative(root, full).split(sep).join("/")
    out.push({ path, content: entry.name.toLowerCase().endsWith(".json") ? readFileSync(full, "utf8") : "" })
  }
}

async function loadFiles(): Promise<KitFile[]> {
  if (statSync(root).isDirectory()) { const files: KitFile[] = []; walk(root, files); return files }
  const zip = await JSZip.loadAsync(readFileSync(root))
  const files: KitFile[] = []
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    files.push({ path: entry.name, content: entry.name.toLowerCase().endsWith(".json") ? await entry.async("string") : "" })
  }
  return files
}

const files = await loadFiles()
const benchmark = benchmarkOf(label)
const failed: Array<{ path: string; reason: string }> = []
let pending = files
let result: ReturnType<typeof convertKit> | undefined
for (let attempt = 0; attempt <= files.length; attempt++) {
  try { result = convertKit(pending, benchmark); break }
  catch (error) {
    if (error instanceof KitConversionError && error.file) {
      failed.push({ path: error.file, reason: error.message })
      pending = pending.filter(file => file.path !== error.file)
      continue
    }
    throw error
  }
}
if (!result) throw new Error("Conversion did not produce a result.")

console.log(`Kit: ${label}`)
console.log("Benchmark\tVersion\tLevel\tPolicies\tSettings\tSkipped files")
for (const level of result.summary.levels) {
  console.log(`${result.summary.benchmark}\t${result.summary.version}\tLevel ${level.level}\t${level.policies}\t${level.settings}\t${result.skipped.length + failed.length}`)
}
if (!result.summary.levels.length) console.log(`${result.summary.benchmark}\t${result.summary.version}\t(none)\t0\t0\t${result.skipped.length + failed.length}`)
for (const item of result.skipped) console.log(`Skipped: ${item.path} (${item.reason})`)
for (const item of failed) console.log(`Failed: ${item.reason}`)

let breakout: BreakoutRow[] | undefined
let breakoutBytes: Uint8Array | undefined
const breakoutPath = optionValue("--breakout")
try {
  if (breakoutPath) {
    breakoutBytes = readFileSync(resolve(breakoutPath))
    breakout = await parseBreakoutWorkbook(breakoutBytes)
  } else if (statSync(root).isDirectory()) {
    const names: string[] = []
    const collect = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, entry.name); if (entry.isDirectory()) collect(full); else if (entry.name.toLowerCase().endsWith(".xlsx")) names.push(full) } }
    collect(root)
    if (names[0]) { breakoutBytes = readFileSync(names[0]); breakout = await parseBreakoutWorkbook(breakoutBytes) }
  } else {
    const zip = await JSZip.loadAsync(readFileSync(root))
    const entry = Object.values(zip.files).find(item => !item.dir && item.name.toLowerCase().endsWith(".xlsx"))
    if (entry) { breakoutBytes = await entry.async("uint8array"); breakout = await parseBreakoutWorkbook(breakoutBytes) }
  }
} catch (error) {
  console.log(`Breakout: unavailable (${error instanceof Error ? error.message : "unreadable workbook"})`)
}
if (exportListPath) {
  let output: string
  try { output = assertOutsideRepository(exportListPath) }
  catch (error) { console.error(error instanceof Error ? error.message : "Refusing to write inside the repository."); process.exit(2) }
  if (!breakoutBytes) { console.error("No breakout workbook was found, so no recommendation list can be exported. Pass --breakout <workbook.xlsx>."); process.exit(2) }
  const list = await recommendationListFromWorkbook(breakoutBytes, { id: result.summary.benchmark, version: result.summary.version })
  writeFileSync(output, serializeRecommendationList(list), "utf8")
  console.log(`Recommendation list: wrote ${list.items.length} items for ${list.benchmark} ${list.version} to ${output}`)
}
let denominator: DenominatorEntry[] | undefined
const denominatorPath = optionValue("--denominator")
if (denominatorPath) denominator = parseDenominatorList(readFileSync(resolve(denominatorPath), "utf8"))

const report = computeCoverage({ benchmark: result.summary.benchmark, version: result.summary.version, packs: result.packs, breakout, denominator })
console.log("Level\tDenominator\tNumerator\tCoverage\tEnumerated\tNot in denominator\tMapped, not enumerated\tDenominator source")
for (const level of report.levels) {
  const ratio = level.coverage === null ? "not computable" : level.coverage.toFixed(4)
  const label = level.denominatorSource === "breakout-proxy" ? `${ratio} (illustrative)` : ratio
  console.log(`Level ${level.level}\t${level.denominator ?? "n/a"}\t${level.numerator}\t${label}\t${level.enumeratedIds.length}\t${level.notInDenominatorIds.length}\t${level.mappedNotEnumeratedIds.length}\t${level.denominatorSource}`)
  if (level.proxy) console.log(`Breakout proxy, Level ${level.level}: ${level.proxy.total} identifiers in the profile, ${level.proxy.manual} in the manual bucket, ${level.proxy.automatedProxy} outside it. The ratio above is illustrative.`)
  if (detail) {
    console.log(`Enumerated, Level ${level.level}: ${level.enumeratedIds.join(", ")}`)
    console.log(`Not in denominator, Level ${level.level}: ${level.notInDenominatorIds.join(", ")}`)
    console.log(`Mapped, not enumerated, Level ${level.level}: ${level.mappedNotEnumeratedIds.join(", ")}`)
  }
}
if (failed.length) process.exit(1)
