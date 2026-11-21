/**
 * The changes the sign-in test makes to the CI runner, the way an administrator of the machine
 * could, without telling the app: hosts file entries that send login.microsoftonline.com and
 * the licensing host to the local stand-in, and a throwaway root certificate in the operating
 * system's trust store that the stand-in's certificate chains to. The app keeps its own
 * authority, redirect, browser opener and certificate checks.
 *
 * - Linux: /etc/hosts, the NSS database in ~/.pki/nssdb (what Chromium on Linux trusts) and the
 *   system bundle (update-ca-certificates), and port 443 opened to unprivileged processes so the
 *   stand-in can listen on it. Needs sudo and certutil (libnss3-tools).
 * - macOS: /etc/hosts and the System keychain as a trusted root, and a disposable unlocked login
 *   keychain for the app's secrets (the runner's own login keychain can be locked). Needs sudo.
 * - Windows: the hosts file and the LocalMachine Root store. Needs an elevated shell.
 *
 * Every change is recorded in a state file before it is made, so `cleanup` can undo a setup that
 * stopped halfway. `cleanup` is idempotent and also runs on its own, from a workflow step that
 * runs even when the test step was cancelled or timed out:
 *
 *   node scripts/sign-in-e2e/runner.mjs cleanup
 *
 * It then reads the machine back and exits 1 when a hosts entry, the root certificate or the
 * macOS keychain setting is still there, or when a store could not be inspected. Only a store
 * listing that succeeded counts as "the root is gone"; a query that fails, times out or finds no
 * store keeps the recovery state for the next cleanup. These are changes to the whole machine: run this only on a throwaway CI runner.
 */
import { execFileSync } from "node:child_process"
import { X509Certificate } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { LICENSE_HOST, LOGIN_HOST } from "./stand-in.mjs"

import { BLOB_HOST, GRAPH_HOST } from "./approvals-stand-in.mjs"

export const HOSTS_NAMES = [LOGIN_HOST, LICENSE_HOST, GRAPH_HOST, BLOB_HOST]
const MARKER = "# tenuvault-sign-in-e2e"
export const CA_NAME = "TenuVault sign-in e2e test root"

/** The real machine. Tests pass their own, with a fake `exec` and a hosts file of their own. */
export function realSystem() {
  return {
    platform: process.platform,
    hostsPath: process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts") : "/etc/hosts",
    // RUNNER_TEMP is the same for every step of a job, so the cleanup step finds the state.
    stateDir: join(process.env.RUNNER_TEMP ?? tmpdir(), "tenuvault-sign-in-e2e"),
    home: homedir(),
    portStartPath: "/proc/sys/net/ipv4/ip_unprivileged_port_start",
    // The root's source file for update-ca-certificates, and the bundle it generates.
    bundleSource: "/usr/local/share/ca-certificates/tenuvault-sign-in-e2e.crt",
    bundleOutput: "/etc/ssl/certs/ca-certificates.crt",
    systemKeychain: "/Library/Keychains/System.keychain",
    // A command that waits for a prompt nobody can answer fails instead of holding the job.
    exec: (command, args) => execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 60_000 }),
  }
}

const stateFile = (system) => join(system.stateDir, "state.json")
const readState = (system) => {
  try { return JSON.parse(readFileSync(stateFile(system), "utf8")) } catch { return {} }
}
const saveState = (system, state) => {
  mkdirSync(system.stateDir, { recursive: true })
  writeFileSync(stateFile(system), JSON.stringify(state, null, 2))
}
const sudo = (system, command, args) => system.exec("sudo", ["-n", command, ...args])
const nssdb = (system) => `sql:${join(system.home, ".pki", "nssdb")}`
const eol = (system) => (system.platform === "win32" ? "\r\n" : "\n")

/** A store could not be read, so whether the root is still in it is unknown. */
export class InspectionError extends Error {}

