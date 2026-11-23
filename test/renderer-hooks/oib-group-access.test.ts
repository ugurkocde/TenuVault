import { describe, expect, it, vi } from "vitest"
import { groupAccessMissing, groupRecheckResult } from "../../src/renderer/components/GroupAccess"
import { assignmentSummary, newAssignment, specFor, unknownGroups, type AssignmentTargets } from "../../src/renderer/components/oib/AssignmentEditor"
import { emptySpec } from "../../src/shared/oib/assignments"
import { OPTIONAL_PERMISSIONS } from "../../src/shared/services/optional-permissions"

vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: {} }))

const group = (id: string) => ({ id, name: id })
const devices = group("Pilot devices")
const users = group("Pilot users")
const excludedDevices = group("Kiosk devices")
const excludedUsers = group("Guest users")
const data = newAssignment({
  ...emptySpec(),
  deviceGroups: [devices],
  userGroups: [users],
  excludeDeviceGroups: [excludedDevices],
  excludeUserGroups: [excludedUsers],
  unmarked: "user",
})
const targets: AssignmentTargets = { device: 1, user: 0, unmarked: 0, filterPlatforms: [], unfiltered: {} }

describe("effective OIB assignment choices", () => {
  it("keeps the selected scopes, including the scope chosen for unmarked policies", () => {
    expect(specFor(data, targets)).toMatchObject({
      deviceGroups: [devices], excludeDeviceGroups: [excludedDevices], userGroups: [], excludeUserGroups: [],
    })
    expect(specFor(data, { ...targets, device: 0, unmarked: 2 })).toMatchObject({
      deviceGroups: [], excludeDeviceGroups: [], userGroups: [users], excludeUserGroups: [excludedUsers],
    })
  })

  it("drops exclusions without an included group of the same scope", () => {
    const withoutUsers = { ...data, spec: { ...data.spec, userGroups: [] } }
    expect(specFor(withoutUsers, { ...targets, user: 1 }).excludeUserGroups).toEqual([])
  })

  it("checks and summarizes only groups in the effective spec", () => {
    const missing = { ...data, missing: [users.id, excludedUsers.id, excludedDevices.id] }
    expect(unknownGroups(missing, targets)).toEqual([excludedDevices.id])
    expect(assignmentSummary(missing, targets)).toEqual([
      "1 device policy: Pilot devices",
      "Excluded device groups: Kiosk devices",
    ])
  })
})

describe("group read permission", () => {
  it.each([
    [false, false, true], [false, true, true], [false, null, true], [false, undefined, true],
    [true, false, true], [true, true, false], [true, null, false], [true, undefined, false],
    [null, false, true], [null, true, false], [null, null, false], [null, undefined, false],
  ] as const)("gates the editor when readable is %s and granted is %s", (readable, granted, missing) => {
    expect(groupAccessMissing(readable, granted)).toBe(missing)
  })

  const permission = OPTIONAL_PERMISSIONS.find(entry => entry.id === "groupRead")!
  const status = (granted: boolean | null) => ({ optional: [{ ...permission, granted, missing: [] }] })

  it("accepts a confirmed grant", () => {
    expect(groupRecheckResult(status(true))).toEqual({ granted: true, message: "" })
  })

  it("reports that consent is still missing", () => {
    expect(groupRecheckResult(status(false))).toEqual({
      granted: false,
      message: "Still not granted. Admin consent can take a few minutes to reach TenuVault. Try again shortly.",
    })
  })

  it.each([undefined, {}, status(null), { ...status(true), error: "Token refresh failed" }])("reports an inconclusive check for %j", (result) => {
    expect(groupRecheckResult(result)).toEqual({
      granted: null,
      message: "The permission could not be checked. Try again shortly.",
    })
  })
})
