import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine } from "../src/main/backup/engine"
import { readRetentionProgress, type RetentionProgressStore } from "../src/main/backup/retention-progress"
import { legacyAzureReader, legacyRecoveryFingerprint, registerStorageToken } from "../src/main/storage/azure-seal"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { BlobLeaseConflictError, BlobLeaseUnsupportedError, LocalBlobStore } from "../src/main/storage/local-blob-store"
import { BACKUP_CONTAINER, BACKUP_OWNER_FILE, localStorageAccountName } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"
import { withBackupServerTime } from "./helpers"

const TENANT = "11111111-1111-1111-1111-111111111111"
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222"
const MASTER = Buffer.alloc(32, 4)
const NOW = new Date("2026-10-12T12:00:00Z")
const OWNER = { Source: "TenuVault Desktop", TenantId: TENANT }
const OLD_ITEM = { id: "old" }
const SECOND_ITEM = { id: "second" }
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const ONE_ITEM_MANIFEST = {
  TenantId: TENANT,
  Status: "Success",
  Failures: 0,
  Scope: { Included: ["DeviceConfigurations"] },
  Items: {
    "DeviceConfigurations/old": { file: "Old.json", hash: snapshotHash(OLD_ITEM), sha256: sha256(OLD_ITEM) },
  },
  ItemCounts: { DeviceConfigurations: 1, TotalPolicies: 1 },
}
const TWO_ITEM_MANIFEST = {
  TenantId: TENANT,
  Status: "Success",
  Failures: 0,
  Scope: { Included: ["DeviceConfigurations"] },
  Items: {
    "DeviceConfigurations/old": { file: "Old.json", hash: snapshotHash(OLD_ITEM), sha256: sha256(OLD_ITEM) },
    "DeviceConfigurations/second": { file: "Second.json", hash: snapshotHash(SECOND_ITEM), sha256: sha256(SECOND_ITEM) },
  },
  ItemCounts: { DeviceConfigurations: 2, TotalPolicies: 2 },
}
const REQUEST = {
  tenantId: TENANT,
  clientId: "client",
  storageAccountName: "contoso",
  scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) },
}

function memoryStore(): RetentionProgressStore {
  const data = new Map<string, string>()
  return {
    get: key => data.get(key) ?? null,
    set: (key, value) => { data.set(key, value) },
    delete: key => { data.delete(key) },
  }
}

function setupAzure(options: {
  count?: number
  progress?: RetentionProgressStore
  override?: (url: URL, request: Request, init?: RequestInit) => Response | Promise<Response> | undefined
} = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  const saved = new Map<string, Buffer>()
  const keyring = [MASTER]
  const etag = (name: string) => `"${createHash("sha256").update(saved.get(name)!).digest("hex")}"`
  const withDate = (response: Response) => withBackupServerTime(response, new Date())
  const calls: Array<{ name: string; request: Request }> = []
  const wireFetch: typeof fetch = async (input, init) => {
    const sent = new Request(input, init)
    const url = new URL(sent.url)
    const name = decodeURIComponent(url.pathname.slice(`/${BACKUP_CONTAINER}/`.length))
    calls.push({ name, request: sent })
    const overridden = options.override?.(url, sent, init)
    if (overridden) return overridden
    if (url.hostname === "graph.microsoft.com") {
      return withDate(url.pathname.endsWith("/deviceConfigurations")
        ? Response.json({ value: Array.from({ length: options.count ?? 1 }, (_, index) => ({ id: `p${index}`, displayName: `Policy ${index}` })) })
        : Response.json({ id: url.pathname.split("/").at(-1) }))
    }
    if (url.searchParams.get("comp") === "list") {
      const prefix = url.searchParams.get("prefix") ?? ""
      const names = [...saved.keys()].filter(entry => entry.startsWith(prefix))
      const entries = url.searchParams.has("delimiter")
        ? [...new Set(names.map(entry => `${entry.split("/")[0]}/`))].map(entry => `<BlobPrefix><Name>${entry}</Name></BlobPrefix>`)
        : names.map(entry => `<Blob><Name>${entry}</Name><Properties><Etag>${etag(entry)}</Etag></Properties></Blob>`)
      return new Response(`<Blobs>${entries.join("")}</Blobs>`)
    }
    if (sent.method === "PUT") {
      if (!url.search) saved.set(name, Buffer.from(await sent.arrayBuffer()))
      return withDate(new Response(null, { status: 201 }))
    }
    if (sent.method === "DELETE") {
      if (saved.has(name) && sent.headers.get("if-match") !== etag(name)) return new Response(null, { status: 412 })
      saved.delete(name)
      return new Response(null, { status: 202 })
    }
    return new Response(sent.method === "HEAD" || !saved.has(name) ? null : new Uint8Array(saved.get(name)!), {
      status: saved.has(name) ? 200 : 404,
      headers: saved.has(name) ? { etag: etag(name) } : undefined,
    })
  }
  registerStorageToken("token", TENANT)
  const fetch = legacyAzureReader(wireFetch, () => keyring)
  const progress = options.progress ?? memoryStore()
  const createEngine = () => new BackupEngine({
    fetch,
    getToken: async () => { registerStorageToken("token", TENANT); return "token" },
    retentionDays: () => 30,
    retentionProgress: progress,
    recoveryKeyFingerprint: () => legacyRecoveryFingerprint(keyring),
  })
  const seed = (name: string, value: unknown) => {
    saved.set(name, Buffer.from(typeof value === "string" ? value : JSON.stringify(value)))
  }
  const seedExpired = (prefix: string, twoItems = false) => {
    seed(`${prefix}DeviceConfigurations/Old.json`, OLD_ITEM)
    if (twoItems) seed(`${prefix}DeviceConfigurations/Second.json`, SECOND_ITEM)
    seed(`${prefix}${BACKUP_OWNER_FILE}`, OWNER)
    seed(`${prefix}metadata.json`, twoItems ? TWO_ITEM_MANIFEST : ONE_ITEM_MANIFEST)
  }
  return { createEngine, engine: createEngine(), saved, calls, seed, seedExpired, progress }
}