const firstLine = (error) => String(error.stderr || error.message).trim().split(/\r?\n/)[0]
const query = (system, what, command, args) => {
  try { return String(system.exec(command, args)) } catch (error) {
    throw new InspectionError(`could not inspect ${what}: ${firstLine(error)}`)
  }
}

/** A fingerprint as uppercase hex without separators. */
const hex = (value) => String(value).replace(/[^0-9a-f]/gi, "").toUpperCase()
const fingerprints = (pem) => {
  const certificate = new X509Certificate(pem)
  return { caSha1: hex(certificate.fingerprint), caSha256: hex(certificate.fingerprint256) }
}
/** Whether a store listing names the root or shows one of its fingerprints on a line. */
const mentions = (text, state) => text.includes(CA_NAME) ||
  text.split(/\r?\n/).some((line) => [state.caSha1, state.caSha256].some((fingerprint) => fingerprint && hex(line).includes(fingerprint)))

/** The NSS database lists every certificate it holds; no database holds none. */
const inNss = (system) => {
  if (!existsSync(join(system.home, ".pki", "nssdb", "cert9.db"))) return false
  return query(system, "the NSS database", "certutil", ["-d", nssdb(system), "-L"]).includes(CA_NAME)
}
/** The bundle update-ca-certificates generates, read certificate by certificate. */
const inLinuxBundle = (system, state) => {
  let text
  try { text = readFileSync(system.bundleOutput, "utf8") } catch (error) {
    throw new InspectionError(`could not inspect ${system.bundleOutput}: ${firstLine(error)}`)
  }
  return [...text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)].some(([pem]) => {
    const found = fingerprints(pem)
    return found.caSha256 === state.caSha256 || new X509Certificate(pem).subject.includes(CA_NAME)
  })
}
/**
 * Every certificate in the System keychain with its hashes. `security` answers a search without
 * a match, and even a keychain path that does not exist, with exit 0 and no output, so the
 * keychain file has to exist for an empty answer to mean "not there".
 */
const inSystemKeychain = (system, state) => {
  if (!existsSync(system.systemKeychain)) throw new InspectionError(`could not inspect the System keychain: ${system.systemKeychain} does not exist`)
  let text
  try { text = String(system.exec("security", ["find-certificate", "-a", "-Z", system.systemKeychain])) } catch (error) {
    // Older versions exit 44 when the search finds nothing.
    if (error.status === 44 && /could not be found/i.test(String(error.stderr))) return false
    throw new InspectionError(`could not inspect the System keychain: ${firstLine(error)}`)
  }
  return mentions(text, state)
}
/** The whole LocalMachine Root store; a listing without certificates is not a real answer. */
const inWindowsRoot = (system, state) => {
  const text = query(system, "the LocalMachine Root store", "certutil", ["-store", "Root"])
  if (!/=+ Certificate \d+ =+/.test(text)) throw new InspectionError("could not inspect the LocalMachine Root store: the listing shows no certificates")
  return mentions(text, state)
}
const keychainPaths = (text) => text.split("\n").map((line) => line.trim().replace(/^"|"$/g, "")).filter(Boolean)

/**
 * A throwaway root and a certificate for the stand-in's hosts signed by it, made with openssl.
 * The root's private key is deleted as soon as the certificate is issued; only the root
 * certificate (to trust) and the stand-in's key and certificate stay, until cleanup.
 */
