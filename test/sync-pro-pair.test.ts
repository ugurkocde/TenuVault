import { describe, expect, it } from "vitest"
import { routes as promotionRoutes } from "../src/main/features/promotion"
import { routes as syncRoutes } from "../src/main/features/sync"
import { proPair } from "../src/main/license/same-license"
import type { TenantLicenseStatus } from "../src/shared/ipc"
import { FakeTenant, setting, wire } from "./feature-change-sets-fakes"
import { call, fakeDeps, TENANT_A, TENANT_B, TENANT_C } from "./feature-helpers"

type License = Pick<TenantLicenseStatus, "tenantId" | "plan" | "entitled" | "source">
const named = (ids: string[]) => ids.map((tenantId) => ({ tenantId }))

function setup(licenses: License[]) {
  const plans = Object.fromEntries(licenses.map(({ tenantId, plan, entitled }) => [tenantId, entitled && plan ? plan : "community"]))
  const deps = fakeDeps({ plans, proPair: (a, b) => proPair(licenses, a, b) })
  const source = new FakeTenant(TENANT_A)
  const policy = source.addPolicy({ name: "Development policy", settings: [setting("setting-1", "value")] })
  wire(deps, [source, new FakeTenant(TENANT_B), new FakeTenant(TENANT_C)])
  const sync = syncRoutes(deps)
  const promotion = promotionRoutes(deps)
  const items = [{ sourceId: policy.id, folder: "ConfigurationPolicies" }]
  return {
    deps,
    reject: (tenantId: string, id: string) => call(promotion, "/api/promotion", { tenantId, action: "reject", id }),
    targets: () => call(sync, "/api/sync", { tenantId: TENANT_A, action: "targets" }),
    copy: (...ids: string[]) => call(sync, "/api/sync", { tenantId: TENANT_A, action: "plan", title: "Copy policy", items, targetTenants: named(ids) }),
    promote: (tenantId: string) => call(promotion, "/api/promotion", { tenantId, sourceTenantId: TENANT_A, targetTenants: named([TENANT_A]), action: "plan", title: "Promote policy", items }),
  }
}

const key: License = { tenantId: TENANT_A, plan: "pro", entitled: true, source: "key" }
const trial: License = { tenantId: TENANT_B, plan: "pro", entitled: true, source: "trial" }
const msp: License = { tenantId: TENANT_C, plan: "msp", entitled: true, source: "tenant" }
const community: License = { tenantId: TENANT_C, plan: "community", entitled: false, source: null }

describe("Copy to Tenants and Dev to Prod licensing", () => {
  it("allows a single copy to either a Pro trial or MSP from a Pro key", async () => {
    const context = setup([key, trial, msp])
    expect(await context.targets()).toMatchObject({
      status: 200,
      body: {
        multiple: false,
        targets: [TENANT_B, TENANT_C].map((tenantId) => ({ tenantId, eligible: true, multiple: false, reason: null })),
      },
    })
    expect((await context.copy(TENANT_B)).status).toBe(200)
    expect((await context.copy(TENANT_C)).status).toBe(200)
    expect(await context.copy(TENANT_B, TENANT_C)).toMatchObject({ status: 402, body: { upgrade: "bulkActions" } })
  })

  it("blocks a Community destination for both features", async () => {
    const context = setup([key, trial, community])
    expect((await context.targets()).body.targets).toContainEqual({ tenantId: TENANT_C, eligible: false, multiple: false, reason: "plan" })
    expect(await context.copy(TENANT_C)).toMatchObject({ status: 402, body: { upgrade: "sync" } })
    expect(await context.promote(TENANT_C)).toMatchObject({ status: 402, body: { upgrade: "promotion" } })
  })

  it("allows MSP to copy to several MSP targets or to one Pro target", async () => {
    const mspSource = { ...key, plan: "msp" } as const
    const allMsp = setup([mspSource, { ...trial, plan: "msp", source: "tenant" }, msp])
    expect((await allMsp.copy(TENANT_B)).status).toBe(200)
    expect((await allMsp.copy(TENANT_B, TENANT_C)).status).toBe(200)

    const mixed = setup([mspSource, trial, msp])
    expect((await mixed.targets()).body).toEqual({
      multiple: true,
      targets: [
        { tenantId: TENANT_B, eligible: true, multiple: false, reason: null },
        { tenantId: TENANT_C, eligible: true, multiple: true, reason: null },
      ],
    })
    expect((await mixed.copy(TENANT_B)).status).toBe(200)
    expect(await mixed.copy(TENANT_B, TENANT_C)).toMatchObject({ status: 402, body: { upgrade: "bulkActions" } })
  })

  it("allows Dev to Prod from a Pro key to a Pro trial", async () => {
    const context = setup([key, trial, msp])
    expect(await context.promote(TENANT_B)).toMatchObject({ status: 200, body: { promotion: { sourceTenantId: TENANT_A } } })
  })

  it("lets a pending promotion be rejected after the source tenant's plan lapses", async () => {
    const context = setup([key, trial, msp])
    const planned = await context.promote(TENANT_B)
    const plan = context.deps.plan
    context.deps.plan = async (tenantId) => {
      if (tenantId.toLowerCase() === TENANT_A) throw new Error("This tenant is not licensed.")
      return plan(tenantId)
    }
    expect((await context.reject(TENANT_B, planned.body.promotion.id)).status).toBe(200)
  })
})
