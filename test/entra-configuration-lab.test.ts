import { describe, expect, it } from "vitest"
import { configurationLab, LAB_8B_TENANT, LAB_8B_APP, LAB_8B_FOLDERS } from "./helpers/entra-configuration-lab"
import type { Item } from "../src/shared/intune/registry"

const token = `header.${Buffer.from(JSON.stringify({ tid: LAB_8B_TENANT, appid: LAB_8B_APP, roles: ["OrganizationalBranding.ReadWrite.All"] })).toString("base64url")}.signature`
function world(failure?: string) {
  const calls: Array<{ method: string; path: string; body?: Item }> = [], objects = new Map<string, Item>()
  const singletons: Record<string, Item> = {
    authorizationPolicy: { displayName: "original" }, identitySecurityDefaultsEnforcementPolicy: { isEnabled: false }, authenticationMethodsPolicy: { registrationEnforcement: { authenticationMethodsRegistrationCampaign: { state: "disabled", includeTargets: [], excludeTargets: [] } } },
    adminConsentRequestPolicy: { isEnabled: false, notifyReviewers: false, remindersEnabled: false, requestDurationInDays: 30, reviewers: [] }, authenticationFlowsPolicy: { selfServiceSignUp: { isEnabled: false } }, [LAB_8B_TENANT]: { marketingNotificationEmails: [] }, branding: { usernameHintText: "original" },
  }
  const original = structuredClone(singletons)
  let injected = false, sequence = 0
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname, method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) as Item : undefined
    calls.push({ path, method, ...(body ? { body } : {}) })
    const collection = /\/(permissionGrantPolicies|tokenLifetimePolicies|activityBasedTimeoutPolicies)$/.test(path)
    const singleton = singletons[path.split("/").at(-1)!]
    if (method === "GET") {
      if (collection) return Response.json({ value: [...objects.values()].filter(item => item.collection === path).map(({ collection: _collection, ...item }) => item), ...(failure === "continuation" ? { "@odata.nextLink": "https://evil.invalid/users" } : {}) })
      if (singleton) return Response.json(singleton)
      if (objects.has(path)) { const { collection: _collection, ...item } = objects.get(path)!; return Response.json(item) }
      return new Response(null, { status: 404 })
    }
    if (method === "DELETE") { objects.delete(path); return new Response(null, { status: 204 }) }
    if (method === "POST") {
      const id = String(body!.id ?? `created-${++sequence}`), item = { ...body!, id, collection: path }
      objects.set(path + "/" + id, item)
      if (failure === "create-timeout") throw new Error("Answer lost after commit")
      return Response.json({ ...body!, id }, { status: 201 })
    }
    if (singleton) Object.assign(singleton, body)
    else if (objects.has(path)) Object.assign(objects.get(path)!, body)
    else throw new Error("Unknown write target")
    if (!injected && failure === "singleton-timeout") { injected = true; throw new Error("Answer lost after singleton commit") }
    if (!injected && failure === "refused") { injected = true; return new Response(null, { status: 403 }) }
    return new Response(null, { status: 204 })
  }) as typeof fetch
  return { calls, objects, singletons, original, lab: configurationLab(token, LAB_8B_TENANT, LAB_8B_APP, fetcher) }
}
describe("the prepared app-only lab harness with injected fetch only", () => {
  it("refuses another tenant, app, token identity and non-allowlisted type before any request", async () => {
    expect(() => configurationLab(token, "other", LAB_8B_APP)).toThrow("restricted")
    expect(() => configurationLab(token, LAB_8B_TENANT, "other")).toThrow("restricted")
    expect(() => configurationLab("opaque", LAB_8B_TENANT, LAB_8B_APP)).toThrow("Invalid")
    const otherToken = `h.${Buffer.from(JSON.stringify({ tid: "other", appid: LAB_8B_APP, roles: ["OrganizationalBranding.ReadWrite.All"] })).toString("base64url")}.s`
    expect(() => configurationLab(otherToken, LAB_8B_TENANT, LAB_8B_APP)).toThrow("token")
    const state = world()
    for (const folder of ["Organization", "Users", "ConditionalAccessPolicies", "CertificateBasedAuthPki", "AuthenticationMethodsPolicy/../../users"]) await expect(state.lab.run(folder)).rejects.toThrow("allowlist")
    expect(state.calls).toEqual([])
  })
  it("refuses branding without the narrow permission or with the retired permission before any request", async () => {
    for (const roles of [[], ["OrganizationalBranding.ReadWrite.All", "Organization.ReadWrite.All"]]) {
      const guardedToken = `h.${Buffer.from(JSON.stringify({ tid: LAB_8B_TENANT, appid: LAB_8B_APP, roles })).toString("base64url")}.s`
      const lab = configurationLab(guardedToken, LAB_8B_TENANT, LAB_8B_APP, (() => { throw new Error("Must not fetch") }) as typeof fetch)
      expect(lab.brandingAllowed).toBe(false)
      await expect(lab.run("EntraCompanyBranding")).rejects.toThrow("narrow role")
    }
  })
  for (const folder of LAB_8B_FOLDERS) it(`${folder}: verifies read-back and leaves original singleton state and no prefixed policies`, async () => {
    const state = world()
    await state.lab.run(folder)
    expect(state.singletons).toEqual(state.original)
    expect(state.objects.size).toBe(0)
    const writes = state.calls.filter(call => call.method !== "GET")
    expect(writes.length).toBeGreaterThan(0)
    if (["AuthorizationPolicy", "SecurityDefaults", "AuthenticationMethodsPolicy"].includes(folder)) {
      expect(writes).toHaveLength(1)
      expect(writes[0]!.body).toEqual(state.original[writes[0]!.path.split("/").at(-1)!])
    }
    expect(writes.every(call => !call.path.includes("conditionalAccess"))).toBe(true)
  })
  for (const failure of ["singleton-timeout", "refused"]) it(`restores the original after ${failure} and verifies it`, async () => {
    const state = world(failure)
    await expect(state.lab.run("AuthenticationFlowsPolicy")).rejects.toThrow()
    expect(state.singletons).toEqual(state.original)
    expect(state.calls.filter(call => call.method === "PATCH")).toHaveLength(2)
    expect(state.calls.at(-1)!.method).toBe("GET")
  })
  it("discovers and removes every prefixed object after a lost create response and leaves non-prefixed objects alone", async () => {
    const state = world("create-timeout")
    const collection = "/v1.0/policies/tokenLifetimePolicies"
    state.objects.set(collection + "/untouched", { id: "untouched", displayName: "Customer policy", collection })
    await expect(state.lab.run("TokenLifetimePolicies")).rejects.toThrow("lost")
    expect([...state.objects.values()].map(item => item.displayName)).toEqual(["Customer policy"])
    expect(state.calls.filter(call => call.method === "DELETE").every(call => !call.path.endsWith("untouched"))).toBe(true)
  })
  it("refuses a malicious continuation and reports all cleanup failures without sending to another host", async () => {
    const state = world("continuation")
    await expect(state.lab.cleanup()).rejects.toThrow("Cleanup needs attention")
    expect(state.calls.every(call => call.method === "GET")).toBe(true)
    expect(state.calls).toHaveLength(3)
  })
  it("persists the original before sending and clears recovery only after restoring and verifying", async () => {
    const state = world(), originals = new Map<string, Item>()
    const events: string[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      if (method !== "GET") expect(originals.has("AuthenticationFlowsPolicy")).toBe(true)
      events.push(method)
      if (method === "GET") return Response.json(state.singletons.authenticationFlowsPolicy)
      Object.assign(state.singletons.authenticationFlowsPolicy!, JSON.parse(String(init?.body)))
      return new Response(null, { status: 204 })
    }) as typeof fetch
    const lab = configurationLab(token, LAB_8B_TENANT, LAB_8B_APP, fetcher, { save: (folder, original) => { events.push("save"); originals.set(folder, original) }, clear: folder => { events.push("clear"); originals.delete(folder) } })
    await lab.run("AuthenticationFlowsPolicy")
    expect(events.indexOf("save")).toBeLessThan(events.indexOf("PATCH"))
    expect(events.slice(-2)).toEqual(["GET", "clear"])
    expect(originals.size).toBe(0)
    expect(state.singletons).toEqual(state.original)
  })
  it("does not write if durable original capture fails", async () => {
    let writes = 0
    const fetcher = (async (_input, init) => { if (init?.method !== "GET") writes++; return Response.json({ selfServiceSignUp: { isEnabled: false } }) }) as typeof fetch
    const lab = configurationLab(token, LAB_8B_TENANT, LAB_8B_APP, fetcher, { save: () => { throw new Error("disk full") }, clear: () => {} })
    await expect(lab.run("AuthenticationFlowsPolicy")).rejects.toThrow("disk full")
    expect(writes).toBe(0)
  })
  it("refuses a secret-bearing original before a mutation", async () => {
    const state = world()
    state.singletons.authenticationMethodsPolicy!.registrationEnforcement = { secret: "must not persist" }
    await expect(state.lab.run("AuthenticationMethodsPolicy")).rejects.toThrow("Credential")
    expect(state.calls.filter(call => call.method !== "GET")).toEqual([])
  })
})
