/**
 * Turns automatic updates off for a packaged smoke run with the DisableAutoUpdate policy that
 * src/main/updates.ts reads, and takes it away again afterwards. Without it, a packaged nightly
 * under test can download a release while the suite switches the update channel, and on macOS that
 * release replaces the app when it quits (seen on 2026-11-15).
 *
 * macOS: /Library/Managed Preferences/com.tenuvault.desktop.plist, where configuration profiles
 *   put it. Only root can write there, so the run needs sudo.
 * Windows: DWORD DisableAutoUpdate = 1 in the key HKCU\SOFTWARE\Policies\TenuVault.
 * Linux reads no policy and installs no updates from a smoke build, so nothing is changed there.
 *
 * The rules that keep the state recoverable whenever a run dies:
 * - One run at a time per machine: a run holds the loopback port 47319 as its lock until it ends,
 *   and the system frees the port the moment the process dies, however it died.
 * - A run only ever works on an empty store. When updates are already off by policy it changes
 *   nothing; when any other TenuVault policy exists (device or user profile, HKLM or HKCU key) it
 *   refuses, so no one else's settings are ever changed or put back.
 * - What a run writes says so: the value TenuVaultSmokeRun sits next to the policy, in one plist
 *   file renamed into place (macOS) or in one registry key the run creates (Windows). The policy
 *   never exists without the mark.
 * - Before it looks at the store, a run waits until no process from a killed run is still
 *   writing it. The next run that holds the lock removes a marked store, and on Windows an empty
 *   policy key (a run killed right after creating it), before anything else.
 *
 * Out of scope: a configuration profile or Group Policy delivered for the first time in the
 * moment between a run's check of the store and its write or removal. The harness is for CI
 * runners and developer machines, and it refuses to start where any TenuVault policy exists.
 *
 * `node scripts/smoke-update-policy.mjs --clean` removes what a killed run left, without a smoke run.
 */
import { spawn, spawnSync } from "node:child_process"
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const DOMAIN = "com.tenuvault.desktop"
const NAME = "DisableAutoUpdate"
const MARK = "TenuVaultSmokeRun"
const LOCK_PORT = 47319
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30_000, ...options })
const failed = (result) => (result.error?.message || result.stderr?.toString() || result.stdout?.toString() || `exit ${result.status}`).trim()
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Holds the machine-wide lock until release(), or until this process dies. */
function lock() {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", (error) =>
      resolve({
        error: error.code === "EADDRINUSE"
          ? `another smoke run holds the ${NAME} policy (its lock, 127.0.0.1:${LOCK_PORT}, is in use); wait for it to finish`
          : `could not take the smoke policy lock on 127.0.0.1:${LOCK_PORT}: ${error.message}`,
      }),
    )
    server.listen({ port: LOCK_PORT, host: "127.0.0.1", exclusive: true }, () => {
      server.unref()
      resolve({ release: () => server.close() })
    })
  })
}

/**
 * Waits until no other process is still writing the store: a killed run's last write can outlive
 * it. A dead run starts no new writes, so once none is left the store shows everything it did.
 */
function waitForWriters(list, describe) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const writers = list()
    if (writers === null) return `could not list running processes to check for ${describe}`
    if (writers.length === 0) return null
    sleep(200)
  }
  return `${describe} is still running after 10 seconds`
}

// ---------- macOS ----------

const MANAGED = "/Library/Managed Preferences"
const FILE = join(MANAGED, `${DOMAIN}.plist`)
const STAGE = join(MANAGED, `.${DOMAIN}.smoke.plist`)
const SUDO_HINT =
  `On macOS the packaged smoke sets ${NAME} in ${MANAGED}, which only root can write. ` +
  "Run `sudo -v` in this terminal (or allow passwordless sudo) and start again."
const sudo = (args) => run("/usr/bin/sudo", ["-n", ...args])
const currentUser = () => {
  try { return userInfo().username || null } catch { return null }
}
const userFile = () => (currentUser() ? join(MANAGED, currentUser(), `${DOMAIN}.plist`) : null)

/** "absent", "present" or { error }. Read as this user: the folders are world-readable. */
function exists(path) {
  try {
    lstatSync(path)
    return "present"
  } catch (error) {
    return error.code === "ENOENT" ? "absent" : { error: `could not check ${path}: ${error.message}` }
  }
}

