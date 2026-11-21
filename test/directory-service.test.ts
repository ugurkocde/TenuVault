import { unsetUserFields, unsetGroupFields } from "./fixtures/directory-response"
import { rejectProxyAuthResponses, withNetworkErrors } from "../src/main/api/network-error"
import { planGuard } from "../src/main/api/plan-gates"
import { DirectoryPendingPublications } from "../src/main/restore/directory-pending-publications"
import { setDirectoryRestoreService } from "../src/main/restore/directory-dispatch"
import { POST as restoreDirectory } from "../src/portal/app/api/restore-directory/route"
import { RestoreSafetyError, RestoreWriteDeferredError } from "../src/shared/intune/restore-guards"
import { DirectoryReadDeferredError, DirectoryRetryPersistenceError } from "../src/main/restore/directory-retry"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { backupNeed } from "../src/shared/services/modules"
import { ApiHost } from "../src/main/api/host"
import { createAuditRecorder } from "../src/main/api/audit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DirectoryRestoreStore } from "../src/main/storage/directory-restore-store"
import { createHash } from "node:crypto"
import { expect, it, vi } from "vitest"
import { DirectoryRestoreService } from "../src/main/restore/directory-service"
import { ModuleSettings } from "../src/main/services/settings"
import { RecoveryAccounts } from "../src/main/restore/safety-resolvers"
import { directoryMappedId } from "../src/main/restore/directory-9a-batches"
import { directoryObjectState, directoryPagePrefix, directoryMappingKey } from "../src/main/restore/directory-object-state"
import { DIRECTORY_REPLICATION_WINDOW_MS } from "../src/main/restore/directory-relationship-history"
import { GuardedRunJournal, restoreFingerprint, restorePersistence, RestorePersistenceError } from "../src/main/restore/guarded-run"
import { LARGE_SHARD_ITEMS } from "../src/shared/large-backup"
import type { Item } from "../src/shared/intune/registry"
import type { IdentityRestoreRequest } from "../src/main/restore/dispatch"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const tenant = id(1), app = id(2), admin = id(3), resource = id(10)
const options = { stage: "object" as const, exactMembers: false, exactOwners: false }
function world(count = 0, missing = false, now: () => number = () => Date.now(), fixtureTenant = tenant) {
  const tenant = fixtureTenant
  let target = missing ? "" : resource
  const data = new Map<string, string>(), members = new Set<string>(), writes: string[] = []
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const settings = new ModuleSettings(store)
  settings.setChoice(tenant, { entra: { access: "restore", areas: ["usersAndDevices", "groups"] } })
  const group: Item = { ...unsetGroupFields, id: resource, displayName: "Group", mailNickname: "group", groupTypes: [], mailEnabled: false, securityEnabled: true, isAssignableToRole: false }
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
    if (path === `roleManagement/directory/roleDefinitions/${id(50)}`) return Response.json({ id: id(50), templateId: "fdd7a751-b60b-444a-984c-02652fe8fa1c" })
    if (path === `groups/${target}`) return Response.json(group)
    if (path === `groups/${resource}/members`) return Response.json({ value: [...members].map(id => ({ id })) })
    if (path === `groups/${resource}/owners`) return Response.json({ value: [] })
    if (path.startsWith(`groups/${resource}/members/`)) return members.has(path.split("/")[3]!) ? Response.json({ id: path.split("/")[3] }) : new Response(null, { status: 404 })
    if (path.startsWith("users/")) return Response.json({ ...unsetUserFields, id: path.split("/")[1], displayName: "Person", userType: "Member", accountEnabled: false })
    return new Response(null, { status: 404 })
  })
  const connection = async () => ({ token, tenantId: tenant, clientId: app, userId: admin })
  const service = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), connection, connection, fetcher, () => [], settings, now)
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
  await expect(service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)).rejects.toThrow(DirectoryReadDeferredError)
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
  expect(await restarted.resume(tenant, saved)).toEqual({ ...page, unresolved: true, selection: page.rows.map(row => row.key), outcomes: [{ key: page.rows[0]!.key, state: "deferred", reason: "The directory write was cancelled before sending.", retryAt: undefined, targetId: request.snapshot.id }] })
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
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const connection = () => new Promise<Awaited<ReturnType<typeof env.connection>>>(resolve => { release = () => { void env.connection().then(resolve) }; entered() })
  const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), connection, env.connection, env.fetcher, () => [], env.settings)
  const request = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" }, runId: page.runId }
  expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: false })
  const pending = service.execute(tenant, request, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
  await started
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
  expect(saved.run.entries[0].step.preview).toBe(restoreFingerprint({ id: resource, present: true, principalId: id(150), resource: env.group, principal: { ...unsetUserFields, id: id(150), displayName: "Person", userType: "Member", accountEnabled: false, "@odata.type": "#microsoft.graph.user" } }))
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
  expect(await env.service().saved(tenant, page.runId, "discard")).toEqual({ ...page, discarded: true, unresolved: false, canDiscard: false })
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
  expect(await execute()).toMatchObject({ status: "partial", outcomes: [...Array.from({ length: 19 }, () => ({ state: "applied" })), { state: "uncertain" }, { state: "pending" }] })
  expect(posts).toBe(20)
  expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ status: "partial", outcomes: [...Array.from({ length: 20 }, () => ({ state: "applied" })), { state: "pending" }] })
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
  const other = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), async () => connection, async () => connection, env.fetcher, () => [], env.settings)
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
    await expect(env.service().prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: true }, env.read)).rejects.toThrow("Resume after Retry-After")
    expect([...env.data.keys()].some(key => key.startsWith("restore.directory.review."))).toBe(false)
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
  const env = world(2), service = env.service(), original = env.fetcher.getMockImplementation()!
  env.members.add(id(100)); env.members.add(id(101)); env.members.add(id(102))
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
  expect([...env.members]).toEqual([id(100), id(101), id(102)])
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
  const env = world(2), service = env.service(), original = env.fetcher.getMockImplementation()!
  env.members.add(id(100)); env.members.add(id(101)); env.members.add(id(102))
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
    expect([...env.members]).toEqual([id(100), id(101), id(102)])
  } finally { vi.useRealTimers() }
})


it("keeps an in-flight member add applied when resume meets actor throttling and unavailable storage", async () => {
  const env = world(1), service = env.service(), original = env.fetcher.getMockImplementation()!
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  let release!: () => void, started!: () => void
  const sent = new Promise<void>(resolve => { started = resolve })
  const response = new Promise<void>(resolve => { release = resolve })
  let throttle = false
  env.fetcher.mockImplementation(async (input, init) => {
    if (init?.method === "POST") { started(); await response }
    if (throttle && new URL(String(input)).pathname === "/v1.0/applications") return new Response(null, { status: 429, headers: { "Retry-After": "120" } })
    return original(input, init)
  })
  const execution = service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  await sent
  throttle = true
  const spy = vi.spyOn(env.store, "set").mockImplementation(() => { throw new Error("Storage unavailable") })
  const calls = env.fetcher.mock.calls.length
  await expect(service.resume(tenant, { ...env.request, runId: page.runId })).rejects.toThrow("already running")
  for (const action of ["reconcile", "discard"] as const) await expect(service.saved(tenant, page.runId, action)).rejects.toThrow("already running")
  expect(env.fetcher.mock.calls).toHaveLength(calls)
  spy.mockRestore(); throttle = false; release()
  expect(await execution).toMatchObject({ outcomes: [{ state: "applied" }], canDiscard: true })
  env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname.includes(`/members/${id(100)}`) ? Promise.resolve(new Response(null, { status: 404 })) : original(input, init))
  expect(await service.saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied" }], canDiscard: true })
  expect(env.writes).toEqual([`POST groups/${resource}/members/$ref`])
  expect(await service.saved(tenant, page.runId, "discard")).toEqual({ ...page, selection: page.rows.map(row => row.key), discarded: true, unresolved: false, canDiscard: false, outcomes: [{ key: page.rows[0]!.key, state: "applied", targetId: resource, reason: undefined, retryAt: undefined }] })
})

it("retains a preview policy deadline after one failed save before a description PATCH", async () => {
  const env = world(), service = env.service(), original = env.fetcher.getMockImplementation()!
  env.members.add(id(100))
  vi.useFakeTimers()
  try {
    const deadline = Date.now() + 120_000, set = env.store.set
    let failed = false
    const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
      if (!failed && key.includes(".coordinator.") && value.includes(String(deadline))) { failed = true; throw new Error("Deadline storage unavailable") }
      set(key, value)
    })
    env.fetcher.mockImplementation((input, init) => String(input).includes("conditionalAccess") ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
    await expect(service.prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: true }, env.read)).rejects.toThrow("Resume after Retry-After")
    expect([...env.data.keys()].some(key => key.startsWith("restore.directory.review."))).toBe(false)
    expect(failed).toBe(true)
    spy.mockRestore(); env.fetcher.mockImplementation(original)
    const request = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved description" } }
    const page = await service.prepare(tenant, request, options, env.read)
    const execute = () => service.execute(tenant, { ...request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
    expect(await execute()).toMatchObject({ outcomes: [{ state: "deferred", retryAt: deadline }] })
    expect(env.writes).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await execute()).toMatchObject({ outcomes: [{ state: "applied" }] })
    expect(env.writes).toEqual([`PATCH groups/${resource}`])
  } finally { vi.useRealTimers() }
})

it("confirms and discards an authenticated cancelled page without a journal or backup", async () => {
  const env = world(1), service = env.service()
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  let loaded!: () => void, release!: () => void
  const loading = new Promise<void>(resolve => { loaded = resolve })
  const backup = new Promise<void>(resolve => { release = resolve })
  const operation = service.operation(tenant, page.runId, async signal => {
    loaded(); await backup
    if (signal.aborted) throw new Error("Cancelled while loading backup")
  })
  await loading
  expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: true })
  release(); expect(await operation).toEqual({ cancelled: true })
  // Saved confirmation has no backup reader or snapshot input.
  expect(await service.saved(tenant, page.runId, "reconcile")).toMatchObject({ ...page, status: "nothing-sent", outcomes: [], canDiscard: true })
  expect(await service.saved(tenant, page.runId, "discard")).toEqual({ ...page, discarded: true, unresolved: false, canDiscard: false })
  expect(env.writes).toEqual([])
})

it("retains both concurrent preview deadlines for the same object and flushes before connection reads", async () => {
  const env = world(1), original = env.fetcher.getMockImplementation()!, connection = vi.fn(env.connection)
  const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), connection, env.connection, env.fetcher, () => [], env.settings)
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  let entered!: () => void, release!: () => void, actors = 0
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  env.fetcher.mockImplementation(async (input, init) => {
    if (new URL(String(input)).pathname === "/v1.0/applications") {
      const index = ++actors
      if (actors === 2) entered()
      await gate
      return new Response(null, { status: 429, headers: { "Retry-After": String(index === 1 ? 180 : 120) } })
    }
    return original(input, init)
  })
  vi.useFakeTimers()
  try {
    const firstDeadline = Date.now() + 180_000, secondDeadline = Date.now() + 120_000
    const spy = vi.spyOn(env.store, "set").mockImplementation(() => { throw new Error("Storage unavailable") })
    const previews = [service.prepare(tenant, env.request, options, env.read), service.prepare(tenant, env.request, options, env.read)]
    const settled = Promise.allSettled(previews)
    await started; release()
    expect((await settled).every(result => result.status === "rejected")).toBe(true)
    const calls = env.fetcher.mock.calls.length, connections = connection.mock.calls.length
    await expect(service.resume(tenant, { ...env.request, runId: page.runId })).rejects.toThrow("retry deadline could not be saved")
    expect(env.fetcher.mock.calls).toHaveLength(calls); expect(connection).toHaveBeenCalledTimes(connections)
    spy.mockRestore(); env.fetcher.mockImplementation(original)
    await service.resume(tenant, { ...env.request, runId: page.runId })
    expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).deadlines[resource]).toBe(firstDeadline)
    expect(firstDeadline).toBeGreaterThan(secondDeadline)
  } finally { vi.useRealTimers() }
})

it("merges a retained actor deadline without overwriting a result confirmed by another service", async () => {
  const env = world(1), service = env.service(), original = env.fetcher.getMockImplementation()!
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  env.fetcher.mockImplementation(async (input, init) => {
    const response = await original(input, init)
    return init?.method === "POST" ? new Response(null, { status: 503 }) : response
  })
  expect(await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  vi.useFakeTimers()
  try {
    const deadline = Date.now() + 120_000
    env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname === "/v1.0/applications" ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
    const spy = vi.spyOn(env.store, "set").mockImplementation(() => { throw new Error("Storage unavailable") })
    await expect(service.resume(tenant, { ...env.request, runId: page.runId })).rejects.toThrow("retry deadline could not be saved")
    spy.mockRestore(); env.fetcher.mockImplementation(original)
    expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied" }] })
    // The delayed publication must reload that newer outcome, even when read-back is now stale.
    env.members.clear()
    expect(await service.saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied", retryAt: deadline }], canDiscard: true })
    expect(env.writes).toEqual([`POST groups/${resource}/members/$ref`])
    expect(await service.saved(tenant, page.runId, "discard")).toEqual({ ...page, selection: page.rows.map(row => row.key), discarded: true, unresolved: false, canDiscard: false, outcomes: [{ key: page.rows[0]!.key, state: "applied", targetId: resource, reason: undefined, retryAt: deadline }] })
  } finally { vi.useRealTimers() }
})

it("merges a retained acknowledgement without replacing newer outcomes in the same batch", async () => {
  const env = world(2), service = env.service()
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const journalKey = `restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`
  const set = env.store.set
  const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key === journalKey && value.includes('"acknowledged":true')) throw new Error("Result storage unavailable")
    set(key, value)
  })
  const execute = (service: DirectoryRestoreService) => service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  await expect(execute(service)).rejects.toThrow("Result storage unavailable")
  spy.mockRestore()
  const other = env.service()
  expect(await execute(other)).toMatchObject({ outcomes: [{ state: "applied" }, { state: "applied" }] })
  env.members.clear()
  expect(await service.saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied" }, { state: "applied" }], canDiscard: true })
  const entries = JSON.parse(env.data.get(journalKey)!).runs[page.runId].entries
  expect(entries.every((entry: { acknowledged?: boolean }) => entry.acknowledged)).toBe(true)
  expect(env.writes).toEqual([`POST groups/${resource}/members/$ref`, `POST groups/${resource}/members/$ref`])
})

