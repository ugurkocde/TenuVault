import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GraphCall } from "../src/portal/lib/policies/graph-restore"
import { withTenantWrite, TenantWriteConflict, tenantWriteLabel } from "../src/main/features/write-lock"
import { handleOib, setOibStore } from "../src/main/oib/service"
import { handleFramework } from "../src/main/frameworks/service"
import { setFrameworkStore } from "../src/main/frameworks/workspaces"
import { applyChangeSet, approveChangeSet, createChangeSet, getChangeSet, previewChangeSet } from "../src/main/features/change-sets/engine"
import { featureRoute } from "../src/main/features/route"
import { POST as oibRoute } from "../src/portal/app/api/oib/route"
import { POST as frameworkRoute } from "../src/portal/app/api/frameworks/route"
import { apiBody } from "../src/main/features/deps"
import { INTUNE_TYPES, type Item } from "../src/shared/intune/registry"
import type { OibRun } from "../src/shared/oib/types"
import type { Assessment } from "../src/shared/frameworks/policies"
import { COMPLETE_BACKUP_METADATA, FakeTenant, setting, wire } from "./feature-change-sets-fakes"
import { call, fakeDeps, TENANT_A, TENANT_B } from "./feature-helpers"
import { memoryStore } from "./helpers"

const SOURCE = "WINDOWS/IntuneManagement/SettingsCatalog/Test.json"
const COMMIT = "a".repeat(40)
const POLICY = { name: "Write lock baseline", description: "", platforms: "windows10", technologies: "mdm", settings: [setting("test_setting", "test_setting_1")] }

// Every pack, token, backup and Graph response comes from a local fixture.
vi.mock("../src/main/oib/source", () => ({
  loadPack: async () => ({
    catalog: { reference: "Write lock fixture", commit: COMMIT, policies: [] },
    items: new Map([[SOURCE, { source: SOURCE, folder: "ConfigurationPolicies", name: POLICY.name, snapshot: structuredClone(POLICY) }]]),
  }),
}))

function gate() {
  let release!: () => void
  let enter!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { enter = resolve })
  return { release, started, wait: async () => { enter(); await held } }
}

const labels = {
  deploy: "OpenIntuneBaseline deployment",
  fix: "OpenIntuneBaseline drift fix",
  undo: "OpenIntuneBaseline undo",
  changeSet: "Change set apply",
  framework: "Framework policy creation",
}
type Pipeline = keyof typeof labels
const pipelines = Object.keys(labels) as Pipeline[]
const conflict = (label: string) => `Another change is being applied to this tenant: ${label}. Try again when it finishes.`

function setup() {
  const store = memoryStore()
  setOibStore(store)
  setFrameworkStore(store)
  const deps = fakeDeps({ plans: { [TENANT_A]: "pro", [TENANT_B]: "pro" } })
  const tenants = [new FakeTenant(TENANT_A), new FakeTenant(TENANT_B)]
  for (const tenant of tenants) tenant.addPolicy({ ...structuredClone(POLICY), name: "Existing fixture", settings: [setting("test_setting", "test_setting_0")] })
  const { backups } = wire(deps, tenants)
  const requests: Array<{ path: string; tenantId: string; body: Record<string, unknown> }> = []
  const api = deps.api
  deps.api = async (path, tenantId, body = {}) => {
    requests.push({ path, tenantId, body: structuredClone(body) })
    return api(path, tenantId, body)
  }
  let hold: (() => Promise<void>) | undefined
  const graph = (tenantId: string, journaled: boolean): GraphCall => {
    const tenant = tenants.find((entry) => entry.tenantId === tenantId)!
    const inner = tenant.graph(journaled)
    return async (method, path, body) => {
      if (method !== "GET" && tenantId === TENANT_A) await hold?.()
      if (method === "GET" && path.endsWith("/settings")) {
        return { status: 200, body: { value: tenant.policies.get(path.split("/")[2]!)?.settings ?? [] } }
      }
      return inner(method, path, body)
    }
  }
  deps.graph = async (tenantId, options) => graph(tenantId, options?.journal === true)
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: url.pathname.split("/")[1] })
    const body = init?.body ? JSON.parse(String(init.body)) as Item : {}
    if (url.hostname === "tenuvault.internal") return deps.api(url.pathname, String(body.tenantId ?? TENANT_A), body)
    if (url.hostname !== "graph.microsoft.com") throw new Error(`Unexpected fixture request: ${url.hostname}`)
    const tenantId = new Headers(init?.headers).get("Authorization")!.slice("Bearer ".length)
    const response = await graph(tenantId, false)((init?.method ?? "GET") as Parameters<GraphCall>[0], url.pathname.slice("/beta/".length) + url.search, body)
    return response.status === 204 ? new Response(null, { status: 204 }) : Response.json(response.body, { status: response.status })
  }))
  return { deps, tenants, store, backups, requests, hold: (wait: () => Promise<void>) => { hold = wait } }
}

