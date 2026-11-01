import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { validateCisCatalog, validateCisPack } from "../src/shared/frameworks/cis-content"
import { assessPolicySet, handleFramework, setCisEntitlementProvider, setInternalCisBenchmarksEnabled } from "../src/main/frameworks/service"
import { parsePolicies } from "../src/shared/frameworks/policies"
import { cisContentBaseUrl, setCisContentEnvOverrideAllowed, setCisContentFallbackBaseUrl } from "../src/main/frameworks/cis-content"
import { loadWorkspace, saveWorkspace, setFrameworkStore } from "../src/main/frameworks/workspaces"
import { kitLevelForPolicy } from "../src/shared/frameworks/cis-flow"
import { applicableRecommendationList, levelCheckSummary, readinessFor } from "../src/shared/frameworks/cis-readiness"
import { cisReadinessTrend } from "../src/shared/frameworks/cis-trend"

/** The delivery service answer for a Level without a published recommendation list. */
const noList = () => Response.json({ ok: false, error: "The requested CIS benchmark content is not published." }, { status: 404 })

const tenantId = "11111111-1111-1111-1111-111111111111"
const type = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const policy = (value = "enabled") => ({ name: "Fakebook baseline", platforms: "windows10", technologies: "mdm", description: "Synthetic profile",
  settings: [{ settingInstance: { "@odata.type": type, settingDefinitionId: "password", choiceSettingValue: { value, children: [{
    "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: "minlength", simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationIntegerSettingValue", value: 8 },
  }] } } }] })

const validCatalog = { benchmarks: [{ id: "fakebook-os", name: "Fakebook OS", version: "9.9.9", levels: [1, 2] }] }
const validPack = { benchmark: "fakebook-os", version: "9.9.9", level: 1 as const, policies: [policy()] }

describe("validateCisCatalog", () => {
  it("accepts a valid catalog and sorts levels", () => {
    expect(validateCisCatalog({ benchmarks: [{ id: "fakebook-os", name: "Fakebook OS", version: "9.9.9", levels: [2, 1] }] }))
      .toEqual({ benchmarks: [{ id: "fakebook-os", name: "Fakebook OS", version: "9.9.9", levels: [1, 2] }] })
    expect(validateCisCatalog(validCatalog)).toEqual(validCatalog)
  })
  it("rejects more than 50 benchmarks", () => {
    const benchmarks = Array.from({ length: 51 }, (_, i) => ({ id: `fakebook-${i}`, name: "Fakebook OS", version: "9.9.9", levels: [1] }))
    expect(() => validateCisCatalog({ benchmarks })).toThrow("at most 50")
  })
  it("rejects a bad level", () => {
    expect(() => validateCisCatalog({ benchmarks: [{ id: "fakebook-os", name: "Fakebook OS", version: "9.9.9", levels: [3] }] })).toThrow("only 1 or 2")
    expect(() => validateCisCatalog({ benchmarks: [{ id: "fakebook-os", name: "Fakebook OS", version: "9.9.9", levels: [] }] })).toThrow("at least one")
  })
  it("rejects a bad slug, version shape and long name", () => {
    expect(() => validateCisCatalog({ benchmarks: [{ id: "Fakebook OS", name: "Fakebook OS", version: "9.9.9", levels: [1] }] })).toThrow("lowercase")
    expect(() => validateCisCatalog({ benchmarks: [{ id: "fakebook-os", name: "Fakebook OS", version: "9.9", levels: [1] }] })).toThrow("1.2.3")
    expect(() => validateCisCatalog({ benchmarks: [{ id: "fakebook-os", name: "x".repeat(201), version: "9.9.9", levels: [1] }] })).toThrow("at most 200")
  })
  it("rejects unknown fields and non-object input", () => {
    expect(() => validateCisCatalog({ benchmarks: [], extra: true })).toThrow("unknown field")
    expect(() => validateCisCatalog(null)).toThrow("JSON object")
  })
})

