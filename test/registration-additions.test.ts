import { expect, it, vi } from "vitest"
import { AddPermissionsFlow } from "../src/main/auth/add-permissions-flow"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
import { ConnectionCapabilities, READ_ONLY } from "../src/main/auth/connection-capabilities"
import { GRAPH_CLI_CLIENT_ID, type TenantConnection } from "../src/shared/tenant-connection"
import { RegistrationAdditions, sameAdditionConnection } from "../src/main/auth/registration-additions"
import { additionConnection, additionGraph } from "./fixtures/registration-additions"

async function prepare(fake = additionGraph(), additions = ["Policy.Read.All", "Group.Read.All"]) {
  return { ...fake, run: await RegistrationAdditions.prepare({ fetch: fake.request, token: "ephemeral", connection: additionConnection, additions, sleep: async () => {} }) }
}
it("previews the exact client, declares once and PATCHes consent in place without granting pending scopes", async () => {
  const fake = additionGraph()
  fake.state.app.requiredResourceAccess[1]!.resourceAccess.push({ id: "POLICY-ID", type: "Scope" })
  const before = structuredClone(fake.state)
  const { run } = await prepare(fake)
  expect(fake.writes).toEqual([])
  expect(run.preview.declare).toEqual(["Group.Read.All"])
  expect(run.preview.consent).toEqual(["Policy.Read.All", "Group.Read.All"])
  const result = await run.apply()
  expect(result).toMatchObject({ state: "complete", declared: ["Group.Read.All"], consented: ["Policy.Read.All", "Group.Read.All"], missingConsent: [], missingDeclarations: [] })
  expect(fake.writes.map(w => w.method)).toEqual(["PATCH", "PATCH"])
  expect(fake.state.app.requiredResourceAccess[0]).toEqual(before.app.requiredResourceAccess[0])
  expect(fake.state.app.requiredResourceAccess[1]!.resourceAccess).toEqual([...before.app.requiredResourceAccess[1]!.resourceAccess, { id: "group-id", type: "Scope" }])
  expect(fake.state.grants[0]!.scope).toBe("User.Read Unknown.Read Policy.Read.All Group.Read.All")
  expect(fake.state.grants[1]).toEqual(before.grants[1])
  expect(fake.state.grants[0]!.scope).not.toContain("pending")
  const urls = vi.mocked(fake.request).mock.calls.map(c => String(c[0]))
  expect(urls[0]).toContain(`/applications(appId='${additionConnection.clientId}')?$select=`)
  expect(urls.some(url => url.includes("displayName eq"))).toBe(false)
  await expect(run.apply()).rejects.toThrow("already used")
})
it.each(["declarations", "consent", "identity"])("stops when %s changed since preview and shows the new state", async kind => {
  const { state, run, writes } = await prepare()
  if (kind === "declarations") state.app.requiredResourceAccess[0]!.resourceAccess.push({ id: "unexpected", type: "Scope" })
  if (kind === "consent") state.grants[0]!.scope = "Changed.Read"
  if (kind === "identity") state.app.displayName = "Renamed"
  const result = await run.apply()
  expect(result.state).toBe("changed")
  expect(result.preview.consented).toEqual(state.grants[0]!.scope.split(" "))
  expect(writes).toEqual([])
})
it.each(["audience", "redirect", "web", "spa", "secret", "certificate", "principalSecret", "federated", "consent", "individual", "duplicates", "disabled", "scopeUnavailable"])("refuses %s before a write", async refusal => {
  const fake = additionGraph()
  if (refusal === "audience") fake.state.app.signInAudience = "AzureADMultipleOrgs"
  if (refusal === "redirect") fake.state.app.publicClient.redirectUris.push("https://remote.test")
  if (refusal === "web") fake.state.app.web.redirectUris.push("http://localhost")
  if (refusal === "spa") fake.state.app.spa.redirectUris.push("http://localhost")
  if (refusal === "secret") fake.state.app.passwordCredentials.push({})
  if (refusal === "certificate") fake.state.app.keyCredentials.push({})
  if (refusal === "principalSecret") fake.state.client.passwordCredentials.push({})
  if (refusal === "federated") fake.state.federated.push({ id: "credential" })
  if (refusal === "consent") fake.state.grants[0]!.scope = "Other.Read"
  if (refusal === "individual") fake.state.grants[0]!.consentType = "Principal"
  if (refusal === "duplicates") fake.state.grants.push({ ...fake.state.grants[0]!, id: "duplicate" })
  if (refusal === "disabled") fake.state.client.accountEnabled = false
  if (refusal === "scopeUnavailable") fake.state.resource.publishedPermissionScopes[0]!.isEnabled = false
  await expect(prepare(fake)).rejects.toThrow()
  expect(fake.writes).toEqual([])
})
it.each(["declaration", "consent"])("reports a %s refusal as partial and preserves existing consent", async phase => {
  const fake = additionGraph()
  fake.state.failure = phase === "declaration" ? "/beta/applications/app-object" : "/beta/oauth2PermissionGrants/grant-id"
  const { run } = await prepare(fake)
  const result = await run.apply()
  expect(result.state).toBe("partial")
  expect(result.message).toContain("administrator role")
  expect(result.missingConsent).toEqual(["Policy.Read.All", "Group.Read.All"])
  expect(result.declared).toEqual(phase === "declaration" ? [] : ["Policy.Read.All", "Group.Read.All"])
  expect(fake.state.grants[0]!.scope).toBe("User.Read Unknown.Read")
  expect(fake.writes).toHaveLength(phase === "declaration" ? 1 : 2)
})
it.each(["declaration", "consent", "readAfter"])("reads back an unanswered %s write without resending it", async phase => {
  const fake = additionGraph()
  fake.state.throwAfter = phase === "declaration" ? "/beta/applications/app-object" : "/beta/oauth2PermissionGrants/grant-id"
  if (phase === "readAfter") fake.state.failure = "readAfter"
  const { run } = await prepare(fake)
  const result = await run.apply()
  expect(result.message).toContain("may have been applied")
  expect(fake.writes).toHaveLength(phase === "declaration" ? 1 : 2)
  expect(result.state).toBe("partial")
})
it("bounds delayed verification and refuses consent until declarations are visible", async () => {
  const fake = additionGraph()
  fake.state.stale = true
  const wait = vi.fn(async () => {})
  const run = await RegistrationAdditions.prepare({ fetch: fake.request, token: "ephemeral", connection: additionConnection, additions: ["Policy.Read.All"], sleep: wait })
  const result = await run.apply()
  expect(result.state).toBe("partial")
  expect(result.message).toContain("could not all be verified")
  expect(wait.mock.calls).toHaveLength(3)
  expect(fake.writes).toHaveLength(1)
})
it("verifies replication after a delay and detects a concurrent consent change before consenting", async () => {
  const fake = additionGraph()
  fake.state.stale = true
  const wait = vi.fn(async () => {
    fake.state.app.requiredResourceAccess[1]!.resourceAccess.push({ id: "policy-id", type: "Scope" })
    fake.state.grants[0]!.scope += " Concurrent.Read"
  })
  const run = await RegistrationAdditions.prepare({ fetch: fake.request, token: "ephemeral", connection: additionConnection, additions: ["Policy.Read.All"], sleep: wait })
  const result = await run.apply()
  expect(result.message).toContain("Another change happened at the same time")
  expect(fake.writes).toHaveLength(1)
})
it("writes nothing when already declared and consented", async () => {
  const fake = additionGraph()
  fake.state.app.requiredResourceAccess[1]!.resourceAccess.push({ id: "policy-id", type: "Scope" })
  fake.state.grants[0]!.scope += " Policy.Read.All"
  const { run } = await prepare(fake, ["Policy.Read.All"])
  expect((await run.apply()).state).toBe("complete")
  expect(fake.writes).toEqual([])
})
it("compares scope names without regard to case and keeps the existing grant spelling", async () => {
  const fake = additionGraph()
  fake.state.grants[0]!.scope = "user.read UNKNOWN.Read unknown.read policy.READ.all"
  const { run } = await prepare(fake)
  expect(run.preview.consent).toEqual(["Group.Read.All"])
  expect((await run.apply()).state).toBe("complete")
  expect(fake.state.grants[0]!.scope).toBe("user.read UNKNOWN.Read policy.READ.all Group.Read.All")
})
it("accepts case-only changes in consent before confirmation and in approved additions after writing", async () => {
  const fake = additionGraph()
  const { run } = await prepare(fake)
  fake.state.grants[0]!.scope = fake.state.grants[0]!.scope.toUpperCase()
  const request = vi.mocked(fake.request)
  const implementation = request.getMockImplementation()!
  request.mockImplementation(async (input, init) => {
    const answer = await implementation(input, init)
    if (init?.method === "PATCH" && String(input).includes("/oauth2PermissionGrants/")) fake.state.grants[0]!.scope = fake.state.grants[0]!.scope.toLowerCase()
    return answer
  })
  const result = await run.apply()
  expect(result).toMatchObject({ state: "complete", consented: ["Policy.Read.All", "Group.Read.All"], missingConsent: [] })
  expect(fake.writes[1]!.body).toEqual({ scope: "USER.READ UNKNOWN.READ Policy.Read.All Group.Read.All" })
})
it.each(["app.id", "app.appId", "client.id", "client.appId", "resource.id", "resource.appId", "grant.clientId", "grant.resourceId"])("accepts case-only changes to the GUID identity %s since preview", async field => {
  const fake = additionGraph()
  const clientId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  const connection = { ...additionConnection, clientId }
  Object.assign(fake.state.app, { id: "abcdefab-1111-2222-3333-444444444444", appId: clientId })
  Object.assign(fake.state.client, { id: "abcdefab-2222-3333-4444-555555555555", appId: clientId })
  fake.state.resource.id = "abcdefab-3333-4444-5555-666666666666"
  for (const grant of fake.state.grants) grant.clientId = fake.state.client.id
  fake.state.grants[0]!.resourceId = fake.state.resource.id
  const run = await RegistrationAdditions.prepare({ fetch: fake.request, token: "ephemeral", connection, additions: ["Policy.Read.All"], sleep: async () => {} })
  const [object, key] = field.split(".") as ["app" | "client" | "resource" | "grant", "id" | "appId" | "clientId" | "resourceId"]
  const target = (object === "grant" ? fake.state.grants[0]! : fake.state[object]) as unknown as Record<string, string>
  target[key] = target[key]!.toUpperCase()
  expect((await run.apply()).state).toBe("complete")
  expect(fake.writes).toHaveLength(2)
})
it.each(["displayName", "unknownIdentity", "unknownDeclaration", "grantId"])("still detects case-only changes to %s outside known GUID fields", async field => {
  const fake = additionGraph()
  Object.assign(fake.state.app, { unknownIdentity: "abcdefab-1111-2222-3333-444444444444" })
  const { run } = await prepare(fake)
  if (field === "displayName") fake.state.app.displayName = fake.state.app.displayName.toUpperCase()
  if (field === "unknownIdentity") Object.assign(fake.state.app, { unknownIdentity: "ABCDEFAB-1111-2222-3333-444444444444" })
  if (field === "unknownDeclaration") fake.state.app.requiredResourceAccess[0]!.resourceAccess[0]!.extra = "KEEP"
  if (field === "grantId") fake.state.grants[0]!.id = fake.state.grants[0]!.id.toUpperCase()
  expect((await run.apply()).state).toBe("changed")
  expect(fake.writes).toEqual([])
})
it.each([{ additions: [] }, { additions: ["Directory.ReadWrite.All"] }])("rejects an invalid permission choice $additions", async ({ additions }) => {
  await expect(prepare(additionGraph(), additions)).rejects.toThrow("Choose permissions")
})
it.each(["https://evil.test/beta/oauth2PermissionGrants", "https://graph.microsoft.com/beta/users", "https://graph.microsoft.com/beta/oauth2PermissionGrants?$skiptoken=same"])("rejects unsafe or repeated paging %s", async page => {
  const fake = additionGraph(); fake.state.badPage = page
  await expect(prepare(fake)).rejects.toThrow("paging")
  expect(fake.writes).toEqual([])
})
it("compares the account, tenant, registration, scopes and approved access without relying on renderer state", () => {
  expect(sameAdditionConnection(additionConnection, { ...additionConnection, clientId: additionConnection.clientId.toUpperCase(), allowed: [...additionConnection.allowed].reverse() })).toBe(true)
  expect(sameAdditionConnection(additionConnection, { ...additionConnection, scopes: additionConnection.scopes.map(name => name.toUpperCase()) })).toBe(true)
  for (const change of [{ homeAccountId: "different" }, { username: "other@test" }, { scopes: [] }, { allowed: [] }, { tenantId: "other" }]) expect(sameAdditionConnection(additionConnection, { ...additionConnection, ...change })).toBe(false)
})

