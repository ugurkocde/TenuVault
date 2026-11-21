/**
 * Turns automatic updates off for a packaged smoke run with the DisableAutoUpdate policy that
 * src/main/updates.ts reads, and puts the previous state back exactly afterwards. Without it, a
 * packaged nightly under test can download a release while the suite switches the update
 * channel, and on macOS that release replaces the app when it quits (seen on 2026-11-15).
 *
 * macOS: DisableAutoUpdate = true in /Library/Managed Preferences/com.tenuvault.desktop.plist,
 *   where configuration profiles put it. Only root can write there, so the run needs sudo.
 * Windows: DWORD DisableAutoUpdate = 1 under HKCU\SOFTWARE\Policies\TenuVault.
 * Linux reads no policy and installs no updates from a smoke build, so nothing is changed there.
 *
 * Before it changes anything, a run records the earlier state and its process ID in a marker under
 * ~/.tenuvault-smoke/update-policy. A run that was killed before it could restore leaves the marker
 * behind, and the next run puts that earlier state back first. A marker whose run is still alive is
 * never touched.
 */
import { spawn, spawnSync } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"

const DOMAIN = "com.tenuvault.desktop"
const NAME = "DisableAutoUpdate"
const MANAGED = "/Library/Managed Preferences"
const SUDO = "/usr/bin/sudo"
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options })
const failed = (result) => (result.error?.message || result.stderr?.toString() || result.stdout?.toString() || `exit ${result.status}`).trim()
const sudo = (args, options) => run(SUDO, ["-n", ...args], options)

export const DEFAULT_STATE = join(homedir(), ".tenuvault-smoke", "update-policy")

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === "EPERM"
  }
}

// ---------- macOS ----------

const SUDO_HINT =
  `On macOS the packaged smoke sets ${NAME} in ${MANAGED}, which only root can write. ` +
  "Run `sudo -v` in this terminal (or allow passwordless sudo) and start the smoke again."

/** True when a managed preference already turns updates off, as the app reads it (src/main/updates.ts). */
function macosManaged() {
  let user = null
  try { user = userInfo().username } catch {}
  const files = [join(MANAGED, `${DOMAIN}.plist`), ...(user ? [join(MANAGED, user, `${DOMAIN}.plist`)] : [])]
  return files.some((file) => /^(true|1)$/i.test(run("/usr/bin/plutil", ["-extract", NAME, "raw", "-o", "-", file]).stdout?.trim() ?? ""))
}

/** Puts the file recorded in a macOS marker back as it was. Returns why it could not, or null. */
function macosUndo(marker) {
  const file = join(MANAGED, `${DOMAIN}.plist`)
  if (marker.existed) {
    const put = sudo(["/usr/bin/install", "-m", marker.mode, "-o", String(marker.uid), "-g", String(marker.gid), marker.backup, file])
    if (put.status !== 0) return failed(put)
    const now = sudo(["/bin/cat", file], { encoding: "buffer" })
    if (now.status !== 0 || !now.stdout.equals(readFileSync(marker.backup))) return `${file} does not match the copy taken before the run`
    return null
  }
  const removed = sudo(["/bin/rm", "-f", file])
  if (removed.status !== 0) return failed(removed)
  // A folder this run created goes only when nothing else was put in it meanwhile.
  if (marker.createdFolder) sudo(["/bin/rmdir", MANAGED])
  return null
}