describe("validateCisPack", () => {
  it("accepts a valid pack matching the request", () => {
    expect(validateCisPack(validPack, { benchmark: "fakebook-os", version: "9.9.9", level: 1 })).toMatchObject({ benchmark: "fakebook-os", version: "9.9.9", level: 1 })
    expect(validateCisPack(validPack, { benchmark: "fakebook-os", version: "9.9.9", level: 1 }).policies).toHaveLength(1)
  })
  it("rejects identity mismatch", () => {
    expect(() => validateCisPack(validPack, { benchmark: "fakebook-os", version: "9.9.9", level: 2 })).toThrow("does not match")
    expect(() => validateCisPack({ ...validPack, version: "1.0.0" }, { benchmark: "fakebook-os", version: "9.9.9", level: 1 })).toThrow("does not match")
    expect(() => validateCisPack({ ...validPack, benchmark: "other-os" }, { benchmark: "fakebook-os", version: "9.9.9", level: 1 })).toThrow("does not match")
  })
  it("rejects an oversized pack list before parsing", () => {
    const policies = Array.from({ length: 65 }, () => policy())
    expect(() => validateCisPack({ ...validPack, policies }, { benchmark: "fakebook-os", version: "9.9.9", level: 1 })).toThrow("at most 64")
  })
  it("accepts an optional recommendation list and validates it strictly", () => {
    const expected = { benchmark: "fakebook-os", version: "9.9.9", level: 1 as const }
    const recommendation = { id: "7.1.1", title: "Synthetic recommendation", level: 1, settings: ["minlength"] }
    expect(validateCisPack(validPack, expected)).not.toHaveProperty("recommendations")
    expect(validateCisPack({ ...validPack, recommendations: [recommendation] }, expected).recommendations).toEqual([recommendation])
    const bad = (entry: unknown, message: string) => expect(() => validateCisPack({ ...validPack, recommendations: [entry] }, expected)).toThrow(message)
    bad({ ...recommendation, id: "7" }, "dotted numeric")
    bad({ ...recommendation, id: "7.1.a" }, "dotted numeric")
    bad({ ...recommendation, title: "x".repeat(301) }, "at most 300")
    bad({ ...recommendation, title: " " }, "non-empty")
    bad({ ...recommendation, level: 3 }, "level must be 1 or 2")
    bad({ ...recommendation, settings: [] }, "settings must list")
    bad({ ...recommendation, settings: [7] }, "settings must list")
    bad({ ...recommendation, extra: true }, "unknown field: extra")
    bad({ ...recommendation, settings: ["minlength", "password", "minlength"] }, "setting minlength is listed twice")
    expect(() => validateCisPack({ ...validPack, recommendations: [recommendation, recommendation] }, expected)).toThrow("duplicate recommendation 7.1.1")
    expect(() => validateCisPack({ ...validPack, recommendations: {} }, expected)).toThrow("must be an array")
    const many = Array.from({ length: 2001 }, (_, index) => ({ ...recommendation, id: `7.${index}.1` }))
    expect(() => validateCisPack({ ...validPack, recommendations: many }, expected)).toThrow("at most 2000")
  })
  it("rejects empty policies and bad level", () => {
    expect(() => validateCisPack({ ...validPack, policies: [] }, { benchmark: "fakebook-os", version: "9.9.9", level: 1 })).toThrow("at least one")
    expect(() => validateCisPack({ ...validPack, level: 3 }, { benchmark: "fakebook-os", version: "9.9.9", level: 1 })).toThrow("level must be 1 or 2")
  })
})

