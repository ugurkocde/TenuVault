import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import * as fileSystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BackupEngine } from '../src/main/backup/engine'
import { readRetentionProgress } from '../src/main/backup/retention-progress'
import { handleLocalBlobRequest, localAccountFromUrl } from '../src/main/storage/blob-emulator'
import { LocalBlobStore, localBackupsExist } from '../src/main/storage/local-blob-store'
import { BACKUP_CONTAINER, BACKUP_OWNER_FILE, localStorageAccountName } from '../src/shared/constants'
import { INTUNE_TYPES } from '../src/shared/intune/registry'
import { memoryStore, withServerDate } from './helpers'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat), rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) }
})

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it.each(['external', 'concurrent'] as const)('keeps listing metadata consistent with the stored body after %s replacement between publication and stat', async writer => {
  const root = mkdtempSync(join(tmpdir(), 'tv-put-replacement-')); roots.push(root)
  const keys = [randomBytes(32)]
  const store = new LocalBlobStore(root, keys)
  const other = writer === 'external' ? new LocalBlobStore(root, keys) : store
  const account = 'account', container = 'intune-backups', name = 'backup-one/Policies/A.json'
  await store.createContainer(account, container)
  await store.list(account, container)
  const published = deferred(), replaced = deferred()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fileSystem.rename).mockImplementationOnce(async (...args) => {
    await actual.rename(...args)
    published.resolve()
    await replaced.promise
  })
  const firstBody = Buffer.from('{}')
  const first = store.put(account, container, name, firstBody, 'application/json', false, { writer: 'first' })
  await published.promise
  const replacementBody = Buffer.from('{"replacement":true,"items":[1,2,3]}')
  const metadata = { writer: 'replacement', revision: '2' }
  try {
    await other.put(account, container, name, replacementBody, 'application/json', false, metadata)
  } finally {
    replaced.resolve()
  }
  const written = await first
  const fresh = await new LocalBlobStore(root, keys).get(account, container, name)
  expect(fresh.data).toEqual(replacementBody)
  expect(fresh.blob).toMatchObject({ size: replacementBody.byteLength, metadata, etag: expect.any(String) })
  for (let read = 0; read < 2; read++) expect(await store.list(account, container)).toEqual([fresh.blob])
  expect(await store.get(account, container, name)).toEqual(fresh)
  expect(written).toMatchObject({ size: firstBody.byteLength, metadata: { writer: 'first' } })
  expect(written.etag).not.toBe(fresh.blob.etag)
})

it.each(['external', 'concurrent'] as const)('keeps the legacy physical filename for an immediate overwrite after %s replacement is detected', async writer => {
  const root = mkdtempSync(join(tmpdir(), 'tv-legacy-put-replacement-')); roots.push(root)
  const keys = [randomBytes(32)]
  const legacy = new LocalBlobStore(root, keys, 1)
  const store = new LocalBlobStore(root, keys)
  const other = writer === 'external' ? new LocalBlobStore(root, keys) : store
  const account = 'account', container = 'intune-backups', name = 'backup-one/Policies/A.json'
  await legacy.createContainer(account, container)
  const original = await legacy.put(account, container, name, Buffer.from('{"legacy":true}'), 'application/json')
  const dir = join(root, account, container)
  const legacyFile = readdirSync(dir)[0]!
  expect(readFileSync(join(dir, legacyFile)).subarray(0, 4).toString()).toBe('TVB1')
  await store.list(account, container)
  const readIndex = vi.spyOn(store as unknown as { readIndex: () => Promise<unknown> }, 'readIndex')
  const published = deferred(), replaced = deferred()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fileSystem.rename).mockImplementationOnce(async (...args) => {
    await actual.rename(...args)
    published.resolve()
    await replaced.promise
  })
  const first = store.put(account, container, name, Buffer.from('{}'), 'application/json', false, { writer: 'first' })
  await published.promise
  let replacement: Awaited<ReturnType<LocalBlobStore['put']>>
  try {
    replacement = await other.put(account, container, name, Buffer.from('{"replacement":true}'), 'application/json', false, { writer: 'replacement' })
  } finally {
    replaced.resolve()
  }
  const written = await first
  expect(written.etag).not.toBe(replacement.etag)
  // No listing or get may repair the cache before this next mutation.
  const finalBody = Buffer.from('{"final":true,"items":[1,2,3]}')
  const latest = await store.put(account, container, name, finalBody, 'application/json', false, { writer: 'final' })
  expect(readIndex).not.toHaveBeenCalled()
  expect(await store.list(account, container)).toEqual([latest])
  expect(readdirSync(dir)).toEqual([legacyFile])
  expect(readFileSync(join(dir, legacyFile)).subarray(0, 4).toString()).toBe('TVB2')
  expect(latest.created).toEqual(original.created)
  expect(await store.get(account, container, name)).toEqual({ blob: latest, data: finalBody })
})

