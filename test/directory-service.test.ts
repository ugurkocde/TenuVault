import { createHash } from "node:crypto"
import { expect, it, vi } from "vitest"
import { DirectoryRestoreService } from "../src/main/restore/directory-service"
import { ModuleSettings } from "../src/main/services/settings"
import { RecoveryAccounts } from "../src/main/restore/safety-resolvers"
import { restoreFingerprint } from "../src/main/restore/guarded-run"
import { LARGE_SHARD_ITEMS } from "../src/shared/large-backup"
import type { Item } from "../src/shared/intune/registry"
import type { IdentityRestoreRequest } from "../src/main/restore/dispatch"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const tenant = id(1), app = id(2), admin = id(3), resource = id(10)
const options = { stage: "object" as const, exactMembers: false, exactOwners: false }
function world(count = 0, missing = false) {
  let target = missing ? "" : resource
  const data = new Map<string, string>(), members = new Set<string>(), writes: string[] = []
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const settings = new ModuleSettings(store)
  settings.setChoice(tenant, { entra: { access: "restore", areas: ["usersAndDevices", "groups"] } })
  const group: Item = { id: resource, displayName: "Group", mailNickname: "group", groupTypes: [], mailEnabled: false, securityEnabled: true, isAssignableToRole: false }
  const saved = Array.from({ length: count }, (_, n) => id(100 + n))
  const declaration = { format: "sorted-id-shards-v1", count, shards: Math.ceil(count / LARGE_SHARD_ITEMS), complete: true, hash: createHash("sha256").update(saved.map(value => JSON.stringify(value) + "\n").join("")).digest("hex") }
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
    if (path.endsWith("/memberOf")) return Response.json({ value: [] })
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
  const service = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), connection, fetcher, () => [], settings)
  const request = { path: `backup/Groups/${resource}.json`, snapshot, origin: "restore" as const }
  const read = async (name: string) => { const part = Number(name.match(/(\d+)\.json$/)?.[1] ?? 0); return saved.slice(part * LARGE_SHARD_ITEMS, (part + 1) * LARGE_SHARD_ITEMS) }
  return { service, settings, store, connection, request, group, saved, read, data, writes, members, fetcher }
}
it("executes a real 50-row relationship preview in bounded batches and resumes without duplicates", async () => {
  const env = world(65), service = env.service()
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(page.rows).toHaveLength(50); expect(page.more).toBe(true)
  expect(page.rows[0]!.review.changes).toEqual([{ property: "present", before: false, after: true }])
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
  expect(exact.rows[0]!.review.changes).toEqual([{ property: "present", before: true, after: false }])
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

it("blocks inherited group beneficiaries before a link can be approved", async () => {
  const env = world(1), original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation(async (input, init) => String(input).includes("/memberOf") ? Response.json({ value: [{ id: id(500) }] }) : original(input, init))
  const page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(page.rows[0]!.review.blocker).toContain("inherited beneficiaries")
  expect(env.writes).toEqual([])
})

it("blocks user name changes when Conditional Access groups could inherit the result", async () => {
  const env = world(), original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation(async (input, init) => String(input).includes("conditionalAccess") ? Response.json({ value: [{ conditions: { users: { includeGroups: [], excludeGroups: [id(500)] } } }] }) : original(input, init))
  const request = { path: `backup/Users/${id(100)}.json`, origin: "restore" as const, snapshot: { id: id(100), displayName: "Saved name", userType: "Member" } }
  const page = await env.service().prepare(tenant, request, options, env.read)
  expect(page.rows[0]!.review.blocker).toContain("dynamic-membership review")
  expect(env.writes).toEqual([])
})

function caGroup(env: ReturnType<typeof world>, included = true) {
  const original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation(async (input, init) => String(input).includes("conditionalAccess") ? Response.json({ value: [{ conditions: { users: { includeGroups: included ? [resource] : [], excludeGroups: included ? [] : [resource] } } }] }) : original(input, init))
}
it("keeps the last member of a Conditional Access included group across batch boundaries", async () => {
  const env = world(), service = env.service()
  for (let n = 0; n < 21; n++) env.members.add(id(100 + n))
  caGroup(env)
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: true }, env.read)
  const result = await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  expect(env.members.size).toBe(1)
  expect(env.writes).toHaveLength(20)
  expect(result.status).toBe("partial")
})
it("blocks emptying a CA target and refuses excluded groups or incomplete policy pages", async () => {
  for (const mode of ["included", "excluded", "incomplete"] as const) {
    const env = world(); env.members.add(id(100)); caGroup(env, mode !== "excluded")
    if (mode === "incomplete") {
      const original = env.fetcher.getMockImplementation()!
      env.fetcher.mockImplementation(async (input, init) => String(input).includes("conditionalAccess") ? Response.json({ value: [{ conditions: { users: { excludeGroups: [] } } }] }) : original(input, init))
      await expect(env.service().prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: true }, env.read)).rejects.toThrow("Conditional Access")
    } else {
      const page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: true }, env.read)
      expect(page.rows[0]!.review.blocker).toContain("Conditional Access")
    }
    expect(env.writes).toEqual([])
  }
})
it("pages a durable 5,000-member production difference at constant Graph cost after restart", async () => {
  const env = world(5000), read = vi.fn(env.read)
  const costs: number[] = [], keys = new Set<string>()
  let previousRunId: string | undefined
  for (let n = 0; n < 100; n++) {
    const before = env.fetcher.mock.calls.length
    const page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships", previousRunId }, read)
    costs.push(env.fetcher.mock.calls.length - before)
    expect(page.rows).toHaveLength(50)
    for (const row of page.rows) { expect(keys.has(row.key)).toBe(false); keys.add(row.key) }
    expect(page.more).toBe(n < 99)
    previousRunId = page.runId
    expect(costs[n]).toBeLessThanOrEqual(costs[0]! + 5)
    // Later pages must use the immutable difference, even if live membership changes.
    env.members.add(id(100 + n))
  }
  expect(keys.size).toBe(5000)
  expect(read).toHaveBeenCalledTimes(5)
  expect(Math.max(...[...env.data.values()].map(value => value.length))).toBeLessThan(150_000)
}, 60_000)
it("retries a throttled later relationship page through production prepare", async () => {
  const env = world(2), original = env.fetcher.getMockImplementation()!
  let attempts = 0
  env.fetcher.mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/members")) {
      if (!url.searchParams.has("$skiptoken")) return Response.json({ value: [], "@odata.nextLink": url.href + "&$skiptoken=next" })
      if (++attempts === 1) return new Response(null, { status: 429, headers: { "Retry-After": "0" } })
      return Response.json({ value: [] })
    }
    return original(input, init)
  })
  const page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(page.rows).toHaveLength(2)
  expect(attempts).toBe(2)
})
for (const folder of ["Users", "Groups"] as const) it(`rejects saved and live formerly synced ${folder} with nullable legacy fields`, async () => {
  // Graph's selected fields can be null after sync is disabled; false still identifies a formerly synced object.
  const former = { onPremisesSyncEnabled: false, onPremisesImmutableId: null, onPremisesLastSyncDateTime: null }
  const env = world()
  const snapshot = folder === "Groups" ? env.request.snapshot : { id: id(100), displayName: "Saved", userType: "Member" }
  const request = { ...env.request, path: `backup/${folder}/${snapshot.id}.json`, snapshot: { ...snapshot, ...former } }
  await expect(env.service().prepare(tenant, request, options, env.read)).rejects.toThrow("formerly synced")
  const original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation(async (input, init) => {
    const response = await original(input, init)
    return new URL(String(input)).pathname.endsWith(`/${snapshot.id}`) ? Response.json({ ...await response.json(), ...former }) : response
  })
  await expect(env.service().prepare(tenant, { ...request, snapshot }, options, env.read)).rejects.toThrow("formerly synced")
  expect(env.writes).toEqual([])
})

