import { describe, expect, it } from "vitest"
import { routes as syncRoutes } from "../src/main/features/sync"
import { routes as promotionRoutes } from "../src/main/features/promotion"
import { applyChangeSet, approveChangeSet, createChangeSet, previewChangeSet } from "../src/main/features/change-sets/engine"
import type { ChangeSetRecord } from "../src/main/features/change-sets/model"
import { DOMAINS } from "../src/main/features/domains"
import { FeatureError } from "../src/main/features/route"
import { PROMOTION_NOT_FOUND, type PromotionRecord } from "../src/main/features/promotion/engine"
import type { SyncRunRecord } from "../src/main/features/sync/engine"
import { recordSyncLinks, syncLinks } from "../src/main/features/sync/links"
import { planGuard, requiredFeatures } from "../src/main/api/plan-gates"
import { upgradeMessage, type Plan } from "../src/shared/plans"
import { call, fakeDeps, TENANT_A, TENANT_B, TENANT_C } from "./feature-helpers"
import { FakeTenant, referenceSetting, setting, wire } from "./feature-change-sets-fakes"

const PATH = "/api/sync"
const TENANT_D = "44444444-4444-4444-4444-444444444444"
const MSP: Record<string, Plan> = { [TENANT_A]: "msp", [TENANT_B]: "msp", [TENANT_C]: "msp", [TENANT_D]: "msp" }

/** TENANT_A is the source; TENANT_B, TENANT_C and TENANT_D are targets. */
function setup(options: { plans?: Record<string, Plan>; sameLicense?: boolean } = {}) {
  let sameLicense = options.sameLicense ?? true
  const deps = fakeDeps({ plans: options.plans ?? { [TENANT_A]: "pro", [TENANT_B]: "pro" }, sameLicense: () => sameLicense })
  const source = new FakeTenant(TENANT_A)
  const targets: Record<string, FakeTenant> = { [TENANT_B]: new FakeTenant(TENANT_B), [TENANT_C]: new FakeTenant(TENANT_C), [TENANT_D]: new FakeTenant(TENANT_D) }
  const wired = wire(deps, [source, ...Object.values(targets)])
  const audit: Array<{ tenantId: string; logEntry: { eventType: string; details: Record<string, unknown> } }> = []
  const api = deps.api
  deps.api = async (path, tenantId, body, apiOptions) => {
    if (path === "/api/audit/log") audit.push({ tenantId, logEntry: (body as { logEntry: never }).logEntry })
    return api(path, tenantId, body, apiOptions)
  }
  const policy = source.addPolicy({ name: "OIB Defender" })
  const sync = syncRoutes(deps)
  const promotion = promotionRoutes(deps)
  const post = (body: Record<string, unknown>) => call(sync, PATH, body)
  const promote = (body: Record<string, unknown>) => call(promotion, "/api/promotion", body)
  const setSameLicense = (value: boolean) => { sameLicense = value }
  return { deps, source, targets, policy, post, promote, audit, setSameLicense, ...wired }
}

type Context = ReturnType<typeof setup>

const named = (ids: string[]) => ids.map((tenantId) => ({ tenantId }))

function plan(context: Context, targets: string[] = [TENANT_B], extra: Record<string, unknown> = {}) {
  return context.post({ tenantId: TENANT_A, action: "plan", targetTenants: named(targets), title: "Sync Defender", items: [{ sourceId: context.policy.id, folder: "ConfigurationPolicies" }], ...extra })
}

async function planned(context: Context, targets: string[] = [TENANT_B]) {
  const response = await plan(context, targets)
  expect(response.status).toBe(200)
  return response.body as { run: SyncRunRecord & { id: string }; targets: Array<{ targetTenantId: string; promotion: (PromotionRecord & { id: string }) | null; error: string | null }> }
}

async function approved(context: Context, target: string, id: string) {
  const preview = await context.post({ tenantId: target, action: "preview", id })
  expect(preview.status).toBe(200)
  const approval = await context.post({ tenantId: target, action: "approve", id, contentHash: preview.body.changeSet.contentHash, targetFingerprint: preview.body.changeSet.targetFingerprint })
  expect(approval.status).toBe(200)
  return preview.body.changeSet.contentHash as string
}

