import { afterEach, describe, expect, it, vi } from "vitest"
import { comparePolicies, parsePolicies, remediationPayload } from "../src/shared/frameworks/policies"
import { frameworks, searchFrameworks } from "../src/shared/frameworks/catalog"
import { collectGraph, handleFramework } from "../src/main/frameworks/service"
import { setFrameworkStore } from "../src/main/frameworks/workspaces"

const type = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const policy = (value = "enabled") => ({ name: "Workstation baseline", platforms: "windows10", technologies: "mdm", description: "Approved profile",
  id: "original", assignments: [{ target: { groupId: "never-copy" } }],
  settings: [{ id: "0", settingInstance: { "@odata.type": type, settingDefinitionId: "password", choiceSettingValue: { value, children: [{
    "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: "minlength", simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationIntegerSettingValue", value: 8 },
  }] } } }] })
const tenantId = "11111111-1111-1111-1111-111111111111"
const appId = "22222222-2222-2222-2222-222222222222"
const liveId = "33333333-3333-3333-3333-333333333333"
afterEach(() => vi.unstubAllGlobals())

describe("framework catalog and policy comparison", () => {
  it("supports independent searchable frameworks, including NIST and STIG", () => {
    expect(new Set(frameworks.map(f => f.id)).size).toBe(frameworks.length)
    expect(searchFrameworks("nist").filter(f => f.publisher === "NIST")).toHaveLength(4)
    expect(searchFrameworks("stig")[0]?.id).toBe("stig")
    expect(searchFrameworks("nonexistent")).toHaveLength(0)
  })
  it("removes assignments and export metadata while retaining derived setting types", () => {
    const parsed = parsePolicies(policy())[0]!
    const payload = remediationPayload(parsed, parsed.settings, "approved revision 3")
    expect(payload).not.toHaveProperty("assignments")
    expect(payload).not.toHaveProperty("id")
    expect(payload.settings[0]).not.toHaveProperty("id")
    expect(payload.settings[0]?.settingInstance).toHaveProperty("@odata.type", type)
    expect(JSON.stringify(payload)).not.toContain("never-copy")
  })
  it("rejects unsupported policy families and malformed exports", () => {
    expect(() => parsePolicies({ displayName: "Compliance" })).toThrow("Settings Catalog")
    expect(() => parsePolicies([])).toThrow("between 1 and 200")
    const input = policy(); input.settings.push(input.settings[0]!)
    expect(() => parsePolicies(input)).toThrow("duplicate root")
  })
  it("matches content regardless of names or export metadata", () => {
    const expected = parsePolicies(policy())
    const live = parsePolicies(policy())[0]!
    const finding = comparePolicies(expected, [{ ...live, id: liveId, name: "Different name" }])[0]!
    expect(finding.status).toBe("Present")
    expect(finding.observed[0]?.policyName).toBe("Different name")
  })
  it("detects changes to nested child values and does not hide conflicting policies", () => {
    const expected = parsePolicies(policy())
    const changed = policy(); changed.settings[0]!.settingInstance.choiceSettingValue.children[0]!.simpleSettingValue.value = 10
    expect(comparePolicies(expected, [{ ...parsePolicies(changed)[0]!, id: liveId }])[0]?.status).toBe("Different")
    expect(comparePolicies(expected, [{ ...expected[0]!, id: liveId }, { ...parsePolicies(changed)[0]!, id: "another" }])[0]?.status).toBe("Different")
  })
  it("requires review of alternate pack values and identifies genuinely absent definitions", () => {
    expect(comparePolicies(parsePolicies([policy("enabled"), policy("disabled")]), []).every(f => f.status === "Review")).toBe(true)
    expect(comparePolicies(parsePolicies(policy()), [])[0]?.status).toBe("Missing")
  })
})

