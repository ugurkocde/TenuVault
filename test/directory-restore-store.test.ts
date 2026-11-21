vi.mock("node:fs", { spy: true })
import * as fs from "node:fs"
import { graphNotFound, unsetUserFields } from "./fixtures/directory-response"
import { fstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { afterEach, it, expect, vi } from "vitest"
import { executeDirectoryBatches } from "../src/main/restore/directory-9a-batches"
import { DirectoryPendingPublications } from "../src/main/restore/directory-pending-publications"
import { directoryObjectState } from "../src/main/restore/directory-object-state"
import { directory9aIO } from "../src/main/restore/directory-9a-io"
import { approveDirectory } from "../src/main/restore/directory-9a"
import { GuardedRunJournal, RestorePersistenceError, restoreFingerprint, type GuardedRun, type GuardedStep } from "../src/main/restore/guarded-run"
import { DirectoryRestoreStore } from "../src/main/storage/directory-restore-store"
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(fs.openSync).mockReset()
  vi.mocked(fs.fsyncSync).mockReset()
  vi.mocked(fs.writeFileSync).mockReset()
})
it("persists encrypted journal partitions across restarts without loading unrelated history", () => {
  const directory = mkdtempSync(join(tmpdir(), "tv-directory-store-")), key = randomBytes(32)
  const cipher = {
    encrypt: (text: string) => { const nonce = randomBytes(12), aes = createCipheriv("aes-256-gcm", key, nonce); const data = Buffer.concat([aes.update(text), aes.final()]); return Buffer.concat([nonce, aes.getAuthTag(), data]) },
    decrypt: (bytes: Buffer) => { const aes = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); aes.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([aes.update(bytes.subarray(28)), aes.final()]).toString() },
  }
  try {
    const store = new DirectoryRestoreStore(directory, cipher)
    for (let i = 0; i < 100; i++) store.set(`restore.directory.batch.${i}`, "Private user metadata " + i)
    const files = readdirSync(directory)
    expect(files).toHaveLength(100)
    for (const file of files) {
      expect(file).toMatch(/^[0-9a-f]{64}\.bin$/)
      expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600)
      expect(readFileSync(join(directory, file)).toString()).not.toContain("Private user")
    }
    const restarted = new DirectoryRestoreStore(directory, cipher)
    expect(restarted.get("restore.directory.batch.20")).toBe("Private user metadata 20")
    restarted.set("restore.directory.batch.20", "Changed")
    expect(store.get("restore.directory.batch.20")).toBe("Changed")
    restarted.delete("restore.directory.batch.20")
    expect(store.get("restore.directory.batch.20")).toBeNull()
    expect(() => store.set("../escape", "invalid")).toThrow("directory restore")
    const target = readdirSync(directory)[0]!
    writeFileSync(join(directory, target), "damaged")
    // Reading another partition does not enumerate or decrypt the damaged record.
    let refused = 0
    for (let i = 0; i < 100; i++) { try { store.get(`restore.directory.batch.${i}`) } catch { refused++ } }
    expect(refused).toBe(1)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it("starts and atomically saves on win32 without opening directory handles", async () => {
  const root = mkdtempSync(join(tmpdir(), "tv-directory-win32-"))
  const { openSync: open } = await vi.importActual<typeof import("node:fs")>("node:fs")
  vi.spyOn(process, "platform", "get").mockReturnValue("win32")
  const opened = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    if (args[1] === "r" && statSync(String(args[0])).isDirectory()) throw Object.assign(new Error("Windows directory access denied"), { code: "EPERM" })
    return open(...args)
  })
  const flush = vi.spyOn(fs, "fsyncSync").mockImplementation(handle => { expect(fstatSync(handle).isFile()).toBe(true) })
  const rename = vi.spyOn(fs, "renameSync")
  try {
    const store = new DirectoryRestoreStore(join(root, "nested", "history"), { encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
    store.set("restore.directory.test", "first"); store.set("restore.directory.test", "second")
    expect(store.get("restore.directory.test")).toBe("second")
    store.delete("restore.directory.test")
    expect(flush).toHaveBeenCalledTimes(2)
    expect(rename).toHaveBeenCalledTimes(2)
    expect(opened.mock.calls.filter(call => call[1] === "wx")).toHaveLength(2)
  } finally { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) }
})

