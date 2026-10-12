import type { Tenant } from "~/contexts/TenantContext"
import type { FrameworkDetail, FrameworkScore } from "../../../main/features/scores/view"
import { featureCall } from "../../lib/feature-api"

export type { FrameworkDetail, FrameworkScore, RankedGap } from "../../../main/features/scores/view"

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

/** "72.5 %" or a plain word when there is no value; never a number for missing evidence. */
export function formatPercent(value: number | null, empty = "Not scored"): string {
  return value === null ? empty : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} %`
}

export function formatDate(iso: string | null): string {
  if (!iso) return "Unknown date"
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleDateString(undefined, { dateStyle: "medium" })
}

const PLATFORM_LABELS: Record<string, string> = { windows: "Windows", macos: "macOS", ios: "iOS", android: "Android", tenant: "Conditional Access" }

export function scopeLabel(platforms: string[]): string {
  return platforms.map((platform) => PLATFORM_LABELS[platform] ?? platform).join(", ")
}
