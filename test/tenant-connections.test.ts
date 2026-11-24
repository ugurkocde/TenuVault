import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SecureStore } from "../src/main/storage/secure-store"
import { ModuleSettings } from "../src/main/services/settings"
import { TenantConnections, TENANT_LIST_KEY, type StagedSignIn } from "../src/main/auth/tenant-connections"
import { accountStore, connectionCache, stageConnectionCache } from "../src/main/auth/stores"
import { GRAPH_CLI_CLIENT_ID, TENUVAULT_CLIENT_ID, type SignInMethod } from "../src/shared/tenant-connection"
import { RESOURCE_SCOPES } from "../src/shared/constants"
import { connectionCoverage } from "../src/main/auth/connection-coverage"
import { ConnectionCapabilities, READ_ONLY } from "../src/main/auth/connection-capabilities"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
import { withRouteTenant } from "../src/main/storage/blob-emulator"

const TENANT = "aaaaaaaa-1111-1111-1111-111111111111"
const OTHER = "aaaaaaaa-1111-1111-1111-111111111112"
const OWN = "bbbbbbbb-1111-1111-1111-111111111111"
const NEXT = "cccccccc-1111-1111-1111-111111111111"
const NOW = "2026-11-24T12:00:00.000Z"
const storage = `tvlocal-${TENANT}`
const raw = JSON.stringify([{ id: 1, name: "Fixture", resources: { storageAccountName: storage }, credentials: { tenantId: TENANT, appId: OWN, clientSecret: "fixture" } }])
const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`
const token = jwt({ tid: TENANT, scp: "User.Read DeviceManagementConfiguration.ReadWrite.All" })
const staged = (clientId: string, tenantId = TENANT): StagedSignIn => ({
  account: { tenantId, clientId, username: "fixture@example.test", homeAccountId: "fixture" },
  accessToken: token,
  cacheWrites: () => ({ ["msal." + clientId]: "fixture-cache" }),
})

let dir: string | undefined
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined })

function fixture() {
  dir = mkdtempSync(join(tmpdir(), "tv-connection-"))
  const cipher = { encrypt: (text: string) => Buffer.from(Buffer.from(text).map(byte => byte ^ 0xff)), decrypt: (value: Buffer) => value.map(byte => byte ^ 0xff).toString() }
  const file = join(dir, "app-state.bin")
  const store = new SecureStore(file, cipher)
  const signIn = vi.fn(async (_tenant: string, clientId: string) => staged(clientId))
  const modules = new ModuleSettings(store)
  const coverage = vi.fn((tenant: string, method: SignInMethod, accessToken: string) => connectionCoverage(modules.get(tenant), method, accessToken))
  const now = vi.fn(() => new Date(NOW))
  const connections = new TenantConnections({ store, signIn: { ownApp: signIn, graphCli: signIn, tenuvaultApp: signIn }, coverage, now })
  const entries = () => Object.fromEntries(store.keys().map(key => [key, store.get(key)]))
  const enroll = () => connections.enroll(TENANT, { method: "ownApp", clientId: OWN }, raw, staged(OWN))
  return { store, signIn, modules, coverage, now, connections, entries, enroll, file, reopen: () => new SecureStore(file, cipher) }
}

describe("tenant connection migration", () => {
  // Produced by serializeTenants from the corresponding release tags, using synthetic tenant IDs.
  it.each(["0.5.3.json", "0.5.4-nightly.json"])("preserves the stored settings from %s", async name => {
    const f = fixture()
    const settings = JSON.parse(readFileSync(new URL(`./fixtures/tenant-connections/${name}`, import.meta.url), "utf8"))
    f.store.setMany(settings)
    const list = JSON.parse(settings[TENANT_LIST_KEY]) as Array<{ credentials: { tenantId: string; appId: string }; createdAt?: string }>
    const choices = list.map(({ credentials }) => f.modules.get(credentials.tenantId))
    f.connections.migrate()
    const entries = f.entries()
    expect(entries).toMatchObject(settings)
    const reloaded = new TenantConnections({ store: f.reopen(), signIn: {}, coverage: f.coverage })
    for (const [i, { credentials, createdAt }] of list.entries()) {
      expect(reloaded.get(credentials.tenantId.toUpperCase())).toEqual({
        version: 1, method: "ownApp", origin: "legacy", clientId: credentials.appId,
        ownClientId: credentials.appId, createdAt: createdAt ?? NOW, updatedAt: NOW,
      })
      expect(f.modules.get(credentials.tenantId)).toEqual(choices[i])
      expect(choices[i]?.intune).toMatchObject({ enabled: true, connection: "default", access: "restore" })
      expect(choices[i]?.conditionalAccess.enabled).toBe(i === 0)
      expect(choices[i]?.defender.enabled).toBe(false)
      expect(choices[i]?.entra.enabled).toBe(false)
      await expect(f.connections.switch(credentials.tenantId, { method: "tenuvaultApp" })).rejects.toThrow("new wizard")
    }
    expect(readFileSync(f.file).includes(Buffer.from("auth.connection"))).toBe(false)
    f.connections.migrate()
    expect(f.entries()).toEqual(entries)
    expect(f.signIn).not.toHaveBeenCalled()
  })

  it("removes the record when the profile is removed and classifies an original-setup reconnect as legacy", () => {
    const f = fixture(); f.enroll()
    f.connections.saveProfiles("[]")
    expect(f.connections.get(TENANT)).toBeNull()
    f.connections.saveProfiles(raw)
    expect(f.connections.get(TENANT)?.origin).toBe("legacy")
    f.connections.saveProfiles(null)
    expect(f.store.get(TENANT_LIST_KEY)).toBeNull()
    expect(f.connections.get(TENANT)).toBeNull()
  })
})

describe("in-place sign-in change", () => {
  it("swaps client ID and account atomically, keeps tenant state, and recomputes coverage with the new token", async () => {
    const f = fixture(); f.enroll()
    f.now.mockReturnValue(new Date("2026-11-25T12:00:00Z"))
    const preserved = { "license.fixture": "activation", "schedule.fixture": "daily", "history.fixture": "backup", "services.modules": "{}" }
    f.store.setMany(preserved)
    const switchResult = await f.connections.switch(TENANT.toUpperCase(), { method: "tenuvaultApp" })
    expect(switchResult.connection).toMatchObject({ clientId: TENUVAULT_CLIENT_ID, method: "tenuvaultApp", ownClientId: OWN, createdAt: NOW, updatedAt: "2026-11-25T12:00:00.000Z" })
    expect(f.coverage).toHaveBeenCalledWith(TENANT, "tenuvaultApp", token)
    expect(switchResult.missing).toContain("Organization.Read.All")
    const store = f.reopen()
    expect(accountStore(store).get(TENANT)?.clientId).toBe(TENUVAULT_CLIENT_ID)
    expect(store.get(`msal.${TENUVAULT_CLIENT_ID}`)).toBe("fixture-cache")
    expect(JSON.parse(store.get(TENANT_LIST_KEY)!)[0]).toMatchObject({ id: 1, name: "Fixture", resources: { storageAccountName: storage }, credentials: { tenantId: TENANT, appId: TENUVAULT_CLIENT_ID } })
    expect(f.entries()).toMatchObject(preserved)
    f.connections.saveProfiles(raw)
    expect(JSON.parse(f.store.get(TENANT_LIST_KEY)!)[0].credentials.appId).toBe(TENUVAULT_CLIENT_ID)
    await expect(f.connections.switch(TENANT, { method: "graphCli" })).resolves.toMatchObject({ connection: { clientId: GRAPH_CLI_CLIENT_ID, ownClientId: OWN } })
    await expect(f.connections.switch(TENANT, { method: "ownApp", clientId: NEXT })).resolves.toMatchObject({ connection: { clientId: NEXT, ownClientId: NEXT } })
  })

  it.each(["sign-in", "wrong tenant", "wrong client", "coverage", "staged cache", "disk"] as const)("preserves all state when %s fails", async phase => {
    const f = fixture(); f.enroll()
    const before = f.entries()
    if (phase === "sign-in") f.signIn.mockRejectedValueOnce(new Error("Sign-in cancelled"))
    if (phase === "wrong tenant") f.signIn.mockResolvedValueOnce(staged(NEXT, OTHER))
    if (phase === "wrong client") f.signIn.mockResolvedValueOnce(staged(OWN))
    if (phase === "coverage") f.signIn.mockResolvedValueOnce({ ...staged(NEXT), accessToken: "unreadable" })
    if (phase === "staged cache") f.signIn.mockResolvedValueOnce({ ...staged(NEXT), cacheWrites: () => { throw new Error("The saved sign-in changed") } })
    if (phase === "disk") vi.spyOn(f.store, "setMany").mockImplementationOnce(() => { throw new Error("Disk error") })
    const error = { "sign-in": "cancelled", "wrong tenant": "different tenant", "wrong client": "different app", coverage: "delegated permissions", "staged cache": "saved sign-in changed", disk: "Disk error" }[phase]
    await expect(f.connections.switch(TENANT, { method: "ownApp", clientId: NEXT })).rejects.toThrow(error)
    expect(f.entries()).toEqual(before)
    await expect(f.connections.switch(TENANT, { method: "ownApp", clientId: NEXT })).resolves.toMatchObject({ connection: { clientId: NEXT } })
  })

  it("refuses a second switch while one is pending and drops a late answer after removal", async () => {
    const f = fixture(); f.enroll()
    let finish!: (result: StagedSignIn) => void
    f.signIn.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const pending = f.connections.switch(TENANT, { method: "ownApp", clientId: NEXT })
    await expect(f.connections.switch(TENANT.toUpperCase(), { method: "tenuvaultApp" })).rejects.toThrow("already in progress")
    f.connections.saveProfiles("[]")
    finish(staged(NEXT))
    await expect(pending).rejects.toThrow("changed during sign-in")
    expect(f.connections.get(TENANT)).toBeNull()
  })

  it("validates input and keeps Azure storage usable when Start now cannot use it", async () => {
    const f = fixture(); f.enroll()
    await expect(f.connections.switch("invalid", { method: "graphCli" })).rejects.toThrow("connected tenant")
    await expect(f.connections.switch(TENANT, { method: "graphCli", clientId: OWN })).rejects.toThrow("fixed client ID")
    await expect(f.connections.switch(TENANT, { method: "ownApp", clientId: GRAPH_CLI_CLIENT_ID })).rejects.toThrow("method that uses this client ID")
    f.connections.saveProfiles(raw.replace(storage, "fixtureaccount"))
    await expect(f.connections.switch(TENANT, { method: "graphCli" })).rejects.toThrow("Choose local storage")
    expect(f.signIn).not.toHaveBeenCalled()
  })

  it("stages the MSAL cache privately and checks for intervening writes before publishing", async () => {
    const f = fixture()
    // Use the same fixture directory for both stores.
    const old = new SecureStore(f.file + ".cache", { encrypt: Buffer.from, decrypt: data => data.toString() })
    const key = `msal.${OWN}`
    old.set(key, "old")
    const cache = connectionCache(f.store, old)
    const draft = stageConnectionCache(cache, OWN)
    const deserialize = vi.fn()
    const context = { tokenCache: { deserialize, serialize: () => "new" }, cacheHasChanged: true } as unknown as Parameters<typeof draft.plugin.beforeCacheAccess>[0]
    await draft.plugin.beforeCacheAccess(context)
    expect(deserialize).toHaveBeenCalledWith("old")
    await draft.plugin.afterCacheAccess(context)
    expect(cache.get(key)).toBe("old")
    f.store.setMany(draft.cacheWrites())
    expect(cache.get(key)).toBe("new")
    expect(() => draft.cacheWrites()).toThrow("saved sign-in changed")
    cache.set(key, "later")
    expect(f.store.get(key)).toBe("later")
    expect(old.get(key)).toBe("old")
  })
})

describe("Start now capability", () => {
  it("blocks writes even with a write token, including copy from or to the tenant", async () => {
    const f = fixture()
    const cap = new ConnectionCapabilities(id => f.connections.get(id))
    f.enroll()
    await f.connections.switch(TENANT, { method: "graphCli" })
    for (const [path, input] of [
      ["restore-backup", {}], ["revert-policy", { action: "revert" }], ["oib", { action: "oib-deploy" }],
      ["restore-directory", { action: "restore" }], ["restore-directory", { action: "resume" }],
      ["restore-backup", { targetTenants: [{ tenantId: OTHER }] }],
      ["restore-backup", { tenantId: OTHER, targetTenants: [{ tenantId: TENANT }] }],
    ] as const) {
      const response = await cap.guard(new Request(`http://test/api/${path}`, { method: "POST", body: JSON.stringify({ tenantId: TENANT, ...input }) }))
      expect(response?.status).toBe(403)
      expect(await response?.json()).toEqual({ error: READ_ONLY })
    }
    expect(() => cap.requireWrite([TENANT])).toThrow(READ_ONLY)
    expect(() => cap.requireWrite([OTHER])).not.toThrow()
    const graph = "https://graph.microsoft.com/beta"
    const network = vi.fn(async () => new Response("{}"))
    const fetch = createBridgedFetch({
      dispatch: vi.fn(), getDelegatedToken: vi.fn(), fetch: network,
      authorizeGraphRequest: (url, input, init, tenant) => cap.authorizeGraphRequest(url, input, init, tenant),
      authorizeResource: (tenant, scope) => cap.requireResource(tenant, scope),
    })
    const headers = { Authorization: `Bearer ${token}` }
    await expect(fetch(graph + "/deviceManagement/configurationPolicies", { method: "POST", headers })).rejects.toThrow(READ_ONLY)
    await expect(withRouteTenant(TENANT, () => fetch(graph + "/$batch", { method: "POST", body: JSON.stringify({ requests: [{ method: "PATCH" }] }) }))).rejects.toThrow(READ_ONLY)
    await expect(fetch(graph + "/$batch", { method: "POST", headers, body: JSON.stringify({ requests: [{ method: "GET" }] }) })).resolves.toBeInstanceOf(Response)
    await expect(fetch(graph + "/organization", { headers })).resolves.toBeInstanceOf(Response)
    expect(network).toHaveBeenCalledTimes(2)
    for (const scope of [RESOURCE_SCOPES.management, RESOURCE_SCOPES.storage, "https://api.securitycenter.microsoft.com/.default"]) {
      expect(() => cap.requireResource(TENANT, scope)).toThrow("only connects to Microsoft Graph")
      const response = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: OWN, scope }) })
      expect(response.status).toBe(403)
    }
    expect(() => cap.requireResource(TENANT, RESOURCE_SCOPES.graph)).not.toThrow()
    expect(() => cap.requireConnection(TENANT, OWN, RESOURCE_SCOPES.graph)).toThrow("method changed")
  })
})
