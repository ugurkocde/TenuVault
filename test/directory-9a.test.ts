import { describe, it, expect, vi } from "vitest"
import { directoryPayload, directoryReview, approveDirectory, requireDirectoryApprovals, relationshipDifference, previewDirectoryPage, NEVER_RESTORED } from "../src/main/restore/directory-9a"
import { directory9aIO, directoryPermissions } from "../src/main/restore/directory-9a-io"
import { executeDirectoryBatches } from "../src/main/restore/directory-9a-batches"
import { GuardedRunJournal, executeGuardedRun, restoreFingerprint, type GuardedRun, type GuardedStep, type GuardedIO } from "../src/main/restore/guarded-run"
import { restoreMatrixRow } from "../src/shared/intune/restore-matrix"
import { typeForFolder, restoreCapability, type Item } from "../src/shared/intune/registry"
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const actor = { tenantId: uuid(1), userId: uuid(2), clientId: uuid(3), applicationObjectId: uuid(4), servicePrincipalId: uuid(5), recoveryAccountIds: [uuid(6)] }
const user = { id: uuid(10), displayName: "Restored user", userPrincipalName: "restored@example.com", mailNickname: "restored", userType: "Member", accountEnabled: false }
const group = { id: uuid(20), displayName: "Restored group", mailNickname: "restored", groupTypes: [], securityEnabled: true, mailEnabled: false, isAssignableToRole: false }
const principal = { id: uuid(30), displayName: "Member", "@odata.type": "#microsoft.graph.user" }
const perms = ["User.Create", "User.ReadUpdate.All", "User.EnableDisableAccount.All", "User.Read.All", "User.ReadWrite.All", "User.DeleteRestore.All", "Group.ReadWrite.All", "GroupMember.ReadWrite.All", "RoleManagement.ReadWrite.Directory", "User.Invite.All", "LicenseAssignment.ReadWrite.All"]
const token = (permissions = perms) => `header.${Buffer.from(JSON.stringify({ tid: actor.tenantId, oid: actor.userId, appid: actor.clientId, scp: permissions.join(" ") })).toString("base64url")}.signature`
const storage = () => { const values = new Map<string, string>(); return { partitioned: true as const, values, get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value) }, delete: (key: string) => { values.delete(key) } } }
const stepFor = (action: NonNullable<GuardedStep["directory"]>["action"], folder = "Groups"): GuardedStep => ({ key: action, folder, sourceId: folder === "Users" ? user.id : group.id, targetId: folder === "Users" ? user.id : group.id, operation: action === "create" || action === "invite" ? "create" : "update", directory: { action }, desired: {}, properties: [], requires: [], preview: restoreFingerprint(null) })
const runFor = (step: GuardedStep): GuardedRun => ({ version: 1, id: "run", tenant: actor.tenantId, actor, origin: "restore", source: { path: "backup/source", fingerprint: "native" }, entries: [{ step, state: "pending" }], mappings: [] })
async function admitted<T>(fn: () => Promise<T>): Promise<T> {
  const saved = ["Users", "Groups"].map(folder => ({ type: typeForFolder(folder)!, restore: typeForFolder(folder)!.restore, row: restoreMatrixRow(folder)!, phase: restoreMatrixRow(folder)!.directoryRestore!.phase, evidence: restoreMatrixRow(folder)!.directoryRestore!.evidence }))
  for (const value of saved) { value.type.restore = "create"; value.row.directoryRestore!.phase = "enabled"; value.row.directoryRestore!.evidence = Object.fromEntries(["create", "update", "recycle", "invite", "member", "owner", "manager", "license"].map(action => [action, { date: "test-only", result: "round-trip-matched" as const }])) }
  try { return await fn() } finally { for (const value of saved) { value.type.restore = value.restore; value.row.directoryRestore!.phase = value.phase; if (value.evidence) value.row.directoryRestore!.evidence = value.evidence; else delete value.row.directoryRestore!.evidence } }
}
const refs = async () => ({ complete: true, principals: [], applications: [], remainingAdministrators: { global: [uuid(100)], privilegedRole: [uuid(101)] } })

