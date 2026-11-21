/**
 * Exercises scripts/smoke-update-policy.mjs against the real policy store of a CI runner: macOS
 * (needs passwordless sudo) and Windows. It needs a store without any TenuVault policy and refuses
 * to run otherwise, so it can only ever remove what it created itself.
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
const STAGE = `${FOLDER}/.com.tenuvault.desktop.smoke.plist`
const KEY = "HKCU\\SOFTWARE\\Policies\\TenuVault"
const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe")
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options })
const sudo = (args, options) => run("/usr/bin/sudo", ["-n", ...args], options)
const work = mkdtempSync(join(tmpdir(), "tenuvault-policy-test-"))
const holders = new Set()
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

/** The TenuVault policy the store holds now, exactly, or null when it holds none. */
function snapshot() {
  if (platform === "darwin") {
    const file = sudo(["/bin/cat", FILE], { encoding: "buffer" })
    const stage = sudo(["/bin/test", "-e", STAGE]).status === 0
    const stat = sudo(["/usr/bin/stat", "-f", "%Lp %u %g", FILE])
    if (file.status !== 0 && !stage) return null
    return JSON.stringify({ bytes: file.status === 0 ? file.stdout.toString("base64") : null, stat: stat.stdout?.trim(), stage })
  }
  const query = run(reg, ["query", KEY, "/s"])
  return query.status === 0 ? query.stdout.trim() : null
}

function managed() {
  if (platform === "darwin") return run("/usr/bin/plutil", ["-extract", "DisableAutoUpdate", "raw", "-expect", "bool", "-o", "-", FILE]).stdout?.trim() === "true"
  return /DisableAutoUpdate\s+REG_DWORD\s+0x0*1\b/i.test(run(reg, ["query", KEY, "/v", "DisableAutoUpdate"]).stdout ?? "")
}

/** Puts a file or registry value into the store as root or the user would, from the given source. */
function plant(target, body, mode = "644") {
  const file = join(work, "plant.plist")
  writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${body}</dict></plist>\n`)
  assert(run("/usr/bin/plutil", ["-convert", "binary1", file]).status === 0, "could not convert the plist to binary")
  assert(sudo(["/bin/mkdir", "-p", FOLDER]).status === 0, "could not create the managed preferences folder")
  assert(sudo(["/usr/bin/install", "-m", mode, "-o", "root", "-g", "wheel", file, target]).status === 0, `could not install ${target}`)
}

/** Removes everything a test may have put in the store. Safe only because the store started empty. */
function clear() {
  if (platform === "darwin") sudo(["/bin/rm", "-f", FILE, STAGE])
  else run(reg, ["delete", KEY, "/f"])
}

/** A smoke run in its own process that sets the policy and waits to be killed. */
function holder() {
  const code = `const m = await import(${JSON.stringify(MODULE)}); const r = await m.disableAutoUpdate(); if (r.error) { console.error(r.error); process.exit(2) } console.log("ready"); setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] })
  holders.add(child)
  child.on("exit", () => holders.delete(child))
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (data) => String(data).includes("ready") && resolve(child))
    child.on("exit", (status) => reject(new Error(`the holder exited with ${status} before it was ready`)))
  })
}

async function kill(child) {
  const exited = new Promise((resolve) => child.once("exit", resolve))
  child.kill("SIGKILL")
  await exited
}

/** One full run: sets the policy, checks it, takes it away and checks the store is empty again. */
async function roundTrip() {
  const result = await disableAutoUpdate()
  try {
    assert(!result.error, result.error)
    assert(managed(), "the policy is not on during the run")
  } finally {
    assert(result.restore(), "restore reported a failure")
  }
  assert(result.restore(), "a second restore reported a failure")
  assert(snapshot() === null, "the store is not empty after the restore")
}

const folderAtStart = platform === "darwin" && sudo(["/bin/test", "-d", FOLDER]).status === 0
if (snapshot() !== null) {
  console.log(`This test needs a store without a TenuVault policy (${platform === "darwin" ? FILE : KEY}); it found one and changed nothing.`)
  process.exit(1)
}

try {
  await check("sets the policy, marked as a smoke run's, and leaves the store empty again", async () => {
    const result = await disableAutoUpdate()
    try {
      assert(!result.error, result.error)
      assert(managed(), "the policy is not on during the run")
      if (platform === "darwin") {
        assert(sudo(["/usr/bin/stat", "-f", "%Lp %u %g", FILE]).stdout?.trim() === "644 0 0", "the policy file is not 644 root:wheel")
        assert(/^\d+@/.test(run("/usr/bin/plutil", ["-extract", "TenuVaultSmokeRun", "raw", "-o", "-", FILE]).stdout ?? ""), "the policy file carries no smoke mark")
      } else {
        assert(/TenuVaultSmokeRun\s+REG_SZ\s+\d+@/.test(run(reg, ["query", KEY, "/v", "TenuVaultSmokeRun"]).stdout ?? ""), "the key carries no smoke mark")
      }
    } finally {
      assert(result.restore(), "restore reported a failure")
    }
    assert(snapshot() === null, "the store is not empty after the restore")
  })

  await check("refuses to edit a policy it did not write, and leaves it byte for byte", async () => {
    try {
      // A root-only binary profile on macOS, a value of 0 on Windows.
      if (platform === "darwin") plant(FILE, "<key>DisableAutoUpdate</key><false/><key>Other</key><string>kept</string>", "600")
      else assert(run(reg, ["add", KEY, "/v", "DisableAutoUpdate", "/t", "REG_DWORD", "/d", "0", "/f"]).status === 0, "could not seed the value")
      const before = snapshot()
      const result = await disableAutoUpdate()
      assert(/does not edit/.test(result.error ?? ""), `the harness did not refuse: ${result.error}`)
      assert(result.restore(), "restore after a refusal reported a failure")
      assert(snapshot() === before, "the refused run changed the store")
    } finally {
      clear()
    }
  })

  await check("refuses while another run holds the policy, and removes what a killed run left", async () => {
    const child = await holder()
    try {
      assert(managed(), "the holder did not set the policy")
      const during = snapshot()
      const second = await disableAutoUpdate()
      assert(/another smoke run/.test(second.error ?? ""), `a second run did not refuse: ${second.error}`)
      assert(snapshot() === during, "the refused run changed the store")
    } finally {
      await kill(child)
    }
    assert(managed(), "the killed holder took the policy away, so the test proves nothing")
    await roundTrip()
  })

  await check("removes a mark a run killed halfway through its write left", async () => {
    try {
      // What a kill between the two writes leaves: macOS, the staged file not yet renamed;
      // Windows, the mark without the policy value, in a key the run created.
      if (platform === "darwin") plant(STAGE, "<key>DisableAutoUpdate</key><true/><key>TenuVaultSmokeRun</key><string>1@x</string>")
      else assert(run(reg, ["add", KEY, "/v", "TenuVaultSmokeRun", "/t", "REG_SZ", "/d", "1@x;keyCreated", "/f"]).status === 0, "could not seed the mark")
      await roundTrip()
    } finally {
      clear()
    }
  })
} finally {
  for (const child of holders) await kill(child)
  if (snapshot() !== null) {
    console.log("Removing a policy the tests left.")
    clear()
  }
  // rmdir removes the folder only when it is empty.
  if (platform === "darwin" && !folderAtStart) sudo(["/bin/rmdir", FOLDER])
  rmSync(work, { recursive: true, force: true })
}

if (failures) {
  console.log(`${failures} failed`)
  process.exit(1)
}
console.log("All smoke update policy tests passed.")