it.each([resource, id(999)])("defers a running write for an unsaved concurrent preview deadline on %s", async previewSource => {
  const env = world(), service = env.service(), original = env.fetcher.getMockImplementation()!
  const request = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" } }
  const page = await service.prepare(tenant, request, options, env.read)
  let entered!: () => void, release!: () => void, hold = true, throttle = false
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  env.fetcher.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    if (throttle && path === "/v1.0/applications") return new Response(null, { status: 429, headers: { "Retry-After": "120" } })
    if (hold && path === `/v1.0/groups/${resource}`) { hold = false; entered(); await gate }
    return original(input, init)
  })
  vi.useFakeTimers()
  try {
    const deadline = Date.now() + 120_000
    const execute = () => service.execute(tenant, { ...request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
    const running = execute()
    await started
    const set = env.store.set
    const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
      if (key.includes(".coordinator.") && value.includes(String(deadline))) throw new Error("Deadline storage unavailable")
      set(key, value)
    })
    throttle = true
    const preview = { ...env.request, path: `backup/Groups/${previewSource}.json`, snapshot: { ...env.request.snapshot, id: previewSource } }
    await expect(service.prepare(tenant, preview, options, env.read)).rejects.toThrow("retry deadline could not be saved")
    throttle = false; spy.mockRestore(); release()
    expect(await running).toMatchObject({ outcomes: [{ state: "deferred", retryAt: deadline }] })
    expect(env.writes).toEqual([])
    expect((await service.resume(tenant, { ...request, runId: page.runId })).selection).toEqual(page.rows.map(row => row.key))
    await vi.advanceTimersByTimeAsync(119_999)
    expect(env.writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(await execute()).toMatchObject({ outcomes: [{ state: "applied" }] })
    expect(env.writes).toEqual([`PATCH groups/${resource}`])
  } finally { vi.useRealTimers() }
})

it.each([false, true])("transfers a concurrent source deadline to a recreated group with unsaved=%s", async unsaved => {
  const env = world(0, true), service = env.service(), original = env.fetcher.getMockImplementation()!
  const page = await service.prepare(tenant, env.request, options, env.read)
  let entered!: () => void, release!: () => void, throttle = false
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  env.fetcher.mockImplementation(async (input, init) => {
    if (throttle && new URL(String(input)).pathname === "/v1.0/applications") return new Response(null, { status: 429, headers: { "Retry-After": "120" } })
    if (init?.method === "POST") { entered(); await gate }
    return original(input, init)
  })
  vi.useFakeTimers()
  try {
    const deadline = Date.now() + 120_000
    const creating = service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
    await started
    const set = env.store.set
    const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
      if (unsaved && key.includes(".coordinator.") && value.includes(String(deadline))) throw new Error("Deadline storage unavailable")
      set(key, value)
    })
    throttle = true
    await expect(service.prepare(tenant, env.request, options, env.read)).rejects.toThrow(unsaved ? "retry deadline could not be saved" : "throttled")
    throttle = false; spy.mockRestore(); release()
    expect(await creating).toMatchObject({ outcomes: [{ state: "applied", targetId: id(900) }] })
    const request = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" } }
    const update = await service.prepare(tenant, request, options, env.read)
    const state = JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!)
    expect(state.deadlines[id(900)]).toBe(deadline); expect(state.deadlines[resource]).toBeUndefined()
    const execute = () => service.execute(tenant, { ...request, runId: update.runId }, update.fingerprint, Object.fromEntries(update.rows.map(row => [row.key, row.review.approvals])))
    expect(await execute()).toMatchObject({ outcomes: [{ state: "deferred", retryAt: deadline }] })
    expect(env.writes).toEqual(["POST groups"])
    await vi.advanceTimersByTimeAsync(119_999)
    expect(env.writes).toEqual(["POST groups"])
    await vi.advanceTimersByTimeAsync(1)
    expect(await execute()).toMatchObject({ outcomes: [{ state: "applied" }] })
    expect(env.writes).toEqual(["POST groups", `PATCH groups/${id(900)}`])
  } finally { vi.useRealTimers() }
})

it("audits the original authenticated admin when the account switches during a directory write", async () => {
  const env = world(1), original = env.fetcher.getMockImplementation()!
  let account = { username: "original@example.test", name: "Original admin" }
  const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), async () => ({ ...await env.connection(), auditActor: { ...account } }), env.connection, env.fetcher, () => [], env.settings)
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  env.fetcher.mockImplementation(async (input, init) => {
    if (init?.method === "POST") { entered(); await gate }
    return original(input, init)
  })
  const entries: unknown[] = [], accountFor = vi.fn(() => ({ ...account, tenantId: tenant, clientId: app }))
  const host = new ApiHost({
    routes: { "/api/restore-directory": { POST: async () => {
      const result = await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
      return Response.json({ ...result, success: true, directoryActor: { username: "spoof@example.test" }, details: { restoredCount: 1, failedCount: 0 } })
    } } },
    onHandled: createAuditRecorder(async request => { entries.push(await request.json()); return Response.json({ success: true }) }, accountFor),
  })
  const execution = host.dispatch(new Request("http://tenuvault.internal/api/restore-directory", { method: "POST", headers: { "content-type": "application/json", "x-directory-actor": "spoof@example.test" }, body: JSON.stringify({ tenantId: tenant, appId: app, clientSecret: "delegated", storageAccountName: "fixtureaccount", action: "restore", directoryActor: { username: "spoof@example.test" } }) }))
  await started
  account = { username: "replacement@example.test", name: "Replacement admin" }
  release()
  expect((await execution).ok).toBe(true)
  await vi.waitFor(() => expect(entries).toHaveLength(1))
  expect(entries[0]).toMatchObject({ user: { id: "original@example.test", email: "original@example.test", name: "Original admin" }, logEntry: { result: "SUCCESS" } })
  expect(accountFor).not.toHaveBeenCalled()
  expect(env.writes).toEqual([`POST groups/${resource}/members/$ref`])
})

it.each(["before preview", "after preview"])("recovers a recreated user's journal mapping %s and protects exact membership", async recovery => {
  const env = world(1), service = env.service(), original = env.fetcher.getMockImplementation()!
  const source = id(100), target = id(900)
  const userRequest: IdentityRestoreRequest = { origin: "restore", path: `backup/Users/${source}.json`, snapshot: { id: source, userType: "Member", displayName: "Saved user", userPrincipalName: "saved@example.test", mailNickname: "saved", accountEnabled: false } }
  let release!: () => void, entered!: () => void
  const sent = new Promise<void>(resolve => { entered = resolve }), responseGate = new Promise<void>(resolve => { release = resolve })
  env.fetcher.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path === "/v1.0/users" && init?.method === "POST") {
      env.members.add(target); env.writes.push("POST users"); entered()
      if (recovery === "after preview") await responseGate
      return Response.json({ id: target }, { status: 201 })
    }
    if (path === "/v1.0/users") return Response.json({ value: [] })
    if (path === `/v1.0/users/${source}`) return new Response(null, { status: 404 })
    if (path === `/v1.0/users/${target}`) return Response.json({ ...unsetUserFields, ...userRequest.snapshot, id: target })
    return original(input, init)
  })
  const user = await service.prepare(tenant, userRequest, options, env.read)
  env.members.add(target); env.members.add(id(200))
  const stale = recovery === "after preview" ? await service.prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: true }, env.read) : undefined
  const set = env.store.set
  const publication = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key.startsWith("restore.directory.mapping.")) throw new Error("Interrupted mapping publication")
    set(key, value)
  })
  const create = service.execute(tenant, { ...userRequest, runId: user.runId }, user.fingerprint, Object.fromEntries(user.rows.map(row => [row.key, row.review.approvals])))
  // Observe the failure immediately so the held-response variant has no unhandled rejection.
  const interrupted = expect(create).rejects.toThrow("Interrupted mapping publication")
  await sent
  env.members.add(id(200))
  const exactOptions = { ...options, stage: "relationships" as const, exactMembers: true }
  if (recovery === "before preview") {
    await interrupted
    await expect(service.prepare(tenant, env.request, exactOptions, env.read)).rejects.toThrow("Interrupted mapping publication")
    publication.mockRestore()
    const fresh = await service.prepare(tenant, env.request, exactOptions, env.read)
    expect(directoryMappedId(env.store, tenant, "Users", source)).toBe(target)
    expect(fresh.rows.map(row => row.key)).toEqual([`Groups:${resource}:member:${id(200)}`])
  } else {
    const removal = stale!.rows.find(row => row.key.endsWith(target))!
    expect(removal.review.changes).toEqual([{ property: "present", before: true, after: false }])
    release(); await interrupted
    await expect(service.execute(tenant, { ...env.request, runId: stale!.runId }, stale!.fingerprint, { [removal.key]: removal.review.approvals })).rejects.toBeInstanceOf(RestorePersistenceError)
    publication.mockRestore()
    // Final validation itself must recover the failed publication and reject the old difference.
    expect(await service.execute(tenant, { ...env.request, runId: stale!.runId }, stale!.fingerprint, { [removal.key]: removal.review.approvals })).toMatchObject({ failed: 1, outcomes: [{ state: "failed-before-send" }] })
    expect(directoryMappedId(env.store, tenant, "Users", source)).toBe(target)
    const fresh = await service.prepare(tenant, env.request, exactOptions, env.read)
    expect(fresh.rows.map(row => row.key)).toEqual([`Groups:${resource}:member:${id(200)}`])
    expect(fresh.fingerprint).not.toBe(stale!.fingerprint)
  }
  expect(env.writes).toEqual(["POST users"])
  expect(env.members).toEqual(new Set([target, id(200)]))
})

it("refuses exact removal when an unchanged saved principal mapping changes during final safety reads", async () => {
  const env = world(2), service = env.service(), target = id(900)
  env.saved.forEach(id => env.members.add(id)); env.members.add(target)
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: true }, env.read)
  expect(page.rows).toHaveLength(1)
  const original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation(async (input, init) => {
    if (String(input).includes("conditionalAccess")) env.data.set(`restore.directory.mapping.${tenant}.objectId.Users.${id(101)}`, target)
    return original(input, init)
  })
  expect(await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })).toMatchObject({ failed: 1, outcomes: [{ state: "failed-before-send" }] })
  expect(env.writes).toEqual([])
  expect(env.members).toEqual(new Set([id(100), id(101), target]))
})

it.each(["object", "members", "policy"])("publishes a preview %s read deadline before its internal wait and defers an approved same-group PATCH", async phase => {
  const env = world(), service = env.service()
  env.members.add(id(100))
  const request = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" } }
  const page = await service.prepare(tenant, request, options, env.read), original = env.fetcher.getMockImplementation()!
  let throttle = true, reached!: () => void
  const throttled = new Promise<void>(resolve => { reached = resolve })
  env.fetcher.mockImplementation((input, init) => {
    const path = new URL(String(input)).pathname
    if (throttle && (phase === "object" ? path === `/v1.0/groups/${resource}` : phase === "members" ? path === `/beta/groups/${resource}/members` : path.includes("conditionalAccess"))) {
      throttle = false; reached()
      return Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "1" } }))
    }
    return original(input, init)
  })
  vi.useFakeTimers()
  try {
    const deadline = Date.now() + 1000
    const preview = service.prepare(tenant, env.request, phase === "object" ? options : { ...options, stage: "relationships", exactMembers: true }, env.read)
    await throttled
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).deadlines[resource]).toBe(deadline)
    const execution = service.execute(tenant, { ...request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
    await vi.advanceTimersByTimeAsync(999)
    expect(env.writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await preview
    expect(await execution).toMatchObject({ outcomes: [{ state: "applied" }] })
    expect(env.writes).toEqual([`PATCH groups/${resource}`])
  } finally { vi.useRealTimers() }
})

it("counts a current-batch failure alongside a deferred row in directory audit totals", async () => {
  const env = world(2), service = env.service()
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read), original = env.fetcher.getMockImplementation()!
  let sends = 0
  env.fetcher.mockImplementation((input, init) => {
    if (init?.method === "POST") return Promise.resolve(new Response(null, { status: ++sends === 1 ? 403 : 429, headers: { "Retry-After": "120" } }))
    return original(input, init)
  })
  const entries: unknown[] = []
  const host = new ApiHost({
    routes: { "/api/restore-directory": { POST: async () => {
      const result = await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
      return Response.json({ ...result, success: result.status === "complete", partial: result.status === "partial", details: { restoredCount: 0, partialCount: result.outcomes.filter(row => ["pending", "captured", "deferred", "uncertain"].includes(row.state)).length, failedCount: result.failed } })
    } } },
    onHandled: createAuditRecorder(async request => { entries.push(await request.json()); return Response.json({ success: true }) }, () => null),
  })
  const result = await host.dispatch(new Request("http://tenuvault.internal/api/restore-directory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantId: tenant, appId: app, clientSecret: "delegated", storageAccountName: "fixtureaccount", action: "restore" }) }))
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ failed: 1, outcomes: [{ state: "failed" }, { state: "deferred" }] })
  await vi.waitFor(() => expect(entries).toHaveLength(1))
  expect(entries[0]).toMatchObject({ logEntry: { result: "PARTIAL", details: { failedCount: 1, partialCount: 1, restoredCount: 0 } } })
  expect(sends).toBe(2); expect(env.writes).toEqual([])
})