it("keeps all directory operations blocked in production and setup unchanged", async () => {
  for (const folder of ["Users", "Groups"]) {
    expect(restoreCapability(typeForFolder(folder)!)).toBe("none")
    expect(restoreMatrixRow(folder)!.directoryRestore!.blocker).toContain("phase 2")
    const fetcher = vi.fn()
    const io = directory9aIO(token(), actor, refs, fetcher)
    await expect(io.write(stepFor("create", folder), {}, undefined, vi.fn(), runFor(stepFor("create", folder)))).rejects.toThrow("staged")
    expect(fetcher).not.toHaveBeenCalled()
  }
})
it("builds disabled users, refuses synced and guest creation, and separates group creation flags", () => {
  expect(directoryPayload("Users", "create", user)).toMatchObject({ accountEnabled: false })
  expect(directoryPayload("Users", "create", { ...user, accountEnabled: true, passwordProfile: { password: "never restore" } })).not.toHaveProperty("passwordProfile")
  for (const flag of ([{ onPremisesSyncEnabled: true }, { onPremisesLastSyncDateTime: "2026-11-01" }, { onPremisesImmutableId: "old" }, { userType: "Guest" }] as Item[])) expect(() => directoryPayload("Users", "create", { ...user, ...flag })).toThrow()
  for (const flags of [{ mailEnabled: true }, { securityEnabled: false }]) expect(() => directoryPayload("Groups", "create", { ...group, ...flags })).toThrow("cannot be restored")
  expect(directoryPayload("Groups", "create", { ...group, isAssignableToRole: true })).toMatchObject({ isAssignableToRole: true, visibility: "Private" })
  expect(directoryPayload("Groups", "update", { ...group, isAssignableToRole: true })).not.toHaveProperty("isAssignableToRole")
  expect(directoryPayload("Groups", "create", { ...group, groupTypes: ["Unified"], mailEnabled: true })).toMatchObject({ mailEnabled: true })
  expect(directoryPayload("Groups", "create", { ...group, groupTypes: ["DynamicMembership"], membershipRule: "user.department -eq \"IT\"" })).toHaveProperty("membershipRule")
  expect(Object.keys(NEVER_RESTORED)).toHaveLength(9)
})
it("shows who gets what, blocks unresolved and protected principals, and binds distinct approvals to each row", () => {
  const step = stepFor("member"); step.directory!.principalId = principal.id; step.desired = { present: true, principalId: principal.id }
  const review = directoryReview(step, { ...group, isAssignableToRole: true }, principal, actor, false)
  expect(review).toMatchObject({ principal: { name: "Member", type: "user" }, resource: { id: group.id, name: group.displayName }, privilege: "member", scope: `${actor.tenantId}/group/${group.id}` })
  expect(review.approvals).toEqual(["directory-item", "privileged-relationship", "security-response"])
  expect(directoryReview(step, group, principal, actor, true).approvals).toContain("privileged-relationship")
  expect(directoryReview(step, group, null, actor, false).blocker).toContain("no longer resolves")
  for (const id of [actor.userId, actor.servicePrincipalId, ...actor.recoveryAccountIds]) expect(directoryReview(step, group, { ...principal, id }, actor, false).blocker).toContain("protected")
  const run = runFor(step)
  for (const kind of review.approvals) approveDirectory(step, run, kind)
  requireDirectoryApprovals(step, run, review.approvals)
  for (const changed of [{ ...run, id: "other" }, { ...run, origin: "sync" as const }, { ...run, source: { path: "other", fingerprint: "native" } }]) expect(() => requireDirectoryApprovals(step, changed, review.approvals)).toThrow("separately")
  expect(() => requireDirectoryApprovals({ ...step, preview: "changed" }, run, review.approvals)).toThrow()
  const other = { ...step, key: "other-row" }; expect(() => requireDirectoryApprovals(other, run, review.approvals)).toThrow()
  expect(directoryReview({ ...step, desired: { present: false } }, group, principal, actor, false).blocker).toContain("exact")
  expect(directoryReview(step, { ...group, groupTypes: ["DynamicMembership"] }, principal, actor, false).blocker).toContain("rule")
  const enabled = stepFor("update", "Users"); enabled.desired = { accountEnabled: true }
  expect(directoryReview(enabled, user, null, actor, false).approvals).toContain("security-response")
  const m365 = stepFor("create"); m365.desired = { groupTypes: ["Unified"] }
  expect(directoryReview(m365, null, null, actor, false).notices.join(" ")).toContain("mailbox")
})

