import type { FeatureDeps } from "./deps"

/**
 * Shapes that several roadmap workflows read from each other. The owning workflow writes
 * them; readers only use the fields below.
 */

/**
 * Fields every record in these domains carries, so a reader can list them without knowing
 * each workflow: change-sets, promotions, baseline-upgrades, hygiene-findings.
 */
export interface ListedRecord {
  title: string
  /** Workflow specific, for example "draft", "approved", "applied", "verified", "failed", "unknown". */
  status: string
  /** One plain sentence on the outcome or state, without secrets or full policy content. */
  summary: string
}

/**
 * Something that needs an admin's attention, derived from a workflow's stored records.
 * `observedAt` is when the underlying evidence was collected; null when it never was, which
 * readers show as unknown, never as healthy.
 */
export interface WorkSignal {
  /** Stable key for deduplication, such as `standard-deviation:<id>`. */
  key: string
  tenantId: string
  source: "change" | "standard" | "hygiene" | "score"
  severity: "critical" | "high" | "medium" | "low"
  /** "unknown" when the evidence is missing or could not be read. */
  state: "open" | "unknown"
  title: string
  reason: string
  observedAt: string | null
  /** An in-app route to the source evidence, such as /portal/governance/standards. */
  link: string
  /** Record references (`<domain>:<id>`) the signal was derived from. */
  evidence: string[]
}

/** A workflow's current signals for one tenant, derived from its stored records. */
export type SignalProvider = (deps: FeatureDeps, tenantId: string) => Promise<WorkSignal[]> | WorkSignal[]
