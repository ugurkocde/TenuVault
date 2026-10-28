import { mkdtempSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { BackupEngine, type BackupJob, type BackupRequest } from "../src/main/backup/engine"
import { runUnattended } from "../src/main/backup/scheduler"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { localStorageAccountName } from "../src/shared/constants"

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "22222222-2222-2222-2222-222222222222"

/** An engine whose backups wait on their Graph token until released. */
function setup() {
  const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-join-")), [randomBytes(32)])
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
    if (url.hostname === "graph.microsoft.com") return Response.json({ value: [] })
    throw new Error(`unexpected ${url}`)
  }) as unknown as typeof fetch
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const getToken = vi.fn(async () => {
    await gate
    return "token"
  })
  const engine = new BackupEngine({ fetch: fetchImpl, getToken })
  const request = (trigger: BackupRequest["trigger"]): BackupRequest => ({ tenantId: TENANT, clientId: CLIENT, storageAccountName: localStorageAccountName(TENANT), trigger })
  return { engine, request, release: () => release() }
}

describe("runUnattended", () => {
  it("runs its own backup when the manual backup it joined is cancelled", async () => {
    const { engine, request, release } = setup()
    const manual = engine.start(request("manual"))
    const waited: BackupJob[] = []
    const scheduled = runUnattended(engine, request("scheduled"), (job) => {
      waited.push(job)
      return engine.waitForJob(job)
    })
    expect(waited).toEqual([manual])
    engine.cancel(manual.id)
    await engine.waitForJob(manual)
    release()
    const job = await scheduled

    expect(manual.status).toBe("Cancelled")
    expect(job).not.toBe(manual)
    expect(job.status).toBe("Completed")
    expect(waited).toEqual([manual, job])
  })

  it("keeps the cancellation of a backup it started itself", async () => {
    const { engine, request } = setup()
    const wait = vi.fn((job: BackupJob) => {
      engine.cancel(job.id)
      return engine.waitForJob(job)
    })
    const job = await runUnattended(engine, request("scheduled"), wait)
    expect(job.status).toBe("Cancelled")
    expect(wait).toHaveBeenCalledTimes(1)
  })

  it("adopts the outcome of a joined backup that was not cancelled", async () => {
    const { engine, request, release } = setup()
    const manual = engine.start(request("manual"))
    const scheduled = runUnattended(engine, request("scheduled"), (started) => engine.waitForJob(started))
    release()
    const job = await scheduled
    expect(job).toBe(manual)
    expect(job.status).toBe("Completed")
  })
})
