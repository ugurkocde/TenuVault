import { describe, expect, it, vi } from "vitest"
import { armErrorMessage, createArmCaller } from "../src/main/azure/arm"

describe("ARM caller", () => {
  it("refuses paths outside Azure Resource Manager before asking for a token", async () => {
    const getToken = vi.fn(async () => "token")
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }))
    const arm = createArmCaller({ getToken, fetch: fetch as typeof globalThis.fetch, sleep: async () => undefined })
    await expect(arm({ method: "GET", path: "https://example.test/subscriptions/x" })).rejects.toThrow(/Azure Resource Manager/)
    await expect(arm({ method: "GET", path: "/tenants/x" })).rejects.toThrow(/Azure Resource Manager/)
    expect(getToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("sends the token only to management.azure.com and parses JSON errors", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const arm = createArmCaller({
      getToken: async () => "arm-token",
      fetch: (async (url: string, init?: RequestInit) => {
        seen.push({ url, init })
        return new Response(JSON.stringify({ error: { code: "BadThing", message: "It broke" } }), { status: 400, headers: { "content-type": "application/json" } })
      }) as typeof globalThis.fetch,
      sleep: async () => undefined,
    })
    const response = await arm({ method: "GET", path: "/subscriptions/22222222-2222-4222-8222-222222222222?api-version=2022-12-01" })
    expect(response.status).toBe(400)
    expect(armErrorMessage(response.body, response.status)).toBe("It broke")
    expect(seen[0]!.url).toBe("https://management.azure.com/subscriptions/22222222-2222-4222-8222-222222222222?api-version=2022-12-01")
    expect(((seen[0]!.init as RequestInit).headers as Record<string, string>).authorization).toBe("Bearer arm-token")
  })

  it("honours Retry-After for a throttled read, capped", async () => {
    const sleeps: number[] = []
    let calls = 0
    const arm = createArmCaller({
      getToken: async () => "arm-token",
      fetch: (async () => {
        calls++
        return calls === 1
          ? new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429, headers: { "retry-after": "99" } })
          : new Response(JSON.stringify({ ok: true }), { status: 200 })
      }) as typeof globalThis.fetch,
      sleep: async (ms) => void sleeps.push(ms),
    })
    await expect(arm({ method: "GET", path: "/subscriptions/22222222-2222-4222-8222-222222222222?api-version=2022-12-01" })).resolves.toMatchObject({ status: 200 })
    expect(sleeps).toEqual([10_000])
  })

  it("never retries a write automatically", async () => {
    let calls = 0
    const arm = createArmCaller({
      getToken: async () => "arm-token",
      fetch: (async () => { calls++; return new Response("{}", { status: 503 }) }) as typeof globalThis.fetch,
      sleep: async () => undefined,
    })
    await arm({ method: "PUT", path: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Resources/deployments/d?api-version=2022-09-01", body: { secret: "do-not-log" } })
    expect(calls).toBe(1)
  })
})