async function applied(context: Context, target: string, id: string, extra: Record<string, unknown> = {}) {
  const contentHash = await approved(context, target, id)
  return context.post({ tenantId: target, action: "apply", id, contentHash, confirm: true, ...extra })
}

/** Plans and applies one Sync of the policy to each target; returns the promotion IDs by target. */
async function synced(context: Context, targets: string[] = [TENANT_B], extra: Record<string, unknown> = {}) {
  const { targets: results } = await planned(context, targets)
  const ids: Record<string, string> = {}
  for (const result of results) {
    expect(result.error).toBeNull()
    const response = await applied(context, result.targetTenantId, result.promotion!.id, extra)
    expect(response.status).toBe(200)
    ids[result.targetTenantId] = result.promotion!.id
  }
  return ids
}

const changeSets = (context: Context, tenantId: string) => context.deps.records.list<ChangeSetRecord>(DOMAINS.changeSets, tenantId)
const status = (context: Context, targets: string[] = [TENANT_B]) => context.post({ tenantId: TENANT_A, action: "status", targetTenants: named(targets) })
const guardRequest = (body: Record<string, unknown>) => new Request(`http://tenuvault.internal${PATH}`, { method: "POST", body: JSON.stringify(body) })

describe("/api/sync plans", () => {
  it("A1: refuses plan and status on Community and keeps stored runs readable", async () => {
    const context = setup()
    const { run, targets } = await planned(context)
    context.deps.plan = async () => "community"
    for (const action of ["plan", "status"]) {
      const response = await context.post({ tenantId: TENANT_A, action, targetTenants: named([TENANT_B]), title: "x", items: [{ sourceId: context.policy.id }] })
      expect(response.status).toBe(402)
      expect(response.body.upgrade).toBe("sync")
    }
    expect((await context.post({ tenantId: TENANT_B, action: "preview", id: targets[0]!.promotion!.id })).status).toBe(402)
    const runs = await context.post({ tenantId: TENANT_A, action: "list-runs" })
    expect(runs.status).toBe(200)
    expect(runs.body.runs.map((entry: { id: string }) => entry.id)).toEqual([run.id])
    expect(runs.body.runs[0]).not.toHaveProperty("history")
    const detail = await context.post({ tenantId: TENANT_A, action: "get-run", id: run.id })
    expect(detail.status).toBe(200)
    expect(detail.body.targets[0]).toMatchObject({ targetTenantId: TENANT_B, promotionId: targets[0]!.promotion!.id, promotion: { id: targets[0]!.promotion!.id }, changeSet: { origin: { workflow: "sync" } }, rollbackChangeSet: null })
    expect((await context.post({ tenantId: TENANT_B, action: "get-target", id: targets[0]!.promotion!.id })).status).toBe(200)
    expect(requiredFeatures(PATH, { action: "plan" })).toEqual(["sync"])
    expect(requiredFeatures(PATH, { action: "list-runs", targetTenants: named([TENANT_B, TENANT_C]) })).toEqual([])
    expect((await planGuard(async () => "community")(guardRequest({ tenantId: TENANT_A, action: "status", targetTenants: named([TENANT_B]) })))?.status).toBe(402)
    expect(await planGuard(async () => "community")(guardRequest({ tenantId: TENANT_A, action: "get-run", id: run.id }))).toBeNull()
  })

  it("A2: syncs one policy to the other tenant of a Pro license", async () => {
    const context = setup()
    const { run, targets } = await planned(context)
    expect(run.status).toBe("planned")
    expect(run.items).toEqual([{ folder: "ConfigurationPolicies", sourceId: context.policy.id, sourceName: "OIB Defender" }])
    expect(targets).toHaveLength(1)
    const promotion = targets[0]!.promotion!
    expect(promotion.sync).toEqual({ runId: run.id })
    expect(promotion.status).toBe("in-review")
    const response = await applied(context, TENANT_B, promotion.id)
    expect(response.status).toBe(200)
    expect(response.body.promotion.status).toBe("applied")
    expect(context.deps.records.list(DOMAINS.syncRuns, TENANT_A)).toHaveLength(1)
    expect(context.deps.records.list(DOMAINS.promotions, TENANT_B)).toHaveLength(1)
    expect(changeSets(context, TENANT_B)).toHaveLength(1)
    expect(changeSets(context, TENANT_B)[0]!.origin).toEqual({ workflow: "sync", recordId: promotion.id })
    expect([...context.targets[TENANT_B]!.policies.values()].map((policy) => policy.name)).toEqual(["OIB Defender"])
    expect(context.backups).toEqual([TENANT_B])
    expect(context.source.writeCount()).toBe(0)
    // Approval passes no reviewer and no note; the engine names the actor.
    expect(changeSets(context, TENANT_B)[0]!.review).toMatchObject({ reviewer: "Admin", note: null })
  })

  it("A3: needs MSP for two targets or a target outside the Pro license, in the guard and the handler", async () => {
    const two = setup({ plans: { [TENANT_A]: "pro", [TENANT_B]: "pro", [TENANT_C]: "pro" } })
    const refused = await plan(two, [TENANT_B, TENANT_C])
    expect(refused.status).toBe(402)
    expect(refused.body).toEqual({ error: upgradeMessage("bulkActions"), upgrade: "bulkActions" })
    const body = { tenantId: TENANT_A, action: "plan", targetTenants: named([TENANT_B, TENANT_C]) }
    expect(requiredFeatures(PATH, body)).toEqual(["sync", "bulkActions"])
    const guarded = await planGuard(async () => "pro")(guardRequest(body))
    expect(guarded?.status).toBe(402)
    expect(await guarded!.json()).toEqual({ error: upgradeMessage("bulkActions"), upgrade: "bulkActions" })
    expect((await planGuard(async (id) => (id === TENANT_C ? "pro" : "msp"))(guardRequest(body)))?.status).toBe(402)
    expect(await planGuard(async () => "msp")(guardRequest(body))).toBeNull()
    expect(await planGuard(async () => "pro")(guardRequest({ ...body, targetTenants: named([TENANT_B]) }))).toBeNull()
    expect((await status(two, [TENANT_B, TENANT_C])).status).toBe(402)

    const outside = setup({ sameLicense: false })
    const response = await plan(outside)
    expect(response.status).toBe(402)
    expect(response.body.upgrade).toBe("bulkActions")
    expect(outside.deps.records.list(DOMAINS.syncRuns, TENANT_A)).toHaveLength(0)
    // A target planned inside the license is refused once the pair no longer shares it.
    const later = setup()
    const { targets } = await planned(later)
    later.setSameLicense(false)
    const preview = await later.post({ tenantId: TENANT_B, action: "preview", id: targets[0]!.promotion!.id })
    expect(preview.status).toBe(402)
    expect(preview.body.upgrade).toBe("bulkActions")
    expect(two.targets[TENANT_B]!.writeCount() + outside.targets[TENANT_B]!.writeCount() + later.targets[TENANT_B]!.writeCount()).toBe(0)
  })

  it("validates targets: distinct, not the source, connected and at most 25", async () => {
    const context = setup({ plans: MSP })
    expect((await plan(context, [TENANT_B, TENANT_B])).status).toBe(400)
    expect((await plan(context, [TENANT_A])).status).toBe(400)
    expect((await plan(context, [])).status).toBe(400)
    expect((await context.post({ tenantId: TENANT_A, action: "plan", title: "x", items: [{ sourceId: context.policy.id }] })).status).toBe(400)
    const many = Array.from({ length: 26 }, (_, index) => `55555555-5555-5555-5555-${String(index).padStart(12, "0")}`)
    expect((await context.post({ tenantId: TENANT_A, action: "plan", targetTenants: many.map((tenantId) => ({ tenantId })), title: "x", items: [{ sourceId: context.policy.id }] })).status).toBe(403)
    const stranger = "66666666-6666-6666-6666-666666666666"
    expect((await plan(context, [TENANT_B, stranger])).status).toBe(403)
    // More than 25 targets is refused before the route reads 26 plans; requireSyncTenants holds the limit.
    const { requireSyncTenants } = await import("../src/main/features/sync/tenants")
    await expect(requireSyncTenants(context.deps, TENANT_A, many)).rejects.toThrow(/at most 25/)
    expect((await plan(context, [TENANT_B], { items: [] })).status).toBe(400)
    expect((await plan(context, [TENANT_B], { items: [{ sourceId: context.policy.id, folder: "GroupPolicyConfigurations" }] })).status).toBe(400)
    expect((await plan(context, [TENANT_B], { mappings: { [TENANT_C]: [] } })).status).toBe(400)
    expect(context.deps.records.list(DOMAINS.syncRuns, TENANT_A)).toHaveLength(0)
  })

  it("A4: applies every target on its own; a failing target never stops or rolls back the others", async () => {
    const context = setup({ plans: MSP })
    const { run, targets } = await planned(context, [TENANT_B, TENANT_C, TENANT_D])
    expect(run.targets.map((target) => target.targetTenantId)).toEqual([TENANT_B, TENANT_C, TENANT_D])
    expect(targets.every((target) => target.error === null && target.promotion?.status === "in-review")).toBe(true)
    // Graph rejects the write with 400, so nothing is written in that target.
    context.targets[TENANT_C]!.failWrite = () => 400
    const results: Record<string, string> = {}
    for (const target of targets) {
      const response = await applied(context, target.targetTenantId, target.promotion!.id)
      expect(response.status).toBe(200)
      results[target.targetTenantId] = response.body.changeSet.status
    }
    expect(results).toEqual({ [TENANT_B]: "applied", [TENANT_C]: "failed", [TENANT_D]: "applied" })
    expect(context.targets[TENANT_B]!.policies.size).toBe(1)
    expect(context.targets[TENANT_C]!.policies.size).toBe(0)
    expect(context.targets[TENANT_D]!.policies.size).toBe(1)
    for (const target of [TENANT_B, TENANT_C, TENANT_D]) {
      expect(changeSets(context, target)).toHaveLength(1)
      expect(changeSets(context, target).some((changeSet) => changeSet.kind === "rollback")).toBe(false)
      expect(context.targets[target]!.writeCount((entry) => entry.method === "DELETE")).toBe(0)
      expect(context.deps.records.list(DOMAINS.promotions, target)).toHaveLength(1)
    }
    expect(Object.keys(syncLinks(context.deps, TENANT_B, TENANT_A))).toHaveLength(1)
    expect(Object.keys(syncLinks(context.deps, TENANT_C, TENANT_A))).toHaveLength(0)
    expect(Object.keys(syncLinks(context.deps, TENANT_D, TENANT_A))).toHaveLength(1)
  })

  it("names targets blocked by findings in the run summary", async () => {
    const context = setup()
    const reusable = "aaaaaaaa-0000-0000-0000-00000000000a"
    context.source.reusable = [{ id: reusable, displayName: "Signing cert" }]
    const epm = context.source.addPolicy({ name: "OIB EPM", settings: [setting("epm_appliesto", "epm_allusers"), referenceSetting(reusable)] })
    const response = await plan(context, [TENANT_B], { items: [{ sourceId: epm.id }] })
    expect(response.status).toBe(200)
    expect(response.body.targets[0].promotion).toMatchObject({ status: "blocked", changeSetId: null })
    expect(response.body.run).toMatchObject({ status: "planned", summary: "1 of 1 target planned, 1 blocked by findings." })
    expect(changeSets(context, TENANT_B)).toHaveLength(0)
  })

  it("plans the other targets when one target cannot be planned", async () => {
    const context = setup({ plans: { ...MSP, [TENANT_C]: "community" } })
    // TENANT_C has no Sync plan, so the route refuses the whole run before anything is stored.
    expect((await plan(context, [TENANT_B, TENANT_C])).status).toBe(402)
    context.deps.plan = async () => "msp"
    const graph = context.deps.graph
    context.deps.graph = async (tenantId, options) => {
      if (tenantId === TENANT_C) throw new Error("Sign in again to use this tenant.")
      return graph(tenantId, options)
    }
    const { run, targets } = await planned(context, [TENANT_B, TENANT_C, TENANT_D])
    expect(run.status).toBe("partial")
    expect(run.summary).toBe("2 of 3 targets planned; 1 could not be planned.")
    const failed = targets.find((target) => target.targetTenantId === TENANT_C)!
    expect(failed.promotion).toBeNull()
    expect(failed.error).toContain("Sign in again to use this tenant.")
    expect(run.targets.find((target) => target.targetTenantId === TENANT_C)).toEqual({ targetTenantId: TENANT_C, promotionId: null, error: failed.error })
    expect(targets.filter((target) => target.promotion?.status === "in-review").map((target) => target.targetTenantId)).toEqual([TENANT_B, TENANT_D])
  })
})

