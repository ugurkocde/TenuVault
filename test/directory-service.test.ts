import { createHash } from "node:crypto"
import { expect, it, vi } from "vitest"
import { DirectoryRestoreService } from "../src/main/restore/directory-service"
import { ModuleSettings } from "../src/main/services/settings"
import { RecoveryAccounts } from "../src/main/restore/safety-resolvers"
import { directoryMappedId } from "../src/main/restore/directory-9a-batches"
import { DIRECTORY_REPLICATION_WINDOW_MS } from "../src/main/restore/directory-relationship-history"
import { restoreFingerprint } from "../src/main/restore/guarded-run"
import { LARGE_SHARD_ITEMS } from "../src/shared/large-backup"
import type { Item } from "../src/shared/intune/registry"
import type { IdentityRestoreRequest } from "../src/main/restore/dispatch"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const tenant = id(1), app = id(2), admin = id(3), resource = id(10)
const options = { stage: "object" as const, exactMembers: false, exactOwners: false }
function world(count = 0, missing = false, now: () => number = Date.now) {
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
  const service = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), connection, fetcher, () => [], settings, now)
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
    if (new URL(String(input)).pathname === `/v1.0/${target}` && (!init?.method || init.method === "GET") && ++reads === (folder === "Groups" ? 5 : 4)) {
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
  expect(await restarted.resume(tenant, saved)).toEqual({ ...page, selection: page.rows.map(row => row.key) })
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
  for (let restart = 0; restart < 3; restart++) expect(await env.service().execute(tenant, request, page.fingerprint, approvals)).toMatchObject({ status: "partial", outcomes: [{ state: "uncertain" }, { state: "deferred" }] })
  expect(sends).toBe(1); expect(env.writes).toEqual([])
  expect(Object.keys(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).locks)).toHaveLength(1)
})

it("never sends the 21st member from a discarded page after a completed first batch", async () => {
  const env = world(41), service = env.service(), original = env.fetcher.getMockImplementation()!
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  let discarded = false
  env.fetcher.mockImplementation(async (input, init) => {
    if (!discarded && new URL(String(input)).pathname.endsWith(`/members/${id(120)}`)) {
      discarded = true
      const prefix = `restore.directory.${tenant}.${page.runId}.`
      expect(JSON.parse(env.data.get(prefix + "cursor")!).batch).toBe(1)
      expect(env.data.has(prefix + "batch.1.plan")).toBe(true)
      expect(env.writes).toHaveLength(20)
      // A separate service represents another desktop window. Its durable discard
      // must stop the current batch at send and the next batch at its entry check.
      expect(await env.service().saved(tenant, page.runId, "discard")).toMatchObject({ discarded: true })
    }
    return original(input, init)
  })
  const request = { ...env.request, runId: page.runId }, approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
  await expect(service.execute(tenant, request, page.fingerprint, approvals)).rejects.toThrow("discarded")
  expect(discarded).toBe(true)
  expect(env.data.has(`restore.directory.${tenant}.${page.runId}.batch.2.plan`)).toBe(false)
  const second = JSON.parse(env.data.get(`restore.directory.${tenant}.${page.runId}.batch.1.restore.guarded.${tenant}`)!).runs[page.runId]
  expect(second.entries[0]).toMatchObject({ state: "failed-before-send" })
  expect(env.writes).toHaveLength(20); expect(env.members.has(id(120))).toBe(false)
  await expect(env.service().execute(tenant, request, page.fingerprint, approvals)).rejects.toThrow("discarded")
})

it("recovers a journalled group create before planning when mapping publication was interrupted", async () => {
  const env = world(0, true), page = await env.service().prepare(tenant, env.request, options, env.read)
  const set = env.store.set, publish = vi.spyOn(env.store, "set")
  let interrupted = false
  publish.mockImplementation((key, value) => {
    if (!interrupted && key.startsWith("restore.directory.mapping.")) { interrupted = true; throw new Error("Interrupted mapping publication") }
    set(key, value)
  })
  const request = { ...env.request, runId: page.runId }, approvals = { [page.rows[0]!.key]: page.rows[0]!.review.approvals }
  await expect(env.service().execute(tenant, request, page.fingerprint, approvals)).rejects.toThrow("Interrupted mapping")
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
    if (new URL(String(input)).pathname.endsWith(`/${request.snapshot.id}`) && init?.method === "GET" && ++reads === (folder === "Groups" ? 5 : 4)) env.settings.setChoice(tenant, change === "service" ? {} : { entra: { access: change === "access" ? "backup" : "restore", areas: change === "area" ? [] : ["usersAndDevices", "groups"] } })
    return original(input, init)
  })
  expect(await service.execute(tenant, { ...request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })).toMatchObject({ outcomes: [{ state: "failed-before-send" }] })
  expect(env.writes).toEqual([])
  await expect(service.prepare(tenant, request, options, env.read)).rejects.toThrow("Backup and restore access")
})