it.each([
  { occupied: false, despiteDamage: false },
  { occupied: true, despiteDamage: false },
  { occupied: true, despiteDamage: true },
])("preserves a replacement during conditional deletion ($occupied, rollback $despiteDamage)", async ({ occupied, despiteDamage }) => {
  const root = mkdtempSync(join(tmpdir(), "tv-retire-replacement-")); roots.push(root)
  const store = new LocalBlobStore(root, [randomBytes(32)])
  const account = "account", container = "intune-backups", name = "backup-one/Policies/A.json"
  const dir = join(root, account, container)
  await store.createContainer(account, container)
  const first = await store.put(account, container, name, Buffer.from("{}"), "application/json")
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  const live = join(dir, readdirSync(dir).find(file => file.endsWith(".tvb"))!)
  const replacement = Buffer.from("replacement")
  vi.mocked(fileSystem.rename).mockImplementationOnce(async (from, to) => {
    await actual.rename(live, join(root, "original"))
    await actual.writeFile(live, replacement)
    await actual.rename(from, to)
    if (occupied) await actual.writeFile(live, "new occupant")
  })
  await expect(store.delete(account, container, name, { ifMatch: first.etag, despiteDamage })).rejects.toThrow(occupied ? "kept in" : name)
  if (occupied) {
    expect(readFileSync(live, "utf8")).toBe("new occupant")
    const held = join(dir, readdirSync(dir).find(file => file.startsWith(".retired-"))!)
    expect(readdirSync(held)).toContain(".quarantined")
    expect(readFileSync(join(held, readdirSync(held).find(file => file.endsWith(".tvb"))!))).toEqual(replacement)
  } else {
    expect(readFileSync(live)).toEqual(replacement)
    expect(readdirSync(dir).some(file => file.startsWith(".retired-"))).toBe(false)
  }
})

it.each([false, true])("recovers interrupted cleanup without overwriting a live file (occupied: %s)", async occupied => {
  const root = mkdtempSync(join(tmpdir(), "tv-retired-crash-")); roots.push(root)
  const keys = [randomBytes(32)]
  const account = "account", container = "intune-backups", name = "backup-one/Policies/A.json"
  const dir = join(root, account, container)
  const store = new LocalBlobStore(root, keys)
  const body = Buffer.from('{"saved":true}')
  await store.createContainer(account, container)
  await store.put(account, container, name, body, "application/json")
  const file = readdirSync(dir).find(file => file.endsWith(".tvb"))!
  const quarantine = mkdtempSync(join(dir, ".retired-"))
  const held = join(quarantine, file)
  renameSync(join(dir, file), held)
  const encrypted = readFileSync(held)
  expect(await localBackupsExist(root)).toBe(true)
  if (occupied) await store.put(account, container, name, Buffer.from('{"replacement":true}'), "application/json")
  const now = Date.now()
  vi.spyOn(Date, "now").mockReturnValue(now + 120_000)

  const restarted = new LocalBlobStore(root, keys)
  const damage = await restarted.damage(account, container)
  if (occupied) {
    expect(damage.files).toEqual([expect.objectContaining({
      file: `${basename(quarantine)}/${file}`, reason: expect.stringContaining("interrupted cleanup"),
    })])
    expect(readFileSync(held)).toEqual(encrypted)
    expect(readFileSync(join(dir, file))).not.toEqual(encrypted)
    await expect(restarted.delete(account, container, name)).rejects.toThrow("interrupted cleanup")
  } else {
    expect(damage.files).toEqual([])
    expect((await restarted.get(account, container, name)).data).toEqual(body)
    expect(readdirSync(dir)).toEqual([file])
  }
})

it("uses the quarantine stamp for the full grace period when rename leaves the blob ctime unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "tv-retired-stamp-")); roots.push(root)
  const keys = [randomBytes(32)]
  const account = "account", container = "intune-backups", name = "backup-one/Policies/A.json"
  const dir = join(root, account, container)
  const body = Buffer.from('{"saved":true}')
  const store = new LocalBlobStore(root, keys)
  await store.createContainer(account, container)
  await store.put(account, container, name, body, "application/json")
  const file = readdirSync(dir).find(file => file.endsWith(".tvb"))!
  const quarantine = mkdtempSync(join(dir, ".retired-"))
  const held = join(quarantine, file)
  renameSync(join(dir, file), held)
  const stamp = join(quarantine, ".quarantined")
  writeFileSync(stamp, "")
  const now = Date.now()
  utimesSync(stamp, now / 1000, now / 1000)
  utimesSync(quarantine, (now - 120_000) / 1000, (now - 120_000) / 1000)
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  vi.mocked(fileSystem.lstat).mockImplementation(async (...args) => {
    const info = await actual.lstat(...args)
    if (args[0] === held && typeof info?.ctimeMs === "number") info.ctimeMs = now - 120_000
    return info
  })
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 59_000)
  expect((await new LocalBlobStore(root, keys).damage(account, container)).files).toEqual([
    expect.objectContaining({ file: expect.stringContaining(file) }),
  ])
  expect(readdirSync(dir)).toEqual([basename(quarantine)])
  clock.mockReturnValue(now + 61_000)
  expect((await new LocalBlobStore(root, keys).get(account, container, name)).data).toEqual(body)
  expect(readdirSync(dir)).toEqual([file])
})

