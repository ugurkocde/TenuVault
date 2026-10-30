import { describe, expect, it } from "vitest"
import { DisclaimerAcknowledgements, disclaimerGuard } from "../src/main/disclaimer"
import { ACKNOWLEDGEMENT_REQUIRED, DISCLAIMER_VERSION } from "../src/shared/disclaimer"
import { tenantWriteTargets } from "../src/shared/tenant-writes"
import { memoryStore } from "./helpers"

const A = "11111111-1111-1111-1111-111111111111"
const B = "22222222-2222-2222-2222-222222222222"
const C = "33333333-3333-3333-3333-333333333333"

const post = (path: string, body: unknown) =>
  new Request(`http://tenuvault.internal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

describe("tenantWriteTargets", () => {
  it("names the tenant of every request that changes it", () => {
    const writes: Array<[string, Record<string, unknown>]> = [
      ["/api/restore-backup", { restoreType: "selective", mode: "copy" }],
      ["/api/restore-backup", { restoreType: "full", mode: "replace" }],
      ["/api/revert-policy", { action: "revert" }],
      ["/api/revert-policy", { action: "restore" }],
      ["/api/oib", { action: "oib-deploy" }],
      ["/api/oib", { action: "oib-fix" }],
      ["/api/oib", { action: "oib-undo" }],
      ["/api/frameworks", { action: "create" }],
      ["/api/promotion", { action: "apply" }],
      ["/api/promotion", { action: "retry" }],
      ["/api/promotion", { action: "rollback-apply" }],
      ["/api/baseline-upgrades", { action: "change-apply" }],
      ["/api/custom-baselines", { action: "change-apply" }],
      ["/api/standards", { action: "standard-change-apply" }],
      ["/api/cis-remediation", { action: "apply" }],
      ["/api/cis-remediation", { action: "retry" }],
      ["/api/cis-remediation", { action: "rollback-apply" }],
    ]
    for (const [path, body] of writes) expect(tenantWriteTargets(path, { ...body, tenantId: A }), `${path} ${String(body.action ?? body.mode)}`).toEqual([A])
  })

  it("names only the destination tenants of a copy to other tenants", () => {
    expect(tenantWriteTargets("/api/restore-backup", { tenantId: A, mode: "copy", targetTenants: [{ tenantId: B, appId: "x" }, { tenantId: C }] })).toEqual([B, C])
  })

  it("never counts reads, backups, assessments, previews or planning", () => {
    const reads: Array<[string, Record<string, unknown>]> = [
      ["/api/backup/start", {}],
      ["/api/restore-preview", {}],
      ["/api/list-backups", {}],
      ["/api/detect-drifts", {}],
      ["/api/oib", { action: "oib-compare" }],
      ["/api/oib", { action: "oib-validate" }],
      ["/api/oib", { action: "oib-progress" }],
      ["/api/frameworks", { action: "assess" }],
      ["/api/frameworks", { action: "native-pdf" }],
      ["/api/promotion", { action: "preview" }],
      ["/api/promotion", { action: "approve" }],
      ["/api/promotion", { action: "rollback-create" }],
      ["/api/promotion", { action: "portfolio-list", targetTenants: [{ tenantId: B }] }],
      ["/api/baseline-upgrades", { action: "change-preview" }],
      ["/api/custom-baselines", { action: "deploy" }],
      ["/api/standards", { action: "standard-adopt" }],
      ["/api/cis-remediation", { action: "plan" }],
      ["/api/cis-remediation", { action: "preview" }],
      ["/api/cis-remediation", { action: "approve" }],
      ["/api/cis-remediation", { action: "rollback-create" }],
      ["/api/cis-remediation", { action: "rollback-approve" }],
      ["/api/scores", { action: "compute" }],
      ["/api/health-review", { action: "run" }],
    ]
    for (const [path, body] of reads) expect(tenantWriteTargets(path, { ...body, tenantId: A }), `${path} ${String(body.action)}`).toEqual([])
  })
})

describe("DisclaimerAcknowledgements", () => {
  it("asks once per tenant and again after a new version", () => {
    const store = memoryStore()
    const acks = new DisclaimerAcknowledgements(store)
    expect(acks.missing([A, B])).toEqual([A, B])
    acks.accept([A.toUpperCase()], () => "admin@contoso.com", new Date("2026-09-30T10:00:00Z"))
    expect(acks.missing([A, B])).toEqual([B])
    expect(JSON.parse(store.get("disclaimer.acknowledgements")!)[A]).toEqual({ version: DISCLAIMER_VERSION, acceptedAt: "2026-09-30T10:00:00.000Z", account: "admin@contoso.com" })
    expect(new DisclaimerAcknowledgements(store, DISCLAIMER_VERSION + 1).missing([A])).toEqual([A])
  })

  it("treats an unreadable record as not accepted", () => {
    const store = memoryStore()
    store.set("disclaimer.acknowledgements", "not json")
    expect(new DisclaimerAcknowledgements(store).missing([A])).toEqual([A])
  })
})

describe("disclaimerGuard", () => {
  it("refuses a tenant change until the tenant accepted, and lets reads through", async () => {
    const acks = new DisclaimerAcknowledgements(memoryStore())
    const guard = disclaimerGuard(acks)
    const refused = await guard(post("/api/oib", { action: "oib-deploy", tenantId: A }))
    expect(refused?.status).toBe(ACKNOWLEDGEMENT_REQUIRED)
    expect(await refused?.json()).toMatchObject({ acknowledgement: { version: DISCLAIMER_VERSION, tenantIds: [A] } })
    expect(await guard(post("/api/oib", { action: "oib-compare", tenantId: A }))).toBeNull()
    expect(await guard(post("/api/backup/start", { tenantId: A }))).toBeNull()
    acks.accept([A], () => null)
    expect(await guard(post("/api/oib", { action: "oib-deploy", tenantId: A }))).toBeNull()
  })

  it("asks only for the copy targets that have not accepted", async () => {
    const acks = new DisclaimerAcknowledgements(memoryStore())
    acks.accept([B], () => null)
    const refused = await disclaimerGuard(acks)(post("/api/restore-backup", { tenantId: A, mode: "copy", targetTenants: [{ tenantId: B }, { tenantId: C }] }))
    expect(await refused?.json()).toMatchObject({ acknowledgement: { tenantIds: [C] } })
  })
})
