vi.mock("node:fs", { spy: true })
import * as fs from "node:fs"
import { fstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { it, expect, vi } from "vitest"
import { DirectoryRestoreStore } from "../src/main/storage/directory-restore-store"
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
