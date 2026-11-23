import { afterEach, describe, expect, it, vi } from "vitest"
import { POST } from "../src/portal/app/api/restore-backup/route"
import { NextRequest } from "../src/main/api/next-server-shim"
import { resolveRestoreAssignments } from "../src/shared/intune/restore-assignments"
import { buildRestorePlan, buildUpdatePlan } from "../src/shared/intune/restore-plan"
import { typeForFolder, type Item } from "../src/shared/intune/registry"
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
  targetObjects: { group: new Map([[newGroup, "Windows pilot"]]), filter: new Map([[newFilter, "Corporate Windows"]]), scopeTag: new Map([["7", "IT"]]) },
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
      kind: "group", sourceId: oldGroup, state: "rejected", suggestion: { targetId: newGroup, targetName: "Windows pilot" },
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

  it("omits only the explicitly skipped assignment in an in-place restore", () => {
    const result = resolveRestoreAssignments(type, snapshot, { ...options, skipped: new Set(["0"]), mappings: [mappings[2]!] })
    expect(result.review.errors).toEqual([])
    expect(result.review.assignments).toMatchObject([{ key: "0", skipped: true }])
    expect(buildUpdatePlan(type, result.snapshot, "policy-id", { includeAssignments: true }).at(-1)?.body).toEqual({ assignments: [] })
    expect(resolveRestoreAssignments(type, snapshot, { ...options, sameTenant: false, skipped: new Set(["0"]), mappings: [mappings[2]!] }).review.errors).toHaveLength(1)
  })

  it("blocks unreadable targets and doesn't assume identical IDs across tenants", () => {
    const unreadable = resolveRestoreAssignments(type, snapshot, { ...options, mappings, targetObjects: { ...options.targetObjects, group: null } })
    expect(unreadable.review.errors).toHaveLength(1)
    const idCollision = resolveRestoreAssignments(type, snapshot, { ...options, sameTenant: false, targetObjects: { ...options.targetObjects, group: new Map([[oldGroup, "Other group"]]) } })
    expect(idCollision.review.references).toContainEqual(expect.objectContaining({ kind: "group", state: "missing", targetId: null }))
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
    { method: "GET", path: "/beta/groups" },
    { method: "GET", path: "/beta/deviceManagement/assignmentFilters" },
  ])
})
