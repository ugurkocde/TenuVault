import { afterEach, describe, expect, it, vi } from "vitest"
import { POST } from "../src/portal/app/api/restore-backup/route"
import { NextRequest } from "../src/main/api/next-server-shim"
import { resolveRestoreAssignments } from "../src/shared/intune/restore-assignments"
import { buildRestorePlan } from "../src/shared/intune/restore-plan"
import { typeForFolder, type Item } from "../src/shared/intune/registry"
import { readGroupStates, type GroupState } from "../src/shared/intune/group-reads"
import { Restorer, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import type { Mapping } from "../src/shared/intune/reference-mapping"

const oldGroup = "11111111-2222-4333-8444-555555555555"
const newGroup = "11111111-2222-4333-8444-555555555556"
const oldFilter = "22222222-2222-4333-8444-555555555555"
const newFilter = "22222222-2222-4333-8444-555555555556"
const type = typeForFolder("ConfigurationPolicies")!
const snapshot: Item = {
  id: "policy-id",
  name: "Contoso Defender Pilot",
  roleScopeTagIds: ["3", "0"],
  settings: [],
  assignments: [
    { target: { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: oldGroup, deviceAndAppManagementAssignmentFilterType: "exclude", deviceAndAppManagementAssignmentFilterId: oldFilter } },
    { source: "policySets", target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "ignored" } },
  ],
}
const options = {
  sameTenant: true,
  mappings: [] as Mapping[],
  skipped: new Set<string>(),
  sourceNames: { group: new Map([[oldGroup, "Windows pilot"]]) },
  groupStates: new Map<string, GroupState>([[oldGroup, { state: "missing", name: null }], [newGroup, { state: "found", name: "Windows pilot" }]]),
  targetObjects: { filter: new Map([[newFilter, "Corporate Windows"]]), scopeTag: new Map([["7", "IT"]]) },
}
const mappings: Mapping[] = [
  { kind: "group", sourceId: oldGroup, targetId: newGroup, confirmed: true },
  { kind: "filter", sourceId: oldFilter, targetId: newFilter, confirmed: true },
  { kind: "scopeTag", sourceId: "3", targetId: "7", confirmed: true },
]

