import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { permissionRemediation } from "../src/renderer/lib/connection-health-view"

const tenantId = "11111111-1111-1111-1111-111111111111"
const clientId = "22222222-2222-2222-2222-222222222222"
const folders: string[] = []
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })))

function shell(shell: string, failure = "", individual = false) {
  const folder = mkdtempSync(join(tmpdir(), "tv-cli-")); folders.push(folder)
  const log = join(folder, "calls.jsonl")
  writeFileSync(join(folder, "az"), `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(process.env.TV_CLI_LOG, JSON.stringify(args) + "\\n")
const step = args[0] === "login" ? "login" : args[0] === "account" ? "tenant" : args.includes("list-grants") ? args.includes("[?resourceId=='graph-object' && consentType=='Principal'] | length(@)") ? "individual" : "existing" : args.includes("add") ? "add" : args.includes("grant") ? "grant" : args.includes("oauth2PermissionScopes[?value=='Policy.Read.All'].id | [0]") ? "lookup" : "graph"
if (process.env.TV_CLI_FAIL === "cancelled" && step === "login") process.exit(130)
if (process.env.TV_CLI_FAIL === step) process.exit(1)
if (step === "tenant") console.log(process.env.TV_CLI_FAIL === "wrongTenant" ? "other-tenant" : "${tenantId}")
if (step === "graph") console.log("graph-object")
if (step === "individual") console.log(process.env.TV_CLI_INDIVIDUAL === "true" ? "1" : "0")
if (step === "existing" && process.env.TV_CLI_FAIL !== "noExisting") console.log("User.Read Policy.Read.All")
if (step === "lookup") { if (process.env.TV_CLI_FAIL !== "emptyLookup") console.log("permission-id") }
`)
  chmodSync(join(folder, "az"), 0o755)
  const fix = permissionRemediation({ tenantId, clientId }, ["Policy.Read.All", "Group.Read.All"])
  const result = spawnSync(shell, ["-c", fix.commands], { encoding: "utf8", env: { ...process.env, PATH: `${folder}:${process.env.PATH}`, TV_CLI_LOG: log, TV_CLI_FAIL: failure, TV_CLI_INDIVIDUAL: String(individual) } })
  return { result, calls: readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) }
}

it.each(["bash", "zsh"])("%s stops all later commands if login fails or is cancelled", shellName => {
  const { result, calls } = shell(shellName, "login")
  expect(result.status).not.toBe(0)
  expect(calls).toEqual([["login", "--tenant", tenantId, "--allow-no-subscriptions"]])
})
it.each(["tenant", "wrongTenant", "graph", "individual", "existing", "lookup", "emptyLookup", "add"])("stops before any later mutation after %s fails", failure => {
  const { result, calls } = shell("bash", failure)
  expect(result.status).not.toBe(0)
  expect(calls.some(args => args.includes("grant"))).toBe(false)
  if (failure !== "add") expect(calls.some(args => args.includes("add"))).toBe(false)
  if (failure === "wrongTenant") expect(calls).toHaveLength(2)
})
it("preserves existing tenant-wide scopes while consenting exactly the missing delegated scopes", () => {
  const { result, calls } = shell("bash")
  expect(result.status).toBe(0)
  const grant = calls.find(args => args.includes("grant"))!
  expect(grant).toEqual(["ad", "app", "permission", "grant", "--id", clientId, "--api", "00000003-0000-0000-c000-000000000000", "--consent-type", "AllPrincipals", "--scope", "Group.Read.All Policy.Read.All User.Read"])
  expect(calls.some(args => args.includes("admin-consent"))).toBe(false)
})
it("stops for review before replacing or broadening individual grants", () => {
  const { result, calls } = shell("bash", "", true)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("Individual Graph consent exists")
  expect(calls.some(args => args.includes("add") || args.includes("grant"))).toBe(false)
})

it("also stops after a cancelled login", () => {
  const { result, calls } = shell("bash", "cancelled")
  expect(result.status).not.toBe(0)
  expect(calls).toHaveLength(1)
})
it("creates only the missing scopes when there is no existing tenant-wide grant", () => {
  const { result, calls } = shell("zsh", "noExisting")
  expect(result.status).toBe(0)
  const grant = calls.find(args => args.includes("grant"))!
  expect(grant.at(-1)).toBe("Group.Read.All Policy.Read.All")
})
it("reports a failed grant as a failure", () => {
  expect(shell("bash", "grant").result.status).not.toBe(0)
})