it("rejects stale creates before locking and keeps the mapped target owning page recoverable", async () => {
  const env = world(0, true)
  const first = await env.service().prepare(tenant, env.request, options, env.read)
  const stale = await env.service().prepare(tenant, env.request, options, env.read)
  const execute = (page: typeof first, request = env.request) => env.service().execute(tenant, { ...request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  await execute(first)
  const updateRequest = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" } }
  const update = await env.service().prepare(tenant, updateRequest, options, env.read), original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation((input, init) => init?.method === "PATCH" ? Promise.resolve(new Response(null, { status: 503 })) : original(input, init))
  expect(await execute(update, updateRequest)).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  expect(await execute(stale)).toMatchObject({ outcomes: [{ state: "blocked", reason: expect.stringContaining("mapping") }] })
  expect(Object.keys(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).locks)).toEqual([id(900)])
  expect((await env.service().prepare(tenant, updateRequest, options, env.read)).rows).toHaveLength(1)
  expect(await env.service().saved(tenant, update.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  await env.service().saved(tenant, stale.runId, "discard")
  env.group.description = "Saved"
  expect(await env.service().saved(tenant, update.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied" }] })
  expect(await env.service().saved(tenant, update.runId, "discard")).toMatchObject({ discarded: true })
  expect(env.writes).toEqual(["POST groups"])
})

it("retains resolved live-object deadlines after discard across competing backups", async () => {
  const env = world(0, true), created = await env.service().prepare(tenant, env.request, options, env.read)
  await env.service().execute(tenant, { ...env.request, runId: created.runId }, created.fingerprint, Object.fromEntries(created.rows.map(row => [row.key, row.review.approvals])))
  const request = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" } }
  const page = await env.service().prepare(tenant, request, options, env.read), original = env.fetcher.getMockImplementation()!
  let sends = 0
  env.fetcher.mockImplementation((input, init) => init?.method === "PATCH" && ++sends === 1 ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  const execute = (p: typeof page, r = request) => env.service().execute(tenant, { ...r, runId: p.runId }, p.fingerprint, Object.fromEntries(p.rows.map(row => [row.key, row.review.approvals])))
  vi.useFakeTimers()
  try {
    const deadline = Date.now() + 120_000
    expect(await execute(page)).toMatchObject({ outcomes: [{ state: "deferred", retryAt: deadline }] })
    const competitorRequest = { ...request, path: `newer/Groups/${id(900)}.json`, snapshot: { ...request.snapshot, id: id(900) } }
    const competitor = await env.service().prepare(tenant, competitorRequest, options, env.read)
    expect(await execute(competitor, competitorRequest)).toMatchObject({ outcomes: [{ state: "blocked", reason: expect.stringContaining("owns this object") }] })
    await env.service().saved(tenant, page.runId, "discard")
    const state = JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!)
    expect(state.deadlines[id(900)]).toBe(deadline); expect(state.deadlines[resource]).toBeUndefined()
    const replacement = await env.service().prepare(tenant, competitorRequest, options, env.read)
    expect(await execute(replacement, competitorRequest)).toMatchObject({ outcomes: [{ state: "deferred", retryAt: deadline }] })
    expect(sends).toBe(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await execute(replacement, competitorRequest)).toMatchObject({ outcomes: [{ state: "applied" }] })
    expect(sends).toBe(2)
  } finally { vi.useRealTimers() }
})

it("finishes a dispatched create after cancellation and durably retains its returned identity", async () => {
  const env = world(0, true), service = env.service(), page = await service.prepare(tenant, env.request, options, env.read), original = env.fetcher.getMockImplementation()!
  let reached!: () => void, release!: () => void
  const sent = new Promise<void>(resolve => { reached = resolve })
  env.fetcher.mockImplementation(async (input, init) => {
    if (init?.method === "POST") {
      reached(); await new Promise<void>(resolve => { release = resolve })
      expect(init.signal?.aborted).toBe(false)
      init.signal?.throwIfAborted()
    }
    return original(input, init)
  })
  const request = { ...env.request, runId: page.runId }, approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
  const pending = service.execute(tenant, request, page.fingerprint, approvals)
  await sent; expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: true }); release()
  expect(await pending).toMatchObject({ outcomes: [{ state: "applied", targetId: id(900) }] })
  expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied", targetId: id(900) }] })
  expect((await env.service().prepare(tenant, env.request, options, env.read)).rows[0]!.review.resource.id).toBe(id(900))
  expect(env.writes).toEqual(["POST groups"])
})

it("does not mark a write uncertain when saving its send marker fails", async () => {
  const env = world(), request = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" } }
  const page = await env.service().prepare(tenant, request, options, env.read), set = env.store.set
  let failed = false
  vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (!failed && key.includes("restore.guarded.") && value.includes('"state":"uncertain"')) { failed = true; throw new Error("Disk unavailable") }
    set(key, value)
  })
  await expect(env.service().execute(tenant, { ...request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).rejects.toThrow("Disk unavailable")
  expect((await env.service().resume(tenant, { ...request, runId: page.runId })).canDiscard).toBe(true)
  const journal = JSON.parse(env.data.get(`restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`)!)
  expect(journal.runs[page.runId].entries[0].state).toBe("captured")
  expect(failed).toBe(true); expect(env.writes).toEqual([])
  expect(await env.service().saved(tenant, page.runId, "discard")).toMatchObject({ discarded: true })
})

it("resumes later approved rows after the same object's uncertain relationship resolves", async () => {
  const env = world(2), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read), original = env.fetcher.getMockImplementation()!
  let sends = 0
  env.fetcher.mockImplementation(async (input, init) => {
    if (init?.method === "POST" && ++sends === 1) return new Response(null, { status: 503 })
    return original(input, init)
  })
  const execute = () => env.service().execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  expect(await execute()).toMatchObject({ outcomes: [{ state: "uncertain" }, { state: "deferred" }] })
  expect(sends).toBe(1)
  env.members.add(id(100))
  expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied" }, { state: "deferred" }] })
  expect(await execute()).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }, { state: "applied" }] })
  expect(sends).toBe(2); expect(env.members).toEqual(new Set([id(100), id(101)]))
})

it("uses one fresh snapshot for inventory review and refuses an already matching row", async () => {
  const env = world(51), service = env.service()
  const first = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  env.members.add(id(150))
  const original = env.fetcher.getMockImplementation()!
  let relationshipReads = 0, principalReads = 0
  env.fetcher.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path === `/v1.0/groups/${resource}/members/${id(150)}`) {
      relationshipReads++
      const response = await original(input, init)
      // A second read would see absence and disagree with the captured preview.
      env.members.delete(id(150))
      return response
    }
    if (path === `/v1.0/users/${id(150)}`) principalReads++
    return original(input, init)
  })
  const next = await service.prepare(tenant, env.request, { ...options, stage: "relationships", previousRunId: first.runId }, env.read)
  expect(relationshipReads).toBe(1); expect(principalReads).toBe(1)
  expect(next.rows).toHaveLength(1)
  expect(next.rows[0]!.review.changes).toEqual([])
  expect(next.rows[0]!.review.blocker).toContain("already matches")
  const saved = JSON.parse(env.data.get(`restore.directory.review.${tenant}.${next.runId}`)!)
  expect(saved.run.entries[0].step.preview).toBe(restoreFingerprint({ id: resource, present: true, principalId: id(150), resource: env.group, principal: { id: id(150), displayName: "Person", userType: "Member", accountEnabled: false, "@odata.type": "#microsoft.graph.user" } }))
  await expect(service.execute(tenant, { ...env.request, runId: next.runId }, next.fingerprint, Object.fromEntries(next.rows.map(row => [row.key, row.review.approvals])))).rejects.toThrow("Approve each")
  expect(env.writes).toEqual([])
})

it("keeps mapping lookup pure after production create recovery", async () => {
  const env = world(0, true), page = await env.service().prepare(tenant, env.request, options, env.read)
  await env.service().execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  const before = new Map(env.data), get = vi.spyOn(env.store, "get"), set = vi.spyOn(env.store, "set"), remove = vi.spyOn(env.store, "delete")
  for (let lookup = 0; lookup < 100; lookup++) expect(directoryMappedId(env.store, tenant, "Groups", resource)).toBe(id(900))
  expect(get).toHaveBeenCalledTimes(100); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
  expect(env.data).toEqual(before)
})

