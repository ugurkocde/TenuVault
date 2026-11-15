import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { permissionRemediation } from "../src/renderer/lib/connection-health-view"

const tenantId = "11111111-1111-1111-1111-111111111111"
const clientId = "22222222-2222-2222-2222-222222222222"
const graphAppId = "00000003-0000-0000-c000-000000000000"
const permissionIds = ["policy-permission-id", "group-permission-id"]
const consentFailure = "Consent may have changed because the request may have been applied; check consent in Entra before retrying."
const graphId = "33333333-3333-3333-3333-333333333333"
const clientObjectId = "44444444-4444-4444-4444-444444444444"
const grant = { id: "existing-grant", clientId: clientObjectId, resourceId: graphId, consentType: "AllPrincipals", scope: "User.Read Policy.Read.All" }
const unrelated = { ...grant, id: "other-api-grant", resourceId: "other-api", scope: "Other.Read" }
const folders: string[] = []
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })))

function shell(shell: string, failure = "", individual = false, existing = true, options: { declaredScopes?: string[]; runs?: number } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "tv-cli-")); folders.push(folder)
  const log = join(folder, "calls.jsonl")
  const stateFile = join(folder, "state.json")
  const initial = {
    grants: [unrelated, ...(existing ? [grant] : []), ...(individual ? [{ ...grant, id: "individual-grant", consentType: "Principal" }] : [])],
    requiredResourceAccess: [
      { resourceAppId: "other-api", resourceAccess: [{ id: permissionIds[0], type: "Scope" }] },
      { resourceAppId: graphAppId, resourceAccess: [{ id: permissionIds[0], type: "Role" }, { id: "unrelated-permission-id", type: "Scope" }, ...(options.declaredScopes ?? []).map(id => ({ id, type: "Scope" }))] },
    ],
  }
  writeFileSync(stateFile, JSON.stringify(initial))
  writeFileSync(join(folder, "az"), `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(process.env.TV_CLI_LOG, JSON.stringify(args) + "\\n")
const state = JSON.parse(fs.readFileSync(process.env.TV_CLI_STATE, "utf8"))
const save = () => fs.writeFileSync(process.env.TV_CLI_STATE, JSON.stringify(state))
const value = flag => args[args.indexOf(flag) + 1]
const query = value("--query")
const step = args[0] === "login" ? "login" : args[0] === "account" ? "tenant" : args[0] === "rest" ? value("--method").toLowerCase() : args.includes("list-grants") ? query.includes("Principal']") ? "individual" : query.includes(".id") ? "grantId" : "existing" : args.includes("add") ? "add" : args.includes("grant") ? "grant" : query.includes("requiredResourceAccess") ? "declarations" : query.includes("oauth2PermissionScopes") ? "lookup" : value("--id") === "${clientId}" ? "client" : "graph"
// Model the old CLI's deletion before creation, so the regression detects consent loss.
if (step === "grant") { state.grants = state.grants.filter(g => g.resourceId !== "${graphId}"); save() }
if (process.env.TV_CLI_FAIL === "cancelled" && step === "login") process.exit(130)
if (process.env.TV_CLI_FAIL === step || (process.env.TV_CLI_FAIL === "consent" && ["grant", "patch", "post"].includes(step))) process.exit(1)
if (step === "tenant") console.log(process.env.TV_CLI_FAIL === "wrongTenant" ? "other-tenant" : "${tenantId}")
if (step === "graph" && process.env.TV_CLI_FAIL !== "emptyGraph") console.log("${graphId}")
if (step === "client" && process.env.TV_CLI_FAIL !== "emptyClient") console.log("${clientObjectId}")
const grants = state.grants.filter(g => g.resourceId === "${graphId}")
if (step === "individual") console.log(grants.filter(g => g.consentType === "Principal").length)
if (step === "grantId" && grants.length) console.log(grants[0].id)
if (step === "existing" && grants.length) console.log(grants[0].scope)
if (step === "declarations") {
  if (value("--id") !== "${clientId}" || query !== "requiredResourceAccess[?resourceAppId=='${graphAppId}'].resourceAccess[] | [?type=='Scope'].id") process.exit(1)
  for (const resource of state.requiredResourceAccess.filter(r => r.resourceAppId === "${graphAppId}")) {
    for (const access of resource.resourceAccess.filter(a => a.type === "Scope")) console.log(access.id)
  }
}
// Azure CLI appends declarations without deduplicating existing (id, type) pairs.
if (step === "add") {
  const resourceAppId = value("--api")
  let resource = state.requiredResourceAccess.find(r => r.resourceAppId === resourceAppId)
  if (!resource) state.requiredResourceAccess.push(resource = { resourceAppId, resourceAccess: [] })
  const [id, type] = value("--api-permissions").split("=")
  resource.resourceAccess.push({ id, type })
  save()
}
if (step === "lookup" && process.env.TV_CLI_FAIL !== "emptyLookup") console.log(query.includes("Policy.Read.All") ? "policy-permission-id" : "group-permission-id")
if (step === "patch" || step === "post") {
  if (value("--headers") !== "Content-Type=application/json") process.exit(1)
  const body = JSON.parse(value("--body"))
  if (step === "patch") {
    const target = state.grants.find(g => value("--url").endsWith("/" + g.id))
    if (!target) process.exit(1)
    Object.assign(target, body)
  } else state.grants.push({ id: "new-grant", ...body })
  save()
  if (process.env.TV_CLI_FAIL === "timeout") { console.error("Request timed out"); process.exit(1) }
}
`)
  chmodSync(join(folder, "az"), 0o755)
  const fix = permissionRemediation({ tenantId, clientId }, ["Policy.Read.All", "Group.Read.All"])
  const results = Array.from({ length: options.runs ?? 1 }, () => spawnSync(shell, ["-c", fix.commands], { encoding: "utf8", env: { ...process.env, PATH: `${folder}:${process.env.PATH}`, TV_CLI_LOG: log, TV_CLI_STATE: stateFile, TV_CLI_FAIL: failure } }))
  return { result: results.at(-1)!, results, initial, state: JSON.parse(readFileSync(stateFile, "utf8")) as typeof initial, calls: readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) }
}

