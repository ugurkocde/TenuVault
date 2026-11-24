import { graphNotFound } from "./fixtures/directory-response"
import { expect, it, vi } from "vitest"
import { directory9bLab, type AppLabIntent } from "./helpers/directory-9b-lab"
import { LAB_8C_APP, LAB_8C_TENANT } from "./helpers/configuration-8c-lab"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`
const token = `h.${Buffer.from(JSON.stringify({ tid: LAB_8C_TENANT, appid: LAB_8C_APP, roles: ["Application.ReadWrite.OwnedBy", "Application.Read.All", "DelegatedPermissionGrant.ReadWrite.All", "AppRoleAssignment.ReadWrite.All"] })).toString("base64url")}.s`
function world() {
  let sequence = 10
  const owners = new Map<string, Set<string>>()
  const intents = new Map<string, AppLabIntent>(), active = new Map<string, Record<string, unknown>>(), deleted = new Map<string, Record<string, unknown>>(), writes: Array<{ path: string; body: Record<string, unknown> }> = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname.replace("/beta/", ""), method = init?.method ?? "GET", body = JSON.parse(String(init?.body ?? "{}"))
    if (method !== "GET") writes.push({ path, body })
    const parts = path.split("/")
    if (path.endsWith("/owners/$ref") && method === "POST") { const parent = parts.slice(0,2).join("/"), links = owners.get(parent) ?? new Set<string>(); links.add(String(body["@odata.id"]).split("/").at(-1)!); owners.set(parent, links); return new Response(null, { status: 204 }) }
    if (path.endsWith("/owners") && method === "GET") return Response.json({ value: [...owners.get(parts.slice(0,2).join("/")) ?? []].map(id => ({ id })) })
    if (path.endsWith("/restore")) { const item = deleted.get(parts[2]!)!; active.set(`${item.folder}/${item.id}`, item); deleted.delete(parts[2]!); return Response.json(item) }
    if (path === "applications" && method === "POST") { const key = id(sequence++), item = { ...body, id: key, appId: id(sequence++), folder: "applications" }; active.set(path+"/"+key, item); return Response.json(item) }
    if (path === "servicePrincipals" && method === "POST") { const app = [...active.values()].find(row => row.appId === body.appId)!; const key = id(sequence++), item = { ...app, id: key, appOwnerOrganizationId: LAB_8C_TENANT, servicePrincipalType: "Application", folder: "servicePrincipals" }; active.set(path+"/"+key, item); return Response.json(item) }
    if (path === "oauth2PermissionGrants" && method === "POST" || path.endsWith("/appRoleAssignments") && method === "POST") { const item = { ...body, id: "A".repeat(43) }; active.set(path+"/"+item.id, item); return Response.json(item) }
    if (method === "GET" && ["applications", "servicePrincipals"].includes(path)) return Response.json({ value: [...active.values()].filter(item => item.folder === path) })
    if (path.startsWith("directory/deletedItems/microsoft.graph.")) return Response.json({ value: [...deleted.values()].filter(item => item.folder === (path.endsWith("application") ? "applications" : "servicePrincipals")) })
    const item = path.startsWith("directory/deletedItems/") ? deleted.get(parts[2]!) : active.get(path)
    if (method === "DELETE") { if (item) { if (path.startsWith("directory")) deleted.delete(parts[2]!); else { active.delete(path); if (item.folder) deleted.set(String(item.id), item) } } return new Response(null, { status: 204 }) }
    if (method === "PATCH" && item) { Object.assign(item, body); return new Response(null, { status: 204 }) }
    return item ? Response.json(item) : graphNotFound()
  })
  const recovery = { save: (intent: AppLabIntent) => { intents.set(intent.folder+":"+intent.name, { ...intent }) }, load: () => [...intents.values()], clear: () => { intents.clear() }, evidence: vi.fn() }
  const lab = directory9bLab(token, LAB_8C_TENANT, LAB_8C_APP, recovery, id(3), fetcher, async () => {})
  return { lab, fetcher, recovery, intents, active, deleted, writes }
}
it("prepares a full fixture-only lifecycle with permanent cleanup and no credentials", async () => {
  const env = world(), api = await env.lab.createApplication(), client = await env.lab.createApplication()
  const resource = await env.lab.createPrincipal(api.appId), principal = await env.lab.createPrincipal(client.appId)
  await env.lab.owner(api.id, principal); await env.lab.owner(resource, principal)
  await env.lab.consent(principal, resource); await env.lab.appRole(principal, resource, api.roleId)
  await env.lab.metadata(principal); await env.lab.recycle(principal); await env.lab.metadata(client.id); await env.lab.recycle(client.id)
  await env.lab.cleanup()
  expect(await env.lab.audit()).toEqual([])
  expect(env.active.size).toBe(0); expect(env.deleted.size).toBe(0); expect(env.intents.size).toBe(0)
  expect(env.writes.some(row => row.path.startsWith("directory/deletedItems/") && !row.path.endsWith("restore"))).toBe(true)
  expect(JSON.stringify(env.writes)).not.toMatch(/passwordCredentials|keyCredentials|clientSecret/)
})
it("refuses existing objects, Microsoft resources, foreign connections and invalid protections before writing", async () => {
  const env = world()
  await expect(env.lab.createPrincipal("00000003-0000-0000-c000-000000000000")).rejects.toThrow("created in this run")
  await expect(env.lab.consent(id(10), id(20))).rejects.toThrow("Existing lab objects")
  await expect(env.lab.appRole(id(10), id(20), id(30))).rejects.toThrow("Existing lab objects")
  await expect(env.lab.owner(id(10), id(20))).rejects.toThrow("Existing lab objects")
  expect(env.writes).toEqual([])
  expect(() => directory9bLab(token, id(1), LAB_8C_APP, env.recovery, id(3), env.fetcher)).toThrow("approved")
  expect(() => directory9bLab(token, LAB_8C_TENANT, LAB_8C_APP, env.recovery, LAB_8C_APP, env.fetcher)).toThrow("separately")
})
it("retains unanswered intent and refuses new fixtures after inconclusive cleanup", async () => {
  const env = world()
  env.intents.set("lost", { name: "TV06-TEST-lost", folder: "applications", state: "intent" })
  await expect(env.lab.cleanup()).rejects.toThrow("unresolved")
  await expect(env.lab.createApplication()).rejects.toThrow("unanswered")
  expect(env.intents.size).toBe(1); expect(env.writes).toEqual([])
})
it("refuses pre-existing prefixed remnants and protects both registration app IDs", async () => {
  const env = world()
  env.active.set(`applications/${id(20)}`, { id: id(20), appId: id(21), displayName: "TV06-TEST-remnant", folder: "applications" })
  env.active.set(`applications/${id(30)}`, { id: id(30), appId: id(31), displayName: "Existing", folder: "applications" })
  await expect(env.lab.cleanup()).rejects.toThrow("pre-existing fixture")
  expect(env.writes).toEqual([])
  env.active.set(`applications/${id(20)}`, { id: id(20), appId: id(3), displayName: "TV06-TEST-protected", folder: "applications" })
  await expect(env.lab.cleanup()).rejects.toThrow("protected app")
})

it("does not replace a recorded fixture identity with a same-name pre-existing object", async () => {
  const env = world(), app = await env.lab.createApplication()
  const recorded = [...env.intents.values()][0]!
  env.active.set(`applications/${id(90)}`, { id: id(90), appId: id(91), displayName: recorded.name, folder: "applications" })
  await expect(env.lab.cleanup()).rejects.toThrow("pre-existing fixture")
  expect([...env.intents.values()][0]!.id).toBe(app.id)
  expect(env.writes.some(write => write.path.includes(id(90)))).toBe(false)
})
