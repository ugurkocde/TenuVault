import { graphWorkloadPolicy } from "./fixtures/directory-graph-v1"
import { unsetUserFields, unsetGroupFields } from "./fixtures/directory-response"
import { rejectProxyAuthResponses, withNetworkErrors } from "../src/main/api/network-error"
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
function world(folder: typeof folders[number], wrapped = false) {
  const data = new Map<string, string>()
  const store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const settings = new ModuleSettings(store)
  settings.setChoice(tenant, { entra: { access: "restore", areas: ["applications", "usersAndDevices", "groups"] } })
  let scopes = "Application.Read.All Application.ReadWrite.All User.ReadUpdate.All User.ReadWrite.All User.Read.All Group.ReadWrite.All Group.Read.All Policy.Read.All"
  const token = () => `h.${Buffer.from(JSON.stringify({ tid: tenant, oid: userId, appid: clientId, scp: scopes })).toString("base64url")}.s`
  const live: Item = folder === "Applications" ? { id: targetId, appId, displayName: "Live", description: "Live", notes: null } : folder === "Users" ? { ...unsetUserFields, id: targetId, displayName: "Live", userType: "Member", accountEnabled: false } : { ...unsetGroupFields, id: targetId, displayName: "Live", description: "Live", mailNickname: "group", groupTypes: [], mailEnabled: false, securityEnabled: true, isAssignableToRole: false }
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
  const connection = vi.fn(async () => ({ token: token(), tenantId: tenant, clientId, userId }))
  const service = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), connection, async () => ({ tenantId: tenant, clientId, userId }), wrapped ? withNetworkErrors(rejectProxyAuthResponses(graph)) : graph, () => [], settings)
  const request = (backup = "backup", value = "Saved") => ({ path: `${backup}/${folder}/${targetId}.json`, origin: "restore" as const, snapshot: { ...live, [field]: value } })
  const prepare = async (requestValue = request()) => service().prepare(tenant, requestValue, options, async () => requestValue.snapshot)
  type Page = Awaited<ReturnType<typeof prepare>>
  const execute = (page: Page, requestValue = request()) => service().execute(tenant, { ...requestValue, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  const locks = () => Object.keys(JSON.parse(data.get(`restore.directory.coordinator.${tenant}`) ?? '{"locks":{}}').locks)
  const entry = (page: Page) => JSON.parse([...data.entries()].find(([key]) => key.includes(`${page.runId}.batch.0.restore.guarded.`))![1]).runs[page.runId].entries[0]
  return { connection, setScopes: (value: string) => { scopes = value }, settings, data, store, graph, live, writes, targetPath, field, service, request, prepare, execute, locks, entry }
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
      return failure === "invalid JSON" ? new Response("{", { status: 200, headers: { "Content-Type": "application/json" } }) : new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); controller.error(new Error("ECONNRESET")) } }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    return original(input, init)
  })
  expect(await env.execute(page, request)).toMatchObject({ failed: 0, outcomes: [{ state: "deferred", reason: expect.stringContaining("temporary Microsoft Graph read failure") }] })
  expect(failed).toBe(true); expect(env.writes).toEqual([])
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  await env.execute(page, request)
  expect(env.writes).toEqual([{ [env.field]: "Saved" }])
})

it.each(folders.flatMap(folder => ["journal", "coordinator"].map(record => ({ folder, record }))))("keeps $folder deferred and locked after one $record deadline save failure", async ({ folder, record }) => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let sends = 0, failures = 0
  env.graph.mockImplementation((input, init) => init?.method === "PATCH" && ++sends === 1 ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  vi.useFakeTimers()
  const deadline = Date.now() + 120_000, set = env.store.set
  vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key.includes(record === "journal" ? ".restore.guarded." : "coordinator.") && value.includes(String(deadline)) && failures++ === 0) throw new Error("One storage failure")
    set(key, value)
  })
  expect(await env.execute(page, request)).toMatchObject({ failed: 0, outcomes: [{ state: "deferred", retryAt: deadline }] })
  expect(failures).toBeGreaterThan(1)
  expect(env.entry(page)).toMatchObject({ state: "deferred", retryAt: deadline })
  expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).deadlines[targetId]).toBe(deadline)
  expect(env.locks()).toEqual([targetId]); expect(sends).toBe(1)
  await env.service().saved(tenant, page.runId, "discard")
  const replacementRequest = env.request("newer", "Newer"), replacement = await env.prepare(replacementRequest)
  expect(await env.execute(replacement, replacementRequest)).toMatchObject({ outcomes: [{ state: "deferred", retryAt: deadline }] })
  expect(sends).toBe(1)
})

