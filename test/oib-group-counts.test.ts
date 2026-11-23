import { describe, expect, it, vi } from "vitest"
import { createGroupCounter } from "../src/main/oib/group-counts"
import { graphCaller, type GraphCall } from "../src/portal/lib/policies/graph-restore"

const guid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const first = guid(1)
const second = guid(2)

describe("group membership counts", () => {
  it("reads plain integer counts on beta with eventual consistency", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      expect(init?.headers).toMatchObject({ ConsistencyLevel: "eventual" })
      const match = new RegExp(`^https://graph.microsoft.com/beta/groups/${first}/members/microsoft.graph.(user|device|group)/\\$count$`).exec(String(url))
      expect(match).not.toBeNull()
      return new Response({ user: " 40\n", device: "12", group: "0" }[match![1]!]!)
    })
    const read = createGroupCounter()
    await expect(read(graphCaller("token", fetch), "tenant", "app", [first])).resolves.toEqual({ [first]: { users: 40, devices: 12, groups: 0 } })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it("keeps user and device counts when Graph rejects the nested-group cast", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => {
      if (String(url).includes("microsoft.graph.group/")) return Response.json({ error: { code: "Request_UnsupportedQuery" } }, { status: 400 })
      return new Response(String(url).includes("microsoft.graph.user/") ? "7" : "0")
    })
    await expect(createGroupCounter()(graphCaller("token", fetch), "tenant", "app", [first])).resolves.toEqual({
      [first]: { users: 7, devices: 0, groups: 0 },
    })
  })

  it.each([
    ["group", 400, "BadRequest"], ["group", 401, "Unauthorized"], ["group", 403, "Forbidden"],
    ["group", 503, "ServiceUnavailable"], ["user", 400, "Request_UnsupportedQuery"], ["device", 400, "Request_UnsupportedQuery"],
  ])("omits counts when the %s cast fails with %i %s", async (type, status, code) => {
    const graph: GraphCall = async (_, path): ReturnType<GraphCall> => path.includes(`microsoft.graph.${type}/`)
      ? { status, body: { error: { code } } }
      : { status: 200, body: {}, rawBody: "7" }
    await expect(createGroupCounter()(graph, "tenant", "app", [first])).resolves.toEqual({})
  })

  it("limits concurrency across requests, deduplicates in-flight reads and expires the per-tenant and app cache", async () => {
    let active = 0
    let peak = 0
    let now = 0
    const graph = vi.fn<GraphCall>().mockImplementation(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise<void>(resolve => setImmediate(resolve))
      active--
      return { status: 200, body: {}, rawBody: "0" }
    })
    const counts = createGroupCounter(() => now)
    const request = () => counts(graph, "tenant", "app", [first, second])
    const [result, same] = await Promise.all([request(), request()])
    expect(result).toEqual(same)
    expect(peak).toBe(4)
    expect(graph).toHaveBeenCalledTimes(6)
    await request()
    expect(graph).toHaveBeenCalledTimes(6)
    await counts(graph, "another-tenant", "app", [first])
    expect(graph).toHaveBeenCalledTimes(9)
    now = 5 * 60_000
    await request()
    expect(graph).toHaveBeenCalledTimes(15)
  })

  it("isolates cached and in-flight counts for two apps in the same tenant", async () => {
    const allowed = vi.fn<GraphCall>().mockResolvedValue({ status: 200, body: {}, rawBody: "4" })
    const denied = vi.fn<GraphCall>().mockResolvedValue({ status: 403, body: {} })
    const counts = createGroupCounter()
    const good = counts(allowed, "tenant", "first-app", [first])
    const refused = counts(denied, "tenant", "second-app", [first])
    await expect(good).resolves.toEqual({ [first]: { users: 4, devices: 4, groups: 4 } })
    await expect(refused).resolves.toEqual({})
    await expect(counts(denied, "tenant", "second-app", [first])).resolves.toEqual({})
    expect(allowed).toHaveBeenCalledTimes(3)
    expect(denied).toHaveBeenCalledTimes(6)
  })

  it("omits failed, malformed and unsafe counts and caps a request at 50 IDs", async () => {
    const graph = vi.fn<GraphCall>().mockImplementation(async (_, path) => {
      if (path.includes(guid(1))) throw new Error("offline")
      if (path.includes(guid(2))) return { status: 403, body: {} }
      if (path.includes(guid(3))) return { status: 200, body: {}, rawBody: "1.5" }
      if (path.includes(guid(4))) return { status: 200, body: {}, rawBody: "9007199254740992" }
      return { status: 200, body: {}, rawBody: "0" }
    })
    const result = await createGroupCounter()(graph, "tenant", "app", Array.from({ length: 51 }, (_, i) => guid(i + 1)))
    expect(Object.keys(result)).toHaveLength(46)
    expect(result).toHaveProperty(guid(50))
    expect(result).not.toHaveProperty(guid(51))
    expect(graph).toHaveBeenCalledTimes(150)
  })
})
