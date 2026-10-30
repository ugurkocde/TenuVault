import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { POST } from "../src/portal/app/api/settings-catalog-check/route"
import { buildSettingsCatalog, deprecatedHits, settingDefinitionIds } from "../src/shared/intune/settings-catalog"

afterEach(() => vi.unstubAllGlobals())

describe("settings catalog helpers", () => {
  it("collects definition IDs at any nesting level, each once", () => {
    const snapshot = {
      settings: [
        { settingInstance: { settingDefinitionId: "top", choiceSettingValue: { value: "top_1", children: [{ settingDefinitionId: "child" }, { settingDefinitionId: "top" }] } } },
        { settingInstance: { settingDefinitionId: "group", groupSettingCollectionValue: [{ children: [{ settingDefinitionId: "child" }, { settingDefinitionId: "deep" }] }] } },
        { name: "no setting here" },
      ],
    }
    expect(settingDefinitionIds(snapshot)).toEqual(["top", "child", "group", "deep"])
    expect(settingDefinitionIds(undefined)).toEqual([])
    expect(settingDefinitionIds("not a snapshot")).toEqual([])
  })

  it("keeps the marked entry when the catalog lists a definition ID twice", () => {
    const catalog = buildSettingsCatalog([
      { id: "dup", displayName: "Thing" },
      { id: "dup", displayName: "Thing (deprecated)" },
      { id: "plain", displayName: "Plain" },
      { displayName: "No ID" },
    ])
    expect(catalog.size).toBe(2)
    expect(catalog.get("dup")).toMatchObject({ mark: "deprecated", displayName: "Thing (deprecated)" })
    expect(catalog.get("plain")?.mark).toBeNull()
  })

  it("reports marked and missing IDs and stays silent on current ones", () => {
    const catalog = buildSettingsCatalog([
      { id: "old", displayName: "Old Thing (obsolete)" },
      { id: "future", displayName: "Future Thing", description: "[to be deprecated] Later." },
      { id: "fine", displayName: "Fine Thing" },
      { id: "risky", displayName: "Risky Thing", description: "The file format is deprecated by its creators." },
    ])
    expect(deprecatedHits(["old", "future", "fine", "risky", "gone"], catalog)).toEqual([
      { definitionId: "old", displayName: "Old Thing (obsolete)", state: "deprecated" },
      { definitionId: "future", displayName: "Future Thing", state: "to be deprecated" },
      { definitionId: "gone", displayName: null, state: "not in catalog" },
    ])
  })
})

const CATALOG = [
  { id: "old", displayName: "Old Thing (deprecated)", description: "" },
  { id: "fine", displayName: "Fine Thing", description: "" },
]

function stubFetch(catalogStatus = 200) {
  const urls: string[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "token" })
    if (url.includes("configurationSettings")) {
      return catalogStatus === 200
        ? Response.json({ value: CATALOG })
        : Response.json({ error: { message: "Insufficient privileges" } }, { status: catalogStatus })
    }
    return Response.json({}, { status: 404 })
  }))
  return urls
}

const request = (body: Record<string, unknown>) =>
  POST(new NextRequest("http://tenuvault.internal/api/settings-catalog-check", { method: "POST", body: JSON.stringify(body) }))

const CREDS = { tenantId: "11111111-1111-1111-1111-111111111111", appId: "app", clientSecret: "secret" }

describe("/api/settings-catalog-check", () => {
  it("returns only the marked and missing IDs, with the catalog check date", async () => {
    const urls = stubFetch()
    const response = await request({ ...CREDS, definitionIds: ["old", "fine", "gone", "old"] })
    expect(response.status).toBe(200)
    const body = await response.json() as { catalog: { state: string; total: number; checkedAt: string }; settings: Record<string, unknown> }
    expect(body.catalog.state).toBe("checked")
    expect(body.catalog.total).toBe(2)
    expect(Date.parse(body.catalog.checkedAt)).toBeTypeOf("number")
    expect(body.settings).toEqual({
      old: { displayName: "Old Thing (deprecated)", state: "deprecated" },
      gone: { displayName: null, state: "not in catalog" },
    })
    const catalogUrl = urls.find((url) => url.includes("configurationSettings"))!
    expect(catalogUrl).toContain("$select=id,displayName,description")
    expect(catalogUrl).not.toContain("$top")
  })

  it("reports an unreadable catalog as unavailable with no settings, never as clean", async () => {
    stubFetch(403)
    const response = await request({ ...CREDS, definitionIds: ["old"] })
    expect(response.status).toBe(200)
    const body = await response.json() as { catalog: { state: string; reason: string }; settings: Record<string, unknown> }
    expect(body.catalog.state).toBe("unavailable")
    expect(body.catalog.reason).toContain("DeviceManagementConfiguration.Read.All")
    expect(body.settings).toEqual({})
  })

  it("rejects missing credentials and malformed ID lists without calling Graph", async () => {
    const urls = stubFetch()
    expect((await request({ definitionIds: ["old"] })).status).toBe(400)
    expect((await request({ ...CREDS, definitionIds: "old" })).status).toBe(400)
    expect((await request({ ...CREDS, definitionIds: [42] })).status).toBe(400)
    expect(urls).toEqual([])
    // No IDs is not an error: nothing to check, reported as such without a catalog read.
    const empty = await request({ ...CREDS, definitionIds: [] })
    expect(empty.status).toBe(200)
    expect((await empty.json()).catalog.state).toBe("unavailable")
    expect(urls).toEqual([])
  })
})
