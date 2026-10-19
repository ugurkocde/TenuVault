import { describe, expect, it } from "vitest"
import { BackupEngine } from "../src/main/backup/engine"
import { localRoutesRunning, withRouteTenant } from "../src/main/storage/blob-emulator"
import { localStorageAccountName } from "../src/shared/constants"

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "22222222-2222-2222-2222-222222222222"

/** A Graph that answers nothing until the request is aborted, so a backup stays running. */
function heldEngine() {
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))
    return new Response(null, { status: 503 })
  }) as typeof fetch
  return new BackupEngine({ fetch: fetchImpl, getToken: async () => "token" })
}

describe("local backup folder in use", () => {
  it("reports a backup to this device until it ends, and ignores backups to Azure", async () => {
    const engine = heldEngine()
    expect(engine.hasLocalWork()).toBe(false)
    const azure = engine.start({ tenantId: "33333333-3333-3333-3333-333333333333", clientId: CLIENT, storageAccountName: "contoso" })
    expect(engine.hasLocalWork()).toBe(false)
    const local = engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: localStorageAccountName(TENANT) })
    // Queued behind the Azure backup, it already holds the folder.
    expect(engine.hasLocalWork()).toBe(true)
    engine.cancel(azure.id)
    await engine.waitForJob(azure)
    expect(engine.hasLocalWork()).toBe(true)
    engine.cancel(local.id)
    await engine.waitForJob(local)
    expect(engine.hasLocalWork()).toBe(false)
  })

  it("counts a route that names local storage while it runs", async () => {
    let finish: () => void = () => undefined
    const route = withRouteTenant(TENANT, () => new Promise<void>((resolve) => { finish = resolve }), localStorageAccountName(TENANT))
    expect(localRoutesRunning()).toBe(true)
    finish()
    await route
    expect(localRoutesRunning()).toBe(false)

    // A route for Azure storage, a synchronous route and a failing route leave nothing counted.
    await withRouteTenant(TENANT, async () => expect(localRoutesRunning()).toBe(false), "contoso")
    expect(withRouteTenant(TENANT, () => 1, localStorageAccountName(TENANT))).toBe(1)
    expect(() => withRouteTenant(TENANT, () => { throw new Error("boom") }, localStorageAccountName(TENANT))).toThrow("boom")
    await expect(withRouteTenant(TENANT, async () => { throw new Error("late") }, localStorageAccountName(TENANT))).rejects.toThrow("late")
    expect(localRoutesRunning()).toBe(false)
  })
})