it.each(["bash", "zsh"])("%s stops all later commands if login fails or is cancelled", shellName => {
  for (const failure of ["login", "cancelled"]) {
    const { result, calls } = shell(shellName, failure)
    expect(result.status).not.toBe(0)
    expect(calls).toEqual([["login", "--tenant", tenantId, "--allow-no-subscriptions"]])
  }
})
it.each(["tenant", "wrongTenant", "graph", "emptyGraph", "individual", "grantId", "existing", "lookup", "emptyLookup", "add"])("stops before any later mutation after %s fails", failure => {
  const { result, calls, initial, state } = shell("bash", failure)
  expect(result.status).not.toBe(0)
  expect(calls.some(args => args[0] === "rest" || args.includes("grant"))).toBe(false)
  expect(state).toEqual(initial)
  if (failure !== "add") expect(calls.some(args => args.includes("add"))).toBe(false)
  if (failure === "wrongTenant") expect(calls).toHaveLength(2)
})
it.each(["bash", "zsh"])("%s updates existing consent in place with the union and leaves other grants alone", shellName => {
  const { result, calls, state } = shell(shellName)
  expect(result.status, result.stderr).toBe(0)
  expect(state.grants).toEqual([unrelated, { ...grant, scope: "Group.Read.All Policy.Read.All User.Read" }])
  const writes = calls.filter(args => args[0] === "rest")
  expect(writes).toEqual([["rest", "--method", "PATCH", "--url", `https://graph.microsoft.com/v1.0/oauth2PermissionGrants/${grant.id}`, "--headers", "Content-Type=application/json", "--body", JSON.stringify({ scope: "Group.Read.All Policy.Read.All User.Read" })]])
  expect(calls.filter(args => args.includes("add"))).toEqual(permissionIds.map(id => ["ad", "app", "permission", "add", "--id", clientId, "--api", "00000003-0000-0000-c000-000000000000", "--api-permissions", `${id}=Scope`]))
  expect(calls.findIndex(args => args[0] === "rest")).toBeGreaterThan(calls.findLastIndex(args => args.includes("add")))
  expect(calls.some(args => args.includes("grant") || args.includes("admin-consent"))).toBe(false)
})
it.each(["bash", "zsh"])("%s keeps every existing scope when the consent update fails", shellName => {
  const { result, calls, initial, state } = shell(shellName, "consent")
  expect(result.status).not.toBe(0)
  expect(state.grants).toEqual(initial.grants)
  expect(result.stderr).toContain(consentFailure)
  expect(calls.at(-1)).toContain("PATCH")
  expect(calls.filter(args => args[0] === "rest")).toHaveLength(1)
})
it.each(["bash", "zsh"])("%s stops for review before changing individual grants", shellName => {
  const { result, calls, initial, state } = shell(shellName, "", true)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("Individual Graph consent exists")
  expect(calls.some(args => args.includes("add") || args.includes("grant") || args[0] === "rest")).toBe(false)
  expect(state).toEqual(initial)
})
it.each(["bash", "zsh"])("%s creates one grant using service principal object IDs when no tenant-wide grant exists", shellName => {
  const { result, calls, state } = shell(shellName, "", false, false)
  expect(result.status, result.stderr).toBe(0)
  const body = { clientId: clientObjectId, consentType: "AllPrincipals", resourceId: graphId, scope: "Group.Read.All Policy.Read.All" }
  expect(calls.filter(args => args[0] === "rest")).toEqual([["rest", "--method", "POST", "--url", "https://graph.microsoft.com/v1.0/oauth2PermissionGrants", "--headers", "Content-Type=application/json", "--body", JSON.stringify(body)]])
  expect(state.grants).toEqual([unrelated, { id: "new-grant", ...body }])
  expect(calls.some(args => args.includes("grant") || args.includes("admin-consent"))).toBe(false)
})
it.each(["bash", "zsh"])("%s leaves consent unchanged when creating the grant fails", shellName => {
  const { result, calls, initial, state } = shell(shellName, "consent", false, false)
  expect(result.status).not.toBe(0)
  expect(state.grants).toEqual(initial.grants)
  expect(result.stderr).toContain(consentFailure)
  expect(calls.at(-1)).toContain("POST")
  expect(calls.filter(args => args[0] === "rest")).toHaveLength(1)
})
it.each(["client", "emptyClient"])("stops without creating consent after %s lookup fails", failure => {
  const { result, calls, initial, state } = shell("bash", failure, false, false)
  expect(result.status).not.toBe(0)
  expect(calls.some(args => args[0] === "rest")).toBe(false)
  expect(state.grants).toEqual(initial.grants)
})