for (const action of ["create", "update", "recycle", "invite", "member", "owner", "manager", "license"] as const) describe(action, () => {
  for (const outcome of ["success", "timeout", "refused", "stale", "unapproved", "cancel"] as const) it(`${outcome}: uses the 8a journal and resumes without replay`, async () => admitted(async () => {
    const folder = ["member", "owner"].includes(action) ? "Groups" : "Users"
    const step = stepFor(action, folder)
    if (step.operation === "create") delete step.targetId
    const base = folder === "Users" ? user : group
    if (["member", "owner", "manager"].includes(action)) step.directory!.principalId = principal.id
    step.desired = action === "create" ? directoryPayload(folder, "create", base) : action === "update" ? { displayName: "Changed" } : action === "recycle" ? { restored: true } : action === "invite" ? { invitedUserEmailAddress: "guest@example.com", invitedUserDisplayName: "Guest", inviteRedirectUrl: "https://myapps.microsoft.com", sendInvitationMessage: false } : action === "manager" ? { principalId: principal.id } : action === "license" ? { assignedLicenses: [{ skuId: uuid(40), disabledPlans: [] }] } : { principalId: principal.id, present: true }
    step.properties = Object.keys(step.desired)
    let writes = 0, live: Item | null = ["create", "invite", "recycle"].includes(action) ? null : { ...base }, deleted = action === "recycle", related = false, licensed = false
    let secret: string | undefined
    const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(String(input)), path = url.pathname.replace("/v1.0/", "")
      if (options?.method !== "GET") {
        writes++
        if (outcome === "refused") return new Response(null, { status: action === "license" ? 429 : 403 })
        const body = options?.body ? JSON.parse(String(options.body)) : {}
        if (action === "create") { secret = body.passwordProfile.password; live = { ...base, ...step.desired } }
        else if (action === "invite") live = { ...base, ...step.desired, mail: "guest@example.com" }
        else if (action === "recycle") { live = { ...base }; deleted = false }
        else if (["member", "owner", "manager"].includes(action)) related = true
        else if (action === "license") licensed = true
        else live = { ...base, ...body }
        if (outcome === "timeout") throw new Error("The answer was lost after commit")
        return Response.json(action === "invite" ? { invitedUser: { id: user.id } } : { id: base.id })
      }
      if (path.startsWith("identity/conditionalAccess/")) return Response.json({ value: [] })
      if (path === `users/${principal.id}`) return Response.json(principal)
      if (path.startsWith("directory/deletedItems/")) return deleted ? Response.json(base) : new Response(null, { status: 404 })
      if (url.searchParams.has("$filter")) return Response.json({ value: live ? [live] : [] })
      if (/\/(members|owners)\//.test(path) || path.endsWith("/manager")) return related ? Response.json(principal) : new Response(null, { status: 404 })
      return live ? Response.json({ ...live, ...(action === "license" ? { assignedLicenses: licensed ? step.desired.assignedLicenses : [] } : {}) }) : new Response(null, { status: 404 })
    })
    const io = directory9aIO(token(), actor, refs, fetcher, async () => [], async () => {})
    step.preview = restoreFingerprint(await io.read(step, step.targetId))
    const run = runFor(step)
    for (const kind of (await io.review(step)).approvals) approveDirectory(step, run, kind)
    if (outcome === "unapproved") delete step.directoryApprovals
    if (outcome === "stale") step.preview = "stale"
    const saved = storage(), journal = new GuardedRunJournal(saved), controller = new AbortController()
    if (outcome === "cancel") controller.abort()
    let result = await executeGuardedRun(journal, run, io, controller.signal)
    if (outcome === "timeout" || outcome === "cancel") result = await executeGuardedRun(new GuardedRunJournal(saved), run, io)
    const state = result.run.entries[0]!.state
    expect(state).toBe(outcome === "refused" ? "failed" : outcome === "stale" ? "blocked" : outcome === "unapproved" ? "failed-before-send" : "applied")
    expect(writes).toBe(["stale", "unapproved"].includes(outcome) ? 0 : 1)
    if (secret) { expect(secret.length).toBeGreaterThan(60); expect([...saved.values.values()].join()).not.toContain(secret); expect([...saved.values.values()].join()).not.toContain("passwordProfile") }
  }))
})

