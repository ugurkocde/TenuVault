import { expect, it, vi } from "vitest"
import { directory9aLab, type DirectoryLabIntent } from "./helpers/directory-9a-lab"
import { LAB_8C_APP, LAB_8C_TENANT } from "./helpers/configuration-8c-lab"
import type { Item } from "../src/shared/intune/registry"
const roles = ["User.Create", "User.ReadUpdate.All", "User.Read.All", "User.DeleteRestore.All", "User.ReadWrite.All"]
const token = (permissions = roles) => `header.${Buffer.from(JSON.stringify({ tid: LAB_8C_TENANT, appid: LAB_8C_APP, roles: permissions })).toString("base64url")}.signature`
const id = "00000000-0000-4000-8000-000000000001"
function setup(mode: "normal" | "lost-create" | "cleanup-refused" | "throttle" = "normal") {
  const active = new Map<string, Item>(), deleted = new Map<string, Item>(), durable = new Map<string, DirectoryLabIntent>(), evidence: Item[] = []
  let throttle = mode === "throttle", secret = "", managerId = ""
  const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace("/v1.0/", ""), method = options?.method ?? "GET"
    if (throttle && method === "GET") { throttle = false; return new Response(null, { status: 429, headers: { "Retry-After": "1" } }) }
    if (method === "POST" && path === "users") {
      const body = JSON.parse(String(options?.body)); secret = body.passwordProfile.password
      expect(body.accountEnabled).toBe(false); delete body.passwordProfile
      active.set(id, { id, ...body })
      if (mode === "lost-create") throw new Error("Lost response")
      return Response.json({ id })
    }
    if (method === "GET") {
      if (path === "users") return Response.json({ value: [...active.values()] })
      if (path === "groups" || path.endsWith("microsoft.graph.group")) return Response.json({ value: [] })
      if (path.endsWith("microsoft.graph.user")) return Response.json({ value: [...deleted.values()] })
      if (path.endsWith("/manager")) return managerId ? Response.json({ id: managerId }) : new Response(null, { status: 404 })
      const value = (path.startsWith("directory/") ? deleted : active).get(path.split("/").at(-1)!)
      return value ? Response.json(value) : new Response(null, { status: 404 })
    }
    if (method === "PATCH") { Object.assign(active.get(id)!, JSON.parse(String(options?.body))); return new Response(null, { status: 204 }) }
    if (method === "DELETE") {
      if (mode === "cleanup-refused") return new Response(null, { status: 403 })
      if (path.endsWith("/manager/$ref")) { managerId = ""; return new Response(null, { status: 204 }) }
      if (path.startsWith("users/")) { const item = active.get(id); if (item) deleted.set(id, item); active.delete(id) }
      else deleted.delete(id)
      return new Response(null, { status: 204 })
    }
    if (path.endsWith("/restore")) { active.set(id, deleted.get(id)!); deleted.delete(id); return Response.json({ id }) }
    if (method === "PUT") { managerId = id; return new Response(null, { status: 204 }) }
    throw new Error("Unexpected fixture request")
  })
  const pause = vi.fn(async () => {})
  const lab = directory9aLab(token(), LAB_8C_TENANT, LAB_8C_APP, { save: intent => { durable.set(intent.name, intent) }, load: () => [...durable.values()], clear: () => durable.clear(), evidence: event => { evidence.push(event) } }, fetcher, pause)
  return { lab, active, deleted, durable, evidence, fetcher, pause, secret: () => secret }
}
for (const mode of ["normal", "lost-create", "throttle"] as const) it(`${mode}: cleans up active and deleted fixtures and clears recovery only after repeated empty audits`, async () => {
  const env = setup(mode)
  try {
    const user = await env.lab.createUser("sl6ll.onmicrosoft.com")
    await env.lab.lifecycleUser(user)
  } catch (error) { if (mode !== "lost-create") throw error }
  expect(env.durable.size).toBe(1)
  expect([...env.durable].join()).not.toContain(env.secret())
  expect(JSON.stringify(env.evidence)).not.toContain(env.secret())
  await env.lab.cleanup()
  expect(env.active.size).toBe(0); expect(env.deleted.size).toBe(0); expect(env.durable.size).toBe(0)
  expect(env.evidence.filter(event => event.kind === "remnant-audit")).toHaveLength(3)
  expect(await env.lab.audit()).toEqual([])
})
it("retains recovery when cleanup is refused and reports the remnants", async () => {
  const env = setup("cleanup-refused")
  await env.lab.createUser("sl6ll.onmicrosoft.com")
  await expect(env.lab.cleanup()).rejects.toThrow("Recovery intent is retained")
  expect(env.durable.size).toBe(1)
  expect(await env.lab.audit()).toHaveLength(1)
})
it("does not change existing objects, never assigns a license or invites a guest, and enforces group grants", async () => {
  const env = setup()
  await expect(env.lab.lifecycleUser(id)).rejects.toThrow("Existing objects")
  await expect(env.lab.manager(id, id)).rejects.toThrow("Existing objects")
  await expect(env.lab.relationship(id, id, "members", true)).rejects.toThrow("Existing objects")
  await expect(env.lab.relationship(id, id, "../../users/other?query" as "members", false)).rejects.toThrow("relationship kind")
  await expect(env.lab.createGroup()).rejects.toThrow("Missing lab application permission")
  await expect(env.lab.createGroup(true)).rejects.toThrow("approved grant")
  expect(env.fetcher).not.toHaveBeenCalled()
})
it("refuses another lab identity and missing application permissions", () => {
  const recovery = { save: vi.fn(), load: () => [], clear: vi.fn(), evidence: vi.fn() }
  expect(() => directory9aLab(token(), "other", LAB_8C_APP, recovery)).toThrow("approved lab")
  expect(() => directory9aLab(token([]), LAB_8C_TENANT, LAB_8C_APP, recovery)).toThrow("Missing lab")
})
it("reports partial-prefix remnants and never deletes them", async () => {
  const env = setup()
  env.active.set(id, { id, displayName: "TV06-TEST-incomplete", userPrincipalName: "existing@example.com", accountEnabled: false })
  await expect(env.lab.cleanup()).rejects.toThrow("unresolved")
  expect(env.active.size).toBe(1)
  expect(env.fetcher.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true)
})