it("cancels the production adapter's throttle wait and resumes after restart", async () => {
  const env = world(1), service = env.service()
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const original = env.fetcher.getMockImplementation()!
  let reached!: () => void, attempts = 0
  const throttled = new Promise<void>(resolve => { reached = resolve })
  env.fetcher.mockImplementation(async (input, init) => {
    if (init?.method === "POST" && ++attempts === 1) { reached(); return new Response(null, { status: 429, headers: { "Retry-After": "60" } }) }
    return original(input, init)
  })
  const request = { ...env.request, runId: page.runId }, approvals = { [page.rows[0]!.key]: page.rows[0]!.review.approvals }
  vi.useFakeTimers()
  try {
    const pending = service.execute(tenant, request, page.fingerprint, approvals)
    await throttled; await service.cancel(tenant, page.runId)
    expect(await pending).toMatchObject({ status: "partial", outcomes: [{ state: "deferred" }] })
    expect(attempts).toBe(1); expect(env.writes).toEqual([])
    const resumed = env.service().execute(tenant, request, page.fingerprint, approvals)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await resumed).toMatchObject({ status: "complete" })
    expect(attempts).toBe(2); expect(env.writes).toHaveLength(1)
  } finally { vi.useRealTimers() }
})

it.each((["Users", "Groups"] as const).flatMap(folder => ["success", "503", "timeout"].map(failure => ({ folder, failure }))))("keeps cancellation plus $failure during the final $folder read resumable with exactly one PATCH", async ({ folder, failure }) => {
  const env = world(), service = env.service()
  const request: IdentityRestoreRequest = folder === "Groups" ? { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved description" } } : { path: `backup/Users/${id(100)}.json`, origin: "restore" as const, snapshot: { id: id(100), displayName: "Saved name", userType: "Member" } }
  const page = await service.prepare(tenant, request, options, env.read)
  const original = env.fetcher.getMockImplementation()!
  const target = `${folder === "Groups" ? "groups" : "users"}/${request.snapshot.id}`
  let release!: () => void, reached!: () => void, reads = 0
  const finalRead = new Promise<void>(resolve => { reached = resolve })
  env.fetcher.mockImplementation(async (input, init) => {
    // Groups rebuild the payload with one extra GET before the final validation reads.
    if (new URL(String(input)).pathname === `/v1.0/${target}` && (!init?.method || init.method === "GET") && ++reads === (folder === "Groups" ? 6 : 5)) {
      reached(); await new Promise<void>(resolve => { release = resolve })
      expect(init?.signal?.aborted).toBe(true)
      if (failure === "503") return new Response(null, { status: 503 })
      if (failure === "timeout") throw new DOMException("Read timed out", "TimeoutError")
    }
    return original(input, init)
  })
  const saved = { ...request, runId: page.runId }, approvals = { [page.rows[0]!.key]: page.rows[0]!.review.approvals }
  const pending = service.execute(tenant, saved, page.fingerprint, approvals)
  await finalRead; await service.cancel(tenant, page.runId); release()
  expect(await pending).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "deferred" }] })
  expect(env.writes).toEqual([])
  const restarted = env.service()
  expect(await restarted.resume(tenant, saved)).toEqual(page)
  expect(await restarted.execute(tenant, saved, page.fingerprint, approvals)).toMatchObject({ status: "complete", failed: 0, outcomes: [{ state: "applied" }] })
  await env.service().execute(tenant, saved, page.fingerprint, approvals)
  expect(env.writes).toEqual([`PATCH ${target}`])
})