it.each(["journal", "coordinator"])("recovers the deadline from the surviving %s record before discard releases ownership", async surviving => {
  const env = world("Groups"), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let sends = 0
  env.graph.mockImplementation((input, init) => init?.method === "PATCH" && ++sends === 1 ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  vi.useFakeTimers()
  const deadline = Date.now() + 120_000, set = env.store.set
  const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if (key.includes(surviving === "journal" ? "coordinator." : ".restore.guarded.") && value.includes(String(deadline))) throw new Error("Storage unavailable")
    set(key, value)
  })
  await expect(env.execute(page, request)).rejects.toThrow("retry deadline could not be saved")
  expect(env.locks()).toEqual([targetId])
  expect(env.entry(page).state).toBe(surviving === "journal" ? "deferred" : "uncertain")
  spy.mockRestore()
  if (surviving === "coordinator") {
    // The coordinator proves this exact attempt was rejected, so recovery needs no matching read-back.
    expect(await env.execute(page, request)).toMatchObject({ outcomes: [{ state: "deferred", retryAt: deadline }] })
    expect(env.entry(page)).toMatchObject({ state: "deferred", retryAt: deadline })
  }
  await env.service().saved(tenant, page.runId, "discard")
  expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).deadlines[targetId]).toBe(deadline)
  const replacementRequest = env.request("newer", "Newer"), replacement = await env.prepare(replacementRequest)
  expect(await env.execute(replacement, replacementRequest)).toMatchObject({ outcomes: [{ state: "deferred", retryAt: deadline }] })
  expect(sends).toBe(1)
})

it.each(folders.flatMap(folder => ["preview", "execute", "resume", "reconcile"].map(action => ({ folder, action }))))("persists $folder $action actor-read throttles and never sends before the deadline", async ({ folder, action }) => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let throttle = false, sends = 0
  env.graph.mockImplementation((input, init) => {
    if (throttle && new URL(String(input)).pathname === "/v1.0/applications") return Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } }))
    if (init?.method === "PATCH") { sends++; return Promise.resolve(new Response(null, { status: 503 })) }
    return original(input, init)
  })
  if (action === "reconcile") expect(await env.execute(page, request)).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  vi.useFakeTimers()
  const deadline = Date.now() + 120_000
  throttle = true
  await expect(action === "preview" ? env.prepare(request) : action === "execute" ? env.execute(page, request) : action === "resume" ? env.service().resume(tenant, { ...request, runId: page.runId }) : env.service().saved(tenant, page.runId, "reconcile")).rejects.toThrow("throttled")
  expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).deadlines[targetId]).toBe(deadline)
  if (action === "reconcile") expect(env.entry(page)).toMatchObject({ state: "uncertain", retryAt: deadline, targetId })
  throttle = false
  if (action === "reconcile") {
    env.live[env.field] = "Saved"
    const calls = env.graph.mock.calls.length
    expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "uncertain", retryAt: deadline }] })
    expect(env.graph).toHaveBeenCalledTimes(calls)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied" }] })
    await env.service().saved(tenant, page.runId, "discard")
    // Recheck the surviving deadline with the clock from before confirmation.
    vi.setSystemTime(deadline - 120_000)
  }
  const newerRequest = env.request("newer", "Newer"), newer = await env.prepare(newerRequest)
  expect(await env.execute(newer, newerRequest)).toMatchObject({ outcomes: [{ state: "deferred", retryAt: deadline }] })
  expect(sends).toBe(action === "reconcile" ? 1 : 0)
})