it.each([1, Infinity])("never repeats a confirmed group create after %s applied-result save failures", async failures => {
  const env = world(0, true), page = await env.service().prepare(tenant, env.request, options, env.read)
  const original = env.store.set
  let saves = 0
  const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key.includes(".restore.guarded.") && JSON.parse(value).runs[page.runId]?.entries.some((entry: { state: string }) => entry.state === "applied") && ++saves <= failures) throw new Error("Result storage unavailable")
    original(key, value)
  })
  const execute = (p: typeof page) => env.service().execute(tenant, { ...env.request, runId: p.runId }, p.fingerprint, Object.fromEntries(p.rows.map(row => [row.key, row.review.approvals])))
  if (failures === 1) {
    expect(await execute(page)).toMatchObject({ outcomes: [{ state: "applied", targetId: id(900) }] })
    expect(saves).toBe(3)
  } else {
    await expect(execute(page)).rejects.toThrow("Result storage unavailable")
    const journal = JSON.parse(env.data.get(`restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`)!)
    expect(journal.runs[page.runId].entries[0].state).toBe("uncertain")
    expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).locks[resource].owner).toBe(page.runId)
  }
  spy.mockRestore()
  const fresh = await env.service().prepare(tenant, env.request, options, env.read)
  if (failures === 1) {
    expect(fresh.rows[0]!.review.resource.id).toBe(id(900))
    expect(await execute(page)).toMatchObject({ outcomes: [{ state: "applied", targetId: id(900) }] })
  } else {
    expect(await execute(fresh)).toMatchObject({ outcomes: [{ state: "blocked", reason: expect.stringContaining("owns this object") }] })
    expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "uncertain" }] })
    await expect(env.service().saved(tenant, page.runId, "discard")).rejects.toThrow("uncertain")
  }
  expect(env.writes).toEqual(["POST groups"])
})

it("refuses conflicting stored create mappings before changing either object lock", async () => {
  const env = world(0, true), page = await env.service().prepare(tenant, env.request, options, env.read)
  const original = env.store.set
  const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key.startsWith("restore.directory.mapping.")) throw new Error("Publication stopped")
    original(key, value)
  })
  await expect(env.service().execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).rejects.toThrow("Publication stopped")
  spy.mockRestore()
  const coordinator = `restore.directory.coordinator.${tenant}`, mapping = `restore.directory.mapping.${tenant}.objectId.Groups.${resource}`
  const state = JSON.parse(env.data.get(coordinator)!)
  delete state.locks[id(900)]
  env.data.set(coordinator, JSON.stringify(state)); env.data.set(mapping, id(901))
  const before = env.data.get(coordinator)
  await expect(env.service().prepare(tenant, env.request, options, env.read)).rejects.toThrow("stored mapping or ownership conflicts")
  expect(env.data.get(coordinator)).toBe(before); expect(env.data.get(mapping)).toBe(id(901))
  // An unrelated source still previews and executes normally.
  const request = { ...env.request, path: `other/Groups/${id(900)}.json`, snapshot: { ...env.request.snapshot, id: id(900), description: "Other" } }
  const other = await env.service().prepare(tenant, request, options, env.read)
  expect(await env.service().execute(tenant, { ...request, runId: other.runId }, other.fingerprint, Object.fromEntries(other.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ outcomes: [{ state: "applied" }] })
  expect(env.writes.filter(write => write === "POST groups")).toHaveLength(1)
})

it.each(["empty", "unparseable", "unknown", "invalid object", "invalid journal"])("refuses %s coordinator state per object without changing it", async kind => {
  const env = world(), request = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" } }
  const page = await env.service().prepare(tenant, request, options, env.read)
  const coordinator = `restore.directory.coordinator.${tenant}`
  const raw = kind === "empty" ? "" : kind === "unparseable" ? "{" : kind === "unknown" ? JSON.stringify({ oldOwner: "unknown" }) : JSON.stringify({ locks: { [resource]: kind === "invalid object" ? { owner: 5 } : { owner: page.runId, journal: "unknown" } }, deadlines: {}, discarded: {} })
  env.data.set(coordinator, raw)
  const execution = env.service().execute(tenant, { ...request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  if (kind === "invalid object") await execution
  else await expect(execution).rejects.toThrow("could not be verified")
  const journal = JSON.parse(env.data.get(`restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`)!)
  expect(journal.runs[page.runId]).toMatchObject({ entries: [{ state: "blocked", reason: expect.stringContaining(`state for object ${resource} could not be verified`) }] })
  expect(env.data.get(coordinator)).toBe(raw); expect(env.writes).toEqual([])
})

it("ignores unrelated damaged coordinator records and obsolete directory state", async () => {
  const env = world(), request = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" } }
  env.data.set(`restore.directory.coordinator.${tenant}`, JSON.stringify({ locks: { [id(999)]: { owner: "stale", journal: "unparseable" } }, deadlines: { [id(999)]: "bad" }, discarded: {} }))
  for (const kind of ["object", "unanswered", "owner", "superseded"]) env.data.set(`restore.directory.${kind}.${tenant}.Groups.${resource}`, "{")
  const page = await env.service().prepare(tenant, request, options, env.read)
  expect(await env.service().execute(tenant, { ...request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ outcomes: [{ state: "applied" }] })
  expect(env.writes).toEqual([`PATCH groups/${resource}`])
})

it.each(["actor", "read-back"])("keeps a %s throttle on the recreated live identity after confirmation and discard", async phase => {
  const env = world(0, true), create = await env.service().prepare(tenant, env.request, options, env.read)
  const execute = (p: typeof create, request = env.request) => env.service().execute(tenant, { ...request, runId: p.runId }, p.fingerprint, Object.fromEntries(p.rows.map(row => [row.key, row.review.approvals])))
  await execute(create)
  const request = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" } }
  const page = await env.service().prepare(tenant, request, options, env.read), original = env.fetcher.getMockImplementation()!
  let throttle = false, sends = 0
  env.fetcher.mockImplementation((input, init) => {
    if (init?.method === "PATCH") { sends++; return Promise.resolve(new Response(null, { status: 503 })) }
    if (throttle && new URL(String(input)).pathname === (phase === "actor" ? "/v1.0/applications" : `/v1.0/groups/${id(900)}`)) { throttle = false; return Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) }
    return original(input, init)
  })
  vi.useFakeTimers()
  try {
    expect(await execute(page, request)).toMatchObject({ outcomes: [{ state: "uncertain" }] })
    throttle = true
    const deadline = Date.now() + 120_000
    if (phase === "actor") await expect(env.service().saved(tenant, page.runId, "reconcile")).rejects.toThrow("throttled")
    else expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "uncertain", retryAt: deadline }] })
    const journal = JSON.parse(env.data.get(`restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`)!)
    expect(journal.runs[page.runId].entries[0]).toMatchObject({ state: "uncertain", retryAt: deadline, targetId: id(900) })
    const state = JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!)
    expect(state.deadlines[id(900)]).toBe(deadline); expect(state.deadlines[resource]).toBeUndefined()
    env.group.description = "Saved"
    const calls = env.fetcher.mock.calls.length
    expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "uncertain", retryAt: deadline }] })
    expect(env.fetcher).toHaveBeenCalledTimes(calls)
    const readBacks = () => env.fetcher.mock.calls.filter(([input]) => new URL(String(input)).pathname === `/v1.0/groups/${id(900)}`).length
    const reads = readBacks()
    expect(await execute(page, request)).toMatchObject({ outcomes: [{ state: "uncertain", retryAt: deadline }] })
    expect(readBacks()).toBe(reads)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied" }] })
    await env.service().saved(tenant, page.runId, "discard")
    // Recheck the surviving live-ID deadline with the clock from before confirmation.
    vi.setSystemTime(deadline - 120_000)
    const newer = { ...request, path: `newer/Groups/${id(900)}.json`, snapshot: { ...request.snapshot, id: id(900), description: "Newer" } }
    const replacement = await env.service().prepare(tenant, newer, options, env.read)
    expect(await execute(replacement, newer)).toMatchObject({ outcomes: [{ state: "deferred", retryAt: deadline }] })
    expect(sends).toBe(1)
  } finally { vi.useRealTimers() }
})



