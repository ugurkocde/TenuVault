import { mkdtempSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { BackupEngine, type BackupRequest, type RunTokens } from "../src/main/backup/engine"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { localStorageAccountName } from "../src/shared/constants"
import { BackupReaderError } from "../src/main/auth/backup-reader"
import { BackupScheduler, scheduledResult } from "../src/main/backup/scheduler"
import { memoryStore } from "./helpers"

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "22222222-2222-2222-2222-222222222222"
const ONE_TYPE = { excluded: INTUNE_TYPES.filter((type) => type.folder !== "DeviceConfigurations").map((type) => type.folder) }

/** An engine on local storage whose Graph reads wait until released, with a Backup Reader for the tenant. */
function setup(options: { reader?: boolean; storageAccountName?: string; retentionDays?: number } = {}) {
  const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-auth-mode-")), [randomBytes(32)])
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const graphAuth: string[] = []
  const blobMethods: string[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
    if (url.hostname === "graph.microsoft.com") {
      graphAuth.push(request.headers.get("authorization") ?? "")
      await gate
      return Response.json({ value: [] })
    }
    if (url.hostname.endsWith(".blob.core.windows.net")) {
      blobMethods.push(`${request.method} ${url.search}`)
      return new Response(null, { status: 201 })
    }
    throw new Error(`unexpected ${url}`)
  }) as unknown as typeof fetch
  const getToken = vi.fn(async (_tenantId: string, _clientId: string, scope: string) => `delegated ${scope}`)
  const reader: RunTokens = {
    mode: "app-only",
    graph: vi.fn(async () => "reader graph"),
    storage: vi.fn(async () => "reader storage"),
  }
  const unattendedTokens = vi.fn((_request: BackupRequest) => (options.reader === false ? null : reader))
  const engine = new BackupEngine({
    fetch: fetchImpl,
    getToken,
    unattendedTokens,
    retentionDays: () => options.retentionDays ?? 0,
  })
  const start = (trigger: BackupRequest["trigger"]) =>
    engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: options.storageAccountName ?? localStorageAccountName(TENANT), scope: ONE_TYPE, trigger })
  return { engine, start, release: () => release(), getToken, reader, unattendedTokens, graphAuth, blobMethods }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25))

describe("backup auth mode", () => {
  it("reads a scheduled backup with the tenant's Backup Reader and never asks for the admin's tokens", async () => {
    const { engine, start, release, getToken, reader, graphAuth } = setup()
    const job = start("scheduled")
    release()
    const done = await engine.waitForJob(job)

    expect(done.status).toBe("Completed")
    expect(done.authMode).toBe("app-only")
    expect(reader.graph).toHaveBeenCalled()
    expect(getToken).not.toHaveBeenCalled()
    expect(graphAuth.every((header) => header === "Bearer reader graph")).toBe(true)
    expect(done.log.join("\n")).toContain("Reading as the tenant's Backup Reader (app-only, read-only).")
  })

  it.each(["manual", "tray", undefined] as const)("never asks for Backup Reader tokens for a %s backup", async (trigger) => {
    const { engine, start, release, getToken, unattendedTokens, graphAuth } = setup()
    const job = start(trigger)
    release()
    const done = await engine.waitForJob(job)

    expect(done.authMode).toBe("delegated")
    expect(unattendedTokens).not.toHaveBeenCalled()
    expect(getToken).toHaveBeenCalledWith(TENANT, CLIENT, "https://graph.microsoft.com/.default")
    expect(graphAuth.every((header) => header === "Bearer delegated https://graph.microsoft.com/.default")).toBe(true)
  })

  it("uses the admin's sign-in for a scheduled backup of a tenant without a Backup Reader", async () => {
    const { engine, start, release, getToken } = setup({ reader: false })
    const job = start("scheduled")
    release()
    const done = await engine.waitForJob(job)

    expect(done.authMode).toBe("delegated")
    expect(getToken).toHaveBeenCalled()
  })

  it("does not let a manual backup join a running Backup Reader backup", async () => {
    const { engine, start, release } = setup()
    const scheduled = start("scheduled")
    await tick()
    const manual = start("manual")

    expect(manual.id).not.toBe(scheduled.id)
    expect(manual.status).toBe("Failed")
    expect(manual.exception).toMatch(/different backup is already running/)
    release()
    await engine.waitForJob(scheduled)
  })

  it("does not let a scheduled Backup Reader backup join a running manual backup", async () => {
    const { engine, start, release } = setup()
    const manual = start("manual")
    await tick()
    const scheduled = start("scheduled")

    expect(scheduled.id).not.toBe(manual.id)
    expect(scheduled.status).toBe("Failed")
    release()
    await engine.waitForJob(manual)
  })

  it("still joins a running backup with the same auth mode", async () => {
    const { engine, start, release } = setup()
    const first = start("scheduled")
    await tick()
    const second = start("scheduled")

    expect(second.id).toBe(first.id)
    release()
    await engine.waitForJob(first)
  })

  it("leaves Azure Storage retention to the next admin backup in a Backup Reader backup", async () => {
    const { engine, start, release, blobMethods, reader } = setup({ storageAccountName: "contoso", retentionDays: 30 })
    const job = start("scheduled")
    release()
    const done = await engine.waitForJob(job)

    expect(done.status).toBe("Completed")
    expect(reader.storage).toHaveBeenCalled()
    expect(blobMethods.some((call) => call.startsWith("DELETE"))).toBe(false)
    // Retention lists the container before deleting; the Backup Reader never gets that far.
    expect(blobMethods.some((call) => call.includes("comp=list"))).toBe(false)
    expect(done.log.join("\n")).toContain("The next backup made with an admin's sign-in removes expired ones.")
    // The Backup Reader cannot create containers, so it does not try.
    expect(blobMethods.some((call) => call.includes("restype=container"))).toBe(false)
  })

  it("still applies retention in Azure Storage for a backup with the admin's sign-in", async () => {
    const { engine, start, release, blobMethods } = setup({ storageAccountName: "contoso", retentionDays: 30 })
    const job = start("manual")
    release()
    await engine.waitForJob(job)

    expect(blobMethods.some((call) => call.includes("comp=list"))).toBe(true)
  })
})

