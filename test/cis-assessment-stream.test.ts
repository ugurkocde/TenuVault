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

async function status(jobId: string, since = 0): Promise<Snapshot> {
  return handleFramework({ action: "assess-status", jobId, since }) as Promise<Snapshot>
}

async function pollDone(jobId: string): Promise<Snapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snap = await status(jobId)
    if (snap.phase === "done" || snap.phase === "failed") return snap
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error("Job did not finish in time.")
}

async function startJob(): Promise<string> {
  const item = pack()
  const result = await handleFramework({ action: "assess-start", frameworkId: "cis-benchmarks", tenantId, appId, reference: item.reference, policies: item.policies }) as { jobId: string }
  expect(typeof result.jobId).toBe("string")
  expect(result.jobId.length).toBeGreaterThan(0)
  return result.jobId
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
})
