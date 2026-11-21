/**
 * Exercises scripts/smoke-update-policy.mjs against the real policy store of a CI runner: macOS
 * (needs passwordless sudo) and Windows. It sets the policy and puts back the earlier state byte for
 * byte, keeps the other keys of an existing file or registry key, refuses to touch the state while
 * the run that set it is alive, and restores what a run killed with SIGKILL left behind.
 * Usage: node scripts/test-smoke-update-policy.mjs
 */
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { disableAutoUpdate } from "./smoke-update-policy.mjs"

const platform = process.platform
if (platform !== "darwin" && platform !== "win32") {
  console.log("Nothing to test: the smoke changes no policy on this platform.")
  process.exit(0)
}

const MODULE = pathToFileURL(join(import.meta.dirname, "smoke-update-policy.mjs")).href
const FOLDER = "/Library/Managed Preferences"
const FILE = `${FOLDER}/com.tenuvault.desktop.plist`
const KEY = "HKCU\\SOFTWARE\\Policies\\TenuVault"
const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe")
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options })
const sudo = (args, options) => run("/usr/bin/sudo", ["-n", ...args], options)
const work = mkdtempSync(join(tmpdir(), "tenuvault-policy-test-"))
const state = join(work, "state")
let failures = 0

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function check(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

/** What the policy store holds now, compared exactly. */
function snapshot() {
  if (platform === "darwin") {
    const folder = sudo(["/bin/test", "-d", FOLDER]).status === 0
    const file = sudo(["/bin/cat", FILE], { encoding: "buffer" })
    const stat = sudo(["/usr/bin/stat", "-f", "%Lp %u %g", FILE])
    return JSON.stringify({ folder, bytes: file.status === 0 ? file.stdout.toString("base64") : null, stat: stat.status === 0 ? stat.stdout.trim() : null })
  }
  const query = run(reg, ["query", KEY, "/s"])
  return query.status === 0 ? query.stdout.trim() : null
}

function managed() {
  if (platform === "darwin") return run("/usr/bin/plutil", ["-extract", "DisableAutoUpdate", "raw", "-o", "-", FILE]).stdout?.trim() === "true"
  return /DisableAutoUpdate\s+REG_DWORD\s+0x0*1\b/i.test(run(reg, ["query", KEY, "/v", "DisableAutoUpdate"]).stdout ?? "")
}

/** Seeds an existing policy store with another key and DisableAutoUpdate off. */
function seed() {
  if (platform === "darwin") {
    const file = join(work, "seed.plist")
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>DisableAutoUpdate</key><false/><key>Other</key><string>kept</string></dict></plist>\n`)
    assert(run("/usr/bin/plutil", ["-convert", "binary1", file]).status === 0, "could not convert the seed to a binary plist")
    assert(sudo(["/bin/mkdir", "-p", FOLDER]).status === 0, "could not create the managed preferences folder")
    assert(sudo(["/usr/bin/install", "-m", "600", "-o", "root", "-g", "wheel", file, FILE]).status === 0, "could not install the seed")
    // Only root can read it, so the app would not see it: the harness has to make its copy readable.
    return
  }
  assert(run(reg, ["add", KEY, "/v", "DisableAutoUpdate", "/t", "REG_DWORD", "/d", "0", "/f"]).status === 0, "could not seed DisableAutoUpdate")
  assert(run(reg, ["add", KEY, "/v", "Other", "/t", "REG_SZ", "/d", "kept", "/f"]).status === 0, "could not seed Other")
}

function unseed() {
  if (platform === "darwin") {
    sudo(["/bin/rm", "-f", FILE])
    sudo(["/bin/rmdir", FOLDER])
  } else run(reg, ["delete", KEY, "/f"])
}

/** A smoke run in its own process that sets the policy and waits to be killed. */
function holder() {
  const code = `import(${JSON.stringify(MODULE)}).then((m) => { const r = m.disableAutoUpdate(process.platform, ${JSON.stringify(state)}); if (r.error) { console.error(r.error); process.exit(2) } console.log("ready"); setInterval(() => {}, 1000) })`
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] })
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (data) => String(data).includes("ready") && resolve(child))
    child.on("exit", (status) => reject(new Error(`the holder exited with ${status} before it was ready`)))
  })
}

const original = snapshot()
console.log(`Policy store before the tests: ${original === null || original.includes('"bytes":null') ? "no TenuVault policy" : "a TenuVault policy exists"}`)
assert(!managed(), "DisableAutoUpdate is already on, so the harness would change nothing; run this on a runner without the policy")

try {
  await check("sets the policy and puts back the absent state", async () => {
    const result = disableAutoUpdate(platform, state)
    assert(!result.error, result.error)
    assert(managed(), "the policy is not on during the run")
    result.restore()
    result.restore()
    assert(snapshot() === original, "the state after the restore differs from the state before")
  })

  await check("keeps the other keys and restores an existing file or key byte for byte", async () => {
    seed()
    const before = snapshot()
    const result = disableAutoUpdate(platform, state)
    assert(!result.error, result.error)
    assert(managed(), "the policy is not on during the run")
    if (platform === "darwin") {
      const other = sudo(["/usr/bin/plutil", "-extract", "Other", "raw", "-o", "-", FILE]).stdout?.trim()
      assert(other === "kept", `the other key became ${other}`)
    } else {
      assert(/Other\s+REG_SZ\s+kept/.test(run(reg, ["query", KEY, "/v", "Other"]).stdout ?? ""), "the other value was lost")
    }
    result.restore()
    assert(snapshot() === before, "the restored file or key differs from the seeded one")
    unseed()
    assert(snapshot() === original, "the seed was not removed")
  })

  await check("refuses while the run that set the policy is alive, and restores after it was killed", async () => {
    const child = await holder()
    assert(managed(), "the holder did not set the policy")
    const during = disableAutoUpdate(platform, state)
    assert(/still holds/.test(during.error ?? ""), `a second run did not refuse: ${during.error}`)
    assert(managed(), "the refused run changed the policy")
    const exited = new Promise((resolve) => child.on("exit", resolve))
    child.kill("SIGKILL")
    await exited
    assert(managed(), "the killed holder restored anyway, so the test proves nothing")
    const next = disableAutoUpdate(platform, state)
    assert(!next.error, next.error)
    assert(managed(), "the next run did not set the policy")
    next.restore()
    assert(snapshot() === original, "the state after recovery and restore differs from the state before")
  })
} finally {
  if (snapshot() !== original) {
    console.log("Cleaning up a policy the tests left.")
    if (original === null || original.includes('"bytes":null')) unseed()
  }
  rmSync(work, { recursive: true, force: true })
}

if (failures) {
  console.log(`${failures} failed`)
  process.exit(1)
}
console.log("All smoke update policy tests passed.")