it.each(["preview", "final validation"].flatMap(phase => [false, true].map(missingLock => ({ phase, missingLock }))))("defers every exact removal for an uncertain saved user create at $phase with missing lock $missingLock", async ({ phase, missingLock }) => {
  const env = world(1), service = env.service(), original = env.fetcher.getMockImplementation()!, source = id(100), target = id(900)
  const userRequest: IdentityRestoreRequest = { origin: "restore", path: `backup/Users/${source}.json`, snapshot: { id: source, userType: "Member", displayName: "Saved user", userPrincipalName: "saved@example.test", mailNickname: "saved", accountEnabled: false } }
  let created = false, confirmed = false
  env.members.add(target); env.members.add(id(200))
  env.fetcher.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path === "/v1.0/users" && init?.method === "POST") { created = true; env.writes.push("POST users"); throw new Error("Response lost after create") }
    if (path === "/v1.0/users") return Response.json({ value: confirmed ? [{ ...userRequest.snapshot, id: target }] : [] })
    if (path === `/v1.0/users/${source}`) return new Response(null, { status: 404 })
    return original(input, init)
  })
  const exactOptions = { ...options, stage: "relationships" as const, exactMembers: true }
  const stale = phase === "final validation" ? await service.prepare(tenant, env.request, exactOptions, env.read) : undefined
  const user = await service.prepare(tenant, userRequest, options, env.read)
  expect(await service.execute(tenant, { ...userRequest, runId: user.runId }, user.fingerprint, Object.fromEntries(user.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  expect(created).toBe(true)
  if (missingLock) {
    const coordinatorKey = `restore.directory.coordinator.${tenant}`
    const coordinator = JSON.parse(env.data.get(coordinatorKey)!)
    delete coordinator.locks[source]
    env.data.set(coordinatorKey, JSON.stringify(coordinator))
  }
  const preview = await service.prepare(tenant, env.request, exactOptions, env.read)
  const removals = preview.rows.filter(row => row.review.changes.some(change => change.after === false))
  expect(removals).toHaveLength(2)
  for (const row of removals) expect(row.review.blocker).toContain(`create for saved member ${source} is unconfirmed`)
  if (stale) {
    const approvals = Object.fromEntries(stale.rows.filter(row => row.key.endsWith(target) || row.key.endsWith(id(200))).map(row => [row.key, row.review.approvals]))
    const execute = () => service.execute(tenant, { ...env.request, runId: stale.runId }, stale.fingerprint, approvals)
    expect(await execute()).toMatchObject({ failed: 0, outcomes: [{ state: "deferred" }, { state: "deferred" }] })
    confirmed = true
    expect(await service.saved(tenant, user.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied" }] })
    const refused = await execute()
    expect(refused.failed).toBe(2)
    for (const outcome of refused.outcomes) expect(outcome.reason).toMatch(/Preview .* again/)
  } else {
    confirmed = true
    await service.saved(tenant, user.runId, "reconcile")
  }
  const fresh = await service.prepare(tenant, env.request, exactOptions, env.read)
  expect(fresh.rows.map(row => row.key)).toEqual([`Groups:${resource}:member:${id(200)}`])
  expect(env.writes).toEqual(["POST users"])
  expect(env.members).toEqual(new Set([target, id(200)]))
})

it.each(["inventory", "mapping"])("retries an approved row after a principal %s store read failure", async phase => {
  const env = world(1), service = env.service()
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const get = env.store.get
  const failed = vi.spyOn(env.store, "get").mockImplementation(key => {
    if (key.startsWith(phase === "inventory" ? "restore.directory.principals." : "restore.directory.mapping.") && (phase === "inventory" || key.endsWith(id(100)))) throw new Error("Mapping storage unavailable")
    return get(key)
  })
  const execute = () => service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
  await expect(execute()).rejects.toBeInstanceOf(RestorePersistenceError)
  expect(env.writes).toEqual([])
  failed.mockRestore()
  expect(await execute()).toMatchObject({ failed: 0, outcomes: [{ state: "applied" }] })
  expect(env.writes).toHaveLength(1)
})

it("propagates a failed policy retry publication and retains its saved deadline without closing the row", async () => {
  const env = world(), service = env.service(), original = env.fetcher.getMockImplementation()!
  env.members.add(id(100))
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships", exactMembers: true }, env.read)
  let fail = false, throttled = false
  const set = env.store.set
  const storage = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (fail && key.includes("restore.guarded.")) throw new Error("Retry journal unavailable")
    set(key, value)
  })
  env.fetcher.mockImplementation(async (input, init) => {
    if (!throttled && String(input).includes("conditionalAccess")) { throttled = true; fail = true; return new Response(null, { status: 429, headers: { "Retry-After": "120" } }) }
    return original(input, init)
  })
  vi.useFakeTimers()
  try {
    const deadline = Date.now() + 120_000
    const execute = () => service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
    await expect(execute()).rejects.toBeInstanceOf(DirectoryRetryPersistenceError)
    expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).deadlines[resource]).toBe(deadline)
    storage.mockRestore()
    expect(await execute()).toMatchObject({ failed: 0, outcomes: [{ state: "deferred", retryAt: deadline }] })
    expect(env.writes).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await execute()).toMatchObject({ outcomes: [{ state: "applied" }] })
    expect(env.writes).toEqual([`DELETE groups/${resource}/members/${id(100)}/$ref`])
  } finally { vi.useRealTimers(); storage.mockRestore() }
})

it("loads principal evidence once per execution page and validates only row dependencies for adds", async () => {
  const env = world(1000), service = env.service(), get = vi.spyOn(env.store, "get")
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(get.mock.calls.filter(([key]) => key.startsWith("restore.directory.coordinator.")).length).toBeLessThan(100)
  get.mockClear()
  expect(await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ status: "complete" })
  expect(get.mock.calls.filter(([key]) => key.startsWith("restore.directory.principals."))).toHaveLength(1)
  expect(get.mock.calls.filter(([key]) => key.startsWith("restore.directory.mapping.")).length).toBeLessThan(2000)
  expect(env.writes).toHaveLength(50)
})

it.each(["journal", "coordinator", "none"])("preserves an advisory scan deadline with %s publication failure", async failure => {
  const env = world(0, true), original = env.fetcher.getMockImplementation()!, connection = await env.connection()
  const claims = JSON.parse(Buffer.from(connection.token.split(".")[1]!, "base64url").toString())
  const reads = INTUNE_TYPES.flatMap(type => { const need = backupNeed(type.folder, "delegated"); return Array.isArray(need) ? need.flat() : [] })
  claims.scp += " " + reads.join(" ")
  connection.token = `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`
  const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), async () => connection, env.connection, env.fetcher, () => [], env.settings)
  const page = await service.prepare(tenant, env.request, options, env.read)
  let scanned = false
  env.fetcher.mockImplementation(async (input, init) => {
    if (String(input).includes("deviceManagement/")) { scanned = true; return new Response(null, { status: 429, headers: { "Retry-After": "120" } }) }
    return original(input, init)
  })
  const set = env.store.set
  const storage = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (scanned && (failure === "journal" ? key.includes("restore.guarded.") : failure === "coordinator" && key.startsWith("restore.directory.coordinator."))) throw new Error("Scan retry persistence unavailable")
    set(key, value)
  })
  vi.useFakeTimers()
  try {
    const deadline = Date.now() + 120_000
    const execute = () => service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
    if (failure === "none") expect(await execute()).toMatchObject({ outcomes: [{ state: "applied", retryAt: deadline }] })
    else await expect(execute()).rejects.toBeInstanceOf(DirectoryRetryPersistenceError)
    expect(scanned).toBe(true)
    storage.mockRestore()
    await service.resume(tenant, { ...env.request, runId: page.runId })
    const history = JSON.parse(env.data.get(`restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`)!)
    expect(history.runs[page.runId].entries[0]).toMatchObject({ state: "applied", retryAt: deadline })
    expect(env.writes).toEqual(["POST groups"])
  } finally { vi.useRealTimers(); storage.mockRestore() }
})

it.each(["execute", "saved confirmation"])("captures the verified owner when %s settles a write by read-back without dispatch", async action => {
  const env = world(1), original = env.fetcher.getMockImplementation()!, connection = { ...await env.connection(), auditActor: { username: "owner@example.test", name: "Page owner" } }
  const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), async () => connection, env.connection, env.fetcher, () => [], env.settings)
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const request = { ...env.request, runId: page.runId }, approvals = { [page.rows[0]!.key]: page.rows[0]!.review.approvals }
  env.fetcher.mockImplementation(async (input, init) => {
    const response = await original(input, init)
    return init?.method === "POST" ? new Response(null, { status: 503 }) : response
  })
  const audits: unknown[] = [], accountFor = vi.fn(() => null)
  setDirectoryRestoreService(service)
  const storage = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("oauth2")) return Response.json({ access_token: "storage-token" })
    if (url.endsWith("metadata.json")) return Response.json({ TenantId: tenant })
    if (url.endsWith(".tenuvault-owner.json")) return new Response(null, { status: 404 })
    return Response.json(env.request.snapshot)
  })
  vi.stubGlobal("fetch", storage)
  const host = new ApiHost({ routes: { "/api/restore-directory": { POST: restoreDirectory } }, onHandled: createAuditRecorder(async request => { audits.push(await request.json()); return Response.json({ success: true }) }, accountFor) })
  const dispatch = (action: string) => host.dispatch(new Request("http://tenuvault.internal/api/restore-directory", { method: "POST", body: JSON.stringify({ tenantId: tenant, appId: app, clientSecret: "delegated", storageAccountName: "fixtureaccount", backupId: "backup", path: request.path, runId: page.runId, fingerprint: page.fingerprint, approvals, stage: "relationships", action }) }))
  try {
    expect(await (await dispatch("restore")).json()).toMatchObject({ outcomes: [{ state: "uncertain" }], partial: true })
    await vi.waitFor(() => expect(audits).toHaveLength(1))
    expect(audits[0]).toMatchObject({ logEntry: { result: "PARTIAL", details: { restoredCount: 0, partialCount: 1 } } })
    storage.mockClear()
    expect(await (await dispatch(action === "execute" ? "restore" : "reconcile")).json()).toMatchObject({ success: true, details: { restoredCount: 1, partialCount: 0, failedCount: 0 } })
    await vi.waitFor(() => expect(audits).toHaveLength(2))
    expect(audits[1]).toMatchObject({ user: { id: "owner@example.test", email: "owner@example.test", name: "Page owner" }, logEntry: { result: "SUCCESS", details: { restoredCount: 1, partialCount: 0 } } })
    if (action === "saved confirmation") {
      expect(audits[1]).toMatchObject({ logEntry: { action: "Confirm saved directory restore results" } })
      expect(storage).not.toHaveBeenCalled()
    }
    expect(accountFor).not.toHaveBeenCalled()
    expect(env.writes).toHaveLength(1)
  } finally { vi.unstubAllGlobals() }
})

it("counts the full saved selection in audit before later batches exist and never duplicates totals on resume", async () => {
  const env = world(25), service = env.service(), original = env.fetcher.getMockImplementation()!
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  let throttle = true
  env.fetcher.mockImplementation(async (input, init) => {
    if (throttle && init?.method === "POST") return new Response(null, { status: 429, headers: { "Retry-After": "120" } })
    return original(input, init)
  })
  const audits: unknown[] = []
  const host = new ApiHost({ routes: { "/api/restore-directory": { POST: async () => {
    const result = await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
    return Response.json({ ...result, success: result.status === "complete", partial: result.status === "partial", details: { restoredCount: result.outcomes.filter(row => row.state === "applied").length, partialCount: result.outcomes.filter(row => ["pending", "captured", "deferred", "uncertain"].includes(row.state)).length, failedCount: result.failed } })
  } } }, onHandled: createAuditRecorder(async request => { audits.push(await request.json()); return Response.json({ success: true }) }, () => null) })
  const dispatch = () => host.dispatch(new Request("http://tenuvault.internal/api/restore-directory", { method: "POST", body: JSON.stringify({ tenantId: tenant, appId: app, clientSecret: "delegated", storageAccountName: "fixtureaccount", action: "restore" }) }))
  const first = await (await dispatch()).json()
  expect(first.outcomes).toHaveLength(25)
  expect(first.outcomes.filter((row: { state: string }) => row.state === "pending")).toHaveLength(5)
  expect(env.data.has(`restore.directory.${tenant}.${page.runId}.batch.1.plan`)).toBe(false)
  await vi.waitFor(() => expect(audits).toHaveLength(1))
  expect(audits[0]).toMatchObject({ logEntry: { result: "PARTIAL", details: { restoredCount: 0, partialCount: 25, failedCount: 0 } } })
  // Expire the server deadline without changing any journal outcomes.
  vi.useFakeTimers()
  try {
    throttle = false
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await (await dispatch()).json()).toMatchObject({ status: "complete", outcomes: Array.from({ length: 25 }, () => ({ state: "applied" })) })
  } finally { vi.useRealTimers() }
  await vi.waitFor(() => expect(audits).toHaveLength(2))
  expect(audits[1]).toMatchObject({ logEntry: { result: "SUCCESS", details: { restoredCount: 25, partialCount: 0, failedCount: 0 } } })
  expect(env.writes).toHaveLength(25)
})

it("uses the injected service clock at the final coordinator deadline boundary", async () => {
  let now = 100
  const env = world(0, false, () => now), service = env.service(), request = { ...env.request, snapshot: { ...env.request.snapshot, description: "Saved" } }
  const page = await service.prepare(tenant, request, options, env.read)
  env.data.set(`restore.directory.coordinator.${tenant}`, JSON.stringify({ locks: {}, deadlines: { [resource]: 2000 }, discarded: {} }))
  const execute = () => service.execute(tenant, { ...request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
  expect(await execute()).toMatchObject({ outcomes: [{ state: "deferred", retryAt: 2000 }] })
  expect(env.writes).toEqual([])
  now = 2000
  expect(await execute()).toMatchObject({ outcomes: [{ state: "applied" }] })
  expect(env.writes).toEqual([`PATCH groups/${resource}`])
})

it("ignores unrelated damaged coordinator locks while capturing relationship principals", async () => {
  const env = world(1), service = env.service()
  env.data.set(`restore.directory.coordinator.${tenant}`, JSON.stringify({ locks: { [id(999)]: { owner: "damaged", journal: "untrusted" } }, deadlines: {}, discarded: {} }))
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]!.review.blocker).toBeUndefined()
  expect(await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })).toMatchObject({ status: "complete" })
  expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).locks[id(999)]).toEqual({ owner: "damaged", journal: "untrusted" })
  expect(env.writes).toHaveLength(1)
})

it("refuses an add when an uppercase saved principal mapping changes during final safety reads", async () => {
  const env = world(1), service = env.service(), source = "AAAAAAAA-0000-4000-8000-000000000100", target = id(900)
  env.saved[0] = source
  env.request.snapshot.members.hash = createHash("sha256").update(JSON.stringify(source) + "\n").digest("hex")
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(page.rows[0]!.key).toBe(`Groups:${resource}:member:${source.toLowerCase()}`)
  const original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation(async (input, init) => {
    if (String(input).includes("conditionalAccess")) env.data.set(`restore.directory.mapping.${tenant}.objectId.Users.${source.toLowerCase()}`, target)
    return original(input, init)
  })
  expect(await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })).toMatchObject({ failed: 1, outcomes: [{ state: "failed-before-send" }] })
  expect(env.writes).toEqual([])
})

it.each(["execute", "saved confirmation"])("cancels uncertain user-create lookup via %s without another POST", async action => {
  const env = world(), service = env.service(), original = env.fetcher.getMockImplementation()!, source = id(100), target = id(900)
  const request: IdentityRestoreRequest = { origin: "restore", path: `backup/Users/${source}.json`, snapshot: { id: source, userType: "Member", displayName: "Saved user", userPrincipalName: "saved@example.test", mailNickname: "saved", accountEnabled: false } }
  let created = false, confirming = false, lookupSignal: AbortSignal | undefined
  let reached!: () => void
  const lookup = new Promise<void>(resolve => { reached = resolve })
  env.fetcher.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path === "/v1.0/users" && init?.method === "POST") { created = true; env.writes.push("POST users"); throw new Error("Create response lost") }
    if (path === `/v1.0/users/${source}`) return new Response(null, { status: 404 })
    if (path === "/v1.0/users") {
      if (!confirming) return Response.json({ value: created ? [{ ...request.snapshot, id: target }] : [] })
      lookupSignal = init?.signal ?? undefined
      reached()
      return new Promise<Response>((_resolve, reject) => {
        lookupSignal?.addEventListener("abort", () => reject(lookupSignal!.reason), { once: true })
      })
    }
    return original(input, init)
  })
  const page = await service.prepare(tenant, request, options, env.read)
  const execute = () => service.execute(tenant, { ...request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  expect(await execute()).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  confirming = true
  const pending = action === "execute" ? execute() : service.saved(tenant, page.runId, "reconcile")
  await lookup
  expect(lookupSignal).toBeDefined()
  expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: true })
  expect(await pending).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  expect(lookupSignal!.aborted).toBe(true)
  expect(env.writes).toEqual(["POST users"])
  const history = JSON.parse(env.data.get(`restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`)!)
  expect(history.runs[page.runId].entries[0].state).toBe("uncertain")
  confirming = false
  expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied", targetId: target }] })
  expect(env.writes).toEqual(["POST users"])
})


