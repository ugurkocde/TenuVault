import { moduleForFolder } from "../src/shared/services/modules"
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { applyChangeSet, approveChangeSet, createChangeSet, createRollbackChangeSet, previewChangeSet } from "../src/main/features/change-sets/engine"
import { writeOperation } from "../src/main/features/change-sets/graph"
import { SUPPORTED_OPERATIONS, unsupportedReason, type OperationAction } from "../src/main/features/change-sets/model"
import { FeatureError } from "../src/main/features/route"
import { PROMOTION_FOLDERS } from "../src/main/features/promotion/engine"
import { CREATED_FOLDER } from "../src/main/frameworks/service"
import { restoreApprovals, saveRestoreApproval, setRestoreApprovalStore } from "../src/main/storage/restore-approvals"
import { setRestoreJournalStore } from "../src/main/storage/restore-journal"
import { POST as listBackupContents } from "../src/portal/app/api/list-backup-contents/route"
import { POST as restoreBackup } from "../src/portal/app/api/restore-backup/route"
import { POST as restorePreview } from "../src/portal/app/api/restore-preview/route"
import { POST as revertPolicy } from "../src/portal/app/api/revert-policy/route"
import { graphCaller, readLive, Restorer, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import { validateBackup } from "../src/portal/lib/policies/restore-validation"
import { comparableSnapshot } from "../src/shared/intune/compare"
import { recoveryReadiness } from "../src/shared/intune/recovery"
import { INTUNE_TYPES, itemName, restoreCapability, typeForFolder, type IntuneType, type Item } from "../src/shared/intune/registry"
import { buildRestorePlan, buildUpdatePlan, NotRestorableError, restoreBlocker, restoreCapabilities, writeBlocker } from "../src/shared/intune/restore-plan"
import { COMPLETE_BACKUP_METADATA, FakeTenant, wire } from "./feature-change-sets-fakes"
import { fakeDeps, TENANT_A, TENANT_B } from "./feature-helpers"
import { registerTestTypes, testType } from "./helpers/backup-fixture"
import { withoutRestoreCapability } from "./helpers/restore-capability"
import { RELEASE_FOLDERS } from "./fixtures/release-0.5-import"

/**
 * Every type has a restore capability, and a type that declares none can never be written. The
 * paths that can change a tenant used to decide "this is a create" and "this can be written" from a
 * type's shape. These tests take the capability from every registry type in turn and send it down
 * every such path: each must refuse it and send no write.
 *
 * Paths with their own fixtures prove the same in their own files: OpenIntuneBaseline in
 * test/oib-service.test.ts, framework baselines in test/frameworks.test.ts, Sync and promotion in
 * test/feature-sync.test.ts.
 */

const TENANT = "11111111-1111-1111-1111-111111111111"
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222"
const BACKUP = "backup-2026-11-10-020000"
const OBJECT = "33333333-3333-4333-8333-333333333333"
const NOT_WRITTEN = "TenuVault backs this type up and compares it, and never writes it to a tenant."

const hash = (snapshot: Item) => createHash("sha256").update(JSON.stringify(comparableSnapshot(snapshot))).digest("base64").slice(0, 22)
const snapshotOf = (type: IntuneType): Item => ({ id: type.singleton?.id ?? OBJECT, [type.nameKey]: "Example", displayName: "Example" })
const fileOf = (type: IntuneType) => `${BACKUP}/${type.folder}/Example.json`

interface World {
  /** Every request to Microsoft Graph, as "METHOD /path". */
  graph: string[]
}

/** The token endpoint, a storage account that holds one backup of `type`, and a tenant that still has the object. */
function world(type: IntuneType, metadata: Record<string, unknown> = {}, graphToken = "token"): World {
  const snapshot = snapshotOf(type)
  const blobs: Record<string, unknown> = {
    [`${BACKUP}/metadata.json`]: { TenantId: TENANT, Status: "Success", Failures: 0, SkippedTypes: [], FailedTypes: [], Scope: { Excluded: [], Included: INTUNE_TYPES.map((entry) => entry.folder) }, Items: { [`${type.folder}/${snapshot.id}`]: { file: "Example.json", hash: hash(snapshot) } }, ...metadata },
    [`${BACKUP}/.tenuvault-owner.json`]: { TenantId: TENANT },
    [fileOf(type)]: snapshot,
  }
  const seen: World = { graph: [] }
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === "login.microsoftonline.com") {
      const scope = new URLSearchParams(init?.body as URLSearchParams).get("scope")
      return Response.json({ access_token: scope?.includes("graph.microsoft.com") ? graphToken : "token" })
    }
    if (url.hostname === "graph.microsoft.com") {
      seen.graph.push(`${init?.method ?? "GET"} ${url.pathname}`)
      return Response.json({ ...snapshot, displayName: "Changed in the tenant", value: [] })
    }
    if (url.searchParams.get("comp") === "list") return new Response(`<EnumerationResults><Blobs><Blob><Name>${fileOf(type)}</Name><Properties><Content-Length>20</Content-Length></Properties></Blob></Blobs><NextMarker></NextMarker></EnumerationResults>`)
    if (init?.method === "PUT" || url.pathname.includes("/metadata/")) return new Response("", { status: 404 })
    const name = url.pathname.split("/").slice(2).map(decodeURIComponent).join("/")
    return name in blobs ? Response.json(blobs[name]) : new Response("", { status: 404 })
  }))
  return seen
}