/** True when file sets key to the boolean true, read as the app reads it. */
const plistTrue = (file, key) => run("/usr/bin/plutil", ["-extract", key, "raw", "-expect", "bool", "-o", "-", file]).stdout?.trim() === "true"
/** The smoke run that wrote file, or null when it is unreadable or not a smoke run's. */
const plistMark = (file) => {
  const result = run("/usr/bin/plutil", ["-extract", MARK, "raw", "-expect", "string", "-o", "-", file])
  return result.status === 0 ? result.stdout.trim() : null
}

/** sudo commands of any process that name the store: a killed run's install, mv or rm. */
function macosWriters() {
  // -ww: whole command lines. ps can report an error on stderr and still exit 0.
  const listed = run("/bin/ps", ["-axww", "-o", "stat=,command="], { timeout: 5000 })
  if (listed.status !== 0 || listed.stderr.trim() || !listed.stdout.trim()) return null
  return listed.stdout.split("\n").filter((line) => {
    const [, stat = "", command = ""] = /^\s*(\S+)\s+(.*)$/.exec(line) ?? []
    // Only the programs a run writes with, not a shell whose script mentions them, and not a
    // zombie (state Z), which has finished.
    return !stat.startsWith("Z") && /^(\/usr\/bin\/)?(sudo|install|mv|rm) /.test(command.replace(/^\/bin\/(mv|rm) /, "$1 ")) && command.includes(`${MANAGED}/`) && command.includes(DOMAIN)
  })
}

/** Removes what a dead smoke run left. Returns why it could not, or null. */
function macosRecover() {
  const waited = waitForWriters(macosWriters, `a process writing ${MANAGED}`)
  if (waited) return waited
  const file = exists(FILE)
  const stage = exists(STAGE)
  for (const state of [file, stage]) if (state.error) return state.error
  const leftovers = [...(stage === "present" ? [STAGE] : []), ...(file === "present" && plistMark(FILE) ? [FILE] : [])]
  if (leftovers.length === 0) return null
  const removed = sudo(["/bin/rm", "-f", ...leftovers])
  if (removed.status !== 0) return `could not remove ${leftovers.join(" and ")}, which a killed smoke run left: ${failed(removed)}. ${SUDO_HINT}`
  console.log(`Removed the ${NAME} policy a killed smoke run left in ${MANAGED}.`)
  return null
}