it.each(["refusal", "unsent marker"].flatMap(failure => ["resume", "reconcile", "discard"].map(action => ({ failure, action }))))("retains a known $failure through journal failure before $action and allows discard", async ({ failure, action }) => {
  const env = world(0, true), service = env.service()
  const page = await service.prepare(tenant, env.request, options, env.read), original = env.fetcher.getMockImplementation()!
  const request = { ...env.request, runId: page.runId }, approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
  const journalKey = `restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`
  let unavailable = false, posts = 0
  env.fetcher.mockImplementation((input, init) => {
    if (init?.method === "POST") { posts++; unavailable = true; return Promise.resolve(new Response(null, { status: 403 })) }
    return original(input, init)
  })
  const set = env.store.set
  const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key === journalKey && failure === "unsent marker" && value.includes('"state":"uncertain"')) {
      set(key, value) // The rename succeeded before directory sync failed.
      unavailable = true
      throw new Error("Send marker directory sync failed")
    }
    if (key === journalKey && unavailable) throw new Error("Journal storage unavailable")
    set(key, value)
  })
  try {
    await expect(service.execute(tenant, request, page.fingerprint, approvals)).rejects.toBeInstanceOf(RestorePersistenceError)
    expect(posts).toBe(failure === "refusal" ? 1 : 0)
    const marker = JSON.parse(env.data.get(journalKey)!).runs[page.runId].entries[0]
    expect(marker).toMatchObject({ state: "uncertain", attempt: 1, step: { key: page.rows[0]!.key } })
    if (action === "resume") await expect(service.resume(tenant, request)).rejects.toBeInstanceOf(RestorePersistenceError)
    else await expect(service.saved(tenant, page.runId, action as "reconcile" | "discard")).rejects.toBeInstanceOf(RestorePersistenceError)
    unavailable = false
    spy.mockRestore()
    if (action === "resume") expect(await service.resume(tenant, request)).toMatchObject({ canDiscard: true, unresolved: failure === "unsent marker" })
    else if (action === "reconcile") expect(await service.saved(tenant, page.runId, "reconcile")).toMatchObject({ canDiscard: true, failed: failure === "refusal" ? 1 : 0, outcomes: [{ state: failure === "refusal" ? "failed" : "captured" }] })
    if (action === "discard") expect(await service.saved(tenant, page.runId, "discard")).toMatchObject({ discarded: true })
    const recovered = JSON.parse(env.data.get(journalKey)!).runs[page.runId].entries[0]
    expect(recovered).toMatchObject({ state: failure === "refusal" ? "failed" : "captured", attempt: 1, step: { key: marker.step.key } })
    expect(await service.saved(tenant, page.runId, "discard")).toMatchObject({ discarded: true })
    await expect(service.execute(tenant, request, page.fingerprint, approvals)).rejects.toThrow("discarded")
    expect(posts).toBe(failure === "refusal" ? 1 : 0)
  } finally { spy.mockRestore() }
})

it("reports saved failure totals when confirmation returns during Retry-After", async () => {
  const env = world(2), service = env.service(), original = env.fetcher.getMockImplementation()!
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  let posts = 0
  env.fetcher.mockImplementation((input, init) => init?.method === "POST" ? Promise.resolve(new Response(null, { status: ++posts === 1 ? 403 : 429, headers: { "Retry-After": "120" } })) : original(input, init))
  const result = await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  expect(result).toMatchObject({ failed: 1, outcomes: [{ state: "failed" }, { state: "deferred" }] })
  const reads = env.fetcher.mock.calls.length
  const confirmed = await service.saved(tenant, page.runId, "reconcile")
  expect(confirmed).toMatchObject({ status: "partial", failed: 1, outcomes: [{ state: "failed" }, { state: "deferred", retryAt: result.outcomes[1]!.retryAt }] })
  expect(env.fetcher.mock.calls).toHaveLength(reads)
  expect(posts).toBe(2)
})

it("deletes the create journal reference only after confirmed mapping publication recovers", async () => {
  const env = world(0, true), service = env.service(), page = await service.prepare(tenant, env.request, options, env.read)
  const journalKey = `restore.directory.create-journal.${tenant}.Groups.${resource}`, set = env.store.set
  const publication = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key.startsWith("restore.directory.mapping.")) throw new Error("Mapping publication unavailable")
    set(key, value)
  })
  try {
    await expect(service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).rejects.toThrow("Mapping publication unavailable")
    expect(env.data.get(journalKey)).toBe(`restore.directory.${tenant}.${page.runId}.batch.0.`)
    expect(directoryMappedId(env.store, tenant, "Groups", resource)).toBeUndefined()
    publication.mockRestore()
    await service.prepare(tenant, env.request, options, env.read)
    expect(directoryMappedId(env.store, tenant, "Groups", resource)).toBe(id(900))
    expect(env.data.has(journalKey)).toBe(false)
    expect(env.writes).toEqual(["POST groups"])
  } finally { publication.mockRestore() }
})

it.each(["execute", "saved confirmation"])("defers uncertain user-create confirmation via %s on one raw throttled read without waiting", async action => {
  const env = world(), service = env.service(), original = env.fetcher.getMockImplementation()!, source = id(100), target = id(900)
  const request: IdentityRestoreRequest = { origin: "restore", path: `backup/Users/${source}.json`, snapshot: { id: source, userType: "Member", displayName: "Saved user", userPrincipalName: "saved@example.test", mailNickname: "saved", accountEnabled: false } }
  let confirming = false, throttled = true, posts = 0, lookups = 0
  env.fetcher.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path === "/v1.0/users" && init?.method === "POST") { posts++; throw new Error("Create response lost") }
    if (path === `/v1.0/users/${source}`) return new Response(null, { status: 404 })
    if (path === "/v1.0/users") {
      if (!confirming) return Response.json({ value: [] })
      lookups++
      return throttled ? new Response(null, { status: 429, headers: { "Retry-After": "60" } }) : Response.json({ value: [{ ...request.snapshot, id: target }] })
    }
    return original(input, init)
  })
  const page = await service.prepare(tenant, request, options, env.read)
  const execute = () => service.execute(tenant, { ...request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  expect(await execute()).toMatchObject({ outcomes: [{ state: "uncertain" }], canDiscard: false })
  confirming = true
  vi.useFakeTimers()
  try {
    const deadline = Date.now() + 60_000
    const result = await (action === "execute" ? execute() : service.saved(tenant, page.runId, "reconcile"))
    expect(result).toMatchObject({ outcomes: [{ state: "uncertain", retryAt: deadline }], canDiscard: false })
    expect(lookups).toBe(1); expect(posts).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: false })
    await expect(service.saved(tenant, page.runId, "discard")).rejects.toThrow("Confirm the uncertain result")
    expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "uncertain", retryAt: deadline }] })
    expect(lookups).toBe(1)
    throttled = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await service.saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied", targetId: target }], canDiscard: true })
    expect(lookups).toBe(2); expect(posts).toBe(1)
  } finally { vi.useRealTimers() }
})


it.each(["execute", "discard"])("keeps all 50 approved rows unresolved after confirming member 20 until %s", async action => {
  const env = world(65), service = env.service(), relationshipOptions = { ...options, stage: "relationships" as const }
  const page = await service.prepare(tenant, env.request, relationshipOptions, env.read), original = env.fetcher.getMockImplementation()!
  expect(page).toMatchObject({ more: true, unresolved: false, discarded: false })
  expect(page.rows).toHaveLength(50)
  let posts = 0
  env.fetcher.mockImplementation(async (input, init) => {
    const response = await original(input, init)
    return init?.method === "POST" && ++posts === 20 ? new Response(null, { status: 503 }) : response
  })
  const request = { ...env.request, runId: page.runId }, selection = page.rows.map(row => row.key)
  const approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
  expect(await service.execute(tenant, request, page.fingerprint, approvals)).toMatchObject({ unresolved: true, outcomes: [...Array.from({ length: 19 }, () => ({ state: "applied" })), { state: "uncertain" }, ...Array.from({ length: 30 }, () => ({ state: "pending" }))] })
  await expect(service.prepare(tenant, env.request, { ...relationshipOptions, previousRunId: page.runId }, env.read)).rejects.toThrow("Resolve or discard this saved page")
  expect(await service.saved(tenant, page.runId, "reconcile")).toMatchObject({ unresolved: true, outcomes: [...Array.from({ length: 20 }, () => ({ state: "applied" })), ...Array.from({ length: 30 }, () => ({ state: "pending" }))] })
  expect(env.data.has(directoryPagePrefix(tenant, page.runId) + "batch.1.plan")).toBe(false)
  const resumed = await env.service().resume(tenant, request)
  expect(resumed).toEqual({ ...page, selection, unresolved: true, outcomes: page.rows.map((row, index) => ({ key: row.key, state: index < 20 ? "applied" : "pending", reason: undefined, retryAt: undefined, targetId: index < 20 ? resource : undefined })) })
  await expect(env.service().prepare(tenant, env.request, { ...relationshipOptions, previousRunId: page.runId }, env.read)).rejects.toThrow("Resolve or discard this saved page")
  expect(posts).toBe(20)
  if (action === "discard") {
    const discarded = { ...resumed, discarded: true, unresolved: false, canDiscard: false }
    expect(await service.saved(tenant, page.runId, "discard")).toEqual(discarded)
    expect(await env.service().resume(tenant, request)).toEqual(discarded)
    await expect(service.execute(tenant, request, page.fingerprint, approvals)).rejects.toThrow("discarded")
  } else {
    expect(await env.service().execute(tenant, request, page.fingerprint, approvals)).toMatchObject({ status: "complete", unresolved: false, outcomes: Array.from({ length: 50 }, () => ({ state: "applied" })) })
  }
  const next = await env.service().prepare(tenant, env.request, { ...relationshipOptions, previousRunId: page.runId }, env.read)
  expect(next.rows).toHaveLength(15)
  expect(next).toMatchObject({ more: false, discarded: false, unresolved: false })
  expect(next.rows.map(row => row.key)).toEqual(expect.arrayContaining(env.saved.slice(50).map(principal => expect.stringContaining(principal))))
  expect(posts).toBe(action === "discard" ? 20 : 50)
})

it("publishes later create mappings after reference cleanup fails and retries cleanup after lock release", async () => {
  const env = world(0, true), service = env.service(), page = await service.prepare(tenant, env.request, options, env.read)
  const set = env.store.set, failure = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key.startsWith("restore.directory.mapping.")) throw new Error("Mapping unavailable")
    set(key, value)
  })
  await expect(service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).rejects.toThrow("Mapping unavailable")
  failure.mockRestore()
  const prefix = directoryPagePrefix(tenant, page.runId) + "batch.0."
  const journal = new GuardedRunJournal({ get: key => env.store.get(prefix + key), set: (key, value) => env.store.set(prefix + key, value), delete: key => env.store.delete(prefix + key) })
  const run = journal.load(tenant, page.runId)!, first = run.entries[0]!, secondSource = id(11), secondTarget = id(901)
  run.entries.push({ ...first, step: { ...first.step, key: "second-create", sourceId: secondSource }, targetId: secondTarget })
  run.mappings.push({ kind: "objectId", folder: "Groups", source: secondSource, target: secondTarget })
  journal.save(run)
  const coordinatorKey = `restore.directory.coordinator.${tenant}`, state = JSON.parse(env.data.get(coordinatorKey)!)
  state.locks[secondSource] = { owner: page.runId, journal: prefix }
  env.store.set(coordinatorKey, JSON.stringify(state))
  const reference = (source: string) => `restore.directory.create-journal.${tenant}.Groups.${source}`
  env.store.set(reference(secondSource), prefix)
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  const remove = env.store.delete, cleanup = vi.spyOn(env.store, "delete").mockImplementation(key => {
    if (key === reference(resource)) throw new Error("Cleanup unavailable")
    remove(key)
  })
  try {
    const objects = directoryObjectState(env.store, tenant, page.runId), steps = run.entries.map(entry => entry.step)
    expect(() => objects.recoverMappings(steps)).not.toThrow()
    expect(env.store.get(directoryMappingKey(tenant, "Groups", resource))).toBe(id(900))
    expect(env.store.get(directoryMappingKey(tenant, "Groups", secondSource))).toBe(secondTarget)
    expect(env.store.get(reference(resource))).toBe(prefix)
    expect(env.store.get(reference(secondSource))).toBeNull()
    expect(warning.mock.calls).toEqual([[`Directory create reference cleanup failed for object ${resource}. The mapping is durable; cleanup will be retried.`]])
    objects.release()
    cleanup.mockRestore()
    objects.recoverMappings(steps)
    expect(env.store.get(reference(resource))).toBeNull()
    expect(JSON.parse(env.data.get(coordinatorKey)!).locks).toEqual({})
    expect(env.writes).toEqual(["POST groups"])
  } finally { cleanup.mockRestore(); warning.mockRestore() }
})

it.each(["lock release", "final cursor"])("finishes previous page cleanup after one failed %s before sending the final 15 rows", async failurePoint => {
  const env = world(65), service = env.service(), relationshipOptions = { ...options, stage: "relationships" as const }
  const first = await service.prepare(tenant, env.request, relationshipOptions, env.read)
  const coordinator = `restore.directory.coordinator.${tenant}`, cursor = directoryPagePrefix(tenant, first.runId) + "cursor"
  const set = env.store.set
  let failures = 0
  const failure = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    const finalSave = failurePoint === "lock release" ? key === coordinator && !JSON.parse(value).locks[resource] : key === cursor && JSON.parse(value).done
    if (env.writes.length === 50 && finalSave && failures++ === 0) throw new Error("Cleanup save unavailable")
    set(key, value)
  })
  try {
    await expect(service.execute(tenant, { ...env.request, runId: first.runId }, first.fingerprint, Object.fromEntries(first.rows.map(row => [row.key, row.review.approvals])))).rejects.toThrow("Cleanup save unavailable")
    expect(env.writes).toHaveLength(50)
    expect((await service.resume(tenant, { ...env.request, runId: first.runId })).unresolved).toBe(false)
    expect(JSON.parse(env.data.get(coordinator)!).locks[resource].owner).toBe(first.runId)
    const restarted = env.service(), next = await restarted.prepare(tenant, env.request, { ...relationshipOptions, previousRunId: first.runId }, env.read)
    expect(JSON.parse(env.data.get(cursor)!).done).toBe(true)
    expect(JSON.parse(env.data.get(coordinator)!).locks).toEqual({})
    expect(next.rows).toHaveLength(15); expect(next.more).toBe(false)
    expect(next.rows.every(row => !row.review.blocker)).toBe(true)
    expect(await restarted.execute(tenant, { ...env.request, runId: next.runId }, next.fingerprint, Object.fromEntries(next.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ status: "complete", failed: 0, unresolved: false, outcomes: next.rows.map(row => ({ key: row.key, state: "applied" })) })
    expect(env.writes).toHaveLength(65); expect(env.members.size).toBe(65)
  } finally { failure.mockRestore() }
})