it("keeps a throttled group create owned until discard before another backup can create", async () => {
  const env = world(0, true), original = env.fetcher.getMockImplementation()!
  const page = await env.service().prepare(tenant, env.request, options, env.read)
  let sends = 0
  env.fetcher.mockImplementation((input, init) => init?.method === "POST" && ++sends === 1 ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  const approvals = { [page.rows[0]!.key]: page.rows[0]!.review.approvals }
  vi.useFakeTimers()
  try {
    expect(await env.service().execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, approvals)).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "deferred" }] })
    expect([...env.data.keys()].some(key => key.startsWith("restore.directory.unanswered."))).toBe(false)
    const newerRequest = { ...env.request, path: env.request.path.replace("backup/", "newer/") }
    const newer = await env.service().prepare(tenant, newerRequest, options, env.read)
    const newerApprovals = { [newer.rows[0]!.key]: newer.rows[0]!.review.approvals }
    expect(await env.service().execute(tenant, { ...newerRequest, runId: newer.runId }, newer.fingerprint, newerApprovals)).toMatchObject({ status: "partial", failed: 1, outcomes: [{ state: "blocked", reason: expect.stringContaining("owns this object") }] })
    expect(sends).toBe(1); expect(env.writes).toEqual([])
    await env.service().saved(tenant, newer.runId, "discard")
    await env.service().saved(tenant, page.runId, "discard")
    const replacement = await env.service().prepare(tenant, newerRequest, options, env.read)
    await vi.advanceTimersByTimeAsync(120_000)
    // The advisory reference scan still reports its existing missing read access.
    expect(await env.service().execute(tenant, { ...newerRequest, runId: replacement.runId }, replacement.fingerprint, { [replacement.rows[0]!.key]: replacement.rows[0]!.review.approvals })).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "applied", targetId: id(900) }] })
    await expect(env.service().execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, approvals)).rejects.toThrow("discarded")
    expect(sends).toBe(2); expect(env.writes).toEqual(["POST groups"])
  } finally { vi.useRealTimers() }
})

