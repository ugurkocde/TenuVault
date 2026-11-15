/**
 * Sends login.microsoftonline.com to the local stand-in the way an administrator of the machine
 * could, without telling the app: a hosts file entry for the host, and a throwaway root
 * certificate in the operating system's trust store that the stand-in's certificate chains to.
 * The app keeps its own authority, redirect, browser opener and certificate checks.
 *
 * - Linux: /etc/hosts, the NSS database in ~/.pki/nssdb (what Chromium on Linux trusts) and the
 *   system bundle (update-ca-certificates), and port 443 opened to unprivileged processes so the
 *   stand-in can listen on it. Needs sudo and certutil (libnss3-tools).
 * - macOS: /etc/hosts and the System keychain as a trusted root. Needs sudo.
 * - Windows: the hosts file and the LocalMachine Root store. Needs an elevated shell.
 *
 * Each change is undone by `remove`, which runs after the sign-ins. These are changes to the
 * whole machine: run this only on a throwaway CI runner.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { LOGIN_HOST } from "./stand-in.mjs"

const MARKER = "# tenuvault-sign-in-e2e"
const CA_NAME = "TenuVault sign-in e2e test root"
const HOSTS = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts") : "/etc/hosts"
const NSSDB = `sql:${join(homedir(), ".pki", "nssdb")}`

const PORT_START = "/proc/sys/net/ipv4/ip_unprivileged_port_start"
let previousPortStart = null

// A command that waits for a prompt nobody can answer fails instead of holding the job.
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 60_000, ...options })
const sudo = (command, args) => run("sudo", ["-n", command, ...args])

/** A throwaway root and a certificate for LOGIN_HOST signed by it, made with openssl in `dir`. */
export function makeCertificates(dir) {
  mkdirSync(dir, { recursive: true })
  const file = (name) => join(dir, name)
  writeFileSync(file("ca.cnf"), [
    "[req]", "distinguished_name=dn", "prompt=no", "x509_extensions=ext",
    "[dn]", `CN=${CA_NAME}`,
    "[ext]", "basicConstraints=critical,CA:TRUE", "keyUsage=critical,keyCertSign,cRLSign", "subjectKeyIdentifier=hash",
  ].join("\n"))
  writeFileSync(file("leaf.cnf"), [
    "[req]", "distinguished_name=dn", "prompt=no",
    "[dn]", `CN=${LOGIN_HOST}`,
  ].join("\n"))
  writeFileSync(file("leaf.ext"), [
    "basicConstraints=critical,CA:FALSE", "keyUsage=critical,digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth",
    `subjectAltName=DNS:${LOGIN_HOST}`, "subjectKeyIdentifier=hash", "authorityKeyIdentifier=keyid",
  ].join("\n"))
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "7", "-config", file("ca.cnf"), "-keyout", file("ca.key"), "-out", file("ca.pem")])
  run("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-config", file("leaf.cnf"), "-keyout", file("leaf.key"), "-out", file("leaf.csr")])
  run("openssl", ["x509", "-req", "-sha256", "-days", "7", "-in", file("leaf.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca.key"), "-CAcreateserial", "-extfile", file("leaf.ext"), "-out", file("leaf.pem")])
  return { ca: file("ca.pem"), key: readFileSync(file("leaf.key")), cert: readFileSync(file("leaf.pem")) }
}

function writeHosts(content) {
  if (process.platform === "win32") return writeFileSync(HOSTS, content)
  const temp = join(process.env.RUNNER_TEMP ?? "/tmp", `hosts-${process.pid}`)
  writeFileSync(temp, content)
  sudo("cp", [temp, HOSTS])
}

function flushDns() {
  if (process.platform === "darwin") {
    sudo("dscacheutil", ["-flushcache"])
    try { sudo("killall", ["-HUP", "mDNSResponder"]) } catch { /* not running */ }
  } else if (process.platform === "win32") {
    run("ipconfig", ["/flushdns"])
  }
}

/** Adds the hosts entry and trusts `ca`. Throws with the command output when a step fails. */
export function install(ca) {
  const hosts = readFileSync(HOSTS, "utf8").split(/\r?\n/).filter((line) => !line.includes(MARKER))
  writeHosts([...hosts, `127.0.0.1 ${LOGIN_HOST} ${MARKER}`, ""].join(process.platform === "win32" ? "\r\n" : "\n"))
  flushDns()
  if (process.platform === "linux") {
    previousPortStart = readFileSync(PORT_START, "utf8").trim()
    if (Number(previousPortStart) > 443) sudo("sysctl", ["-w", "net.ipv4.ip_unprivileged_port_start=443"])
    if (!existsSync(join(homedir(), ".pki", "nssdb", "cert9.db"))) {
      mkdirSync(join(homedir(), ".pki", "nssdb"), { recursive: true })
      run("certutil", ["-d", NSSDB, "-N", "--empty-password"])
    }
    run("certutil", ["-d", NSSDB, "-A", "-t", "C,,", "-n", CA_NAME, "-i", ca])
    sudo("cp", [ca, "/usr/local/share/ca-certificates/tenuvault-sign-in-e2e.crt"])
    sudo("update-ca-certificates", [])
  } else if (process.platform === "darwin") {
    sudo("security", ["add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", ca])
  } else if (process.platform === "win32") {
    run("certutil", ["-addstore", "-f", "Root", ca])
  }
}

/** Undoes `install`. Every step is tried; failures are returned, not thrown. */
export function remove() {
  const problems = []
  const attempt = (name, fn) => { try { fn() } catch (error) { problems.push(`${name}: ${error.stderr || error.message}`) } }
  attempt("hosts", () => {
    const hosts = readFileSync(HOSTS, "utf8").split(/\r?\n/).filter((line) => !line.includes(MARKER))
    writeHosts(hosts.join(process.platform === "win32" ? "\r\n" : "\n"))
    flushDns()
  })
  if (process.platform === "linux") {
    if (previousPortStart && Number(previousPortStart) > 443) attempt("port", () => sudo("sysctl", ["-w", `net.ipv4.ip_unprivileged_port_start=${previousPortStart}`]))
    attempt("nss", () => run("certutil", ["-d", NSSDB, "-D", "-n", CA_NAME]))
    attempt("system bundle", () => {
      sudo("rm", ["-f", "/usr/local/share/ca-certificates/tenuvault-sign-in-e2e.crt"])
      sudo("update-ca-certificates", ["--fresh"])
    })
  } else if (process.platform === "darwin") {
    // Removing the trust setting asks for authorization even as root; deleting the certificate
    // leaves nothing for that setting to apply to.
    attempt("keychain", () => sudo("security", ["delete-certificate", "-c", CA_NAME, "/Library/Keychains/System.keychain"]))
  } else if (process.platform === "win32") {
    attempt("root store", () => run("certutil", ["-delstore", "Root", CA_NAME]))
  }
  return problems
}