describe("CIS content delivery service", () => {
  let data: Map<string, string>
  const originalBase = process.env.TENUVAULT_CIS_CONTENT_BASE_URL
  beforeEach(() => {
    data = new Map()
    setFrameworkStore({ get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => { data.set(k, v) }, delete: (k: string) => { data.delete(k) } })
    setInternalCisBenchmarksEnabled(true)
    setCisEntitlementProvider((requestedTenant) => (requestedTenant === tenantId ? "test-entitlement" : null))
    process.env.TENUVAULT_CIS_CONTENT_BASE_URL = "https://content.example.test/"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setInternalCisBenchmarksEnabled(null)
    setCisEntitlementProvider(null)
    if (originalBase === undefined) delete process.env.TENUVAULT_CIS_CONTENT_BASE_URL
    else process.env.TENUVAULT_CIS_CONTENT_BASE_URL = originalBase
  })

  it("ignores the environment override when overrides are not allowed (packaged builds)", () => {
    setCisContentFallbackBaseUrl("https://license.example.test")
    try {
      expect(cisContentBaseUrl()).toBe("https://content.example.test")
      setCisContentEnvOverrideAllowed(false)
      // The entitlement token only ever goes to the built-in origin now.
      expect(cisContentBaseUrl()).toBe("https://license.example.test")
    } finally {
      setCisContentFallbackBaseUrl(null)
      setCisContentEnvOverrideAllowed(true)
    }
  })

  it("returns the validated catalog", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://content.example.test/cis/v1/catalog")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-entitlement")
      return Response.json(validCatalog)
    })
    vi.stubGlobal("fetch", fetchMock)
    await expect(handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })).resolves.toEqual(validCatalog)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("fails closed without an entitlement and never reaches the delivery service", async () => {
    setCisEntitlementProvider(null)
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })).rejects.toMatchObject({ status: 401, message: expect.stringContaining("entitlement") })
    await expect(handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("saves the workspace pack with the right reference on pack success", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/cis/v1/lists/")) return noList()
      expect(url).toBe("https://content.example.test/cis/v1/packs/fakebook-os/9.9.9/1")
      return Response.json(validPack)
    }))
    const result = await handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 }) as { reference: string; policyCount: number; settingCount: number }
    expect(result).toEqual({ benchmark: "fakebook-os", version: "9.9.9", level: 1, reference: "fakebook-os 9.9.9 Level 1", policyCount: 1, settingCount: 1 })
    const workspace = loadWorkspace(tenantId, "cis-benchmarks")
    expect(workspace.reference).toBe("fakebook-os 9.9.9 Level 1")
    expect(workspace.policies).toHaveLength(1)
    expect(workspace.policies[0]?.name).toBe("Fakebook baseline")
    expect(workspace.policies[0]).not.toHaveProperty("recommendations")
  })

  it("stamps the catalog display name on a pack loaded after the catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/cis/v1/lists/") ? noList() : Response.json(url.endsWith("/catalog") ? validCatalog : validPack)))
    await handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })
    await handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })
    expect(loadWorkspace(tenantId, "cis-benchmarks").policies[0]?.provenance).toEqual({ benchmark: "fakebook-os", version: "9.9.9", level: "Level 1", benchmarkName: "Fakebook OS" })
  })

  it("keeps the benchmark, version and Level of a delivered Level 2 pack, so it scores as Level 2", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/cis/v1/lists/") ? noList() : Response.json({ ...validPack, level: 2, policies: [{ ...policy(), provenance: { level: 1, benchmark: "other-os" } }] })))
    await handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 2 })
    const policies = loadWorkspace(tenantId, "cis-benchmarks").policies
    expect(policies[0]?.provenance).toMatchObject({ benchmark: "fakebook-os", version: "9.9.9", level: "Level 2" })
    const entry = { assessment: { runId: "run-1", tenantId, frameworkId: "cis-benchmarks", reference: "fakebook-os 9.9.9 Level 2", assessedAt: "2026-10-10T12:00:00.000Z", policyCount: 1, findings: [] }, policies }
    expect(readinessFor(entry, { history: [entry] })).toMatchObject({ benchmark: "fakebook-os", version: "9.9.9", levels: [{ level: 2 }] })
  })

  it("reads a numeric provenance Level", () => {
    expect(kitLevelForPolicy({ ...policy(), provenance: { level: 2 } })).toBe(2)
    expect(kitLevelForPolicy({ ...policy(), provenance: { level: 1 } })).toBe(1)
    expect(kitLevelForPolicy({ ...policy(), provenance: { level: "Level 2" } })).toBe(2)
  })

  it("keeps pack recommendations on the pack policies, unmatched ones on the first policy", async () => {
    const recommendations = [
      { id: "7.1.1", title: "Synthetic leaf recommendation", level: 1, settings: ["minlength"] },
      { id: "7.1.2", title: "Synthetic unrelated recommendation", level: 1, settings: ["not_in_pack"] },
    ]
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/cis/v1/lists/") ? noList() : Response.json({ ...validPack, recommendations })))
    await handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })
    expect(loadWorkspace(tenantId, "cis-benchmarks").policies[0]?.recommendations).toEqual(recommendations)
  })

  describe("recommendation lists", () => {
    const list = {
      benchmark: "fakebook-os", version: "9.9.9",
      items: [
        { identifier: "7.1.1", level: 1, automated: true, title: "Synthetic covered recommendation" },
        { identifier: "7.1.2", level: 1, automated: true, title: "Synthetic uncovered recommendation", description: "Synthetic description.", audit: "Synthetic audit\nsecond line.", remediation: "Synthetic remediation." },
        { identifier: "7.1.3", level: 1, automated: false, title: "Synthetic manual recommendation", impact: "Synthetic impact." },
      ],
    }
    const recommendations = [{ id: "7.1.1", title: "Synthetic covered recommendation", level: 1, settings: ["minlength"] }]
    const serve = (listResponse: () => Response) => vi.fn(async (url: string) => {
      if (url.includes("/cis/v1/lists/")) {
        expect(url).toBe("https://content.example.test/cis/v1/lists/fakebook-os/9.9.9/1")
        return listResponse()
      }
      return Response.json({ ...validPack, recommendations })
    })

    it("keeps the delivered list with the pack and lists Manual and Not assessed items with their text", async () => {
      vi.stubGlobal("fetch", serve(() => Response.json(list)))
      await handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })
      const workspace = loadWorkspace(tenantId, "cis-benchmarks")
      expect(workspace.recommendationLists).toEqual([list])
      expect(workspace).not.toHaveProperty("recommendationList")
      // The tenant holds the pack policy as it is, so the covered recommendation is assessed and passes.
      const current = parsePolicies([policy()]).map(item => ({ ...item, id: "33333333-3333-3333-3333-333333333330" }))
      const assessment = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: workspace.reference, policies: workspace.policies, current, runId: "run-1", assessedAt: "2026-10-10T12:00:00.000Z" })
      const entry = { assessment, policies: workspace.policies }
      const level1 = readinessFor(entry, { history: [entry], recommendationLists: workspace.recommendationLists }).levels[0]!
      expect(level1.manual.map(item => [item.identifier, item.state, item.hasText])).toEqual([["7.1.2", "Not assessed", true], ["7.1.3", "Manual", true]])
      expect(level1.manual[0]).toMatchObject({ title: "Synthetic uncovered recommendation", audit: "Synthetic audit\nsecond line." })
      expect(levelCheckSummary(level1)).toBe("Level 1: TenuVault checks 1 of 3 recommendations automatically. The other 2 need a manual check.")
      // Coverage counts what the sentence counts: one of the two automated recommendations.
      expect(level1).toMatchObject({ assessedAutomated: 1, denominator: 2, coverage: 0.5 })
    })

    it("drops a list from an earlier pack when the service has none for the new one", async () => {
      vi.stubGlobal("fetch", serve(() => Response.json(list)))
      await handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })
      vi.stubGlobal("fetch", serve(noList))
      await handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })
      expect(loadWorkspace(tenantId, "cis-benchmarks")).not.toHaveProperty("recommendationLists")
    })

    it("keeps one list per Level, so a saved assessment of one Level never reads another Level's list", async () => {
      const level2 = { ...list, items: [{ identifier: "8.1.1", level: 2, automated: true, title: "Synthetic Level 2 recommendation", audit: "Synthetic Level 2 audit." }] }
      vi.stubGlobal("fetch", serve(() => Response.json(list)))
      await handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })
      const level1Policies = loadWorkspace(tenantId, "cis-benchmarks").policies
      vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/cis/v1/lists/") ? Response.json(level2) : Response.json({ ...validPack, level: 2 })))
      await handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 2 })
      const workspace = loadWorkspace(tenantId, "cis-benchmarks")
      expect(workspace.recommendationLists).toEqual([list, level2])
      const entry = { assessment: assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "fakebook-os 9.9.9 Level 1", policies: level1Policies, current: parsePolicies([policy()]).map(item => ({ ...item, id: "33333333-3333-3333-3333-333333333330" })), runId: "run-1", assessedAt: "2026-10-10T12:00:00.000Z" }), policies: level1Policies }
      const summary = readinessFor(entry, { history: [entry], recommendationLists: workspace.recommendationLists })
      expect(summary.levels.map(level => level.level)).toEqual([1])
      expect(summary.levels[0]!.manual.map(item => item.identifier)).toEqual(["7.1.2", "7.1.3"])
      // The trend reads the same lists: the Level 1 run has only its own Level.
      expect(cisReadinessTrend([entry], undefined, undefined, "2026-10-16", workspace.recommendationLists)[0]!.levels.map(level => level.level)).toEqual([1])
    })

    it("keeps the twelve newest delivered lists", async () => {
      const saved = loadWorkspace(tenantId, "cis-benchmarks")
      saved.recommendationLists = Array.from({ length: 12 }, (_, index) => ({ benchmark: "other-os", version: `1.0.${index}`, items: [{ identifier: "1.1", level: 1 as const, automated: true }] }))
      saveWorkspace(saved)
      vi.stubGlobal("fetch", serve(() => Response.json(list)))
      await handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })
      const lists = loadWorkspace(tenantId, "cis-benchmarks").recommendationLists!
      expect(lists).toHaveLength(12)
      expect(lists.map(item => item.version)).toEqual([...Array.from({ length: 11 }, (_, index) => `1.0.${index + 1}`), "9.9.9"])
    })

    it("resolves each Level on its own: delivered where published, imported items elsewhere", () => {
      const pack = (level: 1 | 2) => parsePolicies([policy()]).map(item => ({ ...item, provenance: { benchmark: "fakebook-os", version: "9.9.9", level: `Level ${level}` } }))
      const imported = { benchmark: "fakebook-os", version: "9.9.9", items: [
        { identifier: "7.1.8", level: 1 as const, automated: false, title: "Synthetic imported L1" },
        { identifier: "8.1.8", level: 2 as const, automated: false, title: "Synthetic imported L2" },
      ] }
      const deliveredL1 = { benchmark: "fakebook-os", version: "9.9.9", items: [{ identifier: "7.1.1", level: 1 as const, automated: true, title: "Synthetic delivered L1" }] }
      const workspace = { recommendationList: imported, recommendationLists: [deliveredL1] }
      const ids = (policies: ReturnType<typeof pack>) => applicableRecommendationList(policies, workspace)?.items.map(item => item.identifier)
      // An assessment of both Levels: delivered for Level 1, the imported items for Level 2.
      expect(ids([...pack(1), ...pack(2)])).toEqual(["7.1.1", "8.1.8"])
      // A Level 1 assessment takes only Level 1, from the delivered list.
      expect(ids(pack(1))).toEqual(["7.1.1"])
      // A Level 2 assessment with no delivered list for its Level reads the imported list as before.
      expect(applicableRecommendationList(pack(2), workspace)).toEqual(imported)
    })

    it("leaves an imported list alone and prefers the delivered list for the Levels it covers", async () => {
      const imported = { benchmark: "fakebook-os", version: "9.9.9", items: [{ identifier: "7.1.9", level: 1 as const, automated: false, title: "Synthetic imported manual" }] }
      const saved = loadWorkspace(tenantId, "cis-benchmarks")
      saved.recommendationList = imported
      saveWorkspace(saved)
      vi.stubGlobal("fetch", serve(() => Response.json(list)))
      await handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })
      const workspace = loadWorkspace(tenantId, "cis-benchmarks")
      expect(workspace.recommendationList).toEqual(imported)
      expect(applicableRecommendationList(workspace.policies, workspace)?.items.map(item => item.identifier)).toEqual(["7.1.1", "7.1.2", "7.1.3"])
      // A pack of a Level without a delivered list reads the imported list, as before.
      expect(applicableRecommendationList(workspace.policies.map(({ recommendations: _carried, ...item }) => ({ ...item, provenance: { ...item.provenance, level: "Level 2" } })), workspace)).toEqual(imported)
    })

    it.each([
      ["another Level", () => Response.json({ ...list, items: [{ ...list.items[0], level: 2 }] })],
      ["another version", () => Response.json({ ...list, version: "9.9.8" })],
      ["an invalid list", () => Response.json({ ...list, extra: true })],
      ["a server error", () => Response.json({ error: "boom" }, { status: 500 })],
    ])("refuses %s and saves nothing", async (_label, listResponse) => {
      vi.stubGlobal("fetch", serve(listResponse))
      await expect(handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })).rejects.toBeInstanceOf(Error)
      expect(loadWorkspace(tenantId, "cis-benchmarks").policies).toHaveLength(0)
    })
  })

  it("errors when the base URL is not configured and saves nothing", async () => {
    delete process.env.TENUVAULT_CIS_CONTENT_BASE_URL
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })).rejects.toMatchObject({ message: expect.stringContaining("not configured") })
    await expect(handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })).rejects.toMatchObject({ message: expect.stringContaining("not configured") })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(loadWorkspace(tenantId, "cis-benchmarks").policies).toEqual([])
  })

  it("errors on HTTP 500 and saves nothing", async () => {
    const before = loadWorkspace(tenantId, "cis-benchmarks")
    before.reference = "previous"
    const { saveWorkspace } = await import("../src/main/frameworks/workspaces")
    saveWorkspace(before)
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "boom" }, { status: 500 })))
    await expect(handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })).rejects.toMatchObject({ message: expect.stringContaining("500") })
    const after = loadWorkspace(tenantId, "cis-benchmarks")
    expect(after.reference).toBe("previous")
    expect(after.policies).toEqual([])
  })

  it("errors on schema failure and saves nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ benchmarks: [{ id: "Bad Slug", name: "Fakebook OS", version: "9.9.9", levels: [1] }] })))
    await expect(handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })).rejects.toThrow("lowercase")
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ benchmark: "fakebook-os", version: "9.9.9", level: 2, policies: [policy()] })))
    await expect(handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })).rejects.toThrow("does not match")
    expect(loadWorkspace(tenantId, "cis-benchmarks").policies).toEqual([])
  })

  it("errors on invalid JSON and saves nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } })))
    await expect(handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })).rejects.toThrow("invalid response")
    expect(loadWorkspace(tenantId, "cis-benchmarks").policies).toEqual([])
  })

  it("rejects traversal benchmark, version and level inputs before any fetch", async () => {
    const fetchMock = vi.fn(async () => Response.json(validPack))
    vi.stubGlobal("fetch", fetchMock)
    const badInputs: Record<string, unknown>[] = [
      { benchmark: "..", version: "9.9.9", level: 1 },
      { benchmark: ".", version: "9.9.9", level: 1 },
      { benchmark: "../fakebook-os", version: "9.9.9", level: 1 },
      { benchmark: "fakebook-os/../other", version: "9.9.9", level: 1 },
      { benchmark: "fakebook/os", version: "9.9.9", level: 1 },
      { benchmark: "fakebook-os", version: "..", level: 1 },
      { benchmark: "fakebook-os", version: "../9.9.9", level: 1 },
      { benchmark: "fakebook-os", version: "9.9.9/..", level: 1 },
      { benchmark: "fakebook-os", version: "9.9", level: 1 },
      { benchmark: "fakebook-os", version: "9.9.9", level: 3 },
      { benchmark: "fakebook-os", version: "9.9.9", level: "1" },
    ]
    for (const input of badInputs) {
      await expect(handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", ...input })).rejects.toThrow("Select a benchmark, version and level.")
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(loadWorkspace(tenantId, "cis-benchmarks").policies).toEqual([])
  })

  it("rejects a redirect response instead of following it", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 302, headers: { Location: "https://evil.example.test/cis/v1/catalog" } }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })).rejects.toThrow("302")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" })
  })

  it("rejects an oversized Content-Length before reading the body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(validCatalog, { headers: { "Content-Length": "1000001" } })))
    await expect(handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })).rejects.toThrow("exceeds")
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(validPack, { headers: { "Content-Length": "8000001" } })))
    await expect(handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 })).rejects.toThrow("exceeds")
    expect(loadWorkspace(tenantId, "cis-benchmarks").policies).toEqual([])
  })

  it("rejects an oversized streamed body even without a large Content-Length", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(1_000_001), { status: 200, headers: { "Content-Type": "application/json", "Content-Length": "10" } })))
    await expect(handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })).rejects.toThrow("exceeds")
  })

  it("reports a timeout as a reachability problem, not an invalid response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }) }))
    await expect(handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })).rejects.toThrow("could not be reached")
    const failingBody = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(Object.assign(new Error("timed out"), { name: "TimeoutError" })) } })
    vi.stubGlobal("fetch", vi.fn(async () => new Response(failingBody, { status: 200, headers: { "Content-Type": "application/json" } })))
    await expect(handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })).rejects.toThrow("could not be reached")
  })

  it("rejects malformed base URLs before any fetch", async () => {
    const fetchMock = vi.fn(async () => Response.json(validCatalog))
    vi.stubGlobal("fetch", fetchMock)
    const badUrls = [
      "https://user:secret@content.example.test/",
      "https://content.example.test/?token=abc",
      "https://content.example.test/#section",
      "http://content.example.test/",
      "not a url",
    ]
    for (const badUrl of badUrls) {
      process.env.TENUVAULT_CIS_CONTENT_BASE_URL = badUrl
      await expect(handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })).rejects.toThrow("base URL is invalid")
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("accepts plain http for localhost in local development", async () => {
    process.env.TENUVAULT_CIS_CONTENT_BASE_URL = "http://localhost:4317/"
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://localhost:4317/cis/v1/catalog")
      return Response.json(validCatalog)
    })
    vi.stubGlobal("fetch", fetchMock)
    await expect(handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })).resolves.toEqual(validCatalog)
    process.env.TENUVAULT_CIS_CONTENT_BASE_URL = "http://127.0.0.1:4317"
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:4317/cis/v1/catalog")
      return Response.json(validCatalog)
    }))
    await expect(handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })).resolves.toEqual(validCatalog)
  })
})
