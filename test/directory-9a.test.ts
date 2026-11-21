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
  for (const value of saved) { value.type.restore = "create"; value.row.directoryRestore!.phase = "enabled"; value.row.directoryRestore!.evidence = Object.fromEntries(["create", "update", "recycle", "invite", "member", "owner", "manager", "license", "owner remove", "account state", "dynamic rule", "role-assignable", "role-assignable creation", "microsoft365", "privileged-links", "nested-links"].map(action => [action, { date: "test-only", result: "round-trip-matched" as const }])) }
  try { return await fn() } finally { for (const value of saved) { value.type.restore = value.restore; value.row.directoryRestore!.phase = value.phase; if (value.evidence) value.row.directoryRestore!.evidence = value.evidence; else delete value.row.directoryRestore!.evidence } }
}
const refs = async () => ({ complete: true, principals: [], applications: [], remainingAdministrators: { global: [uuid(100)], privilegedRole: [uuid(101)] } })

it("admits only individually evidenced operations and refuses licenses and invitations", async () => {
  for (const folder of ["Users", "Groups"]) {
    expect(restoreCapability(typeForFolder(folder)!)).toBe("create")
    expect(restoreMatrixRow(folder)!.directoryRestore!.phase).toBe("enabled")
    const fetcher = vi.fn(), io = directory9aIO(token(), actor, refs, fetcher)
    const step = stepFor(folder === "Users" ? "license" : "recycle", folder)
    await expect(io.write(step, {}, undefined, vi.fn(), runFor(step))).rejects.toThrow()
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
  for (const outcome of ["success", "timeout", "refused", "stale", "unapproved", "cancel", "throttled"] as const) it(`${outcome}: uses the 8a journal and resumes without replay`, async () => admitted(async () => {
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
        if (outcome === "throttled" && writes === 1) return new Response(null, { status: 429, headers: { "Retry-After": "1" } })
        if (outcome === "refused") return new Response(null, { status: 403 })
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
      if (path.endsWith("/memberOf")) return Response.json({ value: [] })
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
    expect(writes).toBe(["stale", "unapproved"].includes(outcome) ? 0 : outcome === "throttled" ? 2 : 1)
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
  const date = vi.spyOn(Date, "now").mockReturnValue(100_000)
  try {
    let calls = 0
    const wait = vi.fn(async () => {})
    const io = directory9aIO(token(), actor, refs, vi.fn(async () => ++calls < 3 ? new Response(null, { status: 429, headers: { "Retry-After": "2" } }) : new Response(null, { status: 404 })), undefined, wait)
    expect((await io.locate("Users", user.id)).action).toBe("create")
    expect(wait.mock.calls).toEqual([[2000], [2000]])
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json({ value: [], "@odata.nextLink": "https://evil.example/users" }))
    const bad = directory9aIO(token(), actor, refs, fetcher)
    const collect = async () => { for await (const _ of bad.ids(group.id, "members")) { /* Fully follow the relationship inventory. */ } }
    await expect(collect()).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0]![0])).toContain(`/beta/groups/${group.id}/members`)
  } finally { date.mockRestore() }
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
it("journal and batch engine: processes 50,000 members and 2,000 users, persists a bounded cursor and resumes a cancelled page without duplicates", async () => admitted(async () => {
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
  step.desired = operation === "create" ? directoryPayload("Groups", operation, group) : { description: "Restored description" }; step.properties = Object.keys(step.desired)
  let writes = 0, live: Item | null = operation === "create" ? null : group
  const fetcher = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
    if (String(_url).includes("roleAssignments")) return Response.json({ value: [{ principalId: actor.userId, directoryScopeId: "/", roleDefinitionId: uuid(50) }] })
    if (String(_url).includes("roleDefinitions")) return Response.json({ templateId: "fdd7a751-b60b-444a-984c-02652fe8fa1c" })
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

it("closes both relationship streams when the preview page ends", async () => {
  const closed: string[] = []
  async function* saved() { try { yield uuid(1); yield uuid(2) } finally { closed.push("saved") } }
  async function* current() { try { yield uuid(3) } finally { closed.push("current") } }
  expect(await previewDirectoryPage(relationshipDifference(saved(), current()), 1)).toHaveLength(1)
  expect(closed.sort()).toEqual(["current", "saved"])
})

it("does not widen a Conditional Access excluded group's membership permission to role management", async () => admitted(async () => {
  const step = stepFor("member"); step.directory!.principalId = principal.id; step.desired = { principalId: principal.id, present: true }; step.properties = Object.keys(step.desired)
  const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    if (options?.method !== "GET") return Response.json({ id: group.id })
    if (String(input).includes("/memberOf")) return Response.json({ value: [] })
    if (String(input).includes("conditionalAccess")) return Response.json({ value: [{ conditions: { users: { includeGroups: [], excludeGroups: [group.id] } } }] })
    if (new URL(String(input)).pathname.endsWith("users/" + principal.id)) return Response.json(principal)
    return Response.json(group)
  })
  const io = directory9aIO(token(["GroupMember.ReadWrite.All", "Group.Read.All", "User.Read.All", "Policy.Read.All"]), actor, refs, fetcher)
  step.preview = restoreFingerprint(await io.read(step))
  const review = await io.review(step), run = runFor(step)
  expect(review.roleAssignable).toBe(false); expect(review.approvals).toContain("privileged-relationship")
  for (const kind of review.approvals) approveDirectory(step, run, kind)
  expect(await io.write(step, step.desired, group.id, () => {}, run)).toEqual({ id: group.id })
}))

it("preserves paused dynamic rules and requires an independent activation approval, refusing unresolved CA beneficiaries", () => {
  const dynamic = { ...group, groupTypes: ["DynamicMembership"], membershipRule: "user.department -eq \"IT\"", membershipRuleProcessingState: "Paused" }
  expect(directoryPayload("Groups", "update", dynamic).membershipRuleProcessingState).toBe("Paused")
  expect(directoryPayload("Groups", "create", { ...dynamic, membershipRuleProcessingState: null }).membershipRuleProcessingState).toBe("Paused")
  expect(() => directoryPayload("Groups", "update", { ...dynamic, membershipRuleProcessingState: "unknown" })).toThrow("unsupported")
  const step = stepFor("update"); step.desired = { membershipRule: dynamic.membershipRule, membershipRuleProcessingState: "On" }
  expect(directoryReview(step, dynamic, null, actor, false).approvals).toContain("security-response")
  expect(directoryReview(step, dynamic, null, actor, true).blocker).toContain("future beneficiaries")
})

it("refuses non-admin group creation before Graph can implicitly add the caller as owner", async () => {
  const step = stepFor("create"); delete step.targetId
  step.desired = directoryPayload("Groups", "create", { ...group, groupTypes: ["DynamicMembership"], membershipRule: "user.department -eq \"IT\"", membershipRuleProcessingState: "Paused" })
  const fetcher = vi.fn(async () => Response.json({ value: [] }))
  const io = directory9aIO(token(), actor, refs, fetcher)
  await expect(io.review(step)).rejects.toThrow("Non-admin creation")
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it("selects the optional user fields needed to reconcile an unanswered create", async () => {
  const step = stepFor("create", "Users"); delete step.targetId
  step.desired = directoryPayload("Users", "create", user)
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const selected = new URL(String(input)).searchParams.get("$select")?.split(",") ?? ["id", "displayName", "userPrincipalName"]
    return Response.json({ value: [Object.fromEntries(Object.entries({ ...user, id: uuid(90) }).filter(([key]) => selected.includes(key)))] })
  })
  const io = directory9aIO(token(), actor, refs, fetcher)
  expect(await io.findCreated(step, step.desired)).toEqual([expect.objectContaining({ ...step.desired, id: uuid(90) })])
})

function retryWorld(removal = false) {
  const step = stepFor("member")
  step.directory = { action: "member", principalId: principal.id, ...(removal ? { exact: true } : {}) }
  step.allowRemoval = removal; step.desired = { principalId: principal.id, present: !removal }; step.properties = Object.keys(step.desired)
  const members = new Set(removal ? [principal.id, uuid(31)] : [])
  const controller = new AbortController()
  let attempts = 0, applied = 0, mode = "success", included = false
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname.replace(/^\/(v1\.0|beta)\//, "")
    if (init?.method !== "GET") {
      attempts++
      if (mode === "throttle" && attempts === 1) return new Response(null, { status: 429 })
      applied++
      if (removal) members.delete(principal.id); else members.add(principal.id)
      if (mode === "unanswered") { controller.abort(); throw new Error("Answer lost") }
      return new Response(null, { status: 204 })
    }
    if (path === `groups/${group.id}`) return Response.json(group)
    if (path.endsWith("/memberOf")) return Response.json({ value: [] })
    if (path.includes("conditionalAccess")) return Response.json({ value: [{ conditions: { users: { includeGroups: included ? [group.id] : [], excludeGroups: [] } } }] })
    if (path === `groups/${group.id}/members`) return Response.json({ value: [...members].map(id => ({ id })) })
    if (path.includes("/members/")) return members.has(principal.id) ? Response.json(principal) : new Response(null, { status: 404 })
    return Response.json(principal)
  })
  const configure = (next: string, ca = false) => { mode = next; included = ca }
  return { step, members, controller, fetcher, configure, attempts: () => attempts, applied: () => applied }
}
it("cancels a throttled write promptly and resumes its definitely unapplied attempt", async () => {
  const env = retryWorld(), saved = storage(), journal = new GuardedRunJournal(saved)
  env.configure("throttle")
  let waiting!: () => void
  const reached = new Promise<void>(resolve => { waiting = resolve })
  let release!: () => void
  const io = directory9aIO(token(), actor, refs, env.fetcher, undefined, async () => { waiting(); await new Promise<void>(resolve => { release = resolve }) })
  env.step.preview = restoreFingerprint(await io.read(env.step))
  const run = runFor(env.step)
  for (const kind of (await io.review(env.step)).approvals) approveDirectory(env.step, run, kind)
  const pending = executeGuardedRun(journal, run, io, env.controller.signal)
  await reached; env.controller.abort()
  let result: Awaited<typeof pending>
  try { result = await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Cancellation did not interrupt backoff")), 100))]) }
  finally { release(); await pending }
  expect(env.attempts()).toBe(1); expect(result.run.entries[0]!.state).toBe("captured")
  expect((await executeGuardedRun(journal, run, directory9aIO(token(), actor, refs, env.fetcher))).status).toBe("complete")
  expect(env.attempts()).toBe(2); expect(env.applied()).toBe(1)
})
it("retains an unanswered cancelled send for reconciliation instead of retrying it", async () => {
  const env = retryWorld(), journal = new GuardedRunJournal(storage())
  env.configure("unanswered")
  const io = directory9aIO(token(), actor, refs, env.fetcher)
  env.step.preview = restoreFingerprint(await io.read(env.step))
  const run = runFor(env.step)
  for (const kind of (await io.review(env.step)).approvals) approveDirectory(env.step, run, kind)
  expect((await executeGuardedRun(journal, run, io, env.controller.signal)).run.entries[0]!.state).toBe("uncertain")
  expect((await executeGuardedRun(journal, run, io)).status).toBe("complete")
  expect(env.attempts()).toBe(1)
})
it("rechecks CA membership before a throttled removal retry and consumes all membership pages", async () => {
  const env = retryWorld(true); env.configure("throttle", true)
  let pages = 0
  const original = env.fetcher.getMockImplementation()!
  env.fetcher.mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/members")) {
      pages++
      return url.searchParams.has("$skiptoken") ? Response.json({ value: [...env.members].filter(id => id !== principal.id).map(id => ({ id })) }) : Response.json({ value: [{ id: principal.id }], "@odata.nextLink": url.href + "&$skiptoken=rest" })
    }
    return original(input, init)
  })
  const io = directory9aIO(token(), actor, refs, env.fetcher, undefined, async () => { env.members.delete(uuid(31)) })
  env.step.preview = restoreFingerprint(await io.read(env.step))
  const run = runFor(env.step)
  for (const kind of (await io.review(env.step)).approvals) approveDirectory(env.step, run, kind)
  expect((await executeGuardedRun(new GuardedRunJournal(storage()), run, io)).status).toBe("partial")
  expect(env.attempts()).toBe(1); expect(env.members.has(principal.id)).toBe(true); expect(pages).toBeGreaterThan(2)
})

