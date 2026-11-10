import { CIS_FRAMEWORKS, FEATURE_PLAN, type Feature } from "../../shared/plans"
import type { TrialTally } from "./tenant-trial-state"
import type { KeyValueStore } from "../storage/secure-store"

type Row = Record<string, unknown>
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.slice(0, 2000).map(object) : []

/** Reads existing local records and the trial tally only. No network calls or additional stores are used. */
export function trialUsageSummary(app: Pick<KeyValueStore, "get">, workspace: Pick<KeyValueStore, "get">, tenant: string, since: number, until: number, tally: TrialTally = {}): string | null {
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) return null
  const read = (store: Pick<KeyValueStore, "get">, key: string): unknown => {
    const raw = store.get(key)
    if (!raw) return null
    if (raw.length > 32_000_000) throw new Error("Record limit")
    return JSON.parse(raw)
  }
  const during = (at: unknown) => typeof at === "string" && Date.parse(at) >= since && Date.parse(at) <= Math.min(until, Date.now())
  const counts: Array<{ count: number; singular: string; plural: string }> = []
  const add = (feature: Feature, count: number, singular: string, plural: string) => {
    if (FEATURE_PLAN[feature] === "pro" && count > 0) counts.push({ count, singular, plural })
  }
  try {
    add("dailySchedule", tally.dailyBackups ?? 0, "daily backup", "daily backups")
    add("azureStorage", tally.azureBackups ?? 0, "backup to Azure storage", "backups to Azure storage")
    add("fullRestore", tally.fullRestores ?? 0, "full restore", "full restores")
    add("driftRevert", tally.driftReverts ?? 0, "drift revert", "drift reverts")
    for (const framework of CIS_FRAMEWORKS) {
      const saved = object(read(app, `framework.workspace.${tenant}.${framework}`))
      const runs = new Set(rows(saved.history).map(row => object(row.assessment)).filter(row => row.tenantId === tenant && row.frameworkId === framework && during(row.assessedAt) && typeof row.runId === "string").map(row => row.runId))
      add("baselineAllPlatforms", runs.size, `${framework === "cis-benchmarks" ? "CIS Benchmarks" : "CIS Controls"} assessment`, `${framework === "cis-benchmarks" ? "CIS Benchmarks" : "CIS Controls"} assessments`)
    }
    const records = (domain: string) => rows(read(workspace, `records.v1.${domain}.${tenant}`)).filter(row => row.tenantId === tenant)
    add("promotion", records("promotions").filter(row => row.status === "applied" && during(row.createdAt) && during(row.updatedAt)).length, "promotion", "promotions")
    add("baselineAllPlatforms", records("cis-remediations").filter(row => row.status === "applied" && during(row.createdAt) && during(row.updatedAt)).length, "CIS remediation", "CIS remediations")
    add("healthReview", records("health-reviews").filter(row => row.kind === "run" && row.status === "completed" && during(row.finishedAt)).length, "health review", "health reviews")
    const alerts = records("notification-outbox").filter(row => row.state === "sent" && during(row.sentAt) && object(row.envelope).test !== true && object(row.envelope).type !== "test")
    add("notifications", new Set(alerts.map(row => row.eventId || row.id).filter(id => typeof id === "string" && id.length > 0)).size, "alert sent", "alerts sent")
    add("changeReports", records("change-reports").filter(row => row.status === "ready" && during(row.createdAt)).length, "change report", "change reports")
    const parts = counts.sort((a, b) => b.count - a.count).slice(0, 4).map(row => `${row.count} ${row.count === 1 ? row.singular : row.plural}`)
    return parts.length ? `During your trial: ${parts.join(", ")}.` : null
  } catch { return null }
}

export function cachedTrialUsage(app: Pick<KeyValueStore, "get">, workspace: Pick<KeyValueStore, "get">) {
  const cache = new Map<string, string | null>()
  return (tenant: string, since: number, until: number, tally: TrialTally = {}): string | null => {
    const key = `${tenant}:${since}:${until}:${JSON.stringify(tally)}`
    if (!cache.has(key)) {
      if (cache.size >= 100) cache.delete(cache.keys().next().value!)
      cache.set(key, trialUsageSummary(app, workspace, tenant, since, until, tally))
    }
    return cache.get(key) ?? null
  }
}

export function trialWorkflowsConfigured(workspace: Pick<KeyValueStore, "get">, tenant: string): boolean {
  try {
    return ["notification-rules", "health-reviews", "change-report-settings"].some(domain => {
      const raw = workspace.get(`records.v1.${domain}.${tenant}`)
      if (!raw || raw.length > 32_000_000) return false
      return rows(JSON.parse(raw)).some(row => row.tenantId === tenant && (domain === "health-reviews" ? row.kind === "schedule" && row.enabled === true : domain === "change-report-settings" ? row.afterScheduledBackup === true : row.enabled === true))
    })
  } catch { return false }
}