describe("Restore assignment planning", () => {
  it("keeps name matches and unconfirmed mappings out of the restore payload", () => {
    const result = resolveRestoreAssignments(type, snapshot, { ...options, mappings: mappings.map((mapping) => ({ ...mapping, confirmed: false })) })
    expect(result.review.references).toContainEqual(expect.objectContaining({
      kind: "group", sourceId: oldGroup, state: "rejected", targetId: oldGroup,
    }))
    expect(result.review.errors).toHaveLength(2)
    expect(result.snapshot).toEqual(snapshot)
  })

  it.each([true, false])("builds a restore with confirmed live objects (same tenant: %s)", (sameTenant) => {
    const result = resolveRestoreAssignments(type, snapshot, { ...options, sameTenant, mappings })
    expect(result.review.errors).toEqual([])
    const plan = buildRestorePlan(type, result.snapshot, { includeAssignments: true })
    expect(plan.create.body.roleScopeTagIds).toEqual(["7", "0"])
    expect(plan.assignments[0]?.body).toEqual({
      assignments: [{ target: { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: newGroup, deviceAndAppManagementAssignmentFilterType: "exclude", deviceAndAppManagementAssignmentFilterId: newFilter } }],
    })
    expect(snapshot.roleScopeTagIds).toEqual(["3", "0"])
  })

  it("preserves live assignments when every direct backup assignment is skipped", async () => {
    const result = resolveRestoreAssignments(type, snapshot, { ...options, skipped: new Set(["0"]), mappings: [mappings[2]!] })
    expect(result.review.errors).toEqual([])
    expect(result.review.assignments).toMatchObject([{ key: "0", skipped: true }])
    expect(result.review.allAssignmentsSkipped).toBe(true)
    const graph = vi.fn<GraphCall>(async (method, path): ReturnType<GraphCall> => {
      if (method !== "GET") return { status: 204, body: {} }
      if (path.split("?")[0] === "deviceManagement/configurationPolicies/policy-id") return { status: 200, body: { ...snapshot, name: "Current", description: "Changed" } }
      return { status: 200, body: { value: [] } }
    })
    const restorer = new Restorer(graph, { mode: "replace", assignments: true })
    const restored = await restorer.restore("backup/ConfigurationPolicies/policy.json", snapshot, {
      snapshot: result.snapshot, skipped: 1, allAssignmentsSkipped: result.review.allAssignmentsSkipped,
    })
    expect(restored).toMatchObject({ success: true, action: "updated", warnings: expect.arrayContaining(["All backup assignments were skipped. Existing assignments were kept."]) })
    expect(graph.mock.calls.filter(([method]) => method !== "GET").map(([method, path]) => [method, path]))
      .toEqual([["PUT", "deviceManagement/configurationPolicies/policy-id"]])
    expect(resolveRestoreAssignments(type, snapshot, { ...options, sameTenant: false, skipped: new Set(["0"]), mappings: [mappings[2]!] }).review.errors).toHaveLength(1)
  })

  it.each([true, false])("warns on unreadable groups without assuming identical IDs across tenants (same tenant: %s)", (sameTenant) => {
    const confirmed = sameTenant ? mappings.slice(1) : mappings
    const groupId = sameTenant ? oldGroup : newGroup
    const unreadable = resolveRestoreAssignments(type, snapshot, { ...options, sameTenant, mappings: confirmed, groupStates: new Map() })
    expect(unreadable.review.errors).toEqual([])
    expect(unreadable.review.warnings).toEqual([expect.stringContaining(groupId)])
    expect(buildRestorePlan(type, unreadable.snapshot, { includeAssignments: true }).assignments[0]?.body)
      .toMatchObject({ assignments: [{ target: { groupId } }] })
    const idCollision = resolveRestoreAssignments(type, snapshot, { ...options, sameTenant: false, groupStates: new Map([[oldGroup, { state: "found", name: "Other group" }]]) })
    expect(idCollision.review.references).toContainEqual(expect.objectContaining({ kind: "group", state: "missing", targetId: null }))
  })

  it("retains All devices and All users assignments across tenants without group reads", () => {
    const assignments = ["allDevicesAssignmentTarget", "allLicensedUsersAssignmentTarget"].map((target) => ({ target: { "@odata.type": `#microsoft.graph.${target}` } }))
    const result = resolveRestoreAssignments(type, { ...snapshot, assignments, roleScopeTagIds: ["0"] }, { ...options, sameTenant: false, groupStates: new Map() })
    expect(result.review.errors).toEqual([])
    expect(result.review.references).toMatchObject([{ kind: "scopeTag", state: "portable" }])
    expect(buildRestorePlan(type, result.snapshot, { includeAssignments: true }).assignments[0]?.body).toEqual({ assignments })
  })

  it("restores both group-target and role-style scope tag assignments", () => {
    const scopeTag = typeForFolder("ScopeTags")!
    const original: Item = { id: "3", displayName: "IT", assignments: [
      { target: { "@odata.type": "#microsoft.graph.scopeTagGroupAssignmentTarget", entraObjectId: oldGroup, targetType: "device" } },
      { displayName: "Pilot", members: [oldGroup], scopeMembers: [oldGroup] },
    ] }
    const result = resolveRestoreAssignments(scopeTag, original, { ...options, mappings })
    expect(result.review.errors).toEqual([])
    expect(buildRestorePlan(scopeTag, result.snapshot, { includeAssignments: true }).assignments).toMatchObject([
      { path: "deviceManagement/roleScopeTags/{id}/assign", body: { assignments: [
        { target: { entraObjectId: newGroup, targetType: "device" } },
        { target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: newGroup } },
      ] } },
    ])
  })
})

afterEach(() => vi.unstubAllGlobals())