it.each(["uncertain", "applied"].flatMap(state => ["cycle", "missing", "prerequisite"].map(dependency => ({ state, dependency }))))("never blocks a $state entry for a $dependency dependency during saved confirmation", async ({ state, dependency }) => {
  const env = world(2), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const original = env.fetcher.getMockImplementation()!
  let sends = 0
  env.fetcher.mockImplementation((input, init) => {
    if (init?.method === "POST" && ++sends === 2 && state === "uncertain") return Promise.resolve(new Response(null, { status: 503 }))
    return original(input, init)
  })
  expect(await env.service().execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ outcomes: [{ state: "applied" }, { state }] })
  const prefix = `restore.directory.${tenant}.${page.runId}.batch.0.`, key = prefix + `restore.guarded.${tenant}`
  const journal = JSON.parse(env.data.get(key)!), run = journal.runs[page.runId], entry = run.entries[1]
  entry.step.requires = [dependency === "cycle" ? entry.step.key : dependency === "missing" ? "missing" : run.entries[0].step.key]
  if (dependency === "prerequisite") run.entries[0].state = "failed"
  env.data.set(key, JSON.stringify(journal))
  const plan = JSON.parse(env.data.get(prefix + "plan")!)
  plan.entries[1].step = entry.step
  env.data.set(prefix + "plan", JSON.stringify(plan))
  expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{}, { state }] })
  expect(JSON.parse(env.data.get(key)!).runs[page.runId].entries[1].state).toBe(state)
  expect(sends).toBe(2)
})

it("refuses release of a confirmed create when coordinator state becomes invalid", async () => {
  const env = world(0, true), page = await env.service().prepare(tenant, env.request, options, env.read), set = env.store.set
  vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    set(key, value)
    if (key.startsWith("restore.directory.mapping.")) env.data.set(`restore.directory.coordinator.${tenant}`, "{")
  })
  await expect(env.service().execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).rejects.toThrow("could not be verified")
  const journal = JSON.parse(env.data.get(`restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`)!)
  expect(journal.runs[page.runId].entries[0]).toMatchObject({ state: "applied", targetId: id(900) })
  expect(env.data.get(`restore.directory.coordinator.${tenant}`)).toBe("{")
  expect(env.writes).toEqual(["POST groups"])
})

it.each(["throw", "drop"])("reports discard only after its marker is durably saved despite a %s failure", async failure => {
  const env = world(), request = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" } }, page = await env.service().prepare(tenant, request, options, env.read)
  const set = env.store.set
  const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key === `restore.directory.coordinator.${tenant}` && JSON.parse(value).discarded[page.runId]) {
      if (failure === "throw") throw new Error("Discard storage unavailable")
      return
    }
    set(key, value)
  })
  await expect(env.service().saved(tenant, page.runId, "discard")).rejects.toThrow(failure === "throw" ? "Discard storage unavailable" : "discard marker could not be verified")
  expect(env.data.get(`restore.directory.coordinator.${tenant}`)).toBeUndefined()
  expect((await env.service().resume(tenant, { ...request, runId: page.runId })).canDiscard).toBe(true)
  spy.mockRestore()
  expect(await env.service().saved(tenant, page.runId, "discard")).toEqual({ discarded: true, canDiscard: false })
  expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).discarded[page.runId]).toBe(true)
  expect(env.writes).toEqual([])
})


