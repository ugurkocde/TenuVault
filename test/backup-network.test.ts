import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine, verifyStorageAccess } from "../src/main/backup/engine"
import { INTUNE_TYPES } from "../src/shared/intune/registry"

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

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("backup request recovery", () => {
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
