import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { POST as restorePreview } from "../src/portal/app/api/restore-preview/route"
import { AUTOPILOT_DEVICE_REIMPORT, autopilotDeviceChanges, autopilotDevicesCsv, autopilotDeviceUpdate } from "../src/shared/intune/autopilot-devices"
import { INTUNE_TYPES, typeForFolder, type Item } from "../src/shared/intune/registry"
import { listSnapshot, locateObject, readObject, type GraphReader } from "../src/shared/intune/read"
import { buildRestorePlan, buildUpdatePlan, NotRestorableError, restoreCapabilities } from "../src/shared/intune/restore-plan"
import { recoveryReadiness } from "../src/shared/intune/recovery"
import { sameSnapshot } from "../src/shared/intune/compare"
import { moduleForFolder } from "../src/shared/services/modules"
import { PROMOTION_FOLDERS } from "../src/main/features/promotion/engine"
import { Restorer, type GraphCall } from "../src/portal/lib/policies/graph-restore"

const type = typeForFolder("AutopilotDevices")!
const ID = "3c88cfd1-6e15-4080-b92a-8bcf0ccf0f72"
const NEW_ID = "83ddbcc1-2270-4cc6-8469-023af5d8b51f"

/** A device as the Autopilot list returns it: empty values as "", status fields and secrets included. */
const listed = (overrides: Item = {}): Item => ({
  id: ID,
  deploymentProfileAssignmentStatus: "assignedOutOfSync",
  deploymentProfileAssignedDateTime: "0001-01-01T00:00:00Z",
  groupTag: "Sales",
  purchaseOrderIdentifier: "",
  serialNumber: "1215-1407-0240",
  productKey: "1215-1407-0240",
  manufacturer: "Microsoft Corporation",
  model: "Virtual Machine",
  enrollmentState: "notContacted",
  lastContactedDateTime: "2025-08-26T06:53:38Z",
  addressableUserName: "",
  userPrincipalName: "",
  resourceName: "",
  skuNumber: "None",
  systemFamily: "Virtual Machine",
  azureActiveDirectoryDeviceId: "3ca8caac-d280-466b-a2d6-e482e7754437",
  azureAdDeviceId: "3ca8caac-d280-466b-a2d6-e482e7754437",
  managedDeviceId: "e81b1566-f49f-42df-bdc9-40c91a0eda25",
  displayName: "",
  deviceAccountUpn: "",
  deviceAccountPassword: "Surface Hub secret",
  deviceFriendlyName: null,
  remediationState: "noRemediationRequired",
  remediationStateLastModifiedDateTime: "2025-08-25T20:29:59Z",
  userlessEnrollmentStatus: "blocked",
  ...overrides,
})

/** The same device from the detail GET, which returns null where the list returns "". */
const detail = (overrides: Item = {}): Item => ({
  ...listed(overrides),
  "@odata.context": "https://graph.microsoft.com/beta/$metadata#deviceManagement/windowsAutopilotDeviceIdentities/$entity",
  purchaseOrderIdentifier: null,
  addressableUserName: null,
  userPrincipalName: null,
  resourceName: null,
  displayName: null,
  deviceAccountUpn: null,
  deviceAccountPassword: null,
  deploymentProfileAssignmentStatus: "assignedUnkownSyncState",
  lastContactedDateTime: "2025-08-26T06:53:38.3735404Z",
  ...overrides,
})

const reader = (get: (path: string) => Item, list: (path: string) => Item[] = () => []): GraphReader => ({ get: async (path) => get(path), list: async (path) => list(path) })

