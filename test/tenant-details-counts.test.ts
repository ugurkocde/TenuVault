import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "../src/portal/app/api/fetch-tenant-details/route"
import { NextRequest } from "../src/main/api/next-server-shim"
import { resolveGroups } from "../src/main/features/hygiene/inventory"
import type { FeatureDeps } from "../src/main/features/deps"
import type { InventoryItem } from "../src/main/features/hygiene/rules"
import type { GraphCall } from "../src/portal/lib/policies/graph-restore"
import type { Item } from "../src/shared/intune/registry"
import { BATCH_SIZE, clearSettingNames, MAX_CACHED_DEFINITIONS, readSettingNames } from "../src/portal/lib/drift/setting-names"

const guid = (number: number) => `aaaaaaaa-0000-0000-0000-${String(number).padStart(12, "0")}`

describe("fetch-tenant-details counts", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reads every count from $count in parallel, correct above one page, without enumerating devices", async () => {
    const counts: Record<string, number> = {
      "/v1.0/deviceManagement/deviceConfigurations": 1200,
      "/v1.0/deviceManagement/deviceCompliancePolicies": 1100,
      "/v1.0/deviceAppManagement/iosManagedAppProtections": 101,
      "/v1.0/deviceAppManagement/androidManagedAppProtections": 102,
      "/v1.0/deviceAppManagement/windowsInformationProtectionPolicies": 103,
      "/v1.0/deviceAppManagement/mdmWindowsInformationProtectionPolicies": 104,
      "/v1.0/deviceManagement/managedDevices": 2500,
      "/v1.0/users": 4321,
    }
    const urls: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "token" })
      urls.push(url)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      const parsed = new URL(url)
      if (parsed.pathname === "/v1.0/organization") {
        return Response.json({ value: [{ id: "org-1", displayName: "Contoso", verifiedDomains: [{ name: "contoso.com", isDefault: true }] }] })
      }
      if (parsed.pathname === "/beta/deviceManagement/configurationPolicies") {
        // Settings Catalog: no $count, at most 100 ids a page, @odata.count is the page size.
        if (parsed.searchParams.has("$count")) return Response.json({ error: { message: "Query option 'Count' is not allowed." } }, { status: 400 })
        const page = Number(parsed.searchParams.get("$skiptoken") ?? "0")
        const rows = page < 13 ? 100 : 0
        const next = page < 12 ? { "@odata.nextLink": `https://graph.microsoft.com/beta/deviceManagement/configurationPolicies?$select=id&$top=100&$skiptoken=${page + 1}` } : {}
        return Response.json({ "@odata.count": rows, value: Array.from({ length: rows }, () => ({ id: "p" })), ...next })
      }
      const filtered = parsed.searchParams.get("$filter")
      const count = filtered ? 2000 : counts[parsed.pathname]
      if (count === undefined) return Response.json({ error: "unexpected" }, { status: 404 })
      // One page holds a single row under $top=1; the total only exists in @odata.count.
      return Response.json({ "@odata.count": count, value: [{}], "@odata.nextLink": "next-page" })
    })
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    const response = await POST(new NextRequest("http://tenuvault.internal/api/fetch-tenant-details", {
      method: "POST",
      body: JSON.stringify({ tenantId: "tenant", appId: "app", clientSecret: "secret" }),
    }))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.statistics).toEqual({
      userCount: 4321,
      deviceCount: 2500,
      complianceRate: 80,
      policies: { deviceConfigurations: 1200, compliancePolicies: 1100, configurationPolicies: 1300, appProtectionPolicies: 410, total: 4010 },
    })
    expect(body.unavailable).toEqual([])
    expect(body).not.toHaveProperty("storageUsed")
    expect(maxInFlight).toBeGreaterThan(1)
    const graphUrls = urls.map((entry) => new URL(entry))
    const policyPages = graphUrls.filter((entry) => entry.pathname === "/beta/deviceManagement/configurationPolicies")
    expect(policyPages).toHaveLength(13)
    for (const entry of policyPages) expect(entry.searchParams.get("$select")).toBe("id")
    const countUrls = graphUrls.filter((entry) => entry.pathname !== "/v1.0/organization" && !policyPages.includes(entry))
    expect(countUrls).toHaveLength(9)
    for (const entry of countUrls) {
      expect(entry.searchParams.get("$count")).toBe("true")
      expect(entry.searchParams.get("$top")).toBe("1")
    }
    expect(graphUrls.filter((entry) => entry.pathname.endsWith("/managedDevices"))).toHaveLength(2)
  })

  it("returns the organization with unreadable counts as null, never as zeros", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "token" })
      const parsed = new URL(url)
      if (parsed.pathname === "/v1.0/organization") return Response.json({ value: [{ id: "org-1", displayName: "Contoso" }] })
      if (parsed.pathname === "/v1.0/users") return Response.json({ error: { code: "Authorization_RequestDenied" } }, { status: 403 })
      if (parsed.searchParams.get("$filter")) return Response.json({ error: { code: "BadRequest" } }, { status: 400 })
      return Response.json({ "@odata.count": 5, value: [{}] })
    })
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    const response = await POST(new NextRequest("http://tenuvault.internal/api/fetch-tenant-details", {
      method: "POST",
      body: JSON.stringify({ tenantId: "tenant", appId: "app", clientSecret: "secret" }),
    }))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.organization).toMatchObject({ id: "org-1", displayName: "Contoso" })
    expect(body.statistics).toMatchObject({ userCount: null, deviceCount: 5, complianceRate: null })
    expect(body.unavailable).toEqual(expect.arrayContaining(["users", "compliant devices"]))
  })

  it("leaves Settings Catalog policies uncounted when a next link leaves Microsoft Graph", async () => {
    const urls: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "token" })
      urls.push(url)
      const parsed = new URL(url)
      if (parsed.pathname === "/v1.0/organization") return Response.json({ value: [{ id: "org-1", displayName: "Contoso" }] })
      if (parsed.pathname === "/beta/deviceManagement/configurationPolicies") {
        return Response.json({ value: [{ id: "p" }], "@odata.nextLink": "https://example.com/beta/deviceManagement/configurationPolicies?page=2" })
      }
      return Response.json({ "@odata.count": 5, value: [{}] })
    })
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    const response = await POST(new NextRequest("http://tenuvault.internal/api/fetch-tenant-details", {
      method: "POST",
      body: JSON.stringify({ tenantId: "tenant", appId: "app", clientSecret: "secret" }),
    }))
    const body = await response.json()
    expect(body.statistics.policies).toMatchObject({ configurationPolicies: null, total: null })
    expect(body.unavailable).toEqual(["configuration policies"])
    expect(urls.some((url) => url.startsWith("https://example.com"))).toBe(false)
  })

  it("fails when the organization cannot be read", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "token" })
      if (new URL(url).pathname === "/v1.0/organization") return Response.json({ error: {} }, { status: 503 })
      return Response.json({ "@odata.count": 5, value: [{}] })
    })
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    const response = await POST(new NextRequest("http://tenuvault.internal/api/fetch-tenant-details", {
      method: "POST",
      body: JSON.stringify({ tenantId: "tenant", appId: "app", clientSecret: "secret" }),
    }))
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body).not.toHaveProperty("statistics")
  })
})

