import { mkdtempSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { BackupEngine } from "../src/main/backup/engine"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { localStorageAccountName } from "../src/shared/constants"

const TENANT_A = "11111111-1111-1111-1111-111111111111"
const TENANT_B = "33333333-3333-3333-3333-333333333333"
const TENANT_C = "44444444-4444-4444-4444-444444444444"
const CLIENT = "22222222-2222-2222-2222-222222222222"

/** An engine whose first tenant blocks on its Graph token until released. */
function setup() {
  const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-queue-")), [randomBytes(32)])
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
    if (url.hostname === "graph.microsoft.com") return Response.json({ value: [] })
    throw new Error(`unexpected ${url}`)
  }) as unknown as typeof fetch
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tokenTenants: string[] = []
  const getToken = vi.fn(async (tenantId: string) => {
    tokenTenants.push(tenantId)
    if (tenantId === TENANT_A) await gate
    return "token"
  })
  const engine = new BackupEngine({ fetch: fetchImpl, getToken })
  const start = (tenantId: string) =>
    engine.start({ tenantId, clientId: CLIENT, storageAccountName: localStorageAccountName(tenantId) })
  return { engine, release: () => release(), tokenTenants, start }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25))

describe("BackupEngine queue", () => {
  it("runs backups of different tenants one at a time, reporting the second as queued", async () => {
    const { engine, release, tokenTenants, start } = setup()
    const first = start(TENANT_A)
    // An unqueued backup still begins synchronously inside start(), as before the queue existed:
    // its run has already claimed a backup folder by the time start() returns.
    expect(first.backupFolder).toBeDefined()
    const second = start(TENANT_B)
    expect(second.backupFolder).toBeUndefined()
    await tick()

    expect(first.status).toBe("Running")
    expect(second.status).toBe("Queued")
    expect(second.progressMessage).toBe("Waiting for another backup to finish...")
    expect(tokenTenants).not.toContain(TENANT_B)

    release()
    await engine.waitForJob(first)
    const done = await engine.waitForJob(second)
    expect(done.status).toBe("Completed")
    expect(tokenTenants).toContain(TENANT_B)
    // The start time is stamped when the queued run actually starts, not when it was queued.
    expect(Date.parse(done.startTime)).toBeGreaterThanOrEqual(Date.parse(first.endTime!))
  })

  it("settles a backup cancelled while queued at once and never runs it", async () => {
    const { engine, release, tokenTenants, start } = setup()
    const first = start(TENANT_A)
    const second = start(TENANT_B)
    await tick()

    engine.cancel(second.id)
    await tick()
    // Settled without waiting for the running backup, so the tenant is free to start again.
    expect(second.status).toBe("Cancelled")
    expect(engine.liveRuns(TENANT_B)).toEqual([])
    const restart = start(TENANT_B)
    expect(restart.id).not.toBe(second.id)
    expect(restart.status).toBe("Queued")

    release()
    await engine.waitForJob(first)
    const done = await engine.waitForJob(second)
    expect(done.status).toBe("Cancelled")
    expect((await engine.waitForJob(restart)).status).toBe("Completed")
    expect(tokenTenants.filter((tenantId) => tenantId === TENANT_B).length).toBeGreaterThan(0)
  })

  it("keeps later tenants queued behind the running backup when a middle one is cancelled", async () => {
    const { engine, release, tokenTenants, start } = setup()
    const first = start(TENANT_A)
    const second = start(TENANT_B)
    const third = start(TENANT_C)
    await tick()

    engine.cancel(second.id)
    await tick()
    expect(second.status).toBe("Cancelled")
    expect(third.status).toBe("Queued")
    expect(tokenTenants).not.toContain(TENANT_C)

    release()
    await engine.waitForJob(first)
    expect((await engine.waitForJob(third)).status).toBe("Completed")
  })
})
