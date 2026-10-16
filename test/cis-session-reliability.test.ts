import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convertKit, type KitFile } from "../src/shared/frameworks/cis-kit"
import { handleFramework, isAdmittedAssessStatus, setInternalCisBenchmarksEnabled } from "../src/main/frameworks/service"
import { loadWorkspace, setFrameworkStore } from "../src/main/frameworks/workspaces"
import { currentSavedAssessment } from "../src/shared/frameworks/cis-run"
import { WORKSPACE_UNREADABLE_MESSAGE } from "../src/shared/frameworks/workspace-history"
import type { Assessment, Json } from "../src/shared/frameworks/policies"

const sleeps = vi.hoisted(() => [] as number[])
// Graph read retries record their wait instead of letting real time pass.
vi.mock("../src/main/graph-retry", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/main/graph-retry")>()), sleep: async (ms: number) => { sleeps.push(ms) } }))

const type = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const GRAPH = "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies"
const tenantId = "11111111-1111-1111-1111-111111111111"
const appId = "22222222-2222-2222-2222-222222222222"
const POLICY_A = "33333333-3333-3333-3333-333333333331"
const POLICY_B = "33333333-3333-3333-3333-333333333332"

const kitPolicy = (name: string, settingId: string) => JSON.stringify({
  name, platforms: "windows10", technologies: "mdm", description: "Covers 7.1.1",
  settings: [{ settingInstance: { "@odata.type": type, settingDefinitionId: settingId, choiceSettingValue: { value: "fake-on" } } }],
})
const kitFiles: KitFile[] = [
  { path: "Level 1/Fakebook Alpha 9.9.9.json", content: kitPolicy("Fakebook Alpha", "fakebook_setting_alpha") },
  { path: "Level 1/Fakebook Beta 9.9.9.json", content: kitPolicy("Fakebook Beta", "fakebook_setting_beta") },
]
function pack() {
  const item = convertKit(kitFiles, { id: "fakebook-os", version: "9.9.9" }).packs.find(entry => entry.level === 1)!
  return { reference: item.reference, policies: JSON.parse(JSON.stringify(item.policies)) as Json }
}

const setting = (settingId: string) => ({ settingInstance: { "@odata.type": type, settingDefinitionId: settingId, choiceSettingValue: { value: "fake-on" } } })
const listed = (id: string, name: string, settingCount: number) => ({ id, name, platforms: "windows10", technologies: "mdm", description: "tenant", settingCount })

type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response
/** A tenant with two policies. `override` answers a request first; returning undefined falls through. */
function tenantFetch(override: (url: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined> = () => undefined) {
  const calls: string[] = []
  const handler: Handler = async (url, init) => {
    calls.push(url)
    const answer = await override(url, init)
    if (answer) return answer
    if (url.includes("oauth2")) return Response.json({ access_token: "test" })
    if (url === GRAPH) return Response.json({ value: [listed(POLICY_A, "Tenant Alpha", 1), listed(POLICY_B, "Tenant Beta", 1)] })
    if (url.endsWith("/assignments")) return Response.json({ value: [] })
    if (url === `${GRAPH}/${POLICY_A}/settings`) return Response.json({ value: [setting("fakebook_setting_alpha")] })
    if (url === `${GRAPH}/${POLICY_B}/settings`) return Response.json({ value: [setting("fakebook_setting_beta")] })
    return Response.json({ value: [] })
  }
  const mock = vi.fn((url: string, init?: RequestInit) => handler(String(url), init))
  vi.stubGlobal("fetch", mock)
  return calls
}

interface Snapshot { phase: string; error: string | null; assessment: Assessment | null }
async function start(): Promise<string> {
  const item = pack()
  const { jobId } = await handleFramework({ action: "assess-start", frameworkId: "cis-benchmarks", tenantId, appId, reference: item.reference, policies: item.policies }) as { jobId: string }
  return jobId
}
async function finish(jobId: string): Promise<Snapshot> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const snapshot = await handleFramework({ action: "assess-status", jobId, tenantId, frameworkId: "cis-benchmarks", since: 0 }) as Snapshot
    if (snapshot.phase === "done" || snapshot.phase === "failed") return snapshot
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error("Job did not finish in time.")
}

let data: Map<string, string>
beforeEach(() => {
  setInternalCisBenchmarksEnabled(true)
  sleeps.splice(0)
  data = new Map<string, string>()
  setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, delete: k => { data.delete(k) } })
})
afterEach(() => { setInternalCisBenchmarksEnabled(null); vi.unstubAllGlobals() })

