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
  settings.setChoice(tenant, { entra: { access: "restore", areas: ["applications", "usersAndDevices", "groups"] } })
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
  const locks = () => Object.keys(JSON.parse(data.get(`restore.directory.coordinator.${tenant}`) ?? '{"locks":{}}').locks)
  const entry = (page: Page) => JSON.parse([...data.entries()].find(([key]) => key.includes(`${page.runId}.batch.0.restore.guarded.`))![1]).runs[page.runId].entries[0]
  return { settings, data, store, graph, live, writes, targetPath, field, service, request, prepare, execute, locks, entry }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it.each(folders)("retains the %s page lock until explicit discard and never bypasses Retry-After", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let sends = 0
  env.graph.mockImplementation((input, init) => init?.method === "PATCH" && ++sends === 1 ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  vi.useFakeTimers()
  expect(await env.execute(page, request)).toMatchObject({ status: "partial", failed: 0, canDiscard: true, outcomes: [{ state: "deferred", retryAt: Date.now() + 120_000 }] })
  expect(env.locks()).toHaveLength(1)
  const newerRequest = env.request("newer", "Newer"), newer = await env.prepare(newerRequest)
  expect(await env.execute(newer, newerRequest)).toMatchObject({ status: "partial", failed: 1, outcomes: [{ state: "blocked", reason: expect.stringContaining("owns this object") }] })
  // A queued replacement cannot invalidate the original page before its deadline.
  expect(await env.execute(page, request)).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "deferred" }] })
  expect(sends).toBe(1)
  expect(await env.service().saved(tenant, page.runId, "discard")).toMatchObject({ discarded: true })
  expect(env.locks()).toEqual([])
  const replacement = await env.prepare(newerRequest)
  expect(await env.execute(replacement, newerRequest)).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "deferred", retryAt: Date.now() + 120_000 }] })
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await env.execute(replacement, newerRequest)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  await expect(env.execute(page, request)).rejects.toThrow("discarded")
  expect(sends).toBe(2); expect(env.writes).toEqual([{ [env.field]: "Newer" }])
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
  expect(await pending).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "deferred" }] })
  expect(env.entry(page).retryAt).toBe(Date.now() + 120_000)
  expect(safetyThrottles).toBe(1); expect(sends).toBe(1); expect(env.writes).toEqual([]); expect(env.locks()).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", failed: 0, outcomes: [{ state: "applied" }] })
  await env.execute(page, request)
  expect(sends).toBe(2); expect(env.writes).toEqual([{ [env.field]: "Saved" }]); expect(env.locks()).toEqual([])
})

it.each(folders.flatMap(folder => ["initial", "references", "final"].map(phase => ({ folder, phase }))))("persists a $folder $phase safety-read deadline before any PATCH", async ({ folder, phase }) => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let reads = 0
  const throttleRead = phase === "initial" ? 1 : phase === "references" ? (folder === "Applications" ? 3 : 2) : folder === "Applications" ? 5 : folder === "Groups" ? 5 : 4
  env.graph.mockImplementation((input, init) => new URL(String(input)).pathname === `/v1.0/${env.targetPath}` && init?.method === "GET" && ++reads === throttleRead ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  vi.useFakeTimers()
  const deadline = Date.now() + 120_000
  expect(await env.execute(page, request)).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "deferred" }] })
  expect(env.entry(page).retryAt).toBe(deadline); expect(env.writes).toEqual([]); expect(env.locks()).toHaveLength(1)
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
    expect(await env.execute(newer, newerRequest)).toMatchObject({ status: "partial", failed: 1, outcomes: [{ state: "blocked", reason: expect.stringContaining("owns this object") }] })
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

it.each(folders)("reconciles retained %s journal results through the route without a backup or write opt-in", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let sends = 0
  env.graph.mockImplementation((input, init) => { if (init?.method === "PATCH") { sends++; return Promise.resolve(new Response(null, { status: 503 })) } return original(input, init) })
  expect(await env.execute(page, request)).toMatchObject({ outcomes: [{ state: "uncertain" }], canDiscard: false })
  await expect(env.service().saved(tenant, page.runId, "discard")).rejects.toThrow("uncertain")
  env.settings.setChoice(tenant, {})
  const storage = vi.fn(() => { throw new Error("Retention deleted backup") }); vi.stubGlobal("fetch", storage)
  const call = async () => {
    setDirectoryRestoreService(env.service())
    return POST(new Request("http://localhost/api/restore-directory", { method: "POST", body: JSON.stringify({ tenantId: tenant, appId: clientId, clientSecret: "placeholder", action: "reconcile", runId: page.runId }) }) as Parameters<typeof POST>[0])
  }
  expect(await (await call()).json()).toMatchObject({ outcomes: [{ state: "uncertain" }], canDiscard: false })
  env.live[env.field] = "Saved"
  const response = await call()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ outcomes: [{ state: "applied" }], canDiscard: true })
  expect(storage).not.toHaveBeenCalled(); expect(sends).toBe(1); expect(env.locks()).toEqual([])
})

it.each(folders)("rechecks %s drift on resume after a confirmed safety-read throttle", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let throttled = false
  env.graph.mockImplementation((input, init) => {
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
  expect(await env.execute(newer, newerRequest)).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "deferred" }] })
  expect(env.entry(newer).retryAt).toBe(Date.now() + 120_000)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await env.execute(newer, newerRequest)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(await env.execute(page, request)).toMatchObject({ status: "partial", failed: 1, outcomes: [{ state: "blocked", reason: expect.stringContaining("tenant changed") }] })
  expect(env.writes).toEqual([{ [env.field]: "Newer" }])
})

