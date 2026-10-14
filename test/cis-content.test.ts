import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { validateCisCatalog, validateCisPack } from "../src/shared/frameworks/cis-content"
import { handleFramework, setInternalCisBenchmarksEnabled } from "../src/main/frameworks/service"
import { loadWorkspace, setFrameworkStore } from "../src/main/frameworks/workspaces"

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
    process.env.TENUVAULT_CIS_CONTENT_BASE_URL = "https://content.example.test/"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setInternalCisBenchmarksEnabled(null)
    if (originalBase === undefined) delete process.env.TENUVAULT_CIS_CONTENT_BASE_URL
    else process.env.TENUVAULT_CIS_CONTENT_BASE_URL = originalBase
  })

  it("returns the validated catalog", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://content.example.test/cis/v1/catalog")
      return Response.json(validCatalog)
    })
    vi.stubGlobal("fetch", fetchMock)
    await expect(handleFramework({ action: "cis-catalog", tenantId, frameworkId: "cis-benchmarks" })).resolves.toEqual(validCatalog)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("saves the workspace pack with the right reference on pack success", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("https://content.example.test/cis/v1/packs/fakebook-os/9.9.9/1")
      return Response.json(validPack)
    }))
    const result = await handleFramework({ action: "cis-fetch-pack", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1 }) as { reference: string; policyCount: number; settingCount: number }
    expect(result).toEqual({ benchmark: "fakebook-os", version: "9.9.9", level: 1, reference: "fakebook-os 9.9.9 Level 1", policyCount: 1, settingCount: 1 })
    const workspace = loadWorkspace(tenantId, "cis-benchmarks")
    expect(workspace.reference).toBe("fakebook-os 9.9.9 Level 1")
    expect(workspace.policies).toHaveLength(1)
    expect(workspace.policies[0]?.name).toBe("Fakebook baseline")
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
})