it("locates the recycle bin before proposing creation and refuses bypassing it", async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes("deletedItems") ? Response.json(user) : new Response(null, { status: 404 }))
  const io = directory9aIO(token(), actor, refs, fetcher)
  expect((await io.locate("Users", user.id)).action).toBe("recycle")
  await expect(io.read({ ...stepFor("create", "Users"), targetId: undefined })).rejects.toThrow("recycle bin")
})
it("uses operation-specific least privileges and never requests excluded directory permissions", () => {
  expect(directoryPermissions(stepFor("create", "Users"))).toEqual(["User.Create"])
  expect(directoryPermissions(stepFor("update", "Users"))).toEqual(["User.ReadUpdate.All"])
  expect(directoryPermissions(stepFor("member"))).toEqual(["GroupMember.ReadWrite.All"])
  expect(directoryPermissions(stepFor("owner"))).toEqual(["Group.ReadWrite.All"])
})
it("retries bounded throttles and rejects hostile continuations before attaching credentials", async () => {
  let calls = 0
  const wait = vi.fn(async () => {})
  const io = directory9aIO(token(), actor, refs, vi.fn(async () => ++calls < 3 ? new Response(null, { status: 429, headers: { "Retry-After": "2" } }) : new Response(null, { status: 404 })), undefined, wait)
  expect((await io.locate("Users", user.id)).action).toBe("create")
  expect(wait.mock.calls).toEqual([[2000], [2000]])
  const fetcher = vi.fn(async () => Response.json({ value: [], "@odata.nextLink": "https://evil.example/users" }))
  const bad = directory9aIO(token(), actor, refs, fetcher)
  await expect(bad.review({ ...stepFor("member"), targetId: group.id })).rejects.toThrow()
})
it("streams 50,000 membership differences and loads only a bounded preview", async () => {
  let loaded = 0
  async function* saved() { for (let n = 1; n <= 50_000; n++) { loaded++; yield uuid(n) } }
  async function* empty() { /* Empty tenant membership. */ }
  expect(await previewDirectoryPage(relationshipDifference(saved(), empty()), 50)).toHaveLength(50)
  expect(loaded).toBe(50)
  let count = 0
  for await (const _ of relationshipDifference(saved(), empty())) count++
  expect(count).toBe(50_000)
  async function* current() { yield uuid(60_000) }
  expect(await previewDirectoryPage(relationshipDifference(empty(), current()))).toEqual([])
  expect(await previewDirectoryPage(relationshipDifference(empty(), current(), true))).toEqual([{ id: uuid(60_000), present: false }])
})
it("batches 50,000 members and 2,000 users, persists a bounded cursor and resumes a cancelled page without duplicates", async () => admitted(async () => {
  for (const total of [50_000, 2000]) {
    const store = storage(), controller = new AbortController(), applied = new Set<string>()
    let largest = 0, writes = 0
    const source = { fingerprint: "immutable-index", page: async (cursor: string | null, limit: number) => {
      const offset = Number(cursor ?? 0), end = Math.min(total, offset + limit)
      return { entries: Array.from({ length: end - offset }, (_, i) => {
        const id = uuid(offset + i + 100), step = stepFor(total === 2000 ? "create" : "member", total === 2000 ? "Users" : "Groups")
        step.key = id
        if (total === 2000) { step.sourceId = id; delete step.targetId; step.desired = { displayName: id, userPrincipalName: id + "@example.com", mailNickname: id, accountEnabled: false }; step.preview = restoreFingerprint(null) }
        else { step.desired = { principalId: id }; step.preview = restoreFingerprint({ id: group.id }) }
        step.properties = Object.keys(step.desired)
        return { step, state: "pending" as const }
      }), next: end === total ? null : String(end) }
    } }
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body)), id = body.principalId ?? body.displayName
      expect(applied.has(id)).toBe(false); applied.add(id); writes++
      if (writes === 23) controller.abort()
      return Response.json({ id: total === 2000 ? id : group.id })
    })
    const io: GuardedIO = { token: token(), type: folder => typeForFolder(folder)!, replacedReferences: async () => [], read: async () => total === 2000 ? null : ({ id: group.id }), findCreated: async () => [], references: refs, write: async (_step, body, _target, before) => { before(); return (await fetcher("https://graph.microsoft.com/v1.0/$batch", { method: "POST", body: JSON.stringify(body) })).json() } }
    const originalSet = store.set
    store.set = (key, value) => { largest = Math.max(largest, value.length); originalSet(key, value) }
    const identity = { ...runFor(stepFor("member")), entries: undefined, mappings: undefined }
    const partial = await executeDirectoryBatches(store, identity, source, io, controller.signal)
    expect(partial.status).toBe("partial")
    const done = await executeDirectoryBatches(store, identity, source, io)
    expect(done.status).toBe("complete"); expect(writes).toBe(total); expect(largest).toBeLessThan(100_000)
    expect((await executeDirectoryBatches(store, identity, source, io)).batches).toBe(Math.ceil(total / 20))
    await expect(executeDirectoryBatches(store, identity, { ...source, fingerprint: "different" }, io)).rejects.toThrow("changed")
  }
}), 180_000)