it("checks cancellation at the final send boundary before attaching a write", async () => {
  const env = retryWorld(), io = directory9aIO(token(), actor, refs, env.fetcher)
  env.step.preview = restoreFingerprint(await io.read(env.step))
  const run = runFor(env.step)
  for (const kind of (await io.review(env.step)).approvals) approveDirectory(env.step, run, kind)
  await expect(io.write(env.step, env.step.desired, group.id, () => env.controller.abort(), run, env.controller.signal)).rejects.toThrow("cancelled before sending")
  expect(env.attempts()).toBe(0)
})
it("blocks removals if a later CA policy or membership page cannot be read completely", async () => {
  for (const collection of ["policies", "members"]) {
    const env = retryWorld(true); env.configure("success", true)
    const original = env.fetcher.getMockImplementation()!
    env.fetcher.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/" + collection)) {
        if (url.searchParams.has("$skiptoken")) return new Response(null, { status: 403 })
        const page = await original(input, init)
        return Response.json({ ...await page.json(), "@odata.nextLink": url.href + (url.search ? "&" : "?") + "$skiptoken=unreadable" })
      }
      return original(input, init)
    })
    const io = directory9aIO(token(), actor, refs, env.fetcher)
    env.step.preview = restoreFingerprint(await io.read(env.step))
    await expect(io.review(env.step)).rejects.toThrow()
    const run = runFor(env.step)
    expect((await executeGuardedRun(new GuardedRunJournal(storage()), run, io)).status).toBe("partial")
    expect(env.attempts()).toBe(0)
  }
})

