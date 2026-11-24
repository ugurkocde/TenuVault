import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SecureStore } from "../src/main/storage/secure-store"
import { ModuleSettings } from "../src/main/services/settings"
import { TenantConnections, TENANT_LIST_KEY, type StagedSignIn } from "../src/main/auth/tenant-connections"
import { accountStore, connectionCache, publicAccountKey, stageConnectionCache } from "../src/main/auth/stores"
import { GRAPH_CLI_CLIENT_ID, TENUVAULT_CLIENT_ID, type SignInMethod } from "../src/shared/tenant-connection"
import { RESOURCE_SCOPES } from "../src/shared/constants"
import { connectionCoverage } from "../src/main/auth/connection-coverage"
import { ConnectionCapabilities, READ_ONLY } from "../src/main/auth/connection-capabilities"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
import { ApiHost } from "../src/main/api/host"
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
const currentAccounts = (store: SecureStore, connections: TenantConnections) => accountStore(store, undefined, tenant => {
  const record = connections.get(tenant)
  return !!record && record.method !== "ownApp"
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
  const tokenFile = join(dir, "token-cache.bin")
  const legacyCache = new SecureStore(tokenFile, cipher)
  const connectionHost = { store, legacyCache, signIn: { ownApp: signIn, graphCli: signIn, tenuvaultApp: signIn }, coverage, now }
  const connections = new TenantConnections(connectionHost)
  const entries = () => Object.fromEntries(store.keys().map(key => [key, store.get(key)]))
  const enroll = () => connections.enroll(TENANT, { method: "ownApp", clientId: OWN }, raw, staged(OWN))
  const reopen = () => new SecureStore(file, cipher)
  const reopenLegacy = () => new SecureStore(tokenFile, cipher)
  const restart = () => {
    const store = reopen()
    const connections = new TenantConnections({ ...connectionHost, store, legacyCache: reopenLegacy() })
    connections.migrate()
    return { store, connections, accounts: currentAccounts(store, connections) }
  }
  return { store, signIn, modules, coverage, now, connections, entries, enroll, file, reopen, reopenLegacy, legacyCache, restart }
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
    expect(accountStore(store).get(TENANT)).toBeNull()
    expect(currentAccounts(store, f.connections).get(TENANT)?.clientId).toBe(TENUVAULT_CLIENT_ID)
    expect(store.get(`msal.${TENUVAULT_CLIENT_ID}`)).toBe("fixture-cache")
    expect(JSON.parse(store.get(TENANT_LIST_KEY)!)[0]).toMatchObject({ id: 1, name: "Fixture", resources: { storageAccountName: storage }, credentials: { tenantId: TENANT, appId: OWN } })
    expect(f.entries()).toMatchObject(preserved)
    f.connections.saveProfiles(raw)
    expect(JSON.parse(f.store.get(TENANT_LIST_KEY)!)[0].credentials.appId).toBe(OWN)
    await expect(f.connections.switch(TENANT, { method: "graphCli" })).resolves.toMatchObject({ connection: { clientId: GRAPH_CLI_CLIENT_ID, ownClientId: OWN } })
    await expect(f.connections.switch(TENANT, { method: "ownApp", clientId: NEXT })).resolves.toMatchObject({ connection: { clientId: NEXT, ownClientId: NEXT } })
  })

  it.each([
    ["0.5.3.json", "graphCli", GRAPH_CLI_CLIENT_ID],
    ["0.5.4-nightly.json", "tenuvaultApp", TENUVAULT_CLIENT_ID],
  ] as const)("keeps the %s credential slot safe after switching to %s", async (name, method, publicId) => {
    const f = fixture()
    const legacySettings = JSON.parse(readFileSync(new URL(`./fixtures/tenant-connections/${name}`, import.meta.url), "utf8"))
    const legacyProfile = JSON.parse(legacySettings[TENANT_LIST_KEY])[0]
    legacyProfile.credentials.tenantId = TENANT
    f.connections.enroll(TENANT, { method: "ownApp", clientId: OWN }, JSON.stringify([legacyProfile]), staged(OWN))
    await f.connections.switch(TENANT, { method })
    const oldAppId = () => JSON.parse(f.reopen().get(TENANT_LIST_KEY)!)[0].credentials.appId
    expect(oldAppId()).toBe(OWN)
    expect(accountStore(f.reopen()).list()).toEqual([])
    expect(currentAccounts(f.reopen(), f.connections).list()).toMatchObject([{ clientId: publicId }])
    const active = f.connections.activeProfiles()!
    expect(JSON.parse(active)[0].credentials.appId).toBe(publicId)
    f.connections.saveProfiles(active)
    expect(oldAppId()).toBe(OWN)
    // A wizard tenant that only ever used a public registration needs setup in 0.5.x.
    f.connections.saveProfiles("[]")
    legacyProfile.credentials.appId = publicId
    f.connections.enroll(TENANT, { method }, JSON.stringify([legacyProfile]), staged(publicId))
    expect(oldAppId()).toBe("")
    expect(JSON.parse(f.connections.activeProfiles()!)[0].credentials.appId).toBe(publicId)
  })

  it.each(["ownApp", "graphCli"] as const)("requires fresh sign-in after a downgrade reauthenticates a %s connection", async method => {
    const f = fixture()
    f.enroll()
    await f.connections.switch(TENANT, method === "ownApp" ? { method, clientId: NEXT } : { method })
    const unchanged = f.restart()
    const active = unchanged.connections.get(TENANT)!
    expect(unchanged.accounts.get(TENANT)?.clientId).toBe(active.clientId)
    const oldAppStore = f.reopen()
    const oldClient = JSON.parse(oldAppStore.get(TENANT_LIST_KEY)!)[0].credentials.appId
    f.reopenLegacy().set(`msal.${oldClient}`, "0.5.x reauthenticated cache")
    accountStore(oldAppStore).set(staged(oldClient).account)
    const upgraded = f.restart()
    expect(upgraded.connections.get(TENANT)?.clientId).toBe(active.clientId)
    expect(upgraded.accounts.get(TENANT)).toBeNull()
    expect(upgraded.store.get(`msal.${active.clientId}`)).toBe("fixture-cache")
    upgraded.accounts.set(staged(active.clientId).account)
    expect(f.restart().accounts.get(TENANT)?.clientId).toBe(active.clientId)
  })

  it("requires a fresh sign-in for a mismatched account even without a legacy cache write", async () => {
    const f = fixture()
    f.enroll()
    await f.connections.switch(TENANT, { method: "tenuvaultApp" })
    accountStore(f.store).set(staged(OWN).account)
    expect(f.restart().accounts.get(TENANT)).toBeNull()
  })

  it("moves a public sign-in and repairs legacy settings written by an earlier 0.6 build", async () => {
    const f = fixture()
    f.enroll()
    await f.connections.switch(TENANT, { method: "graphCli" })
    f.store.setMany({ [TENANT_LIST_KEY]: f.connections.activeProfiles()! }, [publicAccountKey(TENANT)])
    accountStore(f.store).set(staged(GRAPH_CLI_CLIENT_ID).account)
    const migrated = f.restart()
    expect(migrated.accounts.get(TENANT)?.clientId).toBe(GRAPH_CLI_CLIENT_ID)
    expect(accountStore(migrated.store).get(TENANT)).toBeNull()
    expect(JSON.parse(migrated.store.get(TENANT_LIST_KEY)!)[0].credentials.appId).toBe(OWN)
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
  it.each(["source", "destination"] as const)("stops copy batches if the %s switches after admission", async side => {
    const f = fixture()
    const changedTenant = side === "source" ? TENANT : OTHER
    const account = staged(OWN, changedTenant)
    f.signIn.mockImplementation(async (id, client) => staged(client, id))
    f.connections.enroll(changedTenant, { method: "ownApp", clientId: OWN }, raw.replaceAll(TENANT, changedTenant), account)
    const cap = new ConnectionCapabilities(id => f.connections.get(id))
    const network = vi.fn(async () => new Response("{}"))
    const fetch = createBridgedFetch({
      dispatch: vi.fn(), getDelegatedToken: vi.fn(), fetch: network,
      authorizeGraphRequest: (url, input, init, tenant) => cap.authorizeGraphRequest(url, input, init, tenant),
    })
    const batch = (method: string, authorization = `Bearer ${jwt({ tid: OTHER })}`) => fetch("https://graph.microsoft.com/beta/$batch", {
      method: "POST", headers: { authorization }, body: JSON.stringify({ requests: [{ id: "1", method, url: "/deviceManagement/configurationPolicies" }] }),
    })
    const host = new ApiHost({ guard: request => cap.guard(request), routes: {
      "/api/restore-backup": { POST: async () => {
        await batch("POST")
        await f.connections.switch(changedTenant, { method: "graphCli" })
        await expect(batch("POST")).rejects.toThrow(READ_ONLY)
        await expect(batch("POST", "Bearer opaque")).rejects.toThrow(READ_ONLY)
        await expect(batch("GET")).resolves.toBeInstanceOf(Response)
        return Response.json({ ok: true })
      } },
    } })
    const response = await host.dispatch(new Request("http://test/api/restore-backup", {
      method: "POST", body: JSON.stringify({ tenantId: TENANT, targetTenants: [{ tenantId: OTHER, appId: OWN }] }),
    }))
    expect(response.status).toBe(200)
    expect(network).toHaveBeenCalledTimes(2)
  })

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
