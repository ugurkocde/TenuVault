import { expect, it } from "vitest"
import { graphAssignment, graphUser, graphApplication, graphServicePrincipal, graphGroup, graphUserPolicy, graphWorkloadPolicy } from "./fixtures/directory-graph-v1"
import { directoryContinuation, directoryReadAbsent, directoryReadShape } from "../src/main/restore/directory-read-shape"
import { DirectoryReadDeferredError } from "../src/main/restore/directory-retry"
import { RestoreSafetyError } from "../src/shared/intune/restore-guards"
import { graphNotFound } from "./fixtures/directory-response"

const id = "abcdef00-0000-4000-8000-000000000001", otherId = "abcdef00-0000-4000-8000-000000000002"
const url = (path: string) => new URL(`https://graph.microsoft.com/v1.0/${path}`)
it.each([`users/${id}`, `groups/${id}`, `applications/${id}`, `servicePrincipals/${id}`, `directory/deletedItems/${id}`, `users/${otherId}/manager`, `groups/${otherId}/members/${id}`, `groups/${otherId}/owners/${id}/$ref`, `roleManagement/directory/roleDefinitions/${id}`])("defers incomplete single-object evidence for %s", path => {
  for (const value of [{}, [], null, 1, { id: null }, { id: 4 }, { id: "malformed", displayName: "Name" }, { id }, { id, displayName: undefined }]) {
    expect(() => directoryReadShape(value, url(`${path}?$select=id,displayName`))).toThrow(DirectoryReadDeferredError)
  }
  expect(directoryReadShape({ id: id.toUpperCase(), displayName: null }, url(`${path}?$select=id,displayName`))).toEqual({ id: id.toUpperCase(), displayName: null })
  if (!path.endsWith("/manager")) expect(() => directoryReadShape({ id: otherId, displayName: "Other" }, url(`${path}?$select=id,displayName`))).toThrow(RestoreSafetyError)
})
it.each(["users", "servicePrincipals", "identity/conditionalAccess/policies", "roleManagement/directory/roleAssignments", "oauth2PermissionGrants"])("defers malformed collection evidence for %s", path => {
  for (const value of [{}, { value: null }, { value: {} }, { value: [null] }, { value: [[]] }, { value: [], "@odata.nextLink": 4 }]) expect(() => directoryReadShape(value, url(path))).toThrow(DirectoryReadDeferredError)
  expect(directoryReadShape({ value: [] }, url(path))).toEqual({ value: [] })
})
it.each(["groups/target/members", "groups/target/owners", "groups/target/memberOf", "applications/target/owners", "groups/target/members/$ref"])("requires GUID IDs in relationship evidence for %s", path => {
  for (const value of [{}, { value: [{}] }, { value: [{ id: null }] }, { value: [{ id: "malformed" }] }, { value: ["target"] }]) expect(() => directoryReadShape(value, url(path))).toThrow(DirectoryReadDeferredError)
  expect(directoryReadShape({ value: [{ id }] }, url(path))).toEqual({ value: [{ id }] })
})
it.each(["", null, undefined, 1, "/v1.0/groups", "http://graph.microsoft.com/v1.0/groups", "https://evil.example/v1.0/groups", "https://graph.microsoft.com/beta/groups", "https://user:password@graph.microsoft.com/v1.0/groups", "https://graph.microsoft.com/v1.0/groups#fragment"])("defers invalid present continuation %j", next => {
  expect(() => directoryReadShape({ value: [], "@odata.nextLink": next }, url("groups"))).toThrow(DirectoryReadDeferredError)
})
it("accepts an absolute continuation on the same Graph host and API version", () => {
  const page = { value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/groups?$skiptoken=opaque" }
  expect(directoryReadShape(page, url("groups"))).toEqual(page)
})
it.each([null, "group", [id, "malformed"], [null], {}])("defers malformed Conditional Access group decision fields %j", groups => {
  for (const field of ["includeGroups", "excludeGroups"]) expect(() => directoryReadShape({ value: [{ conditions: { users: { [field]: groups } } }] }, url("identity/conditionalAccess/policies"))).toThrow(DirectoryReadDeferredError)
})
it.each(["appId", "appOwnerOrganizationId"])("defers malformed service principal %s decision fields", field => {
  for (const value of [undefined, "", 42, "malformed", []]) expect(() => directoryReadShape({ value: [{ id, [field]: value }] }, url(`servicePrincipals?$select=${field}`))).toThrow(DirectoryReadDeferredError)
  for (const value of [null, otherId]) expect(directoryReadShape({ value: [{ id, [field]: value }] }, url(`servicePrincipals?$select=${field}`)).value).toEqual([{ id, [field]: value }])
})
it.each([`users/${id}`, `groups/${id}`, `applications/${id}`, `servicePrincipals/${id}`, `directory/deletedItems/${id}`, `users/${id}/manager`, `users/${id}/manager/$ref`, `groups/${id}/members/${otherId}`, `groups/${id}/owners/${otherId}/$ref`])("accepts genuine Graph absence only for optional lookup %s", async path => {
  expect(await directoryReadAbsent(graphNotFound(), url(path))).toBeNull()
  for (const response of [new Response("<html>Proxy error</html>", { status: 404, headers: { "Content-Type": "text/html" } }), Response.json({}, { status: 404 }), Response.json({ error: { code: "ResourceNotFound" } }, { status: 404 }), Response.json({ error: { code: null } }, { status: 404, headers: { "request-id": id } }), new Response("not json", { status: 404, headers: { "Content-Type": "application/json", "request-id": id } })]) await expect(directoryReadAbsent(response, url(path))).rejects.toThrow(DirectoryReadDeferredError)
})
it.each(["users", `groups/${id}/members`, "identity/conditionalAccess/policies", `roleManagement/directory/roleDefinitions/${id}`])("defers Graph 404 on required endpoint %s", async path => {
  await expect(directoryReadAbsent(graphNotFound(), url(path))).rejects.toThrow(DirectoryReadDeferredError)
})

it.each(["users", "groups", "servicePrincipals"])("accepts opaque assignment IDs and requires GUID assignment endpoints for %s", collection => {
  const path = url(`${collection}/${graphAssignment.principalId}/appRoleAssignments`)
  expect(directoryReadShape({ value: [graphAssignment] }, path).value).toEqual([graphAssignment])
  for (const id of ["", " ", null, 4]) expect(() => directoryReadShape({ value: [{ ...graphAssignment, id }] }, path)).toThrow(DirectoryReadDeferredError)
  for (const field of ["principalId", "resourceId", "appRoleId"]) expect(() => directoryReadShape({ value: [{ ...graphAssignment, [field]: "malformed" }] }, path)).toThrow(DirectoryReadDeferredError)
})
it("accepts selected object, null, manager and paging shapes observed in Graph v1.0", () => {
  for (const [collection, item] of [["users", graphUser], ["applications", graphApplication], ["servicePrincipals", graphServicePrincipal], ["groups", graphGroup]] as const) {
    expect(directoryReadShape({ value: [item] }, url(`${collection}?$select=${Object.keys(item).join(",")}`)).value).toEqual([item])
    expect(directoryReadShape(item, url(`${collection}/${item.id}?$select=${Object.keys(item).join(",")}`))).toEqual(item)
  }
  expect(directoryReadShape({ value: [graphUserPolicy] }, url("identity/conditionalAccess/policies")).value).toEqual([graphUserPolicy])
  expect(directoryReadShape({ ...graphUser, "@odata.type": "#microsoft.graph.user" }, url(`users/${otherId}/manager`)).id).toBe(graphUser.id)
  const start = "https://graph.microsoft.com/v1.0/users?$top=1&$select=id,displayName,userType"
  expect(directoryContinuation(start, start.replace("id,displayName,userType", "id%2cdisplayName%2cuserType") + "&$skiptoken=opaque", new Set())).toContain("%2c")
})
it.each([null, undefined])("accepts a validated workload-only Conditional Access policy with users %j", users => {
  const policy = { conditions: { ...graphWorkloadPolicy.conditions, users } }
  expect(directoryReadShape({ value: [policy] }, url("identity/conditionalAccess/policies")).value).toEqual([policy])
})
it.each([null, {}, [], { includeServicePrincipals: [] }, { includeServicePrincipals: [], excludeServicePrincipals: [] }, { includeServicePrincipals: ["invalid"], excludeServicePrincipals: [] }, { includeServicePrincipals: [otherId], excludeServicePrincipals: null }, { includeServicePrincipals: [otherId], excludeServicePrincipals: [], servicePrincipalFilter: {} }])("defers incomplete workload-only targeting %j", clientApplications => {
  expect(() => directoryReadShape({ value: [{ conditions: { users: null, clientApplications } }] }, url("identity/conditionalAccess/policies"))).toThrow(DirectoryReadDeferredError)
})
it.each(["All", "None", "GuestsOrExternalUsers"])("accepts the documented includeUsers keyword %s", keyword => {
  const policy = { conditions: { users: { includeUsers: [keyword], includeGroups: [], excludeGroups: [] } } }
  expect(directoryReadShape({ value: [policy] }, url("identity/conditionalAccess/policies")).value).toEqual([policy])
})
it("defers repeated or invalid directory continuations before fetching another page", () => {
  const start = "https://graph.microsoft.com/v1.0/users", seen = new Set<string>()
  expect(directoryContinuation(start, start, seen)).toBe(start)
  for (const next of [start, "bad", "https://evil.example/v1.0/users", "https://graph.microsoft.com/v1.0/groups"]) expect(() => directoryContinuation(start, next, seen)).toThrow(DirectoryReadDeferredError)
})

it.each([null, 42, "", "https://graph.microsoft.com/v1.0/$metadata#users", "https://graph.microsoft.com/v1.0/$metadata#identity/conditionalAccess/policiesOther", "https://other.example/v1.0/$metadata#identity/conditionalAccess/policies"])("defers a Conditional Access collection with a foreign or invalid context %j", context => {
  expect(() => directoryReadShape({ value: [], "@odata.context": context }, url("identity/conditionalAccess/policies"))).toThrow(DirectoryReadDeferredError)
})
it.each(["conditionalAccess/policies", "conditionalAccess/policies(id,conditions)", "identity/conditionalAccess/policies", "identity/conditionalAccess/policies(id,conditions)"])("accepts the documented Conditional Access collection context %s", context => {
  const page = { value: [graphUserPolicy], "@odata.context": `https://graph.microsoft.com/v1.0/$metadata#${context}` }
  expect(directoryReadShape(page, url("identity/conditionalAccess/policies?$select=id,conditions"))).toEqual(page)
})

it.each(["conditionalAccess/policiesOther", "conditionalAccess/policies()", "conditionalAccess/policies(id,)", "conditionalAccess/policies(id)(conditions)", "conditionalAccess/policies(id,*)", "conditionalAccess/policies/$entity", "identity/conditionalAccess/policies(,conditions)"])("rejects an invalid Conditional Access collection path or projection %s", context => {
  expect(() => directoryReadShape({ value: [], "@odata.context": `https://graph.microsoft.com/v1.0/$metadata#${context}` }, url("identity/conditionalAccess/policies"))).toThrow(DirectoryReadDeferredError)
})
it.each(["conditionalAccess/policies", "identity/conditionalAccess/policies"])("keeps version, origin and targeting checks for %s context", context => {
  for (const base of ["https://graph.microsoft.com/beta/$metadata", "https://other.example/v1.0/$metadata", "https://user@graph.microsoft.com/v1.0/$metadata", "https://graph.microsoft.com/v1.0/$metadata?query=1"]) expect(() => directoryReadShape({ value: [], "@odata.context": `${base}#${context}` }, url("identity/conditionalAccess/policies"))).toThrow(DirectoryReadDeferredError)
  expect(() => directoryReadShape({ value: [{ conditions: {} }], "@odata.context": `https://graph.microsoft.com/v1.0/$metadata#${context}` }, url("identity/conditionalAccess/policies"))).toThrow(DirectoryReadDeferredError)
})
