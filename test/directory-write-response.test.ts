import { expect, it } from "vitest"
import { directoryWriteAuthorization, directoryWriteResponse } from "../src/main/restore/directory-write-response"
import { DirectoryAuthenticationDeferredError, DirectoryReadDeferredError, DirectoryRoleDeferredError } from "../src/main/restore/directory-retry"
import { graphGroup, graphUser } from "./fixtures/directory-graph-v1"

const url = (path: string) => new URL(`https://graph.microsoft.com/v1.0/${path}`)
it.each(["users", "groups", "applications"])("acknowledges only an empty 204 for %s PATCH", async path => {
  await expect(directoryWriteResponse(new Response(null, { status: 204 }), "PATCH", url(`${path}/${graphUser.id}`))).resolves.toEqual({})
  for (const status of [200, 201, 202, 203, 206]) for (const body of ["", "<html>Sign in</html>", "{}", JSON.stringify({ id: graphUser.id })]) await expect(directoryWriteResponse(new Response(body, { status }), "PATCH", url(`${path}/${graphUser.id}`))).rejects.toThrow("read back")
})
it.each(["POST", "DELETE"])("acknowledges only an empty 204 for group $ref %s", async method => {
  for (const relation of ["members", "owners"]) {
    const path = url(`groups/${graphGroup.id}/${relation}/${method === "DELETE" ? graphUser.id + "/" : ""}$ref`)
    await expect(directoryWriteResponse(new Response(null, { status: 204 }), method, path)).resolves.toEqual({})
    await expect(directoryWriteResponse(Response.json({ id: graphGroup.id }), method, path)).rejects.toThrow("read back")
  }
})
it.each(["users", "groups"])("requires a 201 typed %s creation object with a GUID", async path => {
  const body = path === "users" ? { ...graphUser, userPrincipalName: "sample@example.com", accountEnabled: false } : { ...graphGroup, mailNickname: "sample" }
  await expect(directoryWriteResponse(Response.json(body, { status: 201 }), "POST", url(path), body)).resolves.toEqual(body)
  for (const bad of [{}, null, [], { id: graphUser.id }, { ...body, id: "opaque" }, { ...body, "@odata.type": "#microsoft.graph.application" }, path === "users" ? graphGroup : { ...graphUser, userPrincipalName: "sample@example.com" }]) await expect(directoryWriteResponse(Response.json(bad, { status: 201 }), "POST", url(path), body)).rejects.toThrow("read back")
  for (const response of [Response.json(body), new Response(null, { status: 204 }), new Response("<html>Sign in</html>", { status: 201 }), new Response("{", { status: 201, headers: { "Content-Type": "application/json" } })]) await expect(directoryWriteResponse(response, "POST", url(path), body)).rejects.toThrow("read back")
})
it("treats only structured Graph 403 errors as known unapplied role denials", async () => {
  await expect(directoryWriteAuthorization(Response.json({ error: { code: "Authorization_RequestDenied", message: "Sensitive server text" } }, { status: 403 }))).rejects.toThrow(DirectoryRoleDeferredError)
  for (const response of [new Response("<html>Denied</html>", { status: 403 }), Response.json({}, { status: 403 }), Response.json({ error: { code: "" } }, { status: 403 }), Response.json({ error: { code: "RequestDenied" } }, { status: 400 })]) await expect(directoryWriteAuthorization(response)).resolves.toBeUndefined()
})

it.each(["users", "groups"])("binds %s create responses to the approved disabled user or static security group", async path => {
  const approved = path === "users" ? { ...graphUser, userPrincipalName: "sample@example.com", accountEnabled: false } : { ...graphGroup, mailNickname: "sample" }
  const key = path === "users" ? "userPrincipalName" : "mailNickname"
  const valid = { ...approved, [key]: String(approved[key as keyof typeof approved]).toUpperCase() + " " }
  await expect(directoryWriteResponse(Response.json(valid, { status: 201 }), "POST", url(path), approved)).resolves.toEqual(valid)
  const invalid = path === "users" ? [{ userPrincipalName: "other@example.com" }, { accountEnabled: true }, { accountEnabled: undefined }, { userType: "Guest" }, { userType: undefined }] : [{ mailNickname: "other" }, { mailNickname: undefined }, { securityEnabled: false }, { mailEnabled: true }, { groupTypes: ["Unified"] }, { groupTypes: ["DynamicMembership"] }]
  for (const extra of invalid) await expect(directoryWriteResponse(Response.json({ ...approved, ...extra }, { status: 201 }), "POST", url(path), approved)).rejects.toThrow("read back")
})
it.each(["Authorization_RequestDenied", "accessDenied", "ACCESSDENIED"])("defers only authorization 403 codes: %s", async code => {
  await expect(directoryWriteAuthorization(Response.json({ error: { code } }, { status: 403 }))).rejects.toThrow(DirectoryRoleDeferredError)
})
it.each(["InvalidAuthenticationToken", "Forbidden", "Request_BadRequest", "insufficient_claims"])("leaves other 403 codes to the sanitized refusal: %s", async code => {
  await expect(directoryWriteAuthorization(Response.json({ error: { code, message: "Never retain this" } }, { status: 403 }))).resolves.toBeUndefined()
})
it("classifies structured Graph read denials and write authentication expiry as known unapplied", async () => {
  await expect(directoryWriteAuthorization(Response.json({ error: { code: "Authorization_RequestDenied" } }, { status: 403 }), true)).rejects.toThrow(DirectoryReadDeferredError)
  await expect(directoryWriteAuthorization(Response.json({ error: { code: "InvalidAuthenticationToken" } }, { status: 401 }))).rejects.toThrow(DirectoryAuthenticationDeferredError)
  await expect(directoryWriteAuthorization(new Response("<html>Sign in</html>", { status: 401 }))).resolves.toBeUndefined()
})