async function prepare(context: ReturnType<typeof setup>, kind: Pipeline, tenantId = TENANT_A) {
  const profile = context.deps.tenant(tenantId)!
  const credentials = { tenantId, appId: profile.clientId, storageAccountName: profile.storageAccountName }
  if (kind === "deploy") return () => handleOib({ ...credentials, action: "oib-deploy", platform: "windows", commit: COMMIT, items: [{ source: SOURCE, mode: "create" }] })
  if (kind === "fix") {
    const existing = [...context.tenants.find((tenant) => tenant.tenantId === tenantId)!.policies.values()][0]!
    return () => handleOib({ ...credentials, action: "oib-fix", platform: "windows", commit: COMMIT, items: [{ source: SOURCE, mode: "update", targetId: existing.id as string }] })
  }
  if (kind === "undo") {
    const existing = [...context.tenants.find((tenant) => tenant.tenantId === tenantId)!.policies.values()][0]!
    const run: OibRun = { runId: `undo-${existing.id}`, tenantId, createdAt: "2026-09-30T12:00:00Z", kind: "deploy", platform: "windows", reference: "Undo fixture", created: [{ folder: "ConfigurationPolicies", name: "Undo fixture", id: existing.id as string }], updated: [], failed: [] }
    const runs = JSON.parse(context.store.get(`oib:runs:${tenantId}`) ?? "[]") as OibRun[]
    context.store.set(`oib:runs:${tenantId}`, JSON.stringify([...runs, run]))
    return () => handleOib({ ...credentials, action: "oib-undo", runId: run.runId })
  }
  if (kind === "framework") {
    const run = await handleFramework({ ...credentials, action: "assess", frameworkId: "custom", reference: "Framework fixture", policies: [{ ...structuredClone(POLICY), settings: [setting("framework_setting", "framework_setting_1")] }] }) as Assessment
    return () => handleFramework({ ...credentials, action: "create", runId: run.runId, keys: ["0:0"], confirmUnassigned: true })
  }
  const record = await createChangeSet(context.deps, tenantId, { title: "Change set fixture", operations: [{ folder: "ConfigurationPolicies", action: "create", proposed: { ...structuredClone(POLICY), name: "Change set fixture" } }] }, "Admin")
  const preview = await previewChangeSet(context.deps, tenantId, record.id)
  await approveChangeSet(context.deps, tenantId, record.id, preview, "Admin")
  return () => applyChangeSet(context.deps, tenantId, record.id, { contentHash: record.contentHash, confirmed: true }, "Admin")
}

beforeEach(() => { setOibStore(null) })
afterEach(() => { vi.unstubAllGlobals(); setOibStore(null); setFrameworkStore(memoryStore()) })

describe("shared tenant write ownership", () => {
  it.each(pipelines.flatMap((first) => pipelines.map((second) => [first, second] as const)))("refuses %s followed by %s on one tenant", async (first, second) => {
    const context = setup()
    const startFirst = await prepare(context, first)
    const startSecond = await prepare(context, second)
    const held = gate()
    context.hold(held.wait)
    const running = startFirst()
    try {
      await held.started
      const backupCount = context.backups.length
      await expect(startSecond()).rejects.toMatchObject({ status: 409, message: conflict(labels[first]) })
      expect(context.backups).toHaveLength(backupCount)
      expect(context.tenants[0]!.writeCount()).toBe(0)
      expect(tenantWriteLabel(TENANT_A)).toBe(labels[first])
    } finally {
      held.release()
      await running
    }
    expect(tenantWriteLabel(TENANT_A)).toBeUndefined()
  })

  it.each(pipelines)("allows another tenant to finish while %s is still running", async (first) => {
    const context = setup()
    const startFirst = await prepare(context, first)
    const startSecond = await prepare(context, first, TENANT_B)
    const held = gate()
    context.hold(held.wait)
    const running = startFirst()
    try {
      await held.started
      await startSecond()
      expect(context.tenants[1]!.writeCount()).toBeGreaterThan(0)
      expect(context.tenants[0]!.writeCount()).toBe(0)
      expect(tenantWriteLabel(TENANT_A)).toBe(labels[first])
    } finally {
      held.release()
      await running
    }
  })

  it.each(["deploy", "fix", "changeSet"] as const)("holds ownership through the %s pre-change backup", async (first) => {
    const context = setup()
    const startFirst = await prepare(context, first)
    const second = await prepare(context, "changeSet")
    const held = gate()
    const api = context.deps.api
    context.deps.api = async (path, tenantId, body) => {
      if (path === "/api/backup/status") await held.wait()
      return api(path, tenantId, body)
    }
    const running = startFirst()
    try {
      await held.started
      await expect(second()).rejects.toThrow(conflict(labels[first]))
      expect(context.tenants[0]!.writeCount()).toBe(0)
    } finally {
      held.release()
      await running
    }
  })

  it("normalizes tenant case and releases ownership after synchronous and asynchronous failures", async () => {
    const tenant = "abcdefab-abcd-abcd-abcd-abcdefabcdef"
    const held = gate()
    const running = withTenantWrite(tenant.toUpperCase(), "Case fixture", held.wait)
    try {
      await held.started
      await expect(withTenantWrite(tenant, "Second fixture", async () => undefined)).rejects.toBeInstanceOf(TenantWriteConflict)
    } finally { held.release(); await running }
    for (const fn of [() => { throw new Error("Sync failure") }, async () => { throw new Error("Async failure") }]) {
      await expect(withTenantWrite(tenant, "Failure fixture", fn)).rejects.toThrow("failure")
      expect(tenantWriteLabel(tenant)).toBeUndefined()
      await expect(withTenantWrite(tenant, "Retry fixture", async () => "retried")).resolves.toBe("retried")
    }
  })

  it("returns the shared conflict as 409 through OIB, framework and workflow routes", async () => {
    const context = setup()
    const held = gate()
    const running = withTenantWrite(TENANT_A, "Active fixture", held.wait)
    try {
      await held.started
      const credentials = apiBody(TENANT_A, context.deps.tenant(TENANT_A)!)
      for (const [route, body] of [
        [oibRoute, { ...credentials, action: "oib-deploy", platform: "windows", items: [{ source: SOURCE, mode: "create" }] }],
        [frameworkRoute, { ...credentials, action: "create", runId: "unused", keys: ["0:0"], confirmUnassigned: true }],
      ] as const) {
        const response = await route(new Request("http://tenuvault.internal/api/fixture", { method: "POST", body: JSON.stringify(body) }))
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: conflict("Active fixture") })
      }
      const routes = featureRoute("/api/promotion", context.deps, { apply: ({ deps, tenantId }) => applyChangeSet(deps, tenantId, "unused", { contentHash: "unused", confirmed: true }, "Admin") })
      expect(await call(routes, "/api/promotion", { tenantId: TENANT_A, action: "apply" })).toEqual({ status: 409, body: { error: conflict("Active fixture") } })
    } finally { held.release(); await running }
  })

  it("keeps framework assessments while creation is running and permits deletion after it finishes", async () => {
    const context = setup()
    const create = await prepare(context, "framework")
    const held = gate()
    context.hold(held.wait)
    const running = create()
    try {
      await held.started
      await expect(handleFramework({ action: "workspace-delete", tenantId: TENANT_A, frameworkId: "custom" })).rejects.toMatchObject({ status: 409 })
    } finally { held.release(); await running }
    await expect(handleFramework({ action: "workspace-delete", tenantId: TENANT_A, frameworkId: "custom" })).resolves.toMatchObject({ history: [] })
  })
})

