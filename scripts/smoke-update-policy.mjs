/**
 * Turns automatic updates off for a packaged smoke run with the DisableAutoUpdate policy that
 * src/main/updates.ts reads, and puts the previous value back exactly afterwards. Without it, a
 * packaged nightly under test can download a release while the suite switches the update
 * channel, and on macOS that release replaces the app when it quits (seen on 2026-11-15).
 *
 * macOS: the preference DisableAutoUpdate for com.tenuvault.desktop in the user's defaults.
 * Windows: DWORD DisableAutoUpdate = 1 under HKCU\SOFTWARE\Policies\TenuVault.
 * Linux reads no policy and installs no updates from a smoke build, so nothing is changed there.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DOMAIN = "com.tenuvault.desktop"
const NAME = "DisableAutoUpdate"
const run = (command, args) => spawnSync(command, args, { encoding: "utf8" })
const failed = (result) => (result.error?.message || result.stderr || result.stdout || `exit ${result.status}`).trim()

function macos() {
  // The value as a plist fragment keeps its type (boolean, integer, string, ...) for the restore.
  const exported = run("defaults", ["export", DOMAIN, "-"])
  const extracted = exported.status === 0 ? spawnSync("plutil", ["-extract", NAME, "xml1", "-o", "-", "-"], { input: exported.stdout, encoding: "utf8" }) : null
  const previous = extracted?.status === 0 ? extracted.stdout.match(/<plist[^>]*>\s*([\s\S]*?)\s*<\/plist>/)?.[1] ?? null : null
  if (extracted?.status === 0 && previous === null) return { error: "could not read the existing DisableAutoUpdate preference" }
  if (previous === "<true/>") return { restore() {} }
  const write = run("defaults", ["write", DOMAIN, NAME, "-bool", "true"])
  if (write.status !== 0) return { error: failed(write) }
  return {
    restore() {
      const result = previous === null ? run("defaults", ["delete", DOMAIN, NAME]) : run("defaults", ["write", DOMAIN, NAME, previous])
      if (result.status !== 0) console.warn(`Could not restore the ${NAME} preference: ${failed(result)}`)
    },
  }
}

function windows() {
  // By absolute path, as the app does, so a reg.exe earlier on PATH is never run.
  const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe")
  const enabled = (hive) => /DisableAutoUpdate\s+REG_DWORD\s+0x0*1\b/i.test(run(reg, ["query", `${hive}\\SOFTWARE\\Policies\\TenuVault`, "/v", NAME]).stdout ?? "")
  if (enabled("HKLM") || enabled("HKCU")) return { restore() {} }
  const key = "HKCU\\SOFTWARE\\Policies\\TenuVault"
  const keyExisted = run(reg, ["query", key]).status === 0
  const valueExisted = keyExisted && run(reg, ["query", key, "/v", NAME]).status === 0
  // reg export keeps every value of the key with its exact type and data, spaces and empty data included.
  const folder = mkdtempSync(join(tmpdir(), "tenuvault-smoke-policy-"))
  const snapshot = join(folder, "policy.reg")
  if (valueExisted) {
    const exported = run(reg, ["export", key, snapshot, "/y"])
    if (exported.status !== 0) { rmSync(folder, { recursive: true, force: true }); return { error: failed(exported) } }
  }
  const add = run(reg, ["add", key, "/v", NAME, "/t", "REG_DWORD", "/d", "1", "/f"])
  if (add.status !== 0) { rmSync(folder, { recursive: true, force: true }); return { error: failed(add) } }
  return {
    restore() {
      const result = !keyExisted ? run(reg, ["delete", key, "/f"])
        : !valueExisted ? run(reg, ["delete", key, "/v", NAME, "/f"])
        : run(reg, ["import", snapshot])
      if (result.status !== 0) console.warn(`Could not restore the ${NAME} policy: ${failed(result)}`)
      rmSync(folder, { recursive: true, force: true })
    },
  }
}

/**
 * Makes sure updates are off by policy. Returns { error } when that failed, otherwise { restore },
 * which puts back the earlier state and is safe to call more than once.
 */
export function disableAutoUpdate(platform = process.platform) {
  const change = platform === "darwin" ? macos() : platform === "win32" ? windows() : { restore() {} }
  if (change.error) return { error: change.error, restore() {} }
  let restored = false
  return {
    restore() {
      if (restored) return
      restored = true
      change.restore()
    },
  }
}
