import { ENTRA_AREAS } from "../src/shared/services/entra"
import { areaPermissions } from "../src/shared/services/manifest"
import { expect, it, vi } from "vitest"
import { DirectoryRestoreService } from "../src/main/restore/directory-service"
import { RecoveryAccounts } from "../src/main/restore/safety-resolvers"
import { privilegeRequest, unitChangeBlocker } from "../src/main/restore/directory-9c"
import { setRestoreJournalStore, guardedRestoreJournal } from "../src/main/storage/restore-journal"
import { typeForFolder } from "../src/shared/intune/registry"
import { readObject } from "../src/shared/intune/read"
import type { IdentityRestoreRequest } from "../src/main/restore/dispatch"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const tenant = id(1), client = id(2), admin = id(3), user = id(4), group = id(5), role = id(6), unit = id(7), oldRole = id(8)
const now = Date.parse("2026-11-23T12:00:00Z")
const endsAt = "2026-11-24T10:00:00.1234567Z"
const scheduleInfo = { startDateTime: "2026-11-22T10:00:00Z", expiration: { type: "afterDateTime", endDateTime: endsAt } }
const scheduled = { id: "saved-schedule", principalId: user, directoryScopeId: "/", roleDefinitionId: oldRole, memberType: "Direct", assignmentType: "Assigned", scheduleInfo }
const options = { stage: "object" as const, exactMembers: false, exactOwners: false }
const noBackupReads = async () => { throw new Error("Unexpected backup read") }
const actor = { tenantId: tenant, clientId: client, userId: admin, applicationObjectId: id(11), servicePrincipalId: id(12), recoveryAccountIds: [] }

function world(largeUnit = false) {
  const entries = new Map<string, string>()
  const store = { partitioned: true as const, get: (key: string) => entries.get(key) ?? null, set: (key: string, value: string) => { entries.set(key, value) }, delete: (key: string) => { entries.delete(key) } }
  setRestoreJournalStore(store)
  guardedRestoreJournal().save({ version: 1, id: id(15), tenant, actor, origin: "restore", entries: [], mappings: [{ kind: "objectId", folder: "EntraRoleDefinitions", source: oldRole, target: role }] })
  const scopes = areaPermissions(ENTRA_AREAS.find(area => area.id === "roles")!, "restore", "delegated")
  const connection = { ...actor, token: `h.${Buffer.from(JSON.stringify({ tid: tenant, oid: admin, appid: client, scp: scopes.join(" ") })).toString("base64url")}.s` }
  let status = 200, restricted = false
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe("GET")
    const url = new URL(String(input))
    expect(url.pathname.startsWith("/beta/")).toBe(true)
    const path = url.pathname.slice(6)
    if (path.startsWith("applications") || path.startsWith("servicePrincipals") && !path.includes("/")) {
      if (!scopes.includes("Application.Read.All")) return new Response(null, { status: 403 })
      return Response.json({ id: path.startsWith("applications") ? id(11) : id(12), appId: client })
    }
    if (path === `roleManagement/directory/roleDefinitions/${role}`) return Response.json({ id: role, displayName: "Custom role", isEnabled: true })
    if (path === `directory/administrativeUnits/${unit}`) return Response.json({ id: unit, displayName: "Unit", membershipType: "Assigned", isMemberManagementRestricted: restricted })
    if (path.endsWith("/members")) {
      const next = Number(url.searchParams.get("$skiptoken") ?? 0)
      url.searchParams.set("$skiptoken", String(next + 1))
      return Response.json({ value: largeUnit ? Array.from({ length: 50 }, (_, i) => ({ id: id(1000 + next * 50 + i) })) : [{ id: id(90) }], ...(largeUnit && next < 999 ? { "@odata.nextLink": String(url) } : {}) })
    }
    if (path.endsWith("/scopedRoleMembers")) return Response.json({ value: [] })
    if (path.startsWith("directoryObjects/")) return new Response(null, { status: 403 })
    if (path.startsWith("users/")) {
      if (!scopes.includes("User.Read.All")) return new Response(null, { status: 403 })
      const principalId = path.split("/")[1]!
      return Response.json({ id: principalId, displayName: "Current user", onPremisesSyncEnabled: null }, { status, headers: { "Retry-After": "120" } })
    }
    if (path === "roleManagement/directory/roleAssignmentSchedules") {
      if (!url.searchParams.has("$skiptoken")) return Response.json({ value: [], "@odata.nextLink": String(url) + "&$skiptoken=page2" })
      return Response.json({ value: [] })
    }
    return new Response(null, { status: 404 })
  })
  const start = () => new DirectoryRestoreService(store, new RecoveryAccounts(store), async () => connection, async () => connection, fetcher, undefined, undefined, () => now)
  return { start, fetcher, status: (value: number) => { status = value }, restrict: () => { restricted = true } }
}

