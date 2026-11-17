/**
 * A local stand-in for the parts of login.microsoftonline.com a first sign-in uses: instance
 * discovery, OpenID discovery, the signing keys, the authorize page and the token endpoint.
 *
 * It answers like Microsoft does for a public client with PKCE: the authorize page posts the
 * code, the state and client_info to the redirect URI as a form (response_mode form_post), and the
 * token endpoint checks the code, the client, the redirect URI and the PKCE verifier before it
 * issues an RS256 ID token signed with a key published in its own JWKS, with Microsoft's issuer,
 * audience, tenant and nonce claims. Nothing in the app is told about it: the runner's hosts file
 * and trust store send the app's traffic here (see runner.mjs).
 *
 * It also answers the two licensing requests that follow a first sign-in (LICENSE_HOST), so the
 * test sends nothing to the production licensing service.
 *
 * Only a browser the harness drives completes a sign-in: the authorize page posts an answer only
 * when the request carries the harness cookie. Any other browser on the machine (the app also
 * opens the system default browser) gets a page that does nothing.
 */
import { createServer } from "node:https"
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto"

export const LOGIN_HOST = "login.microsoftonline.com"
/** The licensing service the app checks a new tenant with after the sign-in. */
export const LICENSE_HOST = "www.tenuvault.com"

/**
 * The licensing service's answers to what the app asks after a first sign-in, as production gave
 * them on 2026-11-15 for an ID token it cannot verify: the health policy, and 401 invalid_token on
 * the organization license route. The app then goes on as Community, as it does against
 * production. Production licensing is checked by the license canary, not by this test.
 */
const LICENSE_HEALTH = {
  ok: true,
  missing: [],
  organizationLicenses: { ok: true, missing: [] },
  tenantTrials: { days: 14, extensionDays: 14, extensionWindowDays: 5, extensionGraceDays: 14, enabled: true, ok: true, missing: [] },
  desktopFeedback: { ok: true, missing: [] },
}
export const HARNESS_COOKIE = "tenuvault_sign_in_e2e"