it("refuses continuation with a retryable error while previous lock cleanup still fails", async () => {
  const env = world(65), service = env.service(), relationshipOptions = { ...options, stage: "relationships" as const }
  const first = await service.prepare(tenant, env.request, relationshipOptions, env.read), set = env.store.set
  const coordinator = `restore.directory.coordinator.${tenant}`
  const failure = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key === coordinator && env.writes.length === 50 && !JSON.parse(value).locks[resource]) throw new Error("Release unavailable")
    set(key, value)
  })
  const previews = () => [...env.data.keys()].filter(key => key.startsWith("restore.directory.review."))
  try {
    await expect(service.execute(tenant, { ...env.request, runId: first.runId }, first.fingerprint, Object.fromEntries(first.rows.map(row => [row.key, row.review.approvals])))).rejects.toThrow("Release unavailable")
    for (let attempt = 0; attempt < 2; attempt++) await expect(service.prepare(tenant, env.request, { ...relationshipOptions, previousRunId: first.runId }, env.read)).rejects.toMatchObject({ constructor: RestoreWriteDeferredError, message: expect.stringContaining("Retry previewing the next page") })
    expect(previews()).toHaveLength(1); expect(env.writes).toHaveLength(50)
    expect(JSON.parse(env.data.get(coordinator)!).locks[resource].owner).toBe(first.runId)
    failure.mockRestore()
    const next = await service.prepare(tenant, env.request, { ...relationshipOptions, previousRunId: first.runId }, env.read)
    expect(next.rows).toHaveLength(15); expect(previews()).toHaveLength(2)
    expect(await service.execute(tenant, { ...env.request, runId: next.runId }, next.fingerprint, Object.fromEntries(next.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ status: "complete" })
    expect(env.writes).toHaveLength(65)
  } finally { failure.mockRestore() }
})

it("defers a settled earlier inventory owner's lock and retries all 15 rows after cleanup", async () => {
  const env = world(65), service = env.service(), relationshipOptions = { ...options, stage: "relationships" as const }
  const first = await service.prepare(tenant, env.request, relationshipOptions, env.read)
  await service.execute(tenant, { ...env.request, runId: first.runId }, first.fingerprint, Object.fromEntries(first.rows.map(row => [row.key, row.review.approvals])))
  const next = await service.prepare(tenant, env.request, { ...relationshipOptions, previousRunId: first.runId }, env.read)
  const coordinator = `restore.directory.coordinator.${tenant}`, state = JSON.parse(env.data.get(coordinator)!)
  state.locks[resource] = { owner: first.runId, journal: directoryPagePrefix(tenant, first.runId) + "batch.2." }
  env.store.set(coordinator, JSON.stringify(state))
  const execute = () => service.execute(tenant, { ...env.request, runId: next.runId }, next.fingerprint, Object.fromEntries(next.rows.map(row => [row.key, row.review.approvals])))
  expect(await execute()).toMatchObject({ status: "partial", failed: 0, unresolved: true, outcomes: next.rows.map(row => ({ key: row.key, state: "deferred", reason: expect.stringContaining("settled earlier directory page") })) })
  expect(env.writes).toHaveLength(50)
  await service.saved(tenant, first.runId, "reconcile")
  expect(await execute()).toMatchObject({ status: "complete", failed: 0, unresolved: false, outcomes: next.rows.map(row => ({ key: row.key, state: "applied" })) })
  expect(env.writes).toHaveLength(65); expect(env.members.size).toBe(65)
})


it.each(["page", "cursor", "history", "coordinator"])("keeps page 2 resumable after one %s read failure looking up page 1's lock", async phase => {
  const env = world(51), service = env.service(), relationshipOptions = { ...options, stage: "relationships" as const }
  const first = await service.prepare(tenant, env.request, relationshipOptions, env.read)
  await service.execute(tenant, { ...env.request, runId: first.runId }, first.fingerprint, Object.fromEntries(first.rows.map(row => [row.key, row.review.approvals])))
  const next = await service.prepare(tenant, env.request, { ...relationshipOptions, previousRunId: first.runId }, env.read)
  const coordinator = `restore.directory.coordinator.${tenant}`, state = JSON.parse(env.data.get(coordinator)!)
  state.locks[resource] = { owner: first.runId, journal: directoryPagePrefix(tenant, first.runId) + "batch.2." }
  env.store.set(coordinator, JSON.stringify(state))
  const ownerKey = `restore.directory.review.${tenant}.${first.runId}`, prefix = directoryPagePrefix(tenant, first.runId), get = env.store.get
  let lookingUpOwner = false, failures = 0
  const failure = vi.spyOn(env.store, "get").mockImplementation(key => {
    if (key === ownerKey) lookingUpOwner = true
    const matches = phase === "page" ? key === ownerKey : phase === "cursor" ? key === prefix + "cursor" : phase === "history" ? key.startsWith(prefix) && key.includes("restore.guarded.") : key === coordinator
    if (lookingUpOwner && matches && failures++ === 0) throw new Error("Owner storage unavailable")
    return get(key)
  })
  const execute = () => service.execute(tenant, { ...env.request, runId: next.runId }, next.fingerprint, Object.fromEntries(next.rows.map(row => [row.key, row.review.approvals])))
  try {
    await expect(execute()).rejects.toBeInstanceOf(RestorePersistenceError)
    expect(failures).toBe(1); expect(env.writes).toHaveLength(50)
    const journal = JSON.parse(env.data.get(directoryPagePrefix(tenant, next.runId) + `batch.0.restore.guarded.${tenant}`)!)
    expect(journal.runs[next.runId].entries[0].state).toBe("pending")
    failure.mockRestore()
    expect(await service.resume(tenant, { ...env.request, runId: next.runId })).toMatchObject({ unresolved: true, selection: next.rows.map(row => row.key) })
    await service.saved(tenant, first.runId, "reconcile")
    expect(await execute()).toMatchObject({ status: "complete", failed: 0, unresolved: false, outcomes: [{ key: next.rows[0]!.key, state: "applied" }] })
    expect(env.writes).toHaveLength(51); expect(env.members.size).toBe(51)
  } finally { failure.mockRestore() }
})

it("retries a coordinator read failure at the final send boundary without closing the row", async () => {
  const env = world(1), service = env.service(), page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const get = env.store.get, journalKey = directoryPagePrefix(tenant, page.runId) + `batch.0.restore.guarded.${tenant}`
  let failures = 0
  const failure = vi.spyOn(env.store, "get").mockImplementation(key => {
    const captured = env.data.get(journalKey)?.includes('"state":"captured"')
    if (captured && key === `restore.directory.coordinator.${tenant}` && failures++ === 0) throw new Error("Final coordinator read unavailable")
    return get(key)
  })
  const execute = () => service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
  try {
    await expect(execute()).rejects.toBeInstanceOf(RestorePersistenceError)
    expect(failures).toBe(1); expect(env.writes).toEqual([])
    expect(JSON.parse(env.data.get(journalKey)!).runs[page.runId].entries[0].state).toBe("captured")
    failure.mockRestore()
    expect(await execute()).toMatchObject({ status: "complete", failed: 0, outcomes: [{ state: "applied" }] })
    expect(env.writes).toHaveLength(1)
  } finally { failure.mockRestore() }
})

it.each(["backup loading", "throttling"])("authenticates cancel locally during %s and hides active state from another owner", async phase => {
  const env = world(1), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  let current = await env.connection()
  const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), async () => current, async () => current, env.fetcher, () => [], env.settings)
  if (phase === "throttling") directoryObjectState(env.store, tenant, page.runId).recordThrottle({ sourceId: resource }, Date.now() + 120_000)
  let release!: () => void, signal!: AbortSignal, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = service.operation(tenant, page.runId, async active => { signal = active; entered(); await new Promise<void>(resolve => { release = resolve }); return { cancelled: active.aborted } })
  await started
  const reads = env.fetcher.mock.calls.length
  try {
    for (const changed of ["userId", "clientId", "tenantId"] as const) {
      current = { ...await env.connection(), [changed]: id(800) }
      current.token = `h.${Buffer.from(JSON.stringify({ tid: current.tenantId, oid: current.userId, appid: current.clientId, scp: "Group.ReadWrite.All" })).toString("base64url")}.s`
      await expect(service.cancel(tenant, page.runId)).rejects.toThrow("Use the admin and connection that reviewed this page.")
      expect(signal.aborted).toBe(false)
    }
    current = await env.connection()
    expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: true })
    expect(signal.aborted).toBe(true)
    release(); expect(await pending).toEqual({ cancelled: true })
    current = { ...current, userId: id(800), token: `h.${Buffer.from(JSON.stringify({ tid: tenant, oid: id(800), appid: app, scp: "Group.ReadWrite.All" })).toString("base64url")}.s` }
    await expect(service.cancel(tenant, page.runId)).rejects.toThrow("Use the admin and connection that reviewed this page.")
    current = await env.connection()
    expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: false })
    expect(env.fetcher).toHaveBeenCalledTimes(reads); expect(env.writes).toEqual([])
  } finally { release(); await pending }
})

it("returns the saved review after failure before the first journal and executes it after recovery", async () => {
  const env = world(1), service = env.service(), savedOptions = { ...options, stage: "relationships" as const, exactMembers: true, exactOwners: true }
  const page = await service.prepare(tenant, env.request, savedOptions, env.read), set = env.store.set
  const failure = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key === directoryPagePrefix(tenant, page.runId) + "cursor") throw new Error("First cursor save unavailable")
    set(key, value)
  })
  const execute = () => service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
  try {
    await expect(execute()).rejects.toBeInstanceOf(RestorePersistenceError)
    failure.mockRestore()
    expect([...env.data.keys()].some(key => key.includes("restore.guarded."))).toBe(false)
    expect(await service.saved(tenant, page.runId, "reconcile")).toMatchObject({ ...page, selection: [page.rows[0]!.key], status: "nothing-sent", unresolved: true, outcomes: [{ key: page.rows[0]!.key, state: "pending" }] })
    expect(env.writes).toEqual([])
    expect(await execute()).toMatchObject({ status: "complete", failed: 0, outcomes: [{ state: "applied" }] })
    expect(env.writes).toHaveLength(1)
  } finally { failure.mockRestore() }
})

it.each(["safety", "other terminal"])("preserves a %s error and its message during continuation cleanup", async kind => {
  const env = world(51), service = env.service(), relationshipOptions = { ...options, stage: "relationships" as const }
  const first = await service.prepare(tenant, env.request, relationshipOptions, env.read)
  await service.execute(tenant, { ...env.request, runId: first.runId }, first.fingerprint, Object.fromEntries(first.rows.map(row => [row.key, row.review.approvals])))
  const cursor = directoryPagePrefix(tenant, first.runId) + "cursor", state = JSON.parse(env.data.get(cursor)!)
  if (kind === "safety") { state.binding = "changed"; env.store.set(cursor, JSON.stringify(state)) }
  const get = env.store.get
  let reads = 0
  const failure = vi.spyOn(env.store, "get").mockImplementation(key => kind === "other terminal" && key === cursor && ++reads > 1 ? "{" : get(key))
  let syntaxMessage = ""
  try { JSON.parse("{") } catch (error) { syntaxMessage = (error as Error).message }
  try {
    await expect(service.prepare(tenant, env.request, { ...relationshipOptions, previousRunId: first.runId }, env.read)).rejects.toMatchObject({ constructor: kind === "safety" ? RestoreSafetyError : SyntaxError, message: kind === "safety" ? "The directory restore source or identity changed. Resume the original plan." : syntaxMessage })
    expect([...env.data.keys()].filter(key => key.startsWith("restore.directory.review."))).toHaveLength(1)
    expect(env.writes).toHaveLength(50)
  } finally { failure.mockRestore() }
})

it("cancels a Retry-After wait from the cached owner when token refresh is unavailable", async () => {
  vi.useFakeTimers()
  try {
    const env = world(2), connection = vi.fn(env.connection), owner = vi.fn(env.connection)
    const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), connection, owner, env.fetcher, () => [], env.settings)
    const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read), original = env.fetcher.getMockImplementation()!
    let attempts = 0
    env.fetcher.mockImplementation((input, init) => {
      if (init?.method === "POST") { attempts++; return Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "60" } })) }
      return original(input, init)
    })
    const pending = service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
    await vi.waitFor(() => expect(attempts).toBe(1))
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    connection.mockRejectedValue(new Error("Token refresh unavailable"))
    const connections = connection.mock.calls.length, calls = env.fetcher.mock.calls.length
    expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: true })
    expect(connection).toHaveBeenCalledTimes(connections); expect(owner).toHaveBeenCalledTimes(3)
    expect(await pending).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "deferred" }, { state: "pending" }] })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(attempts).toBe(1); expect(env.writes).toEqual([]); expect(env.members.size).toBe(0)
    expect(env.fetcher).toHaveBeenCalledTimes(calls)
  } finally { vi.useRealTimers() }
})

it("executes an unrelated approved page after an unsaved deadline expires despite repeated publication failure", async () => {
  vi.useFakeTimers()
  try {
    const env = world(1), service = env.service(), original = env.fetcher.getMockImplementation()!
    const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
    const otherRequest: IdentityRestoreRequest = { origin: "restore", path: `backup/Users/${id(200)}.json`, snapshot: { id: id(200), displayName: "Saved", userType: "Member" } }
    const other = await service.prepare(tenant, otherRequest, options, env.read)
    const set = env.store.set, coordinator = `restore.directory.coordinator.${tenant}`
    const publication = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
      if (key === coordinator && JSON.parse(value).deadlines[resource]) throw new Error("Deadline publication unavailable")
      set(key, value)
    })
    env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname === "/v1.0/applications" ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
    const own = () => service.resume(tenant, { ...env.request, runId: page.runId })
    await expect(own()).rejects.toBeInstanceOf(DirectoryRetryPersistenceError)
    const deadline = Date.now() + 120_000
    env.fetcher.mockImplementation(original)
    const execute = () => service.execute(tenant, { ...otherRequest, runId: other.runId }, other.fingerprint, Object.fromEntries(other.rows.map(row => [row.key, row.review.approvals])))
    await expect(execute()).rejects.toBeInstanceOf(DirectoryRetryPersistenceError)
    expect(env.writes).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await execute()).toMatchObject({ status: "complete", failed: 0, outcomes: [{ state: "applied" }] })
    expect(env.writes).toEqual([`PATCH users/${id(200)}`])
    await expect(own()).rejects.toBeInstanceOf(DirectoryRetryPersistenceError)
    publication.mockRestore()
    expect(await own()).toMatchObject({ runId: page.runId })
    expect(JSON.parse(env.data.get(coordinator)!).deadlines[resource]).toBe(deadline)
    expect(env.writes).toHaveLength(1)
  } finally { vi.restoreAllMocks(); vi.useRealTimers() }
})