function macosChange(id) {
  const user = userFile()
  if (plistTrue(FILE, NAME) || (user && plistTrue(user, NAME))) return {}
  for (const path of [FILE, ...(user ? [user] : [])]) {
    const state = exists(path)
    if (state.error) return { error: state.error }
    if (state === "present") {
      return { error: `${path} already exists and does not set ${NAME} to true. The smoke does not edit a configuration profile: add ${NAME} to it, or run the smoke on a Mac without it.` }
    }
  }
  if (sudo(["/usr/bin/true"]).status !== 0) return { error: SUDO_HINT }
  return {
    apply() {
      const work = mkdtempSync(join(tmpdir(), "tenuvault-smoke-policy-"))
      try {
        const source = join(work, "policy.plist")
        writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>${NAME}</key>
\t<true/>
\t<key>${MARK}</key>
\t<string>${id}</string>
</dict>
</plist>
`)
        // Written next to the target and renamed into place, so the policy appears complete and
        // already marked. mv -n never replaces a file that appeared meanwhile. The folder, which
        // macOS creates on any Mac that ever had a profile, is left in place afterwards.
        for (const step of [
          ["/bin/mkdir", "-p", MANAGED],
          ["/usr/bin/install", "-m", "644", "-o", "root", "-g", "wheel", source, STAGE],
          ["/bin/mv", "-n", STAGE, FILE],
        ]) {
          const result = sudo(step)
          if (result.status !== 0) return failed(result)
        }
      } finally {
        rmSync(work, { recursive: true, force: true })
      }
      return plistMark(FILE) === id ? null : `${FILE} appeared while the smoke was writing it and was left as it is`
    },
    undo() {
      const removed = sudo(["/bin/rm", "-f", STAGE, ...(plistMark(FILE) === id ? [FILE] : [])])
      if (removed.status !== 0) return `${failed(removed)}. ${SUDO_HINT}`
      return plistMark(FILE) === id ? `${FILE} is still there` : null
    },
    // A long suite outlives the sudo timestamp, and the removal at the end needs it.
    keepAlive() {
      const timer = setInterval(() => spawn("/usr/bin/sudo", ["-n", "-v"], { stdio: "ignore" }).on("error", () => {}), 60_000)
      timer.unref()
      return () => clearInterval(timer)
    },
  }
}

// ---------- Windows ----------

const HKCU = "HKCU:\\SOFTWARE\\Policies\\TenuVault"
const HKLM = "HKLM:\\SOFTWARE\\Policies\\TenuVault"
const WRITER = "tenuvault-smoke-policy-write"
// By absolute path, as the app does, so a powershell.exe earlier on PATH is never run.
const powershell = (script) =>
  run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `$ErrorActionPreference = 'Stop'\n${script}`])
const quote = (text) => `'${text.replaceAll("'", "''")}'`

/**
 * Both policy keys, read through the registry API (no localized reg.exe messages): { hklm, hkcu },
 * each null when the key is absent, else { values, subkeys, kind, disable, mark }.
 */
function windowsRead() {
  const result = powershell(`function Read-Key($path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $key = Get-Item -LiteralPath $path
  $kind = if (@($key.GetValueNames()) -contains '${NAME}') { [string]$key.GetValueKind('${NAME}') } else { $null }
  [pscustomobject]@{ values = $key.ValueCount; subkeys = $key.SubKeyCount; kind = $kind; disable = $key.GetValue('${NAME}', $null); mark = $key.GetValue('${MARK}', $null) }
}
[pscustomobject]@{ hklm = Read-Key ${quote(HKLM)}; hkcu = Read-Key ${quote(HKCU)} } | ConvertTo-Json -Compress -Depth 3`)
  if (result.status !== 0) return { error: `could not read the ${NAME} policy: ${failed(result)}` }
  try {
    return JSON.parse(result.stdout)
  } catch {
    return { error: `could not read the ${NAME} policy: ${result.stdout.trim()}` }
  }
}

const dwordOne = (key) => key?.kind === "DWord" && key.disable === 1

/** The smoke's own writes: their command lines carry the WRITER tag. */
function windowsWriters() {
  const result = powershell(`@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${WRITER}*' -and $_.CommandLine -notlike '*Get-CimInstance*' }).Count`)
  const count = result.stdout?.trim() ?? ""
  return result.status === 0 && /^\d+$/.test(count) ? Array.from({ length: Number(count) }) : null
}

/**
 * Removes a marked key in one step: the key with both values when it holds nothing else, otherwise
 * only the policy value and then the mark, each checked. Returns why it could not, or null.
 */
function windowsRemove(mark) {
  const result = powershell(`# ${WRITER}
$key = Get-Item -LiteralPath ${quote(HKCU)} -ErrorAction SilentlyContinue
if ($null -eq $key) { return }
if ([string]$key.GetValue('${MARK}', '') -ne ${quote(mark)}) { throw 'the key carries another mark' }
$others = @($key.GetValueNames() | Where-Object { $_ -ne '${NAME}' -and $_ -ne '${MARK}' })
if ($others.Count -eq 0 -and $key.SubKeyCount -eq 0) { Remove-Item -LiteralPath ${quote(HKCU)}; return }
Remove-ItemProperty -LiteralPath ${quote(HKCU)} -Name '${NAME}' -ErrorAction SilentlyContinue
if ($null -ne (Get-Item -LiteralPath ${quote(HKCU)}).GetValue('${NAME}', $null)) { throw 'the policy value is still there' }
Remove-ItemProperty -LiteralPath ${quote(HKCU)} -Name '${MARK}'`)
  return result.status === 0 ? null : failed(result)
}

function windowsRecover() {
  const waited = waitForWriters(windowsWriters, "a smoke run's registry write")
  if (waited) return waited
  const now = windowsRead()
  if (now.error) return now.error
  if (now.hkcu && now.hkcu.mark == null && now.hkcu.values === 0 && now.hkcu.subkeys === 0) {
    // An empty policy key holds no policy: what a run killed right after creating it leaves.
    const removed = powershell(`# ${WRITER}
$key = Get-Item -LiteralPath ${quote(HKCU)} -ErrorAction SilentlyContinue
if ($null -ne $key -and $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0) { Remove-Item -LiteralPath ${quote(HKCU)} }`)
    if (removed.status !== 0) return `could not remove the empty key ${HKCU}: ${failed(removed)}`
    console.log(`Removed the empty key ${HKCU} a killed smoke run left.`)
    return null
  }
  if (now.hkcu?.mark == null) return null
  const failure = windowsRemove(String(now.hkcu.mark))
  if (failure) return `could not remove the ${NAME} policy a killed smoke run left: ${failure}`
  console.log(`Removed the ${NAME} policy a killed smoke run left under ${HKCU}.`)
  return null
}

function windowsChange(id) {
  const now = windowsRead()
  if (now.error) return { error: now.error }
  if (dwordOne(now.hklm) || dwordOne(now.hkcu)) return {}
  for (const [path, key] of [[HKLM, now.hklm], [HKCU, now.hkcu]]) {
    if (key) return { error: `${path} already exists and does not set ${NAME} to 1. The smoke does not edit a policy someone else set: set ${NAME} to 1 there, or delete the key.` }
  }
  return {
    apply() {
      // New-Item fails when the key appeared meanwhile, so an administrator's key is never taken
      // over. The mark goes in first. When a later step fails, only the mark is taken back, and
      // the key only while it is empty, so a value someone else added meanwhile stays.
      const result = powershell(`# ${WRITER}
New-Item -Path ${quote(HKCU)} | Out-Null
try {
  New-ItemProperty -LiteralPath ${quote(HKCU)} -Name '${MARK}' -PropertyType String -Value ${quote(id)} | Out-Null
  New-ItemProperty -LiteralPath ${quote(HKCU)} -Name '${NAME}' -PropertyType DWord -Value 1 | Out-Null
} catch {
  $key = Get-Item -LiteralPath ${quote(HKCU)} -ErrorAction SilentlyContinue
  if ($null -ne $key -and [string]$key.GetValue('${MARK}', '') -eq ${quote(id)} -and $null -eq $key.GetValue('${NAME}', $null)) { Remove-ItemProperty -LiteralPath ${quote(HKCU)} -Name '${MARK}' }
  $key = Get-Item -LiteralPath ${quote(HKCU)} -ErrorAction SilentlyContinue
  if ($null -ne $key -and $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0) { Remove-Item -LiteralPath ${quote(HKCU)} }
  throw
}`)
      return result.status === 0 ? null : failed(result)
    },
    undo() {
      const current = windowsRead()
      if (current.error) return current.error
      if (current.hkcu?.mark == null) return null
      if (current.hkcu.mark !== id) return `${HKCU} carries another smoke run's mark`
      return windowsRemove(id)
    },
  }
}

// ---------- Shared ----------

/** Removes what a killed run left, holding the lock. Returns { release } or { error }. */
async function lockAndRecover(platform) {
  const held = await lock()
  if (held.error) return held
  const failure = platform === "darwin" ? macosRecover() : windowsRecover()
  if (failure) {
    held.release()
    return { error: failure }
  }
  return held
}

/**
 * Makes sure updates are off by policy. Resolves to { restore }, where restore() takes the policy
 * away again, is safe to call more than once and returns false when it could not, and { error } when
 * the policy could not be set. Call restore after an error too: a write that failed may still have
 * taken effect.
 */
export async function disableAutoUpdate(platform = process.platform) {
  const none = { restore: () => true }
  if (platform !== "darwin" && platform !== "win32") return none
  const held = await lockAndRecover(platform)
  if (held.error) return { error: held.error, ...none }
  const id = `${process.pid}@${new Date().toISOString()}`
  const change = platform === "darwin" ? macosChange(id) : windowsChange(id)
  if (change.error || !change.apply) {
    held.release()
    return change.error ? { error: change.error, ...none } : none
  }
  const stopKeepAlive = change.keepAlive?.() ?? (() => {})
  let result = null
  const restore = () => {
    if (result !== null) return result
    const failure = change.undo()
    stopKeepAlive()
    if (failure) {
      console.warn(`Could not remove the ${NAME} policy this smoke run set: ${failure}. Remove it with: node scripts/smoke-update-policy.mjs --clean`)
    } else {
      held.release()
    }
    result = !failure
    return result
  }
  const error = change.apply()
  return error ? { error, restore } : { restore }
}

const entry = (() => {
  try { return process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href } catch { return null }
})()
if (entry && import.meta.url === entry && process.argv[2] === "--clean") {
  if (process.platform !== "darwin" && process.platform !== "win32") process.exit(0)
  const held = await lockAndRecover(process.platform)
  if (held.error) {
    console.error(held.error)
    process.exit(1)
  }
  held.release()
  console.log("No smoke run's update policy is left.")
}
