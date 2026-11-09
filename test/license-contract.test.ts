import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LICENSE_REFUSAL_REASONS, LicenseService } from "../src/main/license/service"
import { memoryStore } from "./helpers"

// The licensing contract with the service in the TenuVault-Website repository, which tests the
// same file from the server side and fails its CI when its copy differs from this one. Client
// first: a change lands here, ships in a stable release, and only then is copied there.
interface Fields {
  required: string[]
  optional: string[]
}
const contract = JSON.parse(readFileSync(join(__dirname, "fixtures/license-contract.json"), "utf8")) as {
  tenantTrial: { responses: { trialEntitlement: Record<string, unknown>; unavailable: { reason: string[] } }; actions: Record<string, unknown> }
  installId: string
  tenantId: string
  publicKey: string
  refusalReasons: string[]
  otherReasons: Record<string, string[]>
  tokenVersions: number[]
  tokens: { name: string; payload: { iat: number; act: string; v: number }; token: string }[]
  requests: Record<"activate" | "refresh" | "deactivate" | "tenant", Fields>
  responses: Record<"entitlement" | "deactivate" | "error", Fields>
}
const TENANT = contract.tenantId
const token = (name: string) => contract.tokens.find((entry) => entry.name === name)!

type Call = { action: string; body: Record<string, unknown> }
let store: ReturnType<typeof memoryStore>
let calls: Call[]
let answer: (call: Call) => Response

function service() {
  return new LicenseService({
    store,
    persist: true,
    publicKey: contract.publicKey,
    apiBase: "https://www.tenuvault.com",
    appVersion: "0.4.3",
    platform: "win32",
    idToken: async () => "header.payload.signature",
    clientId: () => "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      if (!init?.body) return Response.json({ tenantTrials: { enabled: true } })
      const call = { action: String(url).split("/").pop() ?? "", body: JSON.parse(String(init?.body)) as Record<string, unknown> }
      calls.push(call)
      return answer(call)
    }) as typeof fetch,
  })
}

// An entitlement answer carrying every field the contract allows.
const entitlement = (name: string, extra: Record<string, unknown> = {}) =>
  Response.json({
    token: token(name).token,
    activationId: token(name).payload.act,
    plan: "pro",
    tenants: 2,
    expiresAt: "2026-11-20T00:00:00.000Z",
    shared: true,
    ...extra,
  })

function expectFields(body: Record<string, unknown>, fields: Fields) {
  for (const name of fields.required) expect(body).toHaveProperty(name)
  for (const name of Object.keys(body)) expect([...fields.required, ...fields.optional]).toContain(name)
}

