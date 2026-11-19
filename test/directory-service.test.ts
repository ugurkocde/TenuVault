import { createHash } from "node:crypto"
import { expect, it, vi } from "vitest"
import { DirectoryRestoreService } from "../src/main/restore/directory-service"
import { RecoveryAccounts } from "../src/main/restore/safety-resolvers"
import { restoreFingerprint } from "../src/main/restore/guarded-run"
import type { Item } from "../src/shared/intune/registry"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const tenant = id(1), app = id(2), admin = id(3), resource = id(10)
const options = { stage: "object" as const, exactMembers: false, exactOwners: false }
function world(count = 0, missing = false) {
  let target = missing ? "" : resource
  const data = new Map<string, string>(), members = new Set<string>(), writes: string[] = []
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const group: Item = { id: resource, displayName: "Group", mailNickname: "group", groupTypes: [], mailEnabled: false, securityEnabled: true, isAssignableToRole: false }
  const saved = Array.from({ length: count }, (_, n) => id(100 + n))
  const declaration = { format: "sorted-id-shards-v1", count, shards: count ? 1 : 0, complete: true, hash: createHash("sha256").update(saved.map(value => JSON.stringify(value) + "\n").join("")).digest("hex") }
  const snapshot: Item & { members: typeof declaration; owners: typeof declaration } = { ...group, members: declaration, owners: { ...declaration, count: 0, shards: 0, hash: createHash("sha256").digest("hex") } }
  const token = `h.${Buffer.from(JSON.stringify({ tid: tenant, oid: admin, appid: app, scp: "User.Create User.ReadUpdate.All User.ReadWrite.All User.Read.All Group.ReadWrite.All Group.Read.All GroupMember.ReadWrite.All Application.Read.All Policy.Read.All" })).toString("base64url")}.s`
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname.replace(/^\/(v1\.0|beta)\//, ""), method = init?.method ?? "GET"
    if (method !== "GET") {
      writes.push(method + " " + path)
      if (path === "groups") { target = id(900); group.id = target; Object.assign(group, JSON.parse(String(init?.body))); return Response.json({ id: target }, { status: 201 }) }
      if (path.endsWith("/members/$ref")) members.add(JSON.parse(String(init?.body))["@odata.id"].split("/").at(-1))
      else if (path.includes("/members/")) members.delete(path.split("/")[3]!)
      else if (path === `groups/${resource}`) Object.assign(group, JSON.parse(String(init?.body)))
      return new Response(null, { status: 204 })
    }
    if (path === "applications" || path === "servicePrincipals") return Response.json({ value: [{ id: id(path === "applications" ? 4 : 5), appId: app }] })
    if (path.startsWith("identity/conditionalAccess/")) return Response.json({ value: [] })
    if (path === "roleManagement/directory/roleAssignments") return Response.json({ value: [{ principalId: admin, directoryScopeId: "/", roleDefinitionId: id(50) }] })
    if (path === `roleManagement/directory/roleDefinitions/${id(50)}`) return Response.json({ templateId: "fdd7a751-b60b-444a-984c-02652fe8fa1c" })
    if (path === `groups/${target}`) return Response.json(group)
    if (path === `groups/${resource}/members`) return Response.json({ value: [...members].map(id => ({ id })) })
    if (path === `groups/${resource}/owners`) return Response.json({ value: [] })
    if (path.startsWith(`groups/${resource}/members/`)) return members.has(path.split("/")[3]!) ? Response.json({ id: path.split("/")[3] }) : new Response(null, { status: 404 })
    if (path.startsWith("users/")) return Response.json({ id: path.split("/")[1], displayName: "Person", userType: "Member", accountEnabled: false })
    return new Response(null, { status: 404 })
  })
  const connection = async () => ({ token, tenantId: tenant, clientId: app, userId: admin })
  const service = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), connection, fetcher)
  const request = { path: `backup/Groups/${resource}.json`, snapshot, origin: "restore" as const }
  const read = async () => saved
  return { service, request, group, saved, read, data, writes, members, fetcher }
}
it("executes a real 50-row relationship preview in bounded batches and resumes without duplicates", async () => {
  const env = world(65), service = env.service()
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(page.rows).toHaveLength(50); expect(page.more).toBe(true)
  expect(env.writes).toEqual([])
  const approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
  const request = { ...env.request, runId: page.runId }
  expect(await service.execute(tenant, request, page.fingerprint, approvals)).toMatchObject({ status: "complete", batches: 3, failed: 0 })
  expect(env.writes).toHaveLength(50)
  const restarted = env.service()
  expect((await restarted.resume(tenant, request)).fingerprint).toBe(page.fingerprint)
  await restarted.execute(tenant, request, page.fingerprint, approvals)
  expect(env.writes).toHaveLength(50)
  const next = await restarted.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(next.rows).toHaveLength(15); expect(next.more).toBe(false)
})
it("rejects changed backup content and unapproved rows before writing", async () => {
  const env = world(1), service = env.service(), page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const request = { ...env.request, runId: page.runId }
  await expect(service.execute(tenant, request, page.fingerprint, {})).rejects.toThrow("Approve each")
  await expect(service.execute(tenant, { ...request, snapshot: { ...request.snapshot, displayName: "Changed" } }, page.fingerprint, {})).rejects.toThrow("backup or preview changed")
  expect(env.writes).toEqual([])
})
it("refuses a corrupt relationship hash before publishing a partial preview", async () => {
  const env = world(1)
  env.request.snapshot.members.hash = "bad"
  await expect(env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)).rejects.toThrow("fingerprint")
  expect(env.writes).toEqual([])
})
it("requires exact choice and a separate removal approval for each extra member", async () => {
  const env = world(), service = env.service(); env.members.add(id(100))
  const adds = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(adds.rows).toEqual([])
  const exact = await service.prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: true }, env.read)
  expect(exact.rows[0]!.review.approvals).toContain("exact-group")
  await service.execute(tenant, { ...env.request, runId: exact.runId }, exact.fingerprint, { [exact.rows[0]!.key]: exact.rows[0]!.review.approvals })
  expect(env.members.size).toBe(0)
  expect(env.writes[0]).toBe(`DELETE groups/${resource}/members/${id(100)}/$ref`)
})
it("shows explicit blockers for privileged groups and protects the restoring admin", async () => {
  const env = world(1); env.group.isAssignableToRole = true
  const page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(page.rows[0]!.review.blocker).toContain("Role-assignable")
  expect(page.rows[0]!.review.approvals).toContain("security-response")
  expect(env.writes).toEqual([])
  const own = world(); own.members.add(admin)
  const exact = await own.service().prepare(tenant, own.request, { ...options, stage: "relationships", exactMembers: true }, own.read)
  expect(exact.rows[0]!.review.blocker).toContain("protected")
})
it("restores closed group metadata through the production service", async () => {
  const env = world(), service = env.service(); env.request.snapshot.description = "Saved description"
  const page = await service.prepare(tenant, env.request, options, env.read)
  expect(page.rows[0]!.review.changes).toContainEqual({ property: "description", before: null, after: "Saved description" })
  const approvals = { [page.rows[0]!.key]: page.rows[0]!.review.approvals }
  expect(await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, approvals)).toMatchObject({ status: "complete" })
  expect(env.group.description).toBe("Saved description")
  expect([...env.data.values()].some(value => value.includes(restoreFingerprint(env.request.snapshot)))).toBe(true)
})

