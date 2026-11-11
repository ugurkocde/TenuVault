import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { DESKTOP_APP_PERMISSIONS, parseSetupOutput } from "../src/shared/app-registration"

const override = process.env.TENUVAULT_TEST_POWERSHELL
const powershell = override || ["/usr/bin/pwsh", "/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", join(homedir(), ".local/bin/pwsh")].find(existsSync)
const script = resolve("resources/New-TenuVaultDesktopApp.ps1")
const tenantId = "11111111-1111-4111-8111-111111111111"
const clientId = "22222222-2222-4222-8222-222222222222"
const group = "33333333-3333-4333-8333-333333333333"
const source = readFileSync(script, "utf8")

it("keeps the setup script ASCII and free of module dependencies", () => {
  expect([...source].every(character => character.charCodeAt(0) < 128)).toBe(true)
  expect(source).not.toMatch(/(?:Install-Module|Import-Module|Connect-MgGraph|\w+-Mg\w+)/i)
})

describe.runIf(Boolean(powershell))("real setup script over HTTP", () => {
  it.each([script, resolve("test/fixtures/app-registration/setup-harness.ps1"), resolve("test/fixtures/app-registration/parse-script.ps1")])("parses %s with no edition-specific syntax", file => {
    const result = spawnSync(powershell!, ["-NoProfile", "-File", resolve("test/fixtures/app-registration/parse-script.ps1"), "-Script", file], { encoding: "utf8" })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  async function run(scenario = "default", args: Record<string, unknown> = {}) {
    const requests: { method: string; path: string; body: Record<string, unknown>; query: URLSearchParams; headers: Record<string, unknown> }[] = []
    let challenge = ""
    let redirect = ""
    let pkce = false
    let polls = 0
    let spAttempts = 0
    let grantAttempts = 0
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://localhost")
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString("utf8")
      const body = raw ? (req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : {}
      requests.push({ method: req.method!, path: url.pathname, body, query: url.searchParams, headers: req.headers })
      res.setHeader("Content-Type", "application/json")
      const send = (value: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)) }
      if (url.pathname.endsWith("/authorize")) {
        challenge = url.searchParams.get("code_challenge")!
        redirect = url.searchParams.get("redirect_uri")!
        const target = new URL(redirect)
        target.searchParams.set("state", url.searchParams.get("state")!)
        if (scenario === "declined") { target.searchParams.set("error", "access_denied"); target.searchParams.set("error_description", "Consent was declined.") }
        else target.searchParams.set("code", "test-code")
        if (scenario === "wrong-state") {
          const wrong = new URL(target); wrong.searchParams.set("state", "wrong")
          await fetch(wrong)
        }
        res.writeHead(302, { Location: target.toString() }); res.end(); return
      }
      if (url.pathname.endsWith("/devicecode")) return send({ device_code: "device", user_code: "ABCD", verification_uri: "https://microsoft.com/devicelogin", interval: 1, expires_in: 60 })
      if (url.pathname.endsWith("/token")) {
        if (body.device_code && polls++ === 0) return send({ error: "authorization_pending" }, 400)
        if (body.code) {
          pkce = createHash("sha256").update(body.code_verifier).digest("base64url") === challenge && body.redirect_uri === redirect
          if (!pkce) return send({ error: "invalid_grant" }, 400)
        }
        return send({ access_token: "test-access", id_token: `e30.${Buffer.from(JSON.stringify({ tid: tenantId, preferred_username: "admin@example.test" })).toString("base64url")}.` })
      }
      const path = url.pathname.replace("/graph.microsoft.com/v1.0", "")
      if (path === "/servicePrincipals" && req.method === "GET") {
        const appId = /'([^']+)'/.exec(url.searchParams.get("$filter")!)![1]
        return send({ value: [{ id: appId, appId, oauth2PermissionScopes: [...DESKTOP_APP_PERMISSIONS.flatMap(p => p.permissions), "Group.Read.All"].map((value, i) => ({ value, id: `scope-${i}` })) }] })
      }
      if (path === "/applications" && req.method === "GET") return send({ value: scenario === "existing" ? [{ appId: group }] : [] })
      if (path === "/applications" && req.method === "POST") return send({ id: "app-object", appId: clientId })
      if (path === "/servicePrincipals" && req.method === "POST") {
        if (scenario === "replication" && spAttempts++ < 2) return send({ error: { message: "appId does not reference a valid application object" } }, spAttempts === 1 ? 404 : 400)
        return send({ id: "app-sp" })
      }
      if (path === "/oauth2PermissionGrants" && scenario === "transient" && grantAttempts++ < 2) {
        res.setHeader("Retry-After", "2")
        return send({ error: { message: "Try again" } }, grantAttempts === 1 ? 429 : 503)
      }
      if (path === "/oauth2PermissionGrants" && scenario === "denied") return send({ error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" } }, 403)
      if (req.method === "DELETE" || req.method === "PATCH") { res.statusCode = 204; res.end(); return }
      send({ id: "grant" })
    })
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
    const dir = mkdtempSync(join(tmpdir(), "setup-test-"))
    const clipboard = join(dir, "clipboard.txt")
    const argumentFile = join(dir, "arguments.json")
    writeFileSync(argumentFile, JSON.stringify(args))
    try {
      const output = await new Promise<{ code: number | null; text: string }>((resolveRun, reject) => {
        const child = spawn(powershell!, ["-NoProfile", "-NonInteractive", "-File", resolve("test/fixtures/app-registration/setup-harness.ps1"), "-Server", `http://127.0.0.1:${(server.address() as { port: number }).port}`, "-Script", script, "-ClipboardFile", clipboard, "-ArgumentsFile", argumentFile])
        let text = ""
        child.stdout.on("data", chunk => { text += chunk })
        child.stderr.on("data", chunk => { text += chunk })
        const timeout = setTimeout(() => { child.kill(); reject(new Error(`Script timed out: ${text}`)) }, 35000)
        child.on("error", error => { clearTimeout(timeout); reject(error) })
        child.on("close", code => { clearTimeout(timeout); resolveRun({ code, text }) })
      })
      return { ...output, requests, pkce, polls, spAttempts, clipboard: existsSync(clipboard) ? readFileSync(clipboard, "utf8") : "" }
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }) }
  }

  it.each(["default", "tenant", "group", "optional", "device", "wrong-state", "replication", "existing", "unicode", "transient"])("completes %s setup", async scenario => {
    const args = scenario === "tenant" ? { TenantId: tenantId } : scenario === "group" ? { AllowedGroupId: group } : scenario === "optional" ? { IncludeGroupRead: true } : scenario === "device" ? { UseDeviceCode: true } : scenario === "unicode" ? { DisplayName: "TenuVault Caf\u00e9" } : {}
    const result = await run(scenario, args)
    expect(result.code, result.text).toBe(0)
    expect(parseSetupOutput(result.text)).toEqual({ tenantId, clientId })
    expect(parseSetupOutput(result.clipboard)).toEqual({ tenantId, clientId })
    const auth = result.requests.find(r => r.path.endsWith("/authorize"))
    if (scenario !== "device") {
      expect(result.pkce).toBe(true)
      expect(auth!.query.get("client_id")).toBe("14d82eec-204b-4c2f-b7e8-296a70dab67e")
      expect(auth!.query.get("response_type")).toBe("code")
      expect(auth!.query.get("response_mode")).toBe("query")
      expect(auth!.query.get("prompt")).toBe("select_account")
      expect(auth!.query.get("code_challenge_method")).toBe("S256")
      expect(auth!.query.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+$/)
      expect(auth!.path).toContain(scenario === "tenant" ? tenantId : "organizations")
      expect(auth!.query.get("scope")!.includes("AppRoleAssignment.ReadWrite.All")).toBe(scenario === "group")
    } else expect(result.polls).toBe(2)
    const app = result.requests.find(r => r.method === "POST" && r.path.endsWith("/applications"))!
    expect(app.body).toMatchObject({ signInAudience: "AzureADMyOrg", publicClient: { redirectUris: ["http://localhost"] } })
    if (scenario === "unicode") expect(app.body.displayName).toBe("TenuVault Caf\u00e9")
    expect(app.headers["content-type"]).toBe("application/json; charset=utf-8")
    const grants = result.requests.filter(r => r.path.endsWith("/oauth2PermissionGrants"))
    expect(grants).toHaveLength(scenario === "transient" ? 5 : 3)
    const createdSp = result.requests.find(r => r.method === "POST" && r.path.endsWith("/servicePrincipals"))!
    expect(createdSp.body).toEqual({ appId: clientId, tags: ["HideApp", "WindowsAzureActiveDirectoryIntegratedApp"] })
    if (scenario === "group") {
      expect(result.requests.find(r => r.path.endsWith("/appRoleAssignedTo"))!.body).toEqual({ principalId: group, resourceId: "app-sp", appRoleId: "00000000-0000-0000-0000-000000000000" })
      expect(result.requests.find(r => r.method === "PATCH")!.body).toEqual({ appRoleAssignmentRequired: true })
    }
    expect(grants[0]!.body).toMatchObject({ clientId: "app-sp", consentType: "AllPrincipals" })
    if (scenario === "optional") expect(grants[0]!.body.scope).toContain("Group.Read.All")
    expect(result.requests.some(r => r.path.endsWith("/appRoleAssignedTo"))).toBe(scenario === "group")
    if (scenario === "replication") expect(result.spAttempts).toBe(3)
    if (scenario === "existing") expect(result.text).toContain(`already exists (client id ${group})`)
  }, 45000)

  it("reports declined consent without Graph writes", async () => {
    const result = await run("declined")
    expect(result.code).toBe(1)
    expect(result.text).toContain("Consent was declined.")
    expect(result.requests.some(r => r.path.includes("graph.microsoft.com"))).toBe(false)
  }, 45000)
  it("rolls back when consent is forbidden and names the roles", async () => {
    const result = await run("denied")
    expect(result.code).toBe(1)
    expect(result.requests.some(r => r.method === "DELETE" && r.path.endsWith("/applications/app-object"))).toBe(true)
    for (const text of ["half-created app registration was removed", "admin@example.test", "Global Administrator", "Privileged Role Administrator", "Cloud Application Administrator"]) expect(result.text).toContain(text)
  }, 45000)
})