it.each(["Users", "Groups"] as const)("records a confirmed %s PATCH throttle as unapplied and repeats safety checks before success", async folder => {
  let live: Item = folder === "Users" ? { ...user } : { ...group, description: "Old" }
  let attempts = 0
  const step = stepFor("update", folder)
  step.desired = folder === "Users" ? { displayName: "Saved" } : { description: "Saved" }; step.properties = Object.keys(step.desired)
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      if (++attempts === 1) return new Response(null, { status: 429, headers: { "Retry-After": "2" } })
      live = { ...live, ...JSON.parse(String(init.body)) }; return new Response(null, { status: 204 })
    }
    if (String(input).includes("conditionalAccess")) return Response.json({ value: [] })
    return Response.json(live)
  })
  const safety = vi.fn(refs), store = storage(), journal = new GuardedRunJournal(store), waits: number[] = []
  const io = directory9aIO(token(), actor, safety, fetcher, undefined, async ms => {
    waits.push(ms)
    expect(journal.load(actor.tenantId, "run")!.entries[0]).toMatchObject({ state: "captured", retryAt: expect.any(Number) })
    expect(attempts).toBe(1)
  })
  step.preview = restoreFingerprint(await io.read(step))
  const run = runFor(step)
  for (const approval of (await io.review(step)).approvals) approveDirectory(step, run, approval)
  const date = vi.spyOn(Date, "now").mockReturnValue(100_000)
  try {
    expect(await executeGuardedRun(journal, run, io)).toMatchObject({ status: "complete", run: { entries: [{ state: "applied" }] } })
    expect(attempts).toBe(2); expect(waits).toEqual([2000]); expect(safety).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(2)
  } finally { date.mockRestore() }
})
it.each(["Users", "Groups"] as const)("never resends an unconfirmed %s 503 PATCH after repeated old-value reads", async folder => {
  const live = folder === "Users" ? user : { ...group, description: "Old" }
  const step = stepFor("update", folder)
  step.desired = folder === "Users" ? { displayName: "Saved" } : { description: "Saved" }; step.properties = Object.keys(step.desired)
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => init?.method === "PATCH" ? new Response(null, { status: 503 }) : String(input).includes("conditionalAccess") ? Response.json({ value: [] }) : Response.json(live))
  const io = directory9aIO(token(), actor, refs, fetcher), journal = new GuardedRunJournal(storage())
  step.preview = restoreFingerprint(await io.read(step))
  const run = runFor(step)
  for (const approval of (await io.review(step)).approvals) approveDirectory(step, run, approval)
  for (let restart = 0; restart < 4; restart++) expect(await executeGuardedRun(journal, run, io)).toMatchObject({ status: "partial", run: { entries: [{ state: "uncertain" }] } })
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1)
})