describe("grouped payload comparison", () => {
  const group = "#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance"
  const simple = "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance"
  const child = (id: string, value: string) => ({ "@odata.type": type, settingDefinitionId: `fakebook_payload_${id}`, choiceSettingValue: { value: `fakebook_payload_${id}_${value}`, children: [] } })
  const text = (id: string, value: string) => ({ "@odata.type": simple, settingDefinitionId: `fakebook_payload_${id}`, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationStringSettingValue", value } })
  const payload = (name: string, children: object[]) => ({ name, platforms: "macOS", technologies: "mdm,appleRemoteManagement", description: "Synthetic payload",
    settings: [{ settingInstance: { "@odata.type": group, settingDefinitionId: "fakebook_payload", groupSettingCollectionValue: [{ children }] } }] })
  const recommended = parsePolicies(payload("Synthetic Level 1", [child("one", "true"), text("two", "fake")]))
  const live = (children: object[], id = liveId) => ({ ...parsePolicies(payload("Tenant payload", children))[0]!, id })
  const status = (...tenant: ReturnType<typeof live>[]) => comparePolicies(recommended, tenant)[0]?.status

  it("is Present when the tenant root holds every recommended child plus extra children", () => {
    expect(status(live([text("extra", "kept"), child("one", "true"), text("two", "fake"), child("more", "false")]))).toBe("Present")
  })
  it("is Different when a recommended child is missing from the tenant root", () => {
    expect(status(live([child("one", "true"), text("extra", "kept")]))).toBe("Different")
  })
  it("is Different when a recommended child holds another value", () => {
    expect(status(live([child("one", "false"), text("two", "fake"), text("extra", "kept")]))).toBe("Different")
    expect(status(live([child("one", "true"), text("two", "changed")]))).toBe("Different")
  })
  it("is Different when a second tenant policy holding the root does not satisfy it", () => {
    const satisfied = live([child("one", "true"), text("two", "fake"), text("extra", "kept")])
    expect(status(satisfied, live([child("one", "true")], "44444444-4444-4444-4444-444444444444"))).toBe("Different")
    expect(status(satisfied, live([child("one", "true"), text("two", "fake")], "44444444-4444-4444-4444-444444444444"))).toBe("Present")
  })
  it("ignores extra tenant collection entries after the recommended ones and compares entries by position", () => {
    const entries = (...groups: object[][]) => ({ ...parsePolicies({ ...payload("Tenant payload", []), settings: [{ settingInstance: { "@odata.type": group, settingDefinitionId: "fakebook_payload", groupSettingCollectionValue: groups.map(children => ({ children })) } }] })[0]!, id: liveId })
    expect(status(entries([child("one", "true"), text("two", "fake")], [text("other", "second entry")]))).toBe("Present")
    expect(status(entries([text("other", "first entry")], [child("one", "true"), text("two", "fake")]))).toBe("Different")
  })
  it("compares nested simple value collections exactly, including an empty list", () => {
    const list = (values: string[]) => ({ "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingCollectionInstance", settingDefinitionId: "fakebook_payload_list",
      simpleSettingCollectionValue: values.map(value => ({ "@odata.type": "#microsoft.graph.deviceManagementConfigurationStringSettingValue", value })) })
    const withList = (values: string[]) => parsePolicies(payload("Synthetic list", [list(values), child("one", "true")]))
    const tenantWith = (values: string[]) => ({ ...parsePolicies(payload("Tenant payload", [list(values), child("one", "true"), text("extra", "kept")]))[0]!, id: liveId })
    expect(comparePolicies(withList([]), [tenantWith([])])[0]?.status).toBe("Present")
    expect(comparePolicies(withList([]), [tenantWith(["fake-a"])])[0]?.status).toBe("Different")
    expect(comparePolicies(withList(["fake-a"]), [tenantWith(["fake-a", "fake-b"])])[0]?.status).toBe("Different")
    expect(comparePolicies(withList(["fake-a", "fake-b"]), [tenantWith(["fake-a", "fake-b"])])[0]?.status).toBe("Present")
  })
  it("keeps exact matching for roots without child setting instances", () => {
    const flat = (value: string, extra?: object) => ({ name: "Flat", platforms: "windows10", technologies: "mdm", description: "",
      settings: [{ settingInstance: { "@odata.type": type, settingDefinitionId: "fakebook_flat", choiceSettingValue: { value, children: [], ...extra } } }] })
    const expected = parsePolicies(flat("fake-on"))
    expect(comparePolicies(expected, [{ ...parsePolicies(flat("fake-on"))[0]!, id: liveId }])[0]?.status).toBe("Present")
    expect(comparePolicies(expected, [{ ...parsePolicies(flat("fake-on", { extra: "value" }))[0]!, id: liveId }])[0]?.status).toBe("Different")
    expect(comparePolicies(expected, [{ ...parsePolicies(flat("fake-off"))[0]!, id: liveId }])[0]?.status).toBe("Different")
  })
  it("still asks for review when the pack holds alternative grouped payloads", () => {
    const both = parsePolicies([payload("Level 1", [child("one", "true")]), payload("Level 2", [child("one", "true"), text("two", "fake")])])
    expect(comparePolicies(both, [live([child("one", "true"), text("two", "fake")])]).map(finding => finding.status)).toEqual(["Review", "Review"])
  })
})

describe("Graph reads and tenant-bound remediation", () => {
  it.each(["cis-benchmarks", "cis-controls"])("blocks %s operations before network or workspace access", async frameworkId => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    for (const action of ["workspace-load", "workspace-save", "workspace-delete", "workspace-delete-assessment", "assess", "create"]) {
      await expect(handleFramework({ action, frameworkId, tenantId, appId, reference: "r1", policies: [policy()] }))
        .rejects.toMatchObject({ status: 403, message: expect.stringContaining("coming soon") })
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(searchFrameworks("cis").map(f => f.id)).toEqual(["cis-benchmarks", "cis-controls"])
  })
  it("blocks a disabled assessment's creation even with a different or omitted framework ID", async () => {
    const framework = frameworks.find(f => f.id === "cis-benchmarks")!
    const disabledReason = framework.disabledReason
    const fetch = vi.fn().mockImplementation(async (url: string) => url.includes("oauth2")
      ? Response.json({ access_token: "test" }) : Response.json({ value: [] }))
    vi.stubGlobal("fetch", fetch)
    try {
      // Simulate an assessment obtained before the contract gate was applied.
      delete framework.disabledReason
      const run = await handleFramework({ action: "assess", frameworkId: framework.id, tenantId, appId, reference: "r1", policies: [policy()] }) as { runId: string }
      framework.disabledReason = disabledReason
      fetch.mockClear()
      for (const frameworkId of [undefined, "custom"]) {
        await expect(handleFramework({ action: "create", ...(frameworkId ? { frameworkId } : {}), tenantId, appId, runId: run.runId, keys: ["0:0"], confirmUnassigned: true }))
          .rejects.toMatchObject({ status: 403, message: disabledReason })
      }
      expect(fetch).not.toHaveBeenCalled()
    } finally { framework.disabledReason = disabledReason }
  })
  it("follows empty pages with a continuation and retains beta", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ value: [], "@odata.nextLink": "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies?$skiptoken=next" }))
      .mockResolvedValueOnce(Response.json({ value: [{ id: liveId }] }))
    vi.stubGlobal("fetch", fetch)
    expect(await collectGraph("https://graph.microsoft.com/beta/deviceManagement/configurationPolicies", "test")).toEqual([{ id: liveId }])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it("checks authorization before following a continuation link", async () => {
    let allowed = true
    const fetch = vi.fn(async () => {
      allowed = false
      return Response.json({ value: [], "@odata.nextLink": "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies?$skiptoken=next" })
    })
    vi.stubGlobal("fetch", fetch)
    await expect(collectGraph("https://graph.microsoft.com/beta/deviceManagement/configurationPolicies", "test", () => {
      if (!allowed) throw new Error("CIS access ended")
    })).rejects.toThrow("CIS access ended")
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it("rejects continuation links that would send a token outside beta Graph", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ value: [], "@odata.nextLink": "https://example.com/leak" }))
    vi.stubGlobal("fetch", fetch)
    await expect(collectGraph("https://graph.microsoft.com/beta/deviceManagement/configurationPolicies", "test")).rejects.toThrow("continuation")
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it("fails the assessment when Graph denies access instead of inventing gaps", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ access_token: "test" })).mockResolvedValueOnce(Response.json({}, { status: 403 })))
    await expect(handleFramework({ action: "assess", tenantId, appId, frameworkId: "custom", reference: "r1", policies: [policy()] })).rejects.toThrow("permissions")
  })
  it("keeps creating the selected policies when saving the workspace fails, and reports the failure", async () => {
    const data = new Map<string, string>()
    let failSaves = false
    setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { if (failSaves) throw new Error("Workspace storage is full"); data.set(k, v) }, delete: k => { data.delete(k) } })
    let created = 0
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "test" })
      if (init?.method === "POST") return Response.json({ id: `${liveId.slice(0, -1)}${++created}` })
      return Response.json({ value: [] })
    }))
    const policies = [policy(), { ...policy(), name: "Second baseline", settings: [{ ...policy().settings[0]!, settingInstance: { ...policy().settings[0]!.settingInstance, settingDefinitionId: "second" } }] }]
    const assessment = await handleFramework({ action: "assess", tenantId, appId, frameworkId: "custom", reference: "r1", policies }) as { runId: string }
    failSaves = true
    const result = await handleFramework({ action: "create", tenantId, appId, runId: assessment.runId, keys: ["0:0", "1:0"], confirmUnassigned: true })
      .finally(() => { failSaves = false }) as { success: boolean; results: { id?: string }[]; warning?: string }
    expect(created).toBe(2)
    expect(result).toMatchObject({ success: true, results: [{ id: expect.any(String) }, { id: expect.any(String) }] })
    expect(result.warning).toContain("Workspace storage is full")
  })
  it("creates only approved missing settings, rejects cross-tenant use and replay", async () => {
    const writes: Record<string, unknown>[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "test" })
      expect(url).toContain("/beta/")
      if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return Response.json({ id: liveId }) }
      return Response.json({ value: [] })
    }))
    const assessment = await handleFramework({ action: "assess", tenantId, appId, frameworkId: "custom", reference: "r1", policies: [policy()] }) as { runId: string }
    const create = { action: "create", tenantId, appId, runId: assessment.runId, keys: ["0:0"], confirmUnassigned: true }
    await expect(handleFramework({ ...create, tenantId: liveId })).rejects.toThrow("expired")
    await expect(handleFramework({ ...create, keys: ["99:0"] })).rejects.toThrow("Only missing")
    expect(await handleFramework(create)).toMatchObject({ success: true })
    expect(writes).toHaveLength(1)
    expect(writes[0]).not.toHaveProperty("assignments")
    await expect(handleFramework(create)).rejects.toThrow("already used")
    expect(writes).toHaveLength(1)
  })
  it("refuses remediation after the live landscape changes", async () => {
    let reads = 0
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "test" })
      if (url.endsWith("/settings")) return Response.json({ value: policy().settings })
      return Response.json({ value: reads++ ? [{ ...policy(), id: liveId, settingCount: 1 }] : [] })
    })
    vi.stubGlobal("fetch", fetch)
    const run = await handleFramework({ action: "assess", tenantId, appId, frameworkId: "custom", reference: "r1", policies: [policy()] }) as { runId: string }
    await expect(handleFramework({ action: "create", tenantId, appId, runId: run.runId, keys: ["0:0"], confirmUnassigned: true })).rejects.toThrow("landscape changed")
  })
  it("reports write failure honestly and consumes the assessment after an uncertain result", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "test" })
      if (init?.method === "POST") return Response.json({}, { status: 400 })
      return Response.json({ value: [] })
    }))
    const run = await handleFramework({ action: "assess", tenantId, appId, frameworkId: "custom", reference: "r1", policies: [policy()] }) as { runId: string }
    const create = { action: "create", tenantId, appId, runId: run.runId, keys: ["0:0"], confirmUnassigned: true }
    expect(await handleFramework(create)).toMatchObject({ success: false, results: [{ error: expect.stringContaining("400") }] })
    await expect(handleFramework(create)).rejects.toThrow("already used")
  })
})
