import { describe, expect, it, vi } from "vitest"
import { cisInternalGuard } from "../src/main/api/cis-gate"
import { ApiHost } from "../src/main/api/host"

const tenantId = "11111111-1111-1111-1111-111111111111"
const post = (path: string, body: object) => new Request(`http://tenuvault.internal${path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

describe("cisInternalGuard", () => {
  it("refuses CIS Benchmarks and remediation before downstream guards and handlers", async () => {
    const downstream = vi.fn(async () => null)
    const handler = vi.fn(async () => Response.json({ ok: true }))
    const host = new ApiHost({
      routes: {
        "/api/frameworks": { POST: handler },
        "/api/cis-remediation": { POST: handler },
      },
      guard: async (request) => (await cisInternalGuard(() => false)(request)) ?? downstream(),
    })

    for (const request of [
      post("/api/frameworks", { action: "assess", frameworkId: "cis-benchmarks", tenantId }),
      post("/api/cis-remediation", { action: "apply", tenantId, id: "deployment-1" }),
    ]) {
      const response = await host.dispatch(request)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: "CIS comparisons are coming soon." })
    }
    expect(downstream).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it("always refuses CIS Controls and leaves other frameworks to downstream guards", async () => {
    const guard = cisInternalGuard(() => true)
    const controls = await guard(post("/api/frameworks", { action: "workspace-load", frameworkId: "cis-controls", tenantId }))
    expect(controls?.status).toBe(403)
    expect(await controls?.json()).toEqual({ error: "CIS Controls are coming soon." })
    await expect(guard(post("/api/frameworks", { action: "assess", frameworkId: "microsoft", tenantId }))).resolves.toBeNull()
    await expect(guard(post("/api/frameworks", { action: "assess", frameworkId: "cis-benchmarks", tenantId }))).resolves.toBeNull()
    await expect(guard(post("/api/cis-remediation", { action: "list", tenantId }))).resolves.toBeNull()
  })
})