function macosChange(state) {
  if (macosManaged()) return {}
  const check = sudo(["/usr/bin/true"])
  if (check.status !== 0) return { error: SUDO_HINT }
  const file = join(MANAGED, `${DOMAIN}.plist`)
  const folderExisted = sudo(["/bin/test", "-d", MANAGED]).status === 0
  const existed = sudo(["/bin/test", "-e", file]).status === 0
  const next = join(state, `next-${process.pid}.plist`)
  const backup = join(state, `previous-${process.pid}.plist`)
  const marker = { pid: process.pid, startedAt: new Date().toISOString(), platform: "darwin", existed, createdFolder: !folderExisted }
  if (existed) {
    const stat = sudo(["/usr/bin/stat", "-f", "%Lp %u %g", file])
    const bytes = sudo(["/bin/cat", file], { encoding: "buffer" })
    const [mode, uid, gid] = stat.stdout?.trim().split(" ") ?? []
    if (stat.status !== 0 || bytes.status !== 0 || !gid) return { error: `could not read ${file}: ${failed(stat.status !== 0 ? stat : bytes)}` }
    Object.assign(marker, { mode, uid: Number(uid), gid: Number(gid), backup })
    writeFileSync(backup, bytes.stdout)
    writeFileSync(next, bytes.stdout)
    // plutil keeps the file's format (XML or binary) and every other key.
    const set = run("/usr/bin/plutil", ["-replace", NAME, "-bool", "YES", next])
    if (set.status !== 0) {
      rmSync(next, { force: true })
      rmSync(backup, { force: true })
      return { error: `could not add ${NAME} to ${file}: ${failed(set)}` }
    }
  } else {
    writeFileSync(next, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>${NAME}</key>
\t<true/>
</dict>
</plist>
`)
  }
  return {
    marker,
    apply() {
      const steps = [
        ["/bin/mkdir", "-p", MANAGED],
        // Readable by everyone, as profiles install it, so the app sees it. The restore puts the
        // earlier mode and owner back.
        ["/usr/bin/install", "-m", "644", "-o", "root", "-g", "wheel", next, file],
      ]
      for (const step of steps) {
        const result = sudo(step)
        if (result.status !== 0) return failed(result)
      }
      return null
    },
    // A long suite outlives the sudo timestamp; the restore at the end needs it too.
    keepAlive() {
      const timer = setInterval(() => spawn(SUDO, ["-n", "-v"], { stdio: "ignore" }).on("error", () => {}), 60_000)
      timer.unref()
      return () => clearInterval(timer)
    },
    files: [next, backup],
  }
}

// ---------- Windows ----------

const KEY = "HKCU\\SOFTWARE\\Policies\\TenuVault"
// By absolute path, as the app does, so a reg.exe earlier on PATH is never run.
const reg = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe")

function windowsUndo(marker) {
  const result = marker.valueExisted ? run(reg(), ["import", marker.snapshot]) : run(reg(), ["delete", KEY, "/v", NAME, "/f"])
  const absent = !marker.valueExisted && result.status === 1 && /unable to find/i.test(result.stderr ?? "")
  if (result.status !== 0 && !absent) return failed(result)
  // A key this run created is removed only when nothing else was added to it meanwhile.
  if (!marker.keyExisted) {
    const left = run(reg(), ["query", KEY, "/s"])
    const entries = (left.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^HKEY_CURRENT_USER\\SOFTWARE\\Policies\\TenuVault$/i.test(line))
    if (left.status === 0 && entries.length === 0) run(reg(), ["delete", KEY, "/f"])
  }
  return null
}

function windowsChange(state) {
  const enabled = (hive) => /DisableAutoUpdate\s+REG_DWORD\s+0x0*1\b/i.test(run(reg(), ["query", `${hive}\\SOFTWARE\\Policies\\TenuVault`, "/v", NAME]).stdout ?? "")
  if (enabled("HKLM") || enabled("HKCU")) return {}
  // Only reg's "unable to find" answer means absent; any other failure leaves the earlier state
  // unknown, and then nothing is changed. /ve and /v keep the output to one value.
  const exists = (args) => {
    const result = run(reg(), ["query", KEY, ...args])
    if (result.status === 0) return true
    if (result.status === 1 && /unable to find the specified registry key or value/i.test(result.stderr ?? "")) return false
    return null
  }
  const keyExisted = exists(["/ve"])
  const valueExisted = keyExisted ? exists(["/v", NAME]) : false
  if (keyExisted === null || valueExisted === null) return { error: `could not read the ${NAME} policy under ${KEY}` }
  // reg export keeps the value's exact type and data, spaces and empty data included. Only the
  // DisableAutoUpdate entry is kept for the restore, so other values of the key are never touched.
  const snapshot = join(state, `previous-${process.pid}.reg`)
  if (valueExisted) {
    const exported = run(reg(), ["export", KEY, snapshot, "/y"])
    const entry = exported.status === 0 ? onlyValue(readFileSync(snapshot, "utf16le")) : null
    if (!entry) {
      rmSync(snapshot, { force: true })
      return { error: exported.status === 0 ? `could not find ${NAME} in the exported policy key` : failed(exported) }
    }
    writeFileSync(snapshot, `\ufeff${entry}`, "utf16le")
  }
  return {
    marker: { pid: process.pid, startedAt: new Date().toISOString(), platform: "win32", keyExisted, valueExisted, snapshot },
    apply() {
      const add = run(reg(), ["add", KEY, "/v", NAME, "/t", "REG_DWORD", "/d", "1", "/f"])
      return add.status === 0 ? null : failed(add)
    },
    files: [snapshot],
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

// ---------- Shared ----------

const undo = (marker) => (marker.platform === "darwin" ? macosUndo(marker) : marker.platform === "win32" ? windowsUndo(marker) : null)

function forget(markerFile, marker) {
  for (const file of [marker.backup, marker.snapshot, join(markerFile, "..", `next-${marker.pid}.plist`)]) if (file) rmSync(file, { force: true })
  rmSync(markerFile, { force: true })
}

/** Puts back the state a killed run left. Returns why it could not, or null. */
function recover(markerFile) {
  let text
  try {
    text = readFileSync(markerFile, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return null
    return `could not read ${markerFile}: ${error.message}`
  }
  let marker
  try {
    marker = JSON.parse(text)
  } catch {
    return `${markerFile} is not readable. Check the ${NAME} policy by hand, then delete the file.`
  }
  if (alive(marker.pid)) return `smoke run ${marker.pid} (started ${marker.startedAt}) still holds the ${NAME} policy; wait for it to finish (${markerFile})`
  const failure = undo(marker)
  if (failure) return `could not put back the ${NAME} policy a killed smoke run (${marker.pid}, started ${marker.startedAt}) left: ${failure}${marker.platform === "darwin" ? `. ${SUDO_HINT}` : ""}`
  forget(markerFile, marker)
  console.log(`Put back the ${NAME} policy that smoke run ${marker.pid} (started ${marker.startedAt}) left set.`)
  return null
}

/**
 * Makes sure updates are off by policy. Returns { restore }, which puts back the earlier state and is
 * safe to call more than once, and { error } when the policy could not be set. Call restore after an
 * error too: a write that failed may still have taken effect.
 */
export function disableAutoUpdate(platform = process.platform, state = DEFAULT_STATE) {
  const none = { restore() {} }
  if (platform !== "darwin" && platform !== "win32") return none
  mkdirSync(state, { recursive: true })
  const markerFile = join(state, "marker.json")
  const leftover = recover(markerFile)
  if (leftover) return { error: leftover, ...none }
  const change = platform === "darwin" ? macosChange(state) : windowsChange(state)
  if (change.error) return { error: change.error, ...none }
  if (!change.marker) return none
  // The marker is written before anything changes, and only once: a second run that started at the
  // same moment stops here.
  try {
    const fd = openSync(markerFile, "wx")
    writeSync(fd, JSON.stringify(change.marker))
    closeSync(fd)
  } catch (error) {
    for (const file of change.files) rmSync(file, { force: true })
    return { error: error.code === "EEXIST" ? `another smoke run is changing the ${NAME} policy (${markerFile})` : `could not write ${markerFile}: ${error.message}`, ...none }
  }
  const stopKeepAlive = change.keepAlive?.() ?? (() => {})
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    stopKeepAlive()
    const failure = undo(change.marker)
    // The marker stays when the restore failed, so the next run tries again.
    if (failure) console.warn(`Could not restore the ${NAME} policy: ${failure}. The next smoke run tries again (${markerFile}).`)
    else forget(markerFile, change.marker)
  }
  // A write that failed or was interrupted may still have taken effect, so the restore comes back with the error.
  const error = change.apply()
  return error ? { error, restore } : { restore }
}