it("verifies the prepared group lifecycle, membership and owner round trip under test-only cleanup evidence", async () => {
  const { LAB_9A_GROUP_CLEANUP } = await import("./helpers/directory-9a-lab")
  const active = new Map<string, Item>(), deleted = new Map<string, Item>(), links = new Set<string>(), intents = new Map<string, DirectoryLabIntent>()
  let next = 1
  const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace("/v1.0/", ""), parts = path.split("/"), method = options?.method ?? "GET", body = options?.body ? JSON.parse(String(options.body)) : undefined
    if (method === "GET") {
      if (parts.length === 1) return Response.json({ value: [...active.values()].filter(value => value.fixtureFolder === path) })
      if (path.endsWith("microsoft.graph.user") || path.endsWith("microsoft.graph.group")) return Response.json({ value: [...deleted.values()].filter(value => value.fixtureFolder === (path.endsWith(".user") ? "users" : "groups")) })
      if (parts.length === 4) return links.has(path) ? Response.json({ id: parts[3] }) : new Response(null, { status: 404 })
      const value = parts[0] === "directory" ? deleted.get(parts[2]!) : active.get(parts[1]!); return value ? Response.json(value) : new Response(null, { status: 404 })
    }
    if (method === "POST" && ["users", "groups"].includes(path)) {
      const objectId = `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
      if (body.passwordProfile) delete body.passwordProfile
      active.set(objectId, { ...body, id: objectId, fixtureFolder: path }); return Response.json({ id: objectId })
    }
    if (method === "PATCH") { Object.assign(active.get(parts[1]!)!, body); return new Response(null, { status: 204 }) }
    if (parts[2] === "members" || parts[2] === "owners") {
      const principalId = method === "POST" ? String(body["@odata.id"]).split("/").at(-1)! : parts[3]!
      const key = `${parts[0]}/${parts[1]}/${parts[2]}/${principalId}`
      if (method === "POST") links.add(key); else links.delete(key)
      return new Response(null, { status: 204 })
    }
    if (path.endsWith("/restore")) { active.set(parts[2]!, deleted.get(parts[2]!)!); deleted.delete(parts[2]!); return Response.json({ id: parts[2] }) }
    if (method === "DELETE") {
      if (parts[0] === "directory") deleted.delete(parts[2]!)
      else { const item = active.get(parts[1]!); if (item) deleted.set(parts[1]!, item); active.delete(parts[1]!) }
      return new Response(null, { status: 204 })
    }
    throw new Error("Unexpected group fixture request")
  })
  const permissions = [...roles, "Group.Create", "Group.Read.All", "Group.ReadWrite.All", "GroupMember.ReadWrite.All", "RoleManagement.ReadWrite.Directory"]
  const lab = directory9aLab(token(permissions), LAB_8C_TENANT, LAB_8C_APP, { save: intent => { intents.set(intent.name, intent) }, load: () => [...intents.values()], clear: () => { intents.clear() }, evidence: vi.fn() }, fetcher, async () => {})
  LAB_9A_GROUP_CLEANUP.admitted = true
  try {
    const user = await lab.createUser("sl6ll.onmicrosoft.com")
    for (const [roleAssignable, microsoft365] of [[false, false], [false, true], [true, false]]) {
      const group = await lab.createGroup(roleAssignable, microsoft365)
      await lab.relationship(group, user, "members", true); await lab.relationship(group, user, "members", false)
      if (!roleAssignable) { await lab.relationship(group, user, "owners", true); await lab.relationship(group, user, "owners", false) }
      await lab.lifecycleGroup(group)
    }
    await lab.cleanup()
    expect((await lab.audit()).filter(item => item.folder !== "directory/deletedItems/microsoft.graph.group")).toEqual([]); expect(intents.size).toBe(0); expect(links.size).toBe(0)
    expect(fetcher.mock.calls.every(([input]) => !String(input).includes("roleManagement"))).toBe(true)
  } finally { LAB_9A_GROUP_CLEANUP.admitted = true }
})

it("keeps an uncertain invisible create in durable recovery even after repeated empty audits", async () => {
  const durable = new Map<string, DirectoryLabIntent>()
  const fetcher = vi.fn(async (_input: RequestInfo | URL, options?: RequestInit) => {
    if (options?.method === "POST") throw new Error("Request outcome unknown")
    return Response.json({ value: [] })
  })
  const lab = directory9aLab(token(), LAB_8C_TENANT, LAB_8C_APP, { save: intent => { durable.set(intent.name, intent) }, load: () => [...durable.values()], clear: () => durable.clear(), evidence: vi.fn() }, fetcher, async () => {})
  await expect(lab.createUser("sl6ll.onmicrosoft.com")).rejects.toThrow("unknown")
  await expect(lab.cleanup()).rejects.toThrow("Recovery intent is retained")
  expect([...durable.values()][0]!.state).toBe("intent")
})
