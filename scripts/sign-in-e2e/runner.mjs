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
 * It then reads the machine back and exits 1 when a hosts entry or the root certificate is
 * still there. These are changes to the whole machine: run this only on a throwaway CI runner.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { LICENSE_HOST, LOGIN_HOST } from "./stand-in.mjs"

export const HOSTS_NAMES = [LOGIN_HOST, LICENSE_HOST]
const MARKER = "# tenuvault-sign-in-e2e"
export const CA_NAME = "TenuVault sign-in e2e test root"
const SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain"

/** The real machine. Tests pass their own, with a fake `exec` and a hosts file of their own. */
export function realSystem() {
  return {
    platform: process.platform,
    hostsPath: process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts") : "/etc/hosts",
    // RUNNER_TEMP is the same for every step of a job, so the cleanup step finds the state.
    stateDir: join(process.env.RUNNER_TEMP ?? tmpdir(), "tenuvault-sign-in-e2e"),
    home: homedir(),
    portStartPath: "/proc/sys/net/ipv4/ip_unprivileged_port_start",
    bundleFile: "/usr/local/share/ca-certificates/tenuvault-sign-in-e2e.crt",
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

/** Whether the root is in a store: the query must succeed and name it. */
const inStore = (system, command, args) => {
  try { return String(system.exec(command, args)).includes(CA_NAME) } catch { return false }
}
const inNss = (system) => inStore(system, "certutil", ["-d", nssdb(system), "-L"])
const inSystemKeychain = (system) => inStore(system, "security", ["find-certificate", "-a", "-c", CA_NAME, SYSTEM_KEYCHAIN])
const inWindowsRoot = (system) => inStore(system, "certutil", ["-store", "Root", CA_NAME])

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
  const state = { ...readState(system), certDir: join(system.stateDir, "certs") }
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
      sudo(system, "cp", [ca, system.bundleFile])
      sudo(system, "update-ca-certificates", [])
    } else if (system.platform === "darwin") {
      sudo(system, "security", ["add-trusted-cert", "-d", "-r", "trustRoot", "-k", SYSTEM_KEYCHAIN, ca])
    } else if (system.platform === "win32") {
      system.exec("certutil", ["-addstore", "-f", "Root", ca])
    }
  })
  if (system.platform === "darwin") {
    // The app keeps its secrets in the default keychain. A new, unlocked one stands in for the
    // runner's login keychain, which can be locked by the time the test runs.
    state.keychain ??= {
      path: join(system.stateDir, "sign-in-e2e.keychain-db"),
      default: system.exec("security", ["default-keychain", "-d", "user"]).trim().replace(/^"|"$/g, ""),
      list: system.exec("security", ["list-keychains", "-d", "user"]).split("\n").map((line) => line.trim().replace(/^"|"$/g, "")).filter(Boolean),
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

/** What is still on the machine: hosts entries and the root certificate in each store. */
export function leftovers(system = realSystem()) {
  const found = []
  if (existsSync(system.hostsPath) && hostsLines(system).some((line) => line.includes(MARKER))) found.push(`hosts entries in ${system.hostsPath}`)
  if (system.platform === "linux") {
    if (inNss(system)) found.push("root certificate in the NSS database")
    if (existsSync(system.bundleFile)) found.push(`root certificate at ${system.bundleFile}`)
  } else if (system.platform === "darwin") {
    if (inSystemKeychain(system)) found.push("root certificate in the System keychain")
  } else if (system.platform === "win32") {
    if (inWindowsRoot(system)) found.push("root certificate in the LocalMachine Root store")
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
    attempt("system bundle", () => {
      if (!existsSync(system.bundleFile)) return
      sudo(system, "rm", ["-f", system.bundleFile])
      sudo(system, "update-ca-certificates", ["--fresh"])
    })
    if (state.portStart && Number(state.portStart) > 443) attempt("port", () => sudo(system, "sysctl", ["-w", `net.ipv4.ip_unprivileged_port_start=${state.portStart}`]))
  } else if (system.platform === "darwin") {
    // Deleting the certificate is enough: removing its trust setting asks for authorization even
    // as root, and a setting for a certificate that is gone applies to nothing.
    attempt("System keychain", () => {
      for (let i = 0; i < 5 && inSystemKeychain(system); i++) sudo(system, "security", ["delete-certificate", "-c", CA_NAME, SYSTEM_KEYCHAIN])
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
      for (let i = 0; i < 5 && inWindowsRoot(system); i++) system.exec("certutil", ["-delstore", "Root", CA_NAME])
    })
  }
  const left = leftovers(system)
  // The state goes only once nothing is left, so a later cleanup can still use it.
  if (!left.length) rmSync(system.stateDir, { recursive: true, force: true })
  return { problems, left }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "cleanup") {
    console.error("Usage: node scripts/sign-in-e2e/runner.mjs cleanup")
    process.exit(2)
  }
  const { problems, left } = cleanup()
  for (const problem of problems) console.warn(`Could not undo a change: ${problem}`)
  if (left.length) {
    console.error(`Still on this machine after cleanup: ${left.join("; ")}`)
    process.exit(1)
  }
  console.log("The sign-in test's changes to this machine are undone: no hosts entries, no test root certificate.")
}