it("blocks the entire restore when the second policy has a missing reference, with no Graph writes", async () => {
  const backupId = "backup-fixture"
  const tenantId = "33333333-2222-4333-8444-555555555555"
  const calls: Array<{ path: string; method: string }> = []
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "test" })
    if (url.hostname.endsWith(".blob.core.windows.net")) {
      if (url.pathname.endsWith("metadata.json")) return Response.json({ TenantId: tenantId, Status: "Success" })
      if (url.pathname.endsWith("first.json")) return Response.json({ ...snapshot, assignments: [], roleScopeTagIds: ["0"] })
      if (url.pathname.endsWith("second.json")) return Response.json({ ...snapshot, roleScopeTagIds: ["0"] })
    }
    if (url.hostname === "graph.microsoft.com") {
      calls.push({ path: url.pathname, method: init?.method ?? "GET" })
      if (url.pathname.startsWith("/beta/groups/")) return Response.json({}, { status: 404 })
      return Response.json({ value: [] })
    }
    return new Response(null, { status: 404 })
  })
  const response = await POST(new NextRequest("http://tenuvault.internal/api/restore-backup", {
    method: "POST",
    body: JSON.stringify({
      backupId, tenantId, appId: "test", clientSecret: "test", storageAccountName: "test",
      assignments: true, restoreType: "selective",
      selectedPolicies: ["first", "second"].map((name) => ({ path: `${backupId}/ConfigurationPolicies/${name}.json` })),
    }),
  }))
  expect(response.status).toBe(409)
  expect(calls).toEqual([
    { method: "GET", path: `/beta/groups/${oldGroup}` },
    { method: "GET", path: "/beta/deviceManagement/assignmentFilters" },
  ])
})

it("warns and writes the original group ID when the same-tenant restore gets a 403", async () => {
  const backupId = "backup-fixture"
  const tenantId = "33333333-2222-4333-8444-555555555555"
  const stored: Item = {
    id: "policy-id", name: "Example", roleScopeTagIds: ["0"], settings: [],
    assignments: [{ target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: oldGroup } }],
  }
  const writes: Array<{ path: string; body: unknown }> = []
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "test" })
    if (url.hostname.endsWith(".blob.core.windows.net")) {
      if (url.pathname.endsWith("metadata.json")) return Response.json({ TenantId: tenantId, Status: "Success" })
      if (url.pathname.endsWith("app.json")) return Response.json({
        id: "app-id", displayName: "Installer", "@odata.type": "#microsoft.graph.windowsUniversalAppX",
        assignments: [{ target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: newGroup } }],
      })
      return Response.json(stored)
    }
    if (url.pathname === `/beta/groups/${oldGroup}`) return Response.json({}, { status: 403 })
    if (url.pathname.startsWith("/beta/groups/")) return Response.json({}, { status: 404 })
    if (init?.method === "POST") {
      writes.push({ path: url.pathname, body: JSON.parse(String(init.body)) })
      return Response.json({ id: "restored" }, { status: 201 })
    }
    return new Response(null, { status: 404 })
  })
  const response = await POST(new NextRequest("http://tenuvault.internal/api/restore-backup", {
    method: "POST",
    body: JSON.stringify({
      backupId, tenantId, appId: "test", clientSecret: "test", storageAccountName: "test",
      assignments: true, restoreType: "selective",
      selectedPolicies: [{ path: `${backupId}/ConfigurationPolicies/policy.json` }, { path: `${backupId}/Apps/app.json` }],
    }),
  }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ details: { results: expect.arrayContaining([
    expect.objectContaining({ success: true, warnings: [expect.stringContaining(oldGroup)] }),
    expect.objectContaining({ path: `${backupId}/Apps/app.json`, action: "skipped" }),
  ]) } })
  expect(writes).toContainEqual({ path: "/beta/deviceManagement/configurationPolicies/restored/assign", body: { assignments: stored.assignments } })
})

it("batches referenced groups in groups of twenty and handles their individual statuses", async () => {
  const ids = Array.from({ length: 21 }, (_, index) => `11111111-2222-4333-8444-${String(index).padStart(12, "0")}`)
  const graph = vi.fn<GraphCall>(async (_method, _path, body) => {
    const requests = body?.requests as Array<{ id: string; method: string; url: string }>
    return { status: 200, body: { responses: requests.map(({ id, url }) => {
      const groupId = url.split("/")[2]?.split("?")[0]
      return { id, status: groupId === ids[0] ? 404 : groupId === ids[1] ? 403 : 200, body: { id: groupId ?? "", displayName: "Pilot" } }
    }).reverse() } }
  })
  const states = await readGroupStates(graph, [...ids, ids[0]!])
  expect(graph.mock.calls.map(([method, path, body]) => [method, path, (body?.requests as Item[] | undefined)?.length]))
    .toEqual([["POST", "$batch", 20], ["POST", "$batch", 1]])
  expect(states.get(ids[0]!)).toEqual({ state: "missing", name: null })
  expect(states.get(ids[1]!)).toEqual({ state: "unknown", name: null })
  expect(states.get(ids[20]!)).toEqual({ state: "found", name: "Pilot" })
})
