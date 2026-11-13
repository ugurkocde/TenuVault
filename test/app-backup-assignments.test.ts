import { describe, expect, it, vi } from "vitest"
import { assignmentDeviceId } from "../src/main/app-backup/assignment-device"
import { assignmentReader } from "../src/main/app-backup/assignment-graph"
import { checkAppAssignments, evaluateAssignments, type AssignmentFacts, type AssignmentObservation } from "../src/main/app-backup/assignments"
import { AppSourceService, type AppSourceHost } from "../src/main/app-sources/service"

const tenant = "11111111-1111-1111-1111-111111111111", app = "22222222-2222-2222-2222-222222222222", device = "33333333-3333-3333-3333-333333333333", group = "44444444-4444-4444-4444-444444444444", filter = "55555555-5555-5555-5555-555555555555"
const row = (overrides: Partial<AssignmentObservation> = {}): AssignmentObservation => ({ id: "assignment", intent: "required", type: "allDevicesAssignmentTarget", groupId: null, filterId: null, filterMode: "none", ...overrides })
const facts = (overrides: Partial<AssignmentFacts> = {}): AssignmentFacts => ({ deviceKnown: true, memberships: new Map(), groups: new Map([[group, { name: "Capture PCs", hidden: false }]]), filters: new Map([[filter, { name: "Windows pilot", rule: '(device.deviceName -eq "Pilot")' }]]), warnings: [], ...overrides })
const evaluate = (rows: AssignmentObservation[], value = facts()) => evaluateAssignments(app, rows, value)
const raw = (overrides: Record<string, unknown> = {}) => ({ id: "assignment", intent: "required", target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget", deviceAndAppManagementAssignmentFilterType: "none", ...overrides } })

describe("device assignment guidance", () => {
  it("recognizes All devices without claiming content authorization", () => {
    const result = evaluate([row()])
    expect(result.status).toBe("device-targeted")
    expect(result.assignments[0]?.match).toBe("included")
    expect(result.steps.join()).toContain("Intune still decides")
    expect(JSON.stringify(result)).not.toContain(device)
  })
  it("names the include and exclusion groups and respects exclusion precedence per intent", () => {
    const data = facts({ memberships: new Map([[group, "Capture PCs"]]) })
    const included = row({ type: "groupAssignmentTarget", groupId: group })
    expect(evaluate([included], data).status).toBe("device-targeted")
    const excluded = row({ id: "exclude", type: "exclusionGroupAssignmentTarget", groupId: group })
    const result = evaluate([included, excluded], data)
    expect(result.status).toBe("review")
    expect(result.steps.join()).toContain("exclusion for “Capture PCs”")
    expect(result.steps.join()).toContain("will not override")
    expect(evaluate([included, { ...excluded, intent: "available" }], data).status).toBe("device-targeted")
  })
  it("does not substitute the signed-in admin for the device user", () => {
    const result = evaluate([row({ type: "allLicensedUsersAssignmentTarget" })])
    expect(result.status).toBe("review")
    expect(result.summary).toContain("Only user targeting")
    expect(result.steps.join()).toContain("Existing user assignments can remain")
    expect(result.assignments[0]?.match).toBe("user")
  })
  it("gives actionable missing-assignment and membership guidance", () => {
    expect(evaluate([]).steps.join()).toContain("dedicated device group containing this PC")
    const result = evaluate([row({ type: "groupAssignmentTarget", groupId: group })])
    expect(result.summary).toBe("No device assignment was found for this PC.")
    expect(result.assignments[0]).toMatchObject({ target: "Capture PCs", match: "not-member" })
  })
  it.each(["include", "exclude", "unexpected"])("keeps a %s filter uncertain and shows the rule", filterMode => {
    const result = evaluate([row({ filterId: filter, filterMode })])
    expect(result.status).toBe("review")
    expect(result.assignments[0]).toMatchObject({ match: "unknown", filter: { name: "Windows pilot", rule: '(device.deviceName -eq "Pilot")' } })
    expect(result.steps.join()).toContain(filterMode === "include" ? "must match" : filterMode === "exclude" ? "must not match" : "unresolved filter")
  })
  it("does not let missing memberships, hidden exclusions or unsupported targets imply access", () => {
    const excluded = row({ id: "exclude", type: "exclusionGroupAssignmentTarget", groupId: group })
    expect(evaluate([row(), excluded], facts({ memberships: null })).status).toBe("review")
    expect(evaluate([row(), excluded], facts({ groups: new Map([[group, { name: "Hidden", hidden: true }]]) })).status).toBe("review")
    expect(evaluate([row(), row({ id: "unknown", type: "futureTarget" })]).status).toBe("review")
    expect(evaluate([row()], facts({ deviceKnown: false })).status).toBe("unavailable")
  })
  it("ignores a filter on a group the device is known not to belong to", () => {
    expect(evaluate([row(), row({ id: "other", type: "groupAssignmentTarget", groupId: group, filterId: filter, filterMode: "include" })]).status).toBe("device-targeted")
  })
  it("flags possible uninstall conflicts without predicting Intune's final intent", () => {
    const result = evaluate([row(), row({ id: "uninstall", intent: "uninstall" })])
    expect(result.summary).toContain("install and uninstall")
    expect(result.steps.join()).toContain("Uninstall assignment to “All devices”")
    expect(result.status).toBe("review")
  })
})

describe("local device identity", () => {
  const status = `AzureAdJoined : YES\n DeviceId : ${device}\n TenantId : ${tenant}\n`
  it("requires one tenant-bound joined-device identity", () => {
    expect(assignmentDeviceId(tenant, status)).toBe(device)
    for (const value of [status.replace("YES", "NO"), status + `TenantId : ${tenant}\n`, status.replace(tenant, app), status.replace(device, "bad"), ""]) expect(() => assignmentDeviceId(tenant, value)).toThrow()
  })
})

describe("read-only assignment metadata", () => {
  const path = `/beta/deviceAppManagement/mobileApps/${app}/assignments`
  it("follows assignment and transitive-group pages without trusting counts", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname === path) return Response.json(url.searchParams.has("$skiptoken") ? { value: [raw()] } : { value: [], "@odata.count": 0, "@odata.nextLink": `https://graph.microsoft.com${path}?$skiptoken=second` })
      throw new Error("unexpected URL")
    })
    const output = await checkAppAssignments(tenant, app, async () => "token", { platform: "win32", device: async () => device, fetch: fetcher as typeof fetch })
    expect(output.status).toBe("device-targeted")
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.every(call => String(call[0]).startsWith("https://graph.microsoft.com/beta/"))).toBe(true)
  })
  it("loads nested membership and names before evaluating group targeting", async () => {
    const memberPath = `/beta/devices(deviceId='${device}')/transitiveMemberOf`
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("error")
      const url = new URL(String(input))
      if (url.pathname === path) return Response.json({ value: [raw({ "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: group })] })
      if (url.pathname === `/beta/groups/${group}`) return Response.json({ id: group, displayName: "Pilot PCs", visibility: null })
      if (url.pathname === memberPath) return Response.json(url.searchParams.has("$skiptoken") ? { value: [{ id: group, displayName: null, "@odata.type": "#microsoft.graph.group" }] } : { value: [], "@odata.nextLink": `https://graph.microsoft.com${memberPath}?$skiptoken=second` })
      throw new Error("unexpected URL")
    })
    const output = await checkAppAssignments(tenant, app, async () => "token", { platform: "win32", device: async () => device, fetch: fetcher as typeof fetch })
    expect(output.status).toBe("device-targeted")
    expect(output.assignments[0]?.target).toBe("Pilot PCs")
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it.each(["https://evil.test/beta/deviceAppManagement/mobileApps", `https://graph.microsoft.com/beta/groups/${group}`, `https://graph.microsoft.com/v1.0/deviceAppManagement/mobileApps/${app}/assignments`, `https://graph.microsoft.com${path}#secret`])("refuses credential-bearing continuation to %s", async next => {
    const fetcher = vi.fn(async () => Response.json({ value: [], "@odata.nextLink": next }))
    await expect(assignmentReader("secret", fetcher).list(path, 500)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it("rejects repeated pages, malformed bodies, oversized metadata and excessive rows", async () => {
    for (const body of [{}, { value: [null] }, { value: [], "@odata.nextLink": 1 }, { value: [], "@odata.nextLink": `https://graph.microsoft.com${path}` }, { value: [{ id: "a" }, { id: "b" }] }]) {
      await expect(assignmentReader("token", vi.fn(async () => Response.json(body))).list(path, 1)).rejects.toThrow()
    }
    await expect(assignmentReader("token", vi.fn(async () => new Response(" ".repeat(2 * 1024 ** 2 + 1)))).get(path)).rejects.toThrow()
  })
  it("refuses a partial list after a later error and explains forbidden membership reads", async () => {
    const failed = vi.fn().mockResolvedValueOnce(Response.json({ value: [raw()], "@odata.nextLink": `https://graph.microsoft.com${path}?$skiptoken=more` })).mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
    const output = await checkAppAssignments(tenant, app, async () => "token", { platform: "win32", device: async () => device, fetch: failed })
    expect(output.status).toBe("unavailable"); expect(output.assignments).toEqual([]); expect(output.summary).toContain("403")
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).includes("/assignments?") ? Response.json({ value: [raw(), { ...raw({ "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: group }), id: "excluded" }] }) : new Response("forbidden", { status: 403 }))
    const denied = await checkAppAssignments(tenant, app, async () => "token", { platform: "win32", device: async () => device, fetch: fetcher as typeof fetch })
    expect(denied.status).toBe("review"); expect(denied.warnings.join()).toContain("Device.Read.All")
  })
  it("retains filter details and treats a malformed filter id as unknown", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).includes("/assignments?") ? Response.json({ value: [raw({ deviceAndAppManagementAssignmentFilterId: filter, deviceAndAppManagementAssignmentFilterType: "exclude" })] }) : Response.json({ id: filter, displayName: "Pilot filter", rule: "rule" }))
    const options = { platform: "win32", device: async () => device, fetch: fetcher as typeof fetch }
    expect((await checkAppAssignments(tenant, app, async () => "token", options)).assignments[0]?.filter).toMatchObject({ name: "Pilot filter", mode: "exclude", rule: "rule" })
    options.fetch = vi.fn(async () => Response.json({ value: [raw({ deviceAndAppManagementAssignmentFilterId: "malformed" })] }))
    expect((await checkAppAssignments(tenant, app, async () => "token", options)).status).toBe("review")
  })
  it("does no Graph or device work for unsupported platforms or malformed tenant/app ids", async () => {
    const token = vi.fn(async () => "token"), probe = vi.fn(async () => device), fetcher = vi.fn()
    expect((await checkAppAssignments(tenant, app, token, { platform: "darwin", device: probe, fetch: fetcher })).status).toBe("unsupported")
    await expect(checkAppAssignments("bad", app, token, { platform: "win32", device: probe, fetch: fetcher })).rejects.toThrow()
    expect(token).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
  it("deduplicates tenant/app checks and revalidates tenant access without using entitlements", async () => {
    let resolve!: (value: ReturnType<typeof evaluate>) => void
    const pending = new Promise<ReturnType<typeof evaluate>>(done => { resolve = done })
    let known = true
    const host = { knownTenant: (id: string) => id === tenant && known, assignments: vi.fn(() => pending) } as unknown as AppSourceHost
    const service = new AppSourceService(host)
    expect(() => service.assignments(device, app)).toThrow("configured")
    expect(() => service.assignments(tenant, "bad")).toThrow()
    const first = service.assignments(tenant, app), second = service.assignments(tenant, app)
    expect(first).toBe(second)
    await Promise.resolve(); expect(host.assignments).toHaveBeenCalledTimes(1)
    known = false; resolve(evaluate([row()]))
    await expect(first).rejects.toThrow("configured")
  })
})
