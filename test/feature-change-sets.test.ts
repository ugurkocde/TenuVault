import { describe, expect, it } from "vitest"
import { applyChangeSet, approveChangeSet, CONTENT_DOMAIN, createChangeSet, KEPT_CHANGE_SETS, createRollbackChangeSet, getChangeSet, listChangeSets, previewChangeSet, previewRollback, rejectChangeSet, reviseChangeSet } from "../src/main/features/change-sets/engine"
import type { FeatureDeps } from "../src/main/features/deps"
import { FeatureError } from "../src/main/features/route"
import { containsExpected, contentHashOf, diffConfigurations, REDACTED, sanitizeSnapshot, statusFromResults, type ChangeSetContent, type ChangeSetRecord } from "../src/main/features/change-sets/model"
import { typeForFolder, type Item } from "../src/shared/intune/registry"
import { DOMAINS } from "../src/main/features/domains"
import { MAX_RECORDS } from "../src/main/features/records"
import { fakeDeps, seedRecords, TENANT_A, TENANT_B } from "./feature-helpers"
import { COMPLETE_BACKUP_METADATA, FakeTenant, setting, wire } from "./feature-change-sets-fakes"
import { writeOperation } from "../src/main/features/change-sets/graph"

const POLICIES = typeForFolder("ConfigurationPolicies")!

function setup(options: { backup?: "ok" | "fail" | "no-start"; metadata?: Record<string, unknown> | null } = {}) {
  const deps = fakeDeps({ plans: { [TENANT_A]: "pro", [TENANT_B]: "pro" } })
  const tenant = new FakeTenant(TENANT_A)
  const other = new FakeTenant(TENANT_B)
  const wired = wire(deps, [tenant, other], options)
  const post = (body: Record<string, unknown>, tenantId = TENANT_A) => engine(deps, tenantId, body)
  return { deps, tenant, other, post, ...wired }
}

/**
 * Drives the change-set engine the way a workflow route does and answers like one: a
 * FeatureError becomes its status and message. The engine has no route of its own; promotion
 * and the other workflows call these functions.
 */
async function engine(deps: FeatureDeps, tenantId: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const id = body.id as string
  const run = async (): Promise<unknown> => {
    switch (body.action) {
      case "list": return { changeSets: listChangeSets(deps, tenantId) }
      case "get": return { changeSet: getChangeSet(deps, tenantId, id) }
      case "preview": return previewChangeSet(deps, tenantId, id)
      case "approve": return { changeSet: await approveChangeSet(deps, tenantId, id, { contentHash: body.contentHash as string, targetFingerprint: body.targetFingerprint as string, reviewer: (body.reviewer as string | undefined) ?? null }, "Admin") }
      case "reject": return { changeSet: await rejectChangeSet(deps, tenantId, id, {}, "Admin") }
      case "revise": return { changeSet: await reviseChangeSet(deps, tenantId, id, body.removeKeys as string[], "Admin") }
      case "apply":
      case "retry":
        return { changeSet: await applyChangeSet(deps, tenantId, id, { contentHash: body.contentHash as string, confirmed: body.confirm === true }, "Admin") }
      case "rollback-preview": return previewRollback(deps, tenantId, id)
      case "rollback-create": return { changeSet: await createRollbackChangeSet(deps, tenantId, id, {}, "Admin") }
      default: throw new Error(`Unknown action ${String(body.action)}`)
    }
  }
  try {
    return { status: 200, body: await run() }
  } catch (error) {
    if (error instanceof FeatureError) return { status: error.status, body: { error: error.message } }
    throw error
  }
}

