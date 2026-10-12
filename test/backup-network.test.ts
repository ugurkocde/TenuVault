import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine, verifyStorageAccess } from "../src/main/backup/engine"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { encryptedAzureFetch, openAzure, registerStorageToken, sealAzure } from "../src/main/storage/azure-seal"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
import { withNetworkErrors } from "../src/main/api/network-error"
import { localStorageAccountName } from "../src/shared/constants"

const TENANT = "11111111-1111-1111-1111-111111111111"
const request = {
  tenantId: TENANT,
  clientId: "22222222-2222-2222-2222-222222222222",
  storageAccountName: "contoso",
  scope: { excluded: INTUNE_TYPES.filter((type) => type.folder !== "DeviceConfigurations").map((type) => type.folder) },
}

function requestTimers() {
  vi.useFakeTimers()
}

function setup(override: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined, concurrency?: number) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    return override(url, init) ?? (url.hostname === "graph.microsoft.com" ? Response.json({ value: [] }) : new Response(null, { status: 201 }))
  })
  const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", concurrency })
  return { engine, fetchImpl }
}

const master = Buffer.alloc(32, 4)
function azureBridge(networkFetch: typeof fetch, requireRecovery: () => void = () => undefined): typeof fetch {
  registerStorageToken("token", TENANT)
  return createBridgedFetch({
    dispatch: async () => new Response(),
    getDelegatedToken: async () => ({ accessToken: "token", expiresOn: null }),
    fetch: encryptedAzureFetch(withNetworkErrors(networkFetch), () => [master], requireRecovery),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("backup request recovery", () => {
  it.each(["PUT", "DELETE"])("retries a %s with Azure ServerBusy and its millisecond retry delay", async method => {
    requestTimers()
    const attempts: number[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (!url.search && init?.method === method) {
        attempts.push(Date.now())
        if (attempts.length === 1) return new Response("<Error><Code>ServerBusy</Code></Error>", { status: 503, headers: { "Retry-After": "1", "x-ms-retry-after-ms": "2000" } })
      }
      return new Response(null, { status: init?.method === "DELETE" ? 202 : 201 })
    }
    const pending = verifyStorageAccess(fetchImpl, "contoso", async () => "token")
    await vi.advanceTimersByTimeAsync(1999)
    expect(attempts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBeUndefined()
    expect(attempts).toHaveLength(2)
    expect(attempts[1]! - attempts[0]!).toBe(2000)
  })

  it.each(["PUT", "DELETE"])("retries thrown %s transport failures at one and two seconds", async method => {
    requestTimers()
    const attempts: number[] = []
    const started = Date.now()
    const fetchImpl: typeof fetch = async (input, init) => {
      if (!new URL(String(input)).search && init?.method === method) {
        attempts.push(Date.now() - started)
        if (attempts.length < 3) throw new TypeError("fetch failed", { cause: { code: attempts.length === 1 ? "ECONNRESET" : "ETIMEDOUT" } })
      }
      return new Response(null, { status: init?.method === "DELETE" ? 202 : 201 })
    }
    const pending = verifyStorageAccess(fetchImpl, "contoso", async () => "token")
    await vi.advanceTimersByTimeAsync(3000)
    await expect(pending).resolves.toBeUndefined()
    expect(attempts).toEqual([0, 1000, 3000])
  })

  it("keeps recovery-key preconditions out of the storage circuit without retrying uploads", async () => {
    requestTimers()
    const message = "Save your current backup recovery key in Settings before the first encrypted Azure backup."
    const items = Array.from({ length: 32 }, (_, index) => ({ id: `policy-${index}`, displayName: `Policy ${index}` }))
    const networkFetch = vi.fn(async (input: RequestInfo | URL) => {
      const sent = input as Request
      const url = new URL(sent.url)
      if (url.hostname !== "graph.microsoft.com") return new Response(null, { status: 201 })
      if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: items })
      return Response.json({ id: url.pathname.split("/").at(-1) })
    })
    const requireRecovery = vi.fn(() => { throw new Error(message) })
    const engine = new BackupEngine({ fetch: azureBridge(networkFetch, requireRecovery), getToken: async () => "token" })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(0)
    expect(job).toMatchObject({ status: "Failed", progress: 100, progressMessage: "Backup failed", exception: message })
    expect(job.endTime).toBeDefined()
    for (const item of items) expect(job.log.some(line => line.endsWith(`Could not back up "${item.displayName}": ${message}`))).toBe(true)
    expect(job.log.some(line => line.endsWith(`Backup failed: ${message}`))).toBe(true)
    expect(job.log.some(line => line.includes("did not respond"))).toBe(false)
    // One precondition check per policy and for the manifest. Only container creation reaches Azure.
    expect(requireRecovery).toHaveBeenCalledTimes(33)
    expect(networkFetch).toHaveBeenCalledTimes(34)
    expect(networkFetch.mock.calls.filter(([input]) => new URL((input as Request).url).hostname !== "graph.microsoft.com")).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(requireRecovery).toHaveBeenCalledTimes(33)
    expect(networkFetch).toHaveBeenCalledTimes(34)
  })

  it("does not retry application failures from the local fetch bridge", async () => {
    requestTimers()
    const message = "Backup encryption is unavailable on this device."
    const items = Array.from({ length: 32 }, (_, index) => ({ id: `policy-${index}`, displayName: `Policy ${index}` }))
    const networkFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: items })
      return Response.json({ id: url.pathname.split("/").at(-1) })
    })
    const handleLocalBlob = vi.fn(async (sent: Request) => {
      if (new URL(sent.url).search) return new Response(null, { status: 201 })
      throw new Error(message)
    })
    const bridge = createBridgedFetch({
      dispatch: async () => new Response(),
      getDelegatedToken: async () => ({ accessToken: "token", expiresOn: null }),
      handleLocalBlob,
      fetch: withNetworkErrors(networkFetch),
    })
    const engine = new BackupEngine({ fetch: bridge, getToken: async () => "token" })
    const job = engine.start({ ...request, storageAccountName: localStorageAccountName(TENANT) })
    await vi.advanceTimersByTimeAsync(0)
    expect(job).toMatchObject({ status: "Failed", progress: 100, exception: message })
    expect(job.log.filter(line => line.includes("Could not back up") && line.endsWith(message))).toHaveLength(32)
    expect(job.log.some(line => line.includes("did not respond"))).toBe(false)
    // Container creation, one attempt per policy, and the manifest.
    expect(handleLocalBlob).toHaveBeenCalledTimes(34)
    expect(networkFetch).toHaveBeenCalledTimes(33)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(handleLocalBlob).toHaveBeenCalledTimes(34)
    expect(networkFetch).toHaveBeenCalledTimes(33)
  })

  it.each(["after listing", "before listing"])("stops an outage %s within five minutes and releases the tenant", async scenario => {
    requestTimers()
    const started = Date.now()
    const signals: AbortSignal[] = []
    const items = Array.from({ length: 1000 }, (_, index) => ({ id: `policy-${index}`, displayName: `Policy ${index}` }))
    let hanging = true
    let listed = false
    const { engine, fetchImpl } = setup((url, init) => {
      if (!hanging) return
      if (scenario === "before listing" && url.hostname !== "graph.microsoft.com") return
      if (scenario === "after listing" && !listed) {
        if (url.hostname !== "graph.microsoft.com") return
        listed = true
        return Response.json({ value: items })
      }
      signals.push(init!.signal!)
      // The job must finish even if a bridge ignores both timeout and job aborts.
      return new Promise(() => {})
    })
    const outageRequest = scenario === "before listing"
      ? { ...request, storageAccountName: localStorageAccountName(TENANT), scope: { excluded: [] } }
      : request
    const job = engine.start(outageRequest)
    await vi.advanceTimersByTimeAsync(272_999)
    expect(job.status).toBe("Running")
    await vi.advanceTimersByTimeAsync(1)
    expect(job).toMatchObject({ status: "Failed", progress: 100 })
    expect(job.endTime).toBeDefined()
    expect(new Date(job.endTime!).getTime() - started).toBe(273_000)
    expect(new Date(job.endTime!).getTime() - started).toBeLessThan(5 * 60_000)
    expect(job.exception).toBe("Backup stopped: Microsoft Graph did not respond for 24 consecutive requests. Earlier policies in this run were saved; the backup is incomplete.")
    expect(job.log.some(line => line.includes(job.exception!))).toBe(true)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(signals.every(signal => signal.reason.message.includes("timed out after 90 seconds") || signal.reason.message === job.exception)).toBe(true)
    // 24 failed attempts plus at most seven already in flight. Include container and optional list.
    expect(signals.length).toBeGreaterThanOrEqual(24)
    expect(signals.length).toBeLessThanOrEqual(31)
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(scenario === "after listing" ? 33 : 32)
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith("/metadata.json"))).toBe(false)

    hanging = false
    const next = engine.start(outageRequest)
    expect(next.id).not.toBe(job.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(next.status).toBe("Completed")
  })

  it.each(["hung fetch", "HTTP 503 with a hung body"])("stops 1,000 uploads with a %s despite healthy Graph reads within five minutes", async failure => {
    requestTimers()
    const started = Date.now()
    const signals: AbortSignal[] = []
    const items = Array.from({ length: 1000 }, (_, index) => ({ id: `policy-${index}`, displayName: `Policy ${index}` }))
    let hanging = true
    const { engine, fetchImpl } = setup((url, init) => {
      if (!hanging) return
      if (url.hostname === "graph.microsoft.com") {
        if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: items })
        return Response.json({ id: url.pathname.split("/").at(-1) })
      }
      if (url.search) return
      signals.push(init!.signal!)
      // Ignore aborts to prove the job does not depend on the bridge settling.
      return failure === "hung fetch" ? new Promise(() => {}) : new Response(new ReadableStream(), { status: 503 })
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(272_999)
    expect(job.status).toBe("Running")
    await vi.advanceTimersByTimeAsync(1)
    expect(job).toMatchObject({ status: "Failed", progress: 100 })
    expect(job.endTime).toBeDefined()
    expect(new Date(job.endTime!).getTime() - started).toBe(273_000)
    expect(new Date(job.endTime!).getTime() - started).toBeLessThan(5 * 60_000)
    expect(job.exception).toBe("Backup stopped: backup storage did not respond for 24 consecutive requests. Earlier policies in this run were saved; the backup is incomplete.")
    expect(signals.length).toBeGreaterThanOrEqual(24)
    expect(signals.length).toBeLessThanOrEqual(31)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(signals.every(signal => signal.reason.message.includes("timed out after 90 seconds"))).toBe(true)
    // 31 uploads, 15 healthy policy reads, container creation and the initial Graph list.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(48)
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith("/metadata.json"))).toBe(false)
    const calls = fetchImpl.mock.calls.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fetchImpl.mock.calls).toHaveLength(calls)

    hanging = false
    const next = engine.start(request)
    expect(next.id).not.toBe(job.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(next.status).toBe("Completed")
  })

  it.each([["Graph", 1000], ["blob", 8]] as const)("counts hung HTTP 503 %s bodies and stops %s items within five minutes", async (service, count) => {
    requestTimers()
    const started = Date.now()
    const signals: AbortSignal[] = []
    const items = Array.from({ length: count }, (_, index) => ({ id: `policy-${index}`, displayName: `Policy ${index}` }))
    const { engine, fetchImpl } = setup((url, init) => {
      if (url.hostname === "graph.microsoft.com") {
        if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: items })
        if (service === "blob") return Response.json({ id: url.pathname.split("/").at(-1) })
      } else if (service === "Graph" || url.search) return
      signals.push(init!.signal!)
      return new Response(new ReadableStream(), { status: 503 })
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(273_000)
    expect(job).toMatchObject({ status: "Failed", progress: 100 })
    expect(job.endTime).toBeDefined()
    expect(new Date(job.endTime!).getTime() - started).toBeLessThan(5 * 60_000)
    expect(job.exception).toContain("24 consecutive requests")
    expect(signals.length).toBeGreaterThanOrEqual(24)
    expect(signals.length).toBeLessThanOrEqual(31)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(service === "Graph" ? 33 : 41)
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith("/metadata.json"))).toBe(false)
  })

  it.each(["Graph", "blob"])("counts transport errors while reading an HTTP 503 %s body", async service => {
    requestTimers()
    let failures = 0
    const { engine } = setup((url) => {
      if (url.hostname === "graph.microsoft.com") {
        if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: Array.from({ length: 8 }, (_, index) => ({ id: `policy-${index}`, displayName: `Policy ${index}` })) })
        if (service === "blob") return Response.json({ id: url.pathname.split("/").at(-1) })
      } else if (service === "Graph" || url.search) return
      failures++
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("Connection reset while reading body")) } }), { status: 503 })
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(3000)
    expect(job.status).toBe("Failed")
    expect(job.endTime).toBeDefined()
    expect(job.exception).toContain("24 consecutive requests")
    expect(failures).toBe(24)
  })

  it.each(["unavailable key", "damaged ciphertext", "malformed envelope"])("keeps eight encrypted retention failures out of both circuits: %s", async failure => {
    requestTimers()
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"))
    const message = failure === "malformed envelope"
      ? "Backup authentication failed or the legacy snapshot is invalid"
      : "Backup authentication failed. Import the correct recovery key or recover an undamaged snapshot."
    const saved = new Map<string, Uint8Array>()
    const prefixes = Array.from({ length: 8 }, (_, index) => `backup-2026-08-01-02000${index}/`)
    for (const prefix of prefixes) {
      const url = new URL(`https://contoso.blob.core.windows.net/intune-backups/${prefix}metadata.json`)
      const sealed = sealAzure(Buffer.from(JSON.stringify({ Status: "Success", TenantId: TENANT })), failure === "unavailable key" ? Buffer.alloc(32, 8) : master, TENANT, url)
      if (failure === "damaged ciphertext") sealed[sealed.length - 1]! ^= 1
      saved.set(url.pathname, new Uint8Array(failure === "malformed envelope" ? Buffer.from("Invalid envelope") : sealed))
    }
    const original = new Map(saved)
    let reads = 0
    let deletes = 0
    const networkFetch = vi.fn(async (input: RequestInfo | URL) => {
      const sent = input as Request
      const url = new URL(sent.url)
      if (url.hostname === "graph.microsoft.com") return Response.json({ value: [] })
      if (url.search) {
        if (sent.method === "PUT") return new Response(null, { status: 201 })
        return new Response(`<EnumerationResults><Blobs>${prefixes.map(prefix => `<BlobPrefix><Name>${prefix}</Name></BlobPrefix>`).join("")}</Blobs></EnumerationResults>`)
      }
      if (sent.method === "PUT") {
        saved.set(url.pathname, new Uint8Array(await sent.arrayBuffer()))
        return new Response(null, { status: 201 })
      }
      if (sent.method === "DELETE") deletes++
      reads++
      return new Response(new Uint8Array(saved.get(url.pathname)!))
    })
    const engine = new BackupEngine({ fetch: azureBridge(networkFetch), getToken: async () => "token", retentionDays: () => 30 })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(0)
    expect(job).toMatchObject({ status: "Completed", progress: 100, progressMessage: "Backup completed with 1 warning" })
    expect(job.endTime).toBeDefined()
    expect(job.exception).toBeUndefined()
    expect(reads).toBe(8)
    expect(deletes).toBe(0)
    expect(job.log.join("\n")).toContain(`Could not read the metadata of 8 older backups: ${message.replace(/\.$/, "")}. They were left in place.`)
    expect(job.log.join("\n")).not.toContain("Could not remove old backups")
    expect(job.log.join("\n")).not.toMatch(/did not respond|network stopped responding/)
    const manifestUrl = new URL(`https://contoso.blob.core.windows.net/intune-backups/${job.backupFolder}/metadata.json`)
    const committed = saved.get(manifestUrl.pathname)!
    expect(JSON.parse(openAzure(Buffer.from(committed), [master], TENANT, manifestUrl).data.toString())).toMatchObject({ Status: "Success", Failures: 0 })
    expect(saved.size).toBe(9)
    for (const [path, body] of original) expect(saved.get(path)).toBe(body)
    const calls = networkFetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(reads).toBe(8)
    expect(networkFetch).toHaveBeenCalledTimes(calls)
    expect(saved.get(manifestUrl.pathname)).toBe(committed)
  })

  it("still removes the other expired backups when one metadata blob cannot be decrypted", async () => {
    requestTimers()
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"))
    const saved = new Map<string, Uint8Array>()
    const prefixes = ["backup-2026-08-01-020000/", "backup-2026-08-02-020000/", "backup-2026-08-03-020000/"]
    for (const [index, prefix] of prefixes.entries()) {
      const url = new URL(`https://contoso.blob.core.windows.net/intune-backups/${prefix}metadata.json`)
      const key = index === 1 ? Buffer.alloc(32, 8) : master
      saved.set(url.pathname, new Uint8Array(sealAzure(Buffer.from(JSON.stringify({ Status: "Success", TenantId: TENANT })), key, TENANT, url)))
      saved.set(`/intune-backups/${prefix}DeviceConfigurations/policy.json`, new Uint8Array(sealAzure(Buffer.from("{}"), key, TENANT, new URL(`https://contoso.blob.core.windows.net/intune-backups/${prefix}DeviceConfigurations/policy.json`))))
    }
    const deleted: string[] = []
    const networkFetch = vi.fn(async (input: RequestInfo | URL) => {
      const sent = input as Request
      const url = new URL(sent.url)
      if (url.hostname === "graph.microsoft.com") return Response.json({ value: [] })
      if (url.search) {
        if (sent.method === "PUT") return new Response(null, { status: 201 })
        const params = url.searchParams
        if (params.get("delimiter")) return new Response(`<EnumerationResults><Blobs>${prefixes.map(prefix => `<BlobPrefix><Name>${prefix}</Name></BlobPrefix>`).join("")}</Blobs></EnumerationResults>`)
        const names = [...saved.keys()].filter(path => path.startsWith(`/intune-backups/${params.get("prefix")}`)).map(path => path.slice("/intune-backups/".length))
        return new Response(`<EnumerationResults><Blobs>${names.map(name => `<Blob><Name>${name}</Name></Blob>`).join("")}</Blobs></EnumerationResults>`)
      }
      if (sent.method === "PUT") {
        saved.set(url.pathname, new Uint8Array(await sent.arrayBuffer()))
        return new Response(null, { status: 201 })
      }
      if (sent.method === "DELETE") {
        deleted.push(url.pathname)
        saved.delete(url.pathname)
        return new Response(null, { status: 202 })
      }
      const body = saved.get(url.pathname)
      return body ? new Response(new Uint8Array(body)) : new Response(null, { status: 404 })
    })
    const engine = new BackupEngine({ fetch: azureBridge(networkFetch), getToken: async () => "token", retentionDays: () => 30 })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(0)
    expect(job).toMatchObject({ status: "Completed", progress: 100, progressMessage: "Backup completed with 1 warning" })
    expect(job.exception).toBeUndefined()
    const log = job.log.join("\n")
    // The newest readable backup is kept because it holds types this backup leaves out; the oldest is removed.
    expect(log).toContain("Removed 1 backup older than 30 days.")
    expect(log).toContain("Kept 1 older backup because it holds the newest copy of types this backup leaves out.")
    expect(log).toContain("Could not read the metadata of 1 older backup: Backup authentication failed. Import the correct recovery key or recover an undamaged snapshot. It was left in place.")
    expect(log).not.toContain("Could not remove old backups")
    expect(log).not.toContain("not recorded as this tenant's")
    expect(deleted.filter(path => path.includes("backup-2026-08-01-"))).toHaveLength(2)
    expect(deleted.filter(path => path.includes("backup-2026-08-02-"))).toHaveLength(0)
    expect(deleted.filter(path => path.includes("backup-2026-08-03-"))).toHaveLength(0)
    expect([...saved.keys()].filter(path => path.includes("backup-2026-08-02-"))).toHaveLength(2)
  })

  it("keeps untagged backups when an unreadable backup may belong to another tenant", async () => {
    requestTimers()
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"))
    const saved = new Map<string, Uint8Array>()
    const prefixes = ["backup-2026-08-01-020000/", "backup-2026-08-02-020000/"]
    for (const [index, prefix] of prefixes.entries()) {
      const url = new URL(`https://contoso.blob.core.windows.net/intune-backups/${prefix}metadata.json`)
      // The older backup predates tenant tagging; the newer one cannot be decrypted with this tenant's key.
      const payload = index === 0 ? { Status: "Success" } : { Status: "Success", TenantId: "22222222-2222-2222-2222-222222222222" }
      saved.set(url.pathname, new Uint8Array(sealAzure(Buffer.from(JSON.stringify(payload)), index === 0 ? master : Buffer.alloc(32, 8), TENANT, url)))
    }
    const deleted: string[] = []
    const networkFetch = vi.fn(async (input: RequestInfo | URL) => {
      const sent = input as Request
      const url = new URL(sent.url)
      if (url.hostname === "graph.microsoft.com") return Response.json({ value: [] })
      if (url.search) {
        if (sent.method === "PUT") return new Response(null, { status: 201 })
        const params = url.searchParams
        if (params.get("delimiter")) return new Response(`<EnumerationResults><Blobs>${prefixes.map(prefix => `<BlobPrefix><Name>${prefix}</Name></BlobPrefix>`).join("")}</Blobs></EnumerationResults>`)
        const names = [...saved.keys()].filter(path => path.startsWith(`/intune-backups/${params.get("prefix")}`)).map(path => path.slice("/intune-backups/".length))
        return new Response(`<EnumerationResults><Blobs>${names.map(name => `<Blob><Name>${name}</Name></Blob>`).join("")}</Blobs></EnumerationResults>`)
      }
      if (sent.method === "PUT") {
        saved.set(url.pathname, new Uint8Array(await sent.arrayBuffer()))
        return new Response(null, { status: 201 })
      }
      if (sent.method === "DELETE") {
        deleted.push(url.pathname)
        saved.delete(url.pathname)
        return new Response(null, { status: 202 })
      }
      const body = saved.get(url.pathname)
      return body ? new Response(new Uint8Array(body)) : new Response(null, { status: 404 })
    })
    const engine = new BackupEngine({ fetch: azureBridge(networkFetch), getToken: async () => "token", retentionDays: () => 30 })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(0)
    expect(job).toMatchObject({ status: "Completed", progress: 100, progressMessage: "Backup completed with 1 warning" })
    expect(deleted).toHaveLength(0)
    const log = job.log.join("\n")
    expect(log).toContain("Kept 1 older backup not recorded as this tenant's")
    expect(log).toContain("Could not read the metadata of 1 older backup")
    expect(log).not.toContain("Removed")
  })

  it("commits the complete backup before eight retention reads hang", async () => {
    requestTimers()
    const started = Date.now()
    const saved = new Map<string, string>()
    const signals: AbortSignal[] = []
    const prefixes = Array.from({ length: 8 }, (_, index) => `backup-2026-08-01-02000${index}/`)
    const { fetchImpl } = setup((url, init) => {
      if (url.hostname === "graph.microsoft.com") return
      if (init?.method === "PUT" && !url.search) {
        saved.set(url.pathname, init.body as string)
        return
      }
      if (init?.method !== "GET") return
      if (url.search) return new Response(`<EnumerationResults><Blobs>${prefixes.map(prefix => `<BlobPrefix><Name>${prefix}</Name></BlobPrefix>`).join("")}</Blobs></EnumerationResults>`)
      expect(saved.size).toBe(1)
      signals.push(init.signal!)
      return new Promise(() => {})
    })
    const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30 })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(0)
    const manifest = `/intune-backups/${job.backupFolder}/metadata.json`
    expect(JSON.parse(saved.get(manifest)!)).toMatchObject({ Status: "Success", Failures: 0 })
    await vi.advanceTimersByTimeAsync(273_000)
    const committed = saved.get(manifest)
    expect(JSON.parse(committed!)).toMatchObject({ Status: "Success", Failures: 0 })
    expect(job).toMatchObject({ status: "Completed", progress: 100, progressMessage: "Backup completed with 1 warning" })
    expect(job.endTime).toBeDefined()
    expect(new Date(job.endTime!).getTime() - started).toBeLessThan(5 * 60_000)
    expect(job.exception).toBeUndefined()
    expect(job.log.join("\n")).toContain("Old backups were not removed because the network stopped responding. They will be reconsidered on the next run.")
    expect(signals).toHaveLength(24)
    expect(new Set(fetchImpl.mock.calls.filter(([input, init]) => init?.method === "GET" && !new URL(String(input)).search).map(([input]) => String(input))).size).toBe(8)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(saved.get(manifest)).toBe(committed)
    expect(saved.size).toBe(1)
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false)
    const calls = fetchImpl.mock.calls.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fetchImpl.mock.calls).toHaveLength(calls)
  })

  it.each(["first listing", "metadata read", "delete"])("reports one cleanup warning when a single retention %s hangs", async failure => {
    requestTimers()
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"))
    const oldPrefix = "backup-2026-08-01-020000/"
    const oldManifest = `/intune-backups/${oldPrefix}metadata.json`
    const oldPolicy = `/intune-backups/${oldPrefix}DeviceConfigurations/Old.json`
    const saved = new Map([
      [oldManifest, JSON.stringify({ Status: "Success", TenantId: TENANT, Scope: { Excluded: request.scope.excluded } })],
      [oldPolicy, JSON.stringify({ id: "old" })],
    ])
    const original = new Map(saved)
    const signals: AbortSignal[] = []
    const { fetchImpl } = setup((url, init) => {
      if (url.hostname === "graph.microsoft.com") return
      if (init?.method === "PUT" && !url.search) {
        saved.set(url.pathname, init.body as string)
        return
      }
      if ((failure === "first listing" && init?.method === "GET" && url.searchParams.get("delimiter") === "/")
        || (failure === "metadata read" && init?.method === "GET" && url.pathname === oldManifest)
        || (failure === "delete" && init?.method === "DELETE")) {
        signals.push(init!.signal!)
        return new Promise(() => {})
      }
      if (init?.method === "GET" && url.search) {
        const entries = url.searchParams.get("delimiter") === "/"
          ? `<BlobPrefix><Name>${oldPrefix}</Name></BlobPrefix>`
          : [oldManifest, oldPolicy].map(path => `<Blob><Name>${path.slice("/intune-backups/".length)}</Name></Blob>`).join("")
        return new Response(`<EnumerationResults><Blobs>${entries}</Blobs></EnumerationResults>`)
      }
      if (init?.method === "GET") return new Response(saved.get(url.pathname), { headers: { "content-type": "application/json" } })
      if (init?.method === "DELETE") saved.delete(url.pathname)
    })
    const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30 })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(0)
    const manifest = `/intune-backups/${job.backupFolder}/metadata.json`
    await vi.advanceTimersByTimeAsync(273_000)
    const committed = saved.get(manifest)
    expect(JSON.parse(committed!)).toMatchObject({ Status: "Success", Failures: 0 })
    expect(job).toMatchObject({ status: "Completed", progress: 100, progressMessage: "Backup completed with 1 warning" })
    expect(job.endTime).toBeDefined()
    expect(job.exception).toBeUndefined()
    expect(job.log.filter(line => line.includes("Could not remove old backups:"))).toHaveLength(1)
    expect(job.log.join("\n")).toContain("Backup request timed out after 90 seconds")
    expect(signals).toHaveLength(3)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(saved.get(manifest)).toBe(committed)
    expect(saved.size).toBe(original.size + 1)
    for (const [path, body] of original) expect(saved.get(path)).toBe(body)
    const deletes = fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")
    expect(deletes).toHaveLength(failure === "delete" ? 3 : 0)
    expect(deletes.every(([input]) => new URL(String(input)).pathname === oldManifest)).toBe(true)
    const calls = fetchImpl.mock.calls.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fetchImpl.mock.calls).toHaveLength(calls)
  })

  it.each(["Graph", "blob"])("resets a network failure streak on %s success and keeps per-item warnings", async service => {
    requestTimers()
    const failures: number[] = []
    const started = Date.now()
    let metadata: Record<string, unknown> | undefined
    const { engine } = setup((url, init) => {
      if (url.hostname !== "graph.microsoft.com") {
        if (url.pathname.endsWith("/Reset.json")) return new Promise<Response>(resolve => {
          setTimeout(() => resolve(new Response(null, { status: 201 })), service === "Graph" ? 2000 : 4500)
        })
        if (url.pathname.endsWith("/metadata.json")) metadata = JSON.parse(init!.body as string) as Record<string, unknown>
        if (service === "blob" && url.pathname.includes("/Bad")) {
          failures.push(Date.now() - started)
          throw new TypeError("Connection reset")
        }
        return
      }
      if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: [
        { id: "bad-1", displayName: "Bad 1" }, { id: "reset", displayName: "Reset" }, { id: "bad-2", displayName: "Bad 2" },
      ] })
      if (url.pathname.endsWith("/reset")) return service === "blob" ? Response.json({ id: "reset" }) : new Promise<Response>(resolve => {
        setTimeout(() => resolve(Response.json({ id: "reset" })), 4500)
      })
      if (service === "blob") return Response.json({ id: url.pathname.split("/").at(-1) })
      failures.push(Date.now() - started)
      throw new TypeError("Connection reset")
    }, 2)
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(4499)
    expect(failures).toEqual([0, 1000, 3000, 3000, 4000])
    expect(job.status).toBe("Running")
    await vi.advanceTimersByTimeAsync(1501)
    // Six failures would open this two-worker circuit without the success after the first five.
    expect(failures).toHaveLength(6)
    await vi.advanceTimersByTimeAsync(500)
    expect(job.status).toBe("Completed")
    expect(job.progressMessage).toBe("Backup completed with 2 warnings")
    expect(metadata).toMatchObject({ Status: "CompletedWithWarnings", Failures: 2, ItemCounts: { TotalPolicies: 1 } })
  })

  it("does not reset Graph failures when a storage upload succeeds", async () => {
    requestTimers()
    const saved = new Map<string, string>()
    let startFailures: () => void = () => undefined
    const uploading = new Promise<void>(resolve => { startFailures = resolve })
    const { engine } = setup((url, init) => {
      if (url.hostname !== "graph.microsoft.com") {
        if (url.pathname.endsWith("/Saved.json")) {
          startFailures()
          return new Promise<Response>(resolve => {
            setTimeout(() => {
              saved.set(url.pathname, init!.body as string)
              resolve(new Response(null, { status: 201 }))
            }, 4500)
          })
        }
        return
      }
      if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: [
        { id: "bad-1", displayName: "Bad 1" }, { id: "saved", displayName: "Saved" }, { id: "bad-2", displayName: "Bad 2" },
      ] })
      if (url.pathname.endsWith("/saved")) return Response.json({ id: "saved" })
      return uploading.then(() => { throw new TypeError("Connection reset") })
    }, 2)
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(4500)
    expect(job.status).toBe("Running")
    expect(saved.size).toBe(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(job.status).toBe("Failed")
    expect(job.exception).toBe("Backup stopped: Microsoft Graph did not respond for 6 consecutive requests. Earlier policies in this run were saved; the backup is incomplete.")
    expect([...saved.keys()]).toEqual([`/intune-backups/${job.backupFolder}/DeviceConfigurations/Saved.json`])
  })

  it("stops hung blob uploads without marking earlier saved policies complete", async () => {
    requestTimers()
    const saved = new Map<string, string>()
    const signals: AbortSignal[] = []
    const { engine } = setup((url, init) => {
      if (url.hostname === "graph.microsoft.com") {
        if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: [
          { id: "saved", displayName: "Saved" },
          ...Array.from({ length: 8 }, (_, index) => ({ id: `hung-${index}`, displayName: `Hung ${index}` })),
        ] })
        return Response.json({ id: url.pathname.split("/").at(-1) })
      }
      if (url.search) return
      if (url.pathname.endsWith("/Saved.json")) {
        saved.set(url.pathname, init!.body as string)
        return
      }
      signals.push(init!.signal!)
      return new Promise(() => {})
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(273_000)
    expect(job.status).toBe("Failed")
    expect(job.exception).toContain("24 consecutive requests")
    expect(job.endTime).toBeDefined()
    expect(signals).toHaveLength(24)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(saved.size).toBe(1)
    expect([...saved.keys()]).toEqual([`/intune-backups/${job.backupFolder}/DeviceConfigurations/Saved.json`])
  })

  it.each([429, 503, 404])("does not count Graph HTTP %s responses toward the network circuit", async status => {
    requestTimers()
    let attempts = 0
    let metadata: Record<string, unknown> | undefined
    const { engine } = setup((url, init) => {
      if (url.hostname !== "graph.microsoft.com") {
        if (url.pathname.endsWith("/metadata.json")) metadata = JSON.parse(init!.body as string) as Record<string, unknown>
        return
      }
      if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: [
        ...Array.from({ length: 6 }, (_, index) => ({ id: `bad-${index}`, displayName: `Bad ${index}` })),
        { id: "good", displayName: "Good" },
      ] })
      if (url.pathname.endsWith("/good")) return Response.json({ id: "good" })
      attempts++
      return new Response(null, { status, headers: { "Retry-After": "1" } })
    }, 1)
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(attempts).toBe(status === 404 ? 6 : 18)
    expect(job.status).toBe("Completed")
    expect(job.exception).toBeUndefined()
    expect(metadata).toMatchObject({ Status: "CompletedWithWarnings", Failures: 6, ItemCounts: { TotalPolicies: 1 } })
  })

  it("retries a Graph response whose JSON body arrived incomplete", async () => {
    requestTimers()
    let reads = 0
    let metadata: Record<string, unknown> | undefined
    const { engine } = setup((url, init) => {
      if (url.hostname !== "graph.microsoft.com") {
        if (url.pathname.endsWith("/metadata.json")) metadata = JSON.parse(String(init?.body)) as Record<string, unknown>
        return
      }
      if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: [{ id: "flaky", displayName: "Flaky" }, { id: "good", displayName: "Good" }] })
      if (url.pathname.endsWith("/flaky") && ++reads === 1) {
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"flaky"'))
          controller.close()
        } }))
      }
      return Response.json({ id: url.pathname.split("/").at(-1) })
    }, 1)
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reads).toBe(2)
    expect(job.status).toBe("Completed")
    expect(job.progressMessage).toBe("Backup completed successfully")
    expect(metadata).toMatchObject({ Status: "Success", Failures: 0, ItemCounts: { TotalPolicies: 2 } })
  })

  it("retries persistent Graph JSON syntax errors a bounded number of times without counting them toward the network circuit", async () => {
    requestTimers()
    let attempts = 0
    const { engine } = setup(url => {
      if (url.hostname !== "graph.microsoft.com") return
      if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: [
        ...Array.from({ length: 6 }, (_, index) => ({ id: `bad-${index}`, displayName: `Bad ${index}` })),
        { id: "good", displayName: "Good" },
      ] })
      if (url.pathname.endsWith("/good")) return Response.json({ id: "good" })
      attempts++
      return new Response("Invalid JSON")
    }, 1)
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(attempts).toBe(18)
    expect(job.status).toBe("Completed")
    expect(job.exception).toBeUndefined()
    expect(job.progressMessage).toBe("Backup completed with 6 warnings")
  })

  it.each([429, 503, 404])("does not count completed blob HTTP %s responses toward the network circuit", async status => {
    requestTimers()
    let attempts = 0
    const { engine } = setup(url => {
      if (url.hostname === "graph.microsoft.com") {
        if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: [
          ...Array.from({ length: 6 }, (_, index) => ({ id: `bad-${index}`, displayName: `Bad ${index}` })),
          { id: "good", displayName: "Good" },
        ] })
        return Response.json({ id: url.pathname.split("/").at(-1) })
      }
      if (!url.pathname.includes("/Bad")) return
      attempts++
      return new Response("<Error><Message>Service refused the request</Message></Error>", { status, headers: { "Retry-After": "1" } })
    }, 1)
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(attempts).toBe(status === 404 ? 6 : 18)
    expect(job.status).toBe("Completed")
    expect(job.exception).toBeUndefined()
    expect(job.progressMessage).toBe("Backup completed with 6 warnings")
  })

  it("aborts a blob Retry-After wait when Graph opens the job circuit", async () => {
    requestTimers()
    let puts = 0
    const signals: AbortSignal[] = []
    let startFailures: () => void = () => undefined
    // Finish the successful Graph read before its peer failures can start the streak.
    const waitingUpload = new Promise<void>(resolve => { startFailures = resolve })
    const { engine, fetchImpl } = setup((url, init) => {
      if (url.hostname !== "graph.microsoft.com") {
        if (url.pathname.endsWith("/Waiting.json")) {
          puts++
          signals.push(init!.signal!)
          startFailures()
          return new Response(null, { status: 503, headers: { "Retry-After": "300" } })
        }
        return
      }
      if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: [
        { id: "waiting", displayName: "Waiting" }, { id: "bad-1", displayName: "Bad 1" }, { id: "bad-2", displayName: "Bad 2" },
      ] })
      if (url.pathname.endsWith("/waiting")) return Response.json({ id: "waiting" })
      return waitingUpload.then(() => { throw new TypeError("Connection reset") })
    }, 2)
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(6000)
    expect(job.status).toBe("Failed")
    expect(job.endTime).toBeDefined()
    expect(job.exception).toContain("6 consecutive requests")
    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(true)
    expect(puts).toBe(1)
    const calls = fetchImpl.mock.calls.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fetchImpl.mock.calls).toHaveLength(calls)
  })

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

  it("reports a failed encrypted read-back as an item failure without network retries", async () => {
    requestTimers()
    const message = "Backup authentication failed. Import the correct recovery key or recover an undamaged snapshot."
    let puts = 0
    let reads = 0
    let metadata: Record<string, unknown> | undefined
    const networkFetch: typeof fetch = async input => {
      const sent = input as Request
      const url = new URL(sent.url)
      if (url.hostname === "graph.microsoft.com") {
        return url.pathname.endsWith("/deviceConfigurations")
          ? Response.json({ value: [{ id: "bad", displayName: "Bad" }, { id: "good", displayName: "Good" }] })
          : Response.json({ id: url.pathname.split("/").at(-1) })
      }
      if (url.search) return new Response(null, { status: 201 })
      if (url.pathname.endsWith("/Bad.json")) {
        if (sent.method === "GET") {
          reads++
          return new Response(new Uint8Array(sealAzure(Buffer.from('{"id":"bad"}'), Buffer.alloc(32, 8), TENANT, url)))
        }
        if (++puts === 1) throw new TypeError("Response lost after upload")
        return new Response(null, { status: 409 })
      }
      if (url.pathname.endsWith("/metadata.json")) metadata = JSON.parse(openAzure(Buffer.from(await sent.arrayBuffer()), [master], TENANT, url).data.toString()) as Record<string, unknown>
      return new Response(null, { status: 201 })
    }
    const engine = new BackupEngine({ fetch: azureBridge(networkFetch), getToken: async () => "token", concurrency: 1 })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(job).toMatchObject({ status: "Completed", progress: 100, progressMessage: "Backup completed with 1 warning" })
    expect(job.endTime).toBeDefined()
    expect(job.exception).toBeUndefined()
    expect(puts).toBe(2)
    expect(reads).toBe(1)
    expect(job.log.some(line => line.endsWith(`Could not back up "Bad": ${message}`))).toBe(true)
    expect(job.log.join("\n")).not.toMatch(/did not respond|network stopped responding/)
    expect(metadata).toMatchObject({ Status: "CompletedWithWarnings", Failures: 1, ItemCounts: { TotalPolicies: 1 } })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(puts).toBe(2)
    expect(reads).toBe(1)
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

  it.each(["Graph", "storage"])("honours an HTTP-date Retry-After for %s", async service => {
    requestTimers()
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"))
    const attempts: number[] = []
    const { engine } = setup((url, init) => {
      if (service === "Graph" ? url.hostname !== "graph.microsoft.com" : init?.method !== "PUT" || !url.pathname.endsWith("/metadata.json")) return
      attempts.push(Date.now())
      if (attempts.length === 1) return new Response(null, { status: 503, headers: { "Retry-After": "Mon, 12 Oct 2026 12:02:00 GMT" } })
      return service === "Graph" ? Response.json({ value: [] }) : new Response(null, { status: 201 })
    })
    const job = engine.start(request)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(attempts).toHaveLength(1)
    expect(job.status).toBe("Running")
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts[1]! - attempts[0]!).toBe(120_000)
    expect(job.status).toBe("Completed")
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
    requestTimers()
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
    expect(vi.getTimerCount()).toBe(0)

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
