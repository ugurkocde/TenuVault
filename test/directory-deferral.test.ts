import { afterEach, expect, it, vi } from "vitest"
import { DirectoryRestoreService } from "../src/main/restore/directory-service"
import { setDirectoryRestoreService } from "../src/main/restore/directory-dispatch"
import { RecoveryAccounts } from "../src/main/restore/safety-resolvers"
import { ModuleSettings } from "../src/main/services/settings"
import { POST } from "../src/portal/app/api/restore-directory/route"
import type { Item } from "../src/shared/intune/registry"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const tenant = id(1), clientId = id(2), userId = id(3), targetId = id(10), appId = id(11)
const options = { stage: "object" as const, exactMembers: false, exactOwners: false }
const folders = ["Applications", "Users", "Groups"] as const
function world(folder: typeof folders[number]) {
  const data = new Map<string, string>()
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const settings = new ModuleSettings(store)
  settings.setChoice(tenant, { entra: { access: "restore", areas: ["applications"] } })
  const token = `h.${Buffer.from(JSON.stringify({ tid: tenant, oid: userId, appid: clientId, scp: "Application.Read.All Application.ReadWrite.All User.ReadUpdate.All User.Read.All Group.ReadWrite.All Group.Read.All Policy.Read.All" })).toString("base64url")}.s`
  const live: Item = folder === "Applications" ? { id: targetId, appId, displayName: "Live", description: "Live" } : folder === "Users" ? { id: targetId, displayName: "Live", userType: "Member", accountEnabled: false } : { id: targetId, displayName: "Live", description: "Live", mailNickname: "group", groupTypes: [], mailEnabled: false, securityEnabled: true, isAssignableToRole: false }
  const targetPath = `${folder === "Applications" ? "applications" : folder === "Users" ? "users" : "groups"}/${targetId}`
  const field = folder === "Groups" ? "description" : "displayName"
  const writes: Item[] = []
  const graph = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname.replace("/v1.0/", "")
    if (init?.method && init.method !== "GET") {
      expect(path).toBe(targetPath)
      expect(init.method).toBe("PATCH")
      const body = JSON.parse(String(init.body))
      writes.push(body); Object.assign(live, body)
      return new Response(null, { status: 204 })
    }
    if (path === targetPath) return Response.json(live)
    if (path === "applications") return Response.json({ value: [{ id: id(4), appId: clientId }] })
    if (path === "servicePrincipals") return Response.json({ value: url.searchParams.get("$filter")?.includes(clientId) ? [{ id: id(5), appId: clientId }] : [{ id: id(12), appId, displayName: "App", appOwnerOrganizationId: tenant, servicePrincipalType: "Application" }] })
    if (path.startsWith("identity/conditionalAccess/") || path.endsWith("/memberOf")) return Response.json({ value: [] })
    return new Response(null, { status: 404 })
  })
  const service = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => ({ token, tenantId: tenant, clientId, userId }), graph, () => [], settings)
  const request = (backup = "backup", value = "Saved") => ({ path: `${backup}/${folder}/${targetId}.json`, origin: "restore" as const, snapshot: { ...live, [field]: value } })
  const prepare = async (requestValue = request()) => service().prepare(tenant, requestValue, options, async () => requestValue.snapshot)
  type Page = Awaited<ReturnType<typeof prepare>>
  const execute = (page: Page, requestValue = request()) => service().execute(tenant, { ...requestValue, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  const locks = () => [...data.keys()].filter(key => key.startsWith("restore.directory.unanswered."))
  const entry = (page: Page) => JSON.parse([...data.entries()].find(([key]) => key.includes(`${page.runId}.batch.0.restore.guarded.`))![1]).runs[page.runId].entries[0]
  return { data, store, graph, live, writes, targetPath, field, service, request, prepare, execute, locks, entry }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it.each(folders)("lets a newer %s backup supersede a retained or removed throttled page after its object deadline", async folder => {
  const env = world(folder), original = env.graph.getMockImplementation()!, oldRequest = env.request(), newerRequest = env.request("newer", "Newer")
  const backups = new Map([["backup", oldRequest.snapshot], ["newer", newerRequest.snapshot]])
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "storage" })
    const backup = [...backups.keys()].find(name => url.pathname.includes(`/${name}/`))
    if (!backup || url.pathname.endsWith(".tenuvault-owner.json")) return new Response(null, { status: 404 })
    return Response.json(url.pathname.endsWith("metadata.json") ? { TenantId: tenant } : backups.get(backup))
  }))
  const call = async (backup: string, body: object) => {
    setDirectoryRestoreService(env.service())
    return POST(new Request("http://localhost/api/restore-directory", { method: "POST", body: JSON.stringify({ tenantId: tenant, appId: clientId, clientSecret: "placeholder", storageAccountName: "store", backupId: backup, path: `${backup}/${folder}/${targetId}.json`, stage: "object", ...body }) }) as Parameters<typeof POST>[0])
  }
  const response = await call("backup", { action: "preview" }), page = await response.json()
  expect(response.status).toBe(200)
  const oldBody = { action: "restore", runId: page.runId, fingerprint: page.fingerprint, approvals: { [page.rows[0].key]: page.rows[0].review.approvals } }
  let sends = 0
  env.graph.mockImplementation((input, init) => init?.method === "PATCH" && ++sends === 1 ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  vi.useFakeTimers()
  const deadline = Date.now() + 120_000
  expect(await (await call("backup", oldBody)).json()).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "captured" }] })
  expect(env.entry(page).retryAt).toBe(deadline)
  expect(env.locks()).toEqual([])
  backups.delete("backup")
  expect((await call("backup", { action: "resume", runId: page.runId })).status).toBe(409)
  const preview = await call("newer", { action: "preview" }), newer = await preview.json()
  expect(preview.status).toBe(200)
  expect(newer.rows[0].review.blocker).toBeUndefined()
  const newerBody = { action: "restore", runId: newer.runId, fingerprint: newer.fingerprint, approvals: { [newer.rows[0].key]: newer.rows[0].review.approvals } }
  expect(await (await call("newer", newerBody)).json()).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "pending" }] })
  expect(env.entry(newer).retryAt).toBe(deadline)
  expect(sends).toBe(1); expect(env.writes).toEqual([]); expect(env.locks()).toEqual([])
  await vi.advanceTimersByTimeAsync(119_999)
  const pending = call("newer", newerBody)
  await vi.advanceTimersByTimeAsync(0)
  expect(sends).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(await (await pending).json()).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(env.writes).toEqual([{ [env.field]: "Newer" }]); expect(sends).toBe(2)
  // Even if retention is reversed and live values return to the original preimage,
  // the old reviewed page is permanently invalidated rather than merely stale.
  backups.set("backup", oldRequest.snapshot); env.live[env.field] = "Live"
  expect(await (await call("backup", oldBody)).json()).toMatchObject({ status: "partial", failed: 1, outcomes: [{ state: "blocked", reason: expect.stringContaining("superseded") }] })
  expect(sends).toBe(2); expect(env.locks()).toEqual([])
})

