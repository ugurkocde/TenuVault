import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { X509Certificate } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
// @ts-expect-error The CI harness is plain JavaScript without type declarations.
import { CA_NAME, cleanup, forgetAppSecret, install, leftovers, makeCertificates } from "../scripts/sign-in-e2e/runner.mjs"

type Call = { command: string; args: string[] }
type Platform = "linux" | "darwin" | "win32"

const ORIGINAL_HOSTS = "127.0.0.1 localhost\n::1 localhost\n"
const LOGIN_KEYCHAIN = "/Users/runner/Library/Keychains/login.keychain-db"
const made: string[] = []

/** A real throwaway root from runner.mjs, made with openssl, so fingerprints are real. */
function realRoot(dir: string): { path: string; pem: string; sha1: string } {
  const system = { stateDir: join(dir, "root"), exec: (command: string, args: string[]) => execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }) }
  const { ca } = makeCertificates(system) as { ca: string }
  const pem = readFileSync(ca, "utf8")
  expect(existsSync(join(system.stateDir, "certs", "ca.key"))).toBe(false)
  return { path: ca, pem, sha1: new X509Certificate(pem).fingerprint.replace(/:/g, "") }
}

/**
 * A machine for runner.mjs: its own hosts file, System keychain file and CA bundle, and an `exec`
 * that keeps the trust stores in memory and answers like the real tools do: certutil -L and
 * certutil -store list everything, security lists every certificate with its hashes and answers
 * an empty search with exit 0. `fail` makes chosen commands fail like a timeout or a store that
 * cannot be opened.
 */
function machine(platform: Platform) {
  const dir = mkdtempSync(join(tmpdir(), "sign-in-e2e-runner-"))
  made.push(dir)
  const root = realRoot(dir)
  const paths = {
    hostsPath: join(dir, "hosts"),
    portStartPath: join(dir, "port-start"),
    bundleSource: join(dir, "source.crt"),
    bundleOutput: join(dir, "ca-certificates.crt"),
    systemKeychain: join(dir, "System.keychain"),
  }
  writeFileSync(paths.hostsPath, ORIGINAL_HOSTS)
  writeFileSync(paths.portStartPath, "1024\n")
  writeFileSync(paths.bundleOutput, "")
  writeFileSync(paths.systemKeychain, "keychain")
  const calls: Call[] = []
  const stores = new Set<string>()
  const keychains = { default: LOGIN_KEYCHAIN, list: [LOGIN_KEYCHAIN] }
  const m = {
    dir,
    root,
    calls,
    stores,
    keychains,
    fail: (_call: Call) => false,
    hosts: () => readFileSync(paths.hostsPath, "utf8").replace(/\r\n/g, "\n"),
    system: {} as Record<string, unknown>,
  }
  const exec = (command: string, args: string[]) => {
    const call = command === "sudo" ? { command: args[1]!, args: args.slice(2) } : { command, args }
    calls.push(call)
    if (m.fail(call)) throw Object.assign(new Error(`${call.command} timed out`), { status: null, stderr: `${call.command}: the operation timed out` })
    const [first] = call.args
    switch (call.command) {
      case "cp":
        writeFileSync(call.args[1]!, readFileSync(call.args[0]!))
        return ""
      case "rm":
        rmSync(call.args.at(-1)!, { force: true })
        return ""
      case "update-ca-certificates":
        // Without --fresh the new source is added; with it the bundle is rebuilt from the sources.
        writeFileSync(paths.bundleOutput, call.args.includes("--fresh") ? (existsSync(paths.bundleSource) ? readFileSync(paths.bundleSource, "utf8") : "") : `${readFileSync(paths.bundleOutput, "utf8")}${root.pem}`)
        return ""
      case "certutil":
        if (call.args.includes("-A")) stores.add("nss")
        if (call.args.includes("-D")) stores.delete("nss")
        if (call.args.at(-1) === "-L") return `Certificate Nickname    Trust Attributes\n${stores.has("nss") ? `${CA_NAME}    C,,\n` : ""}`
        if (first === "-addstore") stores.add("windows")
        if (first === "-delstore") stores.delete("windows")
        if (first === "-store") return `Root\n================ Certificate 0 ================\nSubject: CN=Some Other Root\nCert Hash(sha1): 0011\n${stores.has("windows") ? `================ Certificate 1 ================\nSubject: CN=${CA_NAME}\nCert Hash(sha1): ${root.sha1.toLowerCase()}\n` : ""}`
        return ""
      case "security":
        if (first === "add-trusted-cert") stores.add("keychain")
        if (first === "delete-certificate") stores.delete("keychain")
        if (first === "find-certificate") return stores.has("keychain") ? `keychain: "${paths.systemKeychain}"\nSHA-256 hash: 00\nSHA-1 hash: ${root.sha1}\n    "labl"<blob>="${CA_NAME}"\n` : ""
        if (first === "create-keychain") writeFileSync(call.args.at(-1)!, "keychain")
        if (first === "delete-keychain") rmSync(call.args.at(-1)!, { force: true })
        if (first === "default-keychain") {
          if (call.args.includes("-s")) keychains.default = call.args.at(-1)!
          return `    "${keychains.default}"\n`
        }
        if (first === "list-keychains") {
          if (call.args.includes("-s")) keychains.list = call.args.slice(call.args.indexOf("-s") + 1)
          return keychains.list.map((path) => `    "${path}"`).join("\n")
        }
        return ""
      default:
        return ""
    }
  }
  m.system = { platform, ...paths, stateDir: join(dir, "state"), home: join(dir, "home"), exec }
  mkdirSync(m.system.home as string, { recursive: true })
  // Linux keeps an NSS database once the test has created one.
  if (platform === "linux") {
    mkdirSync(join(m.system.home as string, ".pki", "nssdb"), { recursive: true })
    writeFileSync(join(m.system.home as string, ".pki", "nssdb", "cert9.db"), "")
  }
  return m
}

