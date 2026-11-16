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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DOMAIN = "com.tenuvault.desktop"
const NAME = "DisableAutoUpdate"
const run = (command, args) => spawnSync(command, args, { encoding: "utf8" })
const failed = (result) => (result.error?.message || result.stderr || result.stdout || `exit ${result.status}`).trim()

function macos() {
  // The value as a plist fragment keeps its type (boolean, integer, string, ...) for the restore.
  // defaults writes a value given as a plist fragment with that fragment's type.
  const exported = run("defaults", ["export", DOMAIN, "-"])
  if (exported.status !== 0) return { error: `could not read the ${NAME} preference: ${failed(exported)}` }
  const extracted = spawnSync("plutil", ["-extract", NAME, "xml1", "-o", "-", "-"], { input: exported.stdout, encoding: "utf8" })
  const missing = extracted.status !== 0 && /No value at that key path/i.test(extracted.stderr ?? "")
  const previous = extracted.status === 0 ? extracted.stdout.match(/<plist[^>]*>\s*([\s\S]*?)\s*<\/plist>/)?.[1] ?? null : null
  // Change nothing unless the earlier state is known: a value to write back, or no value at all.
  if (!missing && previous === null) return { error: `could not read the ${NAME} preference: ${failed(extracted)}` }
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
  // reg export keeps the value's exact type and data, spaces and empty data included. Only the
  // DisableAutoUpdate entry is kept for the restore, so other values of the key are never touched.
  const folder = mkdtempSync(join(tmpdir(), "tenuvault-smoke-policy-"))
  const snapshot = join(folder, "policy.reg")
  const cleanUp = () => rmSync(folder, { recursive: true, force: true })
  if (valueExisted) {
    const exported = run(reg, ["export", key, snapshot, "/y"])
    const entry = exported.status === 0 ? onlyValue(readFileSync(snapshot, "utf16le")) : null
    if (!entry) { cleanUp(); return { error: exported.status === 0 ? `could not find ${NAME} in the exported policy key` : failed(exported) } }
    writeFileSync(snapshot, `\ufeff${entry}`, "utf16le")
  }
  const add = run(reg, ["add", key, "/v", NAME, "/t", "REG_DWORD", "/d", "1", "/f"])
  if (add.status !== 0) { cleanUp(); return { error: failed(add) } }
  return {
    restore() {
      const result = valueExisted ? run(reg, ["import", snapshot]) : run(reg, ["delete", key, "/v", NAME, "/f"])
      if (result.status !== 0) console.warn(`Could not restore the ${NAME} policy: ${failed(result)}`)
      // A key this run created is removed only when nothing else was added to it meanwhile.
      if (!keyExisted) {
        const left = run(reg, ["query", key, "/s"])
        const entries = (left.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^HKEY_CURRENT_USER\\SOFTWARE\\Policies\\TenuVault$/i.test(line))
        if (left.status === 0 && entries.length === 0) run(reg, ["delete", key, "/f"])
      }
      cleanUp()
    },
  }
}

/** The header, the key line and the DisableAutoUpdate entry (with continuation lines) of a .reg export. */
function onlyValue(text) {
  const lines = text.replace(/^\ufeff/, "").split(/\r?\n/)
  const header = lines.findIndex((line) => line.startsWith("Windows Registry Editor"))
  const keyLine = lines.findIndex((line) => /^\[HKEY_CURRENT_USER\\SOFTWARE\\Policies\\TenuVault\]$/i.test(line))
  const start = lines.findIndex((line) => line.toLowerCase().startsWith(`"${NAME.toLowerCase()}"=`))
  if (header < 0 || keyLine < 0 || start < 0) return null
  let end = start
  while (lines[end]?.endsWith("\\") && end + 1 < lines.length) end++
  return [lines[header], "", lines[keyLine], ...lines.slice(start, end + 1), "", ""].join("\r\n")
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
