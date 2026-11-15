import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
// @ts-expect-error The CI harness is plain JavaScript without type declarations.
import { CA_NAME, cleanup, forgetAppSecret, install, leftovers } from "../scripts/sign-in-e2e/runner.mjs"

type Call = { command: string; args: string[] }

const ORIGINAL_HOSTS = "127.0.0.1 localhost\n::1 localhost\n"

/**
 * A machine for runner.mjs: a hosts file of its own, and an `exec` that records every command,
 * keeps the trust stores in memory and fails the commands named in `failing`. `sudo -n cp`
 * really copies, because that is how the hosts file is written.
 */
function machine(platform: "linux" | "darwin" | "win32", failing: (call: Call) => boolean = () => false) {
  const dir = mkdtempSync(join(tmpdir(), "sign-in-e2e-runner-"))
  const hostsPath = join(dir, "hosts")
  writeFileSync(hostsPath, ORIGINAL_HOSTS)
  const portStartPath = join(dir, "port-start")
  writeFileSync(portStartPath, "1024\n")
  const calls: Call[] = []
  const stores = new Set<string>()
  const exec = (command: string, args: string[]) => {
    const call = command === "sudo" ? { command: args[1]!, args: args.slice(2) } : { command, args }
    calls.push(call)
    if (failing(call)) throw Object.assign(new Error(`${call.command} failed`), { stderr: `${call.command}: refused` })
    if (call.command === "rm") {
      rmSync(call.args.at(-1)!, { force: true })
      return ""
    }
    if (call.command === "cp") {
      writeFileSync(call.args[1]!, readFileSync(call.args[0]!))
      return ""
    }
    if (call.command === "certutil" && call.args.includes("-A")) stores.add("nss")
    if (call.command === "certutil" && call.args.includes("-D")) stores.delete("nss")
    if (call.command === "certutil" && call.args.at(-1) === "-L") return stores.has("nss") ? `${CA_NAME}  C,,` : ""
    if (call.command === "certutil" && call.args[0] === "-addstore") stores.add("windows")
    if (call.command === "certutil" && call.args[0] === "-delstore") stores.delete("windows")
    if (call.command === "certutil" && call.args[0] === "-store") {
      if (!stores.has("windows")) throw new Error("Cannot find object or property.")
      return `Subject: CN=${CA_NAME}`
    }
    if (call.command === "security" && call.args[0] === "add-trusted-cert") stores.add("keychain")
    if (call.command === "security" && call.args[0] === "delete-certificate") stores.delete("keychain")
    if (call.command === "security" && call.args[0] === "find-certificate") {
      if (!stores.has("keychain")) throw new Error("The specified item could not be found in the keychain.")
      return `"labl"<blob>="${CA_NAME}"`
    }
    if (call.command === "security" && call.args[0] === "default-keychain") return '    "/Users/runner/Library/Keychains/login.keychain-db"\n'
    if (call.command === "security" && call.args[0] === "list-keychains") return '    "/Users/runner/Library/Keychains/login.keychain-db"\n'
    return ""
  }
  const system = { platform, hostsPath, stateDir: join(dir, "state"), home: join(dir, "home"), portStartPath, bundleFile: join(dir, "bundle.crt"), exec }
  mkdirSync(system.home, { recursive: true })
  return { dir, system, calls, stores, hosts: () => readFileSync(hostsPath, "utf8") }
}

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("sign-in test runner changes", () => {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    it(`undoes a setup on ${platform} that failed after the hosts entries were written`, () => {
      const m = machine(platform, (call) => ["add-trusted-cert", "-A", "-addstore"].some((flag) => call.args.includes(flag)))
      made.push(m.dir)
      writeFileSync(join(m.dir, "ca.pem"), "root")
      expect(() => install(join(m.dir, "ca.pem"), m.system)).toThrow(/failed/)
      expect(m.hosts()).toContain("login.microsoftonline.com")
      expect(leftovers(m.system)).toEqual([expect.stringContaining("hosts entries")])

      const { left } = cleanup(m.system)
      expect(left).toEqual([])
      expect(m.hosts().replace(/\r\n/g, "\n")).toBe(ORIGINAL_HOSTS)
      expect(existsSync(m.system.stateDir)).toBe(false)
    })

    it(`undoes a complete setup on ${platform}, and a second cleanup changes nothing`, () => {
      const m = machine(platform)
      made.push(m.dir)
      writeFileSync(join(m.dir, "ca.pem"), "root")
      install(join(m.dir, "ca.pem"), m.system)
      expect(m.hosts()).toMatch(/127\.0\.0\.1 www\.tenuvault\.com/)
      expect(m.stores.size).toBe(1)
      expect(leftovers(m.system).length).toBeGreaterThan(0)

      expect(cleanup(m.system).left).toEqual([])
      expect(m.stores.size).toBe(0)
      expect(m.hosts().replace(/\r\n/g, "\n")).toBe(ORIGINAL_HOSTS)
      const before = m.calls.length
      expect(cleanup(m.system)).toEqual({ problems: [], left: [] })
      // Only read-back queries: nothing is written or deleted when nothing is left.
      expect(m.calls.slice(before).every((call) => ["-L", "-store", "find-certificate"].some((query) => call.args.includes(query)))).toBe(true)
    })
  }

  it("restores the Linux port setting recorded before it was changed", () => {
    const m = machine("linux")
    made.push(m.dir)
    writeFileSync(join(m.dir, "ca.pem"), "root")
    install(join(m.dir, "ca.pem"), m.system)
    expect(m.calls).toContainEqual({ command: "sysctl", args: ["-w", "net.ipv4.ip_unprivileged_port_start=443"] })
    cleanup(m.system)
    expect(m.calls).toContainEqual({ command: "sysctl", args: ["-w", "net.ipv4.ip_unprivileged_port_start=1024"] })
  })

  it("restores the macOS keychain list and default, and deletes the disposable keychain", () => {
    const m = machine("darwin")
    made.push(m.dir)
    writeFileSync(join(m.dir, "ca.pem"), "root")
    install(join(m.dir, "ca.pem"), m.system)
    const disposable = join(m.system.stateDir, "sign-in-e2e.keychain-db")
    expect(m.calls).toContainEqual({ command: "security", args: ["default-keychain", "-d", "user", "-s", disposable] })
    forgetAppSecret(m.system)
    expect(m.calls).toContainEqual({ command: "security", args: ["delete-generic-password", "-s", "TenuVault Safe Storage", disposable] })
    writeFileSync(disposable, "keychain")
    cleanup(m.system)
    expect(m.calls).toContainEqual({ command: "security", args: ["default-keychain", "-d", "user", "-s", "/Users/runner/Library/Keychains/login.keychain-db"] })
    expect(m.calls).toContainEqual({ command: "security", args: ["delete-keychain", disposable] })
  })

  it("reports a root certificate it could not remove and keeps the state for another cleanup", () => {
    const m = machine("win32", (call) => call.args[0] === "-delstore")
    made.push(m.dir)
    writeFileSync(join(m.dir, "ca.pem"), "root")
    install(join(m.dir, "ca.pem"), m.system)
    const { left, problems } = cleanup(m.system)
    expect(left).toEqual(["root certificate in the LocalMachine Root store"])
    expect(problems.join()).toMatch(/root store/)
    expect(existsSync(m.system.stateDir)).toBe(true)
  })
})
