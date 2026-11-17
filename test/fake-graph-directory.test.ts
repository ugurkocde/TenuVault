import { expect, it } from "vitest"
import { directoryObjectId } from "../src/shared/intune/entra-directory"
import { fakeGraph } from "./helpers/fake-graph"

it("serves selected directory profiles, manager IDs and paged membership without populating other relationships", async () => {
  const graph = await fakeGraph({ pageSize: 2, collections: {
    users: { count: 3, object: index => ({ displayName: `Synthetic ${index}`, unexpected: "Excluded" }) },
    groups: { count: 1, members: { object: 0, count: 3 }, object: () => ({ displayName: "Synthetic group" }) },
    oauth2PermissionGrants: { count: 1, object: () => ({ scope: "Example.Read" }) },
  } })
  const read = async (path: string) => (await graph.fetch(`https://graph.microsoft.com/v1.0/${path}`)).json()
  try {
    const users = await read("users?$select=id,displayName&$expand=manager($select=id)&$top=999")
    expect(users.value).toEqual([0, 1].map(index => ({ id: graph.id(index), displayName: `Synthetic ${index}`, manager: { id: graph.id(index + 1) } })))
    expect(users["@odata.nextLink"]).toContain("%24skiptoken=2")
    const last = await (await graph.fetch(users["@odata.nextLink"])).json()
    expect(last.value).toEqual([{ id: graph.id(2), displayName: "Synthetic 2", manager: { id: graph.id(0) } }])
    const members = await read(`groups/${graph.id(0)}/members?$select=id&$top=999`)
    expect(members.value).toEqual([{ id: graph.id(0) }, { id: graph.id(1) }])
    expect((await (await graph.fetch(members["@odata.nextLink"])).json()).value).toEqual([{ id: graph.id(2) }])
    for (const property of ["owners", "settings"]) expect((await read(`groups/${graph.id(0)}/${property}?$select=id`)).value).toEqual([])
    const grants = await read("oauth2PermissionGrants?$select=id,scope")
    expect(directoryObjectId("OAuth2PermissionGrants", grants.value[0].id)).toBe(true)
    expect(grants.value[0].scope).toBe("Example.Read")
  } finally { await graph.close() }
})
