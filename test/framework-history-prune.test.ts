import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleFramework, setInternalCisBenchmarksEnabled } from "../src/main/frameworks/service"
import { loadWorkspace, pruneHistory, recordAssessment, setFrameworkStore, workspaceCapacity, type WorkspaceView } from "../src/main/frameworks/workspaces"
import { withTenantWrite } from "../src/main/features/write-lock"
import { HISTORY_FULL_MESSAGE, MAX_WORKSPACE_BYTES, MAX_WORKSPACE_HISTORY } from "../src/shared/frameworks/workspace-history"
import type { Assessment } from "../src/shared/frameworks/policies"

const tenant = "11111111-1111-1111-1111-111111111111"
const other = "22222222-2222-2222-2222-222222222222"
const appId = "33333333-3333-3333-3333-333333333333"
const POLICIES = [{ name: "Synthetic baseline", platforms: "windows10", technologies: "mdm", settings: [{ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: "synthetic_setting", simpleSettingValue: { value: 8 } } }] }]

let data: Map<string, string>
beforeEach(() => {
  data = new Map()
  setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, delete: k => { data.delete(k) } })
})
afterEach(() => { setInternalCisBenchmarksEnabled(null); vi.unstubAllGlobals() })

function assessment(runId: string, assessedAt: string, tenantId = tenant, frameworkId = "custom"): Assessment {
  return { runId, tenantId, frameworkId, reference: "Synthetic v1", assessedAt, policyCount: 0, findings: [] }
}
/** Records `count` assessments, one day apart, the newest last so it is first in history. */
function fill(count: number, tenantId = tenant, frameworkId = "custom"): void {
  for (let day = 1; day <= count; day += 1) recordAssessment(assessment(`run-${day}`, new Date(Date.UTC(2026, 0, day)).toISOString(), tenantId, frameworkId), [])
}
const prune = (keep: unknown, extra: object = {}) => handleFramework({ action: "workspace-prune-history", tenantId: tenant, frameworkId: "custom", keep, ...extra } as never) as Promise<WorkspaceView>
function stubGraph(): string[] {
  const reads: string[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (!url.includes("oauth2")) reads.push(url)
    return Response.json(url.includes("oauth2") ? { access_token: "synthetic" } : { value: [] })
  }))
  return reads
}

describe("workspace history capacity", () => {
  it("reports the count, the limit and full at the cap on every workspace response", async () => {
    fill(MAX_WORKSPACE_HISTORY - 1)
    expect((await handleFramework({ action: "workspace-load", tenantId: tenant, frameworkId: "custom" }) as WorkspaceView).capacity).toEqual({ count: 49, limit: 50, full: false, reason: null })
    recordAssessment(assessment("run-50", "2026-03-01T00:00:00.000Z"), [])
    expect((await handleFramework({ action: "workspace-load", tenantId: tenant, frameworkId: "custom" }) as WorkspaceView).capacity).toEqual({ count: 50, limit: 50, full: true, reason: "count" })
    expect(() => recordAssessment(assessment("run-51", "2026-03-02T00:00:00.000Z"), [])).toThrow(HISTORY_FULL_MESSAGE)
  })

  it("reports full by size when one more assessment like the newest would pass the storage limit", () => {
    const workspace = loadWorkspace(tenant, "custom")
    const large = { ...assessment("large", "2026-01-01T00:00:00.000Z"), reference: "x".repeat(Math.ceil(MAX_WORKSPACE_BYTES / 2)) }
    workspace.history = [{ assessment: large, policies: [] }]
    expect(workspaceCapacity(workspace)).toEqual({ count: 1, limit: 50, full: true, reason: "size" })
    workspace.history = []
    expect(workspaceCapacity(workspace).full).toBe(false)
  })
})

