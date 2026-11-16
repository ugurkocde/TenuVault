/**
 * Turns automatic updates off for a packaged smoke run with the DisableAutoUpdate policy that
 * src/main/updates.ts reads, and puts the previous value back afterwards. Without it, a packaged
 * nightly under test can download a release while the suite switches the update channel, and
 * on macOS that release replaces the app when it quits (seen on 2026-11-15).
 *
 * macOS: the preference DisableAutoUpdate for com.tenuvault.desktop in the user's defaults.
 * Windows: DWORD DisableAutoUpdate = 1 under HKCU\SOFTWARE\Policies\TenuVault.
 * Linux reads no policy and installs no updates from a smoke build, so nothing is changed there.
 */
import { spawnSync } from "node:child_process"
import { join } from "node:path"

const DOMAIN = "com.tenuvault.desktop"
const NAME = "DisableAutoUpdate"
const run = (command, args) => spawnSync(command, args, { encoding: "utf8" })

function macos() {
  const before = run("defaults", ["read", DOMAIN, NAME])
  const had = before.status === 0
  if (had && before.stdout.trim() === "1") return { set: false, restore() {} }
  const write = run("defaults", ["write", DOMAIN, NAME, "-bool", "true"])
  if (write.status !== 0) return { set: false, error: write.stderr.trim(), restore() {} }
  return {
    set: true,
    restore() {
      if (had) run("defaults", ["write", DOMAIN, NAME, "-bool", "false"])
      else run("defaults", ["delete", DOMAIN, NAME])
    },
  }
}

function windows() {
  // By absolute path, as the app does, so a reg.exe earlier on PATH is never run.
  const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe")
  const enabled = (hive) => /DisableAutoUpdate\s+REG_DWORD\s+0x0*1\b/i.test(run(reg, ["query", `${hive}\\SOFTWARE\\Policies\\TenuVault`, "/v", NAME]).stdout ?? "")
  if (enabled("HKLM") || enabled("HKCU")) return { set: false, restore() {} }
  const key = "HKCU\\SOFTWARE\\Policies\\TenuVault"
  const before = run(reg, ["query", key, "/v", NAME])
  const previous = before.status === 0 ? before.stdout.match(/DisableAutoUpdate\s+(REG_\w+)\s+(\S+)/i) : null
  const keyExisted = run(reg, ["query", key]).status === 0
  const add = run(reg, ["add", key, "/v", NAME, "/t", "REG_DWORD", "/d", "1", "/f"])
  if (add.status !== 0) return { set: false, error: (add.stderr || add.stdout).trim(), restore() {} }
  return {
    set: true,
    restore() {
      if (previous) run(reg, ["add", key, "/v", NAME, "/t", previous[1], "/d", previous[2], "/f"])
      else if (keyExisted) run(reg, ["delete", key, "/v", NAME, "/f"])
      else run(reg, ["delete", key, "/f"])
    },
  }
}

/** Sets the policy and returns { set, error?, restore }; restore is safe to call more than once. */
export function disableAutoUpdate(platform = process.platform) {
  const change = platform === "darwin" ? macos() : platform === "win32" ? windows() : { set: false, restore() {} }
  let restored = false
  return {
    ...change,
    restore() {
      if (restored) return
      restored = true
      change.restore()
    },
  }
}
