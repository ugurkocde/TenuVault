import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// On macOS the real plutil reads the fixtures. Elsewhere (CI runs the unit tests on Linux) a
// stand-in answers like `plutil -extract <key> raw -o - <file>` for the XML fixtures below.
const calls = vi.hoisted(() => [] as { command: string; args: string[] }[])
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const execFile = (command: string, args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    calls.push({ command, args })
    if (process.platform === "darwin") return actual.execFile(command, args, callback)
    const [, key, , , , file = ""] = args
    try {
      const value = new RegExp(`<key>${key}</key>\\s*(<true/>|<false/>|<integer>(\\d+)</integer>|<string>([^<]*)</string>)`).exec(readFileSync(file, "utf8"))
      if (!value) throw new Error(`No value at that key path or invalid key path: ${key}`)
      callback(null, `${value[1] === "<true/>" ? "true" : value[1] === "<false/>" ? "false" : value[2] ?? value[3]}\n`, "")
    } catch (error) {
      callback(error as Error, "", String(error))
    }
  }
  // promisify(execFile) resolves { stdout, stderr } through this, as it does for the real execFile.
  Object.assign(execFile, {
    [promisify.custom]: (command: string, args: string[]) =>
      new Promise((resolve, reject) => execFile(command, args, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })))),
  })
  return { ...actual, execFile }
})
vi.mock("electron", () => ({ app: { isPackaged: true, getVersion: () => "0.6.0", on: vi.fn() } }))
vi.mock("electron-updater", async (importOriginal) => {
  const original = await importOriginal<typeof import("electron-updater")>()
  return { default: { autoUpdater: { on: vi.fn(), setFeedURL: vi.fn() } }, CancellationToken: original.CancellationToken }
})

const { managedPreferenceEnabled } = await import("../src/main/updates")

const plist = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tenuvault-managed-prefs-"))
  calls.length = 0
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function profile(body: string, user?: string) {
  const folder = user ? join(root, user) : root
  mkdirSync(folder, { recursive: true })
  const file = join(folder, "com.tenuvault.desktop.plist")
  writeFileSync(file, plist(body))
  return file
}

describe("macOS managed preferences", () => {
  it("is off without a configuration profile", async () => {
    expect(await managedPreferenceEnabled("DisableAutoUpdate", root, "admin")).toBe(false)
  })

  it("reads the device profile and the profile of the signed-in user", async () => {
    profile("<key>DisableAutoUpdate</key>\n<true/>")
    expect(await managedPreferenceEnabled("DisableAutoUpdate", root, "admin")).toBe(true)
    rmSync(join(root, "com.tenuvault.desktop.plist"))
    profile("<key>DisableAutoUpdate</key>\n<true/>", "admin")
    expect(await managedPreferenceEnabled("DisableAutoUpdate", root, "admin")).toBe(true)
    // Another user's profile does not apply.
    expect(await managedPreferenceEnabled("DisableAutoUpdate", root, "someone-else")).toBe(false)
    expect(await managedPreferenceEnabled("DisableAutoUpdate", root, null)).toBe(false)
  })

  it("reads each policy by its own key and needs the value true", async () => {
    profile("<key>DisableSetupDiagnostics</key>\n<true/>\n<key>DisableAutoUpdate</key>\n<false/>")
    expect(await managedPreferenceEnabled("DisableSetupDiagnostics", root, "admin")).toBe(true)
    expect(await managedPreferenceEnabled("DisableAutoUpdate", root, "admin")).toBe(false)
    profile("<key>DisableAutoUpdate</key>\n<integer>1</integer>", "admin")
    expect(await managedPreferenceEnabled("DisableAutoUpdate", root, "admin")).toBe(true)
    profile("<key>DisableAutoUpdate</key>\n<integer>0</integer>", "admin")
    expect(await managedPreferenceEnabled("DisableAutoUpdate", root, "admin")).toBe(false)
  })

  it("treats a profile it cannot read as not set", async () => {
    writeFileSync(join(root, "com.tenuvault.desktop.plist"), "not a property list")
    expect(await managedPreferenceEnabled("DisableAutoUpdate", root, "admin")).toBe(false)
  })

  it.runIf(process.platform === "darwin" && process.getuid?.() !== 0)("treats a profile the user may not read as not set", async () => {
    chmodSync(profile("<key>DisableAutoUpdate</key>\n<true/>"), 0o000)
    expect(await managedPreferenceEnabled("DisableAutoUpdate", root, "admin")).toBe(false)
  })

  it.runIf(process.platform === "darwin")("reads binary property lists, as profiles are often stored", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
    const file = profile("<key>DisableAutoUpdate</key>\n<true/>")
    actual.execFileSync("/usr/bin/plutil", ["-convert", "binary1", file])
    expect(readFileSync(file).subarray(0, 6).toString()).toBe("bplist")
    expect(await managedPreferenceEnabled("DisableAutoUpdate", root, "admin")).toBe(true)
  })

  it("runs plutil by absolute path", async () => {
    await managedPreferenceEnabled("DisableAutoUpdate", root, "admin")
    expect(calls.map((call) => call.command)).toEqual(["/usr/bin/plutil", "/usr/bin/plutil"])
    expect(calls[1]?.args).toEqual(["-extract", "DisableAutoUpdate", "raw", "-o", "-", join(root, "admin", "com.tenuvault.desktop.plist")])
  })
})