it.each(folders)("retains the attempt-bound %s retry in memory when both durable records fail", async folder => {
  const env = world(folder), service = env.service(), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let sends = 0
  env.graph.mockImplementation((input, init) => init?.method === "PATCH" && ++sends === 1 ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  vi.useFakeTimers()
  const deadline = Date.now() + 120_000, set = env.store.set
  const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if ((key.includes(".restore.guarded.") || key.includes(".coordinator.")) && value.includes(String(deadline))) throw new Error("Retry storage unavailable")
    set(key, value)
  })
  const execute = () => service.execute(tenant, { ...request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  await expect(execute()).rejects.toThrow("retry deadline could not be saved")
  expect(env.entry(page)).toMatchObject({ state: "uncertain", attempt: 1 })
  const calls = env.graph.mock.calls.length
  await expect(execute()).rejects.toThrow("retry deadline could not be saved")
  expect(env.graph.mock.calls).toHaveLength(calls)
  spy.mockRestore()
  expect(await execute()).toMatchObject({ outcomes: [{ state: "deferred", retryAt: deadline }] })
  expect(env.entry(page)).toMatchObject({ state: "deferred", attempt: 1 })
  expect(sends).toBe(1)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await execute()).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(env.entry(page).attempt).toBe(2)
  expect(sends).toBe(2); expect(env.writes).toHaveLength(1)
})

it.each(["preview", "execute", "resume", "reconcile"].flatMap(action => folders.map(folder => ({ action, folder }))))("retains the $folder $action actor deadline in memory through failed deadline saves", async ({ action, folder }) => {
  const env = world(folder), service = env.service(), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let throttle = false
  env.graph.mockImplementation((input, init) => throttle && new URL(String(input)).pathname === "/v1.0/applications" ? Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "120" } })) : original(input, init))
  const execute = () => service.execute(tenant, { ...request, runId: page.runId }, page.fingerprint, Object.fromEntries(page.rows.map(row => [row.key, row.review.approvals])))
  if (action === "reconcile") {
    const withThrottle = env.graph.getMockImplementation()!
    env.graph.mockImplementation((input, init) => init?.method === "PATCH" ? Promise.resolve(new Response(null, { status: 503 })) : withThrottle(input, init))
    expect(await execute()).toMatchObject({ outcomes: [{ state: "uncertain" }] })
    env.graph.mockImplementation(withThrottle)
  }
  vi.useFakeTimers()
  const deadline = Date.now() + 120_000, set = env.store.set
  const spy = vi.spyOn(env.store, "set").mockImplementation((key, value) => {
    if ((key.includes(".restore.guarded.") || key.includes(".coordinator.")) && value.includes(String(deadline))) throw new Error("Deadline storage unavailable")
    set(key, value)
  })
  throttle = true
  await expect(action === "preview" ? service.prepare(tenant, request, options, async () => request.snapshot) : action === "execute" ? execute() : action === "resume" ? service.resume(tenant, { ...request, runId: page.runId }) : service.saved(tenant, page.runId, "reconcile")).rejects.toThrow("retry deadline could not be saved")
  throttle = false
  const calls = env.graph.mock.calls.length
  await expect(execute()).rejects.toThrow("retry deadline could not be saved")
  expect(env.graph.mock.calls).toHaveLength(calls)
  spy.mockRestore()
  expect(await execute()).toMatchObject({ outcomes: [{ state: action === "reconcile" ? "uncertain" : "deferred", retryAt: deadline }] })
  expect(env.writes).toEqual([])
  expect(JSON.parse(env.data.get(`restore.directory.coordinator.${tenant}`)!).deadlines[targetId]).toBe(deadline)
  await vi.advanceTimersByTimeAsync(120_000)
  if (action === "reconcile") env.live[env.field] = "Saved"
  expect(await execute()).toMatchObject({ outcomes: [{ state: "applied" }] })
  expect(env.writes).toHaveLength(action === "reconcile" ? 0 : 1)
})


