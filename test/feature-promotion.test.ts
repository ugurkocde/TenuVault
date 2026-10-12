import { describe, expect, it } from "vitest"
import { routes } from "../src/main/features/promotion"
import { containsRedaction, containsSecret, REDACTED, type ChangeSetContent, type ChangeSetRecord } from "../src/main/features/change-sets/model"
import { CONTENT_DOMAIN } from "../src/main/features/change-sets/engine"
import { readCurrent } from "../src/main/features/change-sets/graph"
import { DOMAINS } from "../src/main/features/domains"
import type { PromotionRecord } from "../src/main/features/promotion/engine"
import { resolveReferences, translate, type Mapping } from "../src/main/features/promotion/mapping"
import { buildUpdatePlan } from "../src/shared/intune/restore-plan"
import { typeForFolder, type IntuneType, type Item } from "../src/shared/intune/registry"
import type { Plan } from "../src/shared/plans"
import { call, fakeDeps, TENANT_A, TENANT_B, TENANT_C } from "./feature-helpers"
import { FakeTenant, referenceSetting, setting, wire } from "./feature-change-sets-fakes"

const PATH = "/api/promotion"
const DEV_REUSABLE = "aaaaaaaa-0000-0000-0000-00000000000a"
const PROD_REUSABLE = "bbbbbbbb-0000-0000-0000-00000000000b"
const DEV_GROUP = "aaaaaaaa-0000-0000-0000-00000000000c"

/** TENANT_A is development (source), TENANT_B production (destination). */
function setup(options: { plans?: Record<string, Plan>; sameLicense?: boolean; backup?: "ok" | "fail" } = {}) {
  const deps = fakeDeps({ plans: options.plans ?? { [TENANT_A]: "pro", [TENANT_B]: "pro" }, sameLicense: () => options.sameLicense ?? true })
  const dev = new FakeTenant(TENANT_A)
  const prod = new FakeTenant(TENANT_B)
  const wired = wire(deps, [dev, prod], { backup: options.backup })
  dev.scopeTags.push({ id: "4", displayName: "Pilot" })
  prod.scopeTags.push({ id: "9", displayName: "Pilot" })
  dev.reusable = [{ id: DEV_REUSABLE, displayName: "Signing cert" }]
  prod.reusable = [{ id: PROD_REUSABLE, displayName: "Signing cert" }]
  const simple = dev.addPolicy({ name: "OIB Defender", roleScopeTagIds: ["0", "4"], assignments: [{ id: "a", source: "direct", target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: DEV_GROUP, deviceAndAppManagementAssignmentFilterId: null, deviceAndAppManagementAssignmentFilterType: "none" } }] })
  const withReference = dev.addPolicy({ name: "OIB EPM", settings: [setting("epm_appliesto", "epm_allusers"), referenceSetting(DEV_REUSABLE)] })
  const api = routes(deps)
  const post = (body: Record<string, unknown>, extra: { tenantId?: string; targetTenants?: unknown } = {}) =>
    call(api, PATH, { tenantId: extra.tenantId ?? TENANT_B, targetTenants: "targetTenants" in extra ? extra.targetTenants : [{ tenantId: TENANT_A }], sourceTenantId: TENANT_A, ...body })
  return { deps, dev, prod, simple, withReference, post, ...wired }
}

const MAPPINGS: Mapping[] = [
  { kind: "scopeTag", sourceId: "4", targetId: "9", confirmed: true },
  { kind: "reusableSetting", sourceId: DEV_REUSABLE, targetId: PROD_REUSABLE, confirmed: true },
]

async function planned(context: ReturnType<typeof setup>, items?: Array<{ sourceId: unknown; destinationId?: unknown }>) {
  const response = await context.post({ action: "plan", title: "Promote OIB", ticket: "CHG-7", items: items ?? [{ sourceId: context.simple.id }, { sourceId: context.withReference.id }], mappings: MAPPINGS })
  expect(response.status).toBe(200)
  return response.body.promotion as PromotionRecord & { id: string }
}

async function approved(context: ReturnType<typeof setup>, id: string) {
  const preview = await context.post({ action: "preview", id })
  expect(preview.status).toBe(200)
  const approval = await context.post({ action: "approve", id, contentHash: preview.body.changeSet.contentHash, targetFingerprint: preview.body.changeSet.targetFingerprint })
  expect(approval.status).toBe(200)
  return preview.body
}

function proposal(context: ReturnType<typeof setup>, promotion: PromotionRecord): ChangeSetContent {
  const changeSet = context.deps.records.get<ChangeSetRecord>(DOMAINS.changeSets, TENANT_B, promotion.changeSetId!)!
  return context.deps.records.get<ChangeSetContent>(CONTENT_DOMAIN, TENANT_B, changeSet.proposalId)!
}