describe("workspace-prune-history", () => {
  it("never removes the newest 10 even when a caller asks to keep fewer", () => {
    fill(12)
    expect(pruneHistory(loadWorkspace(tenant, "custom"), 1)).toEqual(["run-2", "run-1"])
    expect(loadWorkspace(tenant, "custom").history.map(entry => entry.assessment.runId)).toEqual(Array.from({ length: 10 }, (_, index) => `run-${12 - index}`))
  })

  it("keeps the newest N by assessment date in one save and leaves other tenants and frameworks untouched", async () => {
    fill(MAX_WORKSPACE_HISTORY)
    fill(12, other)
    fill(12, tenant, "ncsc-dsg")
    // Out-of-order history: the newest is kept by date, not by position.
    const raw = JSON.parse(data.get(`framework.workspace.${tenant}.custom`)!) as { history: unknown[] }
    raw.history.push(raw.history.shift())
    data.set(`framework.workspace.${tenant}.custom`, JSON.stringify(raw))
    let writes = 0
    const set = data.set.bind(data)
    setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { writes += 1; set(k, v) }, delete: k => { data.delete(k) } })
    const saved = await prune(10)
    expect(writes).toBe(1)
    expect(saved.history.map(entry => entry.assessment.runId).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `run-${41 + i}`).sort())
    expect(saved.capacity).toEqual({ count: 10, limit: 50, full: false, reason: null })
    expect(loadWorkspace(tenant, "custom").history).toHaveLength(10)
    expect(loadWorkspace(other, "custom").history).toHaveLength(12)
    expect(loadWorkspace(tenant, "ncsc-dsg").history).toHaveLength(12)
  })

  it("does not write when nothing is older than the newest N", async () => {
    fill(3)
    let writes = 0
    const set = data.set.bind(data)
    setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { writes += 1; set(k, v) }, delete: k => { data.delete(k) } })
    expect((await prune(10)).history).toHaveLength(3)
    expect(writes).toBe(0)
  })

  it.each([0, 1, 9, 51, 10.5, -1, "10", null, undefined, Number.NaN])("rejects keep %s without changing history", async keep => {
    fill(12)
    await expect(prune(keep)).rejects.toMatchObject({ status: 400, message: "Choose how many saved assessments to keep, from 10 to 50." })
    expect(loadWorkspace(tenant, "custom").history).toHaveLength(12)
  })

  it("requires a tenant and a catalog framework", async () => {
    await expect(handleFramework({ action: "workspace-prune-history", frameworkId: "custom", keep: 10 })).rejects.toMatchObject({ status: 400 })
    await expect(handleFramework({ action: "workspace-prune-history", tenantId: tenant, frameworkId: "unknown", keep: 10 })).rejects.toMatchObject({ status: 400 })
    await expect(handleFramework({ action: "workspace-prune-history", tenantId: "not-a-tenant", frameworkId: "custom", keep: 10 })).rejects.toThrow("Invalid workspace identity")
  })

  it("is refused while policy creation runs for the tenant, like the delete actions", async () => {
    fill(12)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const running = withTenantWrite(tenant, "Framework policy creation", () => held)
    try {
      await expect(prune(10)).rejects.toMatchObject({ status: 409 })
      expect(loadWorkspace(tenant, "custom").history).toHaveLength(12)
    } finally { release(); await running }
    expect((await prune(10)).history).toHaveLength(10)
  })

  it("is refused for disabled and read-only legacy frameworks", async () => {
    setInternalCisBenchmarksEnabled(false)
    await expect(handleFramework({ action: "workspace-prune-history", tenantId: tenant, frameworkId: "cis-benchmarks", keep: 10 })).rejects.toMatchObject({ status: 403 })
    await expect(handleFramework({ action: "workspace-prune-history", tenantId: tenant, frameworkId: "oib", keep: 10 })).rejects.toMatchObject({ status: 403 })
  })

  it("revokes live remediation authorization of removed assessments only", async () => {
    stubGraph()
    const first = await handleFramework({ action: "assess", tenantId: tenant, appId, frameworkId: "custom", reference: "v1", policies: POLICIES }) as Assessment
    let second: Assessment | undefined
    for (let index = 0; index < 10; index++) {
      await new Promise(resolve => setTimeout(resolve, 5))
      second = await handleFramework({ action: "assess", tenantId: tenant, appId, frameworkId: "custom", reference: "v1", policies: POLICIES }) as Assessment
    }
    expect((await prune(10)).history).toHaveLength(10)
    await expect(handleFramework({ action: "create", tenantId: tenant, appId, runId: first.runId, keys: ["0:0"], confirmUnassigned: true })).rejects.toThrow("expired")
    // The kept run still authorizes; it reaches the selection check instead of expiring.
    await expect(handleFramework({ action: "create", tenantId: tenant, appId, runId: second!.runId, keys: [], confirmUnassigned: true })).rejects.toThrow("Review and confirm")
  })
})

describe("assessments at the history cap", () => {
  it("refuses a policy-pack comparison before reading the tenant", async () => {
    fill(MAX_WORKSPACE_HISTORY)
    const reads = stubGraph()
    await expect(handleFramework({ action: "assess", tenantId: tenant, appId, frameworkId: "custom", reference: "v1", policies: POLICIES })).rejects.toMatchObject({ status: 409, message: HISTORY_FULL_MESSAGE })
    expect(reads).toEqual([])
  })

  it("refuses a CIS assessment job before reading the tenant", async () => {
    setInternalCisBenchmarksEnabled(true)
    fill(MAX_WORKSPACE_HISTORY, tenant, "cis-benchmarks")
    const reads = stubGraph()
    await expect(handleFramework({ action: "assess-start", tenantId: tenant, appId, frameworkId: "cis-benchmarks", reference: "synthetic-os 1.0.0 Level 1", policies: POLICIES })).rejects.toMatchObject({ status: 409, message: HISTORY_FULL_MESSAGE })
    expect(reads).toEqual([])
  })

  it("fails the job with the full message when the history fills up during the run", async () => {
    setInternalCisBenchmarksEnabled(true)
    fill(MAX_WORKSPACE_HISTORY - 1, tenant, "cis-benchmarks")
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "synthetic" })
      await gate
      return Response.json({ value: [] })
    }))
    const { jobId } = await handleFramework({ action: "assess-start", tenantId: tenant, appId, frameworkId: "cis-benchmarks", reference: "synthetic-os 1.0.0 Level 1", policies: POLICIES }) as { jobId: string }
    recordAssessment(assessment("concurrent", "2026-06-01T00:00:00.000Z", tenant, "cis-benchmarks"), [])
    release()
    let snapshot: { phase: string; error: string | null } = { phase: "", error: null }
    for (let attempt = 0; attempt < 200 && snapshot.phase !== "failed" && snapshot.phase !== "done"; attempt += 1) {
      snapshot = await handleFramework({ action: "assess-status", jobId, tenantId: tenant, frameworkId: "cis-benchmarks" }) as typeof snapshot
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(snapshot).toMatchObject({ phase: "failed", error: HISTORY_FULL_MESSAGE })
    expect(loadWorkspace(tenant, "cis-benchmarks").history).toHaveLength(MAX_WORKSPACE_HISTORY)
  })
})