it.each(folders)("keeps uncertain %s writes locked on local discard without Graph reads", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let sends = 0
  env.graph.mockImplementation((input, init) => {
    if (init?.method === "PATCH") { sends++; return Promise.resolve(new Response(null, { status: 503 })) }
    return original(input, init)
  })
  expect(await env.execute(page, request)).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  const state = env.data.get(`restore.directory.coordinator.${tenant}`), calls = env.graph.mock.calls.length
  env.graph.mockImplementation(async () => new Response(null, { status: 403 }))
  await expect(env.service().saved(tenant, page.runId, "discard")).rejects.toThrow("Confirm the uncertain result before discarding")
  expect(env.graph).toHaveBeenCalledTimes(calls)
  expect(env.data.get(`restore.directory.coordinator.${tenant}`)).toBe(state)
  expect(env.entry(page)).toMatchObject({ state: "uncertain", targetId })
  env.graph.mockImplementation(original); env.live[env.field] = "Saved"
  expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied" }] })
  const confirmedCalls = env.graph.mock.calls.length
  expect(await env.service().saved(tenant, page.runId, "discard")).toMatchObject({ discarded: true })
  expect(env.graph).toHaveBeenCalledTimes(confirmedCalls); expect(sends).toBe(1)
})


it.each(folders.flatMap(folder => [false, true].map(wrapped => ({ folder, wrapped }))))("resumes a known-unsent $folder proxy 407 PATCH with wrapped=$wrapped and exactly one Graph write", async ({ folder, wrapped }) => {
  const env = world(folder, wrapped), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let proxy = true, attempts = 0
  env.graph.mockImplementation((input, init) => {
    if (init?.method === "PATCH") {
      attempts++
      if (proxy) return Promise.resolve(new Response(null, { status: 407 }))
    }
    return original(input, init)
  })
  const result = await env.execute(page, request)
  expect(result).toMatchObject({ failed: 0, canDiscard: true, outcomes: [{ state: "deferred", reason: expect.stringContaining("proxy requires authentication") }] })
  expect(env.entry(page)).toMatchObject({ state: "deferred", attempt: 1 })
  expect(env.locks()).toHaveLength(1); expect(env.writes).toEqual([]); expect(attempts).toBe(1)
  proxy = false
  expect((await env.service().resume(tenant, { ...request, runId: page.runId })).outcomes).toEqual(result.outcomes)
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  await env.execute(page, request)
  expect(env.writes).toEqual([{ [env.field]: "Saved" }]); expect(attempts).toBe(2); expect(env.locks()).toEqual([])
})