it("uses distinct eligibility and assignment requests and preserves the absolute end time", () => {
  const target = { roleId: role, directoryScopeId: "/", groupId: group }
  const cases = {
    RoleEligibilitySchedules: "roleManagement/directory/roleEligibilityScheduleRequests",
    RoleAssignmentSchedules: "roleManagement/directory/roleAssignmentScheduleRequests",
    PimGroupEligibilitySchedules: "identityGovernance/privilegedAccess/group/eligibilityScheduleRequests",
    PimGroupAssignmentSchedules: "identityGovernance/privilegedAccess/group/assignmentScheduleRequests",
  }
  for (const [folder, path] of Object.entries(cases)) {
    expect(privilegeRequest(folder, { ...scheduled, accessId: "owner", justification: "private note", createdUsing: "obsolete" }, user, target, now)).toEqual({
      method: "POST", path, body: { principalId: user, ...(folder.startsWith("PimGroup") ? { accessId: "owner", groupId: group } : { roleDefinitionId: role, directoryScopeId: "/" }), action: "adminAssign", scheduleInfo: { startDateTime: "2026-11-23T12:00:00.000Z", expiration: { type: "afterDateTime", endDateTime: endsAt } } },
    })
  }
  expect(() => privilegeRequest("RoleAssignmentSchedules", scheduled, user, target, Date.parse("2026-11-25"))).toThrow(/expired/)
  expect(() => privilegeRequest("RoleAssignmentSchedules", { ...scheduled, assignmentType: "Activated" }, user, target, now)).toThrow(/activation/)
  expect(() => privilegeRequest("RoleAssignmentSchedules", { ...scheduled, memberType: "Inherited" }, user, target, now)).toThrow(/Inherited/)
  expect(() => privilegeRequest("RoleAssignmentSchedules", { ...scheduled, assignmentType: null }, user, target, now)).toThrow(/administrator-assigned/)
  expect(() => privilegeRequest("RoleEligibilitySchedules", { ...scheduled, appScopeId: id(99) }, user, target, now)).toThrow(/scope/)
  expect(() => privilegeRequest("PimGroupAssignmentSchedules", { ...scheduled, accessId: "admin" }, user, target, now)).toThrow(/privilege/)
})

it("builds only closed create and reference-removal contracts", () => {
  expect(privilegeRequest("EntraRoleAssignments", scheduled, user, { roleId: role, directoryScopeId: `/administrativeUnits/${unit}` }, now)).toEqual({
    method: "POST", path: "roleManagement/directory/roleAssignments", body: { principalId: user, roleDefinitionId: role, directoryScopeId: `/administrativeUnits/${unit}` },
  })
  expect(privilegeRequest("AdministrativeUnits", {}, user, { unitId: unit }, now, true)).toEqual({ method: "DELETE", path: `directory/administrativeUnits/${unit}/members/${user}/$ref` })
  expect(privilegeRequest("AdministrativeUnits", {}, user, { unitId: unit }, now)).toEqual({ method: "POST", path: `directory/administrativeUnits/${unit}/members/$ref`, body: { "@odata.id": `https://graph.microsoft.com/beta/directoryObjects/${user}` } })
  expect(privilegeRequest("AdministrativeUnits", {}, user, { unitId: unit, roleId: role }, now).body).toEqual({ roleId: role, roleMemberInfo: { id: user } })
  expect(unitChangeBlocker({ isMemberManagementRestricted: true })).toMatch(/restricted management/)
})

it("uses the Roles and PIM restore scopes for actor and principal reads, then saves a mapped, paged schedule preview and refuses a write with every approval", async () => {
  const env = world(), service = env.start()
  const request = { path: "backup/RoleAssignmentSchedules/saved-schedule.json", snapshot: scheduled, origin: "restore" as const }
  const page = await service.prepare(tenant, request, options, noBackupReads)
  expect(page.rows[0]?.review).toMatchObject({
    principal: { id: user, name: "Current user", type: "user" }, resource: { id: role, name: "Custom role" },
    scope: "Entire tenant", approvals: ["directory-item", "privileged-relationship", "security-response"],
    notices: [expect.stringContaining("looks deliberate")],
    changes: [{ property: "Schedule", after: { end: endsAt } }, { property: "Relationship", before: "Absent", after: "Present" }],
  })
  expect(env.fetcher.mock.calls.filter(([url]) => String(url).includes("roleAssignmentSchedules"))).toHaveLength(2)
  const saved = { ...request, runId: page.runId }
  expect((await env.start().resume(tenant, saved))).toMatchObject({ fingerprint: page.fingerprint, rows: page.rows })
  const reads = env.fetcher.mock.calls.length
  await expect(service.execute(tenant, saved, page.fingerprint, { "privilege-0": page.rows[0]!.review.approvals })).rejects.toThrow(/required before execution/)
  expect(env.fetcher.mock.calls).toHaveLength(reads)
  expect(await service.saved(tenant, page.runId, "reconcile")).toMatchObject({ status: "nothing-sent" })
  await expect(service.prepare(tenant, { ...request, origin: "import" }, options, noBackupReads)).rejects.toThrow(/owned same-tenant/)
})