it("keeps an approved add uncertain while read-back may predate our acknowledged removal", async () => {
  let now = Date.now()
  const env = world(2, false, () => now), original = env.fetcher.getMockImplementation()!
  env.members.add(id(100)); env.members.add(id(101))
  let stale = false, adds = 0
  env.fetcher.mockImplementation((input, init) => {
    const path = new URL(String(input)).pathname
    if (init?.method === "POST" && path.endsWith("/members/$ref")) { adds++; return Promise.resolve(new Response(null, { status: 503 })) }
    if (stale && path === `/beta/groups/${resource}/members`) return Promise.resolve(Response.json({ value: [id(100), id(101)].map(id => ({ id })) }))
    if (stale && path === `/v1.0/groups/${resource}/members/${id(101)}`) return Promise.resolve(Response.json({ id: id(101) }))
    return original(input, init)
  })
  const empty = { ...env.request, snapshot: { ...env.request.snapshot, members: { ...env.request.snapshot.owners } } }
  const exact = { ...options, stage: "relationships" as const, exactMembers: true }
  const removeB = await env.service().prepare(tenant, empty, exact, async () => [])
  const execute = (page: typeof removeB, request: typeof env.request, principal: string) => {
    const row = page.rows.find(row => row.review.principal?.id === principal)!
    expect(row.review.blocker).toBeUndefined()
    return env.service().execute(tenant, { ...request, runId: page.runId }, page.fingerprint, { [row.key]: row.review.approvals })
  }
  expect(await execute(removeB, empty, id(101))).toMatchObject({ outcomes: [{ state: "applied" }] })
  const addB = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(await execute(addB, env.request, id(101))).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  expect([...env.members]).toEqual([id(100)])
  stale = true
  expect(await env.service().saved(tenant, addB.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "uncertain", reason: expect.stringContaining("recent acknowledged write in the opposite direction") }] })
  const journal = JSON.parse(env.data.get(`restore.directory.${tenant}.${addB.runId}.batch.0.restore.guarded.${tenant}`)!)
  expect(journal.runs[addB.runId].entries[0].acknowledged).toBeUndefined()
  expect(journal.runs[addB.runId].entries[0].state).toBe("uncertain")
  now += DIRECTORY_REPLICATION_WINDOW_MS - 1
  expect(await env.service().saved(tenant, addB.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  now++
  expect(await env.service().saved(tenant, addB.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied" }] })
  expect(adds).toBe(1)
  expect(env.writes).toEqual([`DELETE groups/${resource}/members/${id(101)}/$ref`])
  expect([...env.members]).toEqual([id(100)])
})

it.each(["matching", "wrong step", "wrong attempt"])("recovers a rejected group create from a coordinator-only deadline with a %s marker", async marker => {
  const env = world(0, true), page = await env.service().prepare(tenant, env.request, options, env.read), original = env.fetcher.getMockImplementation()!
  let posts = 0, failures = 0
  env.fetcher.mockImplementation((input, init) => init?.method === "POST" && new URL(String(input)).pathname === "/v1.0/groups" && ++posts === 1 ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  vi.useFakeTimers()
  try {
    const deadline = Date.now() + 120_000, set = env.store.set
    const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
      if (key.includes(".restore.guarded.") && value.includes(String(deadline))) { failures++; throw new Error("Journal storage unavailable") }
      set(key, value)
    })
    const execute = () => env.service().execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
    await expect(execute()).rejects.toThrow("retry deadline could not be saved")
    expect(failures).toBe(2); expect(posts).toBe(1); expect(env.writes).toEqual([])
    const journalKey = `restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`
    const entry = JSON.parse(env.data.get(journalKey)!).runs[page.runId].entries[0]
    expect(entry).toMatchObject({ state: "uncertain", attempt: 1 })
    const coordinatorKey = `restore.directory.coordinator.${tenant}`, state = JSON.parse(env.data.get(coordinatorKey)!)
    expect(state.deadlines[resource]).toBe(deadline)
    expect(state.locks[resource].rejected).toEqual({ step: entry.step.key, attempt: 1 })
    if (marker === "wrong step") state.locks[resource].rejected.step = "different-step"
    if (marker === "wrong attempt") state.locks[resource].rejected.attempt++
    env.data.set(coordinatorKey, JSON.stringify(state))
    spy.mockRestore()
    const calls = env.fetcher.mock.calls.length
    expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "uncertain", retryAt: deadline }] })
    expect(env.fetcher).toHaveBeenCalledTimes(calls)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: marker === "matching" ? "deferred" : "uncertain", retryAt: deadline }] })
    expect(posts).toBe(1)
    if (marker === "matching") {
      expect(await execute()).toMatchObject({ outcomes: [{ state: "applied", targetId: id(900) }] })
      await execute()
      expect(posts).toBe(2); expect(env.writes).toEqual(["POST groups"])
    } else {
      expect(await execute()).toMatchObject({ outcomes: [{ state: "uncertain" }] })
      expect(posts).toBe(1); expect(env.writes).toEqual([])
    }
  } finally { vi.useRealTimers() }
})

it("preserves batch numbers across a journal gap when saving an actor throttle", async () => {
  const env = world(21), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(await env.service().execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ status: "complete", batches: 2 })
  const prefix = `restore.directory.${tenant}.${page.runId}.`, first = prefix + `batch.0.restore.guarded.${tenant}`, second = prefix + `batch.1.restore.guarded.${tenant}`
  const before = JSON.parse(env.data.get(second)!).runs[page.runId]
  env.data.delete(first)
  const original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname === "/v1.0/applications" ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  vi.useFakeTimers()
  try {
    const deadline = Date.now() + 120_000
    await expect(env.service().saved(tenant, page.runId, "reconcile")).rejects.toThrow("throttled")
    expect(env.data.has(first)).toBe(false)
    const after = JSON.parse(env.data.get(second)!).runs[page.runId]
    expect(after).toEqual({ ...before, entries: before.entries.map((entry: object) => ({ ...entry, retryAt: deadline })) })
    expect(env.writes).toHaveLength(21)
  } finally { vi.useRealTimers() }
})

it("creates the next approved batch only on execution after confirming member 20", async () => {
  const env = world(21), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read), original = env.fetcher.getMockImplementation()!
  let posts = 0
  env.fetcher.mockImplementation(async (input, init) => {
    const response = await original(input, init)
    return init?.method === "POST" && ++posts === 20 ? new Response(null, { status: 503 }) : response
  })
  const request = { ...env.request, runId: page.runId }, approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
  const execute = () => env.service().execute(tenant, request, page.fingerprint, approvals)
  expect(await execute()).toMatchObject({ status: "partial", outcomes: [...Array.from({ length: 19 }, () => ({ state: "applied" })), { state: "uncertain" }] })
  expect(posts).toBe(20)
  expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ status: "partial", outcomes: Array.from({ length: 20 }, () => ({ state: "applied" })) })
  expect(env.data.has(`restore.directory.${tenant}.${page.runId}.batch.1.plan`)).toBe(false)
  expect(posts).toBe(20)
  expect((await env.service().resume(tenant, request)).selection).toEqual(page.rows.map(row => row.key))
  expect(await execute()).toMatchObject({ status: "complete", failed: 0, outcomes: Array.from({ length: 21 }, () => ({ state: "applied" })) })
  await execute()
  expect(posts).toBe(21); expect(env.writes).toHaveLength(21); expect(env.members).toEqual(new Set(env.saved))
})

