import { describe, expect, it, vi } from "vitest"
import { BackupKeys } from "../src/main/backup/keys"
import { memoryStore } from "./helpers"

describe("stored backup keys", () => {
  const key = Buffer.alloc(32, 7).toString("base64")
  const recovery = `TVK1.${Buffer.alloc(32, 9).toString("base64url")}`

  it.each([
    "not json", "", "null", "{}", '"key"', "[]", '[null]', '[7]', '["short"]',
    JSON.stringify([key, "bad"]), JSON.stringify([key + "!"]),
    JSON.stringify([key.slice(0, -1)]), JSON.stringify([Buffer.alloc(31).toString("base64")]),
  ])("refuses malformed stored value %s without overwriting it", (value) => {
    const store = memoryStore()
    store.set("backup.keyring", value)
    const write = vi.spyOn(store, "set")
    const keys = new BackupKeys(store)
    for (const action of [() => keys.keyring(), () => keys.exportRecoveryKey(), () => keys.fingerprint(), () => keys.importRecoveryKey(recovery)]) {
      expect(action).toThrow("stored backup encryption keyring is malformed")
      expect(store.get("backup.keyring")).toBe(value)
    }
    expect(write).not.toHaveBeenCalled()
  })

  it("creates the first key only when no value exists", () => {
    const store = memoryStore()
    const write = vi.spyOn(store, "set")
    const keys = new BackupKeys(store)
    const first = keys.keyring()
    expect(first).toHaveLength(1)
    expect(first[0]).toHaveLength(32)
    expect(store.get("backup.keyring")).toBe(JSON.stringify(first.map((value) => value.toString("base64"))))
    expect(keys.keyring()).toEqual(first)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it("reads all valid stored keys without writing", () => {
    const store = memoryStore()
    const old = Buffer.alloc(32, 8)
    store.set("backup.keyring", JSON.stringify([key, old.toString("base64")]))
    const write = vi.spyOn(store, "set")
    expect(new BackupKeys(store).keyring()).toEqual([Buffer.from(key, "base64"), old])
    expect(write).not.toHaveBeenCalled()
  })

  it("imports into an absent keyring without minting another key", () => {
    const store = memoryStore()
    const keys = new BackupKeys(store)
    keys.importRecoveryKey(recovery)
    expect(keys.keyring()).toEqual([Buffer.alloc(32, 9)])
  })

  it("propagates store read failures without writing", () => {
    const store = memoryStore()
    vi.spyOn(store, "get").mockImplementation(() => { throw new Error("Cannot unlock store") })
    const write = vi.spyOn(store, "set")
    const keys = new BackupKeys(store)
    expect(() => keys.keyring()).toThrow("Cannot unlock store")
    expect(() => keys.importRecoveryKey(recovery)).toThrow("Cannot unlock store")
    expect(write).not.toHaveBeenCalled()
  })
})
