import { describe, expect, it } from "vitest"
import { readCurrentAssignments } from "../src/main/oib/assignments"
import type { GraphCall } from "../src/portal/lib/policies/graph-restore"
import { typeForFolder, type Item } from "../src/shared/intune/registry"

const ID = "11111111-2222-4333-8444-555555555555"
const target = (groupId: string) => ({ target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId } })

function graph(answers: Record<string, { status?: number; body: Item }>) {
  const calls: string[] = []
  const call: GraphCall = async (method, path) => {
    calls.push(`${method} ${path}`)
    const answer = answers[path]
    if (!answer) throw new Error(`Unexpected ${path}`)
    return { status: answer.status ?? 200, body: answer.body }
  }
  return { call, calls }
}

describe("reading only a policy's assignments", () => {
  it("reads a Settings Catalog policy's name, then every page of its assignments", async () => {
    const type = typeForFolder("ConfigurationPolicies")!
    const { call, calls } = graph({
      [`deviceManagement/configurationPolicies/${ID}?$select=id,name`]: { body: { id: ID, name: "Win - OIB - SC - Test" } },
      [`deviceManagement/configurationPolicies/${ID}/assignments`]: { body: { value: [target("a")], "@odata.nextLink": `https://graph.microsoft.com/beta/deviceManagement/configurationPolicies/${ID}/assignments?$skiptoken=2` } },
      [`deviceManagement/configurationPolicies/${ID}/assignments?$skiptoken=2`]: { body: { value: [target("b")] } },
    })
    expect(await readCurrentAssignments(call, type, ID)).toEqual({ name: "Win - OIB - SC - Test", assignments: [target("a"), target("b")] })
    // Nothing but the name and the assignments: no settings or definition values are read.
    expect(calls).toHaveLength(3)
  })

  it("expands the assignments of other types in one read, and reports a deleted policy", async () => {
    const type = typeForFolder("GroupPolicyConfigurations")!
    const { call, calls } = graph({ [`deviceManagement/groupPolicyConfigurations/${ID}?$select=id,displayName&$expand=assignments`]: { body: { id: ID, displayName: "Admin template", assignments: [target("a")] } } })
    expect(await readCurrentAssignments(call, type, ID)).toEqual({ name: "Admin template", assignments: [target("a")] })
    expect(calls).toEqual([`GET deviceManagement/groupPolicyConfigurations/${ID}?$select=id,displayName&$expand=assignments`])
    const missing = graph({ [`deviceManagement/groupPolicyConfigurations/${ID}?$select=id,displayName&$expand=assignments`]: { status: 404, body: { error: { code: "ResourceNotFound" } } } })
    expect(await readCurrentAssignments(missing.call, type, ID)).toBeUndefined()
  })

  it("fails instead of returning a partial list", async () => {
    const type = typeForFolder("ConfigurationPolicies")!
    const { call } = graph({
      [`deviceManagement/configurationPolicies/${ID}?$select=id,name`]: { body: { id: ID, name: "x" } },
      [`deviceManagement/configurationPolicies/${ID}/assignments`]: { status: 503, body: { error: { message: "busy" } } },
    })
    await expect(readCurrentAssignments(call, type, ID)).rejects.toThrow("could not be read (503)")
  })
})
