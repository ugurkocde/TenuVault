import type { Tenant } from "~/contexts/TenantContext"
import { featureCall } from "../../lib/feature-api"

export type FindingStatus = "open" | "acknowledged" | "false-positive" | "resolved"
export type Classification = "definite" | "possible"

export interface PolicyRef {
  folder: string
  id: string
  name: string
}

export interface Rule {
  id: string
  name: string
  description: string
  limits: string
}

export interface Scan {
  id: string
  createdAt: string
  backupId: string
  collectedAt: string
  completeness: "complete" | "partial"
  partialReason: string | null
  covered: string[]
  notCollected: Array<{ folder: string; label: string; reason: string }>
  itemCount: number
  unreadableItems: number
  unknowns: Array<{ ruleId: string; reason: string; count: number; policies: PolicyRef[] }>
  groupResolution: { state: string; reason: string | null }
  /** Absent on scans from before the deprecated settings rule. */
  catalog?: { state: string; checkedAt: string | null; total: number | null; reason: string | null }
  counts: { definite: number; possible: number }
}

export interface Finding {
  id: string
  title: string
  summary: string
  status: FindingStatus
  ruleId: string
  classification: Classification
  severity: "high" | "medium" | "low"
  explanation: string
  policies: PolicyRef[]
  settings: Array<{ definitionId: string; values: Array<{ policyId: string; display: string; valueSha256: string }> }>
  details: Record<string, string | string[]>
  evidenceSha256: string
  backupId: string
  collectedAt: string
  firstSeenAt: string
  lastSeenAt: string
  review: { action: string; by: string | null; at: string; note: string } | null
  history?: Array<{ at: string; actor: string | null; reason: string; snapshot: { status: FindingStatus; evidenceSha256: string } }>
}

export interface HygieneList {
  rules: Rule[]
  scans: Scan[]
  findings: Finding[]
  total: number
}

export interface FleetTenant {
  tenantId: string
  name: string
  latestScan: { collectedAt: string; completeness: string; notCollected: number; unknowns: number } | null
  counts: { openDefinite: number; openPossible: number; acknowledged: number; falsePositive: number; resolved: number }
  queue: Array<{ id: string; title: string; ruleId: string; severity: string; collectedAt: string }>
}

export const GROUP_READ_OPT_IN_HINT = "To let this check run, add Group.Read.All to the app registration and grant admin consent (run New-TenuVaultDesktopApp.ps1 with -IncludeGroupRead), then sign in again and rescan."
export const STATUS_LABELS: Record<FindingStatus, string> = { open: "Open", acknowledged: "Acknowledged", "false-positive": "False positive", resolved: "Not detected" }
export const CLASSIFICATION_LABELS: Record<Classification, string> = { definite: "Definite", possible: "Possible" }

export const loadList = (tenant: Tenant) => featureCall<HygieneList>("/api/hygiene", tenant, "list")
export const loadFinding = (tenant: Tenant, findingId: string) => featureCall<{ finding: Finding; rule: Rule; scan: Scan | null }>("/api/hygiene", tenant, "get", { findingId })
export const runScan = (tenant: Tenant) => featureCall<HygieneList>("/api/hygiene", tenant, "scan")
export const reviewFinding = (tenant: Tenant, action: "acknowledge" | "mark-false-positive" | "reopen", findingId: string, text: string) =>
  featureCall<{ finding: Finding }>("/api/hygiene", tenant, action, action === "mark-false-positive" ? { findingId, reason: text } : action === "acknowledge" ? { findingId, note: text } : { findingId, reason: text || undefined })
export const loadFleet = (tenant: Tenant, targets: string[]) => featureCall<{ tenants: FleetTenant[] }>("/api/hygiene", tenant, "portfolio-summary", { targetTenants: targets.map((tenantId) => ({ tenantId })) })

export function formatDate(value: string | null | undefined): string {
  if (!value) return "Unknown"
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Unknown"
}