describe("hygiene group resolution", () => {
  const items = (ids: string[]): InventoryItem[] => [
    { folder: "ConfigurationPolicies", id: "p1", name: "Policy", snapshot: { id: "p1", assignments: ids.map((groupId) => ({ target: { groupId } })) } },
  ]
  const deps = (graph: GraphCall): FeatureDeps => ({ graph: async () => graph }) as unknown as FeatureDeps

  it("resolves groups with bounded concurrency and the same results as sequential reads", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => guid(index + 1))
    let inFlight = 0
    let maxInFlight = 0
    const graph: GraphCall = async (_method, path) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      const id = decodeURIComponent(path.slice("groups/".length, path.indexOf("?")))
      const number = Number(id.slice(-12))
      return { status: number % 3 === 0 ? 500 : number % 2 === 0 ? 404 : 200, body: {} }
    }
    const result = await resolveGroups(deps(graph), "tenant", items(ids))
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(6)
    expect(result.state).toBe("partial")
    for (const [index, id] of ids.entries()) {
      const number = index + 1
      if (number % 3 === 0) expect(result.groups.has(id)).toBe(false)
      else expect(result.groups.get(id)).toBe(number % 2 === 0 ? "missing" : "exists")
    }
  })

  it("stops starting new group reads after a 403 and leaves every group unknown", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => guid(index + 1))
    let calls = 0
    const graph: GraphCall = async (_method, path) => {
      calls++
      if (path.includes(guid(1))) return { status: 403, body: {} }
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { status: 200, body: {} }
    }
    const result = await resolveGroups(deps(graph), "tenant", items(ids))
    expect(result.state).toBe("unavailable")
    expect(result.groups.size).toBe(0)
    expect(calls).toBeLessThan(ids.length)
    expect(calls).toBeLessThanOrEqual(6)
  })
})

