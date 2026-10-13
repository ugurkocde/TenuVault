import type { Tenant } from "~/contexts/TenantContext"
import { featureCall } from "../../lib/feature-api"

export type Severity = "critical" | "high" | "medium" | "low"
export type Counts = Record<Severity | "unknown", number>

export interface ChangeEntry {
  at: string
  actor: string | null
  reason: string
}

export interface Finding {
  id: string
  key: string
  family: "backup" | "signals"
  check: string
  severity: Severity
  state: "open" | "unknown" | "resolved"
  title: string
  reason: string
  observedAt: string | null
  evidenceAt: string | null
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
  occurrence: number
  owner: string | null
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  link: string
  history: ChangeEntry[]
}

export interface Run {
  id: string
  status: string
  summary: string
  trigger: "manual" | "scheduled" | "catch-up"
  startedAt: string
  finishedAt: string
  missedWindows: number
  checks: Array<{ family: string; evaluated: boolean; detail: string }>
  counts: Counts
  deliveries: Array<{ endpoint: string; ok: boolean; attempts: number; error: string | null }>
}

export interface Delivery {
  at: string
  ok: boolean
  attempts: number
  status: number | null
  error: string | null
  findings: number
  test: boolean
}

export interface Endpoint {
  id: string
  kind: "local" | "webhook"
  title: string
  enabled: boolean
  url: string | null
  headerName: string | null
  hasSecretHeader: boolean
  minSeverity: Severity
  includeTenantName: boolean
  includeIdentifiers: boolean
  lastDelivery: Delivery | null
  deliveries: Delivery[]
}

export interface Status {
  schedule: { enabled: boolean; intervalHours: number; lastReviewAt: string | null; lastAttemptAt: string | null; lastOutcome: string | null; nextDueAt: string | null } | null
  readiness: { state: "ready" | "disabled" | "sign-in-required" | "not-licensed"; message: string; signedIn: boolean; licensed: boolean; note: string }
  lastRun: Run | null
  counts: Counts
  thresholds: Record<string, number>
  endpoints: Endpoint[]
}

export interface PortfolioRow {
  tenantId: string
  name: string | null
  signedIn: boolean
  scheduleEnabled: boolean
  lastReviewAt: string | null
  lastOutcome: string | null
  nextDueAt: string | null
  lastRunStatus: string | null
  counts: Counts
  owners: string[]
}

const PATH = "/api/health-review"

export const healthApi = {
  status: (tenant: Tenant) => featureCall<Status>(PATH, tenant, "get-status"),
  findings: (tenant: Tenant) => featureCall<{ findings: Finding[] }>(PATH, tenant, "list-findings").then((result) => result.findings),
  runs: (tenant: Tenant) => featureCall<{ runs: Run[] }>(PATH, tenant, "list-runs").then((result) => result.runs),
  run: (tenant: Tenant) => featureCall<{ run: Run }>(PATH, tenant, "run-review"),
  schedule: (tenant: Tenant, body: { enabled?: boolean; intervalHours?: number }) => featureCall(PATH, tenant, "update-schedule", body),
  acknowledge: (tenant: Tenant, findingId: string) => featureCall(PATH, tenant, "acknowledge-finding", { findingId }),
  owner: (tenant: Tenant, findingId: string, owner: string | null) => featureCall(PATH, tenant, "set-finding-owner", { findingId, owner }),
  addEndpoint: (tenant: Tenant, body: Record<string, unknown>) => featureCall<{ endpoint: Endpoint }>(PATH, tenant, "add-endpoint", body),
  updateEndpoint: (tenant: Tenant, endpointId: string, body: Record<string, unknown>) => featureCall(PATH, tenant, "update-endpoint", { endpointId, ...body }),
  removeEndpoint: (tenant: Tenant, endpointId: string) => featureCall(PATH, tenant, "revoke-endpoint", { endpointId }),
  testEndpoint: (tenant: Tenant, endpointId: string) => featureCall<{ delivery: Delivery }>(PATH, tenant, "test-endpoint", { endpointId }),
  preview: (tenant: Tenant, body: Record<string, unknown>) => featureCall<{ body: string; kind: string }>(PATH, tenant, "preview-payload", body),
  portfolio: (tenant: Tenant, targets: string[]) => featureCall<{ tenants: PortfolioRow[] }>(PATH, tenant, "portfolio-status", { targetTenants: targets.map((tenantId) => ({ tenantId })) }),
}

export function formatTime(value: string | null | undefined, fallback = "Never"): string {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : fallback
}

export const OUTCOME_LABELS: Record<string, string> = {
  completed: "Completed",
  partial: "Partial: some evidence could not be read",
  "could-not-authenticate": "Could not authenticate",
  "not-licensed": "Skipped: not licensed",
  failed: "Failed",
}

export const SEVERITY_TONE = { critical: "danger", high: "danger", medium: "warning", low: "neutral" } as const
