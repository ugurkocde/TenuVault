/**
 * Turns automatic updates off for a packaged smoke run with the DisableAutoUpdate policy that
 * src/main/updates.ts reads, and takes it away again afterwards. Without it, a packaged nightly
 * under test can download a release while the suite switches the update channel, and on macOS that
 * release replaces the app when it quits (seen on 2026-11-15).
 *
 * macOS: /Library/Managed Preferences/com.tenuvault.desktop.plist, where configuration profiles
 *   put it. Only root can write there, so the run needs sudo.
 * Windows: DWORD DisableAutoUpdate = 1 under HKCU\SOFTWARE\Policies\TenuVault.
 * Linux reads no policy and installs no updates from a smoke build, so nothing is changed there.
 *
 * Three rules keep the state recoverable whenever a run dies:
 * - One run at a time per machine: a run holds a loopback port as its lock until it ends, and the
 *   system frees the port the moment the process dies, however it died.
 * - What a run writes says that a smoke run wrote it: the key TenuVaultSmokeRun sits next to the
 *   policy, in the same file (macOS) or registry key (Windows). A run that holds the lock and finds
 *   it knows a dead run left it, and removes it before anything else.
 * - A run never edits a policy store it did not create: when a profile or registry value already
 *   exists and does not turn updates off, it refuses instead, so no one else's settings are ever
 *   copied, changed or put back.
 */
import { spawnSync } from "node:child_process"
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"

const DOMAIN = "com.tenuvault.desktop"
const NAME = "DisableAutoUpdate"
const MARK = "TenuVaultSmokeRun"
const LOCK_PORT = Number(process.env.TENUVAULT_SMOKE_POLICY_PORT || 47319)
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options })
const failed = (result) => (result.error?.message || result.stderr?.toString() || result.stdout?.toString() || `exit ${result.status}`).trim()

/** Holds the machine-wide lock until release(), or until this process dies. */
function lock() {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", (error) =>
      resolve({
        error: error.code === "EADDRINUSE"
          ? `another smoke run holds the ${NAME} policy (127.0.0.1:${LOCK_PORT} is in use); wait for it to finish, or set TENUVAULT_SMOKE_POLICY_PORT if something else uses that port`
          : `could not take the smoke policy lock on 127.0.0.1:${LOCK_PORT}: ${error.message}`,
      }),
    )
    server.listen({ port: LOCK_PORT, host: "127.0.0.1", exclusive: true }, () => {
      server.unref()
      resolve({ release: () => server.close() })
    })
  })
}

// ---------- macOS ----------

const MANAGED = "/Library/Managed Preferences"
const FILE = join(MANAGED, `${DOMAIN}.plist`)
const STAGE = join(MANAGED, `.${DOMAIN}.smoke.plist`)
const SUDO_HINT =
  `On macOS the packaged smoke sets ${NAME} in ${MANAGED}, which only root can write. ` +
  "Run `sudo -v` in this terminal (or allow passwordless sudo) and start the smoke again."
const sudo = (args) => run("/usr/bin/sudo", ["-n", ...args])

/** "absent", "present" or an { error }. Read as this user: the folder is world-readable. */
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
/** The smoke run that wrote file, or null when the file is not readable or not a smoke run's. */
const plistMark = (file) => {
  const result = run("/usr/bin/plutil", ["-extract", MARK, "raw", "-expect", "string", "-o", "-", file])
  return result.status === 0 ? result.stdout.trim() : null
}

function macosManaged() {
  let user = null
  try { user = userInfo().username } catch {}
  return [FILE, ...(user ? [join(MANAGED, user, `${DOMAIN}.plist`)] : [])].some((file) => plistTrue(file, NAME))
}

/** Removes what a dead smoke run left. Returns why it could not, or null. */
function macosRecover() {
  const file = exists(FILE)
  if (file.error) return file.error
  const leftovers = [...(exists(STAGE) === "present" ? [STAGE] : []), ...(file === "present" && plistMark(FILE) ? [FILE] : [])]
  if (leftovers.length === 0) return null
  const removed = sudo(["/bin/rm", "-f", ...leftovers])
  if (removed.status !== 0) return `could not remove ${leftovers.join(" and ")}, which a killed smoke run left: ${failed(removed)}. ${SUDO_HINT}`
  console.log(`Removed the ${NAME} policy a killed smoke run left in ${MANAGED}.`)
  return null
}

function macosChange(id) {
  if (macosManaged()) return {}
  if (sudo(["/usr/bin/true"]).status !== 0) return { error: SUDO_HINT }
  const file = exists(FILE)
  if (file.error) return { error: file.error }
  if (file === "present") {
    return { error: `${FILE} already exists and does not set ${NAME} to true. The smoke does not edit a configuration profile: add ${NAME} to it, or run the smoke on a Mac without it.` }
  }
  const folder = exists(MANAGED)
  if (folder.error) return { error: folder.error }
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
        // Written next to the target and renamed into place, so the policy file appears complete,
        // already carrying its mark. mv -n never replaces a file that appeared meanwhile.
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
      const leftovers = [STAGE, ...(plistMark(FILE) === id ? [FILE] : [])]
      const removed = sudo(["/bin/rm", "-f", ...leftovers])
      if (removed.status !== 0) return `${failed(removed)}. ${SUDO_HINT}`
      if (plistMark(FILE) === id) return `${FILE} is still there`
      // A folder this run created goes only when nothing else was put in it meanwhile.
      if (folder === "absent") sudo(["/bin/rmdir", MANAGED])
      return null
    },
  }
}

