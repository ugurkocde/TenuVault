import { expect, it, vi } from "vitest"
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
  if (refusal === "scopeUnavailable") fake.state.resource.oauth2PermissionScopes[0]!.isEnabled = false
  await expect(prepare(fake)).rejects.toThrow()
  expect(fake.writes).toEqual([])
})
it.each(["declaration", "consent"])("reports a %s refusal as partial and preserves existing consent", async phase => {
  const fake = additionGraph()
  fake.state.failure = phase === "declaration" ? "/v1.0/applications/app-object" : "/v1.0/oauth2PermissionGrants/grant-id"
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
  fake.state.throwAfter = phase === "declaration" ? "/v1.0/applications/app-object" : "/v1.0/oauth2PermissionGrants/grant-id"
  if (phase === "readAfter") fake.state.failure = "readAfter"
  const { run } = await prepare(fake)
  const result = await run.apply()
  expect(result.message).toContain("may have been applied")
  expect(fake.writes).toHaveLength(phase === "declaration" ? 1 : 2)
  if (phase === "consent") expect(result.state).toBe("complete")
  else expect(result.state).toBe("partial")
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
  expect(result.message).toContain("changed during verification")
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
it.each([{ additions: [] }, { additions: ["Directory.ReadWrite.All"] }])("rejects an invalid permission choice $additions", async ({ additions }) => {
  await expect(prepare(additionGraph(), additions)).rejects.toThrow("Choose permissions")
})
it.each(["https://evil.test/v1.0/oauth2PermissionGrants", "https://graph.microsoft.com/v1.0/users", "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?$skiptoken=same"])("rejects unsafe or repeated paging %s", async page => {
  const fake = additionGraph(); fake.state.badPage = page
  await expect(prepare(fake)).rejects.toThrow("paging")
  expect(fake.writes).toEqual([])
})
it("compares the account, tenant, registration, scopes and approved access without relying on renderer state", () => {
  expect(sameAdditionConnection(additionConnection, { ...additionConnection, clientId: additionConnection.clientId.toUpperCase(), allowed: [...additionConnection.allowed].reverse() })).toBe(true)
  for (const change of [{ homeAccountId: "different" }, { username: "other@test" }, { scopes: [] }, { allowed: [] }, { tenantId: "other" }]) expect(sameAdditionConnection(additionConnection, { ...additionConnection, ...change })).toBe(false)
})
