/**
 * Exercises scripts/smoke-update-policy.mjs against the real policy store of a CI runner: macOS
 * (needs passwordless sudo) and Windows. It refuses to run unless the store holds no TenuVault
 * policy, fails when it cannot read the store, and only ever removes what carries its own fixture
 * mark or the smoke run's mark.
 * Usage: node scripts/test-smoke-update-policy.mjs
 */
import { spawn, spawnSync } from "node:child_process"
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { createServer } from "node:net"
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
const SCRIPT = join(import.meta.dirname, "smoke-update-policy.mjs")
/** Registry values the test put in on Windows; cleanup removes only these and its fixture mark. */
const planted = new Set()
const holders = new Set()
let failures = 0

/**
 * Runs fn holding the smoke runs' lock (the loopback port 47319), so no smoke run is changing the
 * store while a fixture is put in or taken out. Throws when another run holds it.
 */
async function locked(fn) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(new Error(`a smoke run holds the policy lock, so the store was not touched: ${error.message}`)))
    server.listen({ port: 47319, host: "127.0.0.1", exclusive: true }, resolve)
  })
  try {
    return await fn()
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

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
function plant(target, body, mode = "644", { replacing = null } = {}) {
  // Only where nothing is yet, or over the given smoke run's own file: never over someone's profile.
  if (replacing) assert(run("/usr/bin/plutil", ["-extract", "TenuVaultSmokeRun", "raw", "-o", "-", target]).stdout?.trim() === replacing, `${target} is not the smoke run's own file`)
  else assert(!present(target), `${target} appeared, so the test does not plant over it`)
  const file = join(work, "plant.plist")
  writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${body}<key>${FIXTURE}</key><true/></dict></plist>\n`)
  assert(run("/usr/bin/plutil", ["-convert", "binary1", file]).status === 0, "could not convert the plist to binary")
  const folder = join(target, "..")
  assert(sudo(["/bin/mkdir", "-p", folder]).status === 0, `could not create ${folder}`)
  assert(sudo(["/usr/bin/install", "-m", mode, "-o", "root", "-g", "wheel", file, target]).status === 0, `could not install ${target}`)
}

/** A registry key in HKCU with the fixture mark and the given values. */
function plantKey(values) {
  for (const name of Object.keys(values)) planted.add(name)
  const lines = Object.entries(values).map(([name, [type, value]]) => `New-ItemProperty -LiteralPath '${HKCU}' -Name '${name}' -PropertyType ${type} -Value '${value}' | Out-Null`)
  const result = powershell([`New-Item -Path '${HKCU}' | Out-Null`, `New-ItemProperty -LiteralPath '${HKCU}' -Name '${FIXTURE}' -PropertyType DWord -Value 1 | Out-Null`, ...lines].join("\n"))
  assert(result.status === 0, `could not create the fixture key: ${result.stderr}`)
}

/**
 * Removes what the tests left: a smoke run's mark through --clean, with the harness's own rules,
 * then, holding the lock, only the fixtures the test planted. Anything else stays.
 */
async function clear() {
  const cleaned = run(process.execPath, [SCRIPT, "--clean"])
  if (cleaned.status !== 0) console.log(`--clean during cleanup: ${(cleaned.stderr || cleaned.stdout).trim()}`)
  await locked(clearFixtures)
}
function clearFixtures() {
  if (platform === "darwin") {
    // A fixture file is the test's own whole file; one without the fixture mark is not.
    for (const path of [FILE, USER_FILE, STAGE]) {
      if (present(path) && sudo(["/usr/bin/plutil", "-extract", FIXTURE, "xml1", "-o", "-", path]).status === 0) sudo(["/bin/rm", "-f", path])
    }
    return
  }
  const names = [FIXTURE, ...planted].map((name) => `'${name}'`).join(", ")
  powershell(`$key = Get-Item -LiteralPath '${HKCU}' -ErrorAction SilentlyContinue
if ($null -eq $key -or $null -eq $key.GetValue('${FIXTURE}', $null)) { return }
foreach ($name in @(${names})) { Remove-ItemProperty -LiteralPath '${HKCU}' -Name $name -ErrorAction SilentlyContinue }
$key = Get-Item -LiteralPath '${HKCU}'
if ($key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0) { Remove-Item -LiteralPath '${HKCU}' }`)
  planted.clear()
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
  try {
    assert(expected.test(result.error ?? ""), `the harness did not refuse: ${result.error}`)
  } finally {
    assert(result.restore(), "restore after a refusal reported a failure")
  }
  assert(snapshot() === before, "the refused run changed the store")
}

/** The smoke run's mark in the store now. */
const currentMark = () =>
  platform === "darwin"
    ? run("/usr/bin/plutil", ["-extract", "TenuVaultSmokeRun", "raw", "-o", "-", FILE]).stdout?.trim()
    : powershell(`(Get-ItemProperty -LiteralPath '${HKCU}').TenuVaultSmokeRun`).stdout?.trim()

if (snapshot() !== null) {
  console.log("This test needs a store without any TenuVault policy; it found one and changed nothing.")
  process.exit(1)
}

try {
  await check("sets a marked policy and leaves the store empty again", roundTrip)

  await check("refuses to edit a policy it did not write, and leaves it byte for byte", async () => {
    try {
      // A root-only binary profile on macOS, a value of 0 on Windows.
      await locked(() => (platform === "darwin" ? plant(FILE, "<key>DisableAutoUpdate</key><false/><key>Other</key><string>kept</string>", "600") : plantKey({ DisableAutoUpdate: ["DWord", 0] })))
      await refuses(/does not edit/)
    } finally {
      await clear()
    }
  })

  await check("refuses when another policy for TenuVault applies, even where it would not write", async () => {
    try {
      // A user profile that leaves updates on (macOS); a key with another policy only (Windows).
      await locked(() => (platform === "darwin" ? plant(USER_FILE, "<key>DisableAutoUpdate</key><false/>") : plantKey({ DisableSetupDiagnostics: ["DWord", 1] })))
      await refuses(/does not edit/)
    } finally {
      await clear()
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

  await check("leaves a policy that replaced the smoke run's during the run", async () => {
    let result = null
    try {
      result = await disableAutoUpdate()
      assert(!result.error, result.error)
      const mark = currentMark()
      assert(/^\d+@/.test(mark ?? ""), "the run's policy carries no mark")
      // A profile replaces the file, or Group Policy sets the value to 0 next to the smoke's mark.
      if (platform === "darwin") plant(FILE, "<key>DisableAutoUpdate</key><false/>", "644", { replacing: mark })
      else {
        planted.add("DisableAutoUpdate")
        assert(powershell(`Set-ItemProperty -LiteralPath '${HKCU}' -Name DisableAutoUpdate -Value 0\nNew-ItemProperty -LiteralPath '${HKCU}' -Name '${FIXTURE}' -PropertyType DWord -Value 1 | Out-Null`).status === 0, "could not replace the value")
      }
      const replaced = snapshot()
      assert(result.restore(), "restore reported a failure")
      result = null
      const after = snapshot()
      if (platform === "darwin") assert(after === replaced, "the restore changed the replacing profile")
      else {
        assert(/DisableAutoUpdate=DWord:0/.test(after ?? ""), `the replacing value is gone: ${after}`)
        assert(!/TenuVaultSmokeRun/.test(after ?? ""), "the smoke mark was left")
      }
    } finally {
      result?.restore()
      await clear()
    }
  })

  // What a kill partway through a write leaves. macOS: the staged file, not yet renamed. Windows:
  // the key with the mark but not the value, or the key alone. --clean must remove each of them.
  const halfway = platform === "darwin"
    ? { "the staged file": () => plant(STAGE, "<key>DisableAutoUpdate</key><true/><key>TenuVaultSmokeRun</key><string>1@x</string>") }
    : {
        "the mark without the value": () => assert(powershell(`New-Item -Path '${HKCU}' | Out-Null\nNew-ItemProperty -LiteralPath '${HKCU}' -Name TenuVaultSmokeRun -PropertyType String -Value '1@x' | Out-Null`).status === 0, "could not plant the mark"),
        "an empty key": () => assert(powershell(`New-Item -Path '${HKCU}' | Out-Null`).status === 0, "could not create the key"),
      }
  for (const [left, put] of Object.entries(halfway)) {
    await check(`--clean removes ${left} a run killed halfway through its write left`, async () => {
      try {
        await locked(put)
        assert(snapshot() !== null, "nothing was planted")
        const cleaned = run(process.execPath, [SCRIPT, "--clean"])
        assert(cleaned.status === 0, `--clean failed: ${cleaned.stderr || cleaned.stdout}`)
        assert(snapshot() === null, `--clean left ${left}`)
        await roundTrip()
      } finally {
        await clear()
      }
    })
  }

  await check("changes nothing when a policy already turns updates off, and holds the lock until it ends", async () => {
    let result = null
    try {
      await locked(() => (platform === "darwin" ? plant(FILE, "<key>DisableAutoUpdate</key><true/>") : plantKey({ DisableAutoUpdate: ["DWord", 1] })))
      const before = snapshot()
      result = await disableAutoUpdate()
      assert(!result.error, result.error)
      assert(snapshot() === before, "the run changed a policy that already turned updates off")
      const second = await disableAutoUpdate()
      second.restore()
      assert(/another smoke run/.test(second.error ?? ""), `a second run did not wait for the lock: ${second.error}`)
      assert(result.restore(), "restore reported a failure")
      result = null
      assert(snapshot() === before, "the restore changed the existing policy")
    } finally {
      result?.restore()
      await clear()
    }
  })

  await check("--clean waits while the app of a killed smoke run still runs", async () => {
    const child = await holder()
    await kill(child)
    assert(managed(), "the killed holder took the policy away, so the test proves nothing")
    // Stands in for the packaged app the killed run started: same profile folder argument.
    const app = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)", "--", `--user-data-dir=${join(work, "tenuvault-smoke-app")}`], { stdio: "ignore" })
    holders.add(app)
    app.on("exit", () => holders.delete(app))
    const appExited = new Promise((resolve) => app.once("exit", resolve))
    const cleaning = spawn(process.execPath, [SCRIPT, "--clean"], { stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    cleaning.stdout.on("data", (data) => (output += data))
    cleaning.stderr.on("data", (data) => (output += data))
    const cleaned = new Promise((resolve) => cleaning.once("exit", resolve))
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert(managed(), "--clean removed the policy while the app was still running")
    await appExited
    assert((await cleaned) === 0, `--clean failed: ${output}`)
    assert(snapshot() === null, "--clean left the policy after the app quit")
  })

  await check("--clean refuses while a run holds the policy", async () => {
    const child = await holder()
    try {
      const during = snapshot()
      const cleaned = run(process.execPath, [SCRIPT, "--clean"])
      assert(cleaned.status === 1 && /another smoke run/.test(cleaned.stderr), `--clean did not refuse: ${cleaned.status} ${cleaned.stderr || cleaned.stdout}`)
      assert(snapshot() === during, "--clean changed the live run's policy")
    } finally {
      await kill(child)
      await clear()
    }
    assert(snapshot() === null, "the killed holder's policy was not removed")
  })

  await check("--clean removes what a killed run left, also through a symlinked path", async () => {
    const child = await holder()
    await kill(child)
    assert(managed(), "the killed holder took the policy away, so the test proves nothing")
    let script = join(work, "linked-smoke-update-policy.mjs")
    try {
      symlinkSync(SCRIPT, script)
    } catch (error) {
      // Windows allows symlinks only with a privilege or developer mode.
      console.log(`     no symlink (${error.code}), --clean runs from its own path`)
      script = SCRIPT
    }
    const cleaned = run(process.execPath, [script, "--clean"])
    assert(cleaned.status === 0 && /No smoke run's update policy is left/.test(cleaned.stdout), `--clean failed: ${cleaned.stderr || cleaned.stdout}`)
    assert(snapshot() === null, "--clean left the policy")
  })
} finally {
  for (const child of holders) await kill(child)
  await clear().catch((error) => console.log(`Cleanup skipped: ${error.message}`))
  rmSync(work, { recursive: true, force: true })
}

if (failures) {
  console.log(`${failures} failed`)
  process.exit(1)
}
console.log("All smoke update policy tests passed.")