it.each(["Graph lookup forbidden", "token refresh unavailable"])("discards deferred rows and releases their locks locally with %s", async unavailable => {
  const env = world(1), connection = vi.fn(env.connection)
  const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), connection, env.connection, env.fetcher, () => [], env.settings)
  const page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read), original = env.fetcher.getMockImplementation()!
  const abort = new AbortController()
  env.fetcher.mockImplementation((input, init) => {
    if (init?.method === "POST") { abort.abort(); return Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) }
    return original(input, init)
  })
  expect(await service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])), abort.signal)).toMatchObject({ outcomes: [{ state: "deferred" }], canDiscard: true })
  const coordinator = `restore.directory.coordinator.${tenant}`
  expect(JSON.parse(env.data.get(coordinator)!).locks[resource].owner).toBe(page.runId)
  env.fetcher.mockImplementation(async () => new Response(null, { status: 403 }))
  if (unavailable === "token refresh unavailable") connection.mockRejectedValue(new Error("Token refresh unavailable"))
  const calls = env.fetcher.mock.calls.length, connections = connection.mock.calls.length
  expect(await service.saved(tenant, page.runId, "discard")).toMatchObject({ runId: page.runId, discarded: true, canDiscard: false, unresolved: false })
  expect(JSON.parse(env.data.get(coordinator)!).locks).toEqual({})
  expect(env.fetcher).toHaveBeenCalledTimes(calls); expect(connection).toHaveBeenCalledTimes(connections)
  expect(env.writes).toEqual([])
  env.fetcher.mockImplementation(original); connection.mockImplementation(env.connection)
  await expect(service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).rejects.toThrow("discarded")
  expect(env.writes).toEqual([])
})

it.each(["reconcile", "discard", "resume", "execute", "cancel"] as const)("verifies the saved owner before revealing running state to %s", async action => {
  const env = world(1), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const connection = vi.fn(env.connection), localOwner = vi.fn(env.connection)
  const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), connection, localOwner, env.fetcher, () => [], env.settings)
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = service.operation(tenant, page.runId, async () => { entered(); await new Promise<void>(resolve => { release = resolve }) })
  await started
  localOwner.mockImplementation(async () => ({ ...await env.connection(), userId: id(800) }))
  const get = vi.spyOn(env.store, "get"), before = new Map(env.data), calls = env.fetcher.mock.calls.length
  try {
    for (const running of [true, false]) {
      if (!running) { release(); await pending }
      get.mockClear()
      const controllers = vi.spyOn(globalThis, "AbortController")
      try {
        const request = { ...env.request, runId: page.runId }
        const result = action === "resume" ? service.resume(tenant, request) : action === "execute" ? service.execute(tenant, request, page.fingerprint, {}) : action === "cancel" ? service.cancel(tenant, page.runId) : service.saved(tenant, page.runId, action)
        await expect(result).rejects.toThrow("Use the admin and connection that reviewed this page.")
        expect(controllers).not.toHaveBeenCalled()
      } finally { controllers.mockRestore() }
      expect(get.mock.calls).toEqual([[`restore.directory.review.${tenant}.${page.runId}`]])
      expect(env.data).toEqual(before)
    }
    expect(connection).not.toHaveBeenCalled(); expect(env.fetcher).toHaveBeenCalledTimes(calls); expect(env.writes).toEqual([])
  } finally { release(); await pending; get.mockRestore() }
})

it.each(["decrypt", "record binding", "record JSON"])("preserves the encrypted %s verification error through nested persistence wrappers during cleanup", async failurePoint => {
  const env = world(51), service = env.service(), relationshipOptions = { ...options, stage: "relationships" as const }
  const first = await service.prepare(tenant, env.request, relationshipOptions, env.read)
  await service.execute(tenant, { ...env.request, runId: first.runId }, first.fingerprint, Object.fromEntries(first.rows.map(row => [row.key, row.review.approvals])))
  const directory = mkdtempSync(join(tmpdir(), "tv-r24-verification-")), cursor = directoryPagePrefix(tenant, first.runId) + "cursor"
  let corrupt = false, reads = 0
  const disk = new DirectoryRestoreStore(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => {
    if (!corrupt) return bytes.toString()
    if (failurePoint === "decrypt") throw new Error("Authentication tag mismatch")
    return failurePoint === "record binding" ? JSON.stringify({ key: "another record", value: "{}" }) : "{"
  } })
  disk.set(cursor, env.data.get(cursor)!)
  const get = env.store.get
  const read = vi.spyOn(env.store, "get").mockImplementation(key => {
    if (key !== cursor) return get(key)
    corrupt = ++reads > 2
    return restorePersistence(() => disk.get(key))
  })
  try {
    await expect(service.prepare(tenant, env.request, { ...relationshipOptions, previousRunId: first.runId }, env.read)).rejects.toMatchObject({ constructor: RestoreSafetyError, message: "Directory restore history could not be verified. No write was sent." })
    expect(reads).toBe(3)
    expect([...env.data.keys()].filter(key => key.startsWith("restore.directory.review."))).toHaveLength(1)
    expect(env.writes).toHaveLength(50)
  } finally { read.mockRestore(); rmSync(directory, { recursive: true, force: true }) }
})


it.each(["resume", "restore"])("checks the cached owner before %s backup loading or reservation", async action => {
  const env = world(1), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const connection = vi.fn(env.connection), localOwner = vi.fn(env.connection)
  const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), connection, localOwner, env.fetcher, () => [], env.settings)
  setDirectoryRestoreService(service)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const storage = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("oauth2")) { entered(); await gate; return Response.json({ access_token: "storage-token" }) }
    if (url.endsWith("metadata.json")) return Response.json({ TenantId: tenant })
    return Response.json(env.request.snapshot)
  })
  vi.stubGlobal("fetch", storage)
  const request = () => new Request("http://localhost/api/restore-directory", { method: "POST", body: JSON.stringify({ tenantId: tenant, appId: app, clientSecret: "delegated", storageAccountName: "fixtureaccount", backupId: "backup", path: env.request.path, runId: page.runId, fingerprint: page.fingerprint, approvals: { [page.rows[0]!.key]: page.rows[0]!.review.approvals }, stage: "relationships", action }) }) as Parameters<typeof restoreDirectory>[0]
  const dispatch = () => restoreDirectory(request())
  let pending: ReturnType<typeof dispatch> | undefined
  try {
    localOwner.mockImplementation(async () => ({ ...await env.connection(), userId: id(800) }))
    const idleRequest = request()
    const controllers = vi.spyOn(globalThis, "AbortController")
    try {
      expect(await (await restoreDirectory(idleRequest)).json()).toEqual({ error: "Use the admin and connection that reviewed this page." })
      expect(controllers).not.toHaveBeenCalled()
    } finally { controllers.mockRestore() }
    expect(storage).not.toHaveBeenCalled()
    localOwner.mockImplementation(env.connection)
    pending = dispatch()
    await started
    const reads = storage.mock.calls.length
    expect(reads).toBe(1)
    localOwner.mockImplementation(async () => ({ ...await env.connection(), userId: id(800) }))
    const concurrentRequest = request()
    const controllersDuringLoad = vi.spyOn(globalThis, "AbortController")
    try {
      expect(await (await restoreDirectory(concurrentRequest)).json()).toEqual({ error: "Use the admin and connection that reviewed this page." })
      expect(controllersDuringLoad).not.toHaveBeenCalled()
    } finally { controllersDuringLoad.mockRestore() }
    expect(storage).toHaveBeenCalledTimes(reads)
    expect(connection).not.toHaveBeenCalled()
    expect(await service.cancel(tenant, page.runId).catch(error => error.message)).toBe("Use the admin and connection that reviewed this page.")
    localOwner.mockImplementation(env.connection)
    expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: true })
    release()
    expect(await (await pending).json()).toEqual({ cancelled: true })
    expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: false })
    expect(connection).not.toHaveBeenCalled(); expect(env.writes).toEqual([])
  } finally { release(); await pending; vi.unstubAllGlobals() }
})

it.each(["resume", "execute"])("requires a fresh matching connection after local owner verification for %s", async action => {
  const env = world(1), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const connection = vi.fn(async () => {
    const current = { ...await env.connection(), userId: id(800) }
    return { ...current, token: `h.${Buffer.from(JSON.stringify({ tid: tenant, oid: current.userId, appid: app, scp: "Group.ReadWrite.All" })).toString("base64url")}.s` }
  }), localOwner = vi.fn(env.connection)
  const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), connection, localOwner, env.fetcher, () => [], env.settings)
  const before = new Map(env.data), calls = env.fetcher.mock.calls.length, request = { ...env.request, runId: page.runId }
  const result = action === "resume" ? service.resume(tenant, request) : service.execute(tenant, request, page.fingerprint, { [page.rows[0]!.key]: page.rows[0]!.review.approvals })
  await expect(result).rejects.toThrow("Use the admin and connection that reviewed this page.")
  expect(localOwner).toHaveBeenCalledTimes(2); expect(connection).toHaveBeenCalledOnce()
  expect(env.data).toEqual(before); expect(env.fetcher).toHaveBeenCalledTimes(calls); expect(env.writes).toEqual([])
  expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: false })
})

it.each(["community", "stale entitlement"].flatMap(plan => ["cancel", "discard"].map(action => ({ plan, action }))))("allows local $action through the desktop host with $plan without plan or network requests", async ({ plan, action }) => {
  const env = world(1), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const connection = vi.fn(async () => { throw new Error("Token refresh unavailable") }), localOwner = vi.fn(env.connection)
  const graph = vi.fn(async () => { throw new Error("Graph unavailable") })
  const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), connection, localOwner, graph, () => [], env.settings)
  setDirectoryRestoreService(service)
  const planOf = vi.fn(() => plan === "community" ? Promise.resolve("community" as const) : new Promise<never>(() => {}))
  const host = new ApiHost({ routes: { "/api/restore-directory": { POST: restoreDirectory } }, guard: planGuard(planOf) })
  const network = vi.fn(async () => { throw new Error("No network access") })
  vi.stubGlobal("fetch", network)
  let release!: () => void, entered!: () => void, signal: AbortSignal | undefined
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = action === "cancel" ? service.operation(tenant, page.runId, async active => { signal = active; entered(); await new Promise<void>(resolve => { release = resolve }); return { cancelled: active.aborted } }) : undefined
  if (pending) await started
  try {
    const response = await host.dispatch(new Request("http://tenuvault.internal/api/restore-directory", { method: "POST", body: JSON.stringify({ tenantId: tenant, appId: app, clientSecret: "delegated", runId: page.runId, action }) }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject(action === "cancel" ? { cancelled: true } : { runId: page.runId, discarded: true, canDiscard: false })
    if (action === "cancel") expect(signal?.aborted).toBe(true)
    else expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).discarded[page.runId]).toBe(true)
    expect(localOwner).toHaveBeenCalledTimes(action === "cancel" ? 2 : 1)
    expect(planOf).not.toHaveBeenCalled(); expect(connection).not.toHaveBeenCalled(); expect(graph).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled(); expect(env.writes).toEqual([])
  } finally { release?.(); await pending; vi.unstubAllGlobals() }
})

it.each(["userId", "tenantId", "clientId"] as const)("checks the cached %s before any next-page publication retry or Graph read", async changed => {
  const env = world(51), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const localOwner = vi.fn(async () => ({ ...await env.connection(), [changed]: id(800) })), connection = vi.fn(env.connection)
  const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), connection, localOwner, env.fetcher, () => [], env.settings)
  await queueUnpublishedCleanup(env, service)
  connection.mockClear()
  const deletes = vi.spyOn(env.store, "delete")
  const publications = vi.spyOn(DirectoryPendingPublications.prototype, "forTenant"), get = vi.spyOn(env.store, "get"), before = new Map(env.data), calls = env.fetcher.mock.calls.length, read = vi.fn(env.read)
  try {
    await expect(service.prepare(tenant, env.request, { ...options, stage: "relationships", previousRunId: page.runId }, read)).rejects.toThrow("Use the admin and connection that reviewed this page.")
    expect(get.mock.calls).toEqual([[`restore.directory.review.${tenant}.${page.runId}`]])
    expect(deletes).not.toHaveBeenCalled(); expect(publications).not.toHaveBeenCalled(); expect(connection).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
    expect(env.fetcher).toHaveBeenCalledTimes(calls); expect(env.data).toEqual(before); expect(env.writes).toEqual([])
  } finally { deletes.mockRestore(); publications.mockRestore(); get.mockRestore() }
})

it.each(["token", "metadata", "snapshot"])("checks the next-page owner before backup loading and again after an account switch during %s loading", async phase => {
  const env = world(51), page = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)
  const localOwner = vi.fn(env.connection), connection = vi.fn(env.connection)
  const service = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), connection, localOwner, env.fetcher, () => [], env.settings)
  await queueUnpublishedCleanup(env, service)
  localOwner.mockClear(); connection.mockClear()
  const deletes = vi.spyOn(env.store, "delete")
  setDirectoryRestoreService(service)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const storage = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input), part = url.includes("oauth2") ? "token" : url.endsWith("metadata.json") ? "metadata" : "snapshot"
    if (part === phase) { entered(); await gate }
    return Response.json(part === "token" ? { access_token: "storage-token" } : part === "metadata" ? { TenantId: tenant } : env.request.snapshot)
  })
  vi.stubGlobal("fetch", storage)
  const request = () => new Request("http://localhost/api/restore-directory", { method: "POST", body: JSON.stringify({ tenantId: tenant, appId: app, clientSecret: "delegated", storageAccountName: "fixtureaccount", backupId: "backup", path: env.request.path, previousRunId: page.runId, stage: "relationships", action: "preview" }) }) as Parameters<typeof restoreDirectory>[0]
  const publications = vi.spyOn(DirectoryPendingPublications.prototype, "forTenant"), get = vi.spyOn(env.store, "get"), before = new Map(env.data), calls = env.fetcher.mock.calls.length
  let pending: ReturnType<typeof restoreDirectory> | undefined
  try {
    localOwner.mockImplementation(async () => ({ ...await env.connection(), userId: id(800) }))
    expect(await (await restoreDirectory(request())).json()).toEqual({ error: "Use the admin and connection that reviewed this page." })
    expect(storage).not.toHaveBeenCalled(); expect(publications).not.toHaveBeenCalled()
    expect(get.mock.calls).toEqual([[`restore.directory.review.${tenant}.${page.runId}`]])
    localOwner.mockImplementation(env.connection); get.mockClear()
    pending = restoreDirectory(request())
    await started
    expect(localOwner).toHaveBeenCalledTimes(2)
    expect(get.mock.calls).toEqual([[`restore.directory.review.${tenant}.${page.runId}`]])
    localOwner.mockImplementation(async () => ({ ...await env.connection(), userId: id(800) }))
    release()
    const response = await pending
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "Use the admin and connection that reviewed this page." })
    expect(localOwner).toHaveBeenCalledTimes(3)
    expect(get.mock.calls).toEqual(Array.from({ length: 2 }, () => [`restore.directory.review.${tenant}.${page.runId}`]))
    expect(deletes).not.toHaveBeenCalled(); expect(publications).not.toHaveBeenCalled(); expect(connection).not.toHaveBeenCalled()
    expect(env.fetcher).toHaveBeenCalledTimes(calls); expect(env.data).toEqual(before); expect(env.writes).toEqual([])
  } finally { release(); await pending; deletes.mockRestore(); publications.mockRestore(); get.mockRestore(); vi.unstubAllGlobals() }
})