it.each(folders)("resumes %s after a PATCH throttle followed by a longer final safety-read throttle", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let sends = 0, safetyThrottles = 0
  env.graph.mockImplementation((input, init) => {
    if (init?.method === "PATCH" && ++sends === 1) return Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "1" } }))
    if (sends === 1 && !safetyThrottles && new URL(String(input)).pathname === `/v1.0/${env.targetPath}` && init?.method === "GET") {
      safetyThrottles++; return Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } }))
    }
    return original(input, init)
  })
  vi.useFakeTimers()
  const pending = env.execute(page, request)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await pending).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "captured" }] })
  expect(env.entry(page).retryAt).toBe(Date.now() + 120_000)
  expect(safetyThrottles).toBe(1); expect(sends).toBe(1); expect(env.writes).toEqual([]); expect(env.locks()).toEqual([])
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", failed: 0, outcomes: [{ state: "applied" }] })
  await env.execute(page, request)
  expect(sends).toBe(2); expect(env.writes).toEqual([{ [env.field]: "Saved" }]); expect(env.locks()).toEqual([])
})

it.each(folders.flatMap(folder => ["initial", "references", "final"].map(phase => ({ folder, phase }))))("persists a $folder $phase safety-read deadline before any PATCH", async ({ folder, phase }) => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let reads = 0
  const throttleRead = phase === "initial" ? 1 : phase === "references" ? (folder === "Applications" ? 3 : 2) : folder === "Groups" ? 6 : 5
  env.graph.mockImplementation((input, init) => new URL(String(input)).pathname === `/v1.0/${env.targetPath}` && init?.method === "GET" && ++reads === throttleRead ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  vi.useFakeTimers()
  const deadline = Date.now() + 120_000
  expect(await env.execute(page, request)).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: phase === "final" ? "captured" : "pending" }] })
  expect(env.entry(page).retryAt).toBe(deadline); expect(env.writes).toEqual([]); expect(env.locks()).toEqual([])
  expect(await env.execute(page, request)).toMatchObject({ status: "partial", failed: 0 })
  expect(env.writes).toEqual([])
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(env.writes).toEqual([{ [env.field]: "Saved" }]); expect(env.locks()).toEqual([])
})