const post = (route: string, body: object) => new NextRequest(`http://tenuvault.internal/api/${route}`, { method: "POST", body: JSON.stringify(body) })
const credentials = { tenantId: TENANT, appId: "app", clientSecret: "placeholder", storageAccountName: "storage" }
const writes = (seen: World) => seen.graph.filter((call) => !call.startsWith("GET "))

async function restore(type: IntuneType, options: Record<string, unknown>): Promise<{ success: boolean; action?: string; error?: string }> {
  const response = await restoreBackup(post("restore-backup", { ...credentials, backupId: BACKUP, restoreType: "selective", selectedPolicies: [{ path: fileOf(type) }], ...options }))
  const body = (await response.json()) as { details?: { results: Array<{ success: boolean; action?: string; error?: string }> }; error?: string }
  return body.details?.results[0] ?? { success: false, error: body.error }
}

async function revert(type: IntuneType, action: "revert" | "restore"): Promise<{ status: number; error?: string }> {
  const response = await revertPolicy(post("revert-policy", { ...credentials, action, policyId: snapshotOf(type).id, policyType: type.label, backupPath: fileOf(type) }))
  return { status: response.status, error: ((await response.json()) as { error?: string }).error }
}

/** The paths every registry type can be sent down, each with what it must answer for a type without a restore capability. */
const PATHS: Array<{ name: string; where: string; refuses: (type: IntuneType, reason: string) => Promise<void> }> = [
  {
    name: "restore as a copy",
    where: "restore-backup route > Restorer.restore (create)",
    refuses: async (type, reason) => expect(await restore(type, { mode: "copy", assignments: true })).toMatchObject({ success: false, action: "skipped", error: reason }),
  },
  {
    name: "restore in place over the live object",
    where: "restore-backup route > Restorer.restore (update)",
    refuses: async (type, reason) => expect(await restore(type, { mode: "replace", assignments: true })).toMatchObject({ success: false, action: "skipped", error: reason }),
  },
  {
    name: "copy to another tenant",
    where: "restore-backup route, targetTenants > Restorer.restore (cross-tenant create)",
    refuses: async (type, reason) => expect(await restore(type, { mode: "copy", assignments: false, targetTenants: [{ tenantId: OTHER_TENANT, appId: OBJECT }] })).toMatchObject({ success: false, action: "skipped", error: reason }),
  },
  {
    name: "revert a drifted object to its backup",
    where: "revert-policy route, action revert > Restorer.restore (update)",
    refuses: async (type, reason) => expect(await revert(type, "revert")).toMatchObject({ error: reason }),
  },
  {
    name: "restore a drifted object as a copy",
    where: "revert-policy route, action restore > Restorer.restore (create)",
    refuses: async (type, reason) => expect(await revert(type, "restore")).toMatchObject({ error: reason }),
  },
  {
    name: "the restore plan builders",
    where: "buildRestorePlan, buildUpdatePlan, restoreBlocker, restoreCapabilities (shared/intune/restore-plan)",
    refuses: async (type, reason) => {
      const snapshot = snapshotOf(type)
      expect(() => buildRestorePlan(type, snapshot, { includeAssignments: true })).toThrow(new NotRestorableError(reason))
      expect(() => buildUpdatePlan(type, snapshot, String(snapshot.id), { includeAssignments: true, current: snapshot })).toThrow(new NotRestorableError(reason))
      expect(restoreBlocker(type, snapshot)).toBe(reason)
      expect(restoreCapabilities(type, snapshot)).toEqual({ blocker: reason, replaceBlocker: reason })
      expect(recoveryReadiness(type, snapshot)).toMatchObject({ automatic: false, manualActions: expect.arrayContaining([reason]) })
      const validation = await validateBackup({ backupId: BACKUP, metadata: null, listedPaths: [fileOf(type)], readSnapshot: async () => ({ ok: true, snapshot }) })
      expect(validation.items[0]!.checks.find((check) => check.id === "payload")).toMatchObject({ ok: false, detail: reason })
    },
  },
  {
    name: "a change set, when it is created",
    where: "createChangeSet > unsupportedReason (features/change-sets)",
    refuses: async (type, reason) => {
      for (const action of ["create", "update", "delete"] as const) expect(unsupportedReason(type.folder, action)).toBe(reason)
      const deps = fakeDeps({ plans: { [TENANT_A]: "pro" } })
      const tenant = new FakeTenant(TENANT_A)
      wire(deps, [tenant])
      await expect(createChangeSet(deps, TENANT_A, { title: "Change", operations: [{ folder: type.folder, action: "create", proposed: snapshotOf(type) }] }, "Admin")).rejects.toThrow(new FeatureError(reason))
      expect(tenant.calls.filter((call) => call.method !== "GET")).toEqual([])
    },
  },
  {
    name: "a change set operation, when it is written",
    where: "writeOperation (features/change-sets/graph), the writer of change sets, Sync, promotion and their rollback",
    refuses: async (type, reason) => {
      const sent: string[] = []
      const graph: GraphCall = async (method, path) => (sent.push(`${method} ${path}`), { status: 200, body: { id: OBJECT } })
      for (const action of ["create", "update", "delete"] as OperationAction[]) {
        const outcome = await writeOperation(graph, type, { action, targetId: action === "create" ? null : OBJECT, proposed: action === "delete" ? null : snapshotOf(type), assignments: null, current: snapshotOf(type) }, () => undefined)
        expect(outcome).toEqual({ state: "rejected", objectId: action === "create" ? null : OBJECT, message: `Not sent: ${reason}` })
      }
      expect(sent).toEqual([])
    },
  },
]