it.each(["http://localhost", "http://localhost/", "http://localhost:54321", "http://localhost:54321/", "http://127.0.0.1", "http://127.0.0.1/", "http://127.0.0.1:54321", "http://127.0.0.1:54321/"])("accepts the local root redirect %s without requiring a portless redirect", async uri => {
  const fake = additionGraph()
  fake.state.app.publicClient.redirectUris = [uri]
  expect((await (await prepare(fake)).run.apply()).state).toBe("complete")
})
it.each(["https://localhost", "https://127.0.0.1", "http://localhost.evil.test", "http://127.0.0.2", "http://[::1]", "http://localhost/callback", "http://127.0.0.1:123/callback", "http://localhost?code=1", "http://localhost/#fragment", "http://user@localhost", "http://localhost:65536", "http://localhost:0", "http://127.1", "http://2130706433"])("refuses a redirect outside the local root contract: %s", async uri => {
  const fake = additionGraph()
  fake.state.app.publicClient.redirectUris = [uri]
  await expect(prepare(fake)).rejects.toThrow("only local redirects")
  expect(fake.writes).toEqual([])
})
const steps = ["connection", "application", "federated", "client", "resource", "grants"] as const
const interleavings = (["declaration", "consent"] as const).flatMap(phase => steps.map(step => ({ phase, step })))
it.each(interleavings)("stops the $phase write when its value changes during the $step check", async ({ phase, step }) => {
  const fake = additionGraph()
  if (phase === "consent") fake.state.app.requiredResourceAccess[1]!.resourceAccess.push({ id: "policy-id", type: "Scope" })
  const { run } = await prepare(fake, ["Policy.Read.All"])
  let injected = false
  const change = () => {
    if (injected) return
    injected = true
    if (phase === "declaration") fake.state.app.requiredResourceAccess[0]!.resourceAccess.push({ id: "concurrent", type: "Scope" })
    else fake.state.grants[0]!.scope = "User.Read Concurrent.Read"
  }
  const original = fake.request
  const request = vi.mocked(original)
  const implementation = request.getMockImplementation()!
  request.mockImplementation(async (input, init) => {
    const answer = await implementation(input, init)
    const url = new URL(String(input))
    if ((init?.method ?? "GET") === "GET") {
      const current = url.pathname.includes("federatedIdentityCredentials") ? "federated"
        : url.pathname.includes("/applications(") ? "application"
        : url.pathname.endsWith("servicePrincipals") ? (url.searchParams.get("$filter")?.includes(additionConnection.clientId) ? "client" : "resource") : "grants"
      if (current === step) change()
    }
    return answer
  })
  const result = await run.apply(async () => { if (step === "connection") change() })
  expect(injected).toBe(true)
  expect(result.state).toBe("changed")
  expect(result.message).toContain("Nothing was written")
  expect(fake.writes).toEqual([])
  if (phase === "consent") expect(result.preview.consented).toEqual(["User.Read", "Concurrent.Read"])
  else expect(result.preview.declared.some(value => value.endsWith("/concurrent"))).toBe(true)
})
it.each((["declaration", "consent"] as const).flatMap(phase => (["addition", "revocation"] as const).map(change => ({ phase, change }))))("reports a concurrent $phase $change after the last pre-write read as partial even when additions are present", async ({ phase, change }) => {
  const fake = additionGraph()
  const { run } = await prepare(fake, ["Policy.Read.All"])
  const request = vi.mocked(fake.request)
  const implementation = request.getMockImplementation()!
  request.mockImplementation(async (input, init) => {
    const answer = await implementation(input, init)
    if (init?.method === "PATCH" && String(input).includes(phase === "declaration" ? "/applications/" : "/oauth2PermissionGrants/")) {
      if (phase === "declaration") {
        if (change === "addition") fake.state.app.requiredResourceAccess[0]!.resourceAccess.push({ id: "concurrent", type: "Scope" })
        else fake.state.app.requiredResourceAccess[0]!.resourceAccess = []
      } else {
        fake.state.grants[0]!.scope = change === "addition" ? "User.Read Unknown.Read Policy.Read.All Concurrent.Read" : "User.Read Policy.Read.All"
      }
    }
    return answer
  })
  const result = await run.apply()
  expect(result.state).toBe("partial")
  expect(result.message).toContain("Another change happened at the same time")
  expect(result.message).toContain("check in Entra")
  expect(result.message).not.toContain("The approved permissions are declared and consented")
  expect(result.declared).toEqual(["Policy.Read.All"])
  expect(fake.writes).toHaveLength(phase === "declaration" ? 1 : 2)
})
it("shows the current consent and stops after declarations when consent changes during the second connection check", async () => {
  const { run, state, writes } = await prepare(additionGraph(), ["Policy.Read.All"])
  let checks = 0
  const result = await run.apply(async () => { if (++checks === 2) state.grants[0]!.scope = "User.Read Concurrent.Read" })
  expect(result.state).toBe("changed")
  expect(result.message).toContain("Declarations were written")
  expect(result.message).not.toContain("Nothing was written")
  expect(result.preview.consented).toEqual(["User.Read", "Concurrent.Read"])
  expect(result.declared).toEqual(["Policy.Read.All"])
  expect(writes).toHaveLength(1)
})
it("compares the exact grant's data without mistaking its response context for a consent change", async () => {
  const fake = additionGraph()
  const request = vi.mocked(fake.request)
  const implementation = request.getMockImplementation()!
  request.mockImplementation(async (input, init) => {
    const answer = await implementation(input, init)
    if (init?.method === "GET" && new URL(String(input)).pathname.endsWith("/oauth2PermissionGrants/grant-id")) {
      return Response.json({ ...await answer.json(), "@odata.context": "https://graph.microsoft.com/beta/$metadata#oauth2PermissionGrants/$entity" })
    }
    return answer
  })
  const { run } = await prepare(fake)
  expect((await run.apply()).state).toBe("complete")
})
it.each(["declaration", "consent"])("finishes all awaited checks before the exact %s GET and PATCH", async phase => {
  const fake = additionGraph()
  const { run } = await prepare(fake)
  const events: string[] = []
  const request = vi.mocked(fake.request)
  const implementation = request.getMockImplementation()!
  request.mockImplementation(async (input, init) => {
    events.push(`${init?.method} ${new URL(String(input)).pathname}`)
    return implementation(input, init)
  })
  expect((await run.apply(async () => { events.push("connection check") })).state).toBe("complete")
  const target = phase === "declaration" ? "/beta/applications/app-object" : "/beta/oauth2PermissionGrants/grant-id"
  const patch = events.indexOf(`PATCH ${target}`)
  expect(events[patch - 1]).toBe(`GET ${target}`)
  expect(events.slice(0, patch)).toContain("connection check")
})
it.each(["declaration", "consent"])("stops on a change returned by the final exact %s read", async phase => {
  const fake = additionGraph()
  const { run } = await prepare(fake, ["Policy.Read.All"])
  const request = vi.mocked(fake.request)
  const implementation = request.getMockImplementation()!
  let injected = false
  request.mockImplementation(async (input, init) => {
    const target = phase === "declaration" ? "/beta/applications/app-object" : "/beta/oauth2PermissionGrants/grant-id"
    if (init?.method === "GET" && new URL(String(input)).pathname === target) {
      injected = true
      if (phase === "declaration") fake.state.app.publicClient.redirectUris = ["https://remote.test"]
      else fake.state.grants[0]!.scope = "User.Read Concurrent.Read"
    }
    return implementation(input, init)
  })
  const result = await run.apply()
  expect(injected).toBe(true)
  expect(result.state).toBe("changed")
  expect(fake.writes).toHaveLength(phase === "declaration" ? 0 : 1)
})
it.each(["declaration", "consent"])("stops the permission %s write when the tenant switches during exact read-back", async phase => {
  const fake = additionGraph()
  const own: TenantConnection = { version: 1, method: "ownApp", clientId: additionConnection.clientId, origin: "wizard", createdAt: "", updatedAt: "" }
  let record = own
  const caps = new ConnectionCapabilities(() => record)
  const target = phase === "declaration" ? "/applications/app-object" : "/oauth2PermissionGrants/grant-id"
  let switched = false
  const network: typeof fetch = async (input, init) => {
    const response = await fake.request(input, init)
    if (init?.method === "GET" && new URL(String(input)).pathname.endsWith(target)) {
      record = { ...own, method: "graphCli", clientId: GRAPH_CLI_CLIENT_ID }
      switched = true
    }
    return response
  }
  const fetch = createBridgedFetch({
    dispatch: vi.fn(), getDelegatedToken: vi.fn(), fetch: network,
    authorizeRequest: (url, input, init, tenant) => caps.authorizeRequest(url, input, init, tenant),
  })
  const flow = new AddPermissionsFlow({
    fetch, connection: async () => { caps.requireWrite([additionConnection.tenantId]); return additionConnection },
    signIn: async () => "ephemeral", refresh: vi.fn(),
  })
  const preview = await flow.preview(additionConnection.tenantId, ["Policy.Read.All"])
  const result = await flow.confirm(additionConnection.tenantId, preview.id)
  expect(switched).toBe(true)
  expect(fake.writes.map(write => write.path.replace(/^\/(?:beta|v1\.0)/, ""))).toEqual(phase === "declaration" ? [] : ["/applications/app-object"])
  expect(result).toMatchObject({ state: "partial", missingConsent: ["Policy.Read.All"] })
  expect(result.message).toContain(READ_ONLY)
  expect(result.message).not.toContain("may have been applied")
})

it("preserves other APIs when introducing the first Graph declaration", async () => {
  const fake = additionGraph()
  fake.state.app.requiredResourceAccess.splice(1)
  const before = structuredClone(fake.state.app.requiredResourceAccess[0])
  const { run } = await prepare(fake)
  expect((await run.apply()).state).toBe("complete")
  expect(fake.state.app.requiredResourceAccess[0]).toEqual(before)
})
it("stops retries on a concurrent change even before all approved additions replicate", async () => {
  const fake = additionGraph()
  fake.state.stale = true
  const request = vi.mocked(fake.request)
  const implementation = request.getMockImplementation()!
  request.mockImplementation(async (input, init) => {
    const answer = await implementation(input, init)
    if (init?.method === "PATCH") fake.state.grants[0]!.scope += " Concurrent.Read"
    return answer
  })
  const sleep = vi.fn(async () => {})
  const run = await RegistrationAdditions.prepare({ fetch: fake.request, token: "ephemeral", connection: additionConnection, additions: ["Policy.Read.All"], sleep })
  expect((await run.apply()).message).toContain("Another change happened at the same time")
  expect(sleep).not.toHaveBeenCalled()
  expect(fake.writes).toHaveLength(1)
})
