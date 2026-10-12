import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Preferences } from "../src/main/preferences"
import { SecureStore } from "../src/main/storage/secure-store"
import { firstBackupNote } from "../src/renderer/lib/plan-notes"

const directories: string[] = []
const cipher = {
  encrypt: (value: string) => Buffer.from(value),
  decrypt: (value: Buffer) => value.toString("utf8"),
}

function storedPreferences(values: Record<string, unknown>): Preferences {
  const directory = mkdtempSync(join(tmpdir(), "tenuvault-preferences-"))
  directories.push(directory)
  const file = join(directory, "store.enc")
  writeFileSync(file, cipher.encrypt(JSON.stringify({ "app.preferences": JSON.stringify(values) })))
  return new Preferences(new SecureStore(file, cipher))
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("first backup note preference", () => {
  it("loads an older stored file without the flag with the default false", () => {
    const preferences = storedPreferences({ startAtLogin: true, retentionDays: 90 })
    expect(preferences.get()).toMatchObject({ startAtLogin: true, retentionDays: 90, firstBackupNoteSeen: false })
    expect(firstBackupNote("community", preferences.get().firstBackupNoteSeen)).not.toBeNull()
  })

  it.each(["false", "true", 0, 1, null, {}, []])("loads a stored non-boolean flag %j without throwing and keeps the note hidden", (value) => {
    const preferences = storedPreferences({ firstBackupNoteSeen: value })
    expect(() => preferences.get()).not.toThrow()
    expect(firstBackupNote("community", preferences.get().firstBackupNoteSeen)).toBeNull()
  })
})