const storeToken = (name: string) =>
  store.set("license.state", JSON.stringify({
    key: "TENU-CONTRACT-KEY-0001",
    activations: { [TENANT]: { activationId: token(name).payload.act, token: token(name).token } },
  }))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime((contract.tokens[0]!.payload.iat + 3600) * 1000)
  store = memoryStore()
  store.set("license.installId", contract.installId)
  calls = []
  answer = () => Response.json({ reason: "unexpected" }, { status: 500 })
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("licensing contract, client side", () => {
  it("knows every refusal reason the service can send", () => {
    for (const reason of contract.refusalReasons) expect(LICENSE_REFUSAL_REASONS).toContain(reason)
  })

  it.each(contract.tokens.map((entry) => [entry.name]))("accepts the %s token offline", (name) => {
    storeToken(name)
    const license = service()
    const status = license.status([TENANT])
    expect(status.tenants[0]!.entitled).toBe(true)
    expect(contract.tokenVersions).toContain(token(name).payload.v)
    expect(status.trial).toBe(["v2 trial", "v2 tenant trial"].includes(name))
    expect(status.validUntil !== null).toBe(name === "v2 expiring paid key")
    expect(license.cisInternal()).toBe(name === "v1 internal cis")
    expect(calls).toHaveLength(0)
  })

  it("sends activate, refresh and deactivate requests with the contract's fields", async () => {
    answer = ({ action }) => (action === "deactivate" ? Response.json({ success: true }) : entitlement("v1 pro"))
    const license = service()
    await license.setKey("TENU-CONTRACT-KEY-0001", [TENANT])
    await license.setShared(TENANT, true)
    await license.deactivate()
    expect(calls.map(({ action }) => action)).toEqual(["activate", "refresh", "deactivate"])
    for (const { action, body } of calls) expectFields(body, contract.requests[action as "activate" | "refresh" | "deactivate"])
  })

  it("sends organization license requests with the contract's fields", async () => {
    answer = ({ body }) => (body.action === "deactivate" ? Response.json({ success: true }) : entitlement("v1 pro", { displayKey: "****0001", licenseKeyId: "5a0e2f6c-8a41-4a8e-9b33-0c6e2d1f7a10" }))
    const license = service()
    await expect(license.requireEntitlement(TENANT)).resolves.toBe("pro")
    await license.releaseTenant(TENANT)
    expect(calls.map(({ action, body }) => `${action}:${String(body.action)}`)).toEqual(["tenant:activate", "tenant:deactivate"])
    for (const { body } of calls) expectFields(body, contract.requests.tenant)
  })

  it("drops a cached entitlement only for a contract refusal", async () => {
    for (const reason of contract.refusalReasons) {
      storeToken("v1 pro")
      answer = () => Response.json({ error: "The license was not accepted.", reason }, { status: 403 })
      const license = service()
      await license.refreshAll()
      expect(license.status([TENANT]).tenants[0]!.entitled, reason).toBe(false)
    }
  })

  it("keeps a cached entitlement for every other answer the contract names", async () => {
    for (const [status, reasons] of Object.entries(contract.otherReasons)) {
      for (const reason of reasons) {
        storeToken("v1 pro")
        answer = () => Response.json({ error: "Not now.", reason }, { status: Number(status), headers: status === "429" ? { "retry-after": "600" } : {} })
        const license = service()
        await license.refreshAll()
        expect(license.status([TENANT]).tenants[0]!.entitled, `${status} ${reason}`).toBe(true)
      }
    }
  })

  it("loads the tenant trial persisted-state fixture offline", () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/license/app-state-tenant-trial.json"), "utf8")) as Record<string, string>
    for (const [key, value] of Object.entries(fixture)) store.set(key, value)
    expect(service().status([TENANT]).tenants[0]).toMatchObject({ source: "trial", trial: true, canEnd: true })
    expect(calls).toHaveLength(0)
  })

  it("uses every tenant trial action with the contract fields", async () => {
    const fixture = token("v2 tenant trial")
    const payload = fixture.payload as typeof fixture.payload & { keyExp: number }
    answer = ({ body }) => {
      if (body.action === "activate") return Response.json({ reason: "tenant_not_licensed" }, { status: 403 })
      if (["end_trial", "trial_contact"].includes(String(body.action))) return Response.json({ success: true })
      return entitlement("v2 tenant trial", { source: "trial", trial: true, keyExp: payload.keyExp, canEnd: true })
    }
    const license = service()
    await license.startTenantTrial(TENANT)
    expect(license.status([TENANT]).tenants[0]).toMatchObject({ source: "trial", trial: true, canEnd: true })
    await license.refreshAll()
    vi.setSystemTime((payload.keyExp - 4 * 86400) * 1000)
    await license.tenantTrialAction(TENANT, "extend_trial")
    await license.tenantTrialAction(TENANT, "trial_contact", "admin@contoso.example")
    await license.tenantTrialAction(TENANT, "trial_contact")
    await license.tenantTrialAction(TENANT, "end_trial")
    for (const { body } of calls) expectFields(body, contract.requests.tenant)
    for (const action of Object.keys(contract.tenantTrial.actions)) expect(calls.some(call => call.body.action === action)).toBe(true)
    expect(contract.tenantTrial.responses.unavailable.reason).toEqual(["used", "licensed", "install_limit", "disabled", "app_update_required", "not_starter"])
    expect(Object.keys(contract.tenantTrial.responses.trialEntitlement)).toEqual(expect.arrayContaining(["token", "activationId", "trial", "keyExp", "source", "canEnd"]))
  })

  it("relies only on answer fields the service promises", () => {
    // call() accepts an answer only with these, so the contract must keep them required.
    expect(contract.responses.entitlement.required).toEqual(expect.arrayContaining(["token", "activationId"]))
    expect(contract.responses.deactivate.required).toContain("success")
    expect(contract.responses.error.required).toContain("reason")
  })
})