it.each(["raw", "wrapped"].flatMap(transport => ["recovered", "role revoked", "object appeared"].map(recovery => ({ transport, recovery }))))("durably defers a $transport proxy 407 group create and repeats safety checks after $recovery", async ({ transport, recovery }) => {
  const env = world(0, true), original = env.fetcher.getMockImplementation()!
  const graph = transport === "wrapped" ? withNetworkErrors(rejectProxyAuthResponses(env.fetcher)) : env.fetcher
  const service = () => new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), env.connection, env.connection, graph, () => [], env.settings)
  const page = await service().prepare(tenant, env.request, options, env.read)
  const request = { ...env.request, runId: page.runId }, approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
  let proxy = true, posts = 0, roleReads = 0
  env.fetcher.mockImplementation((input, init) => {
    const path = new URL(String(input)).pathname
    if (path === "/v1.0/groups" && init?.method === "POST") {
      posts++
      if (proxy) return Promise.resolve(new Response("Proxy authentication required", { status: 407 }))
    }
    if (path === "/v1.0/roleManagement/directory/roleAssignments") {
      roleReads++
      if (!proxy && recovery === "role revoked") return Promise.resolve(Response.json({ value: [] }))
    }
    if (!proxy && recovery === "object appeared" && path === `/v1.0/groups/${resource}`) return Promise.resolve(Response.json(env.group))
    return original(input, init)
  })
  const result = await service().execute(tenant, request, page.fingerprint, approvals)
  expect(result).toMatchObject({ status: "partial", failed: 0, canDiscard: true, unresolved: true, outcomes: [{ state: "deferred", reason: expect.stringContaining("proxy requires authentication") }] })
  const journalKey = `restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`
  const entry = JSON.parse(env.data.get(journalKey)!).runs[page.runId].entries[0]
  expect(entry).toMatchObject({ state: "deferred", attempt: 1, retryAt: expect.any(Number) })
  const coordinator = JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!)
  expect(coordinator.locks[resource]).toMatchObject({ owner: page.runId, rejected: { step: page.rows[0]!.key, attempt: 1 } })
  expect(coordinator.deadlines[resource]).toBe(entry.retryAt)
  expect(posts).toBe(1); expect(env.writes).toEqual([])
  proxy = false
  const resumed = await service().resume(tenant, request)
  expect(resumed.outcomes).toEqual(result.outcomes)
  expect(posts).toBe(1)
  const reads = roleReads
  const settled = await service().execute(tenant, request, page.fingerprint, approvals)
  expect(settled).toMatchObject(recovery === "recovered" ? { status: "partial", failed: 0, warnings: [expect.stringContaining("reference scan did not complete")], outcomes: [{ state: "applied", targetId: id(900) }] } : { status: "partial", failed: 1, outcomes: [{ state: "blocked" }] })
  if (recovery === "recovered") {
    expect(roleReads).toBeGreaterThan(reads)
    expect(env.writes).toEqual(["POST groups"]); expect(posts).toBe(2)
    await service().execute(tenant, request, page.fingerprint, approvals)
    expect(env.writes).toEqual(["POST groups"]); expect(posts).toBe(2)
  } else { expect(env.writes).toEqual([]); expect(posts).toBe(1) }
})

it.each(["timeout", "proxy transport", "proxy auth hint", "503"])("keeps a group create uncertain after ambiguous $0 failure without another POST", async failure => {
  const env = world(0, true), service = env.service(), page = await service.prepare(tenant, env.request, options, env.read), original = env.fetcher.getMockImplementation()!
  let posts = 0
  env.fetcher.mockImplementation((input, init) => {
    if (new URL(String(input)).pathname === "/v1.0/groups" && init?.method === "POST") {
      posts++
      if (failure === "503") return Promise.resolve(new Response(null, { status: 503 }))
      return Promise.reject(failure === "timeout" ? new DOMException("Timeout", "TimeoutError") : new Error(failure === "proxy transport" ? "net::ERR_PROXY_CONNECTION_FAILED" : "net::ERR_PROXY_AUTH_REQUESTED"))
    }
    return original(input, init)
  })
  const request = { ...env.request, runId: page.runId }, approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
  expect(await service.execute(tenant, request, page.fingerprint, approvals)).toMatchObject({ canDiscard: false, outcomes: [{ state: "uncertain" }] })
  expect(await env.service().resume(tenant, request)).toMatchObject({ canDiscard: false, outcomes: [{ state: "uncertain" }] })
  expect(await env.service().execute(tenant, request, page.fingerprint, approvals)).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  expect(posts).toBe(1); expect(env.writes).toEqual([])
})

it("returns all saved outcomes and retry times on Resume including unstarted approved rows", async () => {
  const env = world(25), service = env.service(), page = await service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read), original = env.fetcher.getMockImplementation()!
  let posts = 0
  env.fetcher.mockImplementation((input, init) => {
    if (init?.method === "POST") {
      const status = { 1: 403, 3: 429 }[++posts]
      if (status) return Promise.resolve(new Response(null, { status, headers: { "Retry-After": "120" } }))
    }
    return original(input, init)
  })
  const request = { ...env.request, runId: page.runId }
  const result = await service.execute(tenant, request, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  expect(result.outcomes).toHaveLength(25)
  expect(result.outcomes.slice(0, 3)).toMatchObject([{ state: "failed", reason: expect.any(String) }, { state: "applied", targetId: resource }, { state: "deferred", retryAt: expect.any(Number) }])
  expect(result.outcomes.slice(20)).toEqual(page.rows.slice(20).map(row => ({ key: row.key, state: "pending" })))
  const sends = posts, saved = new Map(env.data)
  const resumed = await env.service().resume(tenant, request)
  expect(resumed.outcomes).toEqual(result.outcomes)
  expect(resumed).toMatchObject({ unresolved: true, canDiscard: true, selection: page.rows.map(row => row.key) })
  expect(posts).toBe(sends); expect(env.data).toEqual(saved)
})

it.each(["journal", "coordinator"])("recovers a known-unsent proxy 407 create after a failed %s publication", async record => {
  const env = world(0, true), service = env.service(), page = await service.prepare(tenant, env.request, options, env.read), original = env.fetcher.getMockImplementation()!
  const request = { ...env.request, runId: page.runId }, approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
  const journalKey = `restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`, coordinatorKey = `restore.directory.coordinator.${tenant}`
  let proxy = true, unavailable = false, posts = 0
  env.fetcher.mockImplementation((input, init) => {
    if (new URL(String(input)).pathname === "/v1.0/groups" && init?.method === "POST") {
      posts++
      if (proxy) { unavailable = true; return Promise.resolve(new Response(null, { status: 407 })) }
    }
    return original(input, init)
  })
  const set = env.store.set, spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (unavailable && key === (record === "journal" ? journalKey : coordinatorKey)) throw new Error("Restore publication unavailable")
    set(key, value)
  })
  try {
    await expect(service.execute(tenant, request, page.fingerprint, approvals)).rejects.toBeInstanceOf(DirectoryRetryPersistenceError)
    if (record === "journal") {
      expect(JSON.parse(env.data.get(journalKey)!).runs[page.runId].entries[0].state).toBe("uncertain")
      expect(JSON.parse(env.data.get(coordinatorKey)!).locks[resource].rejected).toEqual({ step: page.rows[0]!.key, attempt: 1, cause: "proxy" })
    } else expect(JSON.parse(env.data.get(journalKey)!).runs[page.runId].entries[0]).toMatchObject({ state: "deferred", attempt: 1 })
    expect(env.writes).toEqual([]); expect(posts).toBe(1)
    unavailable = false; proxy = false; spy.mockRestore()
    expect(await service.resume(tenant, request)).toMatchObject({ outcomes: [{ state: "deferred" }], canDiscard: true })
    expect(await env.service().execute(tenant, request, page.fingerprint, approvals)).toMatchObject({ failed: 0, outcomes: [{ state: "applied", targetId: id(900) }] })
    expect(env.writes).toEqual(["POST groups"]); expect(posts).toBe(2)
  } finally { spy.mockRestore() }
})

it.each([407, 408, 429, 503, "network"] as const)("retries the same 51-member preview slice after a %s safety read without saving a blocker", async failure => {
  const env = world(51), first = await env.service().prepare(tenant, env.request, { ...options, stage: "relationships", exactOwners: true }, env.read)
  expect(first.rows).toHaveLength(50); expect(first.more).toBe(true)
  await env.service().saved(tenant, first.runId, "discard")
  const original = env.fetcher.getMockImplementation()!, previous = env.data.get(`restore.directory.review.${tenant}.${first.runId}`)
  const continuation = { ...first.options, previousRunId: first.runId }
  let failures = 0
  env.fetcher.mockImplementation((input, init) => {
    if (String(input).includes("conditionalAccess") && failures++ === 0) return failure === "network" ? Promise.reject(new Error("Connection lost")) : Promise.resolve(new Response(null, { status: failure, headers: { "Retry-After": "120" } }))
    return original(input, init)
  })
  await expect(env.service().prepare(tenant, env.request, continuation, env.read)).rejects.toBeInstanceOf(RestoreWriteDeferredError)
  expect([...env.data.keys()].filter(key => key.startsWith("restore.directory.review."))).toEqual([`restore.directory.review.${tenant}.${first.runId}`])
  expect(env.data.get(`restore.directory.review.${tenant}.${first.runId}`)).toBe(previous)
  env.fetcher.mockImplementation(original)
  const recovered = await env.service().prepare(tenant, env.request, continuation, env.read)
  expect(recovered.options).toEqual(continuation); expect(recovered.rows).toHaveLength(1); expect(recovered.more).toBe(false)
  expect(recovered.rows[0]!.review.principal?.id).toBe(id(150)); expect(recovered.rows[0]!.review.blocker).toBeUndefined()
  expect(recovered.rows[0]!.review.approvals).toContain("directory-item"); expect(env.writes).toEqual([])
})

it.each(["matching", "wrong step", "wrong attempt"])("discards a coordinator-only rejected proxy create offline only with a %s attempt marker", async marker => {
  const env = world(0, true), service = env.service(), page = await service.prepare(tenant, env.request, options, env.read), original = env.fetcher.getMockImplementation()!
  const journalKey = `restore.directory.${tenant}.${page.runId}.batch.0.restore.guarded.${tenant}`, coordinatorKey = `restore.directory.coordinator.${tenant}`
  let unavailable = false, posts = 0
  env.fetcher.mockImplementation((input, init) => {
    if (new URL(String(input)).pathname === "/v1.0/groups" && init?.method === "POST") { posts++; unavailable = true; return Promise.resolve(new Response(null, { status: 407 })) }
    return original(input, init)
  })
  const set = env.store.set, spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (unavailable && key === journalKey) throw new Error("Journal publication unavailable")
    set(key, value)
  })
  try {
    await expect(service.execute(tenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).rejects.toBeInstanceOf(DirectoryRetryPersistenceError)
    expect(JSON.parse(env.data.get(journalKey)!).runs[page.runId].entries[0]).toMatchObject({ state: "uncertain", attempt: 1 })
    const coordinator = JSON.parse(env.data.get(coordinatorKey)!), deadline = Date.now() + 120_000
    expect(coordinator.locks[resource].rejected).toEqual({ step: page.rows[0]!.key, attempt: 1, cause: "proxy" })
    coordinator.deadlines[resource] = deadline
    if (marker === "wrong step") coordinator.locks[resource].rejected.step = "different-step"
    if (marker === "wrong attempt") coordinator.locks[resource].rejected.attempt++
    env.data.set(coordinatorKey, JSON.stringify(coordinator))
    unavailable = false; spy.mockRestore()
    const beforeResume = new Map(env.data)
    const resumed = await env.service().resume(tenant, { ...env.request, runId: page.runId })
    expect(resumed.canDiscard).toBe(marker === "matching")
    expect(resumed.outcomes[0]!.state).toBe("uncertain")
    expect(env.data).toEqual(beforeResume)
    const beforeConfirm = new Map(env.data)
    const confirmed = await env.service().saved(tenant, page.runId, "reconcile")
    expect(confirmed.canDiscard).toBe(marker === "matching")
    expect(confirmed.outcomes[0]!.state).toBe("uncertain")
    expect(env.data).toEqual(beforeConfirm)
    const calls = env.fetcher.mock.calls.length, online = vi.fn(async () => { throw new Error("Proxy still requires authentication") })
    env.fetcher.mockImplementation(async () => new Response(null, { status: 407 }))
    const restarted = new DirectoryRestoreService(env.store, new RecoveryAccounts(env.store), online, env.connection, env.fetcher, () => [], env.settings)
    if (marker === "matching") {
      expect(await restarted.saved(tenant, page.runId, "discard")).toMatchObject({ discarded: true, unresolved: false, outcomes: [{ state: "deferred", retryAt: deadline, deferralCause: "proxy" }] })
      const saved = JSON.parse(env.data.get(coordinatorKey)!)
      expect(saved.discarded[page.runId]).toBe(true); expect(saved.locks).toEqual({}); expect(saved.deadlines[resource]).toBe(deadline)
    } else {
      await expect(restarted.saved(tenant, page.runId, "discard")).rejects.toThrow("Confirm the uncertain result")
      expect(JSON.parse(env.data.get(coordinatorKey)!).locks[resource].owner).toBe(page.runId)
      expect(JSON.parse(env.data.get(journalKey)!).runs[page.runId].entries[0].state).toBe("uncertain")
    }
    expect(online).not.toHaveBeenCalled(); expect(env.fetcher).toHaveBeenCalledTimes(calls); expect(posts).toBe(1); expect(env.writes).toEqual([])
  } finally { spy.mockRestore() }
})


it.each(["coordinator saved", "journal only"])("recovers a completed page's released-lock deadline from %s before another group PATCH", async publication => {
  vi.useFakeTimers({ toFake: ["Date"] })
  let time = Date.now()
  const env = world(0, false, () => time), service = env.service()
  env.group.description = "Live"
  const request = { ...env.request, snapshot: { ...env.request.snapshot, description: "First" } }
  const page = await service.prepare(tenant, request, options, env.read)
  const approvals = Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals]))
  expect(await service.execute(tenant, { ...request, runId: page.runId }, page.fingerprint, approvals)).toMatchObject({ status: "complete" })
  const coordinatorKey = `restore.directory.coordinator.${tenant}`, journalKey = directoryPagePrefix(tenant, page.runId) + `batch.0.restore.guarded.${tenant}`
  expect(JSON.parse(env.data.get(coordinatorKey)!).locks).toEqual({})
  const original = env.fetcher.getMockImplementation()!, deadline = time + 120_000
  env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname === "/v1.0/applications" ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": new Date(deadline).toUTCString() } })) : original(input, init))
  const set = env.store.set, spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (publication === "journal only" && key === coordinatorKey) throw new Error("Coordinator unavailable")
    set(key, value)
  })
  try {
    await expect(service.saved(tenant, page.runId, "reconcile")).rejects.toThrow(publication === "journal only" ? "retry deadline could not be saved" : "throttled")
    const retryAt = JSON.parse(env.data.get(journalKey)!).runs[page.runId].entries[0].retryAt
    expect(retryAt).toBeGreaterThan(time); expect(retryAt).toBeLessThanOrEqual(deadline)
    expect(JSON.parse(env.data.get(coordinatorKey)!).locks).toEqual({})
    spy.mockRestore(); env.fetcher.mockImplementation(original)
    const replacementRequest = { ...request, snapshot: { ...request.snapshot, description: "Second" } }
    // A fresh service recovers the journal half during the next tenant operation.
    const replacement = await env.service().prepare(tenant, replacementRequest, options, env.read)
    expect(JSON.parse(env.data.get(coordinatorKey)!).deadlines[resource]).toBe(retryAt)
    // Restart again to prove the target-indexed coordinator half is durable.
    const restarted = env.service(), replacementApprovals = Object.fromEntries(replacement.rows.map(row => [row.key, row.review.approvals]))
    expect(await restarted.execute(tenant, { ...replacementRequest, runId: replacement.runId }, replacement.fingerprint, replacementApprovals)).toMatchObject({ outcomes: [{ state: "deferred", retryAt }] })
    expect(env.writes).toEqual([`PATCH groups/${resource}`])
    time = retryAt; vi.setSystemTime(time)
    expect(await env.service().execute(tenant, { ...replacementRequest, runId: replacement.runId }, replacement.fingerprint, replacementApprovals)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
    expect(env.writes).toEqual([`PATCH groups/${resource}`, `PATCH groups/${resource}`])
    expect(JSON.parse(env.data.get(coordinatorKey)!).deadlines).toEqual({})
    expect(env.data.has(`restore.directory.retry-journals.${tenant}`)).toBe(false)
  } finally { spy.mockRestore(); vi.useRealTimers() }
})

