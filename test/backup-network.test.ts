import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine, verifyStorageAccess } from "../src/main/backup/engine"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { encryptedAzureFetch, openAzure, registerStorageToken, sealAzure } from "../src/main/storage/azure-seal"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
import { withNetworkErrors } from "../src/main/api/network-error"

const TENANT = "11111111-1111-1111-1111-111111111111"
const request = {
  tenantId: TENANT,
  clientId: "22222222-2222-2222-2222-222222222222",
  storageAccountName: "contoso",
  scope: { excluded: INTUNE_TYPES.filter((type) => type.folder !== "DeviceConfigurations").map((type) => type.folder) },
}

function requestTimers() {
  vi.useFakeTimers()
  // Node's native AbortSignal timer does not use the timers replaced by Vitest.
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException("The request timed out", "TimeoutError")), ms)
    return controller.signal
  })
}

function setup(override: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    return override(url, init) ?? (url.hostname === "graph.microsoft.com" ? Response.json({ value: [] }) : new Response(null, { status: 201 }))
  })
  const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token" })
  return { engine, fetchImpl }
}

const master = Buffer.alloc(32, 4)
function azureBridge(networkFetch: typeof fetch): typeof fetch {
  registerStorageToken("token", TENANT)
  return createBridgedFetch({
    dispatch: async () => new Response(),
    getDelegatedToken: async () => ({ accessToken: "token", expiresOn: null }),
    fetch: encryptedAzureFetch(withNetworkErrors(networkFetch), () => [master], () => undefined),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("backup request recovery", () => {
  it("aborts encrypted uploads at the network boundary when the engine times out", async () => {
    requestTimers()
    const signals: AbortSignal[] = []
    const networkFetch: typeof fetch = async input => {
      const outgoing = input as Request
      if (outgoing.method === "PUT" && !new URL(outgoing.url).search) {
        signals.push(outgoing.signal)
        return new Promise((_resolve, reject) => {
          outgoing.signal.addEventListener("abort", () => reject(outgoing.signal.reason), { once: true })
        })
      }
      return outgoing.url.includes("graph.microsoft.com") ? Response.json({ value: [] }) : new Response(null, { status: 201 })
    }
    const engine = new BackupEngine({ fetch: azureBridge(networkFetch), getToken: async () => "token" })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(89_999)
    expect(signals[0]!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signals[0]!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(183_000)
    expect(job.status).toBe("Failed")
    expect(signals).toHaveLength(3)
    expect(signals.every(signal => signal.aborted)).toBe(true)
  })

  it.each([
    ["policy", "lost response", true, 409], ["policy", "lost response", false, 409],
    ["metadata", "lost response", true, 409], ["metadata", "lost response", false, 409],
    ["policy", "timeout", true, 409], ["policy", "timeout", false, 409],
    ["metadata", "timeout", true, 409], ["metadata", "timeout", false, 409],
    ["policy", "lost response", true, 412], ["metadata", "lost response", true, 412],
    ["policy", "lost response", true, 403], ["metadata", "lost response", true, 403],
  ] as const)("reconciles an ambiguous %s PUT after %s only when plaintext matches (%s), HTTP %s", async (blob, failure, matches, conflict) => {
    requestTimers()
    const stored = new Map<string, Uint8Array>()
    let puts = 0
    let reads = 0
    let metadata: Record<string, unknown> | undefined
    const networkFetch: typeof fetch = async input => {
      const outgoing = input as Request
      const url = new URL(outgoing.url)
      if (url.hostname === "graph.microsoft.com") {
        return url.pathname.endsWith("/deviceConfigurations")
          ? Response.json({ value: [{ id: "policy", displayName: "Policy" }] })
          : Response.json({ id: "policy", displayName: "Policy" })
      }
      if (url.search) return new Response(null, { status: 201 })
      const target = url.pathname.endsWith(blob === "metadata" ? "/metadata.json" : "/Policy.json")
      if (outgoing.method === "GET") {
        reads++
        expect(outgoing.signal).toBeInstanceOf(AbortSignal)
        return new Response(new Uint8Array(stored.get(url.pathname)!), { status: 200 })
      }
      const ciphertext = new Uint8Array(await outgoing.arrayBuffer())
      const plaintext = openAzure(Buffer.from(ciphertext), [master], TENANT, url).data.toString()
      if (url.pathname.endsWith("/metadata.json")) metadata = JSON.parse(plaintext) as Record<string, unknown>
      if (target && ++puts > 1) return new Response(null, { status: conflict, headers: { "x-ms-error-code": "BlobImmutableDueToPolicy" } })
      stored.set(url.pathname, target && !matches ? new Uint8Array(sealAzure(Buffer.from('{"different":true}'), master, TENANT, url)) : ciphertext)
      if (target) {
        if (failure === "timeout") return new Promise(() => {})
        throw new TypeError("Response lost after upload")
      }
      return new Response(null, { status: 201 })
    }
    const engine = new BackupEngine({ fetch: azureBridge(networkFetch), getToken: async () => "token" })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(failure === "timeout" ? 91_000 : 1_000)
    expect(puts).toBe(2)
    expect(reads).toBe(1)
    expect(job.status).toBe(matches ? "Completed" : "Failed")
    expect(metadata).toMatchObject({ ItemCounts: { TotalPolicies: blob === "policy" && !matches ? 0 : 1 }, Failures: blob === "policy" && !matches ? 1 : 0 })
    if (matches) expect(job.progressMessage).toBe("Backup completed successfully")
    else if (blob === "policy") expect(job.log.some(line => line.includes("Could not back up") && line.includes("409"))).toBe(true)
    else expect(job.exception).toContain("409")
  })

  it("does not accept a conflict without an earlier ambiguous upload", async () => {
    requestTimers()
    let reads = 0
    const { engine } = setup((url, init) => {
      if (url.hostname === "graph.microsoft.com") return
      if (init?.method === "GET") reads++
      if (url.pathname.endsWith("/metadata.json")) return new Response(null, { status: 409 })
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(0)
    expect(job.status).toBe("Failed")
    expect(reads).toBe(0)
  })

  it("bounds a hung read-back after an ambiguous upload conflict", async () => {
    requestTimers()
    let puts = 0
    const signals: AbortSignal[] = []
    const { engine } = setup((url, init) => {
      if (!url.pathname.endsWith("/metadata.json")) return
      if (init!.method === "PUT") {
        if (++puts === 1) throw new TypeError("Response lost after upload")
        return new Response(null, { status: 409 })
      }
      signals.push(init!.signal!)
      return new Promise(() => {})
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(183_000)
    expect(job.status).toBe("Failed")
    expect(puts).toBe(3)
    expect(signals).toHaveLength(2)
    expect(signals.every(signal => signal.aborted)).toBe(true)
  })

  it.each([120, 300])("honours a Graph Retry-After of %s seconds", async seconds => {
    requestTimers()
    const calls: number[] = []
    const { engine } = setup(url => {
      if (url.hostname !== "graph.microsoft.com") return
      calls.push(Date.now())
      return calls.length === 1 ? new Response(null, { status: 429, headers: { "Retry-After": String(seconds) } }) : Response.json({ value: [] })
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(seconds * 1000 - 1)
    expect(calls).toHaveLength(1)
    expect(job.status).toBe("Running")
    await vi.advanceTimersByTimeAsync(1)
    expect(calls[1]! - calls[0]!).toBe(seconds * 1000)
    expect(job.status).toBe("Completed")
  })

  it("rechecks the shared Graph pause after a delayed token without spending an attempt", async () => {
    requestTimers()
    let tokenCalls = 0
    const calls = new Map<string, number[]>()
    const started = Date.now()
    const fetchImpl: typeof fetch = async input => {
      const url = new URL(String(input))
      if (url.hostname !== "graph.microsoft.com") return new Response(null, { status: 201 })
      if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: [{ id: "fast", displayName: "Fast" }, { id: "slow", displayName: "Slow" }] })
      const id = url.pathname.split("/").at(-1)!
      const times = calls.get(id) ?? []
      times.push(Date.now() - started)
      calls.set(id, times)
      return times.length <= 2 ? new Response(null, { status: 429, headers: { "Retry-After": "120" } }) : Response.json({ id })
    }
    const engine = new BackupEngine({ fetch: fetchImpl, getToken: async (_tenant, _client, scope) => {
      if (scope.includes("graph.microsoft.com") && ++tokenCalls === 3) await new Promise(resolve => { setTimeout(resolve, 10_000) })
      return "token"
    } })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(calls.get("fast")).toEqual([0])
    expect(calls.has("slow")).toBe(false)
    await vi.advanceTimersByTimeAsync(360_001)
    expect(calls.get("fast")).toEqual([0, 120_000, 240_000])
    expect(calls.get("slow")).toEqual([240_000, 360_000, 480_000])
    expect(job.status).toBe("Completed")
  })

  it("fails a bounded request instead of retrying before a pause above five minutes", async () => {
    requestTimers()
    let calls = 0
    const { engine } = setup(url => {
      if (url.hostname !== "graph.microsoft.com") return
      calls++
      return new Response(null, { status: 429, headers: { "Retry-After": "301" } })
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(0)
    expect(job.status).toBe("Failed")
    expect(job.log.some(line => line.includes("longer than 5 minutes"))).toBe(true)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(calls).toBe(1)
  })

  it("holds all concurrent readers until the extended shared Graph resume time", async () => {
    requestTimers()
    const items = Array.from({ length: 8 }, (_, index) => ({ id: `policy-${index}`, displayName: `Policy ${index}` }))
    const calls = new Map<string, number[]>()
    const started = Date.now()
    const { engine } = setup(url => {
      if (url.hostname !== "graph.microsoft.com") return
      if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: items })
      const id = url.pathname.split("/").at(-1)!
      const times = calls.get(id) ?? []
      times.push(Date.now() - started)
      calls.set(id, times)
      if (times.length > 1) return Response.json({ id, displayName: id })
      const throttled = () => new Response(null, { status: 429, headers: { "Retry-After": id === "policy-0" || id === "policy-1" ? "120" : "60" } })
      return id === "policy-1" ? new Promise<Response>(resolve => { setTimeout(() => resolve(throttled()), 20_000) }) : throttled()
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(139_999)
    expect(calls.size).toBe(8)
    expect([...calls.values()].every(times => times.length === 1)).toBe(true)
    expect(job.status).toBe("Running")
    await vi.advanceTimersByTimeAsync(1)
    expect([...calls.values()].every(times => times.length === 2 && times[1] === 140_000)).toBe(true)
    expect(job.status).toBe("Completed")
  })

  it.each(["Graph", "blob"])("finishes a hung %s fetch after bounded attempts and accepts another backup", async (service) => {
    const timeout = requestTimers()
    const signals: AbortSignal[] = []
    let hanging = true
    const { engine } = setup((url, init) => {
      const graph = url.hostname === "graph.microsoft.com"
      if (hanging && graph === (service === "Graph")) {
        signals.push(init!.signal!)
        // Deliberately ignore aborts, as an injected fetch bridge can do.
        return new Promise(() => {})
      }
    })
    const job = engine.start(request)
    expect(engine.start(request).id).toBe(job.id)
    await vi.advanceTimersByTimeAsync(89_999)
    expect(job.status).toBe("Running")
    expect(signals[0]!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signals[0]!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(183_000)
    expect(job).toMatchObject({ status: "Failed", progress: 100 })
    expect(job.endTime).toBeDefined()
    expect(signals).toHaveLength(3)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(timeout.mock.calls.every(([ms]) => ms === 90_000)).toBe(true)

    hanging = false
    const next = engine.start(request)
    expect(next.id).not.toBe(job.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(next.status).toBe("Completed")
  })

  it("times out while reading a hung Graph response body", async () => {
    requestTimers()
    let calls = 0
    const { engine } = setup((url) => {
      if (url.hostname !== "graph.microsoft.com") return
      calls++
      return new Response(new ReadableStream())
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(273_000)
    expect(job.status).toBe("Failed")
    expect(job.endTime).toBeDefined()
    expect(calls).toBe(3)
  })

  it("retries a thrown Graph connection error and succeeds on the second attempt", async () => {
    requestTimers()
    let calls = 0
    const { engine, fetchImpl } = setup((url) => {
      if (url.hostname === "graph.microsoft.com" && ++calls === 1) throw new TypeError("Connection reset")
      return undefined
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toBe(1)
    expect(job.status).toBe("Running")
    await vi.advanceTimersByTimeAsync(1)
    expect(job.status).toBe("Completed")
    expect(calls).toBe(2)
    expect(fetchImpl.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true)
  })

  it("keeps an exhausted item request as a warning and saves other policies", async () => {
    requestTimers()
    let failedReads = 0
    let metadata: Record<string, unknown> | undefined
    const { engine } = setup((url, init) => {
      if (url.hostname !== "graph.microsoft.com") {
        if (url.pathname.endsWith("/metadata.json")) metadata = JSON.parse(init!.body as string) as Record<string, unknown>
        return
      }
      if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: [{ id: "bad", displayName: "Bad" }, { id: "good", displayName: "Good" }] })
      if (url.pathname.endsWith("/bad")) {
        failedReads++
        throw new TypeError("Connection reset")
      }
      return Response.json({ id: "good", displayName: "Good" })
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(job.status).toBe("Completed")
    expect(job.progressMessage).toBe("Backup completed with 1 warning")
    expect(metadata).toMatchObject({ Status: "CompletedWithWarnings", Failures: 1 })
    expect(failedReads).toBe(3)
  })

  it.each(["connection error", "429", "503"])("retries a blob %s and succeeds on the second attempt", async (failure) => {
    requestTimers()
    let attempts = 0
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      if (++attempts === 1) {
        if (failure === "connection error") throw new TypeError("DNS lookup failed")
        return new Response(null, { status: Number(failure) })
      }
      return new Response(null, { status: 201 })
    })
    const result = verifyStorageAccess(fetchImpl, "contoso", async () => "token")
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(result).resolves.toBeUndefined()
    // Container creation twice, then the probe write and delete.
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it("bounds a hung blob error body rather than blocking the job", async () => {
    requestTimers()
    const { engine, fetchImpl } = setup(() => new Response(new ReadableStream(), { status: 403 }))
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(273_000)
    expect(job.status).toBe("Failed")
    expect(job.exception).toContain("timed out")
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})
