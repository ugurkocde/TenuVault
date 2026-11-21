import { expect, it } from "vitest"
import { directoryWriteAuthorization, directoryWriteResponse } from "../src/main/restore/directory-write-response"
import { DirectoryRoleDeferredError } from "../src/main/restore/directory-retry"
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
  const body = path === "users" ? { ...graphUser, userPrincipalName: "sample@example.com" } : graphGroup
  await expect(directoryWriteResponse(Response.json(body, { status: 201 }), "POST", url(path))).resolves.toEqual(body)
  for (const bad of [{}, null, [], { id: graphUser.id }, { ...body, id: "opaque" }, { ...body, "@odata.type": "#microsoft.graph.application" }, path === "users" ? graphGroup : { ...graphUser, userPrincipalName: "sample@example.com" }]) await expect(directoryWriteResponse(Response.json(bad, { status: 201 }), "POST", url(path))).rejects.toThrow("read back")
  for (const response of [Response.json(body), new Response(null, { status: 204 }), new Response("<html>Sign in</html>", { status: 201 }), new Response("{", { status: 201, headers: { "Content-Type": "application/json" } })]) await expect(directoryWriteResponse(response, "POST", url(path))).rejects.toThrow("read back")
})
it("treats only structured Graph 403 errors as known unapplied role denials", async () => {
  await expect(directoryWriteAuthorization(Response.json({ error: { code: "Authorization_RequestDenied", message: "Sensitive server text" } }, { status: 403 }))).rejects.toThrow(DirectoryRoleDeferredError)
  for (const response of [new Response("<html>Denied</html>", { status: 403 }), Response.json({}, { status: 403 }), Response.json({ error: { code: "" } }, { status: 403 }), Response.json({ error: { code: "RequestDenied" } }, { status: 400 })]) await expect(directoryWriteAuthorization(response)).resolves.toBeUndefined()
})