/** A change set that updates one policy, creates one and deletes one, created through the engine. */
async function threeOperations(context: ReturnType<typeof setup>) {
  const existing = context.tenant.addPolicy({ name: "Defender baseline" })
  const doomed = context.tenant.addPolicy({ name: "Old policy" })
  const proposedUpdate: Item = { ...structuredClone(existing), description: "Hardened", settings: [setting("device_vendor_msft_policy_config_defender_allowarchivescanning", "device_vendor_msft_policy_config_defender_allowarchivescanning_0")] }
  const record = await createChangeSet(context.deps, TENANT_A, {
    title: "Harden Defender",
    ticket: "CHG-1",
    operations: [
      { folder: "ConfigurationPolicies", action: "update", targetId: existing.id as string, proposed: proposedUpdate },
      { folder: "ConfigurationPolicies", action: "create", proposed: { name: "New firewall policy", platforms: "windows10", technologies: "mdm", roleScopeTagIds: ["0"], settings: [setting("vendor_msft_firewall_enable", "vendor_msft_firewall_enable_true")] } },
      { folder: "ConfigurationPolicies", action: "delete", targetId: doomed.id as string },
    ],
  }, "Admin")
  return { record, existing, doomed }
}

async function approve(context: ReturnType<typeof setup>, id: string) {
  const preview = await context.post({ action: "preview", id })
  expect(preview.status).toBe(200)
  const approved = await context.post({ action: "approve", id, contentHash: preview.body.contentHash, targetFingerprint: preview.body.targetFingerprint, reviewer: "Reviewer" })
  expect(approved.status).toBe(200)
  return preview.body
}