describe("Graph reads during a CIS assessment", () => {
  it("completes when one read is throttled (429) and another meets a transient 503, honoring Retry-After", async () => {
    let throttled = false
    let unavailable = false
    tenantFetch(url => {
      if (url === GRAPH && !throttled) { throttled = true; return new Response("{}", { status: 429, headers: { "Retry-After": "2" } }) }
      if (url === `${GRAPH}/${POLICY_B}/settings` && !unavailable) { unavailable = true; return new Response("{}", { status: 503 }) }
      return undefined
    })
    const done = await finish(await start())
    expect(done.error).toBeNull()
    expect(done.phase).toBe("done")
    expect(done.assessment?.policyCount).toBe(2)
    expect(done.assessment?.findings.map(finding => finding.status)).toEqual(["Present", "Present"])
    expect(sleeps).toEqual([2000, 1000])
    expect(loadWorkspace(tenantId, "cis-benchmarks").history).toHaveLength(1)
  })

  it("fails after a bounded number of retries when Graph stays unavailable", async () => {
    const calls = tenantFetch(url => url === GRAPH ? new Response("{}", { status: 503 }) : undefined)
    const failed = await finish(await start())
    expect(failed.phase).toBe("failed")
    expect(failed.error).toContain("Request failed (503)")
    expect(calls.filter(url => url === GRAPH)).toHaveLength(4)
  })

  it("fails instead of waiting when Graph asks for a longer pause than an assessment waits", async () => {
    const calls = tenantFetch(url => url === GRAPH ? new Response("{}", { status: 429, headers: { "Retry-After": "45" } }) : undefined)
    const failed = await finish(await start())
    expect(failed.phase).toBe("failed")
    expect(failed.error).toContain("Request failed (429)")
    expect(sleeps).toEqual([])
    expect(calls.filter(url => url === GRAPH)).toHaveLength(1)
  })

  it("stops retrying once the total wait would pass the read budget", async () => {
    const calls = tenantFetch(url => url === GRAPH ? new Response("{}", { status: 429, headers: { "Retry-After": "25" } }) : undefined)
    const failed = await finish(await start())
    expect(failed.phase).toBe("failed")
    expect(sleeps).toEqual([25_000, 25_000])
    expect(calls.filter(url => url === GRAPH)).toHaveLength(3)
  })

  it("checks access again before each retry and stops when it was revoked during the wait", async () => {
    const calls = tenantFetch(url => {
      if (url === GRAPH) { setInternalCisBenchmarksEnabled(false); return new Response("{}", { status: 503 }) }
      return undefined
    })
    const jobId = await start()
    let failed: Snapshot | null = null
    for (let attempt = 0; attempt < 400 && !failed; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
      // Access is back only for the moment of this poll, which runs without yielding.
      setInternalCisBenchmarksEnabled(true)
      const poll = handleFramework({ action: "assess-status", jobId, tenantId, frameworkId: "cis-benchmarks", since: 0 }) as Promise<Snapshot>
      setInternalCisBenchmarksEnabled(false)
      const snapshot = await poll
      if (snapshot.phase === "failed") failed = snapshot
    }
    expect(failed?.error).toContain("CIS comparisons are coming soon")
    expect(calls.filter(url => url === GRAPH)).toHaveLength(1)
  })

  it("does not repeat a POST: a failed token request is not retried", async () => {
    const calls = tenantFetch(url => url.includes("oauth2") ? new Response("{}", { status: 503 }) : undefined)
    await expect(start()).rejects.toThrow("Request failed (503)")
    expect(calls.filter(url => url.includes("oauth2"))).toHaveLength(1)
  })

  it("re-reads a policy whose settings changed during the read, then completes", async () => {
    let listReads = 0
    const calls = tenantFetch(url => {
      // The list still reports the old count; the policy itself reports the new one.
      if (url === GRAPH) { listReads += 1; return Response.json({ value: [listed(POLICY_A, "Tenant Alpha", 2), listed(POLICY_B, "Tenant Beta", 1)] }) }
      if (url === `${GRAPH}/${POLICY_A}`) return Response.json(listed(POLICY_A, "Tenant Alpha renamed", 1))
      return undefined
    })
    const done = await finish(await start())
    expect(done.phase).toBe("done")
    expect(listReads).toBe(1)
    expect(calls.filter(url => url === `${GRAPH}/${POLICY_A}`)).toHaveLength(1)
    expect(calls.filter(url => url === `${GRAPH}/${POLICY_A}/settings`)).toHaveLength(2)
    expect(done.assessment?.findings.find(finding => finding.settingId === "fakebook_setting_alpha")?.observed[0]?.policyName).toBe("Tenant Alpha renamed")
  })

  it("fails after bounded re-reads when the policy keeps changing", async () => {
    const calls = tenantFetch(url => {
      if (url === GRAPH) return Response.json({ value: [listed(POLICY_A, "Tenant Alpha", 2), listed(POLICY_B, "Tenant Beta", 1)] })
      if (url === `${GRAPH}/${POLICY_A}`) return Response.json(listed(POLICY_A, "Tenant Alpha", 2))
      return undefined
    })
    const failed = await finish(await start())
    expect(failed.phase).toBe("failed")
    expect(failed.error).toContain("Policy settings changed during the read")
    expect(calls.filter(url => url === `${GRAPH}/${POLICY_A}/settings`)).toHaveLength(3)
    expect(loadWorkspace(tenantId, "cis-benchmarks").history).toHaveLength(0)
  })
})

