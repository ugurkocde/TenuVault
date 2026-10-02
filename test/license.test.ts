import { generateKeyPairSync, sign } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CLOCK_TOLERANCE_MS,
  FAILURE_COOLDOWN_MS,
  LicenseService,
  entitlementCurrent,
  type LicenseServiceOptions,
} from "../src/main/license/service"
import { memoryStore } from "./helpers"

const { publicKey, privateKey } = generateKeyPairSync("ed25519")
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString()

const TENANT = "11111111-2222-3333-4444-555555555555"
const TENANT_B = "22222222-3333-4444-5555-666666666666"
const INSTALL = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const APP_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f"
const DAY = 24 * 60 * 60_000
const T0 = Date.UTC(2026, 8, 1, 12, 0, 0)

function token(overrides: Record<string, unknown> = {}, key = privateKey): string {
  const iat = Math.floor(T0 / 1000)
  const payload = {
    v: 1,
    sub: "sub",
    act: "act-1",
    plan: "pro",
    tenantId: TENANT,
    installId: INSTALL,
    tenants: 1,
    status: "granted",
    iat,
    exp: iat + 14 * 24 * 60 * 60,
    ...overrides,
  }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${body}.${sign(null, Buffer.from(body), key).toString("base64url")}`
}

type Store = ReturnType<typeof memoryStore>
type Call = { action: string; body: Record<string, unknown> }

let store: Store
let calls: Call[]
let answer: (call: Call) => Response | Promise<Response>

const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const call = {
    action: String(url).split("/").pop() ?? "",
    body: JSON.parse(init?.body as string) as Record<string, unknown>,
  }
  calls.push(call)
  return answer(call)
}) as unknown as typeof fetch

function service(options: Partial<LicenseServiceOptions> & { idTokenValue?: string | null } = {}) {
  const { idTokenValue = "id.token.value", ...rest } = options
  return new LicenseService({
    store,
    persist: true,
    publicKey: publicPem,
    apiBase: "http://127.0.0.1:9",
    appVersion: "0.0.0-test",
    platform: "darwin",
    fetch: fetchMock,
    idToken: async (tenant) => ([TENANT, TENANT_B].includes(tenant) ? idTokenValue : null),
    clientId: (tenant) => ([TENANT, TENANT_B].includes(tenant) ? APP_ID : null),
    ...rest,
  })
}

// A token for the tenant of the request, issued now.
const fresh = (act: string, extra: Record<string, unknown> = {}) =>
  token({ act, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 14 * 86400, ...extra })
const granted = (act: string, extra: Record<string, unknown> = {}, claims: Record<string, unknown> = {}) =>
  Response.json({ token: fresh(act, claims), activationId: act, plan: "pro", ...extra })
const denied = (reason: string) => Response.json({ reason }, { status: 403 })

function storeLicense(tokenValue: string, seen?: number): void {
  store.set(
    "license.state",
    JSON.stringify({
      key: "TEST-LICENSE-KEY",
      activations: { [TENANT]: { activationId: "act-1", token: tokenValue } },
      ...(seen !== undefined ? { seen } : {}),
    }),
  )
}

const entitled = (license: LicenseService, tenant = TENANT) =>
  license.status([tenant]).tenants.find((t) => t.tenantId === tenant)?.entitled ?? false

beforeEach(() => {
  store = memoryStore()
  store.set("license.installId", INSTALL)
  calls = []
  answer = () => Response.json({ reason: "unexpected" }, { status: 500 })
})

describe("entitlementCurrent", () => {
  const exp = Math.floor(T0 / 1000) + 3600

  it("requires a granted status and a finite expiry", () => {
    expect(entitlementCurrent({ exp, status: "granted" }, T0, T0)).toBe(true)
    expect(entitlementCurrent({ exp, status: "revoked" as "granted" }, T0, T0)).toBe(false)
    expect(entitlementCurrent({ exp: `${exp}` as unknown as number, status: "granted" }, T0, T0)).toBe(false)
    expect(entitlementCurrent({ exp: Infinity, status: "granted" }, T0, T0)).toBe(false)
  })

  it("rejects a clock set back beyond the tolerance", () => {
    expect(entitlementCurrent({ exp, status: "granted" }, T0, T0 + CLOCK_TOLERANCE_MS + 1)).toBe(false)
    expect(entitlementCurrent({ exp, status: "granted" }, T0, T0 + CLOCK_TOLERANCE_MS)).toBe(true)
  })
})

describe("LicenseService offline verification", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }))
  afterEach(() => vi.useRealTimers())

  const entitledAt = (time: number) => {
    vi.setSystemTime(time)
    return entitled(service())
  }

  it("stays valid offline for the token lifetime", () => {
    storeLicense(token())
    expect(entitledAt(T0 + DAY)).toBe(true)
    expect(entitledAt(T0 + 13 * DAY)).toBe(true)
    expect(entitledAt(T0 + 15 * DAY)).toBe(false)
  })

  it("refuses the cached token after the clock is set back, across restarts", () => {
    storeLicense(token())
    expect(entitledAt(T0 + 13 * DAY)).toBe(true)
    expect(entitledAt(T0 + 6 * DAY)).toBe(false)
    expect(entitledAt(T0 + 13 * DAY - CLOCK_TOLERANCE_MS)).toBe(true)
  })

  it("refuses a stored mark that is ahead of the clock", () => {
    storeLicense(token(), T0 + 5 * DAY)
    expect(entitledAt(T0 + 2 * DAY)).toBe(false)
  })

  it("refuses a signed token without a granted status or numeric expiry", () => {
    storeLicense(token({ status: undefined }))
    expect(entitledAt(T0 + DAY)).toBe(false)
    storeLicense(token({ exp: `${Math.floor(T0 / 1000) + 14 * 86400}` }))
    expect(entitledAt(T0 + DAY)).toBe(false)
  })

  it("refuses a token bound to another tenant or installation", () => {
    storeLicense(token({ tenantId: TENANT_B }))
    expect(entitledAt(T0 + DAY)).toBe(false)
    storeLicense(token({ installId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" }))
    expect(entitledAt(T0 + DAY)).toBe(false)
  })

  it("verifies nothing with a key other than the signing key, as in an unconfigured build", () => {
    const placeholder = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
    storeLicense(token())
    vi.setSystemTime(T0 + DAY)
    expect(entitled(service({ publicKey: placeholder }))).toBe(false)
  })
})

describe("LicenseService storage", () => {
  it("removes the state of the offline TV1 licenses it replaced", () => {
    for (const key of ["license.key", "license.trialStartedAt", "license.lastSeenAt", "license.tenants"]) store.set(key, "x")
    service().status([])
    expect([...store.values.keys()]).toEqual(["license.installId"])
  })

  it("creates a stable installation ID", () => {
    store = memoryStore()
    service().status([])
    const id = store.get("license.installId")
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    service().status([])
    expect(store.get("license.installId")).toBe(id)
  })

  it("keeps the key in memory only when OS encryption is unavailable", async () => {
    answer = () => granted("act-key")
    const license = service({ persist: false })
    await license.setKey("TEST-LICENSE-KEY", [TENANT])
    expect(license.status([TENANT])).toMatchObject({ hasKey: true, persisted: false })
    expect(store.get("license.state")).toBeNull()
  })
})

describe("LicenseService key activations", () => {
  it("activates each tenant on first use and then answers from the cached token", async () => {
    answer = ({ body }) =>
      body.tenantId === TENANT
        ? granted("act-a", { plan: "msp", tenants: 10 }, { plan: "msp", tenants: 10 })
        : granted("act-b", { plan: "msp", tenants: 10 }, { plan: "msp", tenants: 10, tenantId: TENANT_B })
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [])
    expect(license.status([]).message).toMatch(/Sign in to a tenant/)

    await license.requireEntitlement(TENANT)
    await license.requireEntitlement(TENANT_B.toUpperCase())
    await license.requireEntitlement(TENANT)
    expect(calls.map((c) => [c.action, c.body.tenantId])).toEqual([
      ["activate", TENANT],
      ["activate", TENANT_B],
    ])
    expect(calls[0]!.body).toMatchObject({
      key: "TEST-LICENSE-KEY",
      installId: INSTALL,
      os: "darwin",
      appVersion: "0.0.0-test",
      clientId: APP_ID,
      idToken: "id.token.value",
    })

    // Survives a restart.
    const status = service().status([TENANT, TENANT_B])
    expect(status).toMatchObject({ hasKey: true, keyHint: "****-KEY", plan: "msp", tenantLimit: 10, message: null })
    expect(status.tenants.map((t) => [t.tenantId, t.entitled, t.source])).toEqual([
      [TENANT, true, "key"],
      [TENANT_B, true, "key"],
    ])
  })

  it("refuses a tenant beyond the allowance and pauses before asking again", async () => {
    answer = ({ action, body }) =>
      action === "tenant" ? denied("tenant_not_licensed") : body.tenantId === TENANT ? granted("act-a") : denied("tenant_limit")
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [TENANT])
    calls = []
    await expect(license.requireEntitlement(TENANT_B)).rejects.toThrow("maximum number of tenants")
    expect(calls.map((c) => c.action)).toEqual(["activate", "tenant"])
    // Bursts of token requests do not call the service again.
    await expect(license.requireEntitlement(TENANT_B)).rejects.toThrow("maximum number of tenants")
    expect(calls).toHaveLength(2)
    expect(license.status([TENANT_B]).tenants[0]).toMatchObject({ entitled: false, message: expect.stringMatching(/maximum/) })
    // An action the admin started asks again.
    await expect(license.requireEntitlement(TENANT_B, { retry: true })).rejects.toThrow("maximum number of tenants")
    expect(calls).toHaveLength(4)
    expect(FAILURE_COOLDOWN_MS).toBeGreaterThan(0)
  })

  it("shares one activation request between concurrent token requests", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    answer = async () => {
      await gate
      return granted("act-a")
    }
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [])
    const all = Promise.all([license.requireEntitlement(TENANT), license.requireEntitlement(TENANT)])
    release()
    await all
    expect(calls).toHaveLength(1)
  })

  it("keeps the cached token through an outage and drops it on a confirmed refusal", async () => {
    answer = () => granted("act-a")
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [TENANT])

    answer = () => Response.json({ reason: "upstream" }, { status: 502 })
    await license.refreshAll()
    expect(entitled(license)).toBe(true)
    expect(license.status([TENANT]).offline).toBe(true)

    answer = () => {
      throw new TypeError("fetch failed")
    }
    await license.refreshAll()
    expect(entitled(license)).toBe(true)

    answer = () => denied("revoked")
    await license.refreshAll()
    expect(entitled(license)).toBe(false)
    expect(license.status([TENANT]).tenants[0]).toMatchObject({ activated: false, message: expect.stringMatching(/revoked/) })
  })

  it.each([200, 401, 403, 407, 502])("keeps the activation when a network intermediary returns HTML (%s)", async (status) => {
    answer = () => granted("act-a")
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [TENANT])
    answer = () => new Response("<html>Access blocked</html>", { status, headers: { "Content-Type": "text/html" } })
    await license.refreshAll()
    expect(entitled(license)).toBe(true)
    expect(license.status([TENANT]).offline).toBe(true)
    expect(service().status([TENANT]).tenants[0]?.activated).toBe(true)
    answer = () => granted("act-a")
    await license.refreshAll()
    expect(license.status([TENANT]).offline).toBe(false)
  })

  it.each(["null", "[]", "{", '{"reason":"firewall_block"}'])("preserves the activation on an unrecognized JSON refusal: %s", async (body) => {
    answer = () => granted("act-a")
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [TENANT])
    answer = () => new Response(body, { status: 403, headers: { "Content-Type": "application/json" } })
    await license.refreshAll()
    expect(entitled(license)).toBe(true)
    expect(license.status([TENANT]).offline).toBe(true)
  })

  it.each([
    ["net::ERR_CERT_AUTHORITY_INVALID", "trusted certificates"],
    ["net::ERR_PROXY_CONNECTION_FAILED", "proxy settings"],
    ["net::ERR_CONNECTION_TIMED_OUT", "timed out"],
    ["net::ERR_NAME_NOT_RESOLVED", "allow HTTPS"],
  ])("explains network failures without exposing request data: %s", async (code, guidance) => {
    answer = () => { throw new Error(`${code} secret-request-data`) }
    const license = service()
    await expect(license.setKey("TEST-LICENSE-KEY", [TENANT])).rejects.toThrow(guidance)
    await expect(license.setKey("TEST-LICENSE-KEY", [TENANT])).rejects.not.toThrow("secret-request-data")
  })

  it("does not keep a key that no signed-in tenant accepts", async () => {
    answer = () => denied("not_found")
    const license = service()
    await expect(license.setKey("TEST-LICENSE-KEY", [TENANT])).rejects.toThrow("not valid")
    expect(license.status([TENANT]).hasKey).toBe(false)
    await expect(license.setKey("short", [])).rejects.toThrow("valid license key")
  })

  it("rejects a token that does not verify without losing the cached one", async () => {
    answer = () => granted("act-a")
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [TENANT])
    const other = generateKeyPairSync("ed25519").privateKey
    answer = () => Response.json({ token: token({ act: "act-a" }, other), activationId: "act-a" })
    await license.refreshAll()
    expect(entitled(license)).toBe(true)
  })

  it("refuses a different key while key activations exist", async () => {
    answer = () => granted("act-a")
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [TENANT])
    await expect(license.setKey("OTHER-LICENSE-KEY", [TENANT])).rejects.toThrow("Deactivate this machine")
  })

  it("only licenses tenants by tenant ID", async () => {
    await expect(service().requireEntitlement("contoso.onmicrosoft.com")).rejects.toThrow("tenant ID")
    expect(calls).toHaveLength(0)
  })

  it("releases a removed tenant and keeps an activation the service could not release", async () => {
    answer = () => granted("act-a")
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [TENANT])

    answer = () => Response.json({ reason: "upstream" }, { status: 502 })
    await expect(license.releaseTenant(TENANT)).rejects.toThrow("unavailable")
    expect(license.status([]).tenants[0]).toMatchObject({ tenantId: TENANT, activated: true })

    answer = () => Response.json({ success: true })
    await license.releaseTenant(TENANT)
    expect(calls.at(-1)).toEqual({ action: "deactivate", body: { key: "TEST-LICENSE-KEY", activationId: "act-a" } })
    expect(license.status([]).tenants).toEqual([])
    expect(license.status([]).hasKey).toBe(true)
  })

  it("deactivates every tenant and forgets the key", async () => {
    answer = ({ body }) => granted(body.tenantId === TENANT ? "act-a" : "act-b", {}, { tenantId: body.tenantId })
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [TENANT, TENANT_B])
    answer = () => Response.json({ success: true })
    calls = []
    await license.deactivate()
    expect(calls.map((c) => c.body.activationId)).toEqual(["act-a", "act-b"])
    expect(license.status([TENANT])).toMatchObject({ hasKey: false, plan: null })
    expect(store.get("license.state")).toBeNull()
  })
})

describe("LicenseService organization licenses", () => {
  it("licenses a tenant without a key through the organization license", async () => {
    answer = () => granted("act-org", { source: "tenant", displayKey: "****ABCDEF" })
    const license = service()
    await license.requireEntitlement(TENANT)
    expect(calls).toEqual([
      {
        action: "tenant",
        body: expect.objectContaining({ idToken: "id.token.value", installId: INSTALL, action: "activate" }),
      },
    ])
    expect(calls[0]!.body).not.toHaveProperty("key")
    const status = service().status([TENANT])
    expect(status).toMatchObject({ hasKey: false, keyHint: null, plan: null })
    expect(status.tenants[0]).toMatchObject({ entitled: true, source: "tenant", displayKey: "****ABCDEF", shared: null })
  })

  it("uses Community, without a tenant message, when the tenant has no organization license", async () => {
    answer = () => denied("tenant_not_licensed")
    const license = service()
    await expect(license.requireEntitlement(TENANT)).resolves.toBe("community")
    expect(license.status([TENANT]).tenants[0]).toMatchObject({ entitled: false, plan: "community", message: null })
  })

  it("refreshes a tenant activation with a fresh ID token, and keeps it without one", async () => {
    answer = () => granted("act-org", { source: "tenant" })
    await service().requireEntitlement(TENANT)
    calls = []
    await service({ idTokenValue: null }).refreshAll()
    expect(calls).toHaveLength(0)
    expect(entitled(service({ idTokenValue: null }))).toBe(true)

    await service().refreshAll()
    expect(calls).toEqual([
      { action: "tenant", body: expect.objectContaining({ action: "refresh", activationId: "act-org" }) },
    ])

    answer = () => denied("tenant_not_licensed")
    await service().refreshAll()
    expect(entitled(service())).toBe(false)
  })

  it("releases a tenant activation through the organization license route", async () => {
    const KEY_ID = "5a0e2f6c-8a41-4a8e-9b33-0c6e2d1f7a10"
    answer = () => granted("act-org", { source: "tenant", licenseKeyId: KEY_ID })
    const license = service()
    await license.requireEntitlement(TENANT)
    answer = () => Response.json({ success: true })
    await license.deactivate()
    expect(calls.at(-1)).toEqual({
      action: "tenant",
      body: expect.objectContaining({ action: "deactivate", activationId: "act-org", licenseKeyId: KEY_ID }),
    })
    expect(entitled(license)).toBe(false)
  })

  it("forgets an organization activation it cannot release after the tenant was removed", async () => {
    answer = () => granted("act-org", { source: "tenant" })
    await service().requireEntitlement(TENANT)
    const signedOut = service({ idTokenValue: null })
    await signedOut.releaseTenant(TENANT)
    expect(signedOut.status([]).tenants).toEqual([])
  })

  it("deactivates the machine when an organization activation cannot be released without a sign-in", async () => {
    answer = () => granted("act-org", { source: "tenant" })
    await service().requireEntitlement(TENANT)
    const signedOut = service({ idTokenValue: null })
    await signedOut.deactivate()
    expect(signedOut.status([]).tenants).toEqual([])
  })

  it("lets the key holder share the license and remembers the choice", async () => {
    answer = ({ action, body }) =>
      action === "activate" ? granted("act-key", { shared: false }) : granted("act-key", { shared: body.shareWithTenant })
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [TENANT])
    expect(calls[0]!.body).not.toHaveProperty("shareWithTenant")
    expect(calls[0]!.body).toMatchObject({ clientId: APP_ID, idToken: "id.token.value" })
    expect(license.status([TENANT]).tenants[0]).toMatchObject({ source: "key", shared: false })

    await license.setShared(TENANT, true)
    expect(license.status([TENANT]).tenants[0]!.shared).toBe(true)
    expect(calls.at(-1)).toMatchObject({
      action: "refresh",
      body: { shareWithTenant: true, key: "TEST-LICENSE-KEY", clientId: APP_ID, idToken: "id.token.value" },
    })
    await license.refreshAll()
    expect(calls.at(-1)!.body.shareWithTenant).toBe(true)
  })

  it("reports a sharing change the service could not store", async () => {
    answer = ({ action }) => (action === "activate" ? granted("act-key", { shared: true }) : granted("act-key"))
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [TENANT])
    await expect(license.setShared(TENANT, false)).rejects.toThrow("could not be saved")
    expect(license.status([TENANT]).tenants[0]!.shared).toBe(true)
  })

  it("keeps the sharing choice when the service needs a fresh sign-in", async () => {
    answer = ({ action, body }) =>
      // Like the service: sharing needs a sign-in, stopping does not.
      action === "activate" || body.idToken || body.shareWithTenant === false
        ? granted("act-key", { shared: body.shareWithTenant ?? true })
        : granted("act-key", { shared: false, sharedReason: "sign_in_required" })
    await service().setKey("TEST-LICENSE-KEY", [TENANT])
    // A background refresh without a sign-in does not turn sharing off.
    await service({ idTokenValue: null }).refreshAll()
    expect(calls.at(-1)!.body).toMatchObject({ shareWithTenant: true })
    expect(calls.at(-1)!.body).not.toHaveProperty("idToken")
    expect(service({ idTokenValue: null }).status([TENANT]).tenants[0]).toMatchObject({ shared: true, shareNeedsSignIn: true })
    await expect(service({ idTokenValue: null }).setShared(TENANT, true)).rejects.toThrow("Sign in to this tenant again")
    // Stopping needs no sign-in and sends no token.
    await service({ idTokenValue: null }).setShared(TENANT, false)
    expect(calls.at(-1)!.body).toMatchObject({ shareWithTenant: false })
    expect(calls.at(-1)!.body).not.toHaveProperty("idToken")
    await service().refreshAll()
    expect(service().status([TENANT]).tenants[0]).toMatchObject({ shared: false, shareNeedsSignIn: false })
  })

  it("falls back to the organization license when the key is refused for the tenant", async () => {
    answer = ({ action }) => (action === "activate" ? denied("tenant_limit") : granted("act-org", { source: "tenant" }))
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [])
    await license.requireEntitlement(TENANT)
    expect(calls.map((call) => call.action)).toEqual(["activate", "tenant"])
    expect(license.status([TENANT])).toMatchObject({ hasKey: true, plan: null })
    expect(license.status([TENANT]).tenants[0]).toMatchObject({ entitled: true, source: "tenant" })
  })

  it("keeps the key's refusal when the tenant has no organization license", async () => {
    answer = ({ action }) => (action === "activate" ? denied("tenant_limit") : denied("tenant_not_licensed"))
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [])
    await expect(license.requireEntitlement(TENANT)).rejects.toThrow("maximum number of tenants")
  })
})

describe("LicenseService without a sign-in", () => {
  it("uses Community when there is no key and no sign-in to check an organization license", async () => {
    await expect(service({ idTokenValue: null }).requireEntitlement(TENANT)).resolves.toBe("community")
    expect(calls).toHaveLength(0)
  })

  it("reports the key's refusal when no sign-in is available for the organization license", async () => {
    answer = () => denied("tenant_limit")
    const license = service({ idTokenValue: null })
    await license.setKey("TEST-LICENSE-KEY", [])
    await expect(license.requireEntitlement(TENANT)).rejects.toThrow("maximum number of tenants")
  })
})

describe("LicenseService Community plan", () => {
  it("covers one tenant without a license and refuses a second", async () => {
    answer = () => denied("tenant_not_licensed")
    const license = service()
    await expect(license.requireEntitlement(TENANT)).resolves.toBe("community")
    await expect(license.requireEntitlement(TENANT_B)).rejects.toThrow(`Community covers one tenant, and it is used for tenant ${TENANT}`)
    expect(license.plan(TENANT)).toBe("community")
    expect(license.plan(TENANT_B)).toBeNull()
    expect(license.status([TENANT, TENANT_B])).toMatchObject({ communityTenantId: TENANT })
  })

  it("frees Community for another tenant when its tenant is removed", async () => {
    answer = () => denied("tenant_not_licensed")
    const license = service()
    await license.requireEntitlement(TENANT)
    await license.releaseTenant(TENANT)
    await expect(license.requireEntitlement(TENANT_B)).resolves.toBe("community")
  })

  it("works offline without a key", async () => {
    answer = () => {
      throw new TypeError("fetch failed")
    }
    await expect(service().requireEntitlement(TENANT)).resolves.toBe("community")
  })

  it("checks a Community tenant for a new license only now and then, or when asked", async () => {
    answer = () => denied("tenant_not_licensed")
    const license = service()
    await license.requireEntitlement(TENANT)
    const checks = calls.length
    await license.requireEntitlement(TENANT)
    expect(calls).toHaveLength(checks)
    answer = () => granted("act-org", { source: "tenant" })
    await expect(license.requireEntitlement(TENANT, { retry: true })).resolves.toBe("pro")
  })

  it("falls back to Community when the license ends", async () => {
    storeLicense(token({ exp: Math.floor(Date.now() / 1000) - 60 }))
    answer = () => denied("revoked")
    await expect(service().requireEntitlement(TENANT)).resolves.toBe("community")
  })

  it("never downgrades a paid tenant because the licensing service is unreachable", async () => {
    storeLicense(token({ exp: Math.floor(Date.now() / 1000) - 60 }))
    answer = () => {
      throw new TypeError("fetch failed")
    }
    await expect(service().requireEntitlement(TENANT)).rejects.toThrow()
  })

  it("keeps a key's tenant limit as an error instead of using Community", async () => {
    answer = () => denied("tenant_limit")
    const license = service({ idTokenValue: null })
    await license.setKey("TEST-LICENSE-KEY", [])
    await expect(license.requireEntitlement(TENANT)).rejects.toThrow("maximum number of tenants")
  })
})