export function makeCertificates(system = realSystem()) {
  const dir = join(system.stateDir, "certs")
  mkdirSync(dir, { recursive: true })
  const file = (name) => join(dir, name)
  writeFileSync(file("ca.cnf"), [
    "[req]", "distinguished_name=dn", "prompt=no", "x509_extensions=ext",
    "[dn]", `CN=${CA_NAME}`,
    "[ext]", "basicConstraints=critical,CA:TRUE", "keyUsage=critical,keyCertSign,cRLSign", "subjectKeyIdentifier=hash",
  ].join("\n"))
  writeFileSync(file("leaf.cnf"), ["[req]", "distinguished_name=dn", "prompt=no", "[dn]", `CN=${LOGIN_HOST}`].join("\n"))
  writeFileSync(file("leaf.ext"), [
    "basicConstraints=critical,CA:FALSE", "keyUsage=critical,digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth",
    `subjectAltName=${HOSTS_NAMES.map((name) => `DNS:${name}`).join(",")}`, "subjectKeyIdentifier=hash", "authorityKeyIdentifier=keyid",
  ].join("\n"))
  try {
    system.exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2", "-config", file("ca.cnf"), "-keyout", file("ca.key"), "-out", file("ca.pem")])
    system.exec("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-config", file("leaf.cnf"), "-keyout", file("leaf.key"), "-out", file("leaf.csr")])
    system.exec("openssl", ["x509", "-req", "-sha256", "-days", "2", "-in", file("leaf.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca.key"), "-set_serial", `0x${Date.now().toString(16)}`, "-extfile", file("leaf.ext"), "-out", file("leaf.pem")])
  } finally {
    // Nothing can be signed with the root once the stand-in's certificate exists.
    rmSync(file("ca.key"), { force: true })
    rmSync(file("leaf.csr"), { force: true })
  }
  return { ca: file("ca.pem"), key: readFileSync(file("leaf.key")), cert: readFileSync(file("leaf.pem")) }
}

function writeHosts(system, lines) {
  const content = `${lines.join(eol(system))}${eol(system)}`
  if (system.platform === "win32") return writeFileSync(system.hostsPath, content)
  const temp = join(system.stateDir, "hosts")
  writeFileSync(temp, content)
  sudo(system, "cp", [temp, system.hostsPath])
  rmSync(temp, { force: true })
}

function flushDns(system) {
  if (system.platform === "darwin") {
    sudo(system, "dscacheutil", ["-flushcache"])
    try { sudo(system, "killall", ["-HUP", "mDNSResponder"]) } catch { /* not running */ }
  } else if (system.platform === "win32") {
    system.exec("ipconfig", ["/flushdns"])
  }
}

const hostsLines = (system) => readFileSync(system.hostsPath, "utf8").split(/\r?\n/).filter((line, index, all) => line !== "" || index < all.length - 1)

/**
 * Makes every change, each one recorded in the state file first. Throws with the command output
 * when a step fails; whatever was done until then is undone by `cleanup`.
 */
export function install(ca, system = realSystem()) {
  const state = { ...readState(system), certDir: join(system.stateDir, "certs"), ...fingerprints(readFileSync(ca)) }
  const step = (name, fn) => {
    state[name] = true
    saveState(system, state)
    fn()
  }
  if (system.platform === "linux") {
    // Recorded before it changes, so the original value comes back.
    state.portStart ??= readFileSync(system.portStartPath, "utf8").trim()
    saveState(system, state)
    if (Number(state.portStart) > 443) sudo(system, "sysctl", ["-w", "net.ipv4.ip_unprivileged_port_start=443"])
  }
  step("hosts", () => {
    const kept = hostsLines(system).filter((line) => !line.includes(MARKER))
    writeHosts(system, [...kept, ...HOSTS_NAMES.map((name) => `127.0.0.1 ${name} ${MARKER}`)])
    flushDns(system)
  })
  step("trust", () => {
    if (system.platform === "linux") {
      const db = join(system.home, ".pki", "nssdb")
      if (!existsSync(join(db, "cert9.db"))) {
        mkdirSync(db, { recursive: true })
        system.exec("certutil", ["-d", nssdb(system), "-N", "--empty-password"])
      }
      system.exec("certutil", ["-d", nssdb(system), "-A", "-t", "C,,", "-n", CA_NAME, "-i", ca])
      // From here the generated bundle may hold the root until it is regenerated without it.
      state.bundlePending = true
      saveState(system, state)
      sudo(system, "cp", [ca, system.bundleSource])
      sudo(system, "update-ca-certificates", [])
    } else if (system.platform === "darwin") {
      sudo(system, "security", ["add-trusted-cert", "-d", "-r", "trustRoot", "-k", system.systemKeychain, ca])
    } else if (system.platform === "win32") {
      system.exec("certutil", ["-addstore", "-f", "Root", ca])
    }
  })
  if (system.platform === "darwin") {
    // The app keeps its secrets in the default keychain. A new, unlocked one stands in for the
    // runner's login keychain, which can be locked by the time the test runs.
    state.keychain ??= {
      path: join(system.stateDir, "sign-in-e2e.keychain-db"),
      default: keychainPaths(system.exec("security", ["default-keychain", "-d", "user"]))[0] ?? "",
      list: keychainPaths(system.exec("security", ["list-keychains", "-d", "user"])),
    }
    step("keychainCreated", () => {
      const { path } = state.keychain
      system.exec("security", ["create-keychain", "-p", "", path])
      system.exec("security", ["set-keychain-settings", path])
      system.exec("security", ["unlock-keychain", "-p", "", path])
      system.exec("security", ["list-keychains", "-d", "user", "-s", path])
      system.exec("security", ["default-keychain", "-d", "user", "-s", path])
    })
  }
}

