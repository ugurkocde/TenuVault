import { createHash } from "node:crypto"
import type { BaselinePolicy } from "../../shared/frameworks/policies"
import type { CisLevel } from "../../shared/frameworks/cis-content"

/**
 * What the delivery service delivered to a tenant, so the main process accepts CIS Benchmarks
 * policies only when it delivered them itself. cis-fetch-pack records one entry per delivered
 * pack: its benchmark, version and Level and a digest of each of its policies as saved (with
 * provenance). Saving, assessing and remediating CIS Benchmarks policies then needs them to be
 * a subset of one delivered pack, so removing alternative profile policies keeps working while
 * policies the renderer built itself, such as a Build Kit conversion, are refused. Callers with
 * the internal CIS claim are not checked (Build Kit import).
 */
export interface DeliveredCisPack {
  benchmark: string
  version: string
  level: CisLevel
  /** SHA-256 of each policy in canonical JSON. */
  policies: string[]
}

/** Delivered packs a workspace remembers, newest last; older saved assessments of a pack that rotated out need it loaded again. */
export const MAX_DELIVERED_PACKS = 12

export const CIS_POLICIES_NOT_DELIVERED = "These CIS Benchmarks policies were not delivered to this tenant by the TenuVault delivery service. Load the benchmark again from the delivery service."

/** JSON with object keys sorted, so the same policy always hashes the same after a round trip through the renderer. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export function policyDigest(policy: BaselinePolicy): string {
  return createHash("sha256").update(canonical(policy)).digest("hex")
}

/** The delivered packs with one more, newest last: the same pack delivered again moves to the end instead of repeating. */
export function withDeliveredPack(packs: DeliveredCisPack[] | undefined, pack: Omit<DeliveredCisPack, "policies">, policies: BaselinePolicy[]): DeliveredCisPack[] {
  const entry: DeliveredCisPack = { benchmark: pack.benchmark, version: pack.version, level: pack.level, policies: policies.map(policyDigest) }
  const same = (other: DeliveredCisPack) => other.benchmark === entry.benchmark && other.version === entry.version && other.level === entry.level && other.policies.join() === entry.policies.join()
  return [...(packs ?? []).filter(other => !same(other)), entry].slice(-MAX_DELIVERED_PACKS)
}

/** Whether every policy belongs to one delivered pack, each at most once. An empty set is a subset. */
export function isDeliveredSubset(packs: DeliveredCisPack[] | undefined, policies: BaselinePolicy[]): boolean {
  if (!policies.length) return true
  const digests = policies.map(policyDigest)
  if (new Set(digests).size !== digests.length) return false
  return (packs ?? []).some(pack => digests.every(digest => pack.policies.includes(digest)))
}

/** Reads stored delivered packs; anything malformed makes the workspace unreadable, like the other stored parts. */
export function validateDeliveredPacks(value: unknown): DeliveredCisPack[] {
  if (!Array.isArray(value) || value.length > MAX_DELIVERED_PACKS) throw new Error("Invalid delivered packs")
  return value.map(item => {
    const entry = item as Partial<DeliveredCisPack> | null
    if (!entry || typeof entry !== "object" || typeof entry.benchmark !== "string" || typeof entry.version !== "string" || (entry.level !== 1 && entry.level !== 2) || !Array.isArray(entry.policies) || entry.policies.some(digest => typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))) throw new Error("Invalid delivered packs")
    return { benchmark: entry.benchmark, version: entry.version, level: entry.level, policies: [...entry.policies] }
  })
}