describe("Sync links", () => {
  it("A5: a second Sync of the same policy updates the linked object", async () => {
    const context = setup()
    await synced(context)
    const [created] = [...context.targets[TENANT_B]!.policies.values()]
    const link = syncLinks(context.deps, TENANT_B, TENANT_A)[`ConfigurationPolicies:${(context.policy.id as string).toLowerCase()}`]!
    expect(link).toMatchObject({ targetPolicyId: created!.id, sourceName: "OIB Defender", targetName: "OIB Defender" })
    expect(link.targetHash).toMatch(/^[0-9a-f]{64}$/)
    context.source.policies.get(context.policy.id as string)!.description = "Edited in the source"
    const { targets } = await planned(context)
    const item = targets[0]!.promotion!.items[0]!
    expect(item).toMatchObject({ action: "update", destinationId: created!.id })
    expect(item.findings.some((finding) => finding.code === "sync-link-missing")).toBe(false)
    const response = await applied(context, TENANT_B, targets[0]!.promotion!.id)
    expect(response.body.changeSet.status).toBe("applied")
    const policies = [...context.targets[TENANT_B]!.policies.values()].filter((policy) => policy.name === "OIB Defender")
    expect(policies).toHaveLength(1)
    expect(policies[0]!.description).toBe("Edited in the source")
    expect(syncLinks(context.deps, TENANT_B, TENANT_A)[`ConfigurationPolicies:${(context.policy.id as string).toLowerCase()}`]!.promotionId).toBe(targets[0]!.promotion!.id)
    expect(context.deps.records.list(DOMAINS.syncLinks, TENANT_B)).toHaveLength(1)
  })

  it("never lets an older Sync of the pair replace the link a later Sync recorded", async () => {
    const context = setup()
    const key = `ConfigurationPolicies:${(context.policy.id as string).toLowerCase()}`
    context.deps.now = () => new Date("2026-09-30T12:00:00Z")
    const first = (await synced(context))[TENANT_B]!
    context.source.policies.get(context.policy.id as string)!.description = "Edited in the source"
    context.deps.now = () => new Date("2026-09-30T13:00:00Z")
    const second = (await synced(context))[TENANT_B]!
    const latest = syncLinks(context.deps, TENANT_B, TENANT_A)[key]!
    expect(latest.promotionId).toBe(second)
    // Applying the first target again is refused before any attempt and records nothing.
    const hash = changeSets(context, TENANT_B).find((changeSet) => changeSet.origin.recordId === first)!.contentHash
    expect((await context.post({ tenantId: TENANT_B, action: "apply", id: first, contentHash: hash, confirm: true })).status).toBe(409)
    expect(syncLinks(context.deps, TENANT_B, TENANT_A)[key]).toEqual(latest)
    // Re-recording the first target's verified results never replaces the later link.
    expect(await recordSyncLinks(context.deps, TENANT_B, first)).toBe(0)
    expect(syncLinks(context.deps, TENANT_B, TENANT_A)[key]).toEqual(latest)
  })

  it("A6: creates the policy again with a warning when the linked object was deleted", async () => {
    const context = setup()
    await synced(context)
    const [created] = [...context.targets[TENANT_B]!.policies.keys()]
    // Settings Catalog answers a read of a deleted policy with 400 ResourceNotFound.
    const graph = context.deps.graph
    context.deps.graph = async (tenantId, options) => {
      const reader = await graph(tenantId, options)
      return async (method, path, body, callOptions) => tenantId === TENANT_B && method === "GET" && path.startsWith(`deviceManagement/configurationPolicies/${created}`)
        ? { status: 400, body: { error: { code: "BadRequest", message: "{\"ErrorCode\":\"ResourceNotFound\"}" } } }
        : reader(method, path, body, callOptions)
    }
    context.targets[TENANT_B]!.policies.delete(created!)
    const { targets } = await planned(context)
    const promotion = targets[0]!.promotion!
    expect(promotion.status).toBe("in-review")
    expect(promotion.items[0]).toMatchObject({ action: "create", destinationId: null, blocked: false })
    expect(promotion.items[0]!.findings).toContainEqual(expect.objectContaining({ code: "sync-link-missing", severity: "warning" }))
    expect((await applied(context, TENANT_B, promotion.id)).body.changeSet.status).toBe("applied")
    const [recreated] = [...context.targets[TENANT_B]!.policies.keys()]
    expect(recreated).not.toBe(created)
    expect(syncLinks(context.deps, TENANT_B, TENANT_A)[`ConfigurationPolicies:${(context.policy.id as string).toLowerCase()}`]!.targetPolicyId).toBe(recreated)
  })

  it("fails only the target whose linked object cannot be read", async () => {
    const context = setup({ plans: MSP })
    await synced(context, [TENANT_B, TENANT_C, TENANT_D])
    context.targets[TENANT_C]!.denyPolicyReads = true
    const { run, targets } = await planned(context, [TENANT_B, TENANT_C, TENANT_D])
    expect(run.status).toBe("partial")
    const failed = targets.find((target) => target.targetTenantId === TENANT_C)!
    expect(failed.promotion).toBeNull()
    expect(failed.error).toContain("Access denied")
    for (const target of targets.filter((entry) => entry.targetTenantId !== TENANT_C)) expect(target.promotion!.items[0]!.action).toBe("update")
    expect(context.targets[TENANT_C]!.policies.size).toBe(1)
  })

  it("A7: links only verified writes; a retry that verifies writes the link", async () => {
    const failed = setup()
    failed.targets[TENANT_B]!.failWrite = () => 400
    const first = await planned(failed)
    expect((await applied(failed, TENANT_B, first.targets[0]!.promotion!.id)).body.changeSet.status).toBe("failed")
    expect(syncLinks(failed.deps, TENANT_B, TENANT_A)).toEqual({})

    const context = setup()
    context.targets[TENANT_B]!.failWrite = (method) => (method === "POST" ? "lost" : undefined)
    const { targets } = await planned(context)
    const id = targets[0]!.promotion!.id
    const contentHash = await approved(context, TENANT_B, id)
    const uncertain = await context.post({ tenantId: TENANT_B, action: "apply", id, contentHash, confirm: true })
    expect(uncertain.body.changeSet.status).toBe("uncertain")
    expect(syncLinks(context.deps, TENANT_B, TENANT_A)).toEqual({})
    context.targets[TENANT_B]!.failWrite = undefined
    const retried = await context.post({ tenantId: TENANT_B, action: "retry", id, contentHash, confirm: true })
    expect(retried.status).toBe(200)
    expect(retried.body.changeSet.status).toBe("applied")
    const [created] = [...context.targets[TENANT_B]!.policies.keys()]
    expect(context.targets[TENANT_B]!.policies.size).toBe(1)
    expect(Object.values(syncLinks(context.deps, TENANT_B, TENANT_A))).toEqual([expect.objectContaining({ targetPolicyId: created, promotionId: id, changeSetId: retried.body.changeSet.id })])
  })

  it("A8: reports in-sync, changed in the source and missing in the target", async () => {
    const context = setup()
    await synced(context)
    const before = await status(context)
    expect(before.status).toBe(200)
    expect(before.body.targets).toEqual([{ targetTenantId: TENANT_B, error: null, links: [expect.objectContaining({ folder: "ConfigurationPolicies", sourceId: (context.policy.id as string).toLowerCase(), state: "in-sync", changedIn: null, identical: true, error: null })] }])
    context.source.policies.get(context.policy.id as string)!.settings = [setting("device_vendor_msft_policy_config_defender_allowarchivescanning", "device_vendor_msft_policy_config_defender_allowarchivescanning_0")]
    const edited = await status(context)
    expect(edited.body.targets[0].links[0]).toMatchObject({ state: "changed", changedIn: "source", identical: false })
    const [created] = [...context.targets[TENANT_B]!.policies.keys()]
    context.targets[TENANT_B]!.policies.get(created!)!.description = "Edited in the target"
    expect((await status(context)).body.targets[0].links[0]).toMatchObject({ state: "changed", changedIn: "both" })
    context.targets[TENANT_B]!.policies.delete(created!)
    expect((await status(context)).body.targets[0].links[0]).toMatchObject({ state: "missing-in-target", changedIn: null, identical: null })
    expect(context.targets[TENANT_B]!.writeCount() + context.source.writeCount()).toBe(1)
  })
})