describe("Backup Reader credential failures", () => {
  const reader = (failure: Error): RunTokens => ({ mode: "app-only", graph: async () => { throw failure }, storage: async () => "" })
  const run = async (failure: Error) => {
    const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-reader-fail-")), [randomBytes(32)])
    const engine = new BackupEngine({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (localAccountFromUrl(new URL(request.url))) return handleLocalBlobRequest(store, request)
        return Response.json({ value: [] })
      }) as typeof fetch,
      getToken: async () => "admin",
      unattendedTokens: () => reader(failure),
    })
    return engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: localStorageAccountName(TENANT), scope: ONE_TYPE, trigger: "scheduled" }))
  }

  it("marks a backup the Backup Reader was refused for as a credential failure that is not retried", async () => {
    const job = await run(new BackupReaderError("Microsoft refused the Backup Reader (AADSTS700027). Upload the certificate."))
    expect(job.status).toBe("Failed")
    expect(job.credentialError).toBe(true)
    expect(job.exception).toContain("AADSTS700027")
    expect(scheduledResult(job)).toEqual({ status: "Failed", message: job.exception, credential: true })
  })

  it("does not call a network failure while getting a Backup Reader token a credential failure", async () => {
    const job = await run(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND login.microsoftonline.com"), { code: "ENOTFOUND" }) }))
    expect(job.status).toBe("Failed")
    expect(job.credentialError).toBeUndefined()
    expect(scheduledResult(job).credential).toBeUndefined()
  })

  it("stops retrying the slot after a credential failure and tries again at the next slot", async () => {
    let now = new Date(2026, 9, 25, 12)
    const runs = vi.fn(async () => ({ status: "Failed" as const, message: "Microsoft refused the Backup Reader (AADSTS700027).", credential: true }))
    const scheduler = new BackupScheduler(memoryStore(), runs, () => undefined, () => now)
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", weekday: 0, time: "02:00" })
    now = new Date(2026, 9, 26, 2, 1)
    await scheduler.tick()
    expect(runs).toHaveBeenCalledTimes(1)
    // No retry 15 minutes later: retrying cannot fix a refused certificate.
    now = new Date(now.getTime() + 20 * 60_000)
    await scheduler.tick()
    expect(runs).toHaveBeenCalledTimes(1)
    now = new Date(now.getTime() + 24 * 60 * 60_000)
    await scheduler.tick()
    expect(runs).toHaveBeenCalledTimes(2)
  })
})