it.each(["review", "page save", "principal save after publication"])("removes unpublished first-page inventory and principal records after repeated %s failures", async phase => {
  const env = world(1001), original = env.fetcher.getMockImplementation()!
  if (phase === "review") env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname.startsWith("/v1.0/identity/conditionalAccess/") ? Promise.resolve(new Response(null, { status: 503 })) : original(input, init))
  const set = env.store.set, spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (phase === "page save" && key.startsWith("restore.directory.review.")) throw new Error("Preview save unavailable")
    set(key, value)
    if (phase === "principal save after publication" && key.startsWith("restore.directory.principals.")) throw new Error("Preview save unavailable")
  })
  try {
    const before = new Map(env.data)
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)).rejects.toThrow(phase === "review" ? "temporary Microsoft Graph read failure" : "Preview save unavailable")
      expect(env.data).toEqual(before)
      expect([...env.data.keys()].filter(key => /^restore\.directory\.(inventory|principals|review)\./.test(key))).toEqual([])
    }
    expect(env.writes).toEqual([])
  } finally { spy.mockRestore() }
})

it("retains first-page inventory when the review save publishes before reporting a storage failure", async () => {
  const env = world(1), set = env.store.set
  const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    set(key, value)
    if (key.startsWith("restore.directory.review.")) throw new Error("Review sync failed after publication")
  })
  try {
    await expect(env.service().prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)).rejects.toThrow("Review sync failed after publication")
    const review = [...env.data.entries()].find(([key]) => key.startsWith("restore.directory.review."))!
    const page = JSON.parse(review[1])
    expect(env.data.has(`restore.directory.inventory.${tenant}.${page.inventory.id}.0`)).toBe(true)
    expect(env.data.has(`restore.directory.principals.${tenant}.${page.inventory.id}.0`)).toBe(true)
    expect(await env.service().resume(tenant, { ...env.request, runId: page.run.id })).toMatchObject({ runId: page.run.id, rows: [{ key: page.rows[0].key }] })
    expect(env.writes).toEqual([])
  } finally { spy.mockRestore() }
})


it.each([false, true])("retains an empty relationship page's confirmation deadline on its inventory target (mapped: %s)", async mapped => {
  vi.useFakeTimers({ toFake: ["Date"] })
  const env = world(), service = env.service(), source = mapped ? id(99) : resource
  if (mapped) env.data.set(directoryMappingKey(tenant, "Groups", source), resource)
  const request = { ...env.request, path: `backup/Groups/${source}.json`, snapshot: { ...env.request.snapshot, id: source } }
  const page = await service.prepare(tenant, request, { ...options, stage: "relationships" }, env.read)
  expect(page.rows).toEqual([])
  env.data.set(directoryMappingKey(tenant, "Groups", resource), id(777))
  const original = env.fetcher.getMockImplementation()!, retryAt = Date.now() + 120_000
  env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname === "/v1.0/applications" ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  try {
    await expect(service.saved(tenant, page.runId, "reconcile")).rejects.toThrow("throttled")
    expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).deadlines).toEqual({ [resource]: retryAt })
    env.data.delete(directoryMappingKey(tenant, "Groups", resource))
    env.fetcher.mockImplementation(original)
    const update = { ...request, snapshot: { ...request.snapshot, description: "Saved" } }
    const next = await env.service().prepare(tenant, update, options, env.read), approvals = Object.fromEntries(next.rows.map(row => [row.key, row.review.approvals]))
    vi.setSystemTime(retryAt - 1)
    expect(await env.service().execute(tenant, { ...update, runId: next.runId }, next.fingerprint, approvals)).toMatchObject({ outcomes: [{ state: "deferred", retryAt }] })
    expect(env.writes).toEqual([])
    vi.setSystemTime(retryAt)
    expect(await env.service().execute(tenant, { ...update, runId: next.runId }, next.fingerprint, approvals)).toMatchObject({ outcomes: [{ state: "applied" }] })
    expect(env.writes).toEqual([`PATCH groups/${resource}`])
  } finally { vi.useRealTimers() }
})

it.each(["principals", "inventory"])("attempts every unpublished delete after a %s failure and retries leftovers on the next preview", async kind => {
  const env = world(1001), service = env.service(), original = env.fetcher.getMockImplementation()!, remove = env.store.delete
  const deleted: string[] = []
  const save = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key.startsWith("restore.directory.review.")) throw new Error("Preview save unavailable")
    env.data.set(key, value)
  })
  const spy = vi.spyOn(env.store, "delete").mockImplementation(key => {
    deleted.push(key)
    if (key.startsWith(`restore.directory.${kind}.`) && key.endsWith(".0")) throw new Error("Delete unavailable")
    remove(key)
  })
  try {
    await expect(service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)).rejects.toThrow("Preview save unavailable")
    const leftovers = [...env.data.keys()].filter(key => /^restore\.directory\.(inventory|principals)\./.test(key))
    expect(leftovers).toHaveLength(1); expect(leftovers[0]).toContain(`.${kind}.`); expect(leftovers[0]).toMatch(/\.0$/)
    expect(deleted.filter(key => key.startsWith("restore.directory.inventory."))).toHaveLength(21)
    expect(deleted.filter(key => key.startsWith("restore.directory.principals."))).toHaveLength(2)
    spy.mockRestore()
    env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname === "/v1.0/applications" ? Promise.resolve(new Response(null, { status: 503 })) : original(input, init))
    await expect(service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)).rejects.toThrow()
    expect([...env.data.keys()].filter(key => /^restore\.directory\.(inventory|principals|review)\./.test(key))).toEqual([])
    expect(env.writes).toEqual([])
  } finally { spy.mockRestore(); save.mockRestore() }
})

it.each(["lock", "indexed journal"])("isolates a damaged throttled object's %s from another group's preview and execution", async damage => {
  const env = world(), service = env.service(), request = { ...env.request, snapshot: { ...env.request.snapshot, description: "First" } }
  const page = await service.prepare(tenant, request, options, env.read)
  await service.execute(tenant, { ...request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  const prefix = directoryPagePrefix(tenant, page.runId) + "batch.0.", deadline = Date.now() + 120_000
  const objects = directoryObjectState(env.store, tenant, page.runId)
  objects.trackRetryJournals([{ prefix, targets: [resource] }], deadline)
  if (damage === "lock") env.data.set(`restore.directory.coordinator.${tenant}`, JSON.stringify({ locks: { [resource]: { owner: page.runId, journal: "damaged" } }, deadlines: {}, discarded: {} }))
  else env.data.set(prefix + `restore.guarded.${tenant}`, "{")
  const original = env.fetcher.getMockImplementation()!, other = id(999)
  env.fetcher.mockImplementation((input, init) => new URL(String(input)).pathname === `/v1.0/groups/${other}` && (!init?.method || init.method === "GET") ? Promise.resolve(Response.json({ ...env.group, id: other, description: "Live" })) : original(input, init))
  const unrelated = { ...request, path: `backup/Groups/${other}.json`, snapshot: { ...request.snapshot, id: other } }
  const reads = vi.spyOn(env.store, "get")
  try {
    const next = await env.service().prepare(tenant, unrelated, options, env.read)
    expect(reads.mock.calls.some(([key]) => key.startsWith(prefix))).toBe(false)
    expect(await env.service().execute(tenant, { ...unrelated, runId: next.runId }, next.fingerprint, Object.fromEntries(next.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ outcomes: [{ state: "applied" }] })
    await expect(env.service().prepare(tenant, request, options, env.read)).rejects.toThrow(`state for object ${resource} could not be verified`)
    expect(env.writes).toEqual([`PATCH groups/${resource}`, `PATCH groups/${other}`])
  } finally { reads.mockRestore() }
})

it("recovers indexed target deadlines without reading page batches and normalizes tenant casing", async () => {
  const env = world(), page = await env.service().prepare(tenant, env.request, options, env.read)
  const mixedTenant = "abcdefab-ABCD-4000-8000-abcdefabcdef", lowerTenant = mixedTenant.toLowerCase(), deadline = Date.now() + 120_000
  const prefix = directoryPagePrefix(mixedTenant, page.runId) + "batch.0."
  expect(prefix).toBe(directoryPagePrefix(lowerTenant, page.runId) + "batch.0.")
  const run = { ...JSON.parse(env.data.get(`restore.directory.review.${tenant}.${page.runId}`)!).run, tenant: mixedTenant }
  const journal = new GuardedRunJournal({ get: key => env.store.get(prefix + key), set: (key, value) => env.store.set(prefix + key, value), delete: key => env.store.delete(prefix + key) })
  journal.save(run)
  directoryObjectState(env.store, mixedTenant, page.runId).trackRetryJournals([{ prefix, targets: [resource.toUpperCase()] }], deadline)
  const reads = vi.spyOn(env.store, "get")
  try {
    directoryObjectState(env.store, lowerTenant, "").recoverRetryDeadlines()
    expect(reads.mock.calls.some(([key]) => key.startsWith(prefix))).toBe(false)
    expect(JSON.parse(env.data.get(`restore.directory.coordinator.${lowerTenant}`)!).deadlines[resource]).toBe(deadline)
    expect(directoryObjectState(env.store, lowerTenant, "").recoverMappings([{ folder: "Groups", sourceId: resource }])).toEqual(new Set())
    expect(env.data.has(`restore.directory.retry-journals.${lowerTenant}`)).toBe(true)
  } finally { reads.mockRestore() }
})


it("sends two additions to the same group for a mixed-case tenant using one normalized history", async () => {
  const mixedTenant = "aBcDeFaB-AbCd-4000-8000-aBcDeFaBcDeF", env = world(2, false, Date.now, mixedTenant), service = env.service()
  const page = await service.prepare(mixedTenant, env.request, { ...options, stage: "relationships" }, env.read)
  expect(page.rows).toHaveLength(2)
  expect(await service.execute(mixedTenant, { ...env.request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }, { state: "applied" }] })
  expect(env.writes).toEqual(Array(2).fill(`POST groups/${resource}/members/$ref`))
  expect(env.members).toEqual(new Set(env.saved))
  const directoryKeys = [...env.data.keys()].filter(key => key.startsWith("restore.directory."))
  expect(directoryKeys.length).toBeGreaterThan(0)
  expect(directoryKeys.every(key => key.includes(mixedTenant.toLowerCase()))).toBe(true)
  expect(directoryKeys.some(key => key.includes("relationship-history."))).toBe(true)
  expect(await env.service().resume(mixedTenant.toLowerCase(), { ...env.request, runId: page.runId })).toMatchObject({ outcomes: [{ state: "applied" }, { state: "applied" }] })
})

it.each([false, true])("retries queued cleanup after a failed review publication lookup (published: %s)", async published => {
  const env = world(1), service = env.service(), set = env.store.set, get = env.store.get
  const save = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key.startsWith("restore.directory.review.")) {
      if (published) set(key, value)
      throw new Error("Review save unavailable")
    }
    set(key, value)
  })
  const lookup = vi.spyOn(env.store, "get").mockImplementation(key => {
    if (key.startsWith("restore.directory.review.")) throw new Error("Review lookup unavailable")
    return get(key)
  })
  try {
    await expect(service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)).rejects.toThrow("Review save unavailable")
    const records = [...env.data.entries()].filter(([key]) => /^restore\.directory\.(inventory|principals)\./.test(key))
    expect(records).toHaveLength(2)
    save.mockRestore(); lookup.mockRestore()
    await service.prepare(tenant, env.request, options, env.read)
    for (const [key, value] of records) expect(env.data.get(key)).toBe(published ? value : undefined)
    expect(env.writes).toEqual([])
  } finally { save.mockRestore(); lookup.mockRestore() }
})

it("refuses every requested target covered by a corrupt indexed batch", async () => {
  const env = world(), pageId = id(700), targets = [resource, id(11), id(12)], prefix = directoryPagePrefix(tenant, pageId) + "batch.0."
  directoryObjectState(env.store, tenant, pageId).trackRetryJournals([{ prefix, targets }], Date.now() + 120_000)
  env.data.set(prefix + `restore.guarded.${tenant}`, "{")
  for (const requested of [...targets.map(target => [target]), targets]) {
    expect(() => directoryObjectState(env.store, tenant, "").recoverMappings(requested.map(sourceId => ({ folder: "Groups", sourceId })))).toThrow(`state for object ${requested[0]} could not be verified`)
  }
  expect(() => directoryObjectState(env.store, tenant, "").recoverMappings([{ folder: "Groups", sourceId: id(999) }])).not.toThrow()
  expect(env.writes).toEqual([])
})

it.each([120_000, "invalid", null, [120_000]])("refuses non-current retry index evidence %j without reading old page records", value => {
  const env = world(), prefix = directoryPagePrefix(tenant, id(700)) + "batch.0."
  env.data.set(`restore.directory.retry-journals.${tenant}`, JSON.stringify({ [prefix]: value }))
  const read = vi.spyOn(env.store, "get")
  try {
    expect(() => directoryObjectState(env.store, tenant, resource).recoverMappings([{ folder: "Groups", sourceId: resource }])).toThrow(`state for object ${resource} could not be verified`)
    expect(read.mock.calls.some(([key]) => key.startsWith(prefix) || key.startsWith("restore.directory.review."))).toBe(false)
  } finally { read.mockRestore() }
})

async function queueUnpublishedCleanup(env: ReturnType<typeof world>, service: DirectoryRestoreService) {
  const set = env.store.set
  const save = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key.startsWith("restore.directory.review.")) throw new Error("Review save unavailable")
    set(key, value)
  })
  const remove = vi.spyOn(env.store, "delete").mockImplementation(() => { throw new Error("Cleanup unavailable") })
  try {
    await expect(service.prepare(tenant, env.request, { ...options, stage: "relationships" }, env.read)).rejects.toThrow("Review save unavailable")
    expect(remove).toHaveBeenCalled()
    expect([...env.data.keys()].some(key => key.startsWith("restore.directory.inventory."))).toBe(true)
  } finally { save.mockRestore(); remove.mockRestore() }
}