beforeEach(() => {
  const data = new Map<string, string>()
  const store = { get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  setRestoreApprovalStore(store)
  setRestoreJournalStore(store)
})
afterEach(() => vi.unstubAllGlobals())

describe("Intune policy set restore permission", () => {
  const policySets = typeForFolder("PolicySets")!
  const permission = "DeviceManagementConfiguration.ReadWrite.All"
  const tokenWith = (scp: string) => `e30.${Buffer.from(JSON.stringify({ scp })).toString("base64url")}.sig`
  const readOnly = tokenWith("DeviceManagementConfiguration.Read.All DeviceManagementApps.ReadWrite.All")

  it.each([false, true])("shows the missing write scope in the preview with live=%s", async (live) => {
    const seen = world(policySets, {}, readOnly)
    const preview = await restorePreview(post("restore-preview", { ...credentials, backupId: BACKUP, paths: [fileOf(policySets)], live }))
    expect(preview.status).toBe(200)
    const blocker = expect.stringContaining(permission)
    expect(await preview.json()).toMatchObject({ items: [{ blocker, replaceBlocker: blocker }] })
    expect(writes(seen)).toEqual([])
  })

  it.each(["copy", "replace"])("skips a policy set before sending any Graph writes in %s mode", async (mode) => {
    const seen = world(policySets, {}, readOnly)
    expect(await restore(policySets, { mode, assignments: false })).toMatchObject({ success: false, action: "skipped", error: expect.stringContaining(permission) })
    expect(writes(seen)).toEqual([])
  })

  it.each([
    ["PolicySets", tokenWith(permission), "deviceAppManagement/policySets"],
    ["DeviceConfigurations", readOnly, "deviceManagement/deviceConfigurations"],
  ])("restores %s when the policy-set check permits it or does not apply", async (folder, token, endpoint) => {
    const type = typeForFolder(folder)!
    const seen = world(type, {}, token)
    const preview = await restorePreview(post("restore-preview", { ...credentials, backupId: BACKUP, paths: [fileOf(type)] }))
    const { items } = await preview.json()
    expect(items[0].blocker).toBeUndefined()
    expect(items[0].replaceBlocker).toBeUndefined()
    expect(await restore(type, { mode: "copy", assignments: false })).toMatchObject({ success: true, action: "created" })
    expect(writes(seen)).toEqual([`POST /beta/${endpoint}`])
  })
})

describe("the restore capability of every registry type", () => {
  it("follows the restore kind each type had: nothing gained or lost a capability", () => {
    const capabilities = Object.fromEntries(INTUNE_TYPES.filter(type => ["intune", "conditionalAccess"].includes(moduleForFolder(type.folder)!.module.id)).map((type) => [type.folder, restoreCapability(type)]))
    expect(Object.keys(capabilities)).toEqual(RELEASE_FOLDERS)
    for (const [folder, capability] of Object.entries(capabilities)) {
      expect(capability, folder).toBe(folder === "CompliancePolicySettings" ? "singleton" : folder === "AppleAutomatedEnrollment" ? "metadata" : "create")
    }
  })

  it("is none for a type that declares nothing, with a reason", () => {
    const type = testType("AuthorizationPolicy", "policies/authorizationPolicy")
    expect(restoreCapability(type)).toBe("none")
    for (const operation of ["create", "update", "delete", "assign"] as const) expect(writeBlocker(type, operation)).toBe(NOT_WRITTEN)
    // A type can say why in its own words.
    expect(writeBlocker({ ...type, limitation: "Token seeds are never returned, so hardware tokens cannot be restored." }, "create")).toBe("Token seeds are never returned, so hardware tokens cannot be restored.")
  })

  it("allows what each kind always allowed", () => {
    const kind = (restore: IntuneType["restore"]) => (["create", "update", "delete", "assign"] as const).map((operation) => writeBlocker({ restore }, operation) === undefined)
    expect(kind("create")).toEqual([true, true, true, true])
    // A tenant-wide setting is replaced in place, never created or deleted.
    expect(kind("singleton")).toEqual([false, true, false, true])
    expect(kind("metadata")).toEqual([false, false, false, false])
    expect(kind(undefined)).toEqual([false, false, false, false])
  })
})

describe("a type without a restore capability is refused by every path that can write", () => {
  describe.each(INTUNE_TYPES.map((type) => [type.folder, type] as const))("%s", (_folder, type) => {
    it.each(PATHS)("$name", async (path) => {
      const seen = world(type)
      await withoutRestoreCapability(type, async () => {
        const reason = writeBlocker(type, "create")!
        expect(reason).toBe(type.limitation ?? NOT_WRITTEN)
        await path.refuses(type, reason)
      })
      // Refused before anything was sent: no write, and not even a read of the object.
      expect(writes(seen)).toEqual([])
      expect(seen.graph).toEqual([])
    })
  })

  it("covers every registry type and names where each path enters the code", () => {
    expect(INTUNE_TYPES.length).toBeGreaterThanOrEqual(RELEASE_FOLDERS.length)
    expect(PATHS.map((path) => path.where).every(Boolean)).toBe(true)
  })

  it("can see a write: the same paths do write a type that has its capability", async () => {
    const type = typeForFolder("DeviceCategories")!
    const seen = world(type)
    expect(await restore(type, { mode: "copy", assignments: false })).toMatchObject({ success: true })
    expect(writes(seen)).toEqual(["POST /beta/deviceManagement/deviceCategories"])
    const reverted = world(type)
    expect(await revert(type, "revert")).toMatchObject({ status: 200 })
    expect(writes(reverted)).toEqual([`PATCH /beta/deviceManagement/deviceCategories/${OBJECT}`])
  })
})

describe("a test-only type, as the new services will add them", () => {
  const TYPE = testType("AuthenticationFlowsPolicy", "policies/authenticationFlowsPolicy", { apiVersion: "v1.0", headers: { ConsistencyLevel: "eventual" } })
  let unregister: () => void
  beforeEach(() => {
    unregister = registerTestTypes([TYPE])
  })
  afterEach(() => unregister())

  it.each(PATHS)("is refused by: $name", async (path) => {
    const seen = world(TYPE)
    await path.refuses(TYPE, NOT_WRITTEN)
    expect(seen.graph).toEqual([])
  })

  it("is refused from an imported backup as from any other", async () => {
    // What an import adds to the manifest (see importArchive).
    const seen = world(TYPE, { SourceTenantId: OTHER_TENANT, Import: { sha256: "0".repeat(64), reviewedAt: "2026-11-10T02:00:00Z", provenance: "User-reviewed ZIP; source identity is not cryptographically verified" } })
    expect(await restore(TYPE, { mode: "copy", assignments: false })).toMatchObject({ success: false, action: "skipped", error: NOT_WRITTEN })
    expect(await restore(TYPE, { mode: "replace", assignments: false })).toMatchObject({ success: false, action: "skipped", error: NOT_WRITTEN })
    expect(seen.graph).toEqual([])
  })

  it("is shown in a backup's contents and in the restore preview as never written, with the reason", async () => {
    world(TYPE)
    const contents = (await (await listBackupContents(post("list-backup-contents", { ...credentials, subscriptionId: "sub", resourceGroupName: "rg", backupId: BACKUP }))).json()) as { content: { groups: Array<{ folder: string; limitation?: string }> } }
    expect(contents.content.groups).toMatchObject([{ folder: "AuthenticationFlowsPolicy", limitation: NOT_WRITTEN }])
    // With and without a look at the live object, which is read and never written.
    for (const live of [false, true]) {
      const preview = (await (await restorePreview(post("restore-preview", { ...credentials, backupId: BACKUP, paths: [fileOf(TYPE)], live }))).json()) as { items: Array<{ blocker?: string; replaceBlocker?: string }> }
      expect(preview.items).toMatchObject([{ blocker: NOT_WRITTEN, replaceBlocker: NOT_WRITTEN }])
    }
  })

  it("is read live from its own Graph version and with its headers, so a comparison reads what the backup read", async () => {
    const requests: Array<{ url: string; headers: Headers }> = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      return Response.json({ id: OBJECT, displayName: "Live" })
    }) as typeof fetch
    expect(await readLive(graphCaller("token", fetchImpl), TYPE, OBJECT)).toEqual({ id: OBJECT, displayName: "Live" })
    expect(requests.map((request) => request.url)).toEqual([`https://graph.microsoft.com/v1.0/policies/authenticationFlowsPolicy/${OBJECT}`])
    expect(requests[0]!.headers.get("ConsistencyLevel")).toBe("eventual")
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer token")
    // A beta type is read exactly as before.
    requests.length = 0
    await readLive(graphCaller("token", fetchImpl), typeForFolder("DeviceCategories")!, OBJECT)
    expect(requests.map((request) => request.url)).toEqual([`https://graph.microsoft.com/beta/deviceManagement/deviceCategories/${OBJECT}`])
  })
})

