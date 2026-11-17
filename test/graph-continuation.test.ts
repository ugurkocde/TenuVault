import { describe, expect, it } from "vitest"
import { graphContinuation } from "../src/shared/graph-continuation"
import { readLive, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import type { Item } from "../src/shared/intune/registry"

describe("shared continuation rule", () => {
  const start = "https://graph.microsoft.com/v1.0/groups?$filter=securityEnabled%20eq%20true"
  it("retains mandatory filters without rewriting skip tokens", () => {
    expect(graphContinuation(start, "https://graph.microsoft.com/v1.0/groups?$skiptoken=a%2Bb", new Set())).toBe("https://graph.microsoft.com/v1.0/groups?$skiptoken=a%2Bb&$filter=securityEnabled%20eq%20true")
  })
  for (const next of ["https://evil.test/v1.0/groups", "https://graph.microsoft.com/v1.0/users", "https://graph.microsoft.com/beta/groups", "https://graph.microsoft.com/v1.0/groups#fragment", "https://graph.microsoft.com/v1.0/groups?filter=other"]) it(`refuses ${next}`, () => {
    expect(() => graphContinuation(start, next, new Set())).toThrow("Invalid Graph continuation")
  })
  it("refuses repeated pages and new filters", () => {
    expect(() => graphContinuation(start, start, new Set([start]))).toThrow("repeats")
    expect(() => graphContinuation("https://graph.microsoft.com/v1.0/groups", start, new Set())).toThrow("filter")
  })
  it("applies the same rule through the restore reader before the next request", async () => {
    const calls: string[] = []
    const graph: GraphCall = async (_method, path) => { calls.push(path); return { status: 200, body: calls.length === 1 ? { id: "id", displayName: "Group" } : { value: [], "@odata.nextLink": "https://graph.microsoft.com/beta/users" } as Item } }
    const type = { folder: "Fixture", label: "Fixture", path: "groups", area: "Groups" as const, nameKey: "displayName" as const, extras: [{ property: "members", path: (id: string) => `groups/${id}/members` }] }
    await expect(readLive(graph, type, "id")).rejects.toThrow("another collection")
    expect(calls).toHaveLength(2)
  })
})