it("keeps a same-page unanswered relationship locked and refuses later rows for that object", async () => {
  const env = world(2), service = env.service(), original = env.fetcher.getMockImplementation()!
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  let sends = 0
  env.fetcher.mockImplementation((input, init) => {
    if (init?.method === "POST") { sends++; return Promise.resolve(new Response(null, { status: 503 })) }
    return original(input, init)
  })
  const request = { ...env.request, runId: page.runId }, approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
  for (let restart = 0; restart < 3; restart++) expect(await env.service().execute(tenant, request, page.fingerprint, approvals)).toMatchObject({ status: "partial", outcomes: [{ state: "uncertain" }, { state: "blocked", reason: expect.stringContaining("unanswered write") }] })
  expect(sends).toBe(1); expect(env.writes).toEqual([])
  expect(Object.keys(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).locks)).toHaveLength(1)
})

it("never sends the 21st member from a discarded page after a completed first batch", async () => {
  const env = world(21), service = env.service(), original = env.fetcher.getMockImplementation()!
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  let sends = 0, release!: () => void, reached!: () => void
  const twentieth = new Promise<void>(resolve => { reached = resolve })
  env.fetcher.mockImplementation(async (input, init) => {
    if (init?.method === "POST" && ++sends === 20) { reached(); await new Promise<void>(resolve => { release = resolve }) }
    return original(input, init)
  })
  const request = { ...env.request, runId: page.runId }, approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
  const pending = service.execute(tenant, request, page.fingerprint, approvals)
  await twentieth
  await expect(service.saved(tenant, page.runId, "discard")).rejects.toThrow("already running")
  expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: true }); release()
  expect(await pending).toMatchObject({ status: "partial" })
  expect(env.writes).toHaveLength(20)
  await service.saved(tenant, page.runId, "discard")
  await expect(env.service().execute(tenant, request, page.fingerprint, approvals)).rejects.toThrow("discarded")
  expect(sends).toBe(20); expect(env.members.has(id(120))).toBe(false)
})

it.each(["current", "legacy"])("recovers a journalled group create before planning when %s mapping publication was interrupted", async version => {
  const env = world(0, true), page = await env.service().prepare(tenant, env.request, options, env.read)
  const set = env.store.set, publish = vi.spyOn(env.store, "set")
  let interrupted = false
  publish.mockImplementation((key, value) => {
    if (!interrupted && key.startsWith("restore.directory.mapping.")) { interrupted = true; throw new Error("Interrupted mapping publication") }
    set(key, value)
  })
  const request = { ...env.request, runId: page.runId }, approvals = { [page.rows[0]!.key]: page.rows[0]!.review.approvals }
  await expect(env.service().execute(tenant, request, page.fingerprint, approvals)).rejects.toThrow("Interrupted mapping")
  if (version === "legacy") {
    env.data.delete(`restore.directory.coordinator.${tenant}`)
    env.data.set(`restore.directory.unanswered.${tenant}.Groups.${resource}`, `restore.directory.${tenant}.${page.runId}.batch.0.`)
  }
  const recovered = await env.service().prepare(tenant, env.request, options, env.read)
  expect(recovered.rows[0]!.review.resource.id).toBe(id(900))
  expect(env.writes).toEqual(["POST groups"])
  expect(Object.keys(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).locks).sort()).toEqual([resource, id(900)].sort())
  await env.service().execute(tenant, request, page.fingerprint, approvals)
  expect(env.writes).toEqual(["POST groups"])
  expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).locks).toEqual({})
})