const secretSetting = (): Item => ({ id: "1", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: "wifi_psk", simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSecretSettingValue", value: "fixture-secret", valueState: "encryptedValueToken" } } })

describe("/api/promotion", () => {
  it("promotes reviewed policies one way, unassigned, with mapped references and a production backup", async () => {
    const context = setup()
    const promotion = await planned(context)
    expect(promotion.status).toBe("in-review")
    expect(promotion.changeSetId).toBeTruthy()
    expect(proposal(context, promotion).entries["op-1"]!.body!.roleScopeTagIds).toEqual(["0", "9"])
    const preview = await approved(context, promotion.id)
    expect(preview.changeSet.affectedObjects).toHaveLength(2)
    const applied = await context.post({ action: "apply", id: promotion.id, contentHash: preview.changeSet.contentHash, confirm: true })
    expect(applied.status).toBe(200)
    expect(applied.body.promotion.status).toBe("applied")
    expect(context.backups).toEqual([TENANT_B])
    const created = [...context.prod.policies.values()]
    expect(created.map((policy) => policy.name).sort()).toEqual(["OIB Defender", "OIB EPM"])
    // Assignments are excluded until reviewed separately, and no source GUID reaches production.
    expect(created.every((policy) => Array.isArray(policy.assignments) && policy.assignments.length === 0)).toBe(true)
    expect(JSON.stringify(created)).not.toMatch(/aaaaaaaa-/)
    expect(created.find((policy) => policy.name === "OIB Defender")!.roleScopeTagIds).toEqual(["0", "9"])
    expect(JSON.stringify(created.find((policy) => policy.name === "OIB EPM")!.settings)).toContain(PROD_REUSABLE)
    // The source is only read.
    expect(context.dev.writeCount()).toBe(0)
    // No continuous sync: later source edits are reported, never propagated.
    context.dev.policies.get(context.simple.id as string)!.description = "Edited in dev later"
    const after = await context.post({ action: "preview", id: promotion.id })
    expect(after.body.sourceChanges.join(" ")).toContain("Only the reviewed version is promoted")
    expect(context.prod.writeCount()).toBe(2)
  })

  it("allows Pro only between the two tenants of the same license", async () => {
    const context = setup({ sameLicense: false })
    const response = await context.post({ action: "plan", title: "x", items: [{ sourceId: context.simple.id }], mappings: MAPPINGS })
    expect(response.status).toBe(403)
    // The source must be named in targetTenants so its license is checked.
    const unchecked = setup()
    expect((await unchecked.post({ action: "plan", title: "x", items: [{ sourceId: unchecked.simple.id }], mappings: MAPPINGS }, { targetTenants: undefined })).status).toBe(400)
    // Source and destination must differ.
    expect((await unchecked.post({ action: "plan", title: "x", sourceTenantId: TENANT_B, items: [{ sourceId: unchecked.simple.id }] }, { targetTenants: [] })).status).toBe(400)
  })

  it("refuses an unlicensed or Community destination and an expired source license", async () => {
    const unlicensed = setup({ plans: { [TENANT_A]: "pro" } })
    await expect(unlicensed.post({ action: "plan", title: "x", items: [{ sourceId: unlicensed.simple.id }] })).rejects.toThrow(/not licensed/)
    const community = setup({ plans: { [TENANT_A]: "pro", [TENANT_B]: "community" } })
    expect((await community.post({ action: "plan", title: "x", items: [{ sourceId: community.simple.id }] })).status).toBe(402)
    const expired = setup({ plans: { [TENANT_A]: "community", [TENANT_B]: "pro" } })
    expect((await expired.post({ action: "plan", title: "x", items: [{ sourceId: expired.simple.id }] })).status).toBe(402)
    const stranger = setup()
    expect((await stranger.post({ action: "plan", title: "x", sourceTenantId: TENANT_C, items: [{ sourceId: stranger.simple.id }] }, { targetTenants: [{ tenantId: TENANT_C }] })).status).toBe(403)
    expect(stranger.prod.writeCount() + unlicensed.prod.writeCount() + community.prod.writeCount() + expired.prod.writeCount()).toBe(0)
  })

  it("blocks promotion with missing dependencies and creates no change set", async () => {
    const context = setup()
    const response = await context.post({ action: "plan", title: "x", items: [{ sourceId: context.withReference.id }], mappings: [] })
    const promotion = response.body.promotion as PromotionRecord & { id: string }
    expect(promotion.status).toBe("blocked")
    expect(promotion.changeSetId).toBeNull()
    expect(promotion.items[0]!.findings.some((finding) => finding.code === "display-name-only")).toBe(true)
    expect((await context.post({ action: "apply", id: promotion.id, contentHash: "0".repeat(64), confirm: true })).status).toBe(409)
    expect(context.prod.writeCount()).toBe(0)
  })

  it("keeps the live destination tags explicitly in a PUT proposal and write", async () => {
    const context = setup()
    context.prod.scopeTags.push({ id: "12", displayName: "Production" })
    const existing = context.prod.addPolicy({ name: "OIB Defender", roleScopeTagIds: ["12", "9"] })
    const promotion = await planned(context, [{ sourceId: context.simple.id, destinationId: existing.id }])
    expect(promotion.status).toBe("in-review")
    expect(proposal(context, promotion).entries["op-1"]!.body!.roleScopeTagIds).toEqual(["12", "9"])
    const finding = promotion.items[0]!.findings.find((entry) => entry.code === "scope-tags-kept")!
    expect(finding.severity).toBe("info")
    expect(finding.message).toContain("Scope tags of the destination are kept")
    expect(finding.message).toContain('Source: "Default" (0), "Pilot" (4)')
    expect(finding.message).toContain('Destination: "Production" (12), "Pilot" (9)')
    expect(promotion.items[0]!.references.some((reference) => reference.kind === "scopeTag")).toBe(false)
    const preview = await approved(context, promotion.id)
    expect(preview.promotion.items[0].findings).toContainEqual(finding)
    expect((await context.post({ action: "apply", id: promotion.id, contentHash: preview.changeSet.contentHash, confirm: true })).body.promotion.status).toBe("applied")
    expect(context.prod.calls.find((entry) => entry.method === "PUT")!.body!.roleScopeTagIds).toEqual(["12", "9"])
    expect(context.prod.policies.get(existing.id as string)!.roleScopeTagIds).toEqual(["12", "9"])
  })

  it.each([{ mappings: [] }, { mappings: [{ kind: "scopeTag", sourceId: "4", targetId: "999", confirmed: true }] }])("updates without relying on source scope tag mappings: %j", async ({ mappings }) => {
    const context = setup()
    const existing = context.prod.addPolicy({ name: "OIB Defender", roleScopeTagIds: ["9"] })
    const response = await context.post({ action: "plan", title: "x", items: [{ sourceId: context.simple.id, destinationId: existing.id }], mappings })
    expect(response.body.promotion.status).toBe("in-review")
    expect(proposal(context, response.body.promotion).entries["op-1"]!.body!.roleScopeTagIds).toEqual(["9"])
  })

  it("requires a new plan when destination scope tags change before approval", async () => {
    const context = setup()
    const existing = context.prod.addPolicy({ name: "OIB Defender", roleScopeTagIds: ["9"] })
    const promotion = await planned(context, [{ sourceId: context.simple.id, destinationId: existing.id }])
    existing.roleScopeTagIds = ["0"]
    const preview = await context.post({ action: "preview", id: promotion.id })
    expect(preview.body.changeSet.blockers.join(" ")).toContain("relied on changed")
    expect((await context.post({ action: "approve", id: promotion.id, contentHash: preview.body.changeSet.contentHash, targetFingerprint: preview.body.changeSet.targetFingerprint })).status).toBe(409)
    expect(context.prod.writeCount()).toBe(0)
  })

  it.each([{ tags: undefined }, { tags: [] }])("keeps absent or empty destination tags instead of source tags: %j", async ({ tags }) => {
    const context = setup()
    const existing = context.prod.addPolicy({ name: "OIB Defender" })
    if (tags === undefined) delete existing.roleScopeTagIds
    else existing.roleScopeTagIds = tags
    const promotion = await planned(context, [{ sourceId: context.simple.id, destinationId: existing.id }])
    const body = proposal(context, promotion).entries["op-1"]!.body!
    if (tags === undefined) expect(body).not.toHaveProperty("roleScopeTagIds")
    else expect(body.roleScopeTagIds).toEqual([])
  })

  it.each([{ mappings: [] }, { mappings: [{ kind: "scopeTag", sourceId: "4", targetId: "999", confirmed: true }] }])("creates with Default for an unusable scope tag mapping: %j", async ({ mappings }) => {
    const context = setup()
    const response = await context.post({ action: "plan", title: "x", items: [{ sourceId: context.simple.id }], mappings })
    const promotion = response.body.promotion as PromotionRecord & { id: string }
    expect(promotion.status).toBe("in-review")
    expect(proposal(context, promotion).entries["op-1"]!.body!.roleScopeTagIds).toEqual(["0"])
    expect(promotion.items[0]!.findings).toContainEqual(expect.objectContaining({ code: "scope-tag-default", severity: "warning", message: expect.stringContaining('"Pilot"') }))
    const preview = await approved(context, promotion.id)
    expect((await context.post({ action: "apply", id: promotion.id, contentHash: preview.changeSet.contentHash, confirm: true })).body.promotion.status).toBe("applied")
    expect([...context.prod.policies.values()][0]!.roleScopeTagIds).toEqual(["0"])
  })

  it("keeps the warning when a confirmed scope tag mapping cannot be verified", async () => {
    const context = setup()
    const graph = context.deps.graph
    context.deps.graph = async (tenantId, options) => {
      const reader = await graph(tenantId, options)
      return (method, path, body) => tenantId === TENANT_B && path.startsWith("deviceManagement/roleScopeTags") ? Promise.resolve({ status: 403, body: {} }) : reader(method, path, body)
    }
    const promotion = await planned(context, [{ sourceId: context.simple.id }])
    expect(promotion.status).toBe("in-review")
    expect(proposal(context, promotion).entries["op-1"]!.body!.roleScopeTagIds).toEqual(["0", "9"])
    expect(promotion.items[0]!.findings).toContainEqual(expect.objectContaining({ code: "unknown-membership", severity: "warning" }))
  })

  it("aborts on a failed production backup before any write", async () => {
    const context = setup({ backup: "fail" })
    const promotion = await planned(context)
    const preview = await approved(context, promotion.id)
    const applied = await context.post({ action: "apply", id: promotion.id, contentHash: preview.changeSet.contentHash, confirm: true })
    expect(applied.status).toBe(502)
    expect(context.prod.writeCount()).toBe(0)
  })

  it("refuses to apply after concurrent destination edits", async () => {
    const context = setup()
    const promotion = await planned(context)
    const preview = await approved(context, promotion.id)
    // Someone creates a policy with the same name in production after approval.
    context.prod.addPolicy({ name: "OIB Defender" })
    const applied = await context.post({ action: "apply", id: promotion.id, contentHash: preview.changeSet.contentHash, confirm: true })
    expect(applied.status).toBe(409)
    expect(context.prod.writeCount()).toBe(0)
    expect((await context.post({ action: "get", id: promotion.id })).body.promotion.status).toBe("stale")
  })

  it("invalidates the plan when a mapped dependency changes in the destination", async () => {
    const context = setup()
    const promotion = await planned(context)
    const preview = await approved(context, promotion.id)
    context.prod.reusable[0]!.version = 2
    const applied = await context.post({ action: "apply", id: promotion.id, contentHash: preview.changeSet.contentHash, confirm: true })
    expect(applied.status).toBe(409)
    expect(applied.body.error).toContain("relied on changed")
    expect(context.prod.writeCount()).toBe(0)
  })

  it("re-checks mapped dependencies after the production backup", async () => {
    const context = setup()
    const promotion = await planned(context)
    const preview = await approved(context, promotion.id)
    const api = context.deps.api
    context.deps.api = async (path, tenantId, body) => {
      // The mapped reusable setting is edited while the backup runs.
      if (path === "/api/backup/status") context.prod.reusable[0]!.version = 3
      return api(path, tenantId, body)
    }
    const applied = await context.post({ action: "apply", id: promotion.id, contentHash: preview.changeSet.contentHash, confirm: true })
    expect(applied.status).toBe(409)
    expect(context.backups).toEqual([TENANT_B])
    expect(context.prod.writeCount()).toBe(0)
  })

  it("blocks policies with secret values instead of promoting redacted content", async () => {
    const context = setup()
    const secret = context.dev.addPolicy({ name: "Wi-Fi", settings: [{ id: "0", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: "wifi_psk", simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSecretSettingValue", value: "hunter2", valueState: "encryptedValueToken" } } }] })
    const response = await context.post({ action: "plan", title: "x", items: [{ sourceId: secret.id }], mappings: MAPPINGS })
    expect(response.body.promotion.status).toBe("blocked")
    expect(response.body.promotion.changeSetId).toBeNull()
    // Secrets used to be unconditionally blocked; acknowledgement now permits a proposal without them.
    expect(response.body.promotion.items[0].findings).toContainEqual(expect.objectContaining({ code: "secret-values", severity: "blocking" }))
    expect(JSON.stringify(context.deps.store.values ? [...context.deps.store.values.values()] : [])).not.toContain("hunter2")
  })

  it.each([undefined, false, "true"])("blocks a redacted destination without explicit acknowledgement: %j", async (acknowledgeRedacted) => {
    const context = setup()
    const existing = context.prod.addPolicy({ name: "OIB Defender", settings: [setting("safe", "1"), secretSetting()] })
    const response = await context.post({ action: "plan", title: "x", items: [{ sourceId: context.simple.id, destinationId: existing.id }], mappings: MAPPINGS, acknowledgeRedacted })
    const promotion = response.body.promotion as PromotionRecord & { id: string }
    expect(promotion.status).toBe("blocked")
    expect(promotion.changeSetId).toBeNull()
    expect(promotion.items[0]!.blocked).toBe(true)
    expect(promotion.items[0]!.findings).toContainEqual(expect.objectContaining({ code: "secret-values", severity: "blocking", message: expect.stringContaining("destination policy") }))
    const detail = await context.post({ action: "get", id: promotion.id })
    expect(detail.body.promotion.items[0].findings).toContainEqual(expect.objectContaining({ severity: "blocking", message: expect.stringContaining("must be set again") }))
    expect((await context.post({ action: "apply", id: promotion.id, contentHash: "0".repeat(64), confirm: true, acknowledgeRedacted: true })).status).toBe(409)
    expect(context.prod.writeCount()).toBe(0)
  })

  it("allows an acknowledged redacted destination with a warning and preserved tags", async () => {
    const context = setup()
    const existing = context.prod.addPolicy({ name: "OIB Defender", roleScopeTagIds: ["9"], settings: [setting("safe", "1"), secretSetting()] })
    const response = await context.post({ action: "plan", title: "x", items: [{ sourceId: context.simple.id, destinationId: existing.id }], mappings: [], acknowledgeRedacted: true })
    const promotion = response.body.promotion as PromotionRecord & { id: string }
    expect(promotion.status).toBe("in-review")
    expect(promotion.acknowledgeRedacted).toBe(true)
    expect(promotion.items[0]!.findings).toContainEqual(expect.objectContaining({ code: "secret-values", severity: "warning", message: expect.stringContaining("Automatic rollback") }))
    const preview = await approved(context, promotion.id)
    expect((await context.post({ action: "apply", id: promotion.id, contentHash: preview.changeSet.contentHash, confirm: true })).body.promotion.status).toBe("applied")
    const sent = context.prod.calls.find((entry) => entry.method === "PUT")!.body!
    expect(sent.roleScopeTagIds).toEqual(["9"])
    expect(containsSecret(sent) || containsRedaction(sent)).toBe(false)
  })

  it("requires replanning if destination secrets appear before approval", async () => {
    const context = setup()
    const existing = context.prod.addPolicy({ name: "OIB Defender" })
    const promotion = await planned(context, [{ sourceId: context.simple.id, destinationId: existing.id }])
    ;(existing.settings as Item[]).push(secretSetting())
    const preview = await context.post({ action: "preview", id: promotion.id })
    expect(preview.body.changeSet.blockers.join(" ")).toContain("relied on changed")
    expect((await context.post({ action: "approve", id: promotion.id, contentHash: preview.body.changeSet.contentHash, targetFingerprint: preview.body.changeSet.targetFingerprint })).status).toBe(409)
    const replanned = await planned(context, [{ sourceId: context.simple.id, destinationId: existing.id }])
    expect(replanned.status).toBe("blocked")
    expect(replanned.items[0]!.findings).toContainEqual(expect.objectContaining({ code: "secret-values", severity: "blocking" }))
    expect(context.prod.writeCount()).toBe(0)
  })

  it.each([true, false])("requires acknowledgement for source redaction and omits whole settings, secret type: %j", async (secretType) => {
    const context = setup()
    const secret = secretSetting()
    ;((secret.settingInstance as Item).simpleSettingValue as Item).value = REDACTED
    if (!secretType) ((secret.settingInstance as Item).simpleSettingValue as Item)["@odata.type"] = "#microsoft.graph.deviceManagementConfigurationStringSettingValue"
    const source = context.dev.addPolicy({ name: "Wi-Fi", settings: [setting("safe", "1"), secret] })
    const input = { action: "plan", title: "x", items: [{ sourceId: source.id }], mappings: [] }
    const blocked = (await context.post(input)).body.promotion as PromotionRecord
    expect(blocked.status).toBe("blocked")
    expect(blocked.items[0]!.findings).toContainEqual(expect.objectContaining({ code: "secret-values", severity: "blocking" }))
    const promotion = (await context.post({ ...input, acknowledgeRedacted: true })).body.promotion as PromotionRecord & { id: string }
    expect(promotion.status).toBe("in-review")
    const body = proposal(context, promotion).entries["op-1"]!.body!
    expect(body.settings).toEqual([setting("safe", "1")])
    expect(containsRedaction(body) || containsSecret(body)).toBe(false)
    const preview = await approved(context, promotion.id)
    expect((await context.post({ action: "apply", id: promotion.id, contentHash: preview.changeSet.contentHash, confirm: true })).body.promotion.status).toBe("applied")
    expect(containsSecret([...context.prod.policies.values()][0])).toBe(false)
  })

  it("reconciles uncertain writes on retry and offers a reviewed rollback", async () => {
    const context = setup()
    const promotion = await planned(context)
    const preview = await approved(context, promotion.id)
    let posts = 0
    context.prod.failWrite = (method) => (method === "POST" && ++posts === 2 ? "lost" : undefined)
    const first = await context.post({ action: "apply", id: promotion.id, contentHash: preview.changeSet.contentHash, confirm: true })
    expect(first.body.promotion.status).toBe("uncertain")
    context.prod.failWrite = undefined
    const retried = await context.post({ action: "retry", id: promotion.id, contentHash: preview.changeSet.contentHash, confirm: true })
    expect(retried.body.promotion.status).toBe("applied")
    expect(context.prod.policies.size).toBe(2)
    expect(context.prod.writeCount((entry) => entry.method === "POST")).toBe(2)

    const rollbackPreview = await context.post({ action: "rollback-preview", id: promotion.id })
    expect(rollbackPreview.body.operations.every((operation: { action: string }) => operation.action === "delete")).toBe(true)
    const rollback = await context.post({ action: "rollback-create", id: promotion.id })
    const changeSet = rollback.body.changeSet as ChangeSetRecord & { id: string }
    expect(changeSet.kind).toBe("rollback")
    expect(rollback.body.promotion.rollbackChangeSetId).toBe(changeSet.id)
    // The rollback is reviewed, approved and applied in Promotion; it only writes to production,
    // so it works without naming the source tenant.
    const rollbackOnly = (body: Record<string, unknown>) => call(routes(context.deps), PATH, { tenantId: TENANT_B, id: promotion.id, ...body })
    expect((await rollbackOnly({ action: "rollback-apply", contentHash: changeSet.contentHash, confirm: true })).status).toBe(409)
    const review = await rollbackOnly({ action: "rollback-review" })
    expect(review.status).toBe(200)
    expect((await rollbackOnly({ action: "rollback-approve", contentHash: review.body.contentHash, targetFingerprint: review.body.targetFingerprint })).status).toBe(200)
    const undone = await rollbackOnly({ action: "rollback-apply", contentHash: review.body.contentHash, confirm: true })
    expect(undone.body.changeSet.status).toBe("applied")
    expect(context.prod.policies.size).toBe(0)
    expect((await context.post({ action: "get", id: promotion.id })).body.rollbackChangeSet.status).toBe("applied")
  })

  it("retries after a verified update write without repeating it or reporting its own write as stale", async () => {
    const context = setup()
    const existing = context.prod.addPolicy({ name: "OIB Defender", description: "Production copy" })
    const promotion = await planned(context, [{ sourceId: context.simple.id, destinationId: existing.id }, { sourceId: context.withReference.id }])
    const preview = await approved(context, promotion.id)
    context.prod.failWrite = (method) => (method === "POST" ? "lost" : undefined)
    const first = await context.post({ action: "apply", id: promotion.id, contentHash: preview.changeSet.contentHash, confirm: true })
    expect(first.body.promotion.status).toBe("uncertain")
    expect(context.prod.writeCount((entry) => entry.method === "PUT")).toBe(1)
    context.prod.failWrite = undefined
    const retried = await context.post({ action: "retry", id: promotion.id, contentHash: preview.changeSet.contentHash, confirm: true })
    expect(retried.status).toBe(200)
    expect(retried.body.promotion.status).toBe("applied")
    expect(context.prod.writeCount((entry) => entry.method === "PUT")).toBe(1)
    expect(context.prod.writeCount((entry) => entry.method === "POST")).toBe(1)
    expect(context.prod.policies.size).toBe(2)
  })

  it("keeps promotions readable after a downgrade", async () => {
    const context = setup()
    const promotion = await planned(context)
    const downgraded = fakeDeps({ plans: { [TENANT_A]: "community", [TENANT_B]: "community" }, records: context.deps.records })
    const api = routes(downgraded)
    expect((await call(api, PATH, { tenantId: TENANT_B, action: "list" })).body.promotions).toHaveLength(1)
    expect((await call(api, PATH, { tenantId: TENANT_B, action: "get", id: promotion.id })).status).toBe(200)
    expect((await call(api, PATH, { tenantId: TENANT_B, action: "preview", id: promotion.id })).status).toBe(402)
    // Another tenant never sees it.
    expect((await call(api, PATH, { tenantId: TENANT_A, action: "get", id: promotion.id })).status).toBe(404)
  })
})

const SOURCE_GROUP = "aaaaaaaa-0000-0000-0000-000000000001"
const SOURCE_EXCLUDED = "aaaaaaaa-0000-0000-0000-000000000002"
const SOURCE_FILTER = "aaaaaaaa-0000-0000-0000-000000000003"
const SOURCE_FILTER_EX = "aaaaaaaa-0000-0000-0000-000000000004"
const TARGET_GROUP = "bbbbbbbb-0000-0000-0000-000000000001"
const TARGET_EXCLUDED = "bbbbbbbb-0000-0000-0000-000000000002"
const TARGET_FILTER = "bbbbbbbb-0000-0000-0000-000000000003"
const TARGET_FILTER_EX = "bbbbbbbb-0000-0000-0000-000000000004"

/** A development policy targeted at an included group with an include filter and an excluded group with an exclude filter. */
function targeted() {
  const context = setup()
  context.dev.filters = [{ id: SOURCE_FILTER, displayName: "Corporate Windows", platform: "windows10AndLater", rule: "(device.deviceOwnership -eq \"Corporate\")" }, { id: SOURCE_FILTER_EX, displayName: "Kiosks", platform: "windows10AndLater", rule: "(device.model -eq \"Kiosk\")" }]
  context.dev.groups.set(SOURCE_GROUP, { id: SOURCE_GROUP, displayName: "Pilot devices" })
  context.dev.groups.set(SOURCE_EXCLUDED, { id: SOURCE_EXCLUDED, displayName: "Excluded devices" })
  context.prod.filters = [{ id: TARGET_FILTER, displayName: "Corporate Windows", platform: "windows10AndLater", rule: "(device.deviceOwnership -eq \"Corporate\")" }, { id: TARGET_FILTER_EX, displayName: "Kiosk devices", platform: "windows10AndLater", rule: "(device.model -eq \"Kiosk\")" }]
  context.prod.groups.set(TARGET_GROUP, { id: TARGET_GROUP, displayName: "Pilot devices" })
  context.prod.groups.set(TARGET_EXCLUDED, { id: TARGET_EXCLUDED, displayName: "Excluded devices" })
  const policy = context.dev.addPolicy({
    name: "EPM rules",
    roleScopeTagIds: ["0", "4"],
    settings: [setting("epm_appliesto", "epm_allusers"), referenceSetting(DEV_REUSABLE)],
    assignments: [
      { id: "p_1", source: "direct", sourceId: "p", target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: SOURCE_GROUP, deviceAndAppManagementAssignmentFilterId: SOURCE_FILTER, deviceAndAppManagementAssignmentFilterType: "include" } },
      { id: "p_2", source: "direct", sourceId: "p", target: { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: SOURCE_EXCLUDED, deviceAndAppManagementAssignmentFilterId: SOURCE_FILTER_EX, deviceAndAppManagementAssignmentFilterType: "exclude" } },
    ],
  })
  return { ...context, policy }
}

const TARGETING_MAPPINGS = [
  ...MAPPINGS,
  { kind: "group", sourceId: SOURCE_GROUP, targetId: TARGET_GROUP, confirmed: true },
  { kind: "group", sourceId: SOURCE_EXCLUDED, targetId: TARGET_EXCLUDED, confirmed: true },
  { kind: "filter", sourceId: SOURCE_FILTER, targetId: TARGET_FILTER, confirmed: true },
  { kind: "filter", sourceId: SOURCE_FILTER_EX, targetId: TARGET_FILTER_EX, confirmed: true },
]

describe("promotion dependency mapping", () => {
  it("preserves exclusions and filter types when reviewed assignments are promoted", async () => {
    const context = targeted()
    const planned = (await context.post({ action: "plan", title: "x", includeAssignments: true, items: [{ sourceId: context.policy.id }], mappings: TARGETING_MAPPINGS })).body.promotion as PromotionRecord & { id: string }
    expect(planned.status).toBe("in-review")
    const preview = await approved(context, planned.id)
    expect((await context.post({ action: "apply", id: planned.id, contentHash: preview.changeSet.contentHash, confirm: true })).body.promotion.status).toBe("applied")
    const created = [...context.prod.policies.values()].find((policy) => policy.name === "EPM rules")!
    const [include, exclude] = (created.assignments as Item[]).map((assignment) => assignment.target as Item)
    expect(include).toMatchObject({ "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: TARGET_GROUP, deviceAndAppManagementAssignmentFilterId: TARGET_FILTER, deviceAndAppManagementAssignmentFilterType: "include" })
    expect(exclude).toMatchObject({ "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: TARGET_EXCLUDED, deviceAndAppManagementAssignmentFilterId: TARGET_FILTER_EX, deviceAndAppManagementAssignmentFilterType: "exclude" })
    expect(created.roleScopeTagIds).toEqual(["0", "9"])
    // No source GUID reaches production.
    expect(JSON.stringify(created)).not.toMatch(/aaaaaaaa-/)
  })

  it("rejects a display-name match as proof and never uses unconfirmed mappings", async () => {
    const context = targeted()
    const mappings = TARGETING_MAPPINGS.filter((mapping) => mapping.kind !== "filter").concat([{ kind: "filter", sourceId: SOURCE_FILTER_EX, targetId: TARGET_FILTER_EX, confirmed: false }])
    const promotion = (await context.post({ action: "plan", title: "x", includeAssignments: true, items: [{ sourceId: context.policy.id }], mappings })).body.promotion as PromotionRecord
    expect(promotion.status).toBe("blocked")
    expect(promotion.changeSetId).toBeNull()
    const [item] = promotion.items
    const byName = item!.references.find((reference) => reference.sourceId === SOURCE_FILTER)!
    expect(byName.state).toBe("missing")
    expect(byName.suggestion).toEqual({ targetId: TARGET_FILTER, targetName: "Corporate Windows" })
    expect(item!.findings.some((finding) => finding.code === "display-name-only" && finding.severity === "blocking")).toBe(true)
    expect(item!.references.find((reference) => reference.sourceId === SOURCE_FILTER_EX)!.state).toBe("missing")
    expect(context.prod.writeCount()).toBe(0)
  })

  it("flags missing references with ordering prerequisites and keeps scope tags explicit", async () => {
    const context = targeted()
    const promotion = (await context.post({ action: "plan", title: "x", items: [{ sourceId: context.policy.id }], mappings: [] })).body.promotion as PromotionRecord
    const findings = promotion.items[0]!.findings
    expect(promotion.status).toBe("blocked")
    // Only the reusable setting blocks now. Unmapped scope tags previously blocked too, and now warn and use Default.
    expect(findings.filter((finding) => (finding.code === "missing-mapping" || finding.code === "display-name-only") && finding.severity === "blocking")).toHaveLength(1)
    expect(findings.some((finding) => finding.code === "scope-tag-default" && finding.severity === "warning")).toBe(true)
    expect(findings.some((finding) => finding.code === "ordering")).toBe(true)
    expect(findings.some((finding) => finding.code === "assignments-excluded")).toBe(true)
    // Default stays portable; other tags retain mapping suggestions and use Default until confirmed.
    expect(promotion.items[0]!.references.filter((reference) => reference.kind === "scopeTag").map((reference) => [reference.sourceId, reference.state])).toEqual([["0", "portable"], ["4", "missing"]])
    expect(promotion.items[0]!.references.find((reference) => reference.sourceId === "4")!.suggestion).toEqual({ targetId: "9", targetName: "Pilot" })
  })

  it("rejects a mapping to a destination object that does not exist", async () => {
    const context = targeted()
    const mappings = TARGETING_MAPPINGS.map((mapping) => (mapping.kind === "reusableSetting" ? { ...mapping, targetId: "cccccccc-0000-0000-0000-000000000009" } : mapping))
    const promotion = (await context.post({ action: "plan", title: "x", items: [{ sourceId: context.policy.id }], mappings })).body.promotion as PromotionRecord
    expect(promotion.status).toBe("blocked")
    expect(promotion.items[0]!.findings.some((finding) => finding.code === "rejected-mapping")).toBe(true)
  })

  it("shows unreadable groups as unknown instead of verified", async () => {
    const context = targeted()
    context.prod.groupsForbidden = true
    context.dev.groupsForbidden = true
    const promotion = (await context.post({ action: "plan", title: "x", includeAssignments: true, items: [{ sourceId: context.policy.id }], mappings: TARGETING_MAPPINGS })).body.promotion as PromotionRecord
    const group = promotion.items[0]!.references.find((reference) => reference.kind === "group")!
    expect(group.state).toBe("mapped-unverified")
    expect(group.sourceName).toBeNull()
    expect(promotion.items[0]!.findings.some((finding) => finding.code === "unknown-membership")).toBe(true)
  })

  it("blocks approval when a mapped filter changes in the destination after planning", async () => {
    const context = targeted()
    const planned = (await context.post({ action: "plan", title: "x", includeAssignments: true, items: [{ sourceId: context.policy.id }], mappings: TARGETING_MAPPINGS })).body.promotion as PromotionRecord & { id: string }
    const preview = await context.post({ action: "preview", id: planned.id })
    expect(preview.body.changeSet.blockers).toEqual([])
    context.prod.filters[0]!.rule = "(device.deviceOwnership -eq \"Personal\")"
    const again = await context.post({ action: "preview", id: planned.id })
    expect(again.body.changeSet.blockers.join(" ")).toContain("relied on changed")
    const approval = await context.post({ action: "approve", id: planned.id, contentHash: again.body.changeSet.contentHash, targetFingerprint: again.body.changeSet.targetFingerprint })
    expect(approval.status).toBe(409)
    expect(context.prod.writeCount()).toBe(0)
  })

  it("lists destination objects a mapping can point to", async () => {
    const context = targeted()
    const response = await context.post({ action: "target-objects", kind: "filter" })
    expect(response.body.objects.map((object: { id: string }) => object.id)).toEqual([TARGET_FILTER, TARGET_FILTER_EX])
    expect((await context.post({ action: "target-objects", kind: "group" })).status).toBe(400)
  })
})

describe("promotion translation", () => {
  const policies = typeForFolder("ConfigurationPolicies")!
  const source: Item = {
    name: "x",
    roleScopeTagIds: ["0"],
    settings: [],
    assignments: [
      { source: "direct", target: { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: SOURCE_EXCLUDED, deviceAndAppManagementAssignmentFilterType: "none" } },
      { source: "policySets", target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } },
      { source: "direct", target: { "@odata.type": "#microsoft.graph.configurationManagerCollectionAssignmentTarget", collectionId: "SMS00001" } },
    ],
  }
  const references = resolveReferences([{ kind: "group", sourceId: SOURCE_EXCLUDED }], { mappings: [{ kind: "group", sourceId: SOURCE_EXCLUDED, targetId: TARGET_EXCLUDED, confirmed: true }], sourceNames: {}, targetObjects: {}, groupStates: new Map([[TARGET_EXCLUDED, { state: "found" as const, name: "Excluded" }]]), sameTenant: false })

  it("blocks unsupported targets and skips inherited assignments", () => {
    const result = translate(policies, source, references, { includeAssignments: true, dropUnsupportedExclusions: false })
    expect(result.body).toBeNull()
    expect(result.findings.some((finding) => finding.code === "unsupported-target")).toBe(true)
  })

  it("never converts an exclusion into an include on types that store exclusions as includes", () => {
    const risky: IntuneType = { ...policies, exclusionsUnsupported: true }
    const onlyExclusion: Item = { ...source, assignments: [source.assignments![0 as never] as Item] }
    const blocked = translate(risky, onlyExclusion, references, { includeAssignments: true, dropUnsupportedExclusions: false })
    expect(blocked.body).toBeNull()
    expect(blocked.findings[0]!.code).toBe("exclusion-unsupported")
    const dropped = translate(risky, onlyExclusion, references, { includeAssignments: true, dropUnsupportedExclusions: true })
    expect(dropped.assignments).toEqual([])
    expect(dropped.findings[0]!.code).toBe("exclusion-dropped")
    const kept = translate(policies, onlyExclusion, references, { includeAssignments: true, dropUnsupportedExclusions: false })
    expect((kept.assignments![0]!.target as Item)["@odata.type"]).toBe("#microsoft.graph.exclusionGroupAssignmentTarget")
    expect((kept.assignments![0]!.target as Item).groupId).toBe(TARGET_EXCLUDED)
  })
})

describe("promotion destination scope tags", () => {
  it.each([["DeviceConfigurations", "PATCH"], ["ConfigurationPolicies", "PUT"]])("sends the destination's explicit tags for %s updates", async (folder, method) => {
    const context = setup()
    const type = typeForFolder(folder)!
    const existing = context.prod.addPolicy({ name: "Production policy", displayName: "Production policy", roleScopeTagIds: ["9"] })
    const graph = context.deps.graph
    context.deps.graph = async (tenantId, options) => {
      const reader = await graph(tenantId, options)
      return async (verb, path, body) => {
        if (folder === "DeviceConfigurations" && tenantId === TENANT_B && verb === "GET" && path.startsWith(`${type.path}/${existing.id}`)) return { status: 200, body: structuredClone(existing) }
        return reader(verb, path, body)
      }
    }
    const source: Item = { id: context.simple.id!, [type.nameKey]: "Source policy", roleScopeTagIds: ["4"] }
    // The shared translator covers PATCH types without expanding the Settings Catalog route.
    const destinationSnapshot = await readCurrent(await context.deps.graph(TENANT_B), type, existing.id as string)
    const proposed = translate(type, source, [], { includeAssignments: false, dropUnsupportedExclusions: false, destinationSnapshot })
    expect(proposed.body!.roleScopeTagIds).toEqual(["9"])
    const [step] = buildUpdatePlan(type, proposed.body!, existing.id as string, { includeAssignments: false, current: existing })
    expect(step!.method).toBe(method)
    expect(step!.body.roleScopeTagIds).toEqual(["9"])
  })
})
