import { expect, it } from "vitest"
import { directoryReadShape } from "../src/main/restore/directory-read-shape"
import { DirectoryReadDeferredError } from "../src/main/restore/directory-retry"

const url = (path: string) => new URL(`https://graph.microsoft.com/v1.0/${path}`)
it.each(["users/target", "groups/target", "applications/target", "directory/deletedItems/target", "users/target/manager", "roleManagement/directory/roleDefinitions/target"])("defers incomplete single-object evidence for %s", path => {
  for (const value of [{}, [], null, 1, { id: null }, { id: 4 }, { id: "target" }, { id: "target", displayName: undefined }]) {
    expect(() => directoryReadShape(value, url(`${path}?$select=id,displayName`))).toThrow(DirectoryReadDeferredError)
  }
  expect(directoryReadShape({ id: "target", displayName: null }, url(`${path}?$select=id,displayName`))).toEqual({ id: "target", displayName: null })
  // Identity comparison belongs to the existing safety checks after shape validation.
  expect(directoryReadShape({ id: "another", displayName: "Other" }, url(`${path}?$select=id,displayName`)).id).toBe("another")
})
it.each(["users", "servicePrincipals", "identity/conditionalAccess/policies", "roleManagement/directory/roleAssignments", "oauth2PermissionGrants"])("defers malformed collection evidence for %s", path => {
  for (const value of [{}, { value: null }, { value: {} }, { value: [null] }, { value: [[]] }, { value: [], "@odata.nextLink": 4 }]) expect(() => directoryReadShape(value, url(path))).toThrow(DirectoryReadDeferredError)
  expect(directoryReadShape({ value: [] }, url(path))).toEqual({ value: [] })
})
it.each(["groups/target/members", "groups/target/owners", "groups/target/memberOf", "applications/target/owners", "groups/target/members/$ref", "servicePrincipals/target/appRoleAssignments"])("requires object IDs in relationship evidence for %s", path => {
  for (const value of [{}, { value: [{}] }, { value: [{ id: null }] }, { value: ["target"] }]) expect(() => directoryReadShape(value, url(path))).toThrow(DirectoryReadDeferredError)
  expect(directoryReadShape({ value: [{ id: "target" }] }, url(path))).toEqual({ value: [{ id: "target" }] })
})