it.each([
  { folder: "Users" as const, field: "displayName" },
  { folder: "Users" as const, field: "manager" },
  { folder: "Groups" as const, field: "description" },
  { folder: "Applications" as const, field: "displayName" },
  { folder: "Applications" as const, field: "description" },
])("keeps a stale $folder $field read uncertain after an acknowledged update until a fresh read after the replication window", async ({ folder, field }) => {
  vi.useFakeTimers()
  const env = world(folder), original = env.graph.getMockImplementation()!
  const manager = field === "manager", a = manager ? id(100) : "Live", b = manager ? id(101) : "Changed"
  let managerId = a, stale = false, reject = false, attempts = 0, reads = 0
  env.graph.mockImplementation((input, init) => {
    const path = new URL(String(input)).pathname.replace("/v1.0/", ""), method = init?.method ?? "GET"
    if (method !== "GET") {
      attempts++
      if (reject) return Promise.resolve(new Response(null, { status: 503 }))
      if (manager) { expect(path).toBe(`${env.targetPath}/manager/$ref`); managerId = b; return Promise.resolve(new Response(null, { status: 204 })) }
    }
    if (manager && path === `${env.targetPath}/manager`) { reads++; return Promise.resolve(Response.json({ id: stale ? a : managerId })) }
    if (manager && path.startsWith("users/") && path !== env.targetPath) return Promise.resolve(Response.json({ ...unsetUserFields, id: path.split("/")[1], displayName: "Manager", userType: "Member", accountEnabled: false }))
    if (!manager && path === env.targetPath && method === "GET") { reads++; return Promise.resolve(Response.json({ ...env.live, ...(stale ? { [field]: a } : {}) })) }
    return original(input, init)
  })
  const request = (value: string) => ({ ...env.request(), snapshot: { ...env.live, ...(manager ? { manager: { id: value, complete: true } } : { [field]: value }) } })
  const prepare = (value: ReturnType<typeof request>) => env.service().prepare(tenant, value, { ...options, stage: manager ? "relationships" : "object" }, async () => value.snapshot)
  const firstRequest = request(b), first = await prepare(firstRequest)
  expect(first.rows).toHaveLength(1); expect(first.rows[0]!.review.blocker).toBeUndefined()
  expect(await env.execute(first, firstRequest)).toMatchObject({ outcomes: [{ state: "applied" }] })
  expect(env.entry(first)).toMatchObject({ acknowledged: true, acknowledgedAt: Date.now() })
  const secondRequest = request(a), second = await prepare(secondRequest)
  reject = true
  expect(await env.execute(second, secondRequest)).toMatchObject({ outcomes: [{ state: "uncertain" }], canDiscard: false })
  stale = true
  expect(await env.service().saved(tenant, second.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "uncertain", reason: expect.stringContaining("30 minute replication window") }], canDiscard: false })
  expect(env.entry(second).acknowledged).toBeUndefined()
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1)
  expect(await env.execute(second, secondRequest)).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  stale = false
  await vi.advanceTimersByTimeAsync(1)
  const previousReads = reads
  expect(await env.service().saved(tenant, second.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  expect(reads).toBeGreaterThan(previousReads)
  // A new matching read after the window can settle the result without another write.
  if (manager) managerId = a
  else env.live[field] = a
  expect(await env.service().saved(tenant, second.runId, "reconcile")).toMatchObject({ outcomes: [{ state: "applied" }], canDiscard: true })
  expect(attempts).toBe(2); expect(env.entry(second).acknowledged).toBeUndefined(); expect(env.locks()).toEqual([])
})

it.each(folders.flatMap(folder => ["HTML", "malformed JSON", "non-JSON type"].map(response => ({ folder, response }))))("resumes $folder after a 200 $response safety read and sends its approved PATCH once", async ({ folder, response }) => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  env.graph.mockImplementation((input, init) => new URL(String(input)).pathname === `/v1.0/${env.targetPath}` && init?.method === "GET"
    ? Promise.resolve(new Response(response === "HTML" ? "<html>Proxy sign-in</html>" : response === "malformed JSON" ? "{" : JSON.stringify(env.live), { status: 200, headers: { "Content-Type": response === "malformed JSON" ? "application/json" : "text/html" } }))
    : original(input, init))
  expect(await env.execute(page, request)).toMatchObject({ failed: 0, outcomes: [{ state: "deferred", reason: expect.stringContaining("temporary Microsoft Graph read failure") }] })
  expect(env.writes).toEqual([]); expect(env.locks()).toHaveLength(1)
  env.graph.mockImplementation(original)
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  await env.execute(page, request)
  expect(env.writes).toEqual([{ [env.field]: "Saved" }]); expect(env.locks()).toEqual([])
})

it.each(folders)("keeps an uncertain %s write retryable after a malformed 200 read-back without resending", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let sends = 0
  env.graph.mockImplementation((input, init) => {
    if (init?.method === "PATCH") { sends++; return Promise.resolve(new Response(null, { status: 503 })) }
    if (sends && new URL(String(input)).pathname === `/v1.0/${env.targetPath}`) return Promise.resolve(new Response("{", { headers: { "Content-Type": "application/json" } }))
    return original(input, init)
  })
  expect(await env.execute(page, request)).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  expect(await env.execute(page, request)).toMatchObject({ outcomes: [{ state: "uncertain", reason: "The write did not return a confirmed result. It must be read back before any retry." }] })
  env.live[env.field] = "Saved"; env.graph.mockImplementation(original)
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(sends).toBe(1); expect(env.writes).toEqual([]); expect(env.locks()).toEqual([])
})

