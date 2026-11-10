import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { trialUsageSummary, cachedTrialUsage } from "../src/main/license/usage"
import { memoryStore } from "./helpers"
let app: ReturnType<typeof memoryStore>
let workspace: ReturnType<typeof memoryStore>
const tenant = "contoso"
const since = Date.UTC(2026, 10, 1)
const until = Date.UTC(2026, 10, 20)
const at = new Date(since + 86400_000).toISOString()
function records(domain: string, values: Record<string, unknown>[]) { workspace.set(`records.v1.${domain}.${tenant}`, JSON.stringify(values.map(value => ({ tenantId: tenant, createdAt: at, updatedAt: at, ...value })))) }
beforeEach(() => { app = memoryStore(); workspace = memoryStore(); vi.useFakeTimers(); vi.setSystemTime(until) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it("counts only successful Pro activity for this tenant inside the trial", () => {
  app.set(`framework.workspace.${tenant}.cis-benchmarks`, JSON.stringify({ history: [
    { assessment: { tenantId: tenant, frameworkId: "cis-benchmarks", runId: "1", assessedAt: at } },
    { assessment: { tenantId: tenant, frameworkId: "cis-benchmarks", runId: "1", assessedAt: at } },
    { assessment: { tenantId: "fabrikam", frameworkId: "cis-benchmarks", runId: "2", assessedAt: at } },
    { assessment: { tenantId: tenant, frameworkId: "cis-benchmarks", runId: "3", assessedAt: "2025-01-01" } },
  ] }))
  records("promotions", [{ status: "applied" }, { status: "blocked" }, { status: "applied", sync: {} }, { status: "applied", createdAt: "2025-01-01" }])
  records("health-reviews", [{ kind: "run", status: "completed", finishedAt: at }, { kind: "run", status: "failed", finishedAt: at }])
  records("notification-outbox", [{ state: "sent", sentAt: at, envelope: {} }, { state: "sent", sentAt: at, envelope: { test: true } }, { state: "failed", sentAt: at }, { state: "sent", sentAt: at, envelope: { type: "test" } }])
  expect(trialUsageSummary(app, workspace, tenant, since, until)).toBe("During your trial: 1 CIS Benchmarks assessment, 1 promotion, 1 health review, 1 alert sent.")
  expect(trialUsageSummary(app, workspace, "fabrikam", since, until)).toBeNull()
})
it("uses the highest four counts with plurals and no zeroes", () => {
  records("change-reports", Array.from({ length: 6 }, () => ({ status: "ready" })))
  records("health-reviews", Array.from({ length: 3 }, () => ({ kind: "run", status: "completed", finishedAt: at })))
  expect(trialUsageSummary(app, workspace, tenant, since, until)).toBe("During your trial: 6 change reports, 3 health reviews.")
})
it.each(["weekly", "daily", "fallback", "changed"])("uses only the retained successful daily slot (%s)", kind => {
  app.set("backup.schedules", JSON.stringify({ [tenant]: { tenantId: tenant, frequency: kind === "weekly" ? "weekly" : "daily", lastRunAt: at, since: kind === "changed" ? new Date(until).toISOString() : new Date(since).toISOString(), ...(kind === "fallback" ? { fallbackStartsAt: at } : {}) } }))
  expect(trialUsageSummary(app, workspace, tenant, since, until)).toBe(kind === "daily" ? "During your trial: 1 daily backup." : null)
})
it("never calls the network or changes stores and caches the session result", () => {
  const network = vi.fn(() => { throw new Error("Network forbidden") })
  vi.stubGlobal("fetch", network)
  const get = vi.spyOn(workspace, "get")
  const set = vi.spyOn(workspace, "set")
  const cached = cachedTrialUsage(app, workspace)
  expect(cached(tenant, since, until)).toBeNull()
  const reads = get.mock.calls.length
  expect(cached(tenant, since, until)).toBeNull()
  expect(get).toHaveBeenCalledTimes(reads)
  expect(network).not.toHaveBeenCalled()
  expect(set).not.toHaveBeenCalled()
  for (let i = 0; i < 101; i++) cached(`tenant${i}`, since, until)
})
it.each(["invalid", "oversized", "throws", "empty"])("omits %s records without failing a notice", kind => {
  if (kind === "invalid") app.set("backup.schedules", "{")
  if (kind === "oversized") app.set("backup.schedules", "x".repeat(32_000_001))
  if (kind === "throws") vi.spyOn(app, "get").mockImplementation(() => { throw new Error("Unreadable") })
  expect(trialUsageSummary(app, workspace, tenant, since, until)).toBeNull()
  expect(trialUsageSummary(app, workspace, tenant, NaN, until)).toBeNull()
  expect(trialUsageSummary(app, workspace, tenant, until, since)).toBeNull()
})
