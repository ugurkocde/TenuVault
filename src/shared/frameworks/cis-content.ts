/**
 * Contract for CIS benchmark content delivered by the TenuVault delivery
 * service. Validators are pure and strict: unknown fields, wrong types,
 * oversized lists and identity mismatches are rejected with a plain
 * message naming the first problem. The pack policies are the existing
 * Settings Catalog pack format accepted by parsePolicies.
 */

export type CisLevel = 1 | 2

export interface CisBenchmark {
  id: string
  name: string
  version: string
  levels: CisLevel[]
}

export interface CisCatalog {
  benchmarks: CisBenchmark[]
}

export interface CisPack {
  benchmark: string
  version: string
  level: CisLevel
  policies: unknown[]
}

export interface CisPackExpectation {
  benchmark: string
  version: string
  level: CisLevel
}

export const MAX_CIS_BENCHMARKS = 50
export const MAX_CIS_PACK_POLICIES = 64
export const MAX_CIS_BENCHMARK_NAME_LENGTH = 200
export const MAX_CIS_BENCHMARK_ID_LENGTH = 100

const BENCHMARK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const CATALOG_FIELDS = new Set(["benchmarks"])
const BENCHMARK_FIELDS = new Set(["id", "name", "version", "levels"])
const PACK_FIELDS = new Set(["benchmark", "version", "level", "policies"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateBenchmarkId(value: unknown, label: string): string {
  if (typeof value !== "string" || !BENCHMARK_ID_PATTERN.test(value) || value.length > MAX_CIS_BENCHMARK_ID_LENGTH) {
    throw new Error(`${label}: id must use lowercase letters, numbers and hyphens.`)
  }
  return value
}

function validateVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error(`${label}: version must use the form 1.2.3.`)
  }
  return value
}

function validateLevels(value: unknown, label: string): CisLevel[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label}: levels must contain at least one level.`)
  const seen = new Set<number>()
  for (const entry of value) {
    if (entry !== 1 && entry !== 2) throw new Error(`${label}: levels must contain only 1 or 2.`)
    if (seen.has(entry)) throw new Error(`${label}: levels must not repeat a level.`)
    seen.add(entry)
  }
  return [...seen].sort((a, b) => a - b) as CisLevel[]
}

/** Validates one decoded catalog value. Returns the catalog with levels sorted. */
export function validateCisCatalog(input: unknown): CisCatalog {
  if (!isRecord(input)) throw new Error("The CIS catalog must be a JSON object with benchmarks.")
  for (const key of Object.keys(input)) {
    if (!CATALOG_FIELDS.has(key)) throw new Error(`The CIS catalog has an unknown field: ${key}. Expected benchmarks.`)
  }
  if (!Array.isArray(input.benchmarks)) throw new Error("The CIS catalog benchmarks must be an array.")
  if (input.benchmarks.length > MAX_CIS_BENCHMARKS) throw new Error(`The CIS catalog must contain at most ${MAX_CIS_BENCHMARKS} benchmarks.`)
  const seen = new Set<string>()
  const benchmarks: CisBenchmark[] = input.benchmarks.map((entry, index) => {
    const label = `CIS catalog benchmark ${index + 1}`
    if (!isRecord(entry)) throw new Error(`${label}: expected an object with id, name, version and levels.`)
    for (const key of Object.keys(entry)) {
      if (!BENCHMARK_FIELDS.has(key)) throw new Error(`${label}: unknown field: ${key}. Expected id, name, version and levels.`)
    }
    const id = validateBenchmarkId(entry.id, label)
    if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.trim().length > MAX_CIS_BENCHMARK_NAME_LENGTH) {
      throw new Error(`${label}: name must be a non-empty string of at most ${MAX_CIS_BENCHMARK_NAME_LENGTH} characters.`)
    }
    const version = validateVersion(entry.version, label)
    const levels = validateLevels(entry.levels, label)
    const key = `${id}@${version}`
    if (seen.has(key)) throw new Error(`${label}: duplicate benchmark ${id} ${version}.`)
    seen.add(key)
    return { id, name: entry.name.trim(), version, levels }
  })
  return { benchmarks }
}

/** Validates one decoded pack value against the requested identity. */
export function validateCisPack(input: unknown, expected: CisPackExpectation): CisPack {
  if (!isRecord(input)) throw new Error("The CIS pack must be a JSON object with benchmark, version, level and policies.")
  for (const key of Object.keys(input)) {
    if (!PACK_FIELDS.has(key)) throw new Error(`The CIS pack has an unknown field: ${key}. Expected benchmark, version, level and policies.`)
  }
  const benchmark = validateBenchmarkId(input.benchmark, "CIS pack")
  const version = validateVersion(input.version, "CIS pack")
  if (input.level !== 1 && input.level !== 2) throw new Error("CIS pack: level must be 1 or 2.")
  const level = input.level as CisLevel
  if (benchmark !== expected.benchmark || version !== expected.version || level !== expected.level) {
    throw new Error("The CIS pack does not match the requested benchmark, version and level.")
  }
  if (!Array.isArray(input.policies)) throw new Error("The CIS pack policies must be an array.")
  if (!input.policies.length) throw new Error("The CIS pack policies must contain at least one policy.")
  if (input.policies.length > MAX_CIS_PACK_POLICIES) throw new Error(`The CIS pack must contain at most ${MAX_CIS_PACK_POLICIES} policies.`)
  return { benchmark, version, level, policies: input.policies }
}
