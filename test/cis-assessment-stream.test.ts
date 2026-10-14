import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convertKit, type KitFile } from "../src/shared/frameworks/cis-kit"
import { handleFramework, setInternalCisBenchmarksEnabled } from "../src/main/frameworks/service"
import { loadWorkspace, setFrameworkStore } from "../src/main/frameworks/workspaces"
import type { Assessment, Finding, Json } from "../src/shared/frameworks/policies"

const type = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const GRAPH = "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies"
const tenantId = "11111111-1111-1111-1111-111111111111"
const appId = "22222222-2222-2222-2222-222222222222"

const policy = (name: string, description: string, settingId = "fakebook_setting_alpha") => JSON.stringify({
  name, platforms: "windows10", technologies: "mdm", description,
  settings: [{ settingInstance: { "@odata.type": type, settingDefinitionId: settingId, choiceSettingValue: { value: "fake-on" } } }],
})
const kitFiles: KitFile[] = [
  { path: "Level 1/Fakebook Alpha 9.9.9.json", content: policy("Fakebook Alpha", "Covers 7.1.1 and 7.1.2") },
  { path: "Level 1/Fakebook Beta 9.9.9.json", content: policy("Fakebook Beta", "Covers 7.1.2", "fakebook_setting_beta") },
]

function pack() {
  const converted = convertKit(kitFiles, { id: "fakebook-os", version: "9.9.9" })
  const item = converted.packs.find(entry => entry.level === 1)!
  return { reference: item.reference, policies: JSON.parse(JSON.stringify(item.policies)) as Json }
}

interface Snapshot {
  jobId: string
  phase: string
  read: number
  total: number
  currentPolicy: string
  comparedPolicies: number
  packPolicies: number
  currentPackPolicy: string
  findings: Finding[]
  nextSince: number
  error: string | null
  assessment: Assessment | null
}

const tenantPolicies = [
  { id: "33333333-3333-3333-3333-333333333331", name: "Tenant Alpha", platforms: "windows10", technologies: "mdm", description: "tenant", settingCount: 1, settingId: "fakebook_setting_alpha" },
  { id: "33333333-3333-3333-3333-333333333332", name: "Tenant Other", platforms: "windows10", technologies: "mdm", description: "tenant", settingCount: 1, settingId: "fakebook_setting_other" },
]

function graphFetch(options: { gate?: Promise<void>; failGraph?: boolean; settingsGate?: Promise<void> } = {}) {
  return vi.fn(async (url: string) => {
    const target = String(url)
    if (target.includes("oauth2")) return Response.json({ access_token: "test" })
    if (options.failGraph && target.startsWith(GRAPH)) return new Response(JSON.stringify({}), { status: 503 })
    if (target === GRAPH) {
      if (options.gate) await options.gate
      return Response.json({ value: tenantPolicies.map(({ settingId: _settingId, ...rest }) => rest) })
    }
    if (target.endsWith("/assignments")) return Response.json({ value: [] })
    if (target.includes("/settings")) {
      const found = tenantPolicies.find(entry => target.includes(entry.id))
      if (options.settingsGate && found?.id === tenantPolicies[1]?.id) await options.settingsGate
      return Response.json({ value: [{ settingInstance: { "@odata.type": type, settingDefinitionId: found?.settingId ?? "fakebook_setting_alpha", choiceSettingValue: { value: "fake-on" } } }] })
    }
    return Response.json({ value: [] })
  })
}

async function status(jobId: string, since = 0, tenant: string = tenantId, frameworkId = "cis-benchmarks"): Promise<Snapshot> {
  return handleFramework({ action: "assess-status", jobId, since, tenantId: tenant, frameworkId }) as Promise<Snapshot>
}

async function pollDone(jobId: string, tenant: string = tenantId): Promise<Snapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snap = await status(jobId, 0, tenant)
    if (snap.phase === "done" || snap.phase === "failed") return snap
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error("Job did not finish in time.")
}

async function startJob(tenant: string = tenantId): Promise<string> {
  const item = pack()
  const result = await handleFramework({ action: "assess-start", frameworkId: "cis-benchmarks", tenantId: tenant, appId, reference: item.reference, policies: item.policies }) as { jobId: string }
  expect(typeof result.jobId).toBe("string")
  expect(result.jobId.length).toBeGreaterThan(0)
  return result.jobId
}

function tenantAt(index: number): string {
  return `aaaaaaaa-aaaa-aaaa-aaaa-${String(index).padStart(12, "0")}`
}