it("locks a recreated live group ID across backups with different source IDs", async () => {
  const env = world(0, true), page = await env.service().prepare(tenant, env.request, options, env.read)
  await env.service().execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
  const oldRequest = { ...env.request, snapshot: { ...env.request.snapshot, description: "Old source update" } }
  const old = await env.service().prepare(tenant, oldRequest, options, env.read), original = env.fetcher.getMockImplementation()!
  let patches = 0
  env.fetcher.mockImplementation((input, init) => {
    if (init?.method === "PATCH") { patches++; return Promise.resolve(new Response(null, { status: 503 })) }
    return original(input, init)
  })
  expect(await env.service().execute(tenant, { ...oldRequest, runId: old.runId }, old.fingerprint, { [old.rows[0]!.key]: old.rows[0]!.review.approvals })).toMatchObject({ outcomes: [{ state: "uncertain", targetId: id(900) }] })
  const newerRequest = { ...oldRequest, path: `newer/Groups/${id(900)}.json`, snapshot: { ...oldRequest.snapshot, id: id(900), description: "New source update" } }
  const newer = await env.service().prepare(tenant, newerRequest, options, env.read)
  expect(await env.service().execute(tenant, { ...newerRequest, runId: newer.runId }, newer.fingerprint, { [newer.rows[0]!.key]: newer.rows[0]!.review.approvals })).toMatchObject({ outcomes: [{ state: "blocked", reason: expect.stringContaining("owns this object") }] })
  expect(patches).toBe(1); expect(env.writes).toEqual(["POST groups"])
})

it("records cancellation while execute is awaiting its first connection and sends nothing", async () => {
  const env = world(), page = await env.service().prepare(tenant, { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" } }, options, env.read)
  let release!: () => void
  const connection = () => new Promise<Awaited<ReturnType<typeof env.connection>>>(resolve => { release = () => { void env.connection().then(resolve) } })
  const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), connection, env.fetcher, () => [], env.settings)
  const request = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" }, runId: page.runId }
  expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: false })
  const pending = service.execute(tenant, request, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
  expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: true }); release()
  expect(await pending).toMatchObject({ status: "partial" }); expect(env.writes).toEqual([])
  expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: false })
})

it.each((["Users", "Groups"] as const).flatMap(folder => ["area", "service", "access"].map(change => ({ folder, change }))))("checks $folder $change opt-out at preview and at final dispatch", async ({ folder, change }) => {
  const env = world(), service = env.service()
  const request: IdentityRestoreRequest = folder === "Groups" ? { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" } } : { path: `backup/Users/${id(100)}.json`, origin: "restore", snapshot: { id: id(100), displayName: "Saved", userType: "Member" } }
  const page = await service.prepare(tenant, request, options, env.read), original = env.fetcher.getMockImplementation()!
  let reads = 0
  env.fetcher.mockImplementation(async (input, init) => {
    if (new URL(String(input)).pathname.endsWith(`/${request.snapshot.id}`) && init?.method === "GET" && ++reads === (folder === "Groups" ? 6 : 5)) env.settings.setChoice(tenant, change === "service" ? {} : { entra: { access: change === "access" ? "backup" : "restore", areas: change === "area" ? [] : ["usersAndDevices", "groups"] } })
    return original(input, init)
  })
  expect(await service.execute(tenant, { ...request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })).toMatchObject({ outcomes: [{ state: "failed-before-send" }] })
  expect(env.writes).toEqual([])
  await expect(service.prepare(tenant, request, options, env.read)).rejects.toThrow("Backup and restore access")
})