it.each(folders.flatMap(folder => ["initial", "final"].flatMap(phase => [429, 408, 500, 503, "timeout", "network"].map(failure => ({ folder, phase, failure })))))("defers $folder $phase safety-read $failure and repeats fresh checks on resume", async ({ folder, phase, failure }) => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let reads = 0, failed = false
  const failureRead = phase === "initial" ? 1 : folder === "Users" ? 4 : 5
  env.graph.mockImplementation(async (input, init) => {
    if (!failed && new URL(String(input)).pathname === `/v1.0/${env.targetPath}` && init?.method === "GET" && ++reads === failureRead) {
      failed = true
      if (failure === "timeout") throw new DOMException("Timeout", "TimeoutError")
      if (failure === "network") throw new TypeError("Network failure")
      return new Response(null, { status: Number(failure), headers: { "Retry-After": "120" } })
    }
    return original(input, init)
  })
  vi.useFakeTimers()
  expect(await env.execute(page, request)).toMatchObject({ failed: 0, outcomes: [{ state: "deferred" }] })
  expect(failed).toBe(true); expect(env.writes).toEqual([])
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(env.writes).toEqual([{ [env.field]: "Saved" }])
})

it.each(["token", "metadata", "snapshot"])("registers cancellation before route backup loading at %s and sends nothing", async phase => {
  const env = world("Groups"), request = env.request(), page = await env.prepare(request), service = env.service()
  setDirectoryRestoreService(service)
  let reached!: () => void, release!: () => void
  const loading = new Promise<void>(resolve => { reached = resolve })
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (phase === "token" && url.includes("oauth2") || phase === "metadata" && url.endsWith("metadata.json") || phase === "snapshot" && url.endsWith(`${targetId}.json`)) {
      reached(); await new Promise<void>(resolve => { release = resolve })
      if (phase !== "token") expect(init?.signal?.aborted).toBe(true)
    }
    if (url.includes("oauth2")) return Response.json({ access_token: "storage-token" })
    if (url.endsWith("metadata.json")) return Response.json({ TenantId: tenant })
    if (url.endsWith(".tenuvault-owner.json")) return new Response(null, { status: 404 })
    return Response.json(request.snapshot)
  }))
  const call = (body: object) => POST(new Request("http://localhost/api/restore-directory", { method: "POST", body: JSON.stringify({ tenantId: tenant, appId: clientId, clientSecret: "placeholder", runId: page.runId, ...body }) }) as Parameters<typeof POST>[0])
  const pending = call({ action: "restore", storageAccountName: "store", backupId: "backup", path: request.path, stage: "object", fingerprint: page.fingerprint, approvals: Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])) })
  await loading
  expect(await (await call({ action: "cancel" })).json()).toEqual({ cancelled: true })
  release()
  expect(await (await pending).json()).toEqual({ cancelled: true })
  expect(env.writes).toEqual([])
  expect(await service.cancel(tenant, page.runId)).toEqual({ cancelled: false })
})

it.each(folders)("retains the approved %s row when another page extends the final-read deadline", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request)
  const otherRequest = env.request("other", "Other"), other = await env.prepare(otherRequest), original = env.graph.getMockImplementation()!
  let reads = 0, extending = false, extended = false
  const finalRead = folder === "Users" ? 4 : 5
  env.graph.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    if (extending && path === "/v1.0/applications") return new Response(null, { status: 429, headers: { "Retry-After": "120" } })
    if (!extended && path === `/v1.0/${env.targetPath}` && ++reads === finalRead) {
      extending = true; extended = true
      await expect(env.execute(other, otherRequest)).rejects.toThrow("throttled")
      extending = false
    }
    return original(input, init)
  })
  vi.useFakeTimers()
  const deadline = Date.now() + 120_000
  expect(await env.execute(page, request)).toMatchObject({ failed: 0, outcomes: [{ state: "deferred", retryAt: deadline }] })
  expect(extended).toBe(true); expect(env.writes).toEqual([])
  const stored = JSON.parse(env.data.get(`restore.directory.review.${tenant}.${page.runId}`)!)
  expect(stored.selection).toEqual(page.rows.map(row => row.key))
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(env.writes).toEqual([{ [env.field]: "Saved" }])
})

it.each(folders.flatMap(folder => ["initial", "final"].flatMap(phase => ["body reset", "invalid JSON"].map(failure => ({ folder, phase, failure })))))("handles $folder $phase $failure separately from safety drift", async ({ folder, phase, failure }) => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let reads = 0, failed = false
  const failureRead = phase === "initial" ? 1 : folder === "Users" ? 4 : 5
  env.graph.mockImplementation(async (input, init) => {
    if (!failed && new URL(String(input)).pathname === `/v1.0/${env.targetPath}` && ++reads === failureRead) {
      failed = true
      return failure === "invalid JSON" ? new Response("{", { status: 200 }) : new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); controller.error(new Error("ECONNRESET")) } }), { status: 200 })
    }
    return original(input, init)
  })
  expect(await env.execute(page, request)).toMatchObject({ failed: failure === "body reset" ? 0 : 1, outcomes: [{ state: failure === "body reset" ? "deferred" : phase === "initial" ? "blocked" : "failed-before-send" }] })
  expect(failed).toBe(true); expect(env.writes).toEqual([])
  if (failure === "body reset") {
    expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
    expect(env.writes).toEqual([{ [env.field]: "Saved" }])
  }
})
