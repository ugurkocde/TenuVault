import { afterEach, expect, it, vi } from "vitest"
import { BackupEngine, JOB_DEADLINE_MS } from "../src/main/backup/engine"
import { LARGE_TYPE_MS } from "../src/shared/large-backup"
import { registerTestTypes, testType, jwt, TENANT, CLIENT } from "./helpers/backup-fixture"
let undo: (() => void) | undefined
afterEach(() => { undo?.(); vi.useRealTimers() })
it("keeps a healthy large type past 30 minutes and ends only that type at two hours", async () => {
  vi.useFakeTimers()
  const common = { volume: "large" as const, listOnly: true as const, apiVersion: "v1.0" as const }
  undo = registerTestTypes([testType("AuthorizationPolicy", "synthetic", common), testType("TokenLifetimePolicies", "next", common)])
  const files = new Map<string, string>()
  let pages = 0
  const engine = new BackupEngine({ getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["entra"] }), fetch: (async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === "graph.microsoft.com") {
      if (url.pathname.endsWith("/next")) return Response.json({ value: [{ id: "kept" }] })
      return new Promise(resolve => { setTimeout(() => resolve(Response.json({ value: [], "@odata.nextLink": `https://graph.microsoft.com/v1.0/synthetic?page=${++pages}` })), 60_000) })
    }
    if (init?.method === "PUT") { files.set(url.pathname, String(init.body)); return new Response(null, { status: 201 }) }
    return new Response(null, { status: 404 })
  }) as typeof fetch })
  const job = engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: "contoso" })
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(JOB_DEADLINE_MS + 60_000)
  expect(job.status).toBe("Running")
  await vi.advanceTimersByTimeAsync(LARGE_TYPE_MS - JOB_DEADLINE_MS - 60_000)
  await engine.waitForJob(job)
  expect(job.coverage).toBe("incomplete")
  const metadata = JSON.parse([...files].find(([name]) => name.endsWith("metadata.json"))![1])
  expect(metadata.FailedTypes).toContain("AuthorizationPolicy")
  expect(metadata.LargeItems.TokenLifetimePolicies.complete).toBe(true)
  expect(metadata.ItemCounts.TokenLifetimePolicies).toBe(1)
})

it("interrupts a large upload retry at the type deadline and keeps the next type running", async () => {
  vi.useFakeTimers()
  const common = { volume: "large" as const, listOnly: true as const, apiVersion: "v1.0" as const }
  undo = registerTestTypes([testType("AuthorizationPolicy", "synthetic", { ...common, readBudget: { durationMs: 1000, maxRequests: 10 } }), testType("TokenLifetimePolicies", "next", common)])
  const files = new Map<string, string>()
  const engine = new BackupEngine({ getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["entra"] }), fetch: (async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === "graph.microsoft.com") return Response.json({ value: [{ id: url.pathname.endsWith("/next") ? "kept" : "slow" }] })
    if (url.pathname.endsWith("AuthorizationPolicy/slow.json")) return new Response(null, { status: 503, headers: { "Retry-After": "300" } })
    if (init?.method === "PUT") { files.set(url.pathname, String(init.body)); return new Response(null, { status: 201 }) }
    return new Response(null, { status: 404 })
  }) as typeof fetch })
  const job = engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: "contoso" })
  await vi.advanceTimersByTimeAsync(1000)
  await engine.waitForJob(job)
  const metadata = JSON.parse([...files].find(([name]) => name.endsWith("metadata.json"))![1])
  expect(job.coverage).toBe("incomplete")
  expect(metadata.LargeItems.AuthorizationPolicy.complete).toBe(false)
  expect(metadata.LargeItems.TokenLifetimePolicies.complete).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
