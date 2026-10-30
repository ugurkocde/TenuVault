import { describe, expect, it } from "vitest"
import { routes as standardsRoutes } from "../src/main/features/standards"
import { routes as hygieneRoutes } from "../src/main/features/hygiene"
import { DOMAINS } from "../src/main/features/domains"
import type { CreateAuditLogInput } from "../src/portal/lib/audit/types"
import { call, fakeDeps, TENANT_A, TENANT_B } from "./feature-helpers"
import { setting } from "./feature-change-sets-fakes"

interface AuditCall { tenantId: string; logEntry: CreateAuditLogInput }

function setup() {
  const deps = fakeDeps({ plans: { [TENANT_A]: "msp", [TENANT_B]: "msp" } })
  const audit: AuditCall[] = []
  deps.api = async (path, tenantId, body = {}) => {
    if (path === "/api/audit/log") {
      audit.push({ tenantId, logEntry: body.logEntry as CreateAuditLogInput })
      return Response.json({ success: true })
    }
    return Response.json({ error: "not faked" }, { status: 501 })
  }
  return { deps, audit }
}

const policy = (name: string, settings: unknown[]) => ({ name, description: "", platforms: "windows10", technologies: "mdm", templateReference: { templateId: "" }, settings })

describe("governance decision audit entries", () => {
  it("records hygiene reviews under the deciding tenant, after the review succeeds", async () => {
    const { deps, audit } = setup()
    const finding = deps.records.create<Record<string, unknown>>(DOMAINS.hygieneFindings, TENANT_A, {
      kind: "finding", title: "Duplicate profile", summary: "s", status: "open", ruleId: "duplicate-profile", fingerprint: "fp", classification: "definite", severity: "high",
      explanation: "e", policies: [], settings: [], details: {}, evidenceSha256: "abc", backupId: "b1", collectedAt: "2026-09-01T00:00:00Z", scanId: "s1", firstSeenAt: "2026-09-01T00:00:00Z", lastSeenAt: "2026-09-01T00:00:00Z", review: null,
    }, { actor: "Admin", reason: "seed" })
    const api = hygieneRoutes(deps)
    const missing = await call(api, "/api/hygiene", { tenantId: TENANT_A, action: "acknowledge", findingId: "00000000-0000-4000-8000-000000000099", note: "x" })
    expect(missing.status).toBe(404)
    expect(audit).toHaveLength(0)
    const done = await call(api, "/api/hygiene", { tenantId: TENANT_A, action: "acknowledge", findingId: finding.id, note: "Known overlap" })
    expect(done.status).toBe(200)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ tenantId: TENANT_A, logEntry: { eventType: "GOVERNANCE_FINDING_REVIEWED", resource: { id: finding.id }, details: { decision: "acknowledged", note: "Known overlap", recordId: finding.id } } })
  })

  it("records customization create, revise (with expiry) and retire, and never a failed create", async () => {
    const { deps, audit } = setup()
    const api = standardsRoutes(deps)
    const failed = await call(api, "/api/standards", { tenantId: TENANT_A, action: "create-customization", title: "Bad", settingKey: "k", reason: "r", owner: "o", expiresAt: "not-a-date" })
    expect(failed.status).toBe(400)
    expect(audit).toHaveLength(0)
    const created = await call(api, "/api/standards", { tenantId: TENANT_A, action: "create-customization", title: "Camera on", settingKey: "camera", reason: "Kiosks", owner: "IT" })
    expect(created.status).toBe(200)
    const id = created.body.customization.id
    const revised = await call(api, "/api/standards", { tenantId: TENANT_A, action: "revise-customization", id, owner: "Security", expiresAt: "2027-01-01", why: "Re-reviewed" })
    expect(revised.status).toBe(200)
    expect(revised.body.customization.expiresAt).toBe("2027-01-01")
    const retired = await call(api, "/api/standards", { tenantId: TENANT_A, action: "retire-customization", id, why: "Kiosks gone" })
    expect(retired.status).toBe(200)
    expect(audit.map((entry) => entry.logEntry.eventType)).toEqual(["GOVERNANCE_CUSTOMIZATION_RECORDED", "GOVERNANCE_CUSTOMIZATION_RECORDED", "GOVERNANCE_CUSTOMIZATION_RETIRED"])
    expect(audit.every((entry) => entry.tenantId === TENANT_A)).toBe(true)
  })

  it("keeps shared-scope publishes out of customer audit logs, and records adoptions and exception decisions per customer", async () => {
    const { deps, audit } = setup()
    const api = standardsRoutes(deps)
    const published = await call(api, "/api/standards", { tenantId: TENANT_A, action: "standard-create", standardKey: "workstation", name: "Workstation", changeNotes: "First", source: { type: "manual", reference: "MSP standard" }, policies: [policy("Std - Defender", [setting("scan", "scan_1")])], parameters: [], bindings: [] })
    expect(published.status).toBe(200)
    expect(audit).toHaveLength(0)
    const adopted = await call(api, "/api/standards", { tenantId: TENANT_B, action: "standard-adopt", versionId: published.body.standard.id })
    expect(adopted.status).toBe(200)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ tenantId: TENANT_B, logEntry: { eventType: "GOVERNANCE_STANDARD_ADOPTED", action: "Start standard adoption" } })
    const id = adopted.body.adoption.id
    const plain = await call(api, "/api/standards", { tenantId: TENANT_B, action: "standard-configure", id, parameters: {} })
    expect(plain.status).toBe(200)
    expect(audit).toHaveLength(1)
    const decided = await call(api, "/api/standards", { tenantId: TENANT_B, action: "standard-configure", id, overlay: { settings: [], removals: [], exceptions: [{ policyKey: "std - defender", settingDefinitionId: "scan", reason: "Pilot", approver: "CISO", expiresAt: "2027-01-01T00:00:00Z", status: "approved" }] } })
    expect(decided.status).toBe(200)
    expect(audit).toHaveLength(2)
    expect(audit[1]).toMatchObject({ tenantId: TENANT_B, logEntry: { eventType: "GOVERNANCE_STANDARD_ADOPTED", action: "Decide standard exceptions", details: { decisions: "std - defender:scan=approved" } } })
    const removed = await call(api, "/api/standards", { tenantId: TENANT_B, action: "standard-configure", id, overlay: { settings: [], removals: [], exceptions: [] } })
    expect(removed.status).toBe(200)
    expect(audit).toHaveLength(3)
    expect(audit[2]!.logEntry.details).toMatchObject({ decisions: "std - defender:scan=removed" })
  })
})
