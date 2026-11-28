import { expect, it } from "vitest"
import { directoryWriteAuthorization, directoryWriteReplication, directoryWriteResponse } from "../src/main/restore/directory-write-response"
import { DirectoryAuthenticationDeferredError, DirectoryReadDeferredError, DirectoryRoleDeferredError } from "../src/main/restore/directory-retry"
import { graphGroup, graphUser, graphUserCreateResponse } from "./fixtures/directory-graph-v1"

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
  const body = path === "users" ? graphUser : graphGroup
  await expect(directoryWriteResponse(Response.json(body, { status: 201 }), "POST", url(path), body)).resolves.toEqual(body)
  for (const bad of [{}, null, [], { id: graphUser.id }, { ...body, id: "opaque" }, { ...body, "@odata.type": "#microsoft.graph.application" }, path === "users" ? graphGroup : graphUser]) await expect(directoryWriteResponse(Response.json(bad, { status: 201 }), "POST", url(path), body)).rejects.toThrow("read back")
  for (const response of [Response.json(body), new Response(null, { status: 204 }), new Response("<html>Sign in</html>", { status: 201 }), new Response("{", { status: 201, headers: { "Content-Type": "application/json" } })]) await expect(directoryWriteResponse(response, "POST", url(path), body)).rejects.toThrow("read back")
})
it("treats only structured Graph 403 errors as known unapplied role denials", async () => {
  await expect(directoryWriteAuthorization(Response.json({ error: { code: "Authorization_RequestDenied", message: "Sensitive server text" } }, { status: 403 }))).rejects.toThrow(DirectoryRoleDeferredError)
  for (const response of [new Response("<html>Denied</html>", { status: 403 }), Response.json({}, { status: 403 }), Response.json({ error: { code: "" } }, { status: 403 }), Response.json({ error: { code: "RequestDenied" } }, { status: 400 })]) await expect(directoryWriteAuthorization(response)).resolves.toBeUndefined()
})

it.each(["users", "groups"])("binds %s create responses to the approved disabled user or static security group", async path => {
  const approved = path === "users" ? { ...graphUser, userPrincipalName: "sample@example.com", accountEnabled: false } : { ...graphGroup, mailNickname: "sample" }
  const key = path === "users" ? "userPrincipalName" : "mailNickname"
  const valid = { ...(path === "users" ? graphUserCreateResponse(approved) : approved), [key]: String(approved[key as keyof typeof approved]).toUpperCase() + " " }
  await expect(directoryWriteResponse(Response.json(valid, { status: 201 }), "POST", url(path), approved)).resolves.toEqual(valid)
  const invalid = path === "users" ? [{ userPrincipalName: "other@example.com" }, { userPrincipalName: undefined }, { displayName: "Other user" }, { displayName: undefined }] : [{ displayName: "Other group" }, { description: "Other description" }, { mailNickname: "other" }, { mailNickname: undefined }, { securityEnabled: false }, { mailEnabled: true }, { groupTypes: ["Unified"] }, { groupTypes: ["DynamicMembership"] }]
  for (const extra of invalid) await expect(directoryWriteResponse(Response.json({ ...approved, ...extra }, { status: 201 }), "POST", url(path), approved)).rejects.toThrow("read back")
})
it.each(["Authorization_RequestDenied", "accessDenied", "ACCESSDENIED"])("defers only authorization 403 codes: %s", async code => {
  await expect(directoryWriteAuthorization(Response.json({ error: { code } }, { status: 403 }))).rejects.toThrow(DirectoryRoleDeferredError)
})
it.each(["InvalidAuthenticationToken", "Forbidden", "Request_BadRequest"])("leaves other 403 codes to the sanitized refusal: %s", async code => {
  await expect(directoryWriteAuthorization(Response.json({ error: { code, message: "Never retain this" } }, { status: 403 }))).resolves.toBeUndefined()
})
it("classifies structured Graph read denials and write authentication expiry as known unapplied", async () => {
  await expect(directoryWriteAuthorization(Response.json({ error: { code: "Authorization_RequestDenied" } }, { status: 403 }), true)).rejects.toThrow(DirectoryReadDeferredError)
  await expect(directoryWriteAuthorization(Response.json({ error: { code: "InvalidAuthenticationToken" } }, { status: 401 }))).rejects.toThrow(DirectoryAuthenticationDeferredError)
  await expect(directoryWriteAuthorization(new Response("<html>Sign in</html>", { status: 401 }))).resolves.toBeUndefined()
})