async function runJob(engine: BackupEngine) {
  const job = engine.start(REQUEST)
  await engine.waitForJob(job)
  await vi.advanceTimersByTimeAsync(0)
  expect(job.status, job.log.join("\n")).toBe("Completed")
  return job
}

const tempRoots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("Item 1: retention lease renewal and expiry safety", () => {
  it("tracks each lease expiry from acquire time so slow acquisition renews early leases before they lapse", async () => {
    const expired = "backup-2026-08-01-020000/"
    const active = new Map<string, { id: string; expiresAt: number }>()
    const renewed: Array<{ name: string; at: number }> = []
    let expiredSeenDuringDelete = false
    let acquireCount = 0

    const ctx = setupAzure({
      count: 1,
      override: (url, req) => {
        const name = decodeURIComponent(url.pathname.slice(`/${BACKUP_CONTAINER}/`.length))
        if (req.method === "PUT" && url.searchParams.get("comp") === "lease") {
          const action = req.headers.get("x-ms-lease-action")
          if (action === "acquire") {
            const idx = ++acquireCount
            const delay = idx === 1 ? 0 : 25_000
            const durationMs = Number(req.headers.get("x-ms-lease-duration") ?? "60") * 1000
            const id = req.headers.get("x-ms-proposed-lease-id") || `lease-${idx}`
            // Server records lease start when the request arrives (before slow response returns).
            const acquiredAt = Date.now()
            return new Promise<Response>(resolve => setTimeout(() => {
              active.set(name, { id, expiresAt: acquiredAt + durationMs })
              resolve(new Response(null, { status: 201, headers: { "x-ms-lease-id": id } }))
            }, delay))
          }
          const held = active.get(name)
          const id = req.headers.get("x-ms-lease-id") ?? ""
          if (!held || held.id !== id || held.expiresAt <= Date.now()) {
            return new Response(null, { status: 412, headers: { "x-ms-error-code": "LeaseIdMismatchWithLeaseOperation" } })
          }
          if (action === "renew") {
            held.expiresAt = Date.now() + 60_000
            renewed.push({ name, at: Date.now() })
            return new Response(null, { status: 200, headers: { "x-ms-lease-id": id } })
          }
          if (action === "release") {
            active.delete(name)
            return new Response(null, { status: 200 })
          }
        }
        if (req.method === "DELETE" && name.startsWith(expired)) {
          return new Promise<Response>(resolve => setTimeout(() => {
            const nowMs = Date.now()
            for (const lease of active.values()) {
              if (lease.expiresAt <= nowMs) expiredSeenDuringDelete = true
            }
            ctx.saved.delete(name)
            resolve(new Response(null, { status: 202 }))
          }, 15_000))
        }
        return undefined
      },
    })

    ctx.seedExpired(expired)
    const startMs = Date.now()
    const done = runJob(ctx.engine)
    await vi.advanceTimersByTimeAsync(120_000)
    await done

    expect(expiredSeenDuringDelete).toBe(false)
    expect(renewed.some(entry => entry.at - startMs < 60_000)).toBe(true)
    expect(ctx.saved.has(`${expired}metadata.json`)).toBe(false)
    expect(active.size).toBe(0)
  })

  it("reschedules the renewal chain when the timer overlaps an in-flight ensureFresh renewal", async () => {
    const expired = "backup-2026-08-01-020000/"
    const active = new Map<string, { id: string; expiresAt: number }>()
    let renewCount = 0
    let deleteCount = 0
    let expiredSeenDuringDelete = false

    const ctx = setupAzure({
      count: 1,
      override: (url, req) => {
        const name = decodeURIComponent(url.pathname.slice(`/${BACKUP_CONTAINER}/`.length))
        if (req.method === "PUT" && url.searchParams.get("comp") === "lease") {
          const action = req.headers.get("x-ms-lease-action")
          if (action === "acquire") {
            const id = req.headers.get("x-ms-proposed-lease-id") || `lease-${active.size + 1}`
            active.set(name, { id, expiresAt: Date.now() + 60_000 })
            return new Response(null, { status: 201, headers: { "x-ms-lease-id": id } })
          }
          const held = active.get(name)
          const id = req.headers.get("x-ms-lease-id") ?? ""
          if (!held || held.id !== id || held.expiresAt <= Date.now()) {
            return new Response(null, { status: 412, headers: { "x-ms-error-code": "LeaseIdMismatchWithLeaseOperation" } })
          }
          if (action === "renew") {
            renewCount++
            const started = Date.now()
            // First renewal pass takes 5s so the scheduled timer fires while it is in flight.
            const delay = renewCount <= 3 ? 5_000 : 100
            return new Promise<Response>(resolve => setTimeout(() => {
              held.expiresAt = started + 60_000
              resolve(new Response(null, { status: 200, headers: { "x-ms-lease-id": id } }))
            }, delay))
          }
          if (action === "release") {
            active.delete(name)
            return new Response(null, { status: 200 })
          }
        }
        if (req.method === "DELETE" && name.startsWith(expired)) {
          deleteCount++
          if (deleteCount === 1) {
            // Advance 29.9s via timer, then nudge system clock +200ms so ensureFresh starts
            // renewal just 100ms before the scheduled background timer fires.
            return new Promise<Response>(resolve => setTimeout(() => {
              vi.setSystemTime(Date.now() + 200)
              ctx.saved.delete(name)
              resolve(new Response(null, { status: 202 }))
            }, 29_900))
          }
          if (deleteCount === 2) {
            // Long second delete (65s): leases survive only if the background timer chain rescheduled.
            return new Promise<Response>(resolve => setTimeout(() => {
              const nowMs = Date.now()
              for (const lease of active.values()) {
                if (lease.expiresAt <= nowMs) expiredSeenDuringDelete = true
              }
              ctx.saved.delete(name)
              resolve(new Response(null, { status: 202 }))
            }, 65_000))
          }
        }
        return undefined
      },
    })

    ctx.seedExpired(expired, true)
    const done = runJob(ctx.engine)
    await vi.advanceTimersByTimeAsync(150_000)
    await done

    expect(expiredSeenDuringDelete).toBe(false)
    expect(renewCount).toBeGreaterThanOrEqual(6)
    expect(ctx.saved.has(`${expired}metadata.json`)).toBe(false)
  })

  it("renews leases in expiry order with bounded parallelism capped at 8", async () => {
    const expired = "backup-2026-08-01-020000/"
    const active = new Map<string, { id: string; expiresAt: number }>()
    const acquireOrder: string[] = []
    const renewStartOrder: string[] = []
    let inFlightRenews = 0
    let maxInFlightRenews = 0
    let deleteCount = 0

    const ctx = setupAzure({
      count: 10,
      override: (url, req) => {
        const name = decodeURIComponent(url.pathname.slice(`/${BACKUP_CONTAINER}/`.length))
        if (req.method === "PUT" && url.searchParams.get("comp") === "lease") {
          const action = req.headers.get("x-ms-lease-action")
          if (action === "acquire") {
            const id = req.headers.get("x-ms-proposed-lease-id") || `lease-${active.size + 1}`
            const acquiredAt = Date.now()
            acquireOrder.push(name)
            // Stagger each acquire by 100ms so expiry order is strictly increasing.
            return new Promise<Response>(resolve => setTimeout(() => {
              active.set(name, { id, expiresAt: acquiredAt + 60_000 })
              resolve(new Response(null, { status: 201, headers: { "x-ms-lease-id": id } }))
            }, 100))
          }
          const held = active.get(name)
          const id = req.headers.get("x-ms-lease-id") ?? ""
          if (!held || held.id !== id) return new Response(null, { status: 412 })
          if (action === "renew") {
            renewStartOrder.push(name)
            inFlightRenews++
            maxInFlightRenews = Math.max(maxInFlightRenews, inFlightRenews)
            const started = Date.now()
            return new Promise<Response>(resolve => setTimeout(() => {
              inFlightRenews--
              held.expiresAt = started + 60_000
              resolve(new Response(null, { status: 200, headers: { "x-ms-lease-id": id } }))
            }, 500))
          }
          if (action === "release") {
            active.delete(name)
            return new Response(null, { status: 200 })
          }
        }
        if (req.method === "DELETE" && name.startsWith(expired)) {
          deleteCount++
          if (deleteCount === 1) {
            return new Promise<Response>(resolve => setTimeout(() => {
              ctx.saved.delete(name)
              resolve(new Response(null, { status: 202 }))
            }, 35_000))
          }
        }
        return undefined
      },
    })

    ctx.seedExpired(expired)
    const done = runJob(ctx.engine)
    await vi.advanceTimersByTimeAsync(60_000)
    await done

    expect(acquireOrder.length).toBe(12)
    expect(maxInFlightRenews).toBe(8)
    expect(renewStartOrder.slice(0, acquireOrder.length)).toEqual(acquireOrder)
  })

  it("stops the candidate, keeps remaining files, and warns when renewal fails", async () => {
    const expired = "backup-2026-08-01-020000/"

    // (a) Renewal fails during slow acquisition -> stops before first DELETE, leaves no journal.
    {
      const active = new Map<string, string>()
      const deleted: string[] = []
      let acquireCount = 0
      const ctx = setupAzure({
        count: 1,
        override: (url, req) => {
          const name = decodeURIComponent(url.pathname.slice(`/${BACKUP_CONTAINER}/`.length))
          if (req.method === "PUT" && url.searchParams.get("comp") === "lease") {
            const action = req.headers.get("x-ms-lease-action")
            if (action === "acquire") {
              const idx = ++acquireCount
              const id = req.headers.get("x-ms-proposed-lease-id") || `lease-${idx}`
              return new Promise<Response>(resolve => setTimeout(() => {
                active.set(name, id)
                resolve(new Response(null, { status: 201, headers: { "x-ms-lease-id": id } }))
              }, idx === 1 ? 0 : 35_000))
            }
            if (action === "renew") {
              return new Response(null, { status: 412, headers: { "x-ms-error-code": "LeaseIdMismatchWithLeaseOperation" } })
            }
            if (action === "release") {
              active.delete(name)
              return new Response(null, { status: 200 })
            }
          }
          if (req.method === "DELETE" && name.startsWith(expired)) deleted.push(name)
          return undefined
        },
      })
      ctx.seedExpired(expired)
      const done = runJob(ctx.engine)
      await vi.advanceTimersByTimeAsync(90_000)
      const job = await done
      expect(deleted).toHaveLength(0)
      expect(ctx.saved.has(`${expired}metadata.json`)).toBe(true)
      expect(job.log.join("\n")).toContain("replacement protection could not be renewed")
    }

    // (b) Renewal fails mid-delete -> stops before second DELETE, keeping remaining files.
    {
      const active = new Map<string, string>()
      const deleted: string[] = []
      let deleteCount = 0
      const ctx = setupAzure({
        count: 1,
        override: (url, req) => {
          const name = decodeURIComponent(url.pathname.slice(`/${BACKUP_CONTAINER}/`.length))
          if (req.method === "PUT" && url.searchParams.get("comp") === "lease") {
            const action = req.headers.get("x-ms-lease-action")
            if (action === "acquire") {
              const id = req.headers.get("x-ms-proposed-lease-id") || `lease-${active.size + 1}`
              active.set(name, id)
              return new Response(null, { status: 201, headers: { "x-ms-lease-id": id } })
            }
            if (action === "renew") {
              return new Response(null, { status: 412, headers: { "x-ms-error-code": "LeaseIdMismatchWithLeaseOperation" } })
            }
            if (action === "release") {
              active.delete(name)
              return new Response(null, { status: 200 })
            }
          }
          if (req.method === "DELETE" && name.startsWith(expired)) {
            deleteCount++
            if (deleteCount === 1) {
              return new Promise<Response>(resolve => setTimeout(() => {
                deleted.push(name)
                ctx.saved.delete(name)
                resolve(new Response(null, { status: 202 }))
              }, 35_000))
            }
            deleted.push(name)
          }
          return undefined
        },
      })
      ctx.seedExpired(expired, true)
      const done = runJob(ctx.engine)
      await vi.advanceTimersByTimeAsync(50_000)
      const job = await done
      expect(deleted).toHaveLength(1)
      expect(ctx.saved.has(`${expired}metadata.json`)).toBe(true)
      expect(job.log.join("\n")).toContain("replacement protection could not be renewed")
    }
  })

  it("stops before DELETE when a lease is within the 10s safety margin and cannot be confirmed renewed", async () => {
    const expired = "backup-2026-08-01-020000/"
    const active = new Map<string, string>()
    let deleteDispatched = 0
    let acquireIndex = 0

    const ctx = setupAzure({
      count: 1,
      override: (url, req) => {
        const name = decodeURIComponent(url.pathname.slice(`/${BACKUP_CONTAINER}/`.length))
        if (req.method === "PUT" && url.searchParams.get("comp") === "lease") {
          const action = req.headers.get("x-ms-lease-action")
          if (action === "acquire") {
            const idx = ++acquireIndex
            const id = req.headers.get("x-ms-proposed-lease-id") || `lease-${idx}`
            // Make acquire take 52s so lease starts with only 8s left (inside 10s safety margin).
            return new Promise<Response>(resolve => setTimeout(() => {
              active.set(name, id)
              resolve(new Response(null, { status: 201, headers: { "x-ms-lease-id": id } }))
            }, idx === 1 ? 52_000 : 0))
          }
          if (action === "renew") {
            // Even though server returns 200 OK, renewal took 52s so only 8s remain (< 10s safety margin).
            return new Promise<Response>(resolve => setTimeout(() => {
              resolve(new Response(null, { status: 200, headers: { "x-ms-lease-id": req.headers.get("x-ms-lease-id") ?? "" } }))
            }, 52_000))
          }
          if (action === "release") {
            active.delete(name)
            return new Response(null, { status: 200 })
          }
        }
        if (req.method === "DELETE" && name.startsWith(expired)) {
          deleteDispatched++
        }
        return undefined
      },
    })

    ctx.seedExpired(expired)
    const done = runJob(ctx.engine)
    await vi.advanceTimersByTimeAsync(180_000)
    const job = await done

    expect(deleteDispatched).toBe(0)
    expect(ctx.saved.has(`${expired}metadata.json`)).toBe(true)
    expect(ctx.saved.has(`${expired}DeviceConfigurations/Old.json`)).toBe(true)
    expect(job.log.join("\n")).toContain("replacement protection could not be renewed")
  })
})

