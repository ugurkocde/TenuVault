import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, createElement, useState } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import { groupAccessMissing, groupRecheckResult } from "../../src/renderer/components/GroupAccess"
import { AssignmentEditor, assignmentPickerBlockers, assignmentSummary, newAssignment, specFor, unknownGroups, type AssignmentTargets } from "../../src/renderer/components/oib/AssignmentEditor"
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

  it("uses only active scopes to block picks, including exclusions picked before an inclusion", () => {
    const unmarked = { ...targets, device: 0, unmarked: 1 }
    const spec = { ...data.spec, userGroups: [] }
    expect(assignmentPickerBlockers(spec, unmarked)).toEqual({ inclusions: [], exclusions: [excludedUsers] })
    expect(assignmentPickerBlockers({ ...spec, unmarked: "device" }, unmarked)).toEqual({
      inclusions: [devices], exclusions: [excludedDevices],
    })
    expect(assignmentPickerBlockers({ ...spec, unmarked: "both" }, unmarked)).toEqual({
      inclusions: [devices], exclusions: [excludedDevices, excludedUsers],
    })
  })

  it("lets admins remove saved picks after their scope becomes inactive", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ readable: true, groups: [], missing: [], counts: {} })))
    const node = document.createElement("div")
    document.body.append(node)
    const root = createRoot(node)
    const client = new QueryClient()
    const tenant = { tenantId: "tenant", appId: "app", name: "Tenant" }
    function Editor() {
      const [current, update] = useState(data)
      return createElement(AssignmentEditor, {
        state: { tenant, data: current, update },
        targets: { ...targets, device: 0, unmarked: 1 },
        accessMissing: false,
        accessContext: "test",
      })
    }
    try {
      await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(Editor))))
      expect(node.querySelector('input[aria-label="Excluded user groups"]')).toBeTruthy()
      const select = node.querySelector("select")!
      await act(async () => {
        select.value = "device"
        select.dispatchEvent(new Event("change", { bubbles: true }))
      })
      expect(node.querySelector('input[aria-label="Excluded user groups"]')).toBeNull()
      const remove = node.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${excludedUsers.name}"]`)!
      expect(remove.disabled).toBe(false)
      await act(async () => remove.click())
      expect(node.textContent).not.toContain(excludedUsers.name)
    } finally {
      await act(async () => root.unmount())
      client.clear()
      node.remove()
      vi.unstubAllGlobals()
    }
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
