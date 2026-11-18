import { describe, expect, it } from "vitest"
import { configuration8cLab, LAB_8C_TENANT, LAB_8C_APP, LAB_8C_FOLDERS } from "./helpers/configuration-8c-lab"
import type { Item } from "../src/shared/intune/registry"

const roles = ["Policy.ReadWrite.CrossTenantAccess", "Policy.ReadWrite.ExternalIdentities", "IdentityUserFlow.ReadWrite.All", "EntitlementManagement.ReadWrite.All", "Policy.ReadWrite.AccessReview", "LifecycleWorkflows.ReadWrite.All", "CustomDetection.ReadWrite.All"]
const token = `header.${Buffer.from(JSON.stringify({ tid: LAB_8C_TENANT, appid: LAB_8C_APP, roles })).toString("base64url")}.signature`
function world(failure?: string) {
  const calls: Array<{ method: string; path: string; body?: Item }> = [], objects = new Map<string, Item>()
  const singletons: Record<string, Item> = {
    crossTenantAccessPolicy: { displayName: "original" }, externalIdentitiesPolicy: { allowExternalIdentitiesToLeave: true },
    accessReviewPolicy: { isGroupOwnerManagementEnabled: false }, settings: { workflowScheduleIntervalInHours: 3 },
  }
  const original = structuredClone(singletons)
  let injected = false, sequence = 0
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname, method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) as Item : undefined
    calls.push({ path, method, ...(body ? { body } : {}) })
    const collection = /\/(userFlowAttributes|catalogs|detectionRules)$/.test(path)
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
  return { calls, objects, singletons, original, fetcher, lab: configuration8cLab(token, LAB_8C_TENANT, LAB_8C_APP, fetcher) }
}
describe("the prepared app-only lab harness with injected fetch only", () => {
  it("refuses another tenant, app, token identity and non-allowlisted type before any request", async () => {
    expect(() => configuration8cLab(token, "other", LAB_8C_APP)).toThrow("restricted")
    expect(() => configuration8cLab(token, LAB_8C_TENANT, "other")).toThrow("restricted")
    expect(() => configuration8cLab("opaque", LAB_8C_TENANT, LAB_8C_APP)).toThrow("Invalid")
    const otherToken = `h.${Buffer.from(JSON.stringify({ tid: "other", appid: LAB_8C_APP, roles: ["OrganizationalBranding.ReadWrite.All"] })).toString("base64url")}.s`
    expect(() => configuration8cLab(otherToken, LAB_8C_TENANT, LAB_8C_APP)).toThrow("token")
    const state = world()
    for (const folder of ["Organization", "Users", "ConditionalAccessPolicies", "CertificateBasedAuthPki", "AuthenticationMethodsPolicy/../../users"]) await expect(state.lab.run(folder)).rejects.toThrow("allowlist")
    expect(state.calls).toEqual([])
  })
  it("requires the exact lab grants before any request", () => {
    const guardedToken = `h.${Buffer.from(JSON.stringify({ tid: LAB_8C_TENANT, appid: LAB_8C_APP, roles: [] })).toString("base64url")}.s`
    expect(() => configuration8cLab(guardedToken, LAB_8C_TENANT, LAB_8C_APP)).toThrow("Missing lab application permission")
  })
  for (const folder of LAB_8C_FOLDERS) it(`${folder}: verifies read-back and leaves original singleton state and no prefixed policies`, async () => {
    const state = world()
    await state.lab.run(folder)
    expect(state.singletons).toEqual(state.original)
    expect(state.objects.size).toBe(0)
    const writes = state.calls.filter(call => call.method !== "GET")
    expect(writes.length).toBeGreaterThan(0)
    if (["ExternalIdentitiesPolicy", "LifecycleWorkflowSettings"].includes(folder)) {
      expect(writes).toHaveLength(1)
      expect(writes[0]!.body).toEqual(state.original[writes[0]!.path.split("/").at(-1)!])
    }
    expect(writes.every(call => !call.path.includes("conditionalAccess"))).toBe(true)
  })
  for (const failure of ["singleton-timeout", "refused"]) it(`restores the original after ${failure} and verifies it`, async () => {
    const state = world(failure)
    await expect(state.lab.run("CrossTenantAccessPolicy")).rejects.toThrow()
    expect(state.singletons).toEqual(state.original)
    expect(state.calls.filter(call => call.method === "PATCH")).toHaveLength(2)
    expect(state.calls.at(-1)!.method).toBe("GET")
  })
  it("discovers and removes every prefixed object after a lost create response and leaves non-prefixed objects alone", async () => {
    const state = world("create-timeout")
    const collection = "/v1.0/identity/userFlowAttributes"
    state.objects.set(collection + "/untouched", { id: "untouched", displayName: "Customer policy", collection })
    await expect(state.lab.run("UserFlowAttributes")).rejects.toThrow("lost")
    expect([...state.objects.values()].map(item => item.displayName)).toEqual(["Customer policy"])
    expect(state.calls.filter(call => call.method === "DELETE").every(call => !call.path.endsWith("untouched"))).toBe(true)
  })
  it("refuses a malicious continuation and reports all cleanup failures without sending to another host", async () => {
    const state = world("continuation")
    await expect(state.lab.cleanup()).rejects.toThrow("Cleanup needs attention")
    expect(state.calls.every(call => call.method === "GET")).toBe(true)
    expect(state.calls).toHaveLength(3)
  })
  it("recovers the original after a refused recovery and stops later mutations when recovery cannot finish", async () => {
    const state = world(), durable = new Map<string, Item>()
    let refuseRecovery = true
    const fetcher = (async (input, init) => {
      if (init?.method === "PATCH" && JSON.parse(String(init.body)).displayName === "original" && refuseRecovery) return new Response(null, { status: 503 })
      return state.fetcher(input, init)
    }) as typeof fetch
    const lab = configuration8cLab(token, LAB_8C_TENANT, LAB_8C_APP, fetcher, { save: (folder, original) => { durable.set(folder, original) }, clear: folder => { durable.delete(folder) } })
    await expect(lab.run("CrossTenantAccessPolicy")).rejects.toThrow("bounded retries")
    expect(durable.size).toBe(1)
    await expect(lab.run("UserFlowAttributes")).rejects.toThrow("bounded retries")
    expect(state.calls.some(call => call.method === "POST")).toBe(false)
    refuseRecovery = false
    await lab.cleanup()
    expect(durable.size).toBe(0)
    expect(state.singletons).toEqual(state.original)
  })
})