it.each(folders)("keeps an uncertain dispatched %s 503 locked through old read-backs and newer previews without resending", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let sends = 0
  env.graph.mockImplementation((input, init) => {
    if (init?.method === "PATCH") { sends++; return Promise.resolve(new Response(null, { status: 503 })) }
    return original(input, init)
  })
  for (let restart = 0; restart < 4; restart++) {
    expect(await env.execute(page, request)).toMatchObject({ status: "partial", outcomes: [{ state: "uncertain" }] })
    expect(env.locks()).toHaveLength(1)
    const newerRequest = env.request("newer", "Newer"), newer = await env.prepare(newerRequest)
    expect(newer.rows[0]!.review.blocker).toBeUndefined()
    expect(await env.execute(newer, newerRequest)).toMatchObject({ status: "partial", failed: 1, outcomes: [{ state: "blocked", reason: expect.stringContaining("unanswered write") }] })
  }
  expect(sends).toBe(1); expect(env.writes).toEqual([])
  env.live[env.field] = "Saved"
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(sends).toBe(1); expect(env.locks()).toEqual([])
})

it.each(folders)("keeps normal %s restore and settled-page resume unchanged", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request)
  expect(page.rows[0]!.review.blocker).toBeUndefined()
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", failed: 0, outcomes: [{ state: "applied" }] })
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", failed: 0, outcomes: [{ state: "applied" }] })
  expect(env.writes).toEqual([{ [env.field]: "Saved" }]); expect(env.locks()).toEqual([])
})

it.each(folders)("migrates the previous captured-throttle lock for %s without reopening its backup", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let sends = 0
  env.graph.mockImplementation((input, init) => init?.method === "PATCH" && ++sends === 1 ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  vi.useFakeTimers()
  expect(await env.execute(page, request)).toMatchObject({ status: "partial", failed: 0 })
  // Reproduce round 5's exact persisted shape: a captured retryAt entry plus
  // an unanswered lock, with no separate object deadline/ownership record.
  env.data.delete(`restore.directory.object.${tenant}.${folder}.${targetId}`)
  env.data.set(`restore.directory.unanswered.${tenant}.${folder}.${targetId}`, `restore.directory.${tenant}.${page.runId}.batch.0.`)
  const newerRequest = env.request("newer", "Newer"), newer = await env.prepare(newerRequest)
  expect(await env.execute(newer, newerRequest)).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "pending" }] })
  expect(env.entry(newer).retryAt).toBe(Date.now() + 120_000)
  expect(env.locks()).toEqual([]); expect(sends).toBe(1)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await env.execute(newer, newerRequest)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(await env.execute(page, request)).toMatchObject({ status: "partial", failed: 1, outcomes: [{ state: "blocked", reason: expect.stringContaining("superseded") }] })
  expect(env.writes).toEqual([{ [env.field]: "Newer" }]); expect(sends).toBe(2)
})

it.each(folders)("rechecks %s drift on resume after a confirmed safety-read throttle", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let throttled = false
  env.graph.mockImplementation((input, init) => {
    expect(env.locks()).toEqual([])
    if (!throttled && new URL(String(input)).pathname === `/v1.0/${env.targetPath}` && init?.method === "GET") {
      throttled = true; return Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } }))
    }
    return original(input, init)
  })
  vi.useFakeTimers()
  expect(await env.execute(page, request)).toMatchObject({ status: "partial", failed: 0 })
  env.live[env.field] = "Changed during deferral"
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await env.execute(page, request)).toMatchObject({ status: "partial", failed: 1, outcomes: [{ state: "blocked", reason: expect.stringContaining("tenant changed") }] })
  expect(env.writes).toEqual([]); expect(env.locks()).toEqual([])
})

it.each(folders)("preserves a %s actor safety-read throttle across a new reviewed page", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let throttled = false
  env.graph.mockImplementation((input, init) => {
    if (!throttled && new URL(String(input)).pathname === "/v1.0/applications") {
      throttled = true; return Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } }))
    }
    return original(input, init)
  })
  vi.useFakeTimers()
  await expect(env.execute(page, request)).rejects.toThrow("throttled")
  expect(env.writes).toEqual([]); expect(env.locks()).toEqual([])
  const newerRequest = env.request("newer", "Newer"), newer = await env.prepare(newerRequest)
  expect(await env.execute(newer, newerRequest)).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "pending" }] })
  expect(env.entry(newer).retryAt).toBe(Date.now() + 120_000)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await env.execute(newer, newerRequest)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(await env.execute(page, request)).toMatchObject({ status: "partial", failed: 1, outcomes: [{ state: "blocked", reason: expect.stringContaining("superseded") }] })
  expect(env.writes).toEqual([{ [env.field]: "Newer" }])
})
