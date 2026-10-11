import { describe, expect, it } from "vitest"
import { cleanAssignment, INTUNE_TYPES, restoreOrder, typeForFolder, type Item } from "../src/shared/intune/registry"
import { buildRestorePlan, buildUpdatePlan, NotRestorableError } from "../src/shared/intune/restore-plan"
import { Restorer } from "../src/portal/lib/policies/graph-restore"

const type = (folder: string) => typeForFolder(folder)!

describe("Intune type registry", () => {
  it("has unique folders and Graph paths", () => {
    expect(new Set(INTUNE_TYPES.map((t) => t.folder.toLowerCase())).size).toBe(INTUNE_TYPES.length)
    expect(new Set(INTUNE_TYPES.map((t) => t.path)).size).toBe(INTUNE_TYPES.length)
    for (const t of INTUNE_TYPES) expect(t.path).toMatch(/^device(Management|AppManagement)\/[A-Za-z]+$/)
  })

  it("skips objects Intune provides itself", () => {
    expect(type("Remediations").skip?.({ isGlobalScript: true })).toBeTruthy()
    expect(type("Remediations").skip?.({ isGlobalScript: false })).toBeUndefined()
    expect(type("ScopeTags").skip?.({ isBuiltIn: true })).toBeTruthy()
    expect(type("RoleDefinitions").skip?.({ isBuiltIn: true })).toBeTruthy()
  })

  it("restores referenced objects first and policy sets last", () => {
    const order = restoreOrder(["b/PolicySets/p.json", "b/DeviceConfigurations/d.json", "b/AssignmentFilters/f.json", "b/ScopeTags/s.json"])
    expect(order).toEqual(["b/ScopeTags/s.json", "b/AssignmentFilters/f.json", "b/DeviceConfigurations/d.json", "b/PolicySets/p.json"])
  })

  it("does not let a __proto__ key in an assignment replace the copy's prototype", () => {
    const copy = cleanAssignment(JSON.parse('{"id":"a","__proto__":{"polluted":true},"target":{"groupId":"g"}}') as Item)
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
    expect((copy as { polluted?: unknown }).polluted).toBeUndefined()
    expect(JSON.stringify(copy)).toBe('{"target":{"groupId":"g"}}')
  })
})

