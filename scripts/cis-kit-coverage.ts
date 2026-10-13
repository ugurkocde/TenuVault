/**
 * Prints the conversion coverage of one build kit without writing any kit
 * content to disk or into the repository:
 *   npx jiti scripts/cis-kit-coverage.ts <kit.zip>
 *   npx jiti scripts/cis-kit-coverage.ts <kit folder>
 *
 * The table shows one row per benchmark Level with policy and setting counts,
 * then every skipped or unrecognized file with its reason. A JSON file whose
 * Level cannot be determined is reported as failed and the remaining files are
 * still converted, so the counts stay visible; the exit code is 1 in that case.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { basename, join, relative, resolve, sep } from "node:path"
import JSZip from "jszip"
import { convertKit, KitConversionError, type KitFile } from "../src/shared/frameworks/cis-kit"

const target = process.argv[2]
if (!target) {
  console.error("Usage: npx jiti scripts/cis-kit-coverage.ts <kit.zip | kit folder>")
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
if (failed.length) process.exit(1)
