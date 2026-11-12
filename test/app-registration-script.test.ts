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

// Every API gets its own service principal ID and its own permission IDs, so a mix-up between
// APIs in the app registration or in a consent grant shows up in the recorded requests.
const API_IDS: Record<string, string> = {
  "Microsoft Graph": "00000003-0000-0000-c000-000000000000",
  "Azure Service Management": "797f4846-ba00-4fd7-ba43-dac1f8f63013",
  "Azure Storage": "e406a681-f3d4-42a8-90b6-c2b029497af1",
}
const GRAPH_DEFAULTS = DESKTOP_APP_PERMISSIONS[0]!.permissions
// The opt-in permissions, in the order the script appends them.
const OPT_IN = { IncludeGroupRead: ["Group.Read.All"], IncludeConditionalAccessRestore: ["Policy.ReadWrite.ConditionalAccess"], IncludeAuditLog: ["AuditLog.Read.All"], IncludeNotifications: ["Mail.Send", "GroupMember.Read.All", "User.Read.All"] }
const offered = (appId: string) => (appId === API_IDS["Microsoft Graph"] ? [...GRAPH_DEFAULTS, ...Object.values(OPT_IN).flat()] : ["user_impersonation"])
const scopeId = (appId: string, value: string) => `${appId}/${value}`
const spId = (appId: string) => `sp-${appId}`

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
    const requests: { method: string; path: string; body: Record<string, unknown>; query: URLSearchParams; headers: Record<string, unknown>; status: number }[] = []
    let challenge = ""
    let redirect = ""
    let pkce = false
    let polls = 0
    let spAttempts = 0
    let grantAttempts = 0
    let readFailures = 0
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://localhost")
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString("utf8")
      const body = raw ? (req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : {}
      const entry = { method: req.method!, path: url.pathname, body, query: url.searchParams, headers: req.headers, status: 200 }
      requests.push(entry)
      res.setHeader("Content-Type", "application/json")
      const send = (value: unknown, status = 200) => { entry.status = status; res.statusCode = status; res.end(JSON.stringify(value)) }
      if (url.pathname.endsWith("/authorize")) {
        challenge = url.searchParams.get("code_challenge")!
        redirect = url.searchParams.get("redirect_uri")!
        const target = new URL(redirect)
        target.searchParams.set("state", url.searchParams.get("state")!)
        if (scenario === "declined") { target.searchParams.set("error", "access_denied"); target.searchParams.set("error_description", "Consent was declined.") }
        else if (scenario === "ca-blocked") { target.searchParams.set("error", "access_denied"); target.searchParams.set("error_description", "AADSTS53003: Access has been blocked by Conditional Access policies.") }
        else if (scenario === "app-disabled") { target.searchParams.set("error", "unauthorized_client"); target.searchParams.set("error_description", "AADSTS7000112: Application '14d82eec-204b-4c2f-b7e8-296a70dab67e'(Microsoft Graph Command Line Tools) is disabled.") }
        else target.searchParams.set("code", "test-code")
        if (scenario === "wrong-state") {
          const wrong = new URL(target); wrong.searchParams.set("state", "wrong")
          await fetch(wrong)
        }
        res.writeHead(302, { Location: target.toString() }); res.end(); return
      }
      if (url.pathname.endsWith("/devicecode")) return send({ device_code: "device", user_code: "ABCD", verification_uri: "https://microsoft.com/devicelogin", interval: 1, expires_in: 60 })
      if (url.pathname.endsWith("/token")) {
        if (body.device_code) {
          polls++
          if (scenario === "device-declined") return send({ error: "authorization_declined", error_description: "The user declined." }, 400)
          if (scenario === "device-expired") return send({ error: "expired_token", error_description: "The code expired." }, 400)
          if (polls === 1) return send({ error: scenario === "device-slow" ? "slow_down" : "authorization_pending" }, 400)
        }
        if (body.code) {
          pkce = createHash("sha256").update(body.code_verifier).digest("base64url") === challenge && body.redirect_uri === redirect
          if (!pkce) return send({ error: "invalid_grant" }, 400)
        }
        return send({ access_token: "test-access", id_token: `e30.${Buffer.from(JSON.stringify({ tid: tenantId, preferred_username: "admin@example.test" })).toString("base64url")}.` })
      }
      const path = url.pathname.replace("/graph.microsoft.com/v1.0", "")
      if (path === "/servicePrincipals" && req.method === "GET") {
        if (scenario === "transient" && readFailures++ < 1) return send({ error: { message: "Service unavailable" } }, 503)
        const appId = /'([^']+)'/.exec(url.searchParams.get("$filter")!)![1]!
        return send({ value: [{ id: spId(appId), appId, oauth2PermissionScopes: offered(appId).map(value => ({ value, id: scopeId(appId, value) })) }] })
      }
      if (path === "/applications" && req.method === "GET") return send({ value: scenario === "existing" ? [{ appId: group }] : [] })
      if (path === "/applications" && req.method === "POST") return send({ id: "app-object", appId: clientId })
      if (path === "/servicePrincipals" && req.method === "POST") {
        if (scenario === "replication" && spAttempts++ < 2) return send({ error: { message: "appId does not reference a valid application object" } }, spAttempts === 1 ? 404 : 400)
        return send({ id: "app-sp" })
      }
      if (path === "/oauth2PermissionGrants" && scenario === "transient" && grantAttempts++ < 1) {
        res.setHeader("Retry-After", "2")
        return send({ error: { message: "Try again" } }, 429)
      }
      if (path === "/oauth2PermissionGrants" && scenario === "server-error") return send({ error: { message: "Internal server error" } }, 500)
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

  it.each(["default", "tenant", "group", "optional", "all-optional", "device", "device-slow", "wrong-state", "replication", "existing", "unicode", "transient"])("completes %s setup", async scenario => {
    const device = scenario.startsWith("device")
    const switches = scenario === "optional" ? ["IncludeGroupRead"] : scenario === "all-optional" ? Object.keys(OPT_IN) : []
    const args: Record<string, unknown> = scenario === "tenant" ? { TenantId: tenantId } : scenario === "group" ? { AllowedGroupId: group } : device ? { UseDeviceCode: true } : scenario === "unicode" ? { DisplayName: "TenuVault Caf\u00e9" } : Object.fromEntries(switches.map(name => [name, true]))
    const result = await run(scenario, args)
    expect(result.code, result.text).toBe(0)
    expect(parseSetupOutput(result.text)).toEqual({ tenantId, clientId })
    expect(parseSetupOutput(result.clipboard)).toEqual({ tenantId, clientId })
    const auth = result.requests.find(r => r.path.endsWith("/authorize"))
    if (!device) {
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

    // The app registration asks for each API's own permissions, and each consent grant goes to
    // that API's service principal.
    const graphScopes = [...GRAPH_DEFAULTS, ...switches.flatMap(name => OPT_IN[name as keyof typeof OPT_IN])]
    const scopesOf = (api: string) => (api === "Microsoft Graph" ? graphScopes : ["user_impersonation"])
    const app = result.requests.find(r => r.method === "POST" && r.path.endsWith("/applications"))!
    expect(app.body).toMatchObject({ signInAudience: "AzureADMyOrg", publicClient: { redirectUris: ["http://localhost"] }, notes: "Used by the TenuVault desktop app. Delegated permissions only, no credentials." })
    expect(app.body.displayName).toBe(scenario === "unicode" ? "TenuVault Caf\u00e9" : "TenuVault Desktop")
    expect(app.body.requiredResourceAccess).toEqual(DESKTOP_APP_PERMISSIONS.map(({ api }) => ({
      resourceAppId: API_IDS[api],
      resourceAccess: scopesOf(api).map(value => ({ id: scopeId(API_IDS[api]!, value), type: "Scope" })),
    })))
    expect(app.headers["content-type"]).toBe("application/json; charset=utf-8")
    const createdSp = result.requests.find(r => r.method === "POST" && r.path.endsWith("/servicePrincipals"))!
    expect(createdSp.body).toEqual({ appId: clientId, tags: ["HideApp", "WindowsAzureActiveDirectoryIntegratedApp"] })
    const granted = result.requests.filter(r => r.path.endsWith("/oauth2PermissionGrants") && r.status === 200)
    expect(granted.map(r => r.body)).toEqual(DESKTOP_APP_PERMISSIONS.map(({ api }) => ({
      clientId: "app-sp",
      consentType: "AllPrincipals",
      resourceId: spId(API_IDS[api]!),
      scope: scopesOf(api).join(" "),
    })))

    if (scenario === "group") {
      expect(result.requests.find(r => r.path.endsWith("/appRoleAssignedTo"))!.body).toEqual({ principalId: group, resourceId: "app-sp", appRoleId: "00000000-0000-0000-0000-000000000000" })
      expect(result.requests.find(r => r.method === "PATCH")!.body).toEqual({ appRoleAssignmentRequired: true })
    }
    expect(result.requests.some(r => r.path.endsWith("/appRoleAssignedTo"))).toBe(scenario === "group")
    if (scenario === "replication") expect(result.spAttempts).toBe(3)
    if (scenario === "existing") expect(result.text).toContain(`already exists (client id ${group})`)
    if (scenario === "transient") {
      // A read that met a server error and a throttled write are both repeated.
      expect(result.requests.filter(r => r.status === 503 && r.method === "GET")).toHaveLength(1)
      expect(result.requests.filter(r => r.status === 429 && r.path.endsWith("/oauth2PermissionGrants"))).toHaveLength(1)
    }
  }, 45000)

  it.each([["device-declined", "Device code sign-in was declined"], ["device-expired", "Device code expired"]])("stops a %s sign-in without Graph requests", async (scenario, message) => {
    const result = await run(scenario, { UseDeviceCode: true })
    expect(result.code).toBe(1)
    expect(result.text).toContain(message)
    expect(result.text).toContain("Nothing was changed.")
    expect(result.requests.some(r => r.path.includes("graph.microsoft.com"))).toBe(false)
  }, 45000)

  it("does not repeat a write that met a server error, and rolls back", async () => {
    // The write may have been carried out, so repeating it could create a second object.
    const result = await run("server-error")
    expect(result.code).toBe(1)
    expect(result.requests.filter(r => r.method === "POST" && r.path.endsWith("/oauth2PermissionGrants"))).toHaveLength(1)
    expect(result.requests.some(r => r.method === "DELETE" && r.path.endsWith("/applications/app-object"))).toBe(true)
    expect(result.text).toContain("half-created app registration was removed again")
  }, 45000)

  it("reports declined consent without Graph writes", async () => {
    const result = await run("declined")
    expect(result.code).toBe(1)
    expect(result.text).toContain("Consent was declined.")
    expect(result.requests.some(r => r.path.includes("graph.microsoft.com"))).toBe(false)
  }, 45000)
  it("points to the manual route when the tenant has turned Microsoft Graph Command Line Tools off", async () => {
    const result = await run("app-disabled")
    expect(result.code).toBe(1)
    expect(result.text).toContain("AADSTS7000112")
    expect(result.text).toContain("Create the app registration by hand instead: https://docs.tenuvault.com/getting-started/app-registration/#create-the-app-registration-manually")
    expect(result.requests.some(r => r.path.includes("graph.microsoft.com"))).toBe(false)
  }, 45000)
  it("names both ways on when Conditional Access blocks the script's sign-in", async () => {
    const result = await run("ca-blocked")
    expect(result.code).toBe(1)
    const text = result.text.replace(/\s+/g, " ")
    expect(text).toContain("If it asks for a compliant device or an allowed location, sign in from one and run the script again.")
    expect(text).toContain("create the app registration by hand instead: https://docs.tenuvault.com/getting-started/app-registration/#create-the-app-registration-manually")
    expect(result.requests.some(r => r.path.includes("graph.microsoft.com"))).toBe(false)
  }, 45000)
  it("rolls back when consent is forbidden and names the roles", async () => {
    const result = await run("denied")
    expect(result.code).toBe(1)
    expect(result.requests.some(r => r.method === "DELETE" && r.path.endsWith("/applications/app-object"))).toBe(true)
    for (const text of ["half-created app registration was removed again", "admin@example.test", "Global Administrator", "Cloud Application Administrator", "Application Administrator"]) expect(result.text).toContain(text)
  }, 45000)
})