describe("Windows Autopilot devices backup", () => {
  it("is tenant inventory read from the list, in the Enrollment module, never synced", () => {
    expect(type).toMatchObject({ area: "Enrollment", path: "deviceManagement/windowsAutopilotDeviceIdentities", nameKey: "serialNumber", listOnly: true, inventory: true, locateBy: "serialNumber" })
    // Graph answers $select and $expand on this collection with a server error.
    expect(type.select).toBeUndefined()
    expect(type.expand).toBeUndefined()
    expect(moduleForFolder("AutopilotDevices")?.area.label).toBe("Enrollment and branding")
    expect(PROMOTION_FOLDERS).not.toContain("AutopilotDevices")
    expect(INTUNE_TYPES.filter((entry) => entry.inventory).map((entry) => entry.folder)).toEqual(["AutopilotDevices"])
  })

  it("keeps the registration details and leaves out status, contact times, the product key and secrets", () => {
    const snapshot = listSnapshot(type, listed())
    expect(Object.keys(snapshot)).toEqual(["id", ...type.keep!])
    for (const left of ["productKey", "deviceAccountPassword", "managedDeviceId", "azureAdDeviceId", "azureActiveDirectoryDeviceId", "lastContactedDateTime", "enrollmentState", "deploymentProfileAssignmentStatus", "remediationState", "userlessEnrollmentStatus"]) {
      expect(snapshot).not.toHaveProperty(left)
    }
    expect(snapshot).toMatchObject({ id: ID, serialNumber: "1215-1407-0240", groupTag: "Sales", deviceFriendlyName: "" })
  })

  it("stores a device read by ID the same as its list entry, so restore compares like with like", async () => {
    const read = await readObject(type, ID, reader(() => detail()))
    expect(read).toEqual(listSnapshot(type, listed()))
    expect(sameSnapshot(read, listSnapshot(type, listed()))).toBe(true)
  })

  it("never creates or copies a device: Graph does not return its hardware hash", () => {
    const snapshot = listSnapshot(type, listed())
    expect(() => buildRestorePlan(type, snapshot)).toThrow(NotRestorableError)
    expect(() => buildRestorePlan(type, snapshot)).toThrow(AUTOPILOT_DEVICE_REIMPORT)
    const capabilities = restoreCapabilities(type, snapshot)
    expect(capabilities.blocker).toBe(AUTOPILOT_DEVICE_REIMPORT)
    expect(capabilities.replaceBlocker).toBeUndefined()
  })

  it("points recovery at the hardware hash", () => {
    const readiness = recoveryReadiness(type, listSnapshot(type, listed()))
    expect(readiness.automatic).toBe(false)
    expect(readiness.manualActions).toEqual([AUTOPILOT_DEVICE_REIMPORT])
    expect(readiness.externalArtifacts[0]).toMatch(/hardware hash/)
  })
})