describe("a write that was prepared while the type could still be written", () => {
  const TYPE = typeForFolder("NotificationTemplates")!
  const snapshot: Item = { displayName: "Message", localizedNotificationMessages: [{ locale: "en-us", subject: "Hello", messageTemplate: "Hi", isDefault: true }] }
  const path = `${BACKUP}/NotificationTemplates/Message.json`

  it("is refused on repair: the steps a failed restore kept are checked like fresh ones", async () => {
    const sent: string[] = []
    const graph: GraphCall = async (method, url): ReturnType<GraphCall> => {
      sent.push(`${method} ${url}`)
      return url.endsWith("localizedNotificationMessages") ? { status: 400, body: { error: { message: "Rejected" } } } : { status: 201, body: { id: "created" } }
    }
    const options = { mode: "copy" as const, assignments: false, repairScope: "tenant" }
    const outcome = await new Restorer(graph, options).restore(path, snapshot)
    expect(outcome).toMatchObject({ success: false, partial: true, repairToken: expect.any(String) })
    sent.length = 0
    const repaired = await withoutRestoreCapability(TYPE, () => new Restorer(graph, options).repair(path, outcome.repairToken!))
    expect(repaired).toMatchObject({ success: false, retryable: false, error: NOT_WRITTEN })
    expect(sent.filter((call) => !call.startsWith("GET "))).toEqual([])
  })

  it("is refused when its Multi Admin Approval request is submitted or completed", async () => {
    const code = "11111111-1111-4111-8111-111111111111"
    const sent: string[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (init?.method === "GET") return Response.json(String(input).includes("operationApprovalRequests") ? { status: "approved" } : { id: OBJECT, displayName: "Kiosk" })
      sent.push(`${init?.method} ${String(input)}`)
      if (headers.has("x-msft-approval-code")) return Response.json({ id: OBJECT }, { status: 201 })
      return Response.json({ error: { message: `x-msft-approval-code: ${code}` } }, { status: 412 })
    }) as typeof fetch
    const context = { tenantId: TENANT, requesterId: OBJECT, justification: "Restore a tested backup" }
    const type = typeForFolder("DeviceCategories")!
    const restorer = new Restorer(graphCaller("token", fetcher, { tenant: TENANT }), { mode: "copy", assignments: false, approvalContext: context })
    expect(await restorer.restore(`${BACKUP}/DeviceCategories/Kiosk.json`, { id: OBJECT, displayName: "Kiosk" })).toMatchObject({ approvalState: "submitted" })
    const record = restoreApprovals(TENANT).find((entry) => entry.id === code)!
    expect(record).toMatchObject({ folder: "DeviceCategories", operation: "create" })
    sent.length = 0
    await withoutRestoreCapability(type, async () => {
      await expect(restorer.completeApproval(record)).rejects.toThrow(NOT_WRITTEN)
      await expect(restorer.submitApproval({ ...record, status: "justification-required" }, "Again")).rejects.toThrow(NOT_WRITTEN)
    })
    expect(sent).toEqual([])
    // A stored request for a folder this version does not know is never sent either.
    saveRestoreApproval({ ...record, folder: "RemovedType" })
    await expect(restorer.completeApproval(record)).rejects.toThrow("a type TenuVault does not know")
    expect(sent).toEqual([])
  })

  it("is refused when its change set is applied, whole and before anything is claimed, also as a rollback", async () => {
    const deps = fakeDeps({ plans: { [TENANT_A]: "pro", [TENANT_B]: "pro" } })
    const tenant = new FakeTenant(TENANT_A)
    wire(deps, [tenant, new FakeTenant(TENANT_B)], { metadata: COMPLETE_BACKUP_METADATA })
    const policy = tenant.addPolicy({ name: "Defender baseline" })
    const approved = async (id: string) => {
      const preview = await previewChangeSet(deps, TENANT_A, id)
      await approveChangeSet(deps, TENANT_A, id, { contentHash: preview.contentHash, targetFingerprint: preview.targetFingerprint, reviewer: "Reviewer" }, "Admin")
      return preview.contentHash
    }
    const change = await createChangeSet(deps, TENANT_A, { title: "Harden", operations: [{ folder: "ConfigurationPolicies", action: "update", targetId: policy.id as string, proposed: { ...structuredClone(policy), description: "Hardened" } }] }, "Admin")
    const contentHash = await approved(change.id)
    const type = typeForFolder("ConfigurationPolicies")!
    const before = tenant.calls.length
    await withoutRestoreCapability(type, async () => {
      await expect(applyChangeSet(deps, TENANT_A, change.id, { contentHash, confirmed: true }, "Admin")).rejects.toThrow(new FeatureError(NOT_WRITTEN, 409))
    })
    expect(tenant.calls.slice(before).filter((call) => call.method !== "GET")).toEqual([])
    // With its capability back the same change set applies, and its rollback is refused the same way.
    await applyChangeSet(deps, TENANT_A, change.id, { contentHash, confirmed: true }, "Admin")
    expect(tenant.policies.get(policy.id as string)).toMatchObject({ description: "Hardened" })
    const rollback = await createRollbackChangeSet(deps, TENANT_A, change.id, {}, "Admin")
    const rollbackHash = await approved(rollback.id)
    const applied = tenant.calls.length
    await withoutRestoreCapability(type, async () => {
      await expect(applyChangeSet(deps, TENANT_A, rollback.id, { contentHash: rollbackHash, confirmed: true }, "Admin")).rejects.toThrow(NOT_WRITTEN)
      await expect(createRollbackChangeSet(deps, TENANT_A, change.id, {}, "Admin")).rejects.toThrow()
    })
    expect(tenant.calls.slice(applied).filter((call) => call.method !== "GET")).toEqual([])
    expect(tenant.policies.get(policy.id as string)).toMatchObject({ description: "Hardened" })
  })
})

describe("the paths that write a fixed set of types", () => {
  it("ask the capability of each type they write, so listing a folder never makes it writable", async () => {
    // Change sets, and with them Sync, promotion, CIS remediation, baselines and standards.
    for (const [folder, actions] of Object.entries(SUPPORTED_OPERATIONS)) {
      await withoutRestoreCapability(folder, () => {
        for (const action of actions) expect(unsupportedReason(folder, action)).toBe(NOT_WRITTEN)
      })
      for (const action of actions) expect(unsupportedReason(folder, action)).toBeUndefined()
    }
    // Sync and promotion only take folders change sets can write.
    for (const folder of PROMOTION_FOLDERS) expect(Object.keys(SUPPORTED_OPERATIONS)).toContain(folder)
    // The framework baselines create one type, and name it.
    expect(itemName(typeForFolder(CREATED_FOLDER)!, { name: "x" })).toBe("x")
    expect(typeForFolder(CREATED_FOLDER)!.path).toBe("deviceManagement/configurationPolicies")
  })
})