it("pages beyond blocked rows without making them executable", async () => {
  const env = world(65), service = env.service(); env.group.isAssignableToRole = true
  const first = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(first.rows.every(row => !!row.review.blocker)).toBe(true)
  const next = await service.prepare(tenant, env.request, { ...options, stage: "relationships", previousRunId: first.runId }, env.read)
  expect(next.rows).toHaveLength(15)
  expect(env.writes).toEqual([])
})
it("cancels between writes and resumes the persisted batch after a service restart", async () => {
  const env = world(25), service = env.service()
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const original = env.fetcher.getMockImplementation()!
  let release!: () => void, reached!: () => void, held = false
  const sent = new Promise<void>(resolve => { reached = resolve })
  env.fetcher.mockImplementation(async (input, init) => {
    if (init?.method === "POST" && !held) { held = true; reached(); await new Promise<void>(resolve => { release = resolve }) }
    return original(input, init)
  })
  const approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
  const request = { ...env.request, runId: page.runId }
  const pending = service.execute(tenant, request, page.fingerprint, approvals)
  await sent; await service.cancel(tenant, page.runId); release()
  expect(await pending).toMatchObject({ status: "partial" })
  expect(env.writes).toHaveLength(1)
  expect(await env.service().execute(tenant, request, page.fingerprint, approvals)).toMatchObject({ status: "complete" })
  expect(env.writes).toHaveLength(25)
})

it("accepts the lab's explicit null role flag and refuses an omitted role classification", async () => {
  const env = world(1), service = env.service(); env.group.isAssignableToRole = null
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(page.rows[0]!.review.blocker).toBeUndefined()
  expect(await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })).toMatchObject({ status: "complete" })
  delete env.group.isAssignableToRole; env.members.clear()
  await expect(service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)).rejects.toThrow("privilege could not be resolved")
  expect(env.writes).toHaveLength(1)
})

it("publishes recreated IDs and an advisory reference warning without probing unselected services", async () => {
  const env = world(0, true), service = env.service()
  const page = await service.prepare(tenant, env.request, options, env.read)
  const result = await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
  expect(result).toMatchObject({ status: "partial", outcomes: [{ state: "applied", targetId: id(900) }] })
  expect(result.warnings.length).toBeGreaterThan(0)
  expect(env.fetcher.mock.calls.some(([input]) => String(input).includes("deviceManagement"))).toBe(false)
  const replacement = await env.service().prepare(tenant, env.request, options, env.read)
  expect(replacement.rows[0]!.review.resource.id).toBe(id(900))
  expect(env.writes.filter(write => write === "POST groups")).toHaveLength(1)
})
