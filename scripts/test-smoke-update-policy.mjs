/**
 * Exercises scripts/smoke-update-policy.mjs against the real policy store of a CI runner: macOS
 * (needs passwordless sudo) and Windows. It refuses to run unless the store holds no TenuVault
 * policy, fails when it cannot read the store, and only ever removes what carries its own fixture
 * mark or the smoke run's mark.
 * Usage: node scripts/test-smoke-update-policy.mjs
 */
import { spawn, spawnSync } from "node:child_process"
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { disableAutoUpdate } from "./smoke-update-policy.mjs"

const platform = process.platform
if (platform !== "darwin" && platform !== "win32") {
  console.log("Nothing to test: the smoke changes no policy on this platform.")
  process.exit(0)
}

const MODULE = pathToFileURL(join(import.meta.dirname, "smoke-update-policy.mjs")).href
const FIXTURE = "TenuVaultPolicyTestFixture"
const FOLDER = "/Library/Managed Preferences"
const FILE = `${FOLDER}/com.tenuvault.desktop.plist`
const USER_FILE = `${FOLDER}/${userInfo().username}/com.tenuvault.desktop.plist`
const STAGE = `${FOLDER}/.com.tenuvault.desktop.smoke.plist`
const HKCU = "HKCU:\\SOFTWARE\\Policies\\TenuVault"
const HKLM = "HKLM:\\SOFTWARE\\Policies\\TenuVault"
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options })
const sudo = (args, options) => run("/usr/bin/sudo", ["-n", ...args], options)
const powershell = (script) => run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'\n${script}`])
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

const present = (path) => {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw new Error(`could not check ${path}: ${error.message}`)
  }
}

/** Everything the store holds for TenuVault, exactly; null when it holds nothing. Throws when it cannot tell. */
function snapshot() {
  if (platform === "darwin") {
    const state = {}
    for (const path of [FILE, USER_FILE, STAGE]) {
      if (!present(path)) continue
      const bytes = sudo(["/bin/cat", path], { encoding: "buffer" })
      const stat = sudo(["/usr/bin/stat", "-f", "%Lp %u %g", path])
      if (bytes.status !== 0 || stat.status !== 0) throw new Error(`could not read ${path} with sudo`)
      state[path] = `${stat.stdout.trim()} ${bytes.stdout.toString("base64")}`
    }
    return Object.keys(state).length ? JSON.stringify(state) : null
  }
  const result = powershell(`$out = foreach ($path in ${`'${HKLM}', '${HKCU}'`}) {
  if (Test-Path -LiteralPath $path) {
    $key = Get-Item -LiteralPath $path
    "$path|$($key.SubKeyCount)|" + (($key.GetValueNames() | Sort-Object | ForEach-Object { "$_=$($key.GetValueKind($_)):$($key.GetValue($_))" }) -join ';')
  }
}
$out -join [Environment]::NewLine`)
  if (result.status !== 0) throw new Error(`could not read the policy keys: ${result.stderr}`)
  return result.stdout.trim() || null
}

function managed() {
  if (platform === "darwin") return run("/usr/bin/plutil", ["-extract", "DisableAutoUpdate", "raw", "-expect", "bool", "-o", "-", FILE]).stdout?.trim() === "true"
  const result = powershell(`(Get-ItemProperty -LiteralPath '${HKCU}' -Name DisableAutoUpdate -ErrorAction SilentlyContinue).DisableAutoUpdate`)
  return result.stdout.trim() === "1"
}

