import { describe, expect, it } from "vitest"
import { readCurrentAssignments } from "../src/main/oib/assignments"
import { graphCaller, type GraphCall } from "../src/portal/lib/policies/graph-restore"
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

  it("follows an expanded list onto its further pages", async () => {
    const type = typeForFolder("GroupPolicyConfigurations")!
    const { call } = graph({
      [`deviceManagement/groupPolicyConfigurations/${ID}?$select=id,displayName&$expand=assignments`]: { body: { id: ID, displayName: "Admin template", assignments: [target("a")], "assignments@odata.nextLink": `https://graph.microsoft.com/beta/deviceManagement/groupPolicyConfigurations/${ID}/assignments?$skiptoken=2` } },
      [`deviceManagement/groupPolicyConfigurations/${ID}/assignments?$skiptoken=2`]: { body: { value: [target("b")] } },
    })
    expect((await readCurrentAssignments(call, type, ID))!.assignments).toEqual([target("a"), target("b")])
  })

  it("sends a write marked noRetry once, even after a 401 or 429", async () => {
    for (const status of [401, 429]) {
      let sent = 0
      const fetcher = (async () => { sent++; return Response.json({ error: { message: "no" } }, { status, headers: { "retry-after": "0" } }) }) as unknown as typeof fetch
      const call = graphCaller("token", fetcher, { refreshToken: async () => "fresh", sleep: async () => undefined })
      expect((await call("POST", `deviceManagement/configurationPolicies/${ID}/assign`, { assignments: [] }, { noRetry: true })).status).toBe(status)
      expect(sent).toBe(1)
    }
  })

  it("fails instead of returning a partial list", async () => {
    const type = typeForFolder("ConfigurationPolicies")!
    const { call } = graph({
      [`deviceManagement/configurationPolicies/${ID}?$select=id,name`]: { body: { id: ID, name: "x" } },
      [`deviceManagement/configurationPolicies/${ID}/assignments`]: { status: 503, body: { error: { message: "busy" } } },
    })
    await expect(readCurrentAssignments(call, type, ID)).rejects.toThrow("could not be read (503)")
    // A missing assignment page is a failed read, never a deleted policy.
    const page = graph({
      [`deviceManagement/configurationPolicies/${ID}?$select=id,name`]: { body: { id: ID, name: "x" } },
      [`deviceManagement/configurationPolicies/${ID}/assignments`]: { status: 404, body: { error: { code: "ResourceNotFound" } } },
    })
    await expect(readCurrentAssignments(page.call, type, ID)).rejects.toThrow("could not be read (404)")
  })
})