/**
 * Before each start of the app on macOS: removes the app's safe storage key from the disposable
 * keychain, so every fresh profile gets a new key the app writes and reads itself. An unsigned
 * build cannot read back a key an earlier start of it wrote (errSecAuthFailed).
 */
export function forgetAppSecret(system = realSystem()) {
  const path = readState(system).keychain?.path
  if (system.platform !== "darwin" || !path) return
  for (let i = 0; i < 5; i++) {
    try {
      system.exec("security", ["delete-generic-password", "-s", "TenuVault Safe Storage", path])
    } catch (error) {
      // Exit 44, "could not be found": no key is left. Anything else may leave the earlier key,
      // and the app would then fail to start, so it stops the test before the app starts.
      if (error.status === 44 && /could not be found/i.test(String(error.stderr))) return
      throw new Error(`Could not remove the app's key from the disposable keychain: ${firstLine(error)}`, { cause: error })
    }
  }
}

/**
 * What is still on the machine: hosts entries, the root certificate in each store, and on macOS
 * a keychain setting that was not restored. A store that could not be inspected is reported too,
 * because the root may still be in it.
 */
export function leftovers(system = realSystem()) {
  const state = readState(system)
  const found = []
  const check = (fn) => {
    try { fn() } catch (error) { found.push(error instanceof InspectionError ? error.message : `could not inspect: ${firstLine(error)}`) }
  }
  check(() => {
    if (existsSync(system.hostsPath) && hostsLines(system).some((line) => line.includes(MARKER))) found.push(`hosts entries in ${system.hostsPath}`)
  })
  if (system.platform === "linux") {
    check(() => { if (inNss(system)) found.push("root certificate in the NSS database") })
    check(() => { if (existsSync(system.bundleSource)) found.push(`root certificate at ${system.bundleSource}`) })
    check(() => { if (state.bundlePending) found.push(`${system.bundleOutput} not yet regenerated without the root`) })
    check(() => { if (inLinuxBundle(system, state)) found.push(`root certificate in ${system.bundleOutput}`) })
  } else if (system.platform === "darwin") {
    check(() => { if (inSystemKeychain(system, state)) found.push("root certificate in the System keychain") })
    if (state.keychain) {
      check(() => {
        const current = keychainPaths(query(system, "the default keychain", "security", ["default-keychain", "-d", "user"]))[0] ?? ""
        if (state.keychain.default && current !== state.keychain.default) found.push(`default keychain is ${current}, not ${state.keychain.default}`)
      })
      check(() => {
        const current = keychainPaths(query(system, "the keychain search list", "security", ["list-keychains", "-d", "user"]))
        if (state.keychain.list.length && current.join("\n") !== state.keychain.list.join("\n")) found.push(`keychain search list is ${current.join(", ")}, not ${state.keychain.list.join(", ")}`)
      })
      check(() => { if (existsSync(state.keychain.path)) found.push(`disposable keychain at ${state.keychain.path}`) })
    }
  } else if (system.platform === "win32") {
    check(() => { if (inWindowsRoot(system, state)) found.push("root certificate in the LocalMachine Root store") })
  }
  return found
}