it.each(folders)("previews and sends ordinary Bearer token authentication prose for %s", async folder => {
  const env = world(folder)
  env.live[folder === "Applications" ? "description" : folder === "Groups" ? "displayName" : "jobTitle"] = "Bearer token authentication"
  const request = env.request("backup", "Bearer token authentication"), page = await env.prepare(request)
  expect(page.rows[0]!.review.blocker).toBeUndefined()
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(env.writes).toEqual([{ [env.field]: "Bearer token authentication" }])
})

it.each(folders.flatMap(folder => ["JWT", "Bearer token", "Azure AD client secret", "Basic auth"].map(secret => ({ folder, secret }))))("refuses $secret in $folder metadata at preview before approval or journal publication", async ({ folder, secret }) => {
  const env = world(folder), value = secret === "JWT" ? "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJl" : secret === "Bearer token" ? "Bearer " + "a".repeat(64) : secret === "Basic auth" ? "Basic " + Buffer.from("username:password-for-test-only").toString("base64") : "abc8Q~" + "a".repeat(32)
  await expect(env.prepare(env.request("backup", value))).rejects.toThrow("Credential values")
  expect([...env.data.keys()].some(key => key.startsWith("restore.directory.review.") || key.includes("restore.guarded."))).toBe(false)
  expect([...env.data.values()].some(saved => saved.includes(value))).toBe(false)
  expect(env.writes).toEqual([])
})


it.each(folders)("refuses a JWT in an unchanged live %s field during preview before journal capture", async folder => {
  const env = world(folder), request = env.request()
  if (folder === "Applications") delete request.snapshot.description
  env.live[folder === "Applications" ? "description" : folder === "Groups" ? "displayName" : "jobTitle"] = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJl"
  await expect(env.prepare(request)).rejects.toThrow("Credential values")
  expect([...env.data.keys()].some(key => key.includes("restore.guarded."))).toBe(false)
  expect(env.writes).toEqual([])
})

it.each(folders.flatMap(folder => ["initial", "final"].flatMap(phase => ["empty object", "missing selected field", "non-string id", "malformed GUID id"].map(shape => ({ folder, phase, shape })))))("resumes $folder after $phase evidence has $shape and sends the approved write once", async ({ folder, phase, shape }) => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let reads = 0, malformed = false
  const failureRead = phase === "initial" ? 1 : folder === "Users" ? 4 : 5
  env.graph.mockImplementation((input, init) => {
    if (!malformed && new URL(String(input)).pathname === `/v1.0/${env.targetPath}` && init?.method === "GET" && ++reads === failureRead) {
      malformed = true
      const value = shape === "empty object" ? {} : { ...env.live }
      if (shape === "missing selected field") delete value.displayName
      if (shape === "non-string id") value.id = 42
      if (shape === "malformed GUID id") value.id = "malformed"
      return Promise.resolve(Response.json(value))
    }
    return original(input, init)
  })
  expect(await env.execute(page, request)).toMatchObject({ failed: 0, outcomes: [{ state: "deferred", reason: expect.stringContaining("temporary Microsoft Graph read failure") }] })
  expect(malformed).toBe(true); expect(env.writes).toEqual([]); expect(env.locks()).toHaveLength(1)
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  await env.execute(page, request)
  expect(env.writes).toEqual([{ [env.field]: "Saved" }]); expect(env.locks()).toEqual([])
})

