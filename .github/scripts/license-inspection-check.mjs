// Never relay child output: it can contain the key, signed tokens or saved license state.
import { spawn, execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"

export const expected = {
  trusted: [
    "CHECK trusted activation: activated; entitled=true",
    "CHECK trusted refresh: entitled=true offline=false",
    "CHECK trusted release: hasKey=false",
  ],
  untrusted: ["CHECK untrusted activation: The licensing service could not be reached. Ask IT to check this device's trusted certificates and HTTPS inspection for www.tenuvault.com. (ERR_CERT_AUTHORITY_INVALID); entitled=false"],
  blocked: [
    "CHECK block page refresh: entitled=true offline=true",
    "CHECK block page activation: The licensing service returned an unexpected response. Check for a firewall block or network sign-in page and retry.",
  ],
}

export function inspect(mode, output, code) {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith("CHECK "))
  const want = expected[mode]
  // Only known strings may enter the log or summary. Unexpected output stays private.
  const matches = want.map((line) => lines.includes(line))
  return {
    pass: code === 0 && lines.length === want.length && matches.every(Boolean)
      && lines.every((line, i) => line === want[i]),
    got: want.map((_, i) => matches[i] ? "matched" : "missing or different").join("; ")
      + (code !== 0 ? "; process failed" : "")
      + (lines.some((line) => !want.includes(line)) ? "; unexpected CHECK result" : ""),
  }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.on("data", (data) => { output += data })
    child.stderr.on("data", (data) => { output += data })
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000)
    child.on("error", () => { clearTimeout(timer); resolveRun({ code: -1, output }) })
    child.on("close", (code) => { clearTimeout(timer); resolveRun({ code, output }) })
  })
}

async function ready(proxy, ca) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && proxy.exitCode === null) {
    const listening = await new Promise((done) => {
      const socket = createConnection({ host: "127.0.0.1", port: 18081 })
      socket.setTimeout(250)
      const finish = (ok) => { socket.destroy(); done(ok) }
      socket.once("connect", () => finish(true))
      socket.once("error", () => finish(false))
      socket.once("timeout", () => finish(false))
    })
    if (listening && existsSync(ca)) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error("Inspection proxy did not become ready with its CA within 30 seconds.")
}

async function stop(proxy) {
  if (!proxy || proxy.exitCode !== null) return
  await new Promise((done) => {
    const timer = setTimeout(() => proxy.kill("SIGKILL"), 5_000)
    proxy.once("close", () => { clearTimeout(timer); done() })
    proxy.kill("SIGTERM")
  })
}

async function main() {
  const cwd = resolve(process.argv[2] ?? ".")
  const privateDir = mkdtempSync(join(tmpdir(), "license-inspection-"))
  const bundle = join(privateDir, "mitm-check.cjs")
  const ca = join(privateDir, "conf", "mitmproxy-ca-cert.pem")
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const proxyEnv = { ...env }
  delete proxyEnv.KEY
  let proxy
  let electron = "unavailable"
  let mitmproxy = "unavailable"
  const results = {}
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim()
  try {
    electron = JSON.parse(readFileSync(join(cwd, "node_modules/electron/package.json"), "utf8")).version
    const version = await run("mitmdump", ["--version"], { env: proxyEnv })
    mitmproxy = /^Mitmproxy:\s+([\d.]+)$/m.exec(version.output)?.[1] ?? "unavailable"
    if (version.code !== 0 || mitmproxy === "unavailable") throw new Error("Cannot determine mitmproxy version.")
    const built = await run(join(cwd, "node_modules/.bin/esbuild"), ["scripts/license-mitm-check.ts", "--bundle", "--platform=node", "--format=cjs", "--external:electron", `--outfile=${bundle}`], { cwd, env: proxyEnv })
    if (built.code !== 0) throw new Error("Inspection script bundling failed.")
    async function start(blocked = false) {
      proxy = spawn("mitmdump", ["-q", "--listen-host", "127.0.0.1", "-p", "18081", "--set", `confdir=${join(privateDir, "conf")}`, ...(blocked ? ["-s", "scripts/license-mitm-block.py"] : [])], { cwd, env: proxyEnv, stdio: "ignore" })
      proxy.on("error", () => {})
      await ready(proxy, ca)
    }
    async function check(mode, state = "") {
      const result = await run("xvfb-run", ["-a", "node_modules/.bin/electron", "--no-sandbox", bundle], { cwd, env: { ...env, MODE: mode, CA_PEM: ca, CACHED_STATE: state } })
      results[mode] = inspect(mode, result.output, result.code)
      return result.output
    }
    await start()
    const trusted = await check("trusted")
    const states = trusted.split(/\r?\n/).filter((line) => line.startsWith("STATE "))
    if (!results.trusted.pass || states.length !== 1 || !states[0].slice(6)) {
      results.trusted.pass = false
      throw new Error("Trusted inspection failed. Activation release must be confirmed before proceeding.")
    }
    // State remains in memory and is passed only in the blocked child's environment.
    await check("untrusted")
    await stop(proxy)
    await start(true)
    await check("blocked", states[0].slice(6))
  } finally {
    await stop(proxy)
    rmSync(privateDir, { recursive: true, force: true })
    const rows = Object.entries(expected).map(([mode, lines]) => {
      const result = results[mode]
      return `| ${mode} | ${lines.map((line) => line.slice(6)).join("; ")} | ${result?.got ?? "not run"} | ${result?.pass ? "pass" : "fail"} |`
    })
    const summary = [`Commit checked: ${commit}`, `Electron: ${electron}. mitmproxy: ${mitmproxy}.`, "", "| Mode | Expected | Got | Result |", "|---|---|---|---|", ...rows, ""].join("\n")
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
    console.log(summary)
  }
  if (Object.values(results).length !== 3 || Object.values(results).some((result) => !result.pass)) throw new Error("HTTPS inspection results did not match expectations.")
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