describe("pre-change backup compatibility", () => {
  it("preserves the OIB backup folder, scoped request and metadata fixture", async () => {
    const context = setup()
    const metadata = { ...COMPLETE_BACKUP_METADATA, TenantId: TENANT_A, DurationSeconds: 120 }
    const before = structuredClone(metadata)
    const contents: Record<string, unknown>[] = []
    const api = context.deps.api
    context.deps.api = async (path, tenantId, body) => {
      if (path === "/api/backup/status") return Response.json({ isComplete: true, isSuccessful: true, backupFolder: "backup-1" })
      if (path === "/api/list-backup-contents") { contents.push(body!); return Response.json({ content: { metadata } }) }
      return api(path, tenantId, body)
    }
    const run = await (await prepare(context, "deploy"))() as OibRun
    expect(run.backupFolder).toBe("backup-1")
    expect(JSON.parse(context.store.get(`oib:runs:${TENANT_A}`)!)[0].backupFolder).toBe("backup-1")
    const start = context.requests.find((request) => request.path === "/api/backup/start")!
    expect(start.body).toEqual({ tenantId: TENANT_A, appId: context.deps.tenant(TENANT_A)!.clientId, storageAccountName: `tvlocal-${TENANT_A}`, scope: { excluded: INTUNE_TYPES.map((type) => type.folder).filter((folder) => folder !== "ConfigurationPolicies") } })
    expect(contents).toEqual([apiBody(TENANT_A, context.deps.tenant(TENANT_A)!, { backupId: "backup-1" })])
    expect(metadata).toEqual(before)
  })

  it("preserves the change-set folder, full backup request, metadata and rollback capture", async () => {
    const context = setup()
    const metadata = structuredClone(COMPLETE_BACKUP_METADATA)
    const before = structuredClone(metadata)
    const api = context.deps.api
    context.deps.api = async (path, tenantId, body) => {
      const response = await api(path, tenantId, body)
      return path === "/api/list-backup-contents" ? Response.json({ content: { metadata } }) : response
    }
    const apply = await prepare(context, "changeSet")
    const applied = await apply() as Awaited<ReturnType<typeof applyChangeSet>>
    expect(applied.preChange?.backupFolder).toBe("backup-2026-09-30-120000")
    expect(getChangeSet(context.deps, TENANT_A, applied.id).preChange).toEqual(applied.preChange)
    expect(context.requests.find((request) => request.path === "/api/backup/start")!.body).toEqual({})
    expect(context.requests.find((request) => request.path === "/api/list-backup-contents")!.body).toEqual({ backupId: "backup-2026-09-30-120000" })
    expect(metadata).toEqual(before)
  })
})
