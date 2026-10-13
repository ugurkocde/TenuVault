import { existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { APP_STATE_START_OVER_BUTTON, APP_STATE_START_OVER_DETAIL, SecureStore, UnreadableStoreError, type Cipher } from "../src/main/storage/secure-store"

const xor = (key: number): Cipher => ({
  encrypt: (text) => Buffer.from(Buffer.from(text).map((b) => b ^ key)),
  decrypt: (data) => {
    const text = Buffer.from(data.map((b) => b ^ key)).toString()
    JSON.parse(text)
    return text
  },
})

describe("SecureStore", () => {
  it("warns that starting over deletes the backup key and explains recovery", () => {
    expect(APP_STATE_START_OVER_DETAIL).toContain("deletes the backup encryption key")
    expect(APP_STATE_START_OVER_DETAIL).toContain("Existing local and Azure backups become unreadable unless you exported their recovery key")
    expect(APP_STATE_START_OVER_DETAIL).toContain("choose Quit, restore access to the saved data")
    expect(APP_STATE_START_OVER_DETAIL).toContain("Settings > Storage and recovery > Save recovery key")
    expect(APP_STATE_START_OVER_DETAIL).toContain("Import a recovery key")
    expect(APP_STATE_START_OVER_BUTTON).toBe("Delete backup key and start over")
  })

  it("persists values encrypted", () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-store-"))
    const file = join(dir, "state.bin")
    new SecureStore(file, xor(7)).set("license.key", "TV1.abc")
    expect(readFileSync(file).toString()).not.toContain("TV1.abc")
    expect(new SecureStore(file, xor(7)).get("license.key")).toBe("TV1.abc")
  })

  it("never overwrites a file it cannot decrypt", () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-store-"))
    const file = join(dir, "state.bin")
    new SecureStore(file, xor(7)).set("license.key", "TV1.abc")
    const original = readFileSync(file)

    const locked = new SecureStore(file, xor(9))
    expect(() => locked.open()).toThrow(UnreadableStoreError)
    expect(() => locked.set("license.trialStartedAt", "now")).toThrow(UnreadableStoreError)
    expect(readFileSync(file)).toEqual(original)
  })

  it("does not follow a pre-planted symlink at the temp path", () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-store-"))
    const file = join(dir, "state.bin")
    const victim = join(dir, "victim.bin")
    writeFileSync(victim, "original")
    symlinkSync(victim, `${file}.tmp`)
    new SecureStore(file, xor(7)).set("license.key", "TV1.abc")
    expect(readFileSync(victim).toString()).toBe("original")
    expect(new SecureStore(file, xor(7)).get("license.key")).toBe("TV1.abc")
    expect(existsSync(`${file}.tmp`)).toBe(true)
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(["state.bin.tmp"])
  })

  it("moves an unreadable file aside when the user starts over", () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-store-"))
    const file = join(dir, "state.bin")
    writeFileSync(file, "garbage")
    const store = new SecureStore(file, xor(7))
    const backup = store.moveAside()
    store.set("a", "b")
    expect(readFileSync(backup).toString()).toBe("garbage")
    expect(readdirSync(dir).sort()).toEqual(["state.bin", backup.split(/[\\/]/).pop()].sort())
    expect(new SecureStore(file, xor(7)).get("a")).toBe("b")
  })
})