describe("Sync backups", () => {
  it("A9: skips the pre-change backup on request and keeps rollback available", async () => {
    const context = setup()
    const { targets } = await planned(context)
    const id = targets[0]!.promotion!.id
    expect((await context.post({ tenantId: TENANT_B, action: "apply", id, contentHash: "0".repeat(64), confirm: true, backup: "later" })).status).toBe(400)
    const response = await applied(context, TENANT_B, id, { backup: "none" })
    expect(response.status).toBe(200)
    expect(response.body.changeSet.status).toBe("applied")
    expect(context.backups).toEqual([])
    const changeSet = changeSets(context, TENANT_B)[0]!
    expect(changeSet.preChange).toMatchObject({ backupFolder: null })
    expect(changeSet.history.some((revision) => /Backup skipped and pre-change state captured/.test(revision.reason))).toBe(true)
    expect(changeSet.history.some((revision) => /running the pre-change backup|Backup succeeded/.test(revision.reason))).toBe(false)
    const rollback = await context.post({ tenantId: TENANT_B, action: "rollback-preview", id })
    expect(rollback.status).toBe(200)
    expect(rollback.body.operations).toEqual([expect.objectContaining({ action: "delete", blocked: null })])
    const entry = context.audit.find((logged) => logged.logEntry.details.source === "desktop-change-sets")!
    expect(entry.logEntry.details).toMatchObject({ workflow: "sync", backupSkipped: true, link: "/portal/changes/sync" })
    expect(entry.logEntry.details.backupFolder).toBeUndefined()
  })

  it("A10: refuses backup none for other workflows and for a Sync rollback; /api/promotion ignores it", async () => {
    for (const workflow of ["promotion", "baseline-upgrade", "cis-remediation"]) {
      const context = setup()
      const existing = context.targets[TENANT_B]!.addPolicy({ name: "Defender" })
      const record = await createChangeSet(context.deps, TENANT_B, { title: "Change", origin: { workflow: workflow === "cis-remediation" ? "change-sets" : workflow }, operations: [{ folder: "ConfigurationPolicies", action: "update", targetId: existing.id as string, proposed: { ...structuredClone(existing), description: "Hardened" } }] }, "Admin")
      const preview = await previewChangeSet(context.deps, TENANT_B, record.id)
      await approveChangeSet(context.deps, TENANT_B, record.id, { contentHash: preview.contentHash, targetFingerprint: preview.targetFingerprint }, "Admin")
      // CIS change sets need the CIS plan to be created; the origin is what the restriction reads.
      if (workflow === "cis-remediation") context.deps.records.update<ChangeSetRecord>(DOMAINS.changeSets, TENANT_B, record.id, (current) => ({ ...current, origin: { workflow, recordId: null } }), { actor: null, reason: "Test origin" })
      const error = await applyChangeSet(context.deps, TENANT_B, record.id, { contentHash: record.contentHash, confirmed: true, backup: "none" }, "Admin").catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(FeatureError)
      expect((error as FeatureError).status).toBe(400)
      expect(context.backups).toEqual([])
      expect(context.targets[TENANT_B]!.writeCount()).toBe(0)
      expect(changeSets(context, TENANT_B)[0]!.status).toBe("approved")
    }

    const context = setup()
    const ids = await synced(context)
    const id = ids[TENANT_B]!
    expect((await context.post({ tenantId: TENANT_B, action: "rollback-create", id })).status).toBe(200)
    const review = await context.post({ tenantId: TENANT_B, action: "rollback-review", id })
    expect((await context.post({ tenantId: TENANT_B, action: "rollback-approve", id, contentHash: review.body.contentHash, targetFingerprint: review.body.targetFingerprint })).status).toBe(200)
    const skipped = await context.post({ tenantId: TENANT_B, action: "rollback-apply", id, contentHash: review.body.contentHash, confirm: true, backup: "none" })
    expect(skipped.status).toBe(400)
    expect(context.backups).toEqual([TENANT_B])
    const rolledBack = await context.post({ tenantId: TENANT_B, action: "rollback-apply", id, contentHash: review.body.contentHash, confirm: true })
    expect(rolledBack.status).toBe(200)
    expect(rolledBack.body.changeSet.status).toBe("applied")
    expect(context.backups).toEqual([TENANT_B, TENANT_B])
    expect(context.targets[TENANT_B]!.policies.size).toBe(0)

    const promotion = setup()
    const plannedPromotion = await promotion.promote({ tenantId: TENANT_B, targetTenants: named([TENANT_A]), sourceTenantId: TENANT_A, action: "plan", title: "Promote", items: [{ sourceId: promotion.policy.id }] })
    const promotionId = plannedPromotion.body.promotion.id
    const preview = await promotion.promote({ tenantId: TENANT_B, targetTenants: named([TENANT_A]), sourceTenantId: TENANT_A, action: "preview", id: promotionId })
    await promotion.promote({ tenantId: TENANT_B, targetTenants: named([TENANT_A]), sourceTenantId: TENANT_A, action: "approve", id: promotionId, contentHash: preview.body.changeSet.contentHash, targetFingerprint: preview.body.changeSet.targetFingerprint })
    const promoted = await promotion.promote({ tenantId: TENANT_B, targetTenants: named([TENANT_A]), sourceTenantId: TENANT_A, action: "apply", id: promotionId, contentHash: preview.body.changeSet.contentHash, confirm: true, backup: "none" })
    expect(promoted.status).toBe(200)
    expect(promoted.body.promotion.status).toBe("applied")
    expect(promotion.backups).toEqual([TENANT_B])
    expect(changeSets(promotion, TENANT_B)[0]!.preChange!.backupFolder).toBe("backup-2026-09-30-120000")
  })
})