it.each(["capture", "send marker", "coordinator", "relationship history"])("retries approved rows after a %s storage failure without terminalizing them", async phase => {
  const env = world(1), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read), set = env.store.set
  const request = { ...env.request, runId: page.runId }, approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
  let failures = 0
  const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    const matches = phase === "coordinator" ? key.includes(".coordinator.") : phase === "relationship history" ? key.includes(".relationship-history.") : key.includes(".restore.guarded.") && value.includes(`"state":"${phase === "capture" ? "captured" : "uncertain"}"`)
    if (!failures && matches) { failures++; throw new Error("Injected storage failure") }
    set(key, value)
  })
  await expect(env.service().execute(tenant, request, page.fingerprint, approvals)).rejects.toThrow("Injected storage failure")
  expect(failures).toBe(1); expect(env.writes).toEqual([])
  const journal = JSON.parse(env.data.get(`restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`)!)
  expect(journal.runs[page.runId].entries[0].state).toBe(phase === "send marker" ? "captured" : "pending")
  spy.mockRestore()
  expect((await env.service().resume(tenant, request)).selection).toEqual([page.rows[0]!.key])
  const reads = env.fetcher.mock.calls.length
  expect(await env.service().execute(tenant, request, page.fingerprint, approvals)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(env.fetcher.mock.calls.length).toBeGreaterThan(reads)
  await env.service().execute(tenant, request, page.fingerprint, approvals)
  expect(env.writes).toEqual([`POST groups/${resource}/members/$ref`])
})

it.each(["user", "client", "tenant"].flatMap(identity => ["reconcile", "resume", "discard"].map(action => ({ identity, action }))))("refuses saved $action data for a different $identity before Graph reads during Retry-After", async ({ identity, action }) => {
  const env = world(1), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read), original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation((input, init) => init?.method === "POST" ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  expect(await env.service().execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ outcomes: [{ state: "deferred" }] })
  const connection = { ...await env.connection(), ...(identity === "tenant" ? { tenantId: id(990) } : identity === "client" ? { clientId: id(991) } : { userId: id(992) }) }
  connection.token = `h.${Buffer.from(JSON.stringify({ tid: connection.tenantId, oid: connection.userId, appid: connection.clientId, scp: "GroupMember.ReadWrite.All" })).toString("base64url")}.s`
  const other = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), async () => connection, env.fetcher, () => [], env.settings)
  const before = new Map(env.data), calls = env.fetcher.mock.calls.length
  const result = action === "resume" ? other.resume(tenant, { ...env.request, runId: page.runId }) : other.saved(tenant, page.runId, action as "reconcile" | "discard")
  await expect(result).rejects.toThrow("admin and connection that reviewed")
  expect(env.fetcher).toHaveBeenCalledTimes(calls); expect(env.data).toEqual(before); expect(env.writes).toEqual([])
})

it("returns and enforces the original row selection when resuming a partial page", async () => {
  const env = world(3), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read), original = env.fetcher.getMockImplementation()!
  const selected = [page.rows[0]!, page.rows[2]!], approvals = Object.fromEntries(selected.map(row => [row.key, row.review.approvals])), request = { ...env.request, runId: page.runId }
  env.fetcher.mockImplementation((input, init) => init?.method === "POST" ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  vi.useFakeTimers()
  try {
    expect(await env.service().execute(tenant, request, page.fingerprint, approvals)).toMatchObject({ outcomes: [{ state: "deferred" }, { state: "deferred" }] })
    expect((await env.service().resume(tenant, request)).selection).toEqual(selected.map(row => row.key))
    await expect(env.service().execute(tenant, request, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).rejects.toThrow("original selection")
    expect(env.writes).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    env.fetcher.mockImplementation(original)
    expect(await env.service().execute(tenant, request, page.fingerprint, approvals)).toMatchObject({ status: "complete" })
    expect(env.members).toEqual(new Set([id(100), id(102)])); expect(env.writes).toHaveLength(2)
  } finally { vi.useRealTimers() }
})

it.each([false, true])("confirms an elapsed uncertain entry alongside a future deferred deadline with same object %s", async sameObject => {
  const env = world(2), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read), original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation(async (input, init) => {
    const response = await original(input, init)
    return init?.method === "POST" ? new Response(null, { status: 503 }) : response
  })
  expect(await env.service().execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ outcomes: [{ state: "uncertain" }, { state: "deferred" }] })
  const journalKey = `restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`, journal = JSON.parse(env.data.get(journalKey)!)
  const [uncertain, deferred] = journal.runs[page.runId].entries
  uncertain.retryAt = Date.now() - 1000
  deferred.retryAt = Date.now() + 120_000
  if (!sameObject) {
    // The journal fixture includes a deferred entry for a different object in the saved batch.
    deferred.step.targetId = deferred.targetId = id(999)
    const planKey = `restore.directory.${tenant}.${page.runId}.batch.0.plan`, plan = JSON.parse(env.data.get(planKey)!)
    plan.entries[1].step.targetId = id(999)
    env.data.set(planKey, JSON.stringify(plan))
  }
  env.data.set(journalKey, JSON.stringify(journal))
  const calls = env.fetcher.mock.calls.length
  expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: sameObject ? "uncertain" : "applied" }, { state: "deferred" }] })
  if (sameObject) expect(env.fetcher).toHaveBeenCalledTimes(calls)
  else expect(env.fetcher.mock.calls.length).toBeGreaterThan(calls)
  expect(env.writes).toEqual([`POST groups/${resource}/members/$ref`])
})

it.each(["within writer", "after resume"])("clears a step's rejected marker after success %s while the page stays locked", async mode => {
  const env = world(2), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read), original = env.fetcher.getMockImplementation()!
  let posts = 0
  env.fetcher.mockImplementation((input, init) => {
    if (init?.method === "POST" && ++posts !== 2) return Promise.resolve(new Response(null, { status: posts === 1 ? 429 : 503, headers: { "Retry-After": mode === "within writer" ? "1" : "120" } }))
    return original(input, init)
  })
  const execute = () => env.service().execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  vi.useFakeTimers()
  try {
    const pending = execute()
    await vi.advanceTimersByTimeAsync(0)
    const coordinator = `restore.directory.coordinator.${tenant}`
    expect(posts).toBe(1)
    expect(JSON.parse(env.data.get(coordinator)!).locks[resource].rejected).toEqual({ step: page.rows[0]!.key, attempt: 1 })
    if (mode === "after resume") {
      expect(await pending).toMatchObject({ outcomes: [{ state: "deferred" }, { state: "deferred" }] })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(await execute()).toMatchObject({ outcomes: [{ state: "applied" }, { state: "uncertain" }] })
    } else {
      await vi.advanceTimersByTimeAsync(1000)
      expect(await pending).toMatchObject({ outcomes: [{ state: "applied" }, { state: "uncertain" }] })
    }
    expect(JSON.parse(env.data.get(coordinator)!).locks[resource]).toMatchObject({ owner: page.runId })
    expect(JSON.parse(env.data.get(coordinator)!).locks[resource].rejected).toBeUndefined()
    expect(posts).toBe(3); expect(env.writes).toHaveLength(1)
  } finally { vi.useRealTimers() }
})



