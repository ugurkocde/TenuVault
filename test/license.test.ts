import { generateKeyPairSync, sign } from "node:crypto"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CLOCK_TOLERANCE_MS,
  FAILURE_COOLDOWN_MS,
  LicenseService,
  entitlementCurrent,
  type LicenseServiceOptions,
} from "../src/main/license/service"
import { memoryStore } from "./helpers"
import { earliestExpiringTenant, licenseChipState, licenseExpiryWarning, offlineDeadline } from "../src/renderer/lib/license"
import * as licenseUi from "../src/renderer/lib/license"
import LicensePage from "../src/renderer/pages/LicensePage"
import type { LicenseStatus } from "../src/shared/ipc"

vi.mock("../src/renderer/lib/bridge", () => ({ bridge: {} }))
vi.mock("../src/portal/contexts/TenantContext", () => ({ useTenants: () => [] }))

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

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

function renderLicensePage(status: LicenseStatus): string {
  const hook = vi.spyOn(licenseUi, "useLicense").mockReturnValue({ status, error: null, refresh: async () => {} })
  try {
    return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(LicensePage)))
  } finally {
    hook.mockRestore()
  }
}

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

  it.each([1, 2])("stays valid offline for the version %s token lifetime", (v) => {
    storeLicense(token({ v }))
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

  it.each([1, 2])("refuses a version %s token bound to another tenant, installation or activation", (v) => {
    storeLicense(token({ v, tenantId: TENANT_B }))
    expect(entitledAt(T0 + DAY)).toBe(false)
    storeLicense(token({ v, installId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" }))
    expect(entitledAt(T0 + DAY)).toBe(false)
    storeLicense(token({ v, act: "act-other" }))
    expect(entitledAt(T0 + DAY)).toBe(false)
  })

  it("verifies nothing with a key other than the signing key, as in an unconfigured build", () => {
    const placeholder = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
    storeLicense(token())
    vi.setSystemTime(T0 + DAY)
    expect(entitled(service({ publicKey: placeholder }))).toBe(false)
  })
})

describe("LicenseService key expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it.each([undefined, (T0 + 20 * DAY) / 1000])("keeps version 1 expiry limited to the offline token (%s)", (keyExp) => {
    storeLicense(token({ keyExp }))
    const status = service().status([TENANT])
    expect(status.validUntil).toBeNull()
    expect(status.tenants[0]).toMatchObject({
      entitled: true, validUntil: null, expiresAt: new Date(T0 + 14 * DAY).toISOString(),
    })
    expect(licenseExpiryWarning(status)).toBeNull()
  })

  it.each([45, 20, 30])("exposes a version 2 key expiry %s days away separately from token expiry", (days) => {
    const validUntil = new Date(T0 + days * DAY).toISOString()
    storeLicense(token({ v: 2, keyExp: (T0 + days * DAY) / 1000 }))
    const status = service().status([TENANT])
    expect(status.validUntil).toBe(validUntil)
    expect(status.tenants[0]).toMatchObject({
      entitled: true, validUntil, expiresAt: new Date(T0 + 14 * DAY).toISOString(),
    })
    expect(licenseExpiryWarning(status)).toBe(days > 30 ? null : "expiring")
  })

  it("reports the nearer offline deadline and the tenant whose license expires first", () => {
    const tenants = [
      { tenantId: "a", entitled: true, expiresAt: new Date(T0 + DAY).toISOString(), validUntil: new Date(T0 + 20 * DAY).toISOString(), source: "key" },
      { tenantId: "b", entitled: true, expiresAt: new Date(T0 + 10 * DAY).toISOString(), validUntil: new Date(T0 + 5 * DAY).toISOString(), source: "tenant" },
    ] as never[]
    expect(offlineDeadline({ offline: false, tenants }, T0)).toBeNull()
    expect(offlineDeadline({ offline: true, tenants }, T0)).toBe(new Date(T0 + DAY).toISOString())
    expect(earliestExpiringTenant({ validUntil: new Date(T0 + 5 * DAY).toISOString(), tenants })).toMatchObject({ tenantId: "b", source: "tenant" })
    expect(earliestExpiringTenant({ validUntil: null, tenants })).toBeNull()
  })

  it("does not warn more than 30 days ahead or when no date is supplied", () => {
    expect(licenseExpiryWarning({ validUntil: new Date(T0 + 30 * DAY + 1).toISOString() })).toBeNull()
    expect(licenseExpiryWarning({ validUntil: null })).toBeNull()
    expect(licenseExpiryWarning({ validUntil: "invalid" })).toBeNull()
  })

  it("accepts a version 2 renewing subscription without key expiry", () => {
    storeLicense(token({ v: 2 }))
    const status = service().status([TENANT])
    expect(status.validUntil).toBeNull()
    expect(status.tenants[0]).toMatchObject({ entitled: true, validUntil: null })
    expect(licenseExpiryWarning(status)).toBeNull()
  })

  it("treats a null key expiry on a version 2 token as no expiry", () => {
    storeLicense(token({ v: 2, keyExp: null } as never))
    const status = service().status([TENANT])
    expect(status.tenants[0]).toMatchObject({ entitled: true, validUntil: null })
    expect(status.validUntil).toBeNull()
  })

  it("uses the earliest expiry across key and organization licenses", () => {
    const later = new Date(T0 + 45 * DAY).toISOString()
    const earlier = new Date(T0 + 20 * DAY).toISOString()
    store.set("license.state", JSON.stringify({
      key: "TEST-LICENSE-KEY",
      activations: {
        [TENANT]: { activationId: "act-1", token: token({ v: 2, keyExp: Date.parse(later) / 1000 }) },
        [TENANT_B]: {
          activationId: "act-2", source: "tenant",
          token: token({ v: 2, act: "act-2", tenantId: TENANT_B, keyExp: Date.parse(earlier) / 1000 }),
        },
      },
    }))
    const status = service().status([TENANT, TENANT_B])
    expect(status.validUntil).toBe(earlier)
    expect(status.tenants.map(tenant => tenant.validUntil)).toEqual([later, earlier])
    expect(licenseExpiryWarning(status)).toBe("expiring")
  })

  it.each([-1, 0])("warns about an expired key while its offline token is still current (%s days)", (days) => {
    const validUntil = new Date(T0 + days * DAY).toISOString()
    storeLicense(token({ v: 2, keyExp: Date.parse(validUntil) / 1000 }))
    const status = service().status([TENANT])
    expect(status.tenants[0]).toMatchObject({ entitled: true, plan: "pro", validUntil })
    expect(licenseExpiryWarning(status)).toBe("expired")
  })

  it("still falls back to Community when the server refuses an expired key", async () => {
    storeLicense(token({ v: 2, keyExp: (T0 - DAY) / 1000 }))
    const license = service()
    answer = () => denied("expired")
    await license.refreshAll()
    await expect(license.requireEntitlement(TENANT)).resolves.toBe("community")
    const status = license.status([TENANT])
    expect(status.validUntil).toBeNull()
    expect(status.tenants[0]).toMatchObject({ entitled: false, plan: "community", validUntil: null })
    expect(licenseExpiryWarning(status)).toBeNull()
  })

  it.each([0, 3, "2"])("rejects an unsupported token version: %s", (v) => {
    storeLicense(token({ v }))
    expect(entitled(service())).toBe(false)
  })

  it.each(["1790000000", 1e20, true])("rejects malformed version 2 key expiry: %s", (keyExp) => {
    storeLicense(token({ v: 2, keyExp }))
    expect(entitled(service())).toBe(false)
  })

  it("reports CIS internal access only for a valid token carrying the server-issued claim", () => {
    storeLicense(token({ cis: "internal" }))
    expect(service().cisInternal()).toBe(true)
    storeLicense(token())
    expect(service().cisInternal()).toBe(false)
  })

  it("rejects a token whose CIS claim has an unknown value", () => {
    storeLicense(token({ cis: "customer" }))
    const license = service()
    expect(entitled(license)).toBe(false)
    expect(license.cisInternal()).toBe(false)
  })

  it("verifies the signature over version 2 key expiry", () => {
    const [body, signature] = token({ v: 2, keyExp: (T0 + 20 * DAY) / 1000 }).split(".")
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"))
    payload.keyExp += DAY / 1000
    storeLicense(`${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`)
    expect(entitled(service())).toBe(false)
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

  it("treats a JSON block page with HTTP 200 as an outage, including during deactivation", async () => {
    answer = () => granted("act-a")
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [TENANT])
    answer = () => Response.json({ error: "blocked" })
    await license.refreshAll()
    expect(entitled(license)).toBe(true)
    expect(license.status([TENANT]).offline).toBe(true)
    await expect(license.deactivate()).rejects.toThrow("invalid response")
    expect(entitled(license)).toBe(true)
    expect(license.status([TENANT]).hasKey).toBe(true)
    answer = () => Response.json({ success: true })
    await license.deactivate()
    expect(license.status([TENANT])).toMatchObject({ hasKey: false, offline: false })
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

describe("LicenseService mutation ordering", () => {
  it("serializes overlapping refreshes with the same activation ID", async () => {
    const license = service()
    answer = () => granted("act-a")
    await license.setKey("TEST-LICENSE-KEY", [TENANT])
    const older = deferred<Response>()
    const newer = deferred<Response>()
    const started = deferred<void>()
    answer = () => {
      started.resolve()
      return older.promise
    }
    const first = license.refreshAll()
    await started.promise
    const second = license.refreshAll()
    answer = () => newer.promise
    newer.resolve(granted("act-a"))
    expect(calls.filter(({ action }) => action === "refresh")).toHaveLength(1)
    older.resolve(denied("revoked"))
    await Promise.all([first, second])

    for (const current of [license, service()]) {
      expect(current.status([TENANT])).toMatchObject({ keyState: "active", keyMessage: null, tenants: [{ entitled: true, activated: true }] })
    }
    expect(JSON.parse(store.get("license.state")!).activations[TENANT].activationId).toBe("act-a")
  })

  it("keeps a queued organization refresh on the key chain if its activation becomes a key activation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(T0)
      const license = service()
      await license.setKey("TEST-LICENSE-KEY", [])
      answer = ({ action }) => action === "activate" ? denied("tenant_limit") : granted("act-org", { source: "tenant" })
      await license.requireEntitlement(TENANT)
      vi.setSystemTime(T0 + 15 * DAY)
      const organization = deferred<Response>()
      const key = deferred<Response>()
      const organizationStarted = deferred<void>()
      const keyStarted = deferred<void>()
      answer = ({ action, body }) => {
        if (action === "tenant") {
          organizationStarted.resolve()
          return organization.promise
        }
        if (action === "refresh" && body.tenantId === TENANT) {
          keyStarted.resolve()
          return key.promise
        }
        return granted(body.tenantId === TENANT ? "act-key" : "act-b", {}, { tenantId: body.tenantId })
      }
      const first = license.refreshAll()
      await organizationStarted.promise
      const saving = license.setKey("TEST-LICENSE-KEY", [TENANT])
      const queued = license.refreshAll()
      const other = license.requireEntitlement(TENANT_B)
      organization.resolve(granted("act-org", { source: "tenant" }, { exp: T0 / 1000 + 14 * 86400 }))
      await keyStarted.promise
      await Promise.resolve()
      expect(calls.some(({ body }) => body.tenantId === TENANT_B)).toBe(false)
      key.resolve(granted("act-key"))
      await Promise.all([first, saving, queued, other])
      for (const current of [license, service()]) {
        expect(current.status([TENANT, TENANT_B])).toMatchObject({ keyState: "active", keyMessage: null, tenants: [{ entitled: true, source: "key" }, { entitled: true, source: "key" }] })
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it("applies a later legitimate refusal even when a prior refresh kept the activation ID", async () => {
    const license = service()
    answer = () => granted("act-a")
    await license.setKey("TEST-LICENSE-KEY", [TENANT])
    const older = deferred<Response>()
    const started = deferred<void>()
    answer = () => {
      started.resolve()
      return older.promise
    }
    const first = license.refreshAll()
    await started.promise
    const second = license.refreshAll()
    answer = () => denied("revoked")
    older.resolve(granted("act-a"))
    await Promise.all([first, second])
    for (const current of [license, service()]) {
      expect(current.status([TENANT])).toMatchObject({ keyState: "failed", keyMessage: expect.stringContaining("revoked"), tenants: [{ activated: false, entitled: false }] })
    }
    expect(calls.filter(({ action }) => action === "refresh")).toHaveLength(2)
  })

  it("applies tenant A's pending key refusal when tenant B is removed", async () => {
    const license = service()
    answer = ({ body }) => granted(body.tenantId === TENANT ? "act-a" : "act-b", {}, { tenantId: body.tenantId })
    await license.setKey("TEST-LICENSE-KEY", [TENANT, TENANT_B])
    const response = deferred<Response>()
    const started = deferred<void>()
    answer = ({ action, body }) => {
      if (action === "refresh" && body.tenantId === TENANT) {
        started.resolve()
        return response.promise
      }
      return Response.json({ success: true })
    }
    const refreshing = license.refreshAll()
    await started.promise
    await license.releaseTenant(TENANT_B)
    expect(license.status([]).tenants.map(({ tenantId }) => tenantId)).toEqual([TENANT])
    response.resolve(denied("revoked"))
    await refreshing
    for (const current of [license, service()]) {
      expect(current.status([TENANT])).toMatchObject({ keyState: "failed", keyMessage: expect.stringContaining("revoked"), tenants: [{ tenantId: TENANT, activated: false, entitled: false }] })
      expect(current.status([]).tenants).toEqual([])
    }
  })

  it("does not block an unrelated organization tenant's removal on tenant A's refresh", async () => {
    const license = service()
    answer = ({ body }) => granted(body.idToken === TENANT ? "act-a" : "act-b", { source: "tenant" }, { tenantId: body.idToken })
    const organization = service({ idToken: async (tenant) => tenant })
    await organization.requireEntitlement(TENANT)
    await organization.requireEntitlement(TENANT_B)
    const response = deferred<Response>()
    const started = deferred<void>()
    answer = ({ body }) => {
      if (body.action === "refresh" && body.idToken === TENANT) {
        started.resolve()
        return response.promise
      }
      return Response.json({ success: true })
    }
    const refreshing = organization.refreshAll()
    await started.promise
    await organization.releaseTenant(TENANT_B)
    expect(organization.status([]).tenants.map(({ tenantId }) => tenantId)).toEqual([TENANT])
    response.resolve(denied("revoked"))
    await refreshing
    for (const current of [organization, license, service()]) expect(current.status([]).tenants).toEqual([])
  })

  it.each([true, false])("completes deactivation concurrent with removal, success %s", async (success) => {
    const license = service()
    answer = ({ body }) => granted(body.tenantId === TENANT ? "act-a" : "act-b", {}, { tenantId: body.tenantId })
    await license.setKey("TEST-LICENSE-KEY", [TENANT, TENANT_B])
    const response = deferred<Response>()
    const started = deferred<void>()
    answer = ({ body }) => {
      if (body.activationId === "act-a") {
        started.resolve()
        return response.promise
      }
      return Response.json({ success: true })
    }
    const deactivating = license.deactivate()
    const outcome = success ? expect(deactivating).resolves.toBeUndefined() : expect(deactivating).rejects.toThrow("unavailable")
    await started.promise
    const removing = license.releaseTenant(TENANT_B)
    response.resolve(success ? Response.json({ success: true }) : Response.json({ reason: "upstream" }, { status: 502 }))
    await outcome
    await removing
    for (const current of [license, service()]) {
      expect(current.status([TENANT])).toMatchObject({ hasKey: !success, keyState: success ? "none" : "active", tenants: [{ activated: !success, entitled: !success }] })
    }
    if (success) expect(store.get("license.state")).toBeNull()
  })

  it.each(["success", "refusal"] as const)("does not claim Community for a removed tenant's stale organization activation %s", async (result) => {
    const license = service()
    const response = deferred<Response>()
    const started = deferred<void>()
    answer = () => {
      started.resolve()
      return response.promise
    }
    const requesting = license.requireEntitlement(TENANT)
    const outcome = expect(requesting).rejects.toThrow("license state changed")
    await started.promise
    const removing = license.releaseTenant(TENANT)
    response.resolve(result === "success" ? granted("act-org", { source: "tenant" }) : denied("tenant_not_licensed"))
    await outcome
    await removing
    expect(store.get("license.communityTenant")).toBeNull()
    expect(store.get("license.state")).toBeNull()
    for (const current of [license, service()]) expect(current.status([])).toMatchObject({ communityTenantId: null, tenants: [] })
    answer = () => denied("tenant_not_licensed")
    await expect(license.requireEntitlement(TENANT_B)).resolves.toBe("community")
    expect(service().status([TENANT_B])).toMatchObject({ communityTenantId: TENANT_B })
  })

  it.each(["refresh", "activate", "organization"] as const)("waits for a pending %s success before deactivating and never resurrects it", async (action) => {
    const license = service()
    answer = () => granted("act-a")
    if (action !== "organization") await license.setKey("TEST-LICENSE-KEY", action === "refresh" ? [TENANT] : [])
    const response = deferred<Response>()
    const started = deferred<void>()
    answer = ({ action: request, body }) => {
      if (request === "deactivate" || body.action === "deactivate") return Response.json({ success: true })
      started.resolve()
      return response.promise
    }
    const requesting = action === "refresh" ? license.refreshAll() : license.requireEntitlement(TENANT)
    await started.promise
    let deactivated = false
    const deactivating = license.deactivate().then(() => { deactivated = true })
    await Promise.resolve()
    expect(deactivated).toBe(false)
    expect(calls.some(({ action: request, body }) => request === "deactivate" || body.action === "deactivate")).toBe(false)
    response.resolve(granted("act-late", action === "organization" ? { source: "tenant" } : {}))
    await requesting
    await deactivating
    for (const current of [license, service()]) {
      expect(current.status([TENANT])).toMatchObject({ hasKey: false, keyState: "none", keyMessage: null, tenants: [{ activated: false, entitled: false, message: null }] })
    }
    expect(store.get("license.state")).toBeNull()
  })

  it("does not carry a refused setKey result into a queued replacement", async () => {
    const license = service()
    const response = deferred<Response>()
    const started = deferred<void>()
    answer = ({ body }) => {
      if (body.key === "TEST-LICENSE-KEY") {
        started.resolve()
        return response.promise
      }
      return granted("act-b")
    }
    const saving = license.setKey("TEST-LICENSE-KEY", [TENANT])
    const outcome = expect(saving).rejects.toThrow("revoked")
    await started.promise
    const replacing = license.setKey("OTHER-LICENSE-KEY", [TENANT])
    response.resolve(denied("revoked"))
    await outcome
    await replacing
    for (const current of [license, service()]) expect(current.status([TENANT])).toMatchObject({ keyState: "active", keyMessage: null })
    expect(JSON.parse(store.get("license.state")!).activations[TENANT].activationId).toBe("act-b")
  })

  it("orders starting over with the same key after a pending activation", async () => {
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [])
    const response = deferred<Response>()
    const started = deferred<void>()
    answer = ({ action }) => {
      if (action === "tenant") return denied("tenant_not_licensed")
      started.resolve()
      return response.promise
    }
    const activating = license.requireEntitlement(TENANT)
    await started.promise
    const deactivating = license.deactivate()
    const saving = license.setKey("TEST-LICENSE-KEY", [])
    response.resolve(denied("revoked"))
    await expect(activating).resolves.toBe("community")
    await Promise.all([deactivating, saving])
    for (const current of [license, service()]) expect(current.status([])).toMatchObject({ keyState: "pending", keyMessage: null })
    answer = () => granted("act-new")
    await expect(license.requireEntitlement(TENANT, { retry: true })).resolves.toBe("pro")
  })

  it("allows a new sign-in after removal without reviving the old tenant request", async () => {
    const license = service()
    const response = deferred<Response>()
    const started = deferred<void>()
    answer = () => {
      started.resolve()
      return response.promise
    }
    const old = license.requireEntitlement(TENANT)
    const outcome = expect(old).rejects.toThrow("license state changed")
    await started.promise
    const removing = license.releaseTenant(TENANT)
    const adding = license.checkNewTenant(TENANT)
    answer = () => granted("act-new", { source: "tenant" })
    response.resolve(granted("act-old", { source: "tenant" }))
    await outcome
    await removing
    await expect(adding).resolves.toBe("pro")
    expect(JSON.parse(store.get("license.state")!).activations[TENANT].activationId).toBe("act-new")
    expect(service().status([TENANT]).tenants[0]).toMatchObject({ entitled: true, source: "tenant" })
    expect(store.get("license.communityTenant")).toBeNull()
  })

  it("keeps a later removal in force when a new sign-in check is queued", async () => {
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [])
    const response = deferred<Response>()
    const started = deferred<void>()
    answer = ({ body }) => {
      if (body.tenantId === TENANT) {
        started.resolve()
        return response.promise
      }
      return granted("act-b", {}, { tenantId: TENANT_B })
    }
    const activating = license.requireEntitlement(TENANT)
    await started.promise
    const adding = license.checkNewTenant(TENANT_B)
    const outcome = expect(adding).rejects.toThrow("license state changed")
    const removing = license.releaseTenant(TENANT_B)
    response.resolve(granted("act-a"))
    await activating
    await outcome
    await removing
    expect(calls.filter(({ body }) => body.tenantId === TENANT_B)).toHaveLength(0)
    expect(service().status([TENANT_B]).tenants.find(({ tenantId }) => tenantId === TENANT_B)).toMatchObject({ activated: false, entitled: false })
    expect(store.get("license.communityTenant")).toBeNull()
  })

  it("keeps a retry queued during release cancelled until a later explicit retry", async () => {
    const license = service()
    answer = () => granted("act-a")
    await license.setKey("TEST-LICENSE-KEY", [TENANT])
    const response = deferred<Response>()
    const started = deferred<void>()
    answer = () => {
      started.resolve()
      return response.promise
    }
    const releasing = license.releaseTenant(TENANT)
    await started.promise
    const retrying = license.requireEntitlement(TENANT, { retry: true })
    const outcome = expect(retrying).rejects.toThrow("license state changed")
    response.resolve(Response.json({ success: true }))
    await releasing
    await outcome
    for (const current of [license, service()]) {
      expect(current.status([TENANT])).toMatchObject({ keyState: "pending", keyMessage: null, communityTenantId: null, tenants: [{ activated: false, entitled: false }] })
    }
    answer = () => granted("act-new")
    await expect(license.requireEntitlement(TENANT, { retry: true })).resolves.toBe("pro")
    expect(service().status([TENANT])).toMatchObject({ keyState: "active", communityTenantId: null, tenants: [{ entitled: true }] })
  })

  it("checks current tenant presence after ID token and response body awaits", async () => {
    const present = new Set([TENANT])
    const idToken = deferred<string | null>()
    const license = service({ tenantPresent: (tenant) => present.has(tenant), idToken: () => idToken.promise })
    const requesting = license.requireEntitlement(TENANT)
    const outcome = expect(requesting).rejects.toThrow("license state changed")
    await Promise.resolve()
    present.delete(TENANT)
    idToken.resolve("id.token.value")
    await outcome
    expect(calls).toHaveLength(0)
    expect(store.get("license.communityTenant")).toBeNull()

    present.add(TENANT)
    const body = deferred<unknown>()
    const started = deferred<void>()
    answer = () => {
      const response = granted("act-org", { source: "tenant" })
      vi.spyOn(response, "json").mockImplementation(() => {
        started.resolve()
        return body.promise
      })
      return response
    }
    const retrying = license.requireEntitlement(TENANT)
    const retryOutcome = expect(retrying).rejects.toThrow("license state changed")
    await started.promise
    present.delete(TENANT)
    body.resolve({ token: fresh("act-org"), activationId: "act-org" })
    await retryOutcome
    expect(store.get("license.state")).toBeNull()
    expect(service().status([])).toMatchObject({ communityTenantId: null, tenants: [] })
  })
})

describe("LicenseService key outcomes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it("keeps a saved key pending when the message only asks for a tenant sign-in", async () => {
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [])
    const status = license.status([])
    expect(status.message).toBe("Sign in to a tenant to activate the license for it.")
    expect(licenseChipState(status)).toEqual({ label: "Key saved", tone: "neutral" })
    expect(status).toMatchObject({ keyState: "pending", keyMessage: null })
    expect(renderLicensePage(status)).toContain("License key saved")
    expect(service().status([])).toMatchObject({ keyState: "pending", keyMessage: null })
    expect(licenseChipState(service().status([]))).toEqual({ label: "Key saved", tone: "neutral" })
    expect(calls).toHaveLength(0)
  })

  it.each([
    ["not_found", /not valid/],
    ["revoked", /revoked/],
    ["disabled", /disabled/],
    ["expired", /expired/],
    ["tenant_not_licensed", /no license for this tenant/],
    ["activation_mismatch", /no longer activated/],
  ] as const)("remembers a %s key refusal after Community fallback and restart", async (reason, message) => {
    answer = () => granted("act-a")
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [TENANT])
    expect(license.status([TENANT]).plan).toBe("pro")
    answer = ({ action }) => denied(action === "tenant" ? "tenant_not_licensed" : reason)
    await license.refreshAll()
    await expect(license.requireEntitlement(TENANT)).resolves.toBe("community")
    const status = license.status([TENANT])
    expect(licenseChipState(status)).toEqual({ label: "Inactive", tone: "inactive" })
    expect(status).toMatchObject({ hasKey: true, plan: null, message: null, keyState: "failed", keyMessage: expect.stringMatching(message) })
    expect(status.tenants[0]).toMatchObject({ activated: false, entitled: false, plan: "community", message: null })
    const markup = renderLicensePage(status)
    expect(markup).toContain("License key inactive")
    expect(markup).toContain(status.keyMessage)
    expect(service().status([TENANT])).toMatchObject({ keyState: "failed", keyMessage: status.keyMessage })
    expect(licenseChipState(service().status([TENANT]))).toEqual({ label: "Inactive", tone: "inactive" })
  })

  it.each(["expired", "revoked"])("records a %s refusal on a saved key's first activation", async (reason) => {
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [])
    answer = ({ action }) => denied(action === "tenant" ? "tenant_not_licensed" : reason)
    await expect(license.requireEntitlement(TENANT)).resolves.toBe("community")
    const status = license.status([TENANT])
    expect(status).toMatchObject({ keyState: "failed", keyMessage: expect.stringContaining(reason) })
    expect(licenseChipState(status)).toEqual({ label: "Inactive", tone: "inactive" })
    expect(service().status([TENANT])).toMatchObject({ keyState: "failed", keyMessage: status.keyMessage })
  })

  it("clears a refusal after a successful retry and forgets the outcome on deactivation", async () => {
    const license = service()
    expect(license.status([])).toMatchObject({ keyState: "none", keyMessage: null })
    await license.setKey("TEST-LICENSE-KEY", [])
    answer = () => denied("revoked")
    await license.requireEntitlement(TENANT)
    answer = () => granted("act-a")
    await license.retry([TENANT])
    expect(license.status([TENANT])).toMatchObject({ keyState: "active", keyMessage: null, plan: "pro" })
    expect(licenseChipState(license.status([TENANT]))).toEqual({ label: "Pro", tone: "neutral" })
    expect(service().status([TENANT])).toMatchObject({ keyState: "active", keyMessage: null })
    answer = () => Response.json({ success: true })
    await license.deactivate()
    expect(license.status([TENANT])).toMatchObject({ keyState: "none", keyMessage: null })
  })

  it("retains a refusal when activation of an already saved key fails", async () => {
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [])
    answer = () => denied("expired")
    await expect(license.setKey("TEST-LICENSE-KEY", [TENANT])).rejects.toThrow("expired")
    expect(service().status([TENANT])).toMatchObject({ hasKey: true, keyState: "failed", keyMessage: "This license key has expired." })
  })

  it("does not save a new refused key and clears the refusal when a different key is saved", async () => {
    const license = service()
    answer = () => denied("expired")
    await expect(license.setKey("TEST-LICENSE-KEY", [TENANT])).rejects.toThrow("expired")
    expect(service().status([TENANT])).toMatchObject({ hasKey: false, keyState: "none", keyMessage: null })
    await license.setKey("TEST-LICENSE-KEY", [])
    await license.requireEntitlement(TENANT)
    await license.setKey("OTHER-LICENSE-KEY", [])
    expect(service().status([])).toMatchObject({ keyState: "pending", keyMessage: null })
  })

  it("keeps a valid cached key active during an outage and distinguishes expired verification from pending activation", async () => {
    const license = service()
    answer = () => granted("act-a")
    await license.setKey("TEST-LICENSE-KEY", [TENANT])
    answer = () => { throw new TypeError("fetch failed") }
    await license.refreshAll()
    expect(license.status([TENANT])).toMatchObject({ keyState: "active", keyMessage: null, offline: true })
    vi.setSystemTime(T0 + 15 * DAY)
    const status = license.status([TENANT])
    expect(status).toMatchObject({ keyState: "failed", keyMessage: expect.stringContaining("could not be verified") })
    expect(licenseChipState(status)).toEqual({ label: "Inactive", tone: "inactive" })
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

  it("shows organization coverage in the title while keeping a refused key in its warning", async () => {
    answer = ({ action }) => action === "activate" ? denied("revoked") : granted("act-org", { source: "tenant" })
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [])
    await license.requireEntitlement(TENANT)
    const status = license.status([TENANT])
    expect(licenseChipState(status)).toEqual({ label: "Organization", tone: "neutral" })
    expect(status).toMatchObject({ keyState: "failed", keyMessage: "This license has been revoked. Check your subscription." })
    const markup = renderLicensePage(status)
    expect(markup).toContain("Licensed through your organization")
    expect(markup).not.toContain("License key inactive")
    expect(markup).not.toContain("Your saved key is not active.")
    expect(markup).toContain(status.keyMessage)
  })

  it.each(["expired", "unverifiable"] as const)("shows an inactive organization title and description for an %s activation", async (state) => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(T0)
      answer = () => granted("act-org", { source: "tenant" })
      const license = service()
      await license.requireEntitlement(TENANT)
      expect(licenseUi.licensePageTitle(license.status([TENANT]))).toBe("Licensed through your organization")
      if (state === "expired") vi.setSystemTime(T0 + 15 * DAY)
      const wrongKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
      const current = state === "expired" ? license : service({ publicKey: wrongKey })
      for (const status of [current.status([TENANT]), service(state === "unverifiable" ? { publicKey: wrongKey } : {}).status([TENANT])]) {
        expect(status).toMatchObject({ hasKey: false, tenants: [{ activated: true, entitled: false }] })
        expect(licenseChipState(status)).toEqual({ label: "Inactive", tone: "inactive" })
        expect(licenseUi.licensePageTitle(status)).toBe("Organization license inactive")
        const markup = renderLicensePage(status)
        expect(markup).toContain("Organization license inactive")
        expect(markup).toContain("Your organization license is not currently active.")
        expect(markup).not.toContain("Licensed through your organization</")
      }
    } finally {
      vi.useRealTimers()
    }
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
    await expect(license.requireEntitlement(TENANT_B)).rejects.toMatchObject({ code: "community_tenant_limit", tenantId: TENANT })
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

  it("keeps an idempotent release of an unknown tenant from blocking first Community use", async () => {
    const license = service({ idTokenValue: null })
    await license.releaseTenant(TENANT)
    await expect(license.requireEntitlement(TENANT)).resolves.toBe("community")
    expect(calls).toHaveLength(0)
    expect(service().status([TENANT])).toMatchObject({ communityTenantId: TENANT, tenants: [{ plan: "community" }] })
  })

  it("allows a fresh Community check without a sign-in after a tenant was removed", async () => {
    const license = service({ idTokenValue: null })
    await expect(license.checkNewTenant(TENANT)).resolves.toBe("community")
    await license.releaseTenant(TENANT)
    await expect(license.requireEntitlement(TENANT)).rejects.toThrow("license state changed")
    expect(store.get("license.communityTenant")).toBeNull()
    await expect(license.requireEntitlement(TENANT, { retry: true })).resolves.toBe("community")
    expect(calls).toHaveLength(0)
    expect(service({ idTokenValue: null }).status([TENANT])).toMatchObject({ communityTenantId: TENANT, tenants: [{ plan: "community" }] })
  })

  it("retains cached Community access during explicit use without forcing a key retry", async () => {
    const license = service()
    await license.setKey("TEST-LICENSE-KEY", [])
    answer = ({ action }) => denied(action === "tenant" ? "tenant_not_licensed" : "expired")
    await expect(license.requireEntitlement(TENANT)).resolves.toBe("community")
    const checks = calls.length
    answer = () => { throw new TypeError("fetch failed") }
    await expect(license.checkNewTenant(TENANT, { retry: false })).resolves.toBe("community")
    expect(calls).toHaveLength(checks)
    expect(service().status([TENANT])).toMatchObject({ keyState: "failed", communityTenantId: TENANT, tenants: [{ plan: "community" }] })
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