/** A Graph fake that answers $batch in the real response shape and records request sizes. */
function batchGraph(failIds: Set<string> = new Set()) {
  const sizes: number[] = []
  const graph: GraphCall = async (method, path, body) => {
    expect(method).toBe("POST")
    expect(path).toBe("$batch")
    const requests = (body?.requests ?? []) as Array<{ id: string; method: string; url: string }>
    sizes.push(requests.length)
    return {
      status: 200,
      body: {
        responses: requests.map((request) => {
          const id = decodeURIComponent(request.url.split("/").pop() ?? "")
          if (failIds.has(id)) return { id: request.id, status: 500, body: {} }
          if (id.startsWith("missing")) return { id: request.id, status: 404, body: {} }
          return { id: request.id, status: 200, body: { displayName: `Name ${id}`, options: [{ itemId: `${id}_1`, displayName: "On" }] } }
        }),
      } as unknown as Item,
    }
  }
  return { graph, sizes }
}

describe("readSettingNames batching and cache bound", () => {
  beforeEach(() => clearSettingNames())

  it("issues at most one $batch per 20 uncached IDs", async () => {
    const ids = Array.from({ length: 45 }, (_, index) => `setting_${index}`)
    const { graph, sizes } = batchGraph()
    const names = await readSettingNames(ids, graph)
    expect(sizes).toEqual([BATCH_SIZE, BATCH_SIZE, 5])
    expect(Object.keys(names.settings)).toHaveLength(45)
    expect(names.options).toMatchObject({ setting_0_1: "On" })
    const again = batchGraph()
    await readSettingNames(ids, again.graph)
    expect(again.sizes).toEqual([])
  })

  it("keeps successful items, skips unknown ones and stops after a per-item failure", async () => {
    const ids = Array.from({ length: 25 }, (_, index) => `setting_${index}`)
    const { graph, sizes } = batchGraph(new Set(["setting_0"]))
    const names = await readSettingNames(ids, graph)
    expect(sizes).toEqual([BATCH_SIZE])
    expect(names.settings.setting_0).toBeUndefined()
    expect(names.settings.setting_1).toBe("Name setting_1")
    expect(names.settings.setting_20).toBeUndefined()
  })

  it("evicts the oldest definitions beyond the cache bound", async () => {
    const ids = Array.from({ length: MAX_CACHED_DEFINITIONS + 5 }, (_, index) => `setting_${index}`)
    const first = batchGraph()
    await readSettingNames(ids, first.graph)
    const probe = batchGraph()
    await readSettingNames([ids[0]!], probe.graph)
    expect(probe.sizes).toEqual([1])
    const cached = batchGraph()
    await readSettingNames([ids.at(-1)!], cached.graph)
    expect(cached.sizes).toEqual([])
  })
})
