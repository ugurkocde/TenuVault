import type { Tenant } from "~/contexts/TenantContext"
import type { FrameworkDetail, FrameworkScore } from "../../../main/features/scores/view"
import { CIS_BENCHMARKS_ID } from "../../../shared/frameworks/cis-internal"
import type { CisPortfolioWorkspace } from "../../../shared/frameworks/cis-portfolio"
import { featureCall } from "../../lib/feature-api"

export type { FrameworkDetail, FrameworkScore, RankedGap } from "../../../main/features/scores/view"
export type { CountedItem, CountedResult } from "../../../shared/compliance/counted"

export interface ScoreSummary {
  tenantId: string
  tenantName: string | null
  formula: string
  staleAfterDays: number
  scoringChanged: boolean
  frameworks: FrameworkScore[]
}

export interface PortfolioFramework {
  frameworkId: string
  frameworkName: string
  state: FrameworkScore["state"]
  message: string | null
  score: number | null
  coverage: number | null
  unknown: number | null
  gapCount: number | null
  assessedAt: string | null
  ageDays: number | null
  stale: boolean | null
  partial: boolean | null
  version: string | null
}

export interface PortfolioTenant {
  tenantId: string
  tenantName: string | null
  error: string | null
  frameworks: PortfolioFramework[]
}

export function loadSummary(tenant: Tenant) {
  return featureCall<ScoreSummary>("/api/scores", tenant, "summary")
}

export function loadDetail(tenant: Tenant, frameworkId: string, runId?: string) {
  return featureCall<{ tenantId: string; tenantName: string | null; detail: FrameworkDetail }>("/api/scores", tenant, "detail", { frameworkId, ...(runId && { runId }) })
}

export function loadPortfolio(tenant: Tenant, targets: string[]) {
  return featureCall<{ formula: string; tenants: PortfolioTenant[] }>("/api/scores", tenant, "portfolio-summary", { targetTenants: targets.map((tenantId) => ({ tenantId })) })
}

/**
 * The data of a query that may be shown as current: only from a successful read, made at or
 * after `since` when given (the CIS cards pass the time the tab opened). A failed refetch keeps
 * the cached data in the query; it is hidden behind the error instead of shown as current.
 */
export function freshData<T>(query: { status: "pending" | "error" | "success"; data: T | undefined; dataUpdatedAt: number }, since = 0): T | undefined {
  return query.status === "success" && query.dataUpdatedAt >= since ? query.data : undefined
}

/** "72.5%" or a plain word when there is no value; never a number for missing evidence. The one percent format of every score view. */
export function formatPercent(value: number | null, empty = "Not scored"): string {
  return value === null || !Number.isFinite(value) ? empty : `${Math.round(value * 10) / 10}%`
}

/**
 * A score and its coverage as one unit, "9.6% on 96% coverage": the coverage says how much of
 * the framework the score could evaluate, so the score is never shown without it.
 */
export function formatScore(score: { score: number | null; coverage: number | null }): string {
  if (score.score === null) return "Not scored"
  return score.coverage === null ? `${formatPercent(score.score)}, coverage unknown` : `${formatPercent(score.score)} on ${formatPercent(score.coverage)} coverage`
}

/** "capabilities" or "settings": what the counts of a score refer to. */
export function unitLabel(unit: "capability" | "setting", count: number): string {
  return unit === "setting" ? (count === 1 ? "setting" : "settings") : count === 1 ? "capability" : "capabilities"
}

export function formatDate(iso: string | null): string {
  if (!iso) return "Unknown date"
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleDateString(undefined, { dateStyle: "medium" })
}

/** How long ago a comparison ran: "today" on the same local day, never "0 days ago". Null without an age. */
export function ageText(assessedAt: string, ageDays: number | null, now: Date = new Date()): string | null {
  if (ageDays === null) return null
  if (ageDays === 0) return new Date(assessedAt).toDateString() === now.toDateString() ? "today" : "less than a day ago"
  return `${ageDays} day${ageDays === 1 ? "" : "s"} ago`
}

const PLATFORM_LABELS: Record<string, string> = { windows: "Windows", macos: "macOS", ios: "iOS", android: "Android", tenant: "Conditional Access" }

export function scopeLabel(platforms: string[]): string {
  return platforms.map((platform) => PLATFORM_LABELS[platform] ?? platform).join(", ")
}

/**
 * Frameworks that failed for the same reason, as one entry each: a failed /api/frameworks or
 * /api/oib read gives every framework the same message, which is shown once.
 */
export function groupUnavailable(frameworks: Array<Pick<FrameworkScore, "frameworkName" | "message">>): Array<{ message: string; names: string[] }> {
  const groups = new Map<string, string[]>()
  for (const framework of frameworks) {
    const message = framework.message ?? "The saved results could not be read."
    groups.set(message, [...(groups.get(message) ?? []), framework.frameworkName])
  }
  return [...groups].map(([message, names]) => ({ message, names }))
}

/** "ISO 27001, NIST CSF 2.0" or "18 frameworks" once a list gets too long to read. */
export function namesLabel(names: string[]): string {
  return names.length > 3 ? `${names.length} frameworks` : names.join(", ")
}

/** The saved CIS Benchmarks workspace of a tenant; read only, nothing is collected. */
export async function loadCisWorkspace(tenantId: string): Promise<CisPortfolioWorkspace> {
  const response = await fetch("/api/frameworks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "workspace-load", tenantId, frameworkId: CIS_BENCHMARKS_ID }) })
  const value = (await response.json().catch(() => ({}))) as CisPortfolioWorkspace & { error?: string }
  if (!response.ok) throw new Error(value.error ?? `The saved CIS assessments could not be read (${response.status}).`)
  return value
}