describe("following a running CIS assessment", () => {
  it("finds the running job of a tenant and framework, and nothing once it finished", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    tenantFetch(async url => { if (url === GRAPH) await gate; return undefined })
    const jobId = await start()
    const item = pack()
    const found = await handleFramework({ action: "assess-active", tenantId: tenantId.toUpperCase(), frameworkId: "cis-benchmarks" }) as { jobId: string; reference: string; policies: { name: string }[] }
    expect(found.jobId).toBe(jobId)
    expect(found.reference).toBe(item.reference)
    expect(found.policies.map(policy => policy.name)).toEqual((item.policies as { name: string }[]).map(policy => policy.name))
    await expect(handleFramework({ action: "assess-active", tenantId: "44444444-4444-4444-4444-444444444444", frameworkId: "cis-benchmarks" })).resolves.toEqual({ jobId: null })
    await expect(handleFramework({ action: "assess-active", tenantId, frameworkId: "microsoft" })).resolves.toEqual({ jobId: null })
    release()
    await finish(jobId)
    await expect(handleFramework({ action: "assess-active", tenantId, frameworkId: "cis-benchmarks" })).resolves.toEqual({ jobId: null })
  })

  it("admits status polls of an existing job for its own tenant without a new plan check, and nothing else", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    tenantFetch(async url => { if (url === GRAPH) await gate; return undefined })
    const jobId = await start()
    const post = (body: object, path = "/api/frameworks", method = "POST") => new Request(`http://tenuvault.internal${path}`, { method, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) })
    expect(await isAdmittedAssessStatus(post({ action: "assess-status", jobId, tenantId: tenantId.toUpperCase(), frameworkId: "cis-benchmarks" }))).toBe(true)
    expect(await isAdmittedAssessStatus(post({ action: "assess-status", jobId, tenantId: "44444444-4444-4444-4444-444444444444", frameworkId: "cis-benchmarks" }))).toBe(false)
    expect(await isAdmittedAssessStatus(post({ action: "assess-status", jobId, tenantId, frameworkId: "microsoft" }))).toBe(false)
    expect(await isAdmittedAssessStatus(post({ action: "assess-status", jobId: "no-such-job", tenantId, frameworkId: "cis-benchmarks" }))).toBe(false)
    expect(await isAdmittedAssessStatus(post({ action: "assess-start", jobId, tenantId, frameworkId: "cis-benchmarks" }))).toBe(false)
    expect(await isAdmittedAssessStatus(post({ action: "assess-status", jobId, tenantId, frameworkId: "cis-benchmarks" }, "/api/oib"))).toBe(false)
    expect(await isAdmittedAssessStatus(post({}, "/api/frameworks", "GET"))).toBe(false)
    release()
    await finish(jobId)
  })
})

describe("the newest saved assessment as current results", () => {
  it("is the assessment the last run saved, until a different pack is loaded", async () => {
    tenantFetch()
    const done = await finish(await start())
    const workspace = loadWorkspace(tenantId, "cis-benchmarks")
    expect(currentSavedAssessment(workspace)?.assessment).toEqual(done.assessment)
    await handleFramework({ action: "workspace-save", tenantId, frameworkId: "cis-benchmarks", reference: "other-os 1.0.0 Level 1", policies: workspace.policies as unknown as Json })
    expect(currentSavedAssessment(loadWorkspace(tenantId, "cis-benchmarks"))).toBeNull()
  })
})

describe("an unreadable saved workspace", () => {
  const key = `framework.workspace.${tenantId}.cis-benchmarks`

  it("cannot be loaded, and Reset (workspace-delete) leaves a working empty workspace", async () => {
    data.set(key, "{not json")
    await expect(handleFramework({ action: "workspace-load", tenantId, frameworkId: "cis-benchmarks" })).rejects.toThrow(WORKSPACE_UNREADABLE_MESSAGE)
    const reset = await handleFramework({ action: "workspace-delete", tenantId, frameworkId: "cis-benchmarks" }) as { history: unknown[]; policies: unknown[]; reference: string }
    expect(reset).toMatchObject({ history: [], policies: [], reference: "" })
    const item = pack()
    await expect(handleFramework({ action: "workspace-save", tenantId, frameworkId: "cis-benchmarks", reference: item.reference, policies: item.policies })).resolves.toMatchObject({ reference: item.reference })
    expect(loadWorkspace(tenantId, "cis-benchmarks").reference).toBe(item.reference)
  })

  it("stops a pack download before any network request", async () => {
    data.set(key, "{not json")
    const calls = tenantFetch()
    await expect(handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })).rejects.toThrow(WORKSPACE_UNREADABLE_MESSAGE)
    expect(calls).toEqual([])
  })

  it("stops an assessment before the tenant is read", async () => {
    data.set(key, "{not json")
    const calls = tenantFetch()
    await expect(start()).rejects.toThrow(WORKSPACE_UNREADABLE_MESSAGE)
    expect(calls.some(url => url.startsWith(GRAPH))).toBe(false)
  })
})
