import { describe, expect, it } from "vitest"
import { CommunityLimitError, withPlanError } from "../src/shared/plan-errors"
import { PlanRequired } from "../src/shared/plans"
import type { TenuVaultPreloadBridge } from "../src/shared/ipc"
import { createRendererBridge, unwrapPlanResult } from "../src/renderer/lib/plan-bridge"
import { FeatureApiError } from "../src/renderer/lib/feature-api"

describe("plan errors across IPC and preload", () => {
  it("surfaces the Community code and tenant after data serialization", async () => {
    const reply = await withPlanError(() => { throw new CommunityLimitError("tenant-id", "The tenant was not added. Original limit message.") })
    const serialized = JSON.parse(JSON.stringify(reply))
    const raw = {
      auth: { signIn: async () => serialized },
      license: { checkNewTenant: async () => serialized },
      schedules: { set: async () => [] },
    } as unknown as TenuVaultPreloadBridge
    const bridge = createRendererBridge(raw)
    for (const result of [bridge.auth.signIn("tenant", "client"), bridge.license.checkNewTenant("tenant")]) {
      await expect(result).rejects.toBeInstanceOf(CommunityLimitError)
      await expect(result).rejects.toMatchObject({ code: "community_tenant_limit", tenantId: "tenant-id", message: "The tenant was not added. Original limit message." })
    }
  })

  it("surfaces a schedule plan refusal as a feature API error", async () => {
    const reply = await withPlanError(() => { throw new PlanRequired("dailySchedule") })
    const result = unwrapPlanResult(Promise.resolve(JSON.parse(JSON.stringify(reply))))
    await expect(result).rejects.toBeInstanceOf(FeatureApiError)
    await expect(result).rejects.toMatchObject({ status: 402, upgrade: "dailySchedule" })
  })

  it("keeps successful results and ordinary failures unchanged", async () => {
    const result = { tenantId: "tenant" }
    await expect(unwrapPlanResult(withPlanError(() => result))).resolves.toBe(result)
    const failure = new Error("Sign-in failed")
    await expect(withPlanError(() => { throw failure })).rejects.toBe(failure)
    await expect(unwrapPlanResult(Promise.reject(failure))).rejects.toBe(failure)
  })
})