const writeScope = (folder: typeof folders[number]) => folder === "Applications" ? "Application.ReadWrite.All" : folder === "Groups" ? "Group.ReadWrite.All" : "User.ReadUpdate.All"
const readScopes = "Application.Read.All User.Read.All Group.Read.All Policy.Read.All"
it.each(folders)("blocks %s preview approval with the missing operation scope named", async folder => {
  const env = world(folder)
  env.setScopes(readScopes)
  const request = env.request(), page = await env.prepare(request)
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0]!.review.blocker).toBe(`The signed-in connection lacks this operation's least-privileged permission: ${writeScope(folder)}.`)
  await expect(env.execute(page, request)).rejects.toThrow()
  expect(env.writes).toEqual([])
})
it.each(folders)("defers an approved %s row after its write scope is lost and resumes after consent", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request)
  expect(page.rows[0]!.review.blocker).toBeUndefined()
  env.setScopes(readScopes)
  expect(await env.execute(page, request)).toMatchObject({ failed: 0, outcomes: [{ state: "deferred", reason: `The signed-in connection lacks this operation's least-privileged permission: ${writeScope(folder)}.` }] })
  expect(env.writes).toEqual([]); expect(env.locks()).toHaveLength(1)
  env.setScopes(`${readScopes} ${writeScope(folder)}`)
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  await env.execute(page, request)
  expect(env.writes).toEqual([{ [env.field]: "Saved" }]); expect(env.locks()).toEqual([])
})

it.each(folders)("keeps well-formed wrong %s identity evidence as a safety refusal", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  env.graph.mockImplementation((input, init) => new URL(String(input)).pathname === `/v1.0/${env.targetPath}` && init?.method === "GET" ? Promise.resolve(Response.json({ ...env.live, id: id(900) })) : original(input, init))
  expect(await env.execute(page, request)).toMatchObject({ failed: 1, outcomes: [{ state: "blocked", reason: expect.stringMatching(/identity changed|changed after this preview/) }] })
  expect(env.writes).toEqual([])
})

it.each(folders)("keeps an unexpected %s PATCH success uncertain until read-back without replay", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let sends = 0
  env.graph.mockImplementation((input, init) => {
    if (init?.method === "PATCH") { sends++; return Promise.resolve(Response.json({ id: targetId })) }
    return original(input, init)
  })
  expect(await env.execute(page, request)).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "uncertain" }] })
  expect(env.entry(page).acknowledged).toBeUndefined()
  expect(await env.execute(page, request)).toMatchObject({ outcomes: [{ state: "uncertain" }] })
  Object.assign(env.live, { [env.field]: "Saved" })
  expect(await env.service().saved(tenant, page.runId, "reconcile")).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(env.entry(page).acknowledged).toBeUndefined()
  expect(sends).toBe(1); expect(env.writes).toEqual([])
})
it.each(folders)("resumes a known unapplied %s Graph role denial with fresh permission and approval checks", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let denied = true, sends = 0
  env.graph.mockImplementation((input, init) => {
    if (init?.method === "PATCH") { sends++; if (denied) return Promise.resolve(Response.json({ error: { code: "Authorization_RequestDenied", message: "Never retain this Graph body" } }, { status: 403 })) }
    return original(input, init)
  })
  expect(await env.execute(page, request)).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "deferred", reason: "Your Entra role does not allow this change. Activate the role, then resume." }] })
  expect([...env.data.values()].join()).not.toContain("Never retain this Graph body")
  expect(env.entry(page).acknowledged).toBeUndefined()
  env.setScopes("User.Read.All Group.Read.All Application.Read.All Policy.Read.All")
  expect(await env.execute(page, request)).toMatchObject({ outcomes: [{ state: "deferred" }] })
  expect(sends).toBe(1)
  env.setScopes("Application.Read.All Application.ReadWrite.All User.ReadUpdate.All User.Read.All Group.ReadWrite.All Group.Read.All Policy.Read.All")
  await expect(env.service().execute(tenant, { ...request, runId: page.runId }, page.fingerprint, {})).rejects.toThrow("Approve each selected row separately")
  expect(sends).toBe(1)
  denied = false
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  await env.execute(page, request)
  expect(sends).toBe(2); expect(env.writes).toEqual([{ [env.field]: "Saved" }])
})