it.each(["rm", "lstat"] as const)("keeps the local deletion journal when the first DELETE fails in %s after moving metadata.json into quarantine, so remaining payloads stay resumable", async failStep => {
  const root = mkdtempSync(join(tmpdir(), "tv-retired-journal-")); roots.push(root)
  const keys = [randomBytes(32)]
  const tenant = "11111111-1111-1111-1111-111111111111"
  const account = localStorageAccountName(tenant)
  const store = new LocalBlobStore(root, keys)
  const dir = join(root, account, BACKUP_CONTAINER)
  await store.createContainer(account, BACKUP_CONTAINER)

  const oldPrefix = "backup-2026-08-01-020000/"
  const policy = { id: "old" }
  const manifest = {
    TenantId: tenant,
    Status: "Success",
    Failures: 0,
    Scope: { Included: ["DeviceConfigurations"] },
    Items: {
      "DeviceConfigurations/old": {
        file: "Old.json",
        sha256: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
      },
    },
    ItemCounts: { DeviceConfigurations: 1, TotalPolicies: 1 },
  }
  await store.put(account, BACKUP_CONTAINER, `${oldPrefix}DeviceConfigurations/Old.json`, Buffer.from(JSON.stringify(policy)), "application/json")
  await store.put(account, BACKUP_CONTAINER, `${oldPrefix}${BACKUP_OWNER_FILE}`, Buffer.from(JSON.stringify({ Source: "TenuVault Desktop", TenantId: tenant })), "application/json")
  await store.put(account, BACKUP_CONTAINER, `${oldPrefix}metadata.json`, Buffer.from(JSON.stringify(manifest)), "application/json")

  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  let injected = false
  if (failStep === "rm") {
    vi.mocked(fileSystem.rm).mockImplementation(async (...args) => {
      const target = String(args[0])
      if (!injected && target.includes(".retired-") && target.endsWith(".tvb")) {
        injected = true
        throw Object.assign(new Error("EACCES: locked"), { code: "EACCES" })
      }
      return actual.rm(...args)
    })
  } else {
    vi.mocked(fileSystem.lstat).mockImplementation((async (...args: Parameters<typeof actual.lstat>) => {
      const target = String(args[0])
      if (!injected && target.includes(".retired-") && target.endsWith(".tvb")) {
        injected = true
        throw Object.assign(new Error("EIO: read error"), { code: "EIO" })
      }
      return actual.lstat(...args)
    }) as typeof actual.lstat)
  }

  const progressKey = `${tenant}/${account}/false`
  const progress = memoryStore()
  let clock = new Date("2026-09-24T12:00:00Z")
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
    return withServerDate(Response.json({ value: [] }), clock)
  }) as typeof fetch
  const scope = { excluded: INTUNE_TYPES.filter(type => type.folder !== "DeviceConfigurations").map(type => type.folder) }
  const createEngine = () => new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30, retentionProgress: progress, now: () => clock })

  const firstEng = createEngine()
  const first = await firstEng.waitForJob(firstEng.start({ tenantId: tenant, clientId: "client", storageAccountName: account, scope }))
  expect(first.status).toBe("Completed")
  expect(injected).toBe(true)
  expect(readdirSync(dir).some(name => name.startsWith(".retired-"))).toBe(true)
  expect(readRetentionProgress(progress.get(progressKey)).deletions?.[oldPrefix]).toBeTruthy()

  // Simulate manual recovery removing the quarantined folder (leaving payloads + owner without manifest).
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".retired-")) rmSync(join(dir, name), { recursive: true, force: true })
  }
  vi.mocked(fileSystem.rm).mockImplementation(actual.rm)
  vi.mocked(fileSystem.lstat).mockImplementation(actual.lstat)

  clock = new Date("2026-09-24T12:00:05Z")
  const secondEng = createEngine()
  const second = await secondEng.waitForJob(secondEng.start({ tenantId: tenant, clientId: "client", storageAccountName: account, scope }))
  expect(second.status).toBe("Completed")
  expect(await store.list(account, BACKUP_CONTAINER, oldPrefix)).toEqual([])
  expect(readRetentionProgress(progress.get(progressKey)).deletions).toBeUndefined()
})