describe("Item 2: bounded lease cleanup", () => {
  it("aborts in-flight renewals immediately on cleanup and enforces one 30s total deadline", async () => {
    const expired = "backup-2026-08-01-020000/"
    let renewAborted = false
    let releaseCalls = 0
    let deleteCount = 0

    const ctx = setupAzure({
      count: 1,
      override: (url, req) => {
        const name = decodeURIComponent(url.pathname.slice(`/${BACKUP_CONTAINER}/`.length))
        if (req.method === "PUT" && url.searchParams.get("comp") === "lease") {
          const action = req.headers.get("x-ms-lease-action")
          if (action === "acquire") {
            const id = req.headers.get("x-ms-proposed-lease-id") || "lease"
            return new Response(null, { status: 201, headers: { "x-ms-lease-id": id } })
          }
          if (action === "renew") {
            // Hang until aborted; never finishes on its own.
            return new Promise<Response>((_resolve, reject) => {
              req.signal.addEventListener("abort", () => {
                renewAborted = true
                reject(req.signal.reason ?? new Error("aborted"))
              }, { once: true })
            })
          }
          if (action === "release") {
            releaseCalls++
            // Hanging release that ignores AbortSignal.
            return new Promise<Response>(() => undefined)
          }
        }
        if (req.method === "DELETE" && name.startsWith(expired)) {
          deleteCount++
          if (deleteCount === 1) {
            // Finish at 31s so background renewal started at 30s is in flight when cleanup begins.
            return new Promise<Response>(resolve => setTimeout(() => {
              resolve(new Response(null, { status: 412 }))
            }, 31_000))
          }
        }
        return undefined
      },
    })

    ctx.seedExpired(expired)
    const startMs = Date.now()
    let finished = false
    const job = ctx.engine.start(REQUEST)
    const done = ctx.engine.waitForJob(job).then(() => { finished = true })
    // 31s for delete + 30s shared cleanup deadline = 61s total (nowhere near 3x90s + 3x15s = 315s).
    await vi.advanceTimersByTimeAsync(65_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(finished).toBe(true)
    await done
    expect(job.status, job.log.join("\n")).toBe("Completed")

    expect(renewAborted).toBe(true)
    expect(releaseCalls).toBeGreaterThan(0)
    expect(Date.now() - startMs).toBeLessThanOrEqual(65_000)
  })

  it("releases leases in parallel capped at 8 and skips leases already past expiry", async () => {
    const expired = "backup-2026-08-01-020000/"
    // Part A: 12 leases released in parallel capped at 8.
    {
      let inFlightReleases = 0
      let maxInFlightReleases = 0
      let releaseCount = 0
      const ctx = setupAzure({
        count: 10,
        override: (url, req) => {
          if (req.method === "PUT" && url.searchParams.get("comp") === "lease") {
            const action = req.headers.get("x-ms-lease-action")
            if (action === "acquire") {
              return new Response(null, { status: 201, headers: { "x-ms-lease-id": req.headers.get("x-ms-proposed-lease-id") || "lease" } })
            }
            if (action === "release") {
              releaseCount++
              inFlightReleases++
              maxInFlightReleases = Math.max(maxInFlightReleases, inFlightReleases)
              return new Promise<Response>(resolve => setTimeout(() => {
                inFlightReleases--
                resolve(new Response(null, { status: 200 }))
              }, 1_000))
            }
          }
          return undefined
        },
      })
      ctx.seedExpired(expired)
      const done = runJob(ctx.engine)
      await vi.advanceTimersByTimeAsync(5_000)
      await done
      expect(releaseCount).toBe(12)
      expect(maxInFlightReleases).toBe(8)
    }

    // Part B: Leases already past expiry are skipped during release.
    {
      let releaseCount = 0
      const ctx = setupAzure({
        count: 1,
        override: (url, req) => {
          const name = decodeURIComponent(url.pathname.slice(`/${BACKUP_CONTAINER}/`.length))
          if (req.method === "PUT" && url.searchParams.get("comp") === "lease") {
            const action = req.headers.get("x-ms-lease-action")
            if (action === "acquire") {
              return new Response(null, { status: 201, headers: { "x-ms-lease-id": req.headers.get("x-ms-proposed-lease-id") || "lease" } })
            }
            if (action === "renew") {
              return new Response(null, { status: 412, headers: { "x-ms-error-code": "LeaseIdMismatchWithLeaseOperation" } })
            }
            if (action === "release") {
              releaseCount++
              return new Response(null, { status: 200 })
            }
          }
          if (req.method === "DELETE" && name.startsWith(expired)) {
            // Finishes at 65s when all 60s leases have already expired.
            return new Promise<Response>(resolve => setTimeout(() => {
              resolve(new Response(null, { status: 412 }))
            }, 65_000))
          }
          return undefined
        },
      })
      ctx.seedExpired(expired)
      const done = runJob(ctx.engine)
      await vi.advanceTimersByTimeAsync(70_000)
      await done
      expect(releaseCount).toBe(0)
    }
  })
})

describe("Item 3: permanent lease or local lock unavailability warnings", () => {
  it("shows a clear Azure RBAC setup warning after 3 consecutive runs with the same 403 and resets once leases work", async () => {
    const progress = memoryStore()
    let leaseStatus: number | null = 403
    const ctx = setupAzure({
      count: 1,
      progress,
      override: (_url, req) => {
        if (req.method === "PUT" && new URL(req.url).searchParams.get("comp") === "lease" && req.headers.get("x-ms-lease-action") === "acquire") {
          if (leaseStatus === 403) {
            return new Response(null, { status: 403, headers: { "x-ms-error-code": "AuthorizationPermissionMismatch" } })
          }
          if (leaseStatus === 409) {
            return new Response(null, { status: 409, headers: { "x-ms-error-code": "LeaseAlreadyPresent" } })
          }
          return new Response(null, { status: 201, headers: { "x-ms-lease-id": req.headers.get("x-ms-proposed-lease-id") || "lease" } })
        }
        return undefined
      },
    })
    ctx.seedExpired("backup-2026-08-01-020000/")
    ctx.seedExpired("backup-2026-08-02-020000/")

    const run1 = await runJob(ctx.createEngine())
    expect(run1.log.join("\n")).not.toContain("Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write")

    await vi.advanceTimersByTimeAsync(1_000)
    const run2 = await runJob(ctx.createEngine())
    expect(run2.log.join("\n")).not.toContain("Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write")

    await vi.advanceTimersByTimeAsync(1_000)
    const run3 = await runJob(ctx.createEngine())
    const log3 = run3.log.join("\n")
    expect(log3).toContain("3 consecutive runs")
    expect(log3).toContain("Storage Blob Data Contributor")
    expect(log3).toContain("Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write")

    // Once leases work, expired backups are removed and the consecutive counter resets.
    leaseStatus = null
    await vi.advanceTimersByTimeAsync(1_000)
    await runJob(ctx.createEngine())
    expect(ctx.saved.has("backup-2026-08-01-020000/metadata.json")).toBe(false)
    expect(readRetentionProgress(progress.get(`${TENANT}/contoso`)).leaseFailures).toBeUndefined()
  })

  it("does not trigger the permanent 403 warning when runs alternate with a different error", async () => {
    const progress = memoryStore()
    let leaseStatus = 403
    const ctx = setupAzure({
      count: 1,
      progress,
      override: (_url, req) => {
        if (req.method === "PUT" && new URL(req.url).searchParams.get("comp") === "lease" && req.headers.get("x-ms-lease-action") === "acquire") {
          return new Response(null, {
            status: leaseStatus,
            headers: { "x-ms-error-code": leaseStatus === 403 ? "AuthorizationPermissionMismatch" : "LeaseAlreadyPresent" },
          })
        }
        return undefined
      },
    })
    ctx.seedExpired("backup-2026-08-01-020000/")

    await runJob(ctx.createEngine())
    expect(readRetentionProgress(progress.get(`${TENANT}/contoso`)).leaseFailures).toEqual({ key: "azure:403:AuthorizationPermissionMismatch", count: 1 })
    leaseStatus = 409
    await vi.advanceTimersByTimeAsync(1_000)
    await runJob(ctx.createEngine())
    expect(readRetentionProgress(progress.get(`${TENANT}/contoso`)).leaseFailures).toBeUndefined()
    leaseStatus = 403
    await vi.advanceTimersByTimeAsync(1_000)
    const run3 = await runJob(ctx.createEngine())
    expect(run3.log.join("\n")).not.toContain("Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write")
    expect(readRetentionProgress(progress.get(`${TENANT}/contoso`)).leaseFailures).toEqual({ key: "azure:403:AuthorizationPermissionMismatch", count: 1 })
  })

  it.each([
    ["an unsupported folder", true],
    ["a lock held by another instance", false],
  ])("warns about the local folder after 3 consecutive runs only for %s", async (_name, unsupported) => {
    const root = mkdtempSync(join(tmpdir(), "tv-local-lock-perm-")); tempRoots.push(root)
    const account = localStorageAccountName(TENANT)
    const store = new LocalBlobStore(root, [MASTER])
    const progress = memoryStore()
    await store.createContainer(account, BACKUP_CONTAINER)
    const oldPrefix = "backup-2026-08-01-020000/"
    await store.put(account, BACKUP_CONTAINER, `${oldPrefix}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(OLD_ITEM)), "application/json")
    await store.put(account, BACKUP_CONTAINER, `${oldPrefix}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify(OWNER)), "application/json")
    await store.put(account, BACKUP_CONTAINER, `${oldPrefix}metadata.json`, Buffer.from(JSON.stringify(ONE_ITEM_MANIFEST)), "application/json")

    let failLock = true
    const originalAcquire = store.acquireRetentionLock.bind(store)
    vi.spyOn(store, "acquireRetentionLock").mockImplementation(async (...args) => {
      if (failLock) {
        throw unsupported
          ? new BlobLeaseUnsupportedError("The backup folder does not support the local retention lock (EOPNOTSUPP).")
          : new BlobLeaseConflictError("Another TenuVault instance is currently running retention on this backup folder.")
      }
      return originalAcquire(...args)
    })

    let clock = new Date(NOW.getTime())
    const fetchImpl: typeof fetch = async (input, init) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, req)
      return withBackupServerTime(Response.json({ value: [] }), clock)
    }
    const runLocal = async () => {
      const engine = new BackupEngine({
        fetch: fetchImpl,
        getToken: async () => "token",
        retentionDays: () => 30,
        retentionProgress: progress,
        now: () => clock,
      })
      const job = engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: account, scope: REQUEST.scope })
      await engine.waitForJob(job)
      expect(job.status).toBe("Completed")
      clock = new Date(clock.getTime() + 2_000)
      return job
    }

    const run1 = await runLocal()
    expect(run1.log.join("\n")).not.toContain("3 consecutive runs")
    const run2 = await runLocal()
    expect(run2.log.join("\n")).not.toContain("3 consecutive runs")
    const run3 = await runLocal()
    const log3 = run3.log.join("\n")
    if (unsupported) {
      expect(log3).toContain("3 consecutive runs")
      expect(log3).toContain("does not support the local retention lock")
    } else {
      expect(log3).not.toContain("does not support the local retention lock")
    }

    failLock = false
    await runLocal()
    expect(await store.list(account, BACKUP_CONTAINER, oldPrefix)).toEqual([])
    expect(readRetentionProgress(progress.get(`${TENANT}/${account}`)).leaseFailures).toBeUndefined()
  })
})