it("blocks self-benefit and isolates an unavailable principal", async () => {
  const env = world(), service = env.start()
  const request = { path: "backup/RoleAssignmentSchedules/saved-schedule.json", snapshot: { ...scheduled, principalId: admin }, origin: "restore" as const }
  const page = await service.prepare(tenant, request, options, noBackupReads)
  expect(page.rows[0]?.review.blocker).toMatch(/protected/)
  env.status(404)
  const unresolved = await service.prepare(tenant, { ...request, snapshot: scheduled }, options, noBackupReads)
  expect(unresolved.rows[0]?.review.blocker).toMatch(/no longer resolves/)
  env.status(429)
  await expect(service.prepare(tenant, request, options, noBackupReads)).rejects.toThrow(/throttl/i)
})

it("pages a legacy-named administrative unit, preserving exact choice, role IDs and blocked rows", async () => {
  const env = world()
  const request: IdentityRestoreRequest = { path: "backup/AdministrativeUnits/Recovery unit.json", snapshot: {
    id: unit, members: Array.from({ length: 50 }, (_, index) => id(100 + index)),
    scopedRoleMembers: [id(91), { id: id(92), roleId: oldRole, roleMemberInfo: { id: user } }],
  }, origin: "restore" }
  const page = await env.start().prepare(tenant, request, { ...options, exactMembers: true }, noBackupReads)
  expect(page.rows).toHaveLength(50)
  expect(page.more).toBe(true)
  expect(page.rows[0]?.review.privilege).toBe("Add unit member")
  const next = await env.start().prepare(tenant, request, { ...options, exactMembers: true, previousRunId: page.runId }, noBackupReads)
  expect(next.rows.map(row => row.review.blocker)).toEqual([
    expect.stringContaining("last Global Administrator"), expect.stringContaining("lacks the principal or role ID"), expect.stringContaining("round trip"),
  ])
  expect(next.rows[0]?.review.approvals).toContain("exact-unit")
  expect(next.rows[2]?.review.privilege).toBe("Scoped role member: Custom role")
  expect(next.more).toBe(false)
  env.restrict()
  const restricted = await env.start().prepare(tenant, request, options, noBackupReads)
  expect(restricted.rows[0]?.review.blocker).toMatch(/restricted management/)
})

it("stores scoped unit member IDs without a name or a profile", async () => {
  const type = typeForFolder("AdministrativeUnits")!
  const snapshot = await readObject(type, unit, {
    get: async () => ({ id: unit }),
    list: async path => path.includes("scopedRoleMembers") ? [{ id: id(10), roleId: role, roleMemberInfo: { id: user, displayName: "Personal name", userPrincipalName: "private@example.test" } }] : [],
  })
  expect(snapshot.scopedRoleMembers).toEqual([{ id: id(10), roleId: role, roleMemberInfo: { id: user } }])
  expect(JSON.stringify(snapshot)).not.toContain("Personal name")
})

it("continues a 50,000-member exact AU review without loading every live member", async () => {
  const env = world(true)
  const request = { path: "backup/AdministrativeUnits/Large unit.json", snapshot: { id: unit, members: [], scopedRoleMembers: [] }, origin: "restore" as const }
  const memberReads = () => env.fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith("/members"))
  const first = await env.start().prepare(tenant, request, { ...options, exactMembers: true }, noBackupReads)
  expect(first.rows).toHaveLength(50)
  expect(first.more).toBe(true)
  expect(memberReads()).toHaveLength(1)
  const second = await env.start().prepare(tenant, request, { ...options, exactMembers: true, previousRunId: first.runId }, noBackupReads)
  expect(second.rows[0]?.review.principal?.id).toBe(id(1050))
  expect(memberReads()).toHaveLength(2)
})