/** Puts a binary plist into the store as root, with the fixture mark unless it is a smoke run's. */
function plant(target, body, mode = "644") {
  const file = join(work, "plant.plist")
  writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${body}<key>${FIXTURE}</key><true/></dict></plist>\n`)
  assert(run("/usr/bin/plutil", ["-convert", "binary1", file]).status === 0, "could not convert the plist to binary")
  const folder = join(target, "..")
  assert(sudo(["/bin/mkdir", "-p", folder]).status === 0, `could not create ${folder}`)
  assert(sudo(["/usr/bin/install", "-m", mode, "-o", "root", "-g", "wheel", file, target]).status === 0, `could not install ${target}`)
}

/** A registry key in HKCU with the fixture mark and the given values. */
function plantKey(values) {
  const lines = Object.entries(values).map(([name, [type, value]]) => `New-ItemProperty -LiteralPath '${HKCU}' -Name '${name}' -PropertyType ${type} -Value '${value}' | Out-Null`)
  const result = powershell([`New-Item -Path '${HKCU}' | Out-Null`, `New-ItemProperty -LiteralPath '${HKCU}' -Name '${FIXTURE}' -PropertyType DWord -Value 1 | Out-Null`, ...lines].join("\n"))
  assert(result.status === 0, `could not create the fixture key: ${result.stderr}`)
}

/** Removes only what carries the fixture mark or a smoke run's mark. */
function clear() {
  if (platform === "darwin") {
    for (const path of [FILE, USER_FILE, STAGE]) {
      if (!present(path)) continue
      const marked = ["TenuVaultSmokeRun", FIXTURE].some((key) => sudo(["/usr/bin/plutil", "-extract", key, "xml1", "-o", "/dev/null", path]).status === 0)
      if (marked) sudo(["/bin/rm", "-f", path])
    }
    return
  }
  powershell(`$key = Get-Item -LiteralPath '${HKCU}' -ErrorAction SilentlyContinue
if ($null -ne $key -and ($null -ne $key.GetValue('${FIXTURE}', $null) -or $null -ne $key.GetValue('TenuVaultSmokeRun', $null))) { Remove-Item -LiteralPath '${HKCU}' -Recurse }`)
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

/** One full run: sets the policy, checks it is marked, takes it away and checks the store is empty. */
async function roundTrip() {
  const result = await disableAutoUpdate()
  try {
    assert(!result.error, result.error)
    assert(managed(), "the policy is not on during the run")
    if (platform === "darwin") {
      assert(sudo(["/usr/bin/stat", "-f", "%Lp %u %g", FILE]).stdout?.trim() === "644 0 0", "the policy file is not 644 root:wheel")
      assert(/^\d+@/.test(run("/usr/bin/plutil", ["-extract", "TenuVaultSmokeRun", "raw", "-o", "-", FILE]).stdout ?? ""), "the policy file carries no smoke mark")
    } else {
      assert(/^\d+@/.test(powershell(`(Get-ItemProperty -LiteralPath '${HKCU}').TenuVaultSmokeRun`).stdout ?? ""), "the key carries no smoke mark")
    }
  } finally {
    assert(result.restore(), "restore reported a failure")
  }
  assert(result.restore(), "a second restore reported a failure")
  assert(snapshot() === null, "the store is not empty after the restore")
}

/** The harness must refuse and leave the planted store exactly as it was. */
async function refuses(expected) {
  const before = snapshot()
  assert(before !== null, "nothing was planted")
  const result = await disableAutoUpdate()
  assert(expected.test(result.error ?? ""), `the harness did not refuse: ${result.error}`)
  assert(result.restore(), "restore after a refusal reported a failure")
  assert(snapshot() === before, "the refused run changed the store")
}

if (snapshot() !== null) {
  console.log("This test needs a store without any TenuVault policy; it found one and changed nothing.")
  process.exit(1)
}

try {
  await check("sets a marked policy and leaves the store empty again", roundTrip)

  await check("refuses to edit a policy it did not write, and leaves it byte for byte", async () => {
    try {
      // A root-only binary profile on macOS, a value of 0 on Windows.
      if (platform === "darwin") plant(FILE, "<key>DisableAutoUpdate</key><false/><key>Other</key><string>kept</string>", "600")
      else plantKey({ DisableAutoUpdate: ["DWord", 0] })
      await refuses(/does not edit/)
    } finally {
      clear()
    }
  })

  await check("refuses when another policy for TenuVault applies, even where it would not write", async () => {
    try {
      // A user profile that leaves updates on (macOS); a key with another policy only (Windows).
      if (platform === "darwin") plant(USER_FILE, "<key>DisableAutoUpdate</key><false/>")
      else plantKey({ DisableSetupDiagnostics: ["DWord", 1] })
      await refuses(/does not edit/)
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

  await check("removes what a run killed halfway through its write left", async () => {
    try {
      // macOS: the staged file, not yet renamed. Windows: the key with the mark but not the value.
      if (platform === "darwin") plant(STAGE, "<key>DisableAutoUpdate</key><true/><key>TenuVaultSmokeRun</key><string>1@x</string>")
      else {
        const result = powershell(`New-Item -Path '${HKCU}' | Out-Null\nNew-ItemProperty -LiteralPath '${HKCU}' -Name TenuVaultSmokeRun -PropertyType String -Value '1@x' | Out-Null`)
        assert(result.status === 0, `could not plant the mark: ${result.stderr}`)
      }
      await roundTrip()
    } finally {
      clear()
    }
  })

  await check("--clean removes what a killed run left", async () => {
    const child = await holder()
    await kill(child)
    assert(managed(), "the killed holder took the policy away, so the test proves nothing")
    const cleaned = run(process.execPath, [join(import.meta.dirname, "smoke-update-policy.mjs"), "--clean"])
    assert(cleaned.status === 0, `--clean failed: ${cleaned.stderr || cleaned.stdout}`)
    assert(snapshot() === null, "--clean left the policy")
  })
} finally {
  for (const child of holders) await kill(child)
  clear()
  rmSync(work, { recursive: true, force: true })
}

if (failures) {
  console.log(`${failures} failed`)
  process.exit(1)
}
console.log("All smoke update policy tests passed.")
