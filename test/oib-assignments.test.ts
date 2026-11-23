import { describe, expect, it } from "vitest"
import { assignmentsFor, assignsAnything, conflictingGroups, describeAssignment, directAssignments, emptySpec, filterPlatformFor, includesFor, mergeAssignments, oibScope, parseSpec, sameAssignments, writableAssignment } from "../src/shared/oib/assignments"

const A = "aaaaaaaa-0000-4000-8000-000000000001"
const B = "bbbbbbbb-0000-4000-8000-000000000002"
const X = "cccccccc-0000-4000-8000-000000000003"
const F = "dddddddd-0000-4000-8000-000000000004"
const include = (groupId: string, filter?: Record<string, string>) => ({ target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId, ...filter } })
const exclude = (groupId: string) => ({ target: { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId } })

describe("OIB policy scope", () => {
  it("uses the manifest scope first, then the D or U marker in the name", () => {
    expect(oibScope({ scope: "Device", name: "Win - OIB - Compliance - U - Password" })).toBe("device")
    expect(oibScope({ scope: "User", name: "x" })).toBe("user")
    expect(oibScope({ name: "MacOS - OIB - Microsoft Edge - U - Extensions - v1.0" })).toBe("user")
    expect(oibScope({ name: "Win365 - OIB - Device Security - D - Connectivity Settings - v1.0" })).toBe("device")
    expect(oibScope({ name: "Win - OIB - SC - Test - v3.8" })).toBeUndefined()
    expect(oibScope({ name: "Win - OIB - SC - DU - Test" })).toBeUndefined()
  })
})