beforeEach(() => {
  setInternalCisBenchmarksEnabled(true)
  const data = new Map<string, string>()
  setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, delete: k => { data.delete(k) } })
})
afterEach(() => { setInternalCisBenchmarksEnabled(null); vi.unstubAllGlobals() })

describe("streamed CIS assessment", () => {
  it("returns a jobId promptly while Graph is gated, then reaches done matching synchronous assess", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetchMock = graphFetch({ gate })
    vi.stubGlobal("fetch", fetchMock)
    const jobId = await startJob()
    const early = await status(jobId)
    expect(early.phase).not.toBe("done")
    expect(early.phase).not.toBe("failed")
    release()
    const done = await pollDone(jobId)
    expect(done.phase).toBe("done")
    expect(done.assessment).not.toBeNull()
    expect(done.read).toBe(done.total)
    expect(done.total).toBe(tenantPolicies.length)
    expect(done.comparedPolicies).toBe(done.packPolicies)
    expect(done.packPolicies).toBe(2)

    vi.stubGlobal("fetch", graphFetch())
    const item = pack()
    const sync = await handleFramework({ action: "assess", frameworkId: "cis-benchmarks", tenantId, appId, reference: item.reference, policies: item.policies }) as Assessment
    expect(done.assessment!.findings).toEqual(sync.findings)
    expect(done.findings).toEqual(sync.findings)
  })

  it("advances reading progress while tenant policies are read", async () => {
    let release!: () => void
    const settingsGate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal("fetch", graphFetch({ settingsGate }))
    const jobId = await startJob()
    let mid: Snapshot | null = null
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snap = await status(jobId)
      if (snap.read === 1) { mid = snap; break }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(mid).not.toBeNull()
    expect(mid!.phase).toBe("reading")
    expect(mid!.total).toBe(tenantPolicies.length)
    expect(mid!.read).toBe(1)
    expect(mid!.currentPolicy).toBe("Tenant Alpha")
    release()
    const done = await pollDone(jobId)
    expect(done.read).toBe(done.total)
    expect(done.comparedPolicies).toBe(done.packPolicies)
  })

  it("returns disjoint incremental slices whose concatenation equals the final findings", async () => {
    vi.stubGlobal("fetch", graphFetch())
    const jobId = await startJob()
    const collected: Finding[] = []
    const keys = new Set<string>()
    let since = 0
    let final: Snapshot | null = null
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const snap = await status(jobId, since)
      for (const finding of snap.findings) {
        expect(keys.has(finding.key)).toBe(false)
        keys.add(finding.key)
      }
      collected.push(...snap.findings)
      expect(snap.nextSince).toBeGreaterThanOrEqual(since)
      since = snap.nextSince
      if (snap.phase === "done" || snap.phase === "failed") { final = snap; break }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(final?.phase).toBe("done")
    // Drain any findings revealed in the same poll that reported done is already included.
    const tail = await status(jobId, since)
    collected.push(...tail.findings)
    expect(collected).toEqual(final!.assessment!.findings)
  })

  it("lands in failed with the error preserved and records no assessment when Graph fails", async () => {
    vi.stubGlobal("fetch", graphFetch({ failGraph: true }))
    const before = loadWorkspace(tenantId, "cis-benchmarks").history.length
    const jobId = await startJob()
    const failed = await pollDone(jobId)
    expect(failed.phase).toBe("failed")
    expect(failed.error).toContain("Request failed (503)")
    expect(failed.assessment).toBeNull()
    expect(loadWorkspace(tenantId, "cis-benchmarks").history.length).toBe(before)
  })

  it("returns 404 for an unknown jobId", async () => {
    vi.stubGlobal("fetch", graphFetch())
    await expect(handleFramework({ action: "assess-status", jobId: "no-such-job", since: 0 }))
      .rejects.toMatchObject({ status: 404 })
  })

  it("returns 404 when a poll names another tenant, another framework, or no identity", async () => {
    vi.stubGlobal("fetch", graphFetch())
    const jobId = await startJob()
    await pollDone(jobId)
    const otherTenant = "99999999-9999-9999-9999-999999999999"
    await expect(handleFramework({ action: "assess-status", jobId, since: 0, tenantId: otherTenant, frameworkId: "cis-benchmarks" }))
      .rejects.toMatchObject({ status: 404, message: "Assessment job not found." })
    await expect(handleFramework({ action: "assess-status", jobId, since: 0, tenantId, frameworkId: "microsoft" }))
      .rejects.toMatchObject({ status: 404, message: "Assessment job not found." })
    await expect(handleFramework({ action: "assess-status", jobId, since: 0 }))
      .rejects.toMatchObject({ status: 404, message: "Assessment job not found." })
    await expect(handleFramework({ action: "assess-status", jobId, since: 0, tenantId }))
      .rejects.toMatchObject({ status: 404, message: "Assessment job not found." })
    const snap = await status(jobId)
    expect(snap.jobId).toBe(jobId)
  })

  it("returns the running job for a duplicate start and a new job after it finishes", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetchMock = graphFetch({ gate })
    vi.stubGlobal("fetch", fetchMock)
    const first = await startJob()
    const graphCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === GRAPH).length
    const callsBefore = graphCalls()
    const second = await startJob()
    expect(second).toBe(first)
    expect(graphCalls()).toBe(callsBefore)
    release()
    await pollDone(first)
    vi.stubGlobal("fetch", graphFetch())
    const third = await startJob()
    expect(third).not.toBe(first)
    await pollDone(third)
  })

  it("refuses a duplicate start for a different pack while a job is running", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal("fetch", graphFetch({ gate }))
    const first = await startJob()
    const item = pack()
    await expect(handleFramework({ action: "assess-start", frameworkId: "cis-benchmarks", tenantId, appId, reference: "Fakebook OS 9.9.9 Level 2", policies: item.policies }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("different policy pack") })
    const altered = JSON.parse(JSON.stringify(item.policies)) as { name: string }[]
    altered[0]!.name = "Fakebook Alpha Changed"
    await expect(handleFramework({ action: "assess-start", frameworkId: "cis-benchmarks", tenantId, appId, reference: item.reference, policies: altered }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("different policy pack") })
    const same = await startJob()
    expect(same).toBe(first)
    release()
    await pollDone(first)
  })

  it("rejects a start when ten jobs are already running and never evicts a running job", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal("fetch", graphFetch({ gate }))
    const tenants: string[] = []
    const jobIds: string[] = []
    for (let index = 0; index < 10; index += 1) {
      const tenant = tenantAt(index + 1)
      tenants.push(tenant)
      jobIds.push(await startJob(tenant))
    }
    const extraTenant = tenantAt(99)
    const item = pack()
    await expect(handleFramework({ action: "assess-start", frameworkId: "cis-benchmarks", tenantId: extraTenant, appId, reference: item.reference, policies: item.policies }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("Wait for a running assessment to finish") })
    for (let index = 0; index < jobIds.length; index += 1) {
      const snap = await status(jobIds[index]!, 0, tenants[index]!)
      expect(snap.phase).not.toBe("done")
      expect(snap.phase).not.toBe("failed")
    }
    release()
    for (let index = 0; index < jobIds.length; index += 1) await pollDone(jobIds[index]!, tenants[index]!)
  })

  it("evicts only finished jobs to enforce the cap, and an evicted job polls as unknown", async () => {
    vi.stubGlobal("fetch", graphFetch())
    const tenants: string[] = []
    const jobIds: string[] = []
    for (let index = 0; index < 12; index += 1) {
      const tenant = tenantAt(100 + index)
      tenants.push(tenant)
      const jobId = await startJob(tenant)
      jobIds.push(jobId)
      await pollDone(jobId, tenant)
    }
    await expect(handleFramework({ action: "assess-status", jobId: jobIds[0]!, since: 0, tenantId: tenants[0]!, frameworkId: "cis-benchmarks" }))
      .rejects.toMatchObject({ status: 404, message: "Assessment job not found." })
    const latest = await status(jobIds[jobIds.length - 1]!, 0, tenants[tenants.length - 1]!)
    expect(latest.phase).toBe("done")
  })

  it("refuses assess-start for a native framework and for a disabled framework like assess", async () => {
    vi.stubGlobal("fetch", graphFetch())
    const item = pack()
    for (const action of ["assess", "assess-start"]) {
      await expect(handleFramework({ action, frameworkId: "nist-csf", tenantId, appId, reference: item.reference, policies: item.policies }))
        .rejects.toMatchObject({ status: 403 })
    }
    setInternalCisBenchmarksEnabled(false)
    try {
      for (const action of ["assess", "assess-start"]) {
        await expect(handleFramework({ action, frameworkId: "cis-benchmarks", tenantId, appId, reference: item.reference, policies: item.policies }))
          .rejects.toMatchObject({ status: 403 })
      }
    } finally {
      setInternalCisBenchmarksEnabled(true)
    }
  })
})