it.each(["same session", "restart"])("retains a rejected group create through loss of both retry records in %s", async mode => {
  const env = world(0, true), service = env.service(), original = env.fetcher.getMockImplementation()!
  const page = await service.prepare(tenant, env.request, options, env.read)
  let posts = 0
  env.fetcher.mockImplementation((input, init) => init?.method === "POST" && ++posts === 1 ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  vi.useFakeTimers()
  try {
    const deadline = Date.now() + 120_000, set = env.store.set
    const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
      if (value.includes(String(deadline))) throw new Error("Storage unavailable")
      set(key, value)
    })
    const request = { ...env.request, runId: page.runId }, approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
    await expect(service.execute(tenant, request, page.fingerprint, approvals)).rejects.toThrow("retry deadline could not be saved")
    expect(posts).toBe(1)
    const journalKey = `restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`
    const entry = JSON.parse(env.data.get(journalKey)!).runs[page.runId].entries[0]
    expect(entry).toMatchObject({ state: "uncertain", attempt: 1 })
    expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).deadlines).toEqual({})
    const calls = env.fetcher.mock.calls.length
    if (mode === "same session") {
      await expect(service.saved(tenant, page.runId, "reconcile")).rejects.toThrow("retry deadline could not be saved")
      expect(env.fetcher).toHaveBeenCalledTimes(calls)
    }
    spy.mockRestore()
    const current = mode === "same session" ? service : env.service()
    expect(await current.saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: mode === "same session" ? "deferred" : "uncertain" }] })
    if (mode === "same session") {
      expect(env.fetcher).toHaveBeenCalledTimes(calls)
      const state = JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!)
      expect(state.deadlines[resource]).toBe(deadline)
      expect(state.locks[resource].rejected).toEqual({ step: entry.step.key, attempt: 1 })
    }
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await current.execute(tenant, request, page.fingerprint, approvals)).toMatchObject({ outcomes: [{ state: mode === "same session" ? "applied" : "uncertain" }] })
    expect(posts).toBe(mode === "same session" ? 2 : 1)
    expect(env.writes).toEqual(mode === "same session" ? ["POST groups"] : [])
  } finally { vi.useRealTimers() }
})

it("persists the first validated selection before a throttled actor lookup", async () => {
  const env = world(3), service = env.service(), page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const original = env.fetcher.getMockImplementation()!, rows = page.rows.slice(0, 2), request = { ...env.request, runId: page.runId }
  const approvals = Object.fromEntries(rows.map(row => [row.key, row.review.approvals]))
  env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname === "/v1.0/applications" ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  vi.useFakeTimers()
  try {
    await expect(service.execute(tenant, request, page.fingerprint, approvals)).rejects.toThrow("throttled")
    expect(JSON.parse(env.data.get(`restore.directory.review.${tenant}.${page.runId}`)!).selection).toEqual(rows.map(row => row.key))
    expect(env.writes).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    env.fetcher.mockImplementation(original)
    expect(await env.service().resume(tenant, request)).toMatchObject({ selection: rows.map(row => row.key) })
    await expect(env.service().execute(tenant, request, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).rejects.toThrow("original selection")
    expect(await env.service().execute(tenant, request, page.fingerprint, approvals)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }, { state: "applied" }] })
    expect([...env.members]).toEqual(env.saved.slice(0, 2))
    expect(env.writes).toHaveLength(2)
  } finally { vi.useRealTimers() }
})

it("retains a review row's throttle deadline when deferring its preview", async () => {
  const env = world(), original = env.fetcher.getMockImplementation()!
  env.members.add(id(100)); env.members.add(id(101))
  env.fetcher.mockImplementation((input, init) => String(input).includes("conditionalAccess") ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  vi.useFakeTimers()
  try {
    const deadline = Date.now() + 120_000
    const page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: true }, env.read)
    expect(page.rows).toHaveLength(2)
    expect(page.rows.every(row => row.review.blocker?.includes("Resume after Retry-After"))).toBe(true)
    expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).deadlines[resource]).toBe(deadline)
    env.fetcher.mockImplementation(original)
    const fresh = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: true }, env.read)
    expect(await env.service().execute(tenant, { ...env.request, runId: fresh.runId }, fresh.fingerprint, Object.fromEntries(fresh.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ outcomes: [{ state: "deferred", retryAt: deadline }, { state: "deferred", retryAt: deadline }] })
    expect(env.writes).toEqual([])
  } finally { vi.useRealTimers() }
})

it.each(["included", "excluded", "malformed", "unreadable", "incomplete next page"])("blocks exact removals on their preview row for %s Conditional Access targeting", async mode => {
  const known = mode === "included" || mode === "excluded"
  const env = world(known ? 1 : 0), original = env.fetcher.getMockImplementation()!
  env.members.add(id(101)); env.members.add(id(102))
  env.fetcher.mockImplementation((input, init) => {
    const url = String(input)
    if (!url.includes("conditionalAccess")) return original(input, init)
    if (mode === "unreadable" || url.includes("skiptoken")) return Promise.resolve(new Response(null, { status: 403 }))
    return Promise.resolve(Response.json({ value: [{ conditions: { users: { includeGroups: mode === "malformed" ? ["invalid"] : mode === "included" ? [resource.toUpperCase()] : [], excludeGroups: mode === "excluded" ? [resource] : [] } } }], ...(mode === "incomplete next page" ? { "@odata.nextLink": "https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies?$skiptoken=next" } : {}) }))
  })
  const service = env.service(), page = await service.prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: true }, env.read)
  expect(page.rows).toHaveLength(known ? 3 : 2)
  const removals = page.rows.filter(row => row.review.changes.some(change => change.after === false))
  expect(removals).toHaveLength(2)
  expect(removals.every(row => row.review.blocker?.includes("remove the member in Microsoft Entra") || row.review.blocker?.includes("Remove the member in Microsoft Entra"))).toBe(true)
  await expect(service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(removals.map(row => [row.key, row.review.approvals])))).rejects.toThrow("Approve each")
  if (mode === "included") {
    const add = page.rows.find(row => row.review.principal?.id === id(100))!
    expect(add.review.blocker).toBeUndefined()
    expect(await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, { [add.key]: add.review.approvals })).toMatchObject({ outcomes: [{ state: "applied" }] })
    const request = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved description" } }
    const metadata = await service.prepare(tenant, request, options, env.read)
    expect(await service.execute(tenant, { ...request, runId: metadata.runId }, metadata.fingerprint, { [metadata.rows[0]!.key]: metadata.rows[0]!.review.approvals })).toMatchObject({ outcomes: [{ state: "applied" }] })
  }
  expect(env.writes.every(write => !write.startsWith("DELETE"))).toBe(true)
})