describe("Sync and Dev to Prod stay apart", () => {
  it("A11: Sync records are not listed or actionable through /api/promotion, and the reverse", async () => {
    const context = setup()
    const { targets } = await planned(context)
    const id = targets[0]!.promotion!.id
    const scope = { tenantId: TENANT_B, targetTenants: named([TENANT_A]), sourceTenantId: TENANT_A }
    expect((await context.promote({ ...scope, action: "list" })).body.promotions).toEqual([])
    for (const action of ["get", "preview", "approve", "reject", "apply", "retry", "rollback-preview", "rollback-create", "rollback-review"]) {
      const response = await context.promote({ ...scope, action, id, contentHash: "0".repeat(64), targetFingerprint: "0".repeat(64), confirm: true })
      expect(response.status, action).toBe(404)
      expect(response.body.error).toBe(PROMOTION_NOT_FOUND)
    }
    const promotion = await context.promote({ ...scope, action: "plan", title: "Promote", items: [{ sourceId: context.policy.id }] })
    expect(promotion.status).toBe(200)
    expect((await context.promote({ ...scope, action: "list" })).body.promotions.map((entry: { id: string }) => entry.id)).toEqual([promotion.body.promotion.id])
    expect(changeSets(context, TENANT_B).find((changeSet) => changeSet.id === promotion.body.promotion.changeSetId)!.origin.workflow).toBe("promotion")
    for (const action of ["get-target", "preview", "apply"]) expect((await context.post({ tenantId: TENANT_B, action, id: promotion.body.promotion.id, contentHash: "0".repeat(64), confirm: true })).status, action).toBe(404)
    expect(changeSets(context, TENANT_B).find((changeSet) => changeSet.id === targets[0]!.promotion!.changeSetId)!.status).toBe("in-review")
  })

  it("rejects a Sync target with no reviewer or note", async () => {
    const context = setup()
    const { targets } = await planned(context)
    const rejected = await context.post({ tenantId: TENANT_B, action: "reject", id: targets[0]!.promotion!.id })
    expect(rejected.status).toBe(200)
    expect(rejected.body.promotion.status).toBe("rejected")
    expect(changeSets(context, TENANT_B)[0]!.review).toMatchObject({ decision: "rejected", reviewer: "Admin", note: null })
  })

  it("lists source policies and the mappable objects of a target", async () => {
    const context = setup()
    const listed = await context.post({ tenantId: TENANT_A, action: "policies", folder: "ConfigurationPolicies" })
    expect(listed.status).toBe(200)
    expect(listed.body.source.map((policy: { name: string }) => policy.name)).toEqual(["OIB Defender"])
    context.targets[TENANT_B]!.filters = [{ id: "f1", displayName: "Corporate devices" }]
    const objects = await context.post({ tenantId: TENANT_A, action: "target-objects", targetTenantId: TENANT_B, kind: "filter" })
    expect(objects.body).toEqual({ objects: [{ id: "f1", name: "Corporate devices" }], readable: true })
    context.setSameLicense(false)
    expect((await context.post({ tenantId: TENANT_A, action: "target-objects", targetTenantId: TENANT_B, kind: "filter" })).status).toBe(402)
  })
})