it.each([401, 403])("defers a structured Graph %s insufficient-claims error for interactive sign-in", async status => {
  await expect(directoryWriteAuthorization(Response.json({ error: { code: "insufficient_claims", message: "Sensitive claims body" } }, { status }))).rejects.toMatchObject({ deferralCause: "authentication", message: expect.stringContaining("Sign in again and satisfy the Conditional Access requirement") })
  const headers = { "WWW-Authenticate": 'Bearer realm="", error="insufficient_claims", claims="eyJhY2Nlc3NfdG9rZW4iOnt9fQ=="' }
  await expect(directoryWriteAuthorization(Response.json({ error: { code: "Authorization_RequestDenied" } }, { status, headers }))).rejects.toMatchObject({ deferralCause: "authentication", message: expect.stringContaining("Conditional Access") })
})
it("does not treat an incomplete claims header or an unstructured 403 as a claims deferral", async () => {
  for (const challenge of ['Bearer error="insufficient_claims"', 'Basic error="insufficient_claims", claims="encoded"', 'Bearer error="other", claims="encoded"']) await expect(directoryWriteAuthorization(Response.json({ error: { code: "Forbidden" } }, { status: 403, headers: { "WWW-Authenticate": challenge } }))).resolves.toBeUndefined()
  await expect(directoryWriteAuthorization(new Response("<html>Denied</html>", { status: 403, headers: { "WWW-Authenticate": 'Bearer error="insufficient_claims", claims="encoded"' } }))).resolves.toBeUndefined()
})

it("defers only the exact documented 400 for POST group member references", async () => {
  const error = { code: "Request_BadRequest", message: "The source resource object or one of the objects being referenced don't exist." }
  const path = `groups/${graphGroup.id}/members/$ref`
  await expect(directoryWriteReplication(Response.json({ error }, { status: 400 }), "POST", url(path))).rejects.toMatchObject({ deferralCause: "replication", message: expect.stringContaining("replicating") })
  for (const [method, target] of [["DELETE", path], ["POST", path.replace("members", "owners")], ["PATCH", `groups/${graphGroup.id}`], ["POST", "users"]]) await expect(directoryWriteReplication(Response.json({ error }, { status: 400 }), method!, url(target!))).resolves.toBeUndefined()
  for (const other of [{ ...error, code: "Request_ResourceNotFound" }, { ...error, message: "Already a member" }, { ...error, message: undefined }]) await expect(directoryWriteReplication(Response.json({ error: other }, { status: 400 }), "POST", url(path))).resolves.toBeUndefined()
  for (const response of [Response.json({ error }, { status: 404 }), new Response(JSON.stringify({ error }), { status: 400 }), new Response("{", { status: 400, headers: { "Content-Type": "application/json" } })]) await expect(directoryWriteReplication(response, "POST", url(path))).resolves.toBeUndefined()
})

it.each(["", "not JSON", "<html>Sign in</html>"])("defers a header-only Graph 401 claims challenge with body %s", async body => {
  const headers = { "WWW-Authenticate": 'Bearer claims="sensitive-claims", error="insufficient_claims", realm=""' }
  await expect(directoryWriteAuthorization(new Response(body, { status: 401, headers }))).rejects.toMatchObject({ deferralCause: "authentication", message: expect.stringContaining("Sign in again and satisfy the Conditional Access requirement") })
  await expect(directoryWriteAuthorization(new Response(body, { status: 401, headers }), true)).rejects.toMatchObject({ deferralCause: "authentication" })
})

it("binds claims parameters to the same Bearer challenge in combined authentication headers", async () => {
  for (const challenge of ['Basic realm="proxy", Bearer claims="encoded", error="insufficient_claims"', 'Bearer realm="a,b", error="insufficient_claims", claims="encoded", Basic realm="proxy"']) await expect(directoryWriteAuthorization(new Response(null, { status: 401, headers: { "WWW-Authenticate": challenge } }))).rejects.toMatchObject({ deferralCause: "authentication" })
  for (const challenge of ['Basic error="insufficient_claims", Bearer claims="encoded"', 'Bearer error="insufficient_claims", Basic claims="encoded"', 'Bearer error="insufficient_claims", claims=" "']) await expect(directoryWriteAuthorization(new Response(null, { status: 401, headers: { "WWW-Authenticate": challenge } }))).resolves.toBeUndefined()
})

it.each([401, 403])("classifies a structured %s insufficient-claims read before generic read denials", async status => {
  await expect(directoryWriteAuthorization(Response.json({ error: { code: "insufficient_claims", message: "Sensitive claims body" } }, { status }), true)).rejects.toMatchObject({ deferralCause: "authentication", message: expect.stringContaining("Sign in again") })
  const headers = { "WWW-Authenticate": 'Bearer realm="", error="insufficient_claims", claims="eyJhY2Nlc3NfdG9rZW4iOnt9fQ=="' }
  await expect(directoryWriteAuthorization(Response.json({ error: { code: "Authorization_RequestDenied" } }, { status, headers }), true)).rejects.toMatchObject({ deferralCause: "authentication" })
  await expect(directoryWriteAuthorization(Response.json({ error: { code: "Authorization_RequestDenied" } }, { status }), true)).rejects.toThrow(DirectoryReadDeferredError)
})

it("defers a header-only 403 claims challenge on reads and leaves writes to the structured-body rule", async () => {
  const headers = { "WWW-Authenticate": 'Bearer realm="", error="insufficient_claims", claims="eyJhY2Nlc3NfdG9rZW4iOnt9fQ=="' }
  await expect(directoryWriteAuthorization(new Response("", { status: 403, headers }), true)).rejects.toMatchObject({ deferralCause: "authentication" })
  await expect(directoryWriteAuthorization(new Response("<html>Denied</html>", { status: 403, headers }))).resolves.toBeUndefined()
})