// ---------- Windows ----------

const KEY = "HKCU\\SOFTWARE\\Policies\\TenuVault"
const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32")
// By absolute path, as the app does, so a reg.exe or powershell.exe earlier on PATH is never run.
const reg = (args) => run(join(system32, "reg.exe"), args)

/**
 * Both policy keys, read through the registry API rather than reg.exe's localized messages:
 * { hklm, hkcu }, each null when the key is absent, else { values, subkeys, disable, kind, mark }.
 */
function windowsRead() {
  const script = `$ErrorActionPreference = 'Stop'
function Read-Key($path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $key = Get-Item -LiteralPath $path
  $names = @($key.GetValueNames())
  $kind = if ($names -contains '${NAME}') { [string]$key.GetValueKind('${NAME}') } else { $null }
  [pscustomobject]@{ values = $key.ValueCount; subkeys = $key.SubKeyCount; kind = $kind; disable = $key.GetValue('${NAME}', $null); mark = $key.GetValue('${MARK}', $null) }
}
[pscustomobject]@{ hklm = Read-Key 'HKLM:\\SOFTWARE\\Policies\\TenuVault'; hkcu = Read-Key 'HKCU:\\SOFTWARE\\Policies\\TenuVault' } | ConvertTo-Json -Compress -Depth 3`
  const result = run(join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
  if (result.status !== 0) return { error: `could not read the ${NAME} policy: ${failed(result)}` }
  try {
    return JSON.parse(result.stdout)
  } catch {
    return { error: `could not read the ${NAME} policy: ${result.stdout.trim()}` }
  }
}

const dwordOne = (key) => key?.kind === "DWord" && key.disable === 1

/** Deletes the values a smoke run added, then its mark, then the key if the run created it. Returns why it could not, or null. */
function windowsRemove(mark) {
  // The mark goes last: until the policy value is gone, it says who set it.
  reg(["delete", KEY, "/v", NAME, "/f"])
  reg(["delete", KEY, "/v", MARK, "/f"])
  const now = windowsRead()
  if (now.error) return now.error
  if (now.hkcu?.mark != null || now.hkcu?.kind) return `${KEY} still holds ${now.hkcu.kind ? NAME : MARK}`
  if (/;keyCreated$/.test(mark) && now.hkcu && now.hkcu.values === 0 && now.hkcu.subkeys === 0) {
    const removed = reg(["delete", KEY, "/f"])
    if (removed.status !== 0) return `could not remove ${KEY}, which the smoke run created: ${failed(removed)}`
  }
  return null
}

function windowsRecover() {
  const now = windowsRead()
  if (now.error) return now.error
  if (now.hkcu?.mark == null) return null
  const failure = windowsRemove(String(now.hkcu.mark))
  if (failure) return `could not remove the ${NAME} policy a killed smoke run left: ${failure}`
  console.log(`Removed the ${NAME} policy a killed smoke run left under ${KEY}.`)
  return null
}

function windowsChange(id) {
  const now = windowsRead()
  if (now.error) return { error: now.error }
  if (dwordOne(now.hklm) || dwordOne(now.hkcu)) return {}
  if (now.hkcu?.kind) {
    return { error: `${KEY} already has ${NAME} (${now.hkcu.kind} ${now.hkcu.disable}). The smoke does not edit a policy someone else set: set it to 1, or delete it.` }
  }
  const mark = `${id}${now.hkcu ? "" : ";keyCreated"}`
  return {
    apply() {
      // The mark first, so a run killed after it is found and cleaned up by the next one.
      for (const args of [["add", KEY, "/v", MARK, "/t", "REG_SZ", "/d", mark, "/f"], ["add", KEY, "/v", NAME, "/t", "REG_DWORD", "/d", "1", "/f"]]) {
        const result = reg(args)
        if (result.status !== 0) return failed(result)
      }
      return null
    },
    undo() {
      const current = windowsRead()
      if (current.error) return current.error
      if (current.hkcu?.mark !== mark) return current.hkcu?.mark == null ? null : `${KEY} carries another smoke run's mark`
      return windowsRemove(mark)
    },
  }
}

// ---------- Shared ----------

/**
 * Makes sure updates are off by policy. Resolves to { restore }, where restore() takes the policy
 * away again, is safe to call more than once and returns false when it could not, and { error } when
 * the policy could not be set. Call restore after an error too: a write that failed may still have
 * taken effect.
 */
export async function disableAutoUpdate(platform = process.platform) {
  const none = { restore: () => true }
  if (platform !== "darwin" && platform !== "win32") return none
  const held = await lock()
  if (held.error) return { error: held.error, ...none }
  const fail = (error) => {
    held.release()
    return { error, ...none }
  }
  const recovered = platform === "darwin" ? macosRecover() : windowsRecover()
  if (recovered) return fail(recovered)
  const id = `${process.pid}@${new Date().toISOString()}`
  const change = platform === "darwin" ? macosChange(id) : windowsChange(id)
  if (change.error) return fail(change.error)
  if (!change.apply) {
    held.release()
    return none
  }
  let result = null
  const restore = () => {
    if (result !== null) return result
    const failure = change.undo()
    if (failure) {
      // Left marked, so the next smoke run removes it.
      console.warn(`Could not remove the ${NAME} policy this smoke run set: ${failure}. The next smoke run removes it.`)
    } else {
      held.release()
    }
    result = !failure
    return result
  }
  const error = change.apply()
  return error ? { error, restore } : { restore }
}