for (const operation of ["create", "update"] as const) it(`group ${operation}: refuses an unapproved write and preserves an unknown create without duplicating it`, async () => admitted(async () => {
  const step = stepFor(operation)
  if (operation === "create") delete step.targetId
  step.desired = directoryPayload("Groups", operation, group); step.properties = Object.keys(step.desired)
  let writes = 0, live: Item | null = operation === "create" ? null : group
  const fetcher = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
    if (options?.method !== "GET") { writes++; live = { ...group, ...step.desired }; throw new Error("Lost create response") }
    if (String(_url).includes("deletedItems")) return new Response(null, { status: 404 })
    return live ? Response.json(live) : new Response(null, { status: 404 })
  })
  const io = directory9aIO(token(), actor, refs, fetcher, async () => [])
  step.preview = restoreFingerprint(await io.read(step, step.targetId))
  const run = runFor(step)
  for (const kind of (await io.review(step)).approvals) approveDirectory(step, run, kind)
  const store = storage()
  let result = await executeGuardedRun(new GuardedRunJournal(store), run, io)
  expect(result.run.entries[0]!.state).toBe("uncertain")
  result = await executeGuardedRun(new GuardedRunJournal(store), run, io)
  expect(result.run.entries[0]!.state).toBe(operation === "create" ? "uncertain" : "applied")
  expect(writes).toBe(1)
}))
it("retains an unanswered batch lock across run IDs", async () => admitted(async () => {
  const store = storage(), step = stepFor("create")
  step.desired = { displayName: "New" }; step.properties = ["displayName"]; delete step.targetId
  let writes = 0
  const io: GuardedIO = { token: token(), type: folder => typeForFolder(folder)!, read: async () => null, findCreated: async () => [], references: refs, write: async (_step, _body, _target, before) => { before(); writes++; throw new Error("Lost response") } }
  const source = { fingerprint: "same", page: async () => ({ entries: [{ step, state: "pending" as const }], next: null }) }
  const identity = runFor(step)
  expect((await executeDirectoryBatches(store, identity, source, io)).status).toBe("partial")
  expect((await executeDirectoryBatches(store, { ...identity, id: "different-run" }, source, io)).status).toBe("partial")
  expect(writes).toBe(1)
}))