describe("change-set model", () => {
  it("hashes content independently of metadata and key order", () => {
    const base = { kind: "change" as const, targetTenantId: TENANT_A, sourceTenantId: null, sourceVersion: null, operations: [], dependencies: [], rollbackOf: null }
    expect(contentHashOf(base)).toBe(contentHashOf({ ...base }))
    expect(contentHashOf(base)).not.toBe(contentHashOf({ ...base, sourceVersion: "v2" }))
  })

  it("redacts Settings Catalog secret values before anything is stored", () => {
    const { snapshot, redacted } = sanitizeSnapshot(POLICIES, { name: "Wi-Fi", settings: [{ settingInstance: { simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSecretSettingValue", value: "hunter2", valueState: "encryptedValueToken" } } }] })
    expect(redacted).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain("hunter2")
    expect(JSON.stringify(snapshot)).toContain(REDACTED)
  })

  it("diffs settings by definition and ignores server-managed fields", () => {
    const before = { name: "A", lastModifiedDateTime: "x", settings: [setting("a", "a_1"), setting("b", "b_1")] }
    const after = { name: "A", lastModifiedDateTime: "y", settings: [setting("b", "b_1"), setting("a", "a_0")] }
    const diff = diffConfigurations(POLICIES, before, after)
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!.path).toContain("settings.a")
  })

  it("treats null members as absent when comparing a read-back", () => {
    expect(containsExpected({ a: 1, b: null, c: [] }, { a: 1, d: 2 })).toBe(true)
    expect(containsExpected({ a: 1 }, { a: 2 })).toBe(false)
  })

  it("derives the change set status from per-operation outcomes", () => {
    const result = (status: "verified" | "failed" | "uncertain" | "pending") => ({ status, objectId: null, message: null, readBack: null, attempts: 1, at: null })
    expect(statusFromResults([result("verified"), result("verified")])).toBe("applied")
    expect(statusFromResults([result("verified"), result("failed")])).toBe("partial")
    expect(statusFromResults([result("verified"), result("uncertain")])).toBe("uncertain")
    expect(statusFromResults([result("failed")])).toBe("failed")
  })
})

describe("change-set engine", () => {
  it("applies an approved change set with backup, capture, journaled writes and read-back", async () => {
    const context = setup()
    const { record, existing, doomed } = await threeOperations(context)
    expect(record.status).toBe("in-review")
    const preview = await approve(context, record.id)
    expect(preview.affectedObjects).toHaveLength(3)
    expect(preview.irreversible.join(" ")).toContain("irreversible")
    expect(preview.notice).toContain("no atomic tenant transaction")

    const applied = await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })
    expect(applied.status).toBe(200)
    const changeSet = applied.body.changeSet as ChangeSetRecord
    expect(changeSet.status).toBe("applied")
    expect(Object.values(changeSet.results).every((result) => result.status === "verified" && result.readBack !== null)).toBe(true)
    expect(context.backups).toEqual([TENANT_A])
    expect(changeSet.preChange?.backupFolder).toBe("backup-2026-09-30-120000")
    // Every write went through the journaled caller.
    expect(context.tenant.calls.filter((entry) => entry.method !== "GET").every((entry) => entry.journaled)).toBe(true)
    expect(context.tenant.policies.get(existing.id as string)?.description).toBe("Hardened")
    expect(context.tenant.policies.has(doomed.id as string)).toBe(false)
    // The pre-change capture holds the replaced and deleted objects.
    const capture = context.deps.records.get<ChangeSetContent>(CONTENT_DOMAIN, TENANT_A, changeSet.preChange!.captureId)!
    expect(capture.entries["op-1"]!.body?.description).toBe("")
    expect(capture.entries["op-3"]!.body?.name).toBe("Old policy")
    // Applying again is refused; nothing is repeated.
    expect((await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })).status).toBe(409)
  })

  it("requires explicit confirmation", async () => {
    const context = setup()
    const { record } = await threeOperations(context)
    const preview = await approve(context, record.id)
    expect((await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash })).status).toBe(400)
    expect(context.tenant.writeCount()).toBe(0)
  })

  it("refuses an approval when the target changed after the preview", async () => {
    const context = setup()
    const { record, existing } = await threeOperations(context)
    const preview = await context.post({ action: "preview", id: record.id })
    context.tenant.policies.get(existing.id as string)!.description = "Edited by someone else"
    const approved = await context.post({ action: "approve", id: record.id, contentHash: preview.body.contentHash, targetFingerprint: preview.body.targetFingerprint })
    expect(approved.status).toBe(409)
  })

  it("marks a stale approval and writes nothing when the target changed after approval", async () => {
    const context = setup()
    const { record, existing } = await threeOperations(context)
    const preview = await approve(context, record.id)
    context.tenant.policies.get(existing.id as string)!.assignments = [{ id: "x", source: "direct", target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget", deviceAndAppManagementAssignmentFilterId: null, deviceAndAppManagementAssignmentFilterType: "none" } }]
    const applied = await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })
    expect(applied.status).toBe(409)
    expect(context.tenant.writeCount()).toBe(0)
    expect(context.backups).toEqual([])
    const stored = (await context.post({ action: "get", id: record.id })).body.changeSet as ChangeSetRecord
    expect(stored.status).toBe("stale")
    expect(stored.review).toBeNull()
  })

  it("never approves, revises or applies a stale change set again", async () => {
    const context = setup()
    const { record, existing } = await threeOperations(context)
    const first = await approve(context, record.id)
    context.tenant.policies.get(existing.id as string)!.description = "Edited by someone else"
    const stale = await context.post({ action: "apply", id: record.id, contentHash: first.contentHash, confirm: true })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toContain("Preview the change again to create a new change set.")
    expect((await context.post({ action: "get", id: record.id })).body.changeSet.summary).toContain("can no longer be approved or applied")

    const preview = await context.post({ action: "preview", id: record.id })
    const approved = await context.post({ action: "approve", id: record.id, contentHash: preview.body.contentHash, targetFingerprint: preview.body.targetFingerprint })
    expect(approved.status).toBe(409)
    expect(approved.body.error).toContain("stale")
    expect((await context.post({ action: "revise", id: record.id, removeKeys: ["op-3"] })).status).toBe(409)
    expect((await context.post({ action: "apply", id: record.id, contentHash: preview.body.contentHash, confirm: true })).status).toBe(409)
    expect((await context.post({ action: "get", id: record.id })).body.changeSet.status).toBe("stale")
    expect(context.tenant.writeCount()).toBe(0)
    // It can still be dismissed.
    expect((await context.post({ action: "reject", id: record.id })).status).toBe(200)
  })

  it("requires a fresh review after the content changes", async () => {
    const context = setup()
    const { record } = await threeOperations(context)
    const preview = await approve(context, record.id)
    const revised = await context.post({ action: "revise", id: record.id, removeKeys: ["op-3"] })
    expect(revised.body.changeSet.status).toBe("in-review")
    expect(revised.body.changeSet.contentHash).not.toBe(preview.contentHash)
    expect((await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })).status).toBe(409)
    expect(context.tenant.writeCount()).toBe(0)
  })

  it("detects stored content that changed after approval", async () => {
    const context = setup()
    const { record } = await threeOperations(context)
    const preview = await approve(context, record.id)
    context.deps.records.update<ChangeSetContent>(CONTENT_DOMAIN, TENANT_A, record.proposalId, (current) => ({ ...current, entries: { ...current.entries, "op-2": { body: { name: "Tampered", settings: [] }, assignments: null } } }), { actor: null, reason: "test tamper" })
    const applied = await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })
    expect(applied.status).toBe(409)
    expect(applied.body.error).toContain("changed after it was reviewed")
    expect(context.tenant.writeCount()).toBe(0)
  })

  it("aborts before any write when the pre-change backup fails", async () => {
    for (const backup of ["fail", "no-start"] as const) {
      const context = setup({ backup })
      const { record } = await threeOperations(context)
      const preview = await approve(context, record.id)
      const applied = await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })
      expect(applied.status).toBe(502)
      expect(applied.body.error).toContain("nothing was written")
      expect(context.tenant.writeCount()).toBe(0)
      const stored = (await context.post({ action: "get", id: record.id })).body.changeSet as ChangeSetRecord
      expect(stored.status).toBe("approved")
      expect(stored.preChange).toBeNull()
    }
  })

  it("refuses a pre-change backup that is not complete for the types it writes and says what is missing", async () => {
    const cases: Array<[Record<string, unknown> | null, string]> = [
      [{ ...COMPLETE_BACKUP_METADATA, Status: "CompletedWithWarnings", Failures: 2 }, "status CompletedWithWarnings, 2 failure(s)"],
      [{ ...COMPLETE_BACKUP_METADATA, Failures: 1 }, "status Success, 1 failure(s)"],
      [{ ...COMPLETE_BACKUP_METADATA, Failures: undefined }, "an unknown number of failures"],
      [{ ...COMPLETE_BACKUP_METADATA, Scope: { Excluded: ["ConfigurationPolicies"] } }, `${POLICIES.label} left out of the backup scope`],
      [{ ...COMPLETE_BACKUP_METADATA, SkippedTypes: ["ConfigurationPolicies"] }, `${POLICIES.label} skipped for missing permissions`],
      [{ ...COMPLETE_BACKUP_METADATA, FailedTypes: ["ConfigurationPolicies"] }, `${POLICIES.label} failed`],
      [null, "could not be read"],
    ]
    for (const [metadata, reason] of cases) {
      const context = setup({ metadata })
      const { record } = await threeOperations(context)
      const preview = await approve(context, record.id)
      const applied = await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })
      expect(applied.status).toBe(502)
      expect(applied.body.error).toContain(reason)
      expect(applied.body.error).toContain("nothing was written")
      expect(context.tenant.writeCount()).toBe(0)
      const stored = (await context.post({ action: "get", id: record.id })).body.changeSet as ChangeSetRecord
      expect(stored.status).toBe("approved")
      expect(stored.preChange).toBeNull()
    }
  })

  it("hands the change set back when the journaled caller cannot be created", async () => {
    const context = setup()
    const { record } = await threeOperations(context)
    const preview = await approve(context, record.id)
    const graph = context.deps.graph
    context.deps.graph = async (tenantId, options) => {
      if (options?.journal) throw new Error("Sign in again to continue.")
      return graph(tenantId, options)
    }
    await expect(context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })).rejects.toThrow(/Sign in again/)
    expect(context.tenant.writeCount()).toBe(0)
    const stored = (await context.post({ action: "get", id: record.id })).body.changeSet as ChangeSetRecord
    expect(stored.status).toBe("approved")
    expect(stored.lastError).toContain("Sign in again")
    context.deps.graph = graph
    const applied = await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })
    expect(applied.body.changeSet.status).toBe("applied")
  })

  it("accepts a complete pre-change backup that left out only types the change set does not write", async () => {
    const context = setup({ metadata: { ...COMPLETE_BACKUP_METADATA, Scope: { Excluded: ["Apps"] }, SkippedTypes: ["ConditionalAccess"] } })
    const { record } = await threeOperations(context)
    const preview = await approve(context, record.id)
    const applied = await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })
    expect(applied.status).toBe(200)
    expect(applied.body.changeSet.status).toBe("applied")
    expect(applied.body.changeSet.preChange?.backupFolder).toBe("backup-2026-09-30-120000")
  })

  it("locks the change set during the backup so a reject or revise cannot race the apply", async () => {
    const context = setup()
    const { record } = await threeOperations(context)
    const preview = await approve(context, record.id)
    const answers: number[] = []
    const api = context.deps.api
    context.deps.api = async (path, tenantId, body) => {
      if (path === "/api/backup/status") {
        answers.push((await context.post({ action: "reject", id: record.id })).status)
        answers.push((await context.post({ action: "revise", id: record.id, removeKeys: ["op-3"] })).status)
      }
      return api(path, tenantId, body)
    }
    const applied = (await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })).body.changeSet as ChangeSetRecord
    expect(answers).toEqual([409, 409])
    expect(applied.status).toBe("applied")
  })

  it("hands the change set back unchanged when the target cannot be read before writing", async () => {
    const context = setup()
    const { record } = await threeOperations(context)
    const preview = await approve(context, record.id)
    context.tenant.denyPolicyReads = true
    const applied = await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })
    expect(applied.status).toBe(403)
    const stored = (await context.post({ action: "get", id: record.id })).body.changeSet as ChangeSetRecord
    expect(stored.status).toBe("approved")
    expect(stored.lastError).toContain("nothing was written")
    expect(context.tenant.writeCount()).toBe(0)
  })

  it("keeps interrupted writes uncertain and reconciles them on retry without repeating verified writes", async () => {
    const context = setup()
    const { record, existing } = await threeOperations(context)
    const preview = await approve(context, record.id)
    // The update lands; the create is sent and applied but its response is lost; the delete is never sent.
    context.tenant.failWrite = (method) => (method === "POST" ? "lost" : method === "DELETE" ? "throw" : undefined)
    const first = (await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })).body.changeSet as ChangeSetRecord
    expect(first.status).toBe("uncertain")
    expect(first.results["op-1"]!.status).toBe("verified")
    expect(first.results["op-2"]!.status).toBe("uncertain")
    expect(first.results["op-3"]!.status).toBe("uncertain")
    const putsBefore = context.tenant.writeCount((entry) => entry.method === "PUT")
    const postsBefore = context.tenant.writeCount((entry) => entry.method === "POST")

    context.tenant.failWrite = undefined
    const retried = (await context.post({ action: "retry", id: record.id, contentHash: preview.contentHash, confirm: true })).body.changeSet as ChangeSetRecord
    expect(retried.status).toBe("applied")
    // The verified update is not written again; the lost create is found by name and not repeated.
    expect(context.tenant.writeCount((entry) => entry.method === "PUT")).toBe(putsBefore)
    expect(context.tenant.writeCount((entry) => entry.method === "POST")).toBe(postsBefore)
    expect(retried.results["op-2"]!.message).toContain("not written again")
    expect([...context.tenant.policies.values()].filter((policy) => policy.name === "New firewall policy")).toHaveLength(1)
    // The delete never reached Graph; live still held the captured state, so it was written once.
    expect(context.tenant.writeCount((entry) => entry.method === "DELETE")).toBe(2)
    expect(context.tenant.policies.get(existing.id as string)?.description).toBe("Hardened")
    expect(retried.attempts).toBe(2)
    expect(context.backups).toEqual([TENANT_A])
  })

  it("keeps a partly written update uncertain on retry and includes it in rollback", async () => {
    const context = setup()
    const existing = context.tenant.addPolicy({ name: "Defender baseline" })
    const assignments = [{ target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget", deviceAndAppManagementAssignmentFilterId: null, deviceAndAppManagementAssignmentFilterType: "none" } }]
    const proposed: Item = { ...structuredClone(existing), description: "Hardened" }
    const record = await createChangeSet(context.deps, TENANT_A, { title: "Harden and assign", operations: [{ folder: "ConfigurationPolicies", action: "update", targetId: existing.id as string, proposed, assignments }] }, "Admin")
    const preview = await approve(context, record.id)
    // The configuration is written; the assignment call never reaches Graph.
    context.tenant.failWrite = (_method, path) => (path.endsWith("/assign") ? "throw" : undefined)
    const first = (await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })).body.changeSet as ChangeSetRecord
    expect(first.results["op-1"]!.status).toBe("uncertain")
    expect(context.tenant.policies.get(existing.id as string)?.description).toBe("Hardened")

    for (let attempt = 0; attempt < 2; attempt++) {
      const retried = (await context.post({ action: "retry", id: record.id, contentHash: preview.contentHash, confirm: true })).body.changeSet as ChangeSetRecord
      expect(retried.status).toBe("uncertain")
      expect(retried.results["op-1"]!.status).toBe("uncertain")
      expect(retried.results["op-1"]!.message).toContain("may have written part of the update")
      expect(retried.results["op-1"]!.message).not.toContain("Nothing was written")
    }

    const rollbackPreview = await context.post({ action: "rollback-preview", id: record.id })
    expect(rollbackPreview.body.operations.map((operation: { key: string; action: string }) => [operation.key, operation.action])).toEqual([["op-1", "update"]])
    context.tenant.failWrite = undefined
    const rollback = (await context.post({ action: "rollback-create", id: record.id })).body.changeSet as ChangeSetRecord & { id: string }
    const rollbackReview = await approve(context, rollback.id)
    const applied = (await context.post({ action: "apply", id: rollback.id, contentHash: rollbackReview.contentHash, confirm: true })).body.changeSet as ChangeSetRecord
    expect(applied.status).toBe("applied")
    expect(context.tenant.policies.get(existing.id as string)?.description).toBe("")
  })

  it("records a denied read-back as uncertain, not verified", async () => {
    const context = setup()
    const { record } = await threeOperations(context)
    const preview = await approve(context, record.id)
    const original = context.tenant.graph.bind(context.tenant)
    let writes = 0
    context.tenant.graph = (journaled: boolean) => {
      const inner = original(journaled)
      return async (method, path, body) => {
        if (method !== "GET") writes += 1
        // After the first write, detail reads are denied.
        context.tenant.denyPolicyReads = writes > 0
        return inner(method, path, body)
      }
    }
    const applied = (await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })).body.changeSet as ChangeSetRecord
    expect(applied.results["op-1"]!.status).toBe("uncertain")
    expect(applied.results["op-1"]!.readBack).toBe("denied")
    expect(applied.status).toBe("uncertain")
  })

  it("drops old change sets that never wrote and nothing refers to instead of failing at the record cap", async () => {
    const context = setup()
    const ids = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
    const contentIds = (index: number) => `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`
    const changeSet = (index: number, status: string, extra: Record<string, unknown> = {}) => ({ id: ids(index), title: `Old ${index}`, status, summary: "", kind: "change", origin: { workflow: "standard-adoption", recordId: null }, targetTenantId: TENANT_A, sourceTenantId: null, sourceVersion: null, ticket: null, operations: [], dependencies: [], proposalId: contentIds(index), review: null, preChange: null, results: {}, rollbackOf: null, attempts: 0, lastError: null, contentHash: "x", ...extra })
    const sets = Array.from({ length: MAX_RECORDS }, (_, index) => index === 0 ? changeSet(0, "applied", { preChange: { capturedAt: "2026-01-01T00:00:00Z", backupFolder: "b", captureId: contentIds(MAX_RECORDS), objects: [] } }) : index === 1 ? changeSet(1, "in-review") : changeSet(index, index % 2 ? "rejected" : "stale"))
    seedRecords(context.deps, DOMAINS.changeSets, TENANT_A, sets)
    seedRecords(context.deps, CONTENT_DOMAIN, TENANT_A, [...sets.map((entry) => ({ id: entry.proposalId, title: "", status: "frozen", summary: "", kind: "proposal", changeSetId: null, entries: {} })), { id: contentIds(MAX_RECORDS), title: "", status: "frozen", summary: "", kind: "capture", changeSetId: ids(0), entries: {} }].slice(0, MAX_RECORDS))
    // A workflow still names this stale change set as pending.
    seedRecords(context.deps, DOMAINS.adoptions, TENANT_A, [{ id: "aaaaaaaa-0000-4000-8000-000000000001", title: "Adoption", status: "change-set", summary: "", pending: { changeSetId: ids(2) } }])

    const { record } = await threeOperations(context)
    expect(record.status).toBe("in-review")
    const kept = new Set(listChangeSets(context.deps, TENANT_A).map((entry) => entry.id))
    expect(kept.size).toBeLessThanOrEqual(KEPT_CHANGE_SETS + 1)
    for (const id of [ids(0), ids(1), ids(2), record.id]) expect(kept.has(id)).toBe(true)
    const content = new Set(context.deps.records.list(CONTENT_DOMAIN, TENANT_A).map((entry) => entry.id))
    expect(content.has(record.proposalId)).toBe(true)
    expect(content.has(contentIds(1))).toBe(true)
    expect(content.has(contentIds(2))).toBe(true)
    expect(content.has(contentIds(3))).toBe(false)
  })

  it("isolates tenants: another tenant cannot read or apply a change set", async () => {
    const context = setup()
    const { record } = await threeOperations(context)
    const preview = await approve(context, record.id)
    expect((await context.post({ action: "get", id: record.id }, TENANT_B)).status).toBe(404)
    expect((await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true }, TENANT_B)).status).toBe(404)
    expect((await context.post({ action: "list" }, TENANT_B)).body.changeSets).toEqual([])
    expect(context.other.calls).toEqual([])
    expect(context.deps.records.list(DOMAINS.changeSets, TENANT_B)).toEqual([])
  })

  it("rejects unsupported operation types and redacted content", async () => {
    const context = setup()
    await expect(createChangeSet(context.deps, TENANT_A, { title: "x", operations: [{ folder: "GroupPolicyConfigurations", action: "create", proposed: { displayName: "x" } }] }, null)).rejects.toThrow(/do not support/)
    await expect(createChangeSet(context.deps, TENANT_A, { title: "x", operations: [{ folder: "ConfigurationPolicies", action: "create", proposed: { name: "x", secret: REDACTED } }] }, null)).rejects.toThrow(/redacted/)
  })

  it("rolls back through a separately reviewed change set with read-back", async () => {
    const context = setup()
    const { record, existing, doomed } = await threeOperations(context)
    const preview = await approve(context, record.id)
    await context.post({ action: "apply", id: record.id, contentHash: preview.contentHash, confirm: true })
    const created = [...context.tenant.policies.values()].find((policy) => policy.name === "New firewall policy")!

    const rollbackPreview = await context.post({ action: "rollback-preview", id: record.id })
    expect(rollbackPreview.status).toBe(200)
    expect(rollbackPreview.body.operations.map((operation: { action: string }) => operation.action)).toEqual(["update", "delete", "create"])
    expect(rollbackPreview.body.notice).toContain("not an atomic transaction")
    expect(context.tenant.writeCount()).toBe(3)

    const rollback = (await context.post({ action: "rollback-create", id: record.id })).body.changeSet as ChangeSetRecord & { id: string }
    expect(rollback.kind).toBe("rollback")
    expect(rollback.status).toBe("in-review")
    // A rollback is never applied without its own approval.
    expect((await context.post({ action: "apply", id: rollback.id, contentHash: rollback.contentHash, confirm: true })).status).toBe(409)
    const rollbackReview = await approve(context, rollback.id)
    const applied = (await context.post({ action: "apply", id: rollback.id, contentHash: rollbackReview.contentHash, confirm: true })).body.changeSet as ChangeSetRecord
    expect(applied.status).toBe("applied")
    expect(context.tenant.policies.get(existing.id as string)?.description).toBe("")
    expect(context.tenant.policies.has(created.id as string)).toBe(false)
    const recreated = [...context.tenant.policies.values()].filter((policy) => policy.name === "Old policy")
    expect(recreated).toHaveLength(1)
    expect(recreated[0]!.id).not.toBe(doomed.id)
    expect(context.backups).toEqual([TENANT_A, TENANT_A])
  })
})