const b64url = (value) => Buffer.from(value).toString("base64url")
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * Starts the stand-in on port `port` (127.0.0.1, or every address on macOS) with the TLS key and certificate for LOGIN_HOST.
 * `account` is the user every sign-in signs in as. Returns the server, its request log, and
 * `setMode` to choose how the next authorize request answers: "code" (a normal sign-in),
 * "wrong-state" (a code with a state that is not the app's) or "deny" (error=access_denied).
 */
export async function startStandIn({ key, cert, port = 443, tenantId, clientId, account }) {
  const log = []
  const record = (line) => log.push(`${new Date().toISOString()} ${line}`)
  const secret = randomBytes(16).toString("hex")
  let mode = "code"
  const codes = new Map()
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const kid = randomBytes(8).toString("hex")
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, kty: "RSA", use: "sig", alg: "RS256" }
  const oid = randomUUID()
  const clientInfo = b64url(JSON.stringify({ uid: oid, utid: tenantId }))

  const jwt = (claims) => {
    const header = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid }))
    const body = b64url(JSON.stringify(claims))
    return `${header}.${body}.${sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url")}`
  }

  const openIdConfiguration = (tenant) => {
    const base = `https://${LOGIN_HOST}/${tenant}`
    return {
      token_endpoint: `${base}/oauth2/v2.0/token`,
      token_endpoint_auth_methods_supported: ["client_secret_post", "private_key_jwt", "client_secret_basic"],
      jwks_uri: `https://${LOGIN_HOST}/${tenant}/discovery/v2.0/keys`,
      response_modes_supported: ["query", "fragment", "form_post"],
      subject_types_supported: ["pairwise"],
      id_token_signing_alg_values_supported: ["RS256"],
      response_types_supported: ["code", "id_token", "code id_token", "id_token token"],
      scopes_supported: ["openid", "profile", "email", "offline_access"],
      issuer: `https://${LOGIN_HOST}/${tenantId}/v2.0`,
      request_uri_parameter_supported: false,
      userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
      authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
      device_authorization_endpoint: `${base}/oauth2/v2.0/devicecode`,
      http_logout_supported: true,
      frontchannel_logout_supported: true,
      end_session_endpoint: `${base}/oauth2/v2.0/logout`,
      claims_supported: ["sub", "iss", "aud", "exp", "iat", "auth_time", "acr", "nonce", "preferred_username", "name", "tid", "ver", "at_hash", "c_hash", "email"],
      kerberos_endpoint: `${base}/kerberos`,
      tenant_region_scope: "EU",
      cloud_instance_name: "microsoftonline.com",
      cloud_graph_host_name: "graph.windows.net",
      msgraph_host: "graph.microsoft.com",
      rbac_url: "https://pas.windows.net",
    }
  }

  const json = (response, status, body) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
    response.end(JSON.stringify(body))
  }
  const html = (response, status, body) => {
    response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Sign in stand-in</title></head>${body}</html>`)
  }
  const tokenError = (response, error, description) => {
    record(`token refused: ${error} ${description}`)
    json(response, 400, { error, error_description: `${description}\r\nTrace ID: ${randomUUID()}`, error_codes: [Number(/AADSTS(\d+)/.exec(description)?.[1] ?? 0)], timestamp: new Date().toISOString() })
  }

  const authorize = (url, request, response) => {
    const params = url.searchParams
    const cookies = Object.fromEntries((request.headers.cookie ?? "").split(";").map((part) => part.trim().split("=")).filter((pair) => pair.length === 2))
    if (cookies[HARNESS_COOKIE] !== secret) {
      record("authorize without the harness cookie: answered with a page that does nothing")
      return html(response, 200, "<body><p>This sign-in is handled by the test harness.</p></body>")
    }
    const redirectUri = params.get("redirect_uri") ?? ""
    const problems = []
    if (params.get("client_id") !== clientId) problems.push("client_id")
    if (params.get("response_type") !== "code") problems.push("response_type")
    if (params.get("response_mode") !== "form_post") problems.push("response_mode")
    if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) problems.push("code_challenge")
    if (!params.get("state")) problems.push("state")
    if (!/^http:\/\/localhost:\d+\/?$/.test(redirectUri)) problems.push("redirect_uri")
    if (problems.length) {
      record(`authorize refused, unexpected ${problems.join(", ")}: ${url.search}`)
      return html(response, 400, `<body><p>AADSTS900144: unexpected ${escapeHtml(problems.join(", "))}</p></body>`)
    }
    const fields = { state: params.get("state") }
    if (mode === "deny") {
      Object.assign(fields, { error: "access_denied", error_description: "AADSTS65004: User declined to consent to access the app." })
    } else {
      const code = randomBytes(32).toString("base64url")
      codes.set(code, { challenge: params.get("code_challenge"), redirectUri, nonce: params.get("nonce"), scope: params.get("scope") ?? "" })
      Object.assign(fields, { code, client_info: clientInfo, session_state: randomUUID() })
      if (mode === "wrong-state") fields.state = randomBytes(32).toString("base64url")
    }
    record(`authorize answered (${mode}) to ${redirectUri}`)
    const inputs = Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join("")
    // As Microsoft's form_post answer does: a form the page submits as soon as it loads.
    html(response, 200, `<body onload="document.forms[0].submit()"><form method="POST" action="${escapeHtml(redirectUri)}">${inputs}<noscript><button>Continue</button></noscript></form></body>`)
  }

  const token = async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
    if (body.get("grant_type") !== "authorization_code") return tokenError(response, "unsupported_grant_type", "AADSTS70003: The app requested an unsupported grant type.")
    if (body.get("client_id") !== clientId) return tokenError(response, "unauthorized_client", "AADSTS700016: Application not found in the directory.")
    const entry = codes.get(body.get("code") ?? "")
    codes.delete(body.get("code") ?? "")
    if (!entry) return tokenError(response, "invalid_grant", "AADSTS70008: The provided authorization code is invalid or has expired.")
    if (body.get("redirect_uri") !== entry.redirectUri) return tokenError(response, "invalid_grant", "AADSTS50148: The redirect_uri does not match the one used in the authorization request.")
    const verifier = body.get("code_verifier") ?? ""
    if (createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) return tokenError(response, "invalid_grant", "AADSTS501481: The Code_Verifier does not match the code_challenge supplied in the authorization request.")
    const now = Math.floor(Date.now() / 1000)
    const common = { iat: now, nbf: now, exp: now + 3600, tid: tenantId, oid, sub: oid }
    const idToken = jwt({
      ...common,
      aud: clientId,
      iss: `https://${LOGIN_HOST}/${tenantId}/v2.0`,
      ...(entry.nonce ? { nonce: entry.nonce } : {}),
      name: account.name,
      preferred_username: account.username,
      ver: "2.0",
    })
    const accessToken = jwt({ ...common, aud: "https://graph.microsoft.com", iss: `https://sts.windows.net/${tenantId}/`, scp: "openid profile", upn: account.username, appid: clientId, ver: "1.0" })
    record("token issued for an authorization code with a matching PKCE verifier")
    json(response, 200, {
      token_type: "Bearer",
      scope: entry.scope.split(" ").filter((scope) => !["openid", "profile", "offline_access"].includes(scope)).join(" "),
      expires_in: 3599,
      ext_expires_in: 3599,
      access_token: accessToken,
      refresh_token: randomBytes(48).toString("base64url"),
      id_token: idToken,
      client_info: clientInfo,
    })
  }

  const licensing = async (url, request, response) => {
    if (request.method === "GET" && url.pathname === "/api/desktop-license/health") return json(response, 200, LICENSE_HEALTH)
    if (request.method === "POST" && url.pathname === "/api/desktop-license/tenant") {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { /* answered below */ }
      record(`licensing: tenant route, action ${String(body.action)}, answered 401 invalid_token`)
      return json(response, 401, { error: "The Microsoft sign-in could not be verified.", reason: "invalid_token" })
    }
    record(`licensing: not served: ${request.method} ${url.pathname}`)
    json(response, 404, { error: "not_found" })
  }

  const server = createServer({ key, cert }, (request, response) => {
    const url = new URL(request.url ?? "/", `https://${LOGIN_HOST}`)
    record(`${request.method} ${request.headers.host ?? ""}${url.pathname}`)
    const segments = url.pathname.split("/").filter(Boolean)
    const tenant = segments[0] ?? ""
    const rest = segments.slice(1).join("/")
    Promise.resolve().then(async () => {
      const host = request.headers.host?.split(":")[0]
      if (host === LICENSE_HOST) return licensing(url, request, response)
      if (host !== LOGIN_HOST) return json(response, 421, { error: "misdirected_request" })
      if (request.method === "GET" && tenant === "common" && rest === "discovery/instance") {
        return json(response, 200, {
          tenant_discovery_endpoint: `https://${LOGIN_HOST}/${tenantId}/v2.0/.well-known/openid-configuration`,
          "api-version": "1.1",
          metadata: [{ preferred_network: LOGIN_HOST, preferred_cache: "login.windows.net", aliases: [LOGIN_HOST, "login.windows.net", "login.microsoft.com", "sts.windows.net"] }],
        })
      }
      if (request.method === "GET" && rest === "v2.0/.well-known/openid-configuration") return json(response, 200, openIdConfiguration(tenant))
      if (request.method === "GET" && rest === "discovery/v2.0/keys") return json(response, 200, { keys: [jwk] })
      if (request.method === "GET" && rest === "oauth2/v2.0/authorize") return authorize(url, request, response)
      if (request.method === "POST" && rest === "oauth2/v2.0/token") return token(request, response)
      record(`not served: ${request.method} ${url.pathname}`)
      json(response, 404, { error: "not_found" })
    }).catch((error) => {
      record(`error: ${error?.stack ?? error}`)
      if (!response.headersSent) json(response, 500, { error: "server_error" })
    })
  })
  server.on("tlsClientError", (error) => record(`TLS error: ${error.message}`))
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    // macOS lets a process without root listen on a port below 1024 only on the wildcard address.
    server.listen(port, process.platform === "darwin" ? "0.0.0.0" : "127.0.0.1", resolve)
  })
  return {
    server,
    log,
    record,
    /** The cookie a harness browser sends so that the authorize page answers. */
    cookie: { name: HARNESS_COOKIE, value: secret, domain: LOGIN_HOST, path: "/", secure: true, httpOnly: true, sameSite: "None" },
    setMode: (next) => { mode = next },
    // Browsers keep connections open; closing waits for none of them.
    close: () => new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