describe("Restore plans", () => {
  const assignment = { id: "x_y", source: "direct", sourceId: "x", intent: "apply", target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "g1" } }

  it("strips server fields and annotations, keeps polymorphic types, and names copies", () => {
    const snapshot: Item = {
      "@odata.type": "#microsoft.graph.macOSCustomConfiguration",
      "@odata.context": "ctx",
      id: "old",
      version: 3,
      createdDateTime: "2024-01-01",
      displayName: "MDE",
      payload: "YWJj",
      "assignments@odata.context": "ctx",
      assignments: [assignment],
    }
    const plan = buildRestorePlan(type("DeviceConfigurations"), snapshot, { prefix: "[Restored]", includeAssignments: true })
    expect(plan.create).toEqual({
      method: "POST",
      path: "deviceManagement/deviceConfigurations",
      body: { "@odata.type": "#microsoft.graph.macOSCustomConfiguration", displayName: "[Restored] MDE", payload: "YWJj" },
    })
    expect(plan.assignments).toEqual([
      { method: "POST", path: "deviceManagement/deviceConfigurations/{id}/assign", body: { assignments: [{ intent: "apply", target: assignment.target }] }, kind: "assignments" },
    ])
    expect(snapshot.id).toBe("old")
  })

  it("sends encrypted OMA-URI values in plain text and refuses masked ones", () => {
    const setting = { "@odata.type": "#microsoft.graph.omaSettingString", omaUri: "./x", isEncrypted: true, secretReferenceValueId: "s1" }
    const plan = buildRestorePlan(type("DeviceConfigurations"), { displayName: "P", omaSettings: [{ ...setting, value: "<enabled/>" }] })
    expect(plan.create.body.omaSettings).toEqual([{ "@odata.type": "#microsoft.graph.omaSettingString", omaUri: "./x", value: "<enabled/>" }])
    expect(() => buildRestorePlan(type("DeviceConfigurations"), { displayName: "P", omaSettings: [{ ...setting, value: "****" }] })).toThrow(/masked/)
  })

  it("never restores exclusions on types where Graph would turn them into includes", () => {
    const exclusion = { target: { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: "g2" } }
    const esp = buildRestorePlan(type("EnrollmentConfigurations"), { displayName: "ESP", priority: 3, assignments: [assignment, exclusion] }, { includeAssignments: true })
    expect(esp.assignments[0]!.body).toEqual({ enrollmentConfigurationAssignments: [{ intent: "apply", target: assignment.target }] })
    expect(esp.steps).toEqual([{ method: "POST", path: "deviceManagement/deviceEnrollmentConfigurations/{id}/setPriority", body: { priority: 3 }, kind: "content" }])
    const terms = buildRestorePlan(type("TermsAndConditions"), { displayName: "T", assignments: [exclusion] }, { includeAssignments: true })
    expect(terms.assignments).toEqual([])
    expect(terms.create.body.version).toBe(1)
  })

  it("restores app categories and dependency links, and never copies assignments inherited from a policy set", () => {
    const plan = buildRestorePlan(type("Apps"), {
      "@odata.type": "#microsoft.graph.winGetApp",
      displayName: "Git",
      categories: [{ id: "c1", displayName: "Tools" }],
      relationships: [
        { "@odata.type": "#microsoft.graph.mobileAppDependency", id: "r1", targetId: "t1", targetType: "child", dependencyType: "autoInstall" },
        { "@odata.type": "#microsoft.graph.mobileAppSupersedence", id: "r2", targetId: "t2", targetType: "parent", supersedenceType: "update" },
      ],
      assignments: [assignment, { ...assignment, id: "ps", source: "policySets", sourceId: "set1" }],
    }, { includeAssignments: true })
    expect(plan.create.body).not.toHaveProperty("categories")
    expect(plan.steps).toEqual([
      { method: "POST", path: "deviceAppManagement/mobileApps/{id}/categories/$ref", body: { "@odata.id": "https://graph.microsoft.com/beta/deviceAppManagement/mobileAppCategories/c1" }, kind: "content" },
      { method: "POST", path: "deviceAppManagement/mobileApps/{id}/updateRelationships", body: { relationships: [{ "@odata.type": "#microsoft.graph.mobileAppDependency", targetId: "t1", dependencyType: "autoInstall" }] }, kind: "content" },
    ])
    expect((plan.assignments[0]!.body.mobileAppAssignments as unknown[]).length).toBe(1)
  })

  it("puts an app's categories and dependency links back when replacing in place", () => {
    const link = { "@odata.type": "#microsoft.graph.mobileAppDependency", targetId: "t1", targetType: "child", dependencyType: "autoInstall" }
    const snapshot = { "@odata.type": "#microsoft.graph.winGetApp", displayName: "Git", categories: [{ id: "c1" }], relationships: [link] }
    const steps = buildUpdatePlan(type("Apps"), snapshot, "a1", { current: { ...snapshot, categories: [{ id: "c2" }], relationships: [] } })
    expect(steps.map((step) => `${step.method} ${step.path}`)).toEqual([
      "PATCH deviceAppManagement/mobileApps/a1",
      "POST deviceAppManagement/mobileApps/a1/updateRelationships",
      "POST deviceAppManagement/mobileApps/a1/categories/$ref",
      "DELETE deviceAppManagement/mobileApps/a1/categories/c2/$ref",
    ])
    const unchanged = buildUpdatePlan(type("Apps"), snapshot, "a1", { current: snapshot })
    expect(unchanged.map((step) => step.method)).toEqual(["PATCH"])
  })

  it("assigns policy sets through their update action, also when replacing in place", () => {
    const snapshot = { displayName: "Set", items: [{ id: "i", "@odata.type": "#microsoft.graph.mobileAppPolicySetItem", payloadId: "app1", intent: "required", status: "x" }], assignments: [assignment] }
    const plan = buildRestorePlan(type("PolicySets"), snapshot, { includeAssignments: true })
    expect(plan.create.body.items).toEqual([{ "@odata.type": "#microsoft.graph.mobileAppPolicySetItem", payloadId: "app1", intent: "required" }])
    expect(plan.assignments).toEqual([{ method: "POST", path: "deviceAppManagement/policySets/{id}/update", body: { assignments: [{ intent: "apply", target: assignment.target }] }, kind: "assignments", replacesAll: true }])
    const update = buildUpdatePlan(type("PolicySets"), snapshot, "p1", { includeAssignments: true, current: { items: [{ id: "old-item", payloadId: "removed-app" }] } })
    expect(update.map((step) => `${step.method} ${step.path}`)).toEqual(["PATCH deviceAppManagement/policySets/p1", "POST deviceAppManagement/policySets/p1/update", "POST deviceAppManagement/policySets/p1/update"])
    expect(update[0]!.body).not.toHaveProperty("items")
    expect(update[1]!.body).toEqual({ addedPolicySetItems: [{ "@odata.type": "#microsoft.graph.mobileAppPolicySetItem", payloadId: "app1", intent: "required" }], deletedPolicySetItems: ["old-item"] })
  })

  it("leaves assignments out unless requested", () => {
    expect(buildRestorePlan(type("DeviceConfigurations"), { displayName: "A", assignments: [assignment] }).assignments).toEqual([])
  })

  it("uses each script type's own assignment body", () => {
    const keys = ["PowerShellScripts", "ShellScripts", "CustomAttributeScripts", "Remediations"].map((folder) => {
      const [step] = buildRestorePlan(type(folder), { displayName: "S", assignments: [assignment] }, { includeAssignments: true }).assignments
      return Object.keys(step!.body)[0]
    })
    expect(keys).toEqual(["deviceManagementScriptAssignments", "deviceManagementScriptAssignments", "deviceManagementScriptAssignments", "deviceHealthScriptAssignments"])
  })

  it("rebuilds administrative template values with binds to the same definitions", () => {
    const snapshot: Item = {
      displayName: "ADMX",
      definitionValues: [
        {
          id: "dv1",
          enabled: true,
          definition: { id: "def1" },
          presentationValues: [{ id: "pv1", "@odata.type": "#microsoft.graph.groupPolicyPresentationValueText", value: "x", presentation: { id: "pres1" } }],
        },
      ],
    }
    const plan = buildRestorePlan(type("GroupPolicyConfigurations"), snapshot)
    expect(plan.create.body).toEqual({ displayName: "ADMX" })
    expect(plan.steps).toEqual([
      {
        method: "POST",
        path: "deviceManagement/groupPolicyConfigurations/{id}/updateDefinitionValues",
        kind: "content",
        body: {
          added: [
            {
              enabled: true,
              "definition@odata.bind": "https://graph.microsoft.com/beta/deviceManagement/groupPolicyDefinitions('def1')",
              presentationValues: [
                {
                  "@odata.type": "#microsoft.graph.groupPolicyPresentationValueText",
                  value: "x",
                  "presentation@odata.bind": "https://graph.microsoft.com/beta/deviceManagement/groupPolicyDefinitions('def1')/presentations('pres1')",
                },
              ],
            },
          ],
          updated: [],
          deletedIds: [],
        },
      },
    ])
  })

  it("creates template based profiles from their template with the backed-up settings", () => {
    const plan = buildRestorePlan(type("EndpointSecurityIntents"), {
      id: "i1",
      displayName: "Baseline",
      templateId: "034ccd46-190c-4afc-adf1-ad7cc11262eb",
      roleScopeTagIds: ["0"],
      settings: [{ id: "s1", "@odata.type": "#microsoft.graph.deviceManagementBooleanSettingInstance", definitionId: "d1", valueJson: "true" }],
    })
    expect(plan.create).toEqual({
      method: "POST",
      path: "deviceManagement/templates/034ccd46-190c-4afc-adf1-ad7cc11262eb/createInstance",
      body: {
        displayName: "Baseline",
        description: null,
        roleScopeTagIds: ["0"],
        settingsDelta: [{ "@odata.type": "#microsoft.graph.deviceManagementBooleanSettingInstance", definitionId: "d1", valueJson: "true" }],
      },
    })
  })

  it("refuses apps that need an installer file and reference-only types", () => {
    expect(() => buildRestorePlan(type("Apps"), { "@odata.type": "#microsoft.graph.win32LobApp", displayName: "7-Zip" })).toThrow(NotRestorableError)
    expect(buildRestorePlan(type("Apps"), { "@odata.type": "#microsoft.graph.webApp", displayName: "Portal", appUrl: "https://example.com" }).create.body).toMatchObject({ appUrl: "https://example.com" })
    expect(() => buildRestorePlan(type("AppleAutomatedEnrollment"), { tokenName: "ADE" })).toThrow(/uploaded again/)
  })

  it("updates in place with PATCH and replaces assignments, including removing them all", () => {
    const steps = buildUpdatePlan(type("DeviceConfigurations"), { "@odata.type": "#microsoft.graph.windows10CustomConfiguration", displayName: "A", omaSettings: [], assignments: [] }, "abc", { includeAssignments: true })
    expect(steps).toEqual([
      { method: "PATCH", path: "deviceManagement/deviceConfigurations/abc", body: { "@odata.type": "#microsoft.graph.windows10CustomConfiguration", displayName: "A", omaSettings: [] }, kind: "content" },
      { method: "POST", path: "deviceManagement/deviceConfigurations/abc/assign", body: { assignments: [] }, kind: "assignments" },
    ])
  })
})