/**
 * Undoes `install`, also after a setup that failed halfway or never ran. Every step is tried and
 * a step with nothing to undo does nothing. Returns what is still on the machine afterwards.
 */
export function cleanup(system = realSystem()) {
  const state = readState(system)
  const problems = []
  const attempt = (name, fn) => { try { fn() } catch (error) { problems.push(`${name}: ${String(error.stderr || error.message).trim()}`) } }
  attempt("hosts", () => {
    if (!existsSync(system.hostsPath)) return
    const lines = hostsLines(system)
    if (!lines.some((line) => line.includes(MARKER))) return
    writeHosts(system, lines.filter((line) => !line.includes(MARKER)))
    flushDns(system)
  })
  if (system.platform === "linux") {
    attempt("nss", () => {
      for (let i = 0; i < 5 && inNss(system); i++) system.exec("certutil", ["-d", nssdb(system), "-D", "-n", CA_NAME])
    })
    // Regenerated while the source is there or a regeneration is still pending, also when an
    // earlier cleanup deleted the source and then failed to regenerate.
    attempt("system bundle", () => {
      if (!existsSync(system.bundleSource) && !state.bundlePending) return
      state.bundlePending = true
      saveState(system, state)
      if (existsSync(system.bundleSource)) sudo(system, "rm", ["-f", system.bundleSource])
      sudo(system, "update-ca-certificates", ["--fresh"])
      state.bundlePending = false
      saveState(system, state)
    })
    if (state.portStart && Number(state.portStart) > 443) attempt("port", () => sudo(system, "sysctl", ["-w", `net.ipv4.ip_unprivileged_port_start=${state.portStart}`]))
  } else if (system.platform === "darwin") {
    // Deleting the certificate is enough: removing its trust setting asks for authorization even
    // as root, and a setting for a certificate that is gone applies to nothing.
    attempt("System keychain", () => {
      for (let i = 0; i < 5 && inSystemKeychain(system, state); i++) sudo(system, "security", ["delete-certificate", "-c", CA_NAME, system.systemKeychain])
    })
    if (state.keychain) {
      attempt("keychain list", () => {
        if (state.keychain.list.length) system.exec("security", ["list-keychains", "-d", "user", "-s", ...state.keychain.list])
        if (state.keychain.default) system.exec("security", ["default-keychain", "-d", "user", "-s", state.keychain.default])
      })
      attempt("disposable keychain", () => {
        if (existsSync(state.keychain.path)) system.exec("security", ["delete-keychain", state.keychain.path])
      })
    }
  } else if (system.platform === "win32") {
    attempt("root store", () => {
      for (let i = 0; i < 5 && inWindowsRoot(system, state); i++) system.exec("certutil", ["-delstore", "Root", CA_NAME])
    })
  }
  const left = leftovers(system)
  // The state goes only once every undo step worked and nothing is left, so a later cleanup can
  // still retry a restoration that failed (the Linux port setting, the macOS keychains).
  if (!left.length && !problems.length) rmSync(system.stateDir, { recursive: true, force: true })
  return { problems, left }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "cleanup") {
    console.error("Usage: node scripts/sign-in-e2e/runner.mjs cleanup")
    process.exit(2)
  }
  const { problems, left } = cleanup()
  for (const problem of problems) console.error(`Could not undo a change: ${problem}`)
  if (left.length) console.error(`Still on this machine after cleanup: ${left.join("; ")}`)
  if (problems.length || left.length) process.exit(1)
  console.log("The sign-in test's changes to this machine are undone and read back: no hosts entries, no test root certificate in any store.")
}