it("finishes a user name preview and restore when Conditional Access targets only workloads", async () => {
  const env = world("Users"), original = env.graph.getMockImplementation()!
  env.graph.mockImplementation((input, init) => String(input).includes("conditionalAccess") ? Promise.resolve(Response.json({ value: [graphWorkloadPolicy] })) : original(input, init))
  const request = env.request(), page = await env.prepare(request)
  expect(page.rows[0]!.review.blocker).toBeUndefined()
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  expect(env.writes).toEqual([{ displayName: "Saved" }])
})

it.each(folders.flatMap(folder => ["initial", "references", "final", "write"].map(phase => ({ folder, phase }))))("resumes $folder after a Graph authorization failure at $phase with a fresh connection and all checks", async ({ folder, phase }) => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  let reads = 0, denied = false, sends = 0
  const denyAt = phase === "initial" ? 1 : phase === "references" ? (folder === "Applications" ? 3 : 2) : folder === "Applications" ? 5 : folder === "Groups" ? 5 : 4
  env.graph.mockImplementation((input, init) => {
    if (init?.method === "PATCH") {
      sends++
      if (phase === "write" && !denied) { denied = true; return Promise.resolve(Response.json({ error: { code: "InvalidAuthenticationToken", message: "Never retain authorization body" } }, { status: 401 })) }
    }
    if (phase !== "write" && init?.method === "GET" && new URL(String(input)).pathname === `/v1.0/${env.targetPath}` && ++reads === denyAt) {
      denied = true; return Promise.resolve(Response.json({ error: { code: "Authorization_RequestDenied", message: "Never retain authorization body" } }, { status: 403 }))
    }
    return original(input, init)
  })
  expect(await env.execute(page, request)).toMatchObject({ status: "partial", failed: 0, outcomes: [{ state: "deferred" }] })
  expect(denied).toBe(true); expect(sends).toBe(phase === "write" ? 1 : 0)
  expect(env.writes).toEqual([]); expect(env.locks()).toHaveLength(1)
  expect([...env.data.values()].join()).not.toContain("Never retain authorization body")
  const connections = env.connection.mock.calls.length
  env.setScopes("Application.Read.All User.Read.All Group.Read.All Policy.Read.All")
  expect(await env.execute(page, request)).toMatchObject({ failed: 0, outcomes: [{ state: "deferred" }] })
  expect(env.connection.mock.calls.length).toBeGreaterThan(connections)
  env.setScopes("Application.Read.All Application.ReadWrite.All User.ReadUpdate.All User.Read.All Group.ReadWrite.All Group.Read.All Policy.Read.All")
  await expect(env.service().execute(tenant, { ...request, runId: page.runId }, page.fingerprint, {})).rejects.toThrow("Approve each selected row separately")
  expect(env.writes).toEqual([])
  expect(await env.execute(page, request)).toMatchObject({ status: "complete", outcomes: [{ state: "applied" }] })
  await env.execute(page, request)
  expect(env.writes).toEqual([{ [env.field]: "Saved" }]); expect(env.locks()).toEqual([])
  expect(sends).toBe(phase === "write" ? 2 : 1)
})
it.each(folders)("keeps a non-authorization %s Graph 403 failed with the sanitized refusal", async folder => {
  const env = world(folder), request = env.request(), page = await env.prepare(request), original = env.graph.getMockImplementation()!
  env.graph.mockImplementation((input, init) => init?.method === "PATCH" ? Promise.resolve(Response.json({ error: { code: "Request_BadRequest", message: "Never retain refusal body" } }, { status: 403 })) : original(input, init))
  expect(await env.execute(page, request)).toMatchObject({ failed: 1, outcomes: [{ state: "failed", reason: "Microsoft Graph refused this write (403). Review restore access in Services in Settings and preview this item again." }] })
  expect([...env.data.values()].join()).not.toContain("Never retain refusal body")
  expect(env.writes).toEqual([])
})