it.each(["bash", "zsh"])("%s stops before changing declarations or consent when the registration read fails", shellName => {
  const { result, calls, initial, state } = shell(shellName, "declarations")
  expect(result.status).not.toBe(0)
  expect(calls.some(args => args.includes("add") || args[0] === "rest")).toBe(false)
  expect(state).toEqual(initial)
})
it.each(["bash", "zsh"])("%s declares each Graph scope once across two runs while preserving other declarations", shellName => {
  const { results, calls, initial, state } = shell(shellName, "", false, true, { runs: 2 })
  for (const result of results) expect(result.status, result.stderr).toBe(0)
  expect(state.requiredResourceAccess).toEqual([
    initial.requiredResourceAccess[0],
    { ...initial.requiredResourceAccess[1], resourceAccess: [...initial.requiredResourceAccess[1]!.resourceAccess, ...permissionIds.map(id => ({ id, type: "Scope" }))] },
  ])
  const additions = calls.filter(args => args.includes("add"))
  expect(additions.map(args => args.at(-1))).toEqual(permissionIds.map(id => `${id}=Scope`))
  expect(calls.filter(args => args.includes("show") && args.includes("app"))).toHaveLength(2)
  expect(state.grants).toEqual([unrelated, { ...grant, scope: "Group.Read.All Policy.Read.All User.Read" }])
})
it.each(["bash", "zsh"])("%s skips a scope already declared on the registration and still consents it", shellName => {
  const { results, calls, initial, state } = shell(shellName, "", false, false, { declaredScopes: [permissionIds[0]!], runs: 2 })
  for (const result of results) expect(result.status, result.stderr).toBe(0)
  expect(calls.filter(args => args.includes("add")).map(args => args.at(-1))).toEqual([`${permissionIds[1]}=Scope`])
  expect(state.requiredResourceAccess).toEqual([
    initial.requiredResourceAccess[0],
    { ...initial.requiredResourceAccess[1], resourceAccess: [...initial.requiredResourceAccess[1]!.resourceAccess, { id: permissionIds[1], type: "Scope" }] },
  ])
  expect(calls.filter(args => args[0] === "rest").map(args => args[2])).toEqual(["POST", "PATCH"])
  expect(state.grants).toEqual([unrelated, { ...grant, id: "new-grant", scope: "Group.Read.All Policy.Read.All" }])
})
it.each(["bash", "zsh"])("%s treats a declared scope ID in other letter case as already declared", shellName => {
  const { results, calls } = shell(shellName, "", false, true, { declaredScopes: [permissionIds[0]!.toUpperCase()], runs: 2 })
  for (const result of results) expect(result.status, result.stderr).toBe(0)
  expect(calls.filter(args => args.includes("add")).map(args => args.at(-1))).toEqual([`${permissionIds[1]}=Scope`])
})
it.each(["bash", "zsh"])("%s warns to check Entra when a consent write is applied and then times out", shellName => {
  for (const existing of [true, false]) {
    const { result, calls, initial, state } = shell(shellName, "timeout", false, existing)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Request timed out")
    expect(result.stderr).toContain(consentFailure)
    expect(state.grants).toEqual([unrelated, { ...grant, id: existing ? grant.id : "new-grant", scope: existing ? "Group.Read.All Policy.Read.All User.Read" : "Group.Read.All Policy.Read.All" }])
    expect(state.requiredResourceAccess[0]).toEqual(initial.requiredResourceAccess[0])
    expect(calls.filter(args => args[0] === "rest")).toHaveLength(1)
    expect(calls.at(-1)).toContain(existing ? "PATCH" : "POST")
  }
})
it("includes the consent outcome warning in the copied administrator request", () => {
  const fix = permissionRemediation({ tenantId, clientId }, ["Policy.Read.All"])
  expect(fix.request).toContain(consentFailure)
})