describe("Restorer", () => {
  type Call = { method: string; path: string; body?: Item }
  const fakeGraph = (responses: Record<string, { status: number; body: Item }>) => {
    const calls: Call[] = []
    let created = 0
    const graph = async (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: Item) => {
      calls.push({ method, path, ...(body ? { body } : {}) })
      const key = `${method} ${path}`
      if (responses[key]) return responses[key]!
      // Keep the existing empty-body fallback explicit in this mock response.
      // oxlint-disable-next-line unicorn/no-useless-fallback-in-spread
      if (method === "POST" && !/\/(assign|assignments)$/.test(path)) return { status: 201, body: { id: `new${++created}`, ...(body ?? {}) } }
      return { status: 204, body: {} }
    }
    return { graph, calls }
  }

  it("creates copies and points later snapshots at objects it recreated", async () => {
    const { graph, calls } = fakeGraph({})
    const restorer = new Restorer(graph, { mode: "copy", assignments: false })
    const old = "11111111-2222-3333-4444-555555555555"
    const filter = await restorer.restore("b/AssignmentFilters/f.json", { id: old, displayName: "Macs", rule: "x", platform: "macOS" })
    expect(filter).toMatchObject({ success: true, action: "created", policyId: "new1" })
    await restorer.restore("b/DeviceConfigurations/d.json", { id: "d", displayName: "Profile", filterId: old, bind: `filters('${old}')` })
    expect(calls[1]!.body).toMatchObject({ displayName: "[Restored] Profile", filterId: "new1", bind: "filters('new1')" })
  })

  it("refuses to replace a profile in place from a backup with a masked secret", async () => {
    const { graph, calls } = fakeGraph({ "GET deviceManagement/deviceConfigurations/p1?$expand=assignments": { status: 200, body: { id: "p1", displayName: "P", omaSettings: [] } } })
    const outcome = await new Restorer(graph, { mode: "replace", assignments: false }).restore("b/DeviceConfigurations/p.json", {
      id: "p1", displayName: "P", omaSettings: [{ omaUri: "./x", isEncrypted: true, value: "****" }],
    })
    expect(outcome).toMatchObject({ success: false })
    expect(outcome.error).toMatch(/masked/)
    expect(calls.map((c) => c.method)).toEqual(["GET"])
  })

  it("replaces notification messages by locale instead of adding duplicates", () => {
    const steps = buildUpdatePlan(type("NotificationTemplates"), {
      displayName: "N",
      localizedNotificationMessages: [{ id: "old", locale: "en-us", subject: "S", messageTemplate: "T", isDefault: true }],
    }, "n1", { current: { localizedNotificationMessages: [{ id: "m1", locale: "en-us" }, { id: "m2", locale: "de-de" }] } })
    expect(steps.map((step) => `${step.method} ${step.path}`)).toEqual([
      "PATCH deviceManagement/notificationMessageTemplates/n1",
      "PATCH deviceManagement/notificationMessageTemplates/n1/localizedNotificationMessages/m1",
      "DELETE deviceManagement/notificationMessageTemplates/n1/localizedNotificationMessages/m2",
    ])
  })

  it("remaps short IDs only where they are the whole value", async () => {
    const { graph, calls } = fakeGraph({ "POST deviceManagement/roleScopeTags": { status: 201, body: { id: "15" } } })
    const restorer = new Restorer(graph, { mode: "copy", assignments: false })
    await restorer.restore("b/ScopeTags/t.json", { id: "10", displayName: "Finance" })
    await restorer.restore("b/DeviceConfigurations/d.json", { id: "d", displayName: "P", roleScopeTagIds: ["0", "10"], passwordMinimumLength: 10, note: "retry 10 times" })
    expect(calls[1]!.body).toMatchObject({ roleScopeTagIds: ["0", "15"], passwordMinimumLength: 10, note: "retry 10 times" })
  })

  it("replaces an existing object in place and recreates a deleted one under its original name", async () => {
    const { graph, calls } = fakeGraph({
      "GET deviceManagement/deviceCategories/here": { status: 200, body: { id: "here", displayName: "Kiosk (renamed)" } },
      "GET deviceManagement/deviceCategories/gone": { status: 404, body: {} },
    })
    const restorer = new Restorer(graph, { mode: "replace", assignments: false })
    expect(await restorer.restore("b/DeviceCategories/a.json", { id: "here", displayName: "Kiosk" })).toMatchObject({ action: "updated", policyId: "here" })
    expect(await restorer.restore("b/DeviceCategories/b.json", { id: "gone", displayName: "Shared" })).toMatchObject({ action: "created" })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET deviceManagement/deviceCategories/here",
      "PATCH deviceManagement/deviceCategories/here",
      "GET deviceManagement/deviceCategories/gone",
      "POST deviceManagement/deviceCategories",
    ])
    expect(calls[3]!.body).toEqual({ displayName: "Shared" })
  })

  it("keeps a created object and reports partial failure when its assignments fail", async () => {
    const { graph } = fakeGraph({ "POST deviceManagement/deviceConfigurations/new1/assign": { status: 400, body: { error: { message: "Group not found" } } } })
    const restorer = new Restorer(graph, { mode: "copy", assignments: true })
    const outcome = await restorer.restore("b/DeviceConfigurations/d.json", { displayName: "P", assignments: [{ target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "deleted" } }] })
    expect(outcome).toMatchObject({ success: false, partial: true, policyId: "new1", repairToken: expect.any(String), warnings: ["Assignments could not be restored: Group not found"] })
  })

  it("reports items it cannot recreate as skipped with the reason", async () => {
    const { graph, calls } = fakeGraph({})
    const outcome = await new Restorer(graph, { mode: "copy", assignments: false }).restore("b/Apps/7zip.json", { "@odata.type": "#microsoft.graph.macOSPkgApp", displayName: "7zip" })
    expect(outcome).toMatchObject({ success: false, action: "skipped" })
    expect(outcome.error).toMatch(/installer/)
    expect(calls).toEqual([])
  })

  it("unwraps Intune's JSON error messages", async () => {
    const message = JSON.stringify({ _version: 3, Message: "Invalid setting value - Operation ID (for customer support): 1" })
    const { graph } = fakeGraph({ "POST deviceManagement/deviceConfigurations": { status: 400, body: { error: { message } } } })
    const outcome = await new Restorer(graph, { mode: "copy", assignments: false }).restore("b/DeviceConfigurations/d.json", { displayName: "P" })
    expect(outcome).toMatchObject({ success: false, error: "Invalid setting value" })
  })
})
