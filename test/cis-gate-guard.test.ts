import { describe, expect, it, vi } from "vitest"
import { cisGuard } from "../src/main/api/cis-gate"
import { ApiHost } from "../src/main/api/host"
import { requiredFeatures } from "../src/main/api/plan-gates"
import { featureRouteFeatures } from "../src/shared/feature-routes"

const tenantId = "11111111-1111-1111-1111-111111111111"
const post = (path: string, body: object) => new Request(`http://tenuvault.internal${path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

describe("cisGuard", () => {
  it("leaves CIS Benchmarks and remediation to the plan guard, without any internal claim", async () => {
    const guard = cisGuard(() => "cached-token")
    for (const request of [
      post("/api/frameworks", { action: "assess", frameworkId: "cis-benchmarks", tenantId }),
      post("/api/frameworks", { action: "workspace-load", frameworkId: "cis-benchmarks", tenantId }),
      post("/api/cis-remediation", { action: "apply", tenantId, id: "deployment-1" }),
      post("/api/cis-remediation", { action: "list", tenantId }),
    ]) {
      await expect(guard(request)).resolves.toBeNull()
    }
    // The plan guard then asks for Pro or MSP for every paid CIS action.
    for (const action of ["assess", "assess-start", "cis-catalog", "cis-fetch-pack", "workspace-cis-pdf", "workspace-csv", "workspace-json"]) {
      expect(requiredFeatures("/api/frameworks", { action, frameworkId: "cis-benchmarks" })).toEqual(["baselineAllPlatforms"])
    }
    for (const action of ["plan", "preview", "approve", "apply", "rollback-create", "rollback-apply"]) {
      expect(featureRouteFeatures("/api/cis-remediation", action)).toEqual(["baselineAllPlatforms"])
    }
    // Stored deployments stay readable on every plan.
    expect(featureRouteFeatures("/api/cis-remediation", "list")).toEqual([])
  })

  it("refuses CIS content delivery without a cached entitlement before downstream guards", async () => {
    const downstream = vi.fn(async () => null)
    const handler = vi.fn(async () => Response.json({ ok: true }))
    const host = new ApiHost({
      routes: { "/api/frameworks": { POST: handler } },
      guard: async (request) => (await cisGuard(() => null)(request)) ?? downstream(),
    })

    for (const body of [
      { action: "cis-catalog", frameworkId: "cis-benchmarks", tenantId },
      { action: "cis-fetch-pack", frameworkId: "cis-benchmarks", tenantId, benchmark: "fakebook-os", version: "9.9.9", level: 1 },
    ]) {
      const response = await host.dispatch(post("/api/frameworks", body))
      expect(response.status).toBe(401)
    }
    expect(downstream).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()

    const entitled = cisGuard((requested) => (requested === tenantId ? "cached-token" : null))
    await expect(entitled(post("/api/frameworks", { action: "cis-catalog", frameworkId: "cis-benchmarks", tenantId }))).resolves.toBeNull()
    await expect(entitled(post("/api/frameworks", { action: "assess", frameworkId: "cis-benchmarks", tenantId: "22222222-2222-2222-2222-222222222222" }))).resolves.toBeNull()
  })

  it("always refuses CIS Controls before downstream guards and leaves other frameworks to them", async () => {
    const downstream = vi.fn(async () => null)
    const handler = vi.fn(async () => Response.json({ ok: true }))
    const host = new ApiHost({
      routes: { "/api/frameworks": { POST: handler } },
      guard: async (request) => (await cisGuard(() => "cached-token")(request)) ?? downstream(),
    })
    const controls = await host.dispatch(post("/api/frameworks", { action: "workspace-load", frameworkId: "cis-controls", tenantId }))
    expect(controls.status).toBe(403)
    expect(await controls.json()).toEqual({ error: "CIS Controls are coming soon." })
    expect(downstream).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
    const guard = cisGuard(() => "cached-token")
    await expect(guard(post("/api/frameworks", { action: "assess", frameworkId: "microsoft", tenantId }))).resolves.toBeNull()
  })
})