describe("assignment spec", () => {
  it("normalizes group IDs and keeps names", () => {
    const spec = parseSpec({ deviceGroups: [{ id: A.toUpperCase(), name: "Pilot devices" }], userGroups: [B], filters: { windows10AndLater: { id: F, mode: "exclude" }, macOS: null } })
    expect(spec).toEqual({ deviceGroups: [{ id: A, name: "Pilot devices" }], userGroups: [{ id: B }], excludeGroups: [], unmarked: "both", filters: { windows10AndLater: { id: F, mode: "exclude" } } })
    expect(assignsAnything(spec)).toBe(true)
    expect(assignsAnything({ ...emptySpec(), excludeGroups: [{ id: X }] })).toBe(false)
  })

  it("refuses what Intune would not take or what would surprise the admin", () => {
    expect(() => parseSpec(null)).toThrow("invalid")
    expect(() => parseSpec({ deviceGroups: ["Pilot"] })).toThrow("Entra group object ID")
    expect(() => parseSpec({ deviceGroups: [A, A.toUpperCase()] })).toThrow("listed twice")
    expect(() => parseSpec({ deviceGroups: [A], excludeGroups: [A] })).toThrow("both included and excluded")
    expect(() => parseSpec({ deviceGroups: Array.from({ length: 26 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`) })).toThrow("at most 25")
    expect(() => parseSpec({ unmarked: "all" })).toThrow("marker")
    expect(() => parseSpec({ filters: { linux: { id: F, mode: "include" } } })).toThrow("Unknown assignment filter platform")
    expect(() => parseSpec({ filters: { macOS: { id: F, mode: "only" } } })).toThrow("includes or excludes")
  })
})

describe("assignments per policy", () => {
  const spec = { ...emptySpec(), deviceGroups: [{ id: A }], userGroups: [{ id: B }, { id: A }], excludeGroups: [{ id: X }], filters: { windows10AndLater: { id: F, mode: "include" as const } } }

  it("routes groups by scope and sends unmarked policies where the admin chose", () => {
    expect(includesFor("device", spec).map(g => g.id)).toEqual([A])
    expect(includesFor("user", spec).map(g => g.id)).toEqual([B, A])
    expect(includesFor(undefined, spec).map(g => g.id)).toEqual([A, B])
    expect(includesFor(undefined, { ...spec, unmarked: "none" })).toEqual([])
  })

  it("adds the filter of the policy's platform to each include and the exclusions after them", () => {
    const filter = { deviceAndAppManagementAssignmentFilterId: F, deviceAndAppManagementAssignmentFilterType: "include" }
    expect(assignmentsFor({ folder: "ConfigurationPolicies", scope: "device" }, "windows", spec)).toEqual({ assignments: [include(A, filter), exclude(X)], include: 1, exclude: 1, filter: { id: F, mode: "include" }, notes: [] })
    // A macOS policy has no macOS filter chosen: no filter, no note.
    expect(assignmentsFor({ folder: "ConfigurationPolicies", scope: "device" }, "macos", spec)).toMatchObject({ assignments: [include(A), exclude(X)], notes: [] })
  })

  it("leaves out filters and exclusions the policy type does not take, and says so", () => {
    expect(filterPlatformFor("DriverUpdateProfiles", "windows")).toBeUndefined()
    expect(filterPlatformFor("AppProtectionIOS", "byod")).toBe("iOSMobileApplicationManagement")
    expect(filterPlatformFor("ConfigurationPolicies", "byod")).toBeUndefined()
    const driver = assignmentsFor({ folder: "DriverUpdateProfiles", scope: "device", typeLabel: "driver update profiles" }, "windows", spec)
    expect(driver.assignments).toEqual([include(A), exclude(X)])
    expect(driver.notes).toEqual(["Assigned without a filter: driver update profiles does not support assignment filters."])
    const noExclusions = assignmentsFor({ folder: "ConfigurationPolicies", scope: "device", exclusionsUnsupported: true, typeLabel: "x" }, "windows", spec)
    expect(noExclusions).toMatchObject({ exclude: 0, notes: ["Excluded groups were left out: x does not support exclusions."] })
    // Nothing to include: no exclusions either, so the policy stays unassigned.
    expect(assignmentsFor({ folder: "ConfigurationPolicies", scope: "user" }, "windows", { ...spec, userGroups: [] })).toEqual({ assignments: [], include: 0, exclude: 0, notes: [] })
  })
})

describe("merging assignments", () => {
  it("keeps direct assignments, replaces the same target and leaves policy set assignments out", () => {
    const live = [
      { id: "1", source: "direct", target: { ...include(A).target, deviceAndAppManagementAssignmentFilterId: null, deviceAndAppManagementAssignmentFilterType: "none" } },
      { id: "2", source: "policySets", target: include("set").target },
      { id: "3", target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" }, intent: "apply" },
    ]
    const current = directAssignments(live).map(writableAssignment)
    expect(current).toEqual([include(A), { intent: "apply", target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } }])
    const filtered = include(A, { deviceAndAppManagementAssignmentFilterId: F, deviceAndAppManagementAssignmentFilterType: "exclude" })
    expect(mergeAssignments(current, [filtered, exclude(X)])).toEqual([current[1], filtered, exclude(X)])
    expect(sameAssignments(current, [...current].reverse())).toBe(true)
    expect(sameAssignments(current, [include(A)])).toBe(false)
  })

  it("keeps a group's own filter when the added include has none", () => {
    const filtered = include(A, { deviceAndAppManagementAssignmentFilterId: F, deviceAndAppManagementAssignmentFilterType: "exclude" })
    expect(mergeAssignments([filtered], [include(A), include(B)])).toEqual([filtered, include(B)])
  })

  it("keeps an exclusion of a group the admin now includes, and reports it", () => {
    const merged = mergeAssignments([exclude(A)], [include(A)])
    expect(merged).toEqual([exclude(A), include(A)])
    expect(conflictingGroups(merged)).toEqual([A])
  })

  it("describes assignments in words", () => {
    expect(describeAssignment(include(A, { deviceAndAppManagementAssignmentFilterId: F, deviceAndAppManagementAssignmentFilterType: "include" }), { [A]: "Pilot" }, { [F]: "Corporate" })).toBe("Pilot, filter Corporate (include)")
    expect(describeAssignment(exclude(X))).toBe(`Excluded: ${X}`)
    expect(describeAssignment({ target: { "@odata.type": "#microsoft.graph.allLicensedUsersAssignmentTarget" } })).toBe("All users")
  })
})