describe("change-set Graph writes against recorded lab responses", () => {
  // Recorded in the lab (redacted): deleting a Settings Catalog policy that is already gone answers
  // 400 ResourceNotFound, not 404, like the detail read does.
  const alreadyDeleted = { status: 400, body: { error: { code: "ResourceNotFound", message: JSON.stringify({ _version: 3, Message: "An error has occurred - Operation ID (for customer support): 00000000-0000-0000-0000-000000000000 - Activity ID: redacted - Url: https://proxy.redacted/DeviceConfigV2/DCV2GraphService/redacted/deviceManagement/configurationPolicies('00000000-0000-0000-0000-00000000e2e1')?api-version=5026-05-26", CustomApiErrorPhrase: "", RetryAfter: null, ErrorSourceService: "", HttpHeaders: "{}" }) } } }

  it("treats a delete of a Settings Catalog policy that is already gone as written, for read-back to confirm", async () => {
    const calls: string[] = []
    const outcome = await writeOperation(async (method, path) => {
      calls.push(`${method} ${path}`)
      return structuredClone(alreadyDeleted)
    }, POLICIES, { action: "delete", targetId: "00000000-0000-0000-0000-00000000e2e1", proposed: null, assignments: null, current: null }, () => {})
    expect(outcome).toEqual({ state: "written", objectId: "00000000-0000-0000-0000-00000000e2e1" })
    expect(calls).toEqual(["DELETE deviceManagement/configurationPolicies/00000000-0000-0000-0000-00000000e2e1"])
  })

  it("still rejects other 400 answers to a delete", async () => {
    const outcome = await writeOperation(async () => ({ status: 400, body: { error: { code: "BadRequest", message: "Policy is in use" } } }), POLICIES, { action: "delete", targetId: "00000000-0000-0000-0000-00000000e2e1", proposed: null, assignments: null, current: null }, () => {})
    expect(outcome).toEqual({ state: "rejected", objectId: "00000000-0000-0000-0000-00000000e2e1", message: "Policy is in use" })
  })

  it("refuses to freeze Intune secret values or masks as they are read, so they are never written back", async () => {
    // Recorded in the lab (token redacted): a Settings Catalog secret reads back as an encrypted value token.
    const secret = { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSecretSettingValue", settingValueTemplateReference: null, value: "00000000-0000-0000-0000-0000000000aa", valueState: "encryptedValueToken" }
    const policy = (value: Item) => ({ name: "x", platforms: "macOS", technologies: "mdm,appleRemoteManagement", settings: [{ id: "0", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance", settingDefinitionId: "com.apple.profileremovalpassword_com.apple.profileremovalpassword", groupSettingCollectionValue: [{ children: [{ "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: "com.apple.profileremovalpassword_removalpassword", simpleSettingValue: value }] }] } }] })
    const context = setup()
    await expect(createChangeSet(context.deps, TENANT_A, { title: "x", operations: [{ folder: "ConfigurationPolicies", action: "create", proposed: policy(secret) }] }, null)).rejects.toThrow(/secret/)
    await expect(createChangeSet(context.deps, TENANT_A, { title: "x", operations: [{ folder: "ConfigurationPolicies", action: "create", proposed: policy({ "@odata.type": "#microsoft.graph.deviceManagementConfigurationStringSettingValue", value: "****" }) }] }, null)).rejects.toThrow(/secret/)
    expect(context.tenant.writeCount()).toBe(0)
  })
})