it.each(["included", "excluded", "unreadable", "malformed"])("refuses an approved ordinary removal when Conditional Access becomes %s at final send", async mode => {
  const env = world(), service = env.service(), original = env.fetcher.getMockImplementation()!
  env.members.add(id(100))
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: true }, env.read)
  expect(page.rows[0]!.review.blocker).toBeUndefined()
  let policies = 0
  env.fetcher.mockImplementation((input, init) => {
    if (!String(input).includes("conditionalAccess") || ++policies === 1) return original(input, init)
    return Promise.resolve(mode === "unreadable" ? new Response(null, { status: 403 }) : Response.json({ value: [{ conditions: { users: { includeGroups: mode === "included" ? [resource] : [], ...(mode === "malformed" ? {} : { excludeGroups: mode === "excluded" ? [resource] : [] }) } } }] }))
  })
  expect(await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ outcomes: [{ state: "failed-before-send" }] })
  expect(policies).toBe(2)
  expect(env.writes).toEqual([])
  expect([...env.members]).toEqual([id(100)])
})

it.each(["execute", "reconcile"])("keeps an uncertain removal unconfirmed after our acknowledged add via %s until the window expires", async action => {
  let now = Date.now(), stale = false, deletes = 0
  const env = world(1, false, () => now), service = env.service(), original = env.fetcher.getMockImplementation()!
  const added = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  await service.execute(tenant, { ...env.request, runId: added.runId }, added.fingerprint, Object.fromEntries(added.rows.map(row => [row.key, row.review.approvals])))
  const request = { ...env.request, snapshot: { ...env.request.snapshot, members: env.request.snapshot.owners } }
  const removal = await service.prepare(tenant, request, { ...options, stage: "relationships", exactMembers: true }, async () => [])
  env.fetcher.mockImplementation((input, init) => {
    if (init?.method === "DELETE") { deletes++; return Promise.resolve(new Response(null, { status: 503 })) }
    if (stale && new URL(String(input)).pathname === `/v1.0/groups/${resource}/members/${id(100)}`) return Promise.resolve(new Response(null, { status: 404 }))
    return original(input, init)
  })
  const execute = () => service.execute(tenant, { ...request, runId: removal.runId }, removal.fingerprint, Object.fromEntries(removal.rows.map(row => [row.key, row.review.approvals])))
  expect(await execute()).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  stale = true
  const confirm = () => action === "execute" ? execute() : service.saved(tenant, removal.runId, "reconcile")
  expect(await confirm()).toMatchObject({ outcomes: [{ state: "uncertain", reason: expect.stringContaining("opposite direction") }] })
  now += DIRECTORY_REPLICATION_WINDOW_MS - 1
  expect(await confirm()).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  now++
  expect(await confirm()).toMatchObject({ outcomes: [{ state: "applied" }] })
  expect(deletes).toBe(1)
  expect(env.writes).toEqual([`POST groups/${resource}/members/$ref`])
})

it.each([true, false])("retains an acknowledged relationship present=%s across failed result saves and stale read-back", async present => {
  const env = world(present ? 1 : 0), service = env.service(), original = env.fetcher.getMockImplementation()!
  if (!present) env.members.add(id(100))
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: !present }, env.read)
  const set = env.store.set, journalKey = `restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`
  const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key === journalKey && value.includes('"acknowledged":true')) throw new Error("Result storage unavailable")
    set(key, value)
  })
  await expect(service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).rejects.toThrow("Result storage unavailable")
  expect(JSON.parse(env.data.get(journalKey)!).runs[page.runId].entries[0].state).toBe("uncertain")
  env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname === `/v1.0/groups/${resource}/members/${id(100)}` ? Promise.resolve(present ? new Response(null, { status: 404 }) : Response.json({ id: id(100) })) : original(input, init))
  const calls = env.fetcher.mock.calls.length
  await expect(service.saved(tenant, page.runId, "reconcile")).rejects.toThrow("Result storage unavailable")
  expect(env.fetcher.mock.calls).toHaveLength(calls)
  spy.mockRestore()
  expect(await service.saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied" }] })
  expect(JSON.parse(env.data.get(journalKey)!).runs[page.runId].entries[0]).toMatchObject({ state: "applied", acknowledged: true, acknowledgedAt: expect.any(Number) })
  expect(env.writes).toHaveLength(1)
})

it("keeps owner additions admitted for Conditional Access included groups", async () => {
  const env = world(1), service = env.service()
  caGroup(env)
  const request = { ...env.request, snapshot: { ...env.request.snapshot, owners: env.request.snapshot.members, members: env.request.snapshot.owners } }
  const page = await service.prepare(tenant, request, { ...options, stage: "relationships" }, env.read)
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]!.review.privilege).toBe("owner")
  expect(page.rows[0]!.review.blocker).toBeUndefined()
  expect(await service.execute(tenant, { ...request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ outcomes: [{ state: "applied" }] })
  expect(env.writes).toEqual([`POST groups/${resource}/owners/$ref`])
})

it("keeps a matching relationship uncertain when its reconciliation history cannot be read", async () => {
  const env = world(1), service = env.service(), page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read), original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation(async (input, init) => {
    const response = await original(input, init)
    return init?.method === "POST" ? new Response(null, { status: 503 }) : response
  })
  expect(await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  env.data.set(`restore.directory.relationship-history.${tenant}.${resource}`, "{")
  expect(await service.saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  expect(env.writes).toEqual([`POST groups/${resource}/members/$ref`])
})

it("refuses a removal retry if Conditional Access begins targeting the group during backoff", async () => {
  const env = world(), service = env.service(), original = env.fetcher.getMockImplementation()!
  env.members.add(id(100))
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: true }, env.read)
  let attempts = 0
  env.fetcher.mockImplementation((input, init) => {
    if (init?.method === "DELETE") { attempts++; return Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "1" } })) }
    if (attempts && String(input).includes("conditionalAccess")) return Promise.resolve(Response.json({ value: [{ conditions: { users: { includeGroups: [resource], excludeGroups: [] } } }] }))
    return original(input, init)
  })
  vi.useFakeTimers()
  try {
    const pending = service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toMatchObject({ outcomes: [{ state: "failed-before-send" }] })
    expect(attempts).toBe(1)
    expect(env.writes).toEqual([])
    expect([...env.members]).toEqual([id(100)])
  } finally { vi.useRealTimers() }
})