/** The commands that read a trust store back. */
const isQuery = (call: Call) =>
  (call.command === "certutil" && (call.args.at(-1) === "-L" || call.args[0] === "-store")) || (call.command === "security" && call.args[0] === "find-certificate")

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("sign-in test runner changes", () => {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    it(`undoes a setup on ${platform} that failed after the hosts entries were written`, () => {
      const m = machine(platform)
      m.fail = (call) => ["add-trusted-cert", "-A", "-addstore"].some((flag) => call.args.includes(flag))
      expect(() => install(m.root.path, m.system)).toThrow(/timed out/)
      expect(m.hosts()).toContain("login.microsoftonline.com")
      expect(leftovers(m.system)).toEqual([expect.stringContaining("hosts entries")])
      m.fail = () => false

      expect(cleanup(m.system).left).toEqual([])
      expect(m.hosts()).toBe(ORIGINAL_HOSTS)
      expect(existsSync(m.system.stateDir as string)).toBe(false)
    })

    it(`undoes a complete setup on ${platform}, and a second cleanup changes nothing`, () => {
      const m = machine(platform)
      install(m.root.path, m.system)
      expect(m.hosts()).toMatch(/127\.0\.0\.1 www\.tenuvault\.com/)
      expect(m.stores.size).toBe(1)
      expect(leftovers(m.system).length).toBeGreaterThan(0)

      expect(cleanup(m.system).left).toEqual([])
      expect(m.stores.size).toBe(0)
      expect(m.hosts()).toBe(ORIGINAL_HOSTS)
      const before = m.calls.length
      expect(cleanup(m.system)).toEqual({ problems: [], left: [] })
      // Only read-back queries: nothing is written or deleted when nothing is left.
      expect(m.calls.slice(before).every((call) => isQuery(call) || (call.command === "security" && ["default-keychain", "list-keychains"].includes(call.args[0]!)))).toBe(true)
    })

    it(`keeps the state and fails when the ${platform} trust store cannot be read back`, () => {
      const m = machine(platform)
      install(m.root.path, m.system)
      m.fail = isQuery

      const { left } = cleanup(m.system)
      // Nothing is reported as removed: the store still holds the root and the state stays.
      expect(left).toEqual(expect.arrayContaining([expect.stringMatching(/could not inspect .*timed out/)]))
      expect(m.stores.size).toBe(1)
      expect(existsSync(m.system.stateDir as string)).toBe(true)

      m.fail = () => false
      expect(cleanup(m.system).left).toEqual([])
      expect(m.stores.size).toBe(0)
      expect(existsSync(m.system.stateDir as string)).toBe(false)
    })
  }

  it("does not take an empty answer for a System keychain that is not there as the root being gone", () => {
    const m = machine("darwin")
    install(m.root.path, m.system)
    rmSync(m.system.systemKeychain as string)
    expect(cleanup(m.system).left).toEqual(expect.arrayContaining([expect.stringMatching(/could not inspect the System keychain: .* does not exist/)]))
    expect(existsSync(m.system.stateDir as string)).toBe(true)
  })

  it("does not take a Root store listing without certificates as the root being gone", () => {
    const m = machine("win32")
    install(m.root.path, m.system)
    const exec = m.system.exec as (command: string, args: string[]) => string
    m.system.exec = (command: string, args: string[]) => (command === "certutil" && args[0] === "-store" ? "CertUtil: -store command completed successfully.\n" : exec(command, args))
    expect(cleanup(m.system).left).toEqual(expect.arrayContaining([expect.stringMatching(/Root store: the listing shows no certificates/)]))
    expect(existsSync(m.system.stateDir as string)).toBe(true)
  })

  it("retries a Linux bundle regeneration that failed after the source was deleted, and checks the bundle itself", () => {
    const m = machine("linux")
    install(m.root.path, m.system)
    expect(readFileSync(m.system.bundleOutput as string, "utf8")).toContain(m.root.pem.trim())
    m.fail = (call) => call.command === "update-ca-certificates"

    const first = cleanup(m.system)
    expect(existsSync(m.system.bundleSource as string)).toBe(false)
    expect(first.left).toEqual(expect.arrayContaining([
      expect.stringContaining("not yet regenerated without the root"),
      expect.stringContaining(`root certificate in ${m.system.bundleOutput}`),
    ]))
    expect(JSON.parse(readFileSync(join(m.system.stateDir as string, "state.json"), "utf8")).bundlePending).toBe(true)

    // The source is gone already; the pending flag alone makes the next cleanup regenerate.
    m.fail = () => false
    expect(cleanup(m.system).left).toEqual([])
    expect(m.calls.filter((call) => call.command === "update-ca-certificates" && call.args.includes("--fresh"))).toHaveLength(2)
    expect(readFileSync(m.system.bundleOutput as string, "utf8")).not.toContain("BEGIN CERTIFICATE")
  })

  it("restores the Linux port setting recorded before it was changed", () => {
    const m = machine("linux")
    install(m.root.path, m.system)
    expect(m.calls).toContainEqual({ command: "sysctl", args: ["-w", "net.ipv4.ip_unprivileged_port_start=443"] })
    cleanup(m.system)
    expect(m.calls).toContainEqual({ command: "sysctl", args: ["-w", "net.ipv4.ip_unprivileged_port_start=1024"] })
  })

  it("restores the macOS keychain list and default, deletes the disposable keychain, and reports a list it could not restore", () => {
    const m = machine("darwin")
    install(m.root.path, m.system)
    const disposable = join(m.system.stateDir as string, "sign-in-e2e.keychain-db")
    expect(m.keychains).toEqual({ default: disposable, list: [disposable] })
    forgetAppSecret(m.system)
    expect(m.calls).toContainEqual({ command: "security", args: ["delete-generic-password", "-s", "TenuVault Safe Storage", disposable] })

    m.fail = (call) => call.args[0] === "list-keychains" && call.args.includes("-s")
    const first = cleanup(m.system)
    expect(first.left).toEqual(expect.arrayContaining([expect.stringContaining(`keychain search list is ${disposable}`)]))
    expect(existsSync(m.system.stateDir as string)).toBe(true)

    m.fail = () => false
    expect(cleanup(m.system).left).toEqual([])
    expect(m.keychains).toEqual({ default: LOGIN_KEYCHAIN, list: [LOGIN_KEYCHAIN] })
    expect(existsSync(disposable)).toBe(false)
  })

  it("keeps the state and reports a failed Linux port restoration even when nothing is left", () => {
    const m = machine("linux")
    install(m.root.path, m.system)
    m.fail = (call) => call.command === "sysctl" && call.args.includes("net.ipv4.ip_unprivileged_port_start=1024")
    const first = cleanup(m.system)
    expect(first.left).toEqual([])
    expect(first.problems).toEqual([expect.stringMatching(/^port: /)])
    expect(JSON.parse(readFileSync(join(m.system.stateDir as string, "state.json"), "utf8")).portStart).toBe("1024")

    m.fail = () => false
    expect(cleanup(m.system)).toEqual({ problems: [], left: [] })
    expect(m.calls.filter((call) => call.command === "sysctl" && call.args.includes("net.ipv4.ip_unprivileged_port_start=1024"))).toHaveLength(2)
    expect(existsSync(m.system.stateDir as string)).toBe(false)
  })

  it("keeps the state and reports a failed macOS default keychain restoration", () => {
    const m = machine("darwin")
    install(m.root.path, m.system)
    m.fail = (call) => call.args[0] === "default-keychain" && call.args.includes("-s")
    const first = cleanup(m.system)
    expect(first.problems).toEqual([expect.stringMatching(/^keychain list: /)])
    expect(existsSync(m.system.stateDir as string)).toBe(true)

    m.fail = () => false
    expect(cleanup(m.system)).toEqual({ problems: [], left: [] })
    expect(m.keychains.default).toBe(LOGIN_KEYCHAIN)
  })

  it("forgets the app's key until security reports none, and stops on any other failure", () => {
    const m = machine("darwin")
    install(m.root.path, m.system)
    const exec = m.system.exec as (command: string, args: string[]) => string
    const deleting = (call: string[]) => call[0] === "delete-generic-password"
    let keys = 2
    m.system.exec = (command: string, args: string[]) => {
      if (command !== "security" || !deleting(args)) return exec(command, args)
      if (keys === 0) throw Object.assign(new Error("Command failed"), { status: 44, stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." })
      keys--
      return ""
    }
    expect(() => forgetAppSecret(m.system)).not.toThrow()
    expect(keys).toBe(0)

    m.system.exec = (command: string, args: string[]) => {
      if (command === "security" && deleting(args)) throw Object.assign(new Error("Command failed"), { status: 51, stderr: "security: SecKeychainItemDelete: User interaction is not allowed." })
      return exec(command, args)
    }
    expect(() => forgetAppSecret(m.system)).toThrow(/Could not remove the app's key from the disposable keychain: security: SecKeychainItemDelete: User interaction is not allowed/)

    // Five keys deleted in a row: it stops after five attempts without an error.
    let attempts = 0
    m.system.exec = (command: string, args: string[]) => {
      if (command === "security" && deleting(args)) { attempts++; return "" }
      return exec(command, args)
    }
    forgetAppSecret(m.system)
    expect(attempts).toBe(5)
  })

  it("reports a root certificate it could not remove and keeps the state for another cleanup", () => {
    const m = machine("win32")
    install(m.root.path, m.system)
    m.fail = (call) => call.args[0] === "-delstore"
    const { left, problems } = cleanup(m.system)
    expect(left).toEqual(["root certificate in the LocalMachine Root store"])
    expect(problems.join()).toMatch(/root store/)
    expect(existsSync(m.system.stateDir as string)).toBe(true)
  })
})
