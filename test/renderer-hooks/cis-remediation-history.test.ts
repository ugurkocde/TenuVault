import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CisRemediationHistory } from "../../src/renderer/features/cis-remediation/CisRemediationHistory"
import type { Tenant } from "../../src/portal/contexts/TenantContext"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TENANT_ID = "11111111-1111-1111-1111-111111111111"
const tenant = { id: "local", name: "Synthetic tenant", credentials: { tenantId: TENANT_ID, appId: "22222222-2222-2222-2222-222222222222" } } as unknown as Tenant
const OLDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const NEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const deployment = (id: string, title: string, createdAt: string, extra: object = {}) => ({
  id, title, createdAt, updatedAt: createdAt, status: "applied", summary: "Applied.", tenantId: TENANT_ID, reference: "synthetic-os 9.9.9 Level 1", runId: "run-1",
  items: [{ policyIndex: 0, policyName: "Synthetic", action: "update", targetId: "t1", targetName: "Tenant", findingKeys: ["0:0"], assignedExposure: false, assignmentCount: 0 }, { policyIndex: 1, policyName: "Other", action: "create", targetId: null, targetName: null, findingKeys: ["1:0"], assignedExposure: false, assignmentCount: 0 }],
  changeSetId: `cs-${id}`, rollbackChangeSetId: null, ...extra,
})
const changeSet = (id: string, title: string, kind: "change" | "rollback") => ({
  id, tenantId: TENANT_ID, createdAt: "2026-10-15T10:00:00Z", updatedAt: "2026-10-15T10:00:00Z", title, kind, ticket: null, status: "applied", sourceVersion: "synthetic-os 9.9.9 Level 1",
  origin: { workflow: "cis-remediation", recordId: "r" }, contentHash: "0".repeat(64), lastError: null, review: null, results: {},
  operations: [{ key: "op-1", folder: "ConfigurationPolicies", action: "update", targetId: "t1", name: "Tenant", setsAssignments: false, diff: [], diffTruncated: false, source: { label: "Synthetic" } }],
  preChange: { backupFolder: "synthetic", capturedAt: "2026-10-15T10:00:00Z", objects: [] }, history: [],
})

const roots: Root[] = []
const containers: HTMLDivElement[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  vi.unstubAllGlobals()
})

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function stubRoutes(handler: (action: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ action: string; body: Record<string, unknown> }> = []
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>
    expect(path).toBe("/api/cis-remediation")
    calls.push({ action: String(body.action), body })
    return new Response(JSON.stringify(handler(String(body.action), body)), { status: 200, headers: { "Content-Type": "application/json" } })
  }))
  return calls
}

function render(focus: { id: string; at: number } | null = null) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(CisRemediationHistory, { tenant, focus })))
  return { container, rerender: (next: { id: string; at: number } | null) => act(() => root.render(createElement(CisRemediationHistory, { tenant, focus: next }))) }
}

describe("CIS remediation history", () => {
  it("lists deployments newest first and opens the deployment and its rollback change sets", async () => {
    const calls = stubRoutes((action, body) => {
      if (action === "list") return { deployments: [deployment(NEWER, "Remediate benchmark findings", "2026-10-15T11:00:00Z", { rollbackChangeSetId: "rb" }), deployment(OLDER, "Deploy benchmark policies", "2026-10-14T09:00:00Z")] }
      if (action === "get") return { deployment: deployment(String(body.id), "Remediate benchmark findings", "2026-10-15T11:00:00Z", { rollbackChangeSetId: "rb" }), changeSet: changeSet("cs", "Remediate benchmark findings", "change"), rollbackChangeSet: changeSet("rb", "Rollback of Remediate benchmark findings", "rollback") }
      throw new Error(`unexpected ${action}`)
    })
    const { container } = render()
    await flush()
    const rows = [...container.querySelectorAll("li > button[aria-expanded]")]
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Remediate benchmark findings"),
      expect.stringContaining("Deploy benchmark policies"),
    ])
    expect(rows[0]!.textContent).toContain("2 operations")
    expect(rows[0]!.textContent).toContain("rollback created")
    expect(rows[0]!.textContent).toContain("applied")
    expect(rows[0]!.textContent).toContain("synthetic-os 9.9.9 Level 1")

    await act(async () => { (rows[0] as HTMLButtonElement).click() })
    await flush()
    expect(calls.find((call) => call.action === "get")?.body).toMatchObject({ id: NEWER, tenantId: TENANT_ID })
    expect(container.textContent).toContain("Preview rollback")
    expect(container.textContent).toContain("Rollback of Remediate benchmark findings")
  })

  it("opens a just planned deployment and reloads the list", async () => {
    let listed = 0
    const calls = stubRoutes((action, body) => {
      if (action === "list") return { deployments: listed++ ? [deployment(NEWER, "Remediate benchmark findings", "2026-10-15T11:00:00Z")] : [] }
      return { deployment: deployment(String(body.id), "Remediate benchmark findings", "2026-10-15T11:00:00Z"), changeSet: changeSet("cs", "Remediate benchmark findings", "change"), rollbackChangeSet: null }
    })
    const view = render()
    await flush()
    expect(view.container.textContent).toContain("No benchmark deployments yet")
    view.rerender({ id: NEWER, at: 1 })
    await flush()
    expect(calls.filter((call) => call.action === "list")).toHaveLength(2)
    expect(view.container.querySelector("li > button")?.getAttribute("aria-expanded")).toBe("true")
    expect(view.container.textContent).toContain("Operations (1)")
  })
})