describe("Restoring Autopilot device properties", () => {
  const snapshot = (overrides: Item = {}) => listSnapshot(type, listed(overrides))

  it("writes nothing when the editable properties match", () => {
    expect(autopilotDeviceUpdate(snapshot(), snapshot())).toEqual([])
    // A difference Intune does not let admins edit is not written either.
    expect(autopilotDeviceUpdate(snapshot({ model: "Laptop 7" }), snapshot())).toEqual([])
  })

  it("sends only the group tag and device name that differ, and clears them with an empty value", () => {
    expect(autopilotDeviceUpdate(snapshot({ groupTag: "Sales", displayName: "" }), snapshot({ groupTag: "", displayName: "KIOSK-01" }))).toEqual([
      { method: "POST", path: "{collection}/{id}/updateDeviceProperties", body: { groupTag: "Sales", displayName: "" }, kind: "content" },
    ])
  })

  it("sets the user with its friendly name", () => {
    const steps = autopilotDeviceUpdate(snapshot({ userPrincipalName: "ana@contoso.com", addressableUserName: "Ana" }), snapshot({ userPrincipalName: "ben@contoso.com", addressableUserName: "Ben" }))
    expect(steps).toEqual([{ method: "POST", path: "{collection}/{id}/updateDeviceProperties", body: { userPrincipalName: "ana@contoso.com", addressableUserName: "Ana" }, kind: "content" }])
  })

  it("never sends an empty friendly name or a friendly name without a user, which Graph refuses", () => {
    // The backed-up user has no friendly name: only the user is sent, and the live friendly name stays.
    const kept = snapshot({ userPrincipalName: "ana@contoso.com" })
    const live = snapshot({ userPrincipalName: "ben@contoso.com", addressableUserName: "Ben" })
    expect(autopilotDeviceUpdate(kept, live)).toEqual([{ method: "POST", path: "{collection}/{id}/updateDeviceProperties", body: { userPrincipalName: "ana@contoso.com" }, kind: "content" }])
    expect(autopilotDeviceChanges(kept, live)).toEqual([
      { label: "Assigned user", from: "ben@contoso.com", to: "ana@contoso.com", restored: true },
      { label: "User friendly name", from: "Ben", to: "Not set", restored: false },
    ])
    // A friendly name without a user cannot be written, so nothing is sent for it.
    const orphan = snapshot({ addressableUserName: "Ana" })
    expect(autopilotDeviceUpdate(orphan, snapshot())).toEqual([])
    expect(autopilotDeviceChanges(orphan, snapshot())).toEqual([{ label: "User friendly name", from: "Not set", to: "Ana", restored: false }])
    // Only the friendly name differs while the user matches: the user is sent again with it.
    expect(autopilotDeviceUpdate(snapshot({ userPrincipalName: "ana@contoso.com", addressableUserName: "Ana" }), snapshot({ userPrincipalName: "ana@contoso.com", addressableUserName: "A" })))
      .toEqual([{ method: "POST", path: "{collection}/{id}/updateDeviceProperties", body: { userPrincipalName: "ana@contoso.com", addressableUserName: "Ana" }, kind: "content" }])
  })

  it("unassigns the user when the backup has none, because Graph refuses an empty user", () => {
    const steps = autopilotDeviceUpdate(snapshot({ groupTag: "Sales" }), snapshot({ groupTag: "Old", userPrincipalName: "ben@contoso.com", addressableUserName: "Ben" }))
    expect(steps).toEqual([
      { method: "POST", path: "{collection}/{id}/updateDeviceProperties", body: { groupTag: "Sales" }, kind: "content" },
      { method: "POST", path: "{collection}/{id}/unassignUserFromDevice", body: {}, kind: "content" },
    ])
  })

  it("resolves the device path and reviews only the editable properties", () => {
    const current = snapshot({ groupTag: "Old", model: "Laptop 7" })
    const plan = buildUpdatePlan(type, snapshot(), ID, { current })
    expect(plan.map((step) => step.path)).toEqual([`deviceManagement/windowsAutopilotDeviceIdentities/${ID}/updateDeviceProperties`])
    expect(autopilotDeviceChanges(snapshot(), current)).toEqual([{ label: "Group tag", from: "Old", to: "Sales", restored: true }])
    // Restore assignments does not apply to devices and adds no step.
    expect(buildUpdatePlan(type, snapshot(), ID, { current, includeAssignments: true })).toHaveLength(1)
  })
})