describe("Item 4: stale lock mtime check and container-scoped locks", () => {
  it("reclaims a stale lock using whichever of wall clock expiresAt or mtime age is older", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-lock-stale-")); tempRoots.push(root)
    const account = localStorageAccountName(TENANT)
    const storeA = new LocalBlobStore(root, [MASTER])
    const storeB = new LocalBlobStore(root, [MASTER])
    await storeA.createContainer(account, BACKUP_CONTAINER)
    const lockPath = join(root, account, BACKUP_CONTAINER, ".tenuvault-retention.lock")

    // 1. Holder clock far in the future, but file mtime is older than durationMs -> reclaimed via mtime.
    const nowMs = Date.now()
    writeFileSync(lockPath, JSON.stringify({ id: "skewed-ahead", pid: 99999, durationMs: 60_000, expiresAt: nowMs + 3_600_000 }))
    const staleSec = (nowMs - 65_000) / 1000
    utimesSync(lockPath, staleSec, staleSec)
    const reclaimedByMtime = await storeB.acquireRetentionLock(account, BACKUP_CONTAINER, 60_000)
    expect(JSON.parse(readFileSync(lockPath, "utf8")).id).toBe(reclaimedByMtime)

    // 2. Fresh lock (both expiresAt and mtime are recent) -> rejected with conflict.
    await expect(storeA.acquireRetentionLock(account, BACKUP_CONTAINER, 60_000)).rejects.toBeInstanceOf(BlobLeaseConflictError)
    await storeB.releaseRetentionLock(account, BACKUP_CONTAINER, reclaimedByMtime)

    // 3. Holder clock behind (expiresAt in the past), but file mtime is fresh -> reclaimed via expiresAt.
    writeFileSync(lockPath, JSON.stringify({ id: "skewed-behind", pid: 99999, durationMs: 60_000, expiresAt: nowMs - 5_000 }))
    const reclaimedByWall = await storeA.acquireRetentionLock(account, BACKUP_CONTAINER, 60_000)
    expect(JSON.parse(readFileSync(lockPath, "utf8")).id).toBe(reclaimedByWall)
    await storeA.releaseRetentionLock(account, BACKUP_CONTAINER, reclaimedByWall)
  })

  it("scopes retention locks per container directory rather than the whole root", async () => {
    const root = mkdtempSync(join(tmpdir(), "tv-lock-scope-")); tempRoots.push(root)
    const accountA = localStorageAccountName(TENANT)
    const accountB = localStorageAccountName(OTHER_TENANT)
    const storeA = new LocalBlobStore(root, [MASTER])
    const storeB = new LocalBlobStore(root, [MASTER])
    await storeA.createContainer(accountA, BACKUP_CONTAINER)
    await storeA.createContainer(accountA, "other-container")
    await storeB.createContainer(accountB, BACKUP_CONTAINER)

    const lockA = await storeA.acquireRetentionLock(accountA, BACKUP_CONTAINER, 60_000)
    expect(existsSync(join(root, ".tenuvault-retention.lock"))).toBe(false)
    expect(existsSync(join(root, accountA, BACKUP_CONTAINER, ".tenuvault-retention.lock"))).toBe(true)

    // Same root, different tenant account and different container are not blocked.
    const lockB = await storeB.acquireRetentionLock(accountB, BACKUP_CONTAINER, 60_000)
    const lockOtherContainer = await storeB.acquireRetentionLock(accountA, "other-container", 60_000)
    // Same account + same container is still blocked.
    await expect(storeB.acquireRetentionLock(accountA, BACKUP_CONTAINER, 60_000)).rejects.toBeInstanceOf(BlobLeaseConflictError)

    await storeA.releaseRetentionLock(accountA, BACKUP_CONTAINER, lockA)
    await storeB.releaseRetentionLock(accountB, BACKUP_CONTAINER, lockB)
    await storeB.releaseRetentionLock(accountA, "other-container", lockOtherContainer)
  })
})