it.each(["file", "directory", "directory and rollback"])("recovers a create without POST after EIO syncing the send marker %s", async failure => {
  const root = mkdtempSync(join(tmpdir(), "tv-directory-barrier-"))
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  const store = new DirectoryRestoreStore(root, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() })
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
  const actor = { tenantId: id(1), userId: id(2), clientId: id(3), applicationObjectId: id(4), servicePrincipalId: id(5), recoveryAccountIds: [] }
  const token = `h.${Buffer.from(JSON.stringify({ tid: actor.tenantId, oid: actor.userId, appid: actor.clientId, scp: "User.Create" })).toString("base64url")}.s`
  const desired = { displayName: "Saved", userPrincipalName: "saved@example.test", mailNickname: "saved", accountEnabled: false }
  const step: GuardedStep = { key: "create", folder: "Users", sourceId: id(10), operation: "create", directory: { action: "create" }, desired, properties: Object.keys(desired), preview: restoreFingerprint(null), requires: [] }
  const run: GuardedRun = { version: 1, tenant: actor.tenantId, id: id(20), actor, origin: "restore", entries: [{ step, state: "pending" }], mappings: [] }
  const posts = vi.fn()
  const io = directory9aIO(token, actor, async () => ({ principals: [], applications: [], complete: true }), async (input, init) => {
    if (init?.method === "POST") { posts(); return Response.json({ ...desired, id: id(30), userType: "Member" }, { status: 201 }) }
    if (new URL(String(input)).pathname === `/v1.0/users/${id(30)}`) return Response.json({ ...unsetUserFields, ...desired, id: id(30), userType: "Member" })
    if (new URL(String(input)).pathname === "/v1.0/users") return Response.json({ value: [] })
    return graphNotFound()
  }, async () => [])
  for (const kind of (await io.review(step)).approvals) approveDirectory(step, run, kind)
  const pending = new DirectoryPendingPublications().forTenant(run.tenant)
  io.persistConfirmed = (_step, save) => pending.retain(save)
  let sendMarker = false, failedMarker = false
  const write = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
    const record = JSON.parse(String(args[1]))
    if (failure === "directory and rollback" && failedMarker && record.key.includes("restore.guarded.")) throw new Error("Rollback storage unavailable")
    sendMarker = record.value.includes('"state":"uncertain"')
    return actual.writeFileSync(...args)
  })
  const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(handle => {
    if (sendMarker && fstatSync(handle).isDirectory() === (failure !== "file")) { failedMarker = true; throw Object.assign(new Error("Send marker sync failed"), { code: "EIO" }) }
    actual.fsyncSync(handle)
  })
  const source = { fingerprint: "source", page: async () => ({ entries: run.entries, next: null }) }
  const prefix = `restore.directory.${actor.tenantId}.${run.id}.batch.0.`
  const journal = new GuardedRunJournal({ get: key => store.get(prefix + key), set: (key, value) => store.set(prefix + key, value), delete: key => store.delete(prefix + key) })
  try {
    await expect(executeDirectoryBatches(store, run, source, io)).rejects.toBeInstanceOf(RestorePersistenceError)
    expect(posts).not.toHaveBeenCalled()
    expect(journal.load(run.tenant, run.id)!.entries[0]!).toMatchObject({ state: failure === "directory and rollback" ? "uncertain" : "captured", attempt: 1 })
    expect(readdirSync(root).some(file => file.endsWith(".tmp"))).toBe(false)
    sync.mockRestore(); write.mockRestore()
    pending.flush()
    expect(journal.load(run.tenant, run.id)!.entries[0]!).toMatchObject({ state: "captured", attempt: 1 })
    if (failure === "directory and rollback") {
      expect(await executeDirectoryBatches(store, run, source, io, undefined, 20, true)).toMatchObject({ status: "partial" })
      expect(journal.load(run.tenant, run.id)!.entries[0]!.state).toBe("captured")
      const objects = directoryObjectState(store, run.tenant, run.id)
      objects.release(true)
      expect(objects.discarded()).toBe(true)
      await expect(executeDirectoryBatches(store, run, source, io)).rejects.toThrow("discarded")
      expect(posts).not.toHaveBeenCalled()
      return
    }
    expect(await executeDirectoryBatches(store, run, source, io)).toMatchObject({ status: "complete" })
    expect(posts).toHaveBeenCalledTimes(1)
  } finally { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) }
})

it("throws when syncing a coordinator directory fails", () => {
  const root = mkdtempSync(join(tmpdir(), "tv-directory-coordinator-sync-"))
  const store = new DirectoryRestoreStore(root, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() })
  const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(handle => {
    if (fstatSync(handle).isDirectory()) throw Object.assign(new Error("Coordinator sync failed"), { code: "EIO" })
  })
  try { expect(() => store.set("restore.directory.coordinator.tenant", "state")).toThrow("Coordinator sync failed") }
  finally { sync.mockRestore(); rmSync(root, { recursive: true, force: true }) }
})