describe("Finding a device imported again", () => {
  it("matches the serial number exactly, since contains() also matches longer serials", async () => {
    const paths: string[] = []
    const found = await locateObject(type, listSnapshot(type, listed()), reader(() => ({}), (path) => {
      paths.push(path)
      return [listed({ id: "other", serialNumber: "1215-1407-0240-9" }), listed({ id: NEW_ID })]
    }))
    expect(paths).toEqual([`deviceManagement/windowsAutopilotDeviceIdentities?$filter=${encodeURIComponent("contains(serialNumber,'1215-1407-0240')")}`])
    expect(found).toEqual(listSnapshot(type, listed({ id: NEW_ID })))
  })

  it("finds nothing for an ambiguous or empty serial, and escapes quotes", async () => {
    const twice = reader(() => ({}), () => [listed({ id: "a" }), listed({ id: "b" })])
    expect(await locateObject(type, listSnapshot(type, listed()), twice)).toBeUndefined()
    expect(await locateObject(type, listSnapshot(type, listed({ serialNumber: "" })), twice)).toBeUndefined()
    const paths: string[] = []
    await locateObject(type, listSnapshot(type, listed({ serialNumber: "O'Brien" })), reader(() => ({}), (path) => (paths.push(path), [])))
    expect(decodeURIComponent(paths[0]!)).toContain("contains(serialNumber,'O''Brien')")
  })

  it("reviews a device imported again under a new ID as matching when its properties match", async () => {
    const backupId = "backup-2026-11-09-020000"
    const path = `${backupId}/AutopilotDevices/1215-1407-0240.json`
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "token" })
      if (url.hostname === "graph.microsoft.com") {
        if (url.pathname.endsWith(ID)) return Response.json({ error: { code: "ResourceNotFound" } }, { status: 404 })
        return Response.json({ value: [listed({ id: NEW_ID })] })
      }
      if (decodeURIComponent(url.pathname) === `/intune-backups/${path}`) return Response.json(listSnapshot(type, listed()))
      if (decodeURIComponent(url.pathname) === `/intune-backups/${backupId}/metadata.json`) return Response.json({ TenantId: "tenant", Status: "Success" })
      return new Response("", { status: 404 })
    }))
    try {
      const body = { tenantId: "tenant", appId: "app", clientSecret: "test", storageAccountName: "store", backupId, paths: [path], live: true }
      const response = await restorePreview(new NextRequest("http://tenuvault.internal/api/restore-preview", { method: "POST", body: JSON.stringify(body) }))
      expect(response.status).toBe(200)
      const { items } = await response.json()
      expect(items[0]).toMatchObject({ live: "same" })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("restores the group tag on the device under its new ID, in place", async () => {
    const calls: Array<{ method: string; path: string; body?: Item }> = []
    const graph: GraphCall = async (method, path, body): ReturnType<GraphCall> => {
      calls.push({ method, path, body })
      if (method === "GET" && path.includes(ID)) return { status: 404, body: { error: { code: "ResourceNotFound" } } }
      if (method === "GET" && path.includes("$filter")) return { status: 200, body: { value: [listed({ id: NEW_ID, groupTag: "" })] } }
      return { status: 204, body: {} }
    }
    const outcome = await new Restorer(graph, { mode: "replace", assignments: false }).restore("b/AutopilotDevices/1215-1407-0240.json", listSnapshot(type, listed()))
    expect(outcome).toMatchObject({ success: true, action: "updated", policyId: NEW_ID })
    expect(outcome.warnings).toContain("Intune applies Autopilot device changes within a few minutes.")
    const writes = calls.filter((call) => call.method === "POST")
    expect(writes).toEqual([{ method: "POST", path: `deviceManagement/windowsAutopilotDeviceIdentities/${NEW_ID}/updateDeviceProperties`, body: { groupTag: "Sales" } }])
  })

  it("reports a device that is gone without writing, and never copies one to another tenant", async () => {
    const calls: string[] = []
    const graph: GraphCall = async (method, path): ReturnType<GraphCall> => {
      calls.push(`${method} ${path}`)
      if (method === "GET" && path.includes("$filter")) return { status: 200, body: { value: [] } }
      return { status: 404, body: {} }
    }
    const missing = await new Restorer(graph, { mode: "replace", assignments: false }).restore("b/AutopilotDevices/1215-1407-0240.json", listSnapshot(type, listed()))
    expect(missing).toMatchObject({ success: false, action: "skipped", error: AUTOPILOT_DEVICE_REIMPORT })
    const copy = await new Restorer(graph, { mode: "copy", assignments: false, crossTenant: true }).restore("b/AutopilotDevices/1215-1407-0240.json", listSnapshot(type, listed()))
    expect(copy).toMatchObject({ success: false, action: "skipped", error: AUTOPILOT_DEVICE_REIMPORT })
    expect(calls.filter((call) => !call.startsWith("GET"))).toEqual([])
  })

  it("reports a device whose editable properties already match as unchanged", async () => {
    const graph: GraphCall = async (method, path) => (method === "GET" && path.includes(ID) ? { status: 200, body: detail() } : { status: 500, body: {} })
    const outcome = await new Restorer(graph, { mode: "replace", assignments: false }).restore("b/AutopilotDevices/1215-1407-0240.json", listSnapshot(type, listed()))
    expect(outcome).toMatchObject({ success: true, action: "unchanged" })
  })
})

describe("Autopilot device CSV export", () => {
  it("lists one row per device by serial number, with formula injection neutralised", () => {
    const csv = autopilotDevicesCsv([
      listSnapshot(type, listed({ serialNumber: "SN-2", groupTag: "=HYPERLINK(\"x\")" })),
      listSnapshot(type, listed({ serialNumber: "SN-1", userPrincipalName: "ana@contoso.com", addressableUserName: "Ana, Sales" })),
    ])
    expect(csv.split("\r\n")).toEqual([
      "Serial number,Manufacturer,Model,Group tag,Purchase order,Assigned user,User friendly name,Device name",
      "SN-1,Microsoft Corporation,Virtual Machine,Sales,,ana@contoso.com,\"Ana, Sales\",",
      "SN-2,Microsoft Corporation,Virtual Machine,\"'=HYPERLINK(\"\"x\"\")\",,,,",
      "",
    ])
  })
})
