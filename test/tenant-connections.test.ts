import { graphPermissions } from "../src/shared/services/manifest"
import { resourcePackScopes, tenantPermissionPacks } from "../src/shared/services/permission-packs"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SecureStore } from "../src/main/storage/secure-store"
import { ModuleSettings } from "../src/main/services/settings"
import { TenantConnections, TENANT_LIST_KEY, type StagedSignIn } from "../src/main/auth/tenant-connections"
import { accountStore, connectionCache, publicAccountKey, stageConnectionCache } from "../src/main/auth/stores"
import { CONNECTION_WRITE_REFUSED, SETUP_HELPER_CLIENT_ID, START_NOW_REMOVED_REASON, TENUVAULT_CLIENT_ID, type SignInMethod, type TenantConnection } from "../src/shared/tenant-connection"
import { RESOURCE_SCOPES } from "../src/shared/constants"
import { connectionChoice, connectionCoverage } from "../src/main/auth/connection-coverage"
import { ConnectionCapabilities } from "../src/main/auth/connection-capabilities"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
import { executionMetadata } from "../src/main/api/execution-metadata"
import { ApiHost } from "../src/main/api/host"
import { createArmCaller } from "../src/main/azure/arm"
import { withRouteTenant } from "../src/main/storage/blob-emulator"

const TENANT = "aaaaaaaa-1111-1111-1111-111111111111"
const OTHER = "aaaaaaaa-1111-1111-1111-111111111112"
const OWN = "bbbbbbbb-1111-1111-1111-111111111111"
const NEXT = "cccccccc-1111-1111-1111-111111111111"
const NOW = "2026-11-24T12:00:00.000Z"
const storage = `tvlocal-${TENANT}`
const raw = JSON.stringify([{ id: 1, name: "Fixture", resources: { storageAccountName: storage }, credentials: { tenantId: TENANT, appId: OWN, clientSecret: "fixture" } }])
const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`
const defaultSettings = new ModuleSettings({ get: () => null, set: () => undefined, delete: () => undefined }).get(TENANT)
const token = jwt({ tid: TENANT, scp: graphPermissions(connectionChoice(defaultSettings), "delegated").join(" ") })
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
  const coverage = vi.fn((tenant: string, method: SignInMethod, accessToken: string, graphScopes?: string[], grantedScopes?: readonly string[]) => connectionCoverage(modules.get(tenant), method, accessToken, graphScopes, grantedScopes))
  const now = vi.fn(() => new Date(NOW))
  const tokenFile = join(dir, "token-cache.bin")
  const legacyCache = new SecureStore(tokenFile, cipher)
  const connectionHost = { store, legacyCache, signIn: { ownApp: signIn, tenuvaultApp: signIn }, coverage, now }
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
      expect(choices[i]?.entra.enabled).toBe(false)
      await expect(f.connections.switch(credentials.tenantId, { method: "tenuvaultApp" })).rejects.toThrow("new wizard")
    }
    expect(readFileSync(f.file).includes(Buffer.from("auth.connection"))).toBe(false)
    f.connections.migrate()
    expect(f.entries()).toEqual(entries)
    expect(f.signIn).not.toHaveBeenCalled()
  })

  it.each([[OWN, "2026-11-25T12:00:00.000Z"], [NEXT, NOW]])("keeps a fresh 0.5.x profile and account when it re-adds the tenant with %s", async (clientId, createdAt) => {
    const f = fixture()
    const profiles = JSON.parse(raw)
    profiles[0].createdAt = NOW
    f.connections.enroll(TENANT, { method: "ownApp", clientId: OWN }, JSON.stringify(profiles), staged(OWN))
    await f.connections.switch(TENANT, { method: "tenuvaultApp" })
    const legacy = f.reopen()
    legacy.set(TENANT_LIST_KEY, "[]")
    const readded = JSON.parse(raw)[0]
    readded.createdAt = createdAt
    readded.credentials.appId = clientId
    const profile = JSON.stringify([readded])
    legacy.set(TENANT_LIST_KEY, profile)
    accountStore(legacy).set(staged(clientId).account)
    f.reopenLegacy().set(`msal.${clientId}`, "new legacy sign-in")

    const upgraded = f.restart()
    expect(upgraded.connections.get(TENANT)).toMatchObject({ origin: "legacy", method: "ownApp", clientId, createdAt: readded.createdAt })
    expect(upgraded.accounts.get(TENANT)?.clientId).toBe(clientId)
    expect(upgraded.store.get(publicAccountKey(TENANT))).toBeNull()
    expect(upgraded.store.get(TENANT_LIST_KEY)).toBe(profile)
    await expect(upgraded.connections.switch(TENANT, { method: "ownApp", clientId: NEXT })).rejects.toThrow("new wizard")
    expect(f.restart().connections.get(TENANT)).toEqual(upgraded.connections.get(TENANT))
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
  it("preserves the current connection when the new registration has unverifiable coverage", async () => {
    const f = fixture()
    f.enroll()
    const before = f.entries()
    f.signIn.mockResolvedValueOnce({ ...staged(NEXT), accessToken: "opaque", grantedScopes: ["https://graph.microsoft.com/.default"] })
    await expect(f.connections.switch(TENANT, { method: "ownApp", clientId: NEXT })).rejects.toThrow("delegated permissions")
    expect(f.entries()).toEqual(before)
    expect(f.restart().accounts.get(TENANT)?.clientId).toBe(OWN)
  })

  it("commits a verified own registration switch and returns missing permissions for Settings", async () => {
    const f = fixture()
    f.enroll()
    const accessToken = jwt({ tid: TENANT, scp: "User.Read" })
    const expected = connectionCoverage(f.modules.get(TENANT), "ownApp", accessToken)
    expect(expected).not.toHaveLength(0)
    f.signIn.mockResolvedValueOnce({ ...staged(NEXT), accessToken })
    await expect(f.connections.switch(TENANT, { method: "ownApp", clientId: NEXT })).resolves.toMatchObject({
      connection: { clientId: NEXT, method: "ownApp" }, account: { clientId: NEXT }, missing: expected,
    })
    const saved = f.restart()
    expect(saved.accounts.get(TENANT)?.clientId).toBe(NEXT)
    expect(saved.store.get(`msal.${NEXT}`)).toBe("fixture-cache")
  })

  it("matches the base switch contract when the new own registration lacks Policy.Read.All", async () => {
    const f = fixture()
    f.enroll()
    f.modules.setChoice(TENANT, { conditionalAccess: { access: "backup" } })
    f.signIn.mockResolvedValueOnce({ ...staged(NEXT), accessToken: jwt({ tid: TENANT, scp: "User.Read Organization.Read.All" }) })
    const result = await f.connections.switch(TENANT, { method: "ownApp", clientId: NEXT })
    expect(result.missing).toEqual(["Policy.Read.All"])
    expect(f.restart().connections.get(TENANT)).toMatchObject({ method: "ownApp", clientId: NEXT })
  })

  it("swaps client ID and account atomically, keeps tenant state, and recomputes coverage with the new token", async () => {
    const f = fixture(); f.enroll()
    f.now.mockReturnValue(new Date("2026-11-25T12:00:00Z"))
    const preserved = { "license.fixture": "activation", "schedule.fixture": "daily", "history.fixture": "backup", "services.modules": "{}" }
    f.store.setMany(preserved)
    const switchResult = await f.connections.switch(TENANT.toUpperCase(), { method: "tenuvaultApp" })
    expect(switchResult.connection).toMatchObject({ clientId: TENUVAULT_CLIENT_ID, method: "tenuvaultApp", ownClientId: OWN, createdAt: NOW, updatedAt: "2026-11-25T12:00:00.000Z" })
    expect(f.coverage).toHaveBeenCalledWith(TENANT, "tenuvaultApp", token, undefined, undefined)
    expect(switchResult.missing).toEqual([])
    const store = f.reopen()
    expect(accountStore(store).get(TENANT)).toBeNull()
    expect(currentAccounts(store, f.connections).get(TENANT)?.clientId).toBe(TENUVAULT_CLIENT_ID)
    expect(store.get(`msal.${TENUVAULT_CLIENT_ID}`)).toBe("fixture-cache")
    expect(JSON.parse(store.get(TENANT_LIST_KEY)!)[0]).toMatchObject({ id: 1, name: "Fixture", resources: { storageAccountName: storage }, credentials: { tenantId: TENANT, appId: OWN } })
    expect(f.entries()).toMatchObject(preserved)
    f.connections.saveProfiles(raw)
    expect(JSON.parse(f.store.get(TENANT_LIST_KEY)!)[0].credentials.appId).toBe(OWN)
    await expect(f.connections.switch(TENANT, { method: "ownApp", clientId: NEXT })).resolves.toMatchObject({ connection: { clientId: NEXT, ownClientId: NEXT } })
  })

  it("keeps the 0.5.4-nightly.json credential slot safe after switching to tenuvaultApp", async () => {
    const f = fixture()
    const legacySettings = JSON.parse(readFileSync(new URL("./fixtures/tenant-connections/0.5.4-nightly.json", import.meta.url), "utf8"))
    const legacyProfile = JSON.parse(legacySettings[TENANT_LIST_KEY])[0]
    legacyProfile.credentials.tenantId = TENANT
    f.connections.enroll(TENANT, { method: "ownApp", clientId: OWN }, JSON.stringify([legacyProfile]), staged(OWN))
    await f.connections.switch(TENANT, { method: "tenuvaultApp" })
    const oldAppId = () => JSON.parse(f.reopen().get(TENANT_LIST_KEY)!)[0].credentials.appId
    expect(oldAppId()).toBe(OWN)
    expect(accountStore(f.reopen()).list()).toEqual([])
    expect(currentAccounts(f.reopen(), f.connections).list()).toMatchObject([{ clientId: TENUVAULT_CLIENT_ID }])
    const active = f.connections.activeProfiles()!
    expect(JSON.parse(active)[0].credentials.appId).toBe(TENUVAULT_CLIENT_ID)
    f.connections.saveProfiles(active)
    expect(oldAppId()).toBe(OWN)
    // A wizard tenant that only ever used a public registration needs setup in 0.5.x.
    f.connections.saveProfiles("[]")
    legacyProfile.credentials.appId = TENUVAULT_CLIENT_ID
    f.connections.enroll(TENANT, { method: "tenuvaultApp" }, JSON.stringify([legacyProfile]), staged(TENUVAULT_CLIENT_ID))
    expect(oldAppId()).toBe("")
    expect(JSON.parse(f.connections.activeProfiles()!)[0].credentials.appId).toBe(TENUVAULT_CLIENT_ID)
  })

  it.each(["ownApp", "tenuvaultApp"] as const)("requires fresh sign-in after a downgrade reauthenticates a %s connection", async method => {
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
    await f.connections.switch(TENANT, { method: "tenuvaultApp" })
    f.store.setMany({ [TENANT_LIST_KEY]: f.connections.activeProfiles()! }, [publicAccountKey(TENANT)])
    accountStore(f.store).set(staged(TENUVAULT_CLIENT_ID).account)
    const migrated = f.restart()
    expect(migrated.accounts.get(TENANT)?.clientId).toBe(TENUVAULT_CLIENT_ID)
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

  it("returns a fixed error across IPC and logs only the code", async () => {
    const f = fixture(); f.enroll()
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const returnToApp = vi.fn()
    try {
      f.signIn.mockRejectedValueOnce(new Error("Microsoft could not authenticate private.admin@example.test"))
      await expect(f.connections.switchForIpc(TENANT, { method: "ownApp", clientId: NEXT }, returnToApp)).resolves.toEqual({
        error: { code: "switch_failed", message: "The app registration could not be changed. Try again." },
      })
      expect(warning.mock.calls).toEqual([["[auth:switchConnection]", "switch_failed"]])
      expect(returnToApp).toHaveBeenCalledOnce()
      expect(f.connections.get(TENANT)?.clientId).toBe(OWN)
    } finally {
      warning.mockRestore()
    }
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

  it("validates input and rejects the setup helper client ID or removed methods", async () => {
    const f = fixture(); f.enroll()
    await expect(f.connections.switch("invalid", { method: "tenuvaultApp" })).rejects.toThrow("connected tenant")
    await expect(f.connections.switch(TENANT, { method: "tenuvaultApp", clientId: OWN })).rejects.toThrow("fixed client ID")
    await expect(f.connections.switch(TENANT, { method: "ownApp", clientId: TENUVAULT_CLIENT_ID })).rejects.toThrow("method that uses this client ID")
    await expect(f.connections.switch(TENANT, { method: "ownApp", clientId: SETUP_HELPER_CLIENT_ID })).rejects.toThrow("setup helper")
    await expect(f.connections.switch(TENANT, { method: "graphCli" as SignInMethod })).rejects.toThrow("Unsupported sign-in method")
    expect(() => f.connections.enroll(OTHER, { method: "ownApp", clientId: SETUP_HELPER_CLIENT_ID }, raw.replaceAll(TENANT, OTHER), staged(SETUP_HELPER_CLIENT_ID, OTHER))).toThrow("setup helper")
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

describe("Removed Start now connection guard", () => {
  it.each(["source", "destination"] as const)("stops copy batches if the %s needs a sign-in method after admission", async side => {
    const own: TenantConnection = { version: 1, method: "ownApp", clientId: OWN, origin: "wizard", createdAt: NOW, updatedAt: NOW }
    const needsMethod: TenantConnection = { ...own, method: null, clientId: "", needsSignInMethod: true }
    let source = own
    let dest = own
    const cap = new ConnectionCapabilities(id => id === TENANT ? source : id === OTHER ? dest : null)
    const network = vi.fn(async () => new Response("{}"))
    const fetch = createBridgedFetch({
      dispatch: vi.fn(), getDelegatedToken: vi.fn(), fetch: network,
      authorizeRequest: (url, input, init, tenant) => cap.authorizeRequest(url, input, init, tenant),
    })
    cap.requireIssuedToken(OTHER, OWN, RESOURCE_SCOPES.graph, "opaque-destination")
    const batch = (method: string, authorization = "Bearer opaque-destination") => fetch("https://graph.microsoft.com/beta/$batch", {
      method: "POST", headers: { authorization }, body: JSON.stringify({ requests: [{ id: "1", method, url: "/deviceManagement/configurationPolicies" }] }),
    })
    const host = new ApiHost({ bindConnections: tenants => cap.bindConnections(tenants), guard: request => cap.guard(request), routes: {
      "/api/restore-backup": { POST: async () => {
        await batch("POST")
        if (side === "source") source = needsMethod
        else dest = needsMethod
        await expect(batch("POST")).rejects.toThrow(START_NOW_REMOVED_REASON)
        await expect(batch("POST", "Bearer opaque")).rejects.toThrow(START_NOW_REMOVED_REASON)
        if (side === "source") await expect(batch("GET")).resolves.toBeInstanceOf(Response)
        else await expect(batch("GET")).rejects.toThrow(START_NOW_REMOVED_REASON)
        return Response.json({ ok: true })
      } },
    } })
    const response = await host.dispatch(new Request("http://test/api/restore-backup", {
      method: "POST", body: JSON.stringify({ tenantId: TENANT, targetTenants: [{ tenantId: OTHER, appId: OWN }] }),
    }))
    expect(response.status).toBe(200)
    expect(network).toHaveBeenCalledTimes(side === "source" ? 2 : 1)
  })

  it("stops Copy to Tenants if the source loses its sign-in method after the bridge starts authorization", async () => {
    const own: TenantConnection = { version: 1, method: "ownApp", clientId: OWN, origin: "wizard", createdAt: NOW, updatedAt: NOW }
    let source = own
    const cap = new ConnectionCapabilities(id => id === TENANT ? source : own)
    const network = vi.fn(async () => new Response("{}"))
    const fetch = createBridgedFetch({
      dispatch: vi.fn(), getDelegatedToken: vi.fn(), fetch: network,
      authorizeRequest: (url, input, init, tenant) => {
        const authorization = cap.authorizeRequest(url, input, init, tenant)
        queueMicrotask(() => { source = { ...own, method: null, clientId: "", needsSignInMethod: true } })
        return authorization
      },
    })
    cap.requireIssuedToken(OTHER, OWN, RESOURCE_SCOPES.graph, "opaque-destination")
    const host = new ApiHost({ bindConnections: ids => cap.bindConnections(ids), guard: request => cap.guard(request), routes: {
      "/api/restore-backup": { POST: async () => {
        await expect(fetch("https://graph.microsoft.com/beta/deviceManagement/configurationPolicies", {
          method: "POST", headers: { authorization: "Bearer opaque-destination" },
        })).rejects.toThrow(START_NOW_REMOVED_REASON)
        return Response.json({ ok: true })
      } },
    } })
    const response = await host.dispatch(new Request("http://test/api/restore-backup", {
      method: "POST", body: JSON.stringify({ tenantId: TENANT, targetTenants: [{ tenantId: OTHER, appId: OWN }] }),
    }))
    expect(network).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
  })

  it.each(["POST", "PATCH", "PUT", "DELETE", "batch"])("stops a single-tenant restore %s in the bridge's last turn", async method => {
    const own: TenantConnection = { version: 1, method: "ownApp", clientId: OWN, origin: "wizard", createdAt: NOW, updatedAt: NOW }
    let record = own
    let nextConnection: TenantConnection = { ...own, clientId: NEXT }
    const cap = new ConnectionCapabilities(() => record)
    cap.requireIssuedToken(TENANT, OWN, RESOURCE_SCOPES.graph, "opaque-restore")
    const network = vi.fn(async () => new Response("{}"))
    const fetch = createBridgedFetch({
      dispatch: vi.fn(), getDelegatedToken: vi.fn(), fetch: network,
      authorizeRequest: (url, input, init, tenant) => {
        const authorization = cap.authorizeRequest(url, input, init, tenant)
        queueMicrotask(() => { record = nextConnection })
        return authorization
      },
    })
    const host = new ApiHost({ bindConnections: ids => cap.bindConnections(ids), guard: request => cap.guard(request), routes: {
      "/api/restore-backup": { POST: async () => {
        const path = "/deviceManagement/configurationPolicies"
        const batch = method === "batch"
        const response = await fetch(`https://graph.microsoft.com/beta${batch ? "/$batch" : path}`, {
          method: batch ? "POST" : method, headers: { authorization: "Bearer opaque-restore" },
          ...(batch ? { body: JSON.stringify({ requests: [{ id: "1", method: "PATCH", url: path }] }) } : {}),
        })
        return Response.json({ ok: response.ok })
      } },
    } })
    const restore = () => host.dispatch(new Request("http://test/api/restore-backup", {
      method: "POST", body: JSON.stringify({ tenantId: TENANT }),
    }))
    expect(await (await restore()).json()).toEqual({ ok: true })
    expect(network).toHaveBeenCalledOnce()
    record = own
    nextConnection = { ...own, method: null, clientId: "", needsSignInMethod: true }
    expect(await (await restore()).json()).toEqual({ error: `${START_NOW_REMOVED_REASON} Choose a sign-in method.` })
    expect(network).toHaveBeenCalledOnce()
  })

  it("blocks writes and Graph calls for a tenant needing a sign-in method", async () => {
    const needsMethod: TenantConnection = { version: 1, method: null, clientId: "", origin: "wizard", needsSignInMethod: true, createdAt: NOW, updatedAt: NOW }
    const cap = new ConnectionCapabilities(id => id === TENANT ? needsMethod : null, undefined, async () => true)
    const expectedError = `${START_NOW_REMOVED_REASON} Choose a sign-in method.`
    for (const [path, input] of [
      ["restore-backup", {}], ["revert-policy", { action: "revert" }], ["oib", { action: "oib-deploy" }],
      ["oib", { action: "oib-assign" }], ["cis-remediation", { action: "apply" }], ["promotion", { action: "apply" }],
      ["restore-directory", { action: "restore" }], ["restore-directory", { action: "resume" }],
      ["restore-backup", { targetTenants: [{ tenantId: OTHER }] }],
      ["restore-backup", { tenantId: OTHER, targetTenants: [{ tenantId: TENANT }] }],
    ] as const) {
      const response = await cap.guard(new Request(`http://test/api/${path}`, { method: "POST", body: JSON.stringify({ tenantId: TENANT, ...input }) }))
      expect(response?.status).toBe(403)
      expect(await response?.json()).toEqual(path === "restore-backup" ? { error: expectedError, code: CONNECTION_WRITE_REFUSED } : { error: expectedError })
    }
    expect(() => cap.requireWrite([TENANT])).toThrow(START_NOW_REMOVED_REASON)
    expect(() => cap.requireWrite([OTHER])).not.toThrow()
    const network = vi.fn(async () => new Response("{}"))
    const fetch = createBridgedFetch({
      dispatch: vi.fn(), getDelegatedToken: vi.fn(), fetch: network,
      authorizeRequest: (url, input, init, tenant) => cap.authorizeRequest(url, input, init, tenant),
      authorizeResource: (tenant, scope) => cap.requireResource(tenant, scope),
    })
    const headers = { Authorization: `Bearer ${jwt({ tid: TENANT, appid: OWN, scp: "DeviceManagementConfiguration.ReadWrite.All" })}` }
    await expect(fetch("https://graph.microsoft.com/beta/organization", { headers })).rejects.toThrow(START_NOW_REMOVED_REASON)
    await expect(withRouteTenant(TENANT, () => fetch("https://graph.microsoft.com/beta/$batch", { method: "POST", body: JSON.stringify({ requests: [{ method: "PATCH" }] }) }))).rejects.toThrow(START_NOW_REMOVED_REASON)
    expect(network).not.toHaveBeenCalled()
    expect(() => cap.requireResource(TENANT, RESOURCE_SCOPES.graph)).toThrow(START_NOW_REMOVED_REASON)
    expect(() => cap.requireConnection(TENANT, OWN, RESOURCE_SCOPES.graph)).toThrow(START_NOW_REMOVED_REASON)
  })
})


describe("dispatch after asynchronous authorization", () => {
  it.each([
    ["ARM deployment", "https://management.azure.com/subscriptions/fixture/providers/Microsoft.Resources/deployments/watcher?api-version=2022-09-01", RESOURCE_SCOPES.management],
    ["watcher alerts.json", "https://backupfixture.blob.core.windows.net/tenuvault-notification-state/alerts.json", RESOURCE_SCOPES.storage],
  ])("stops the %s PUT when its tenant loses its sign-in method", async (_, url, scope) => {
    const own = { version: 1, clientId: OWN, method: "ownApp", origin: "wizard", createdAt: NOW, updatedAt: NOW } as const
    let current: TenantConnection = own
    let next: TenantConnection = { ...own, clientId: NEXT }
    const caps = new ConnectionCapabilities(id => id === TENANT ? current : null)
    const network = vi.fn<typeof fetch>(async () => new Response("{}"))
    const fetch = createBridgedFetch({
      dispatch: vi.fn(), getDelegatedToken: vi.fn(), fetch: network,
      authorizeRequest: async (...args) => {
        const authorization = await caps.authorizeRequest(...args)
        current = next
        return authorization
      },
    })
    const token = "opaque-azure-token"
    caps.requireIssuedToken(TENANT, OWN, scope, token)
    const run = () => executionMetadata.run({ connections: caps.bindConnections([TENANT]) }, () => {
      if (scope === RESOURCE_SCOPES.management) {
        const path = new URL(url)
        return createArmCaller({ fetch, getToken: async () => token })({ method: "PUT", path: path.pathname + path.search, body: {} })
      }
      return fetch(url, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: "{}" }).then(response => ({ status: response.status }))
    })
    await expect(run()).resolves.toMatchObject({ status: 200 })
    expect(network).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({ method: "PUT" }))

    current = own
    next = { ...own, clientId: "", method: null, needsSignInMethod: true }
    await expect(run()).rejects.toThrow(START_NOW_REMOVED_REASON)
    expect(network).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["tenuvaultApp", TENUVAULT_CLIENT_ID, "GET"],
    ["tenuvaultApp", TENUVAULT_CLIENT_ID, "POST"],
  ] as const)("stops a read when cached availability changes for %s (%#)", async (method, clientId, verb) => {
    let enabled = true
    let disableBeforeDispatch = false
    const caps = new ConnectionCapabilities(() => ({
      version: 1, clientId, method, origin: "wizard", createdAt: NOW, updatedAt: NOW,
    }), undefined, async () => enabled, () => enabled)
    const network = vi.fn<typeof fetch>(async () => new Response("{}"))
    const fetch = createBridgedFetch({
      dispatch: vi.fn(), getDelegatedToken: vi.fn(), fetch: network,
      authorizeRequest: async (...args) => {
        const authorization = await caps.authorizeRequest(...args)
        if (disableBeforeDispatch) enabled = false
        return authorization
      },
    })
    const token = "opaque-graph-token"
    caps.requireIssuedToken(TENANT, clientId, RESOURCE_SCOPES.graph, token)
    const send = () => fetch(`https://graph.microsoft.com/beta/${verb === "GET" ? "users" : "$batch"}`, {
      method: verb,
      headers: { authorization: `Bearer ${token}` },
      ...(verb === "POST" ? { body: JSON.stringify({ requests: [{ id: "1", method: "GET", url: "/users" }] }) } : {}),
    })
    await expect(send()).resolves.toMatchObject({ status: 200 })
    disableBeforeDispatch = true
    await expect(send()).rejects.toThrow("temporarily unavailable")
    expect(network).toHaveBeenCalledTimes(1)
  })
})

describe("TenuVault app capabilities", () => {
  it("publishes a verified restore pack and its service setting together", () => {
    const f = fixture()
    const choice = { intune: { access: "backup" } } as const
    const read = resourcePackScopes(tenantPermissionPacks(choice, { azure: false, audit: false }), "graph")
    f.connections.enroll(TENANT, { method: "tenuvaultApp" }, raw, {
      ...staged(TENUVAULT_CLIENT_ID), graphScopes: read,
    }, f.modules.choiceEntries(TENANT, choice))
    const record = f.connections.get(TENANT)!
    const restore = tenantPermissionPacks({ intune: { access: "restore" } }, { azure: false, audit: false }).find(pack => pack.id === "intune-restore")!
    const settings = f.modules.restoreAccessEntries(TENANT, "intune")
    expect(f.modules.get(TENANT).intune.access).toBe("backup")
    expect(f.connections.addVerifiedGraphScopes(TENANT, { ...record, updatedAt: "stale" }, restore.scopes, settings)).toBe(false)
    expect(f.modules.get(TENANT).intune.access).toBe("backup")
    expect(f.connections.addVerifiedGraphScopes(TENANT, record, restore.scopes, settings)).toBe(true)
    expect(f.connections.get(TENANT)?.graphScopes).toEqual([...new Set([...read, ...restore.scopes])])
    expect(f.modules.get(TENANT).intune.access).toBe("restore")
    expect(f.modules.get(TENANT).entra.enabled).toBe(false)
  })

  it("requires the chosen, verified service restore pack and its scopes in the delegated token", async () => {
    let packs = tenantPermissionPacks({ intune: { access: "backup" } }, { azure: false, audit: false })
    let graphScopes = resourcePackScopes(packs, "graph")
    let enabled = true
    const record = () => ({
      version: 1 as const, clientId: TENUVAULT_CLIENT_ID, method: "tenuvaultApp" as const, origin: "wizard" as const,
      createdAt: NOW, updatedAt: NOW, graphScopes,
    })
    const caps = new ConnectionCapabilities(record, () => packs, async () => enabled)
    const send = async (claims: object, path = "deviceManagement/configurationPolicies") => {
      const url = new URL("https://graph.microsoft.com/beta/" + path)
      const authorization = await caps.authorizeRequest(url, url, { method: "POST", headers: { Authorization: `Bearer ${jwt(claims)}` } }, TENANT)
      authorization?.beforeDispatch?.()
    }
    const broad = { tid: TENANT, azp: TENUVAULT_CLIENT_ID, scp: graphScopes.join(" ") + " DeviceManagementConfiguration.ReadWrite.All Application.ReadWrite.All" }
    await expect(send(broad)).rejects.toThrow("Review the restore permissions for this service in Settings > Sign-in.")

    packs = tenantPermissionPacks({ intune: { access: "restore" } }, { azure: false, audit: false })
    await expect(send(broad)).rejects.toThrow("Review the restore permissions for this service in Settings > Sign-in.")
    graphScopes = resourcePackScopes(packs, "graph")
    await expect(send(broad)).rejects.toThrow("Review the restore permissions for this service in Settings > Sign-in.")
    const allowed = { ...broad, scp: graphScopes.join(" ") }
    await expect(send(allowed)).resolves.toBeUndefined()
    await expect(send(allowed, "identity/conditionalAccess/policies")).rejects.toThrow("Review the restore permissions for this service in Settings > Sign-in.")
    await expect(send(allowed, "applications")).rejects.toThrow("Review the restore permissions for this service in Settings > Sign-in.")
    await expect(send({ ...allowed, azp: OWN })).rejects.toThrow("method changed")
    enabled = false
    await expect(send(allowed)).rejects.toThrow("temporarily unavailable")
  })

  it("stops already issued tokens across resources when health changes or the tenant switches", async () => {
    const packs = tenantPermissionPacks({ intune: { access: "restore" } }, { azure: true, audit: false })
    const graphScopes = resourcePackScopes(packs, "graph")
    let enabled = true
    const shared = { version: 1 as const, clientId: TENUVAULT_CLIENT_ID, method: "tenuvaultApp" as const, origin: "wizard" as const, createdAt: NOW, updatedAt: NOW, graphScopes }
    let record: TenantConnection = shared
    const cap = new ConnectionCapabilities(id => id === TENANT ? record : null, () => packs, async () => enabled)
    const network = vi.fn(async () => new Response("{}"))
    const fetch = createBridgedFetch({
      dispatch: vi.fn(), getDelegatedToken: vi.fn(), fetch: network,
      authorizeRequest: (url, input, init, tenant) => cap.authorizeRequest(url, input, init, tenant),
    })
    const graph = "https://graph.microsoft.com/beta"
    const paths: Array<[string, RequestInit?]> = [
      [graph + "/organization"],
      [graph + "/organization", { method: "HEAD" }],
      [graph + "/$batch", { method: "POST", body: JSON.stringify({ requests: [{ method: "GET", url: "/organization" }] }) }],
      [graph + "/deviceManagement/configurationPolicies", { method: "POST" }],
      ["https://management.azure.com/subscriptions"],
      ["https://example.blob.core.windows.net/container", { method: "PUT" }],
    ]
    const claims = { tid: TENANT, appid: TENUVAULT_CLIENT_ID, scp: graphScopes.join(" ") }
    const send = (path: string, init?: RequestInit, accessToken = jwt(claims)) =>
      fetch(path, { ...init, headers: { authorization: `Bearer ${accessToken}` } })
    for (const [path, init] of paths) await send(path, init)
    enabled = false
    for (const [path, init] of paths) await expect(send(path, init)).rejects.toThrow("temporarily unavailable")
    expect(network).toHaveBeenCalledTimes(paths.length)

    enabled = true
    const write = graph + "/deviceManagement/configurationPolicies"
    const host = new ApiHost({ bindConnections: tenants => cap.bindConnections(tenants), routes: {
      "/api/restore-backup": { POST: async () => {
        record = { ...shared, method: "ownApp", clientId: OWN }
        await expect(send(write, { method: "POST" })).rejects.toThrow("method changed")
        await expect(send(write, { method: "POST" }, jwt({ ...claims, appid: OWN }))).rejects.toThrow("method changed")
        return Response.json({ ok: true })
      } },
    } })
    const response = await host.dispatch(new Request("http://test/api/restore-backup", { method: "POST", body: JSON.stringify({ tenantId: TENANT }) }))
    expect(response.status).toBe(200)
    expect(network).toHaveBeenCalledTimes(paths.length)
  })

  it("keeps a read-only batch Request body available for dispatch", async () => {
    const caps = new ConnectionCapabilities(() => ({
      version: 1, method: "tenuvaultApp", origin: "wizard", clientId: TENUVAULT_CLIENT_ID, createdAt: NOW, updatedAt: NOW,
    }), undefined, async () => true)
    const network = vi.fn<typeof fetch>(async input => new Response(await (input as Request).text()))
    const fetch = createBridgedFetch({
      dispatch: vi.fn(), getDelegatedToken: vi.fn(), fetch: network,
      authorizeRequest: (url, input, init, tenant) => caps.authorizeRequest(url, input, init, tenant),
    })
    const body = JSON.stringify({ requests: [{ method: "GET", url: "/organization" }] })
    const request = new Request("https://graph.microsoft.com/beta/$batch", {
      method: "POST", body, headers: { authorization: `Bearer ${jwt({ tid: TENANT, azp: TENUVAULT_CLIENT_ID })}` },
    })
    expect(await (await fetch(request)).text()).toBe(body)
  })

  it("retains own-registration dispatch for opaque and readable bearer values", async () => {
    const record = { version: 1 as const, clientId: OWN, method: "ownApp" as const, origin: "wizard" as const, createdAt: NOW, updatedAt: NOW }
    const cap = new ConnectionCapabilities(id => id === TENANT ? record : null)
    const url = new URL("https://graph.microsoft.com/beta/organization")
    for (const bearer of ["opaque", jwt({ tid: OTHER, appid: NEXT })]) {
      expect(() => cap.requireIssuedToken(TENANT, OWN, RESOURCE_SCOPES.graph, bearer)).not.toThrow()
      await expect(cap.authorizeRequest(url, url, { headers: { authorization: `Bearer ${bearer}` } }, TENANT)).resolves.toBeUndefined()
      await expect(cap.authorizeRequest(url, url, { headers: { authorization: `Bearer ${bearer}` } }, OTHER)).resolves.toBeUndefined()
    }
    expect(() => cap.requireConnection(TENANT, NEXT, RESOURCE_SCOPES.graph)).toThrow("method changed")
  })

  it("uses trusted acquisition for an opaque TenuVault app token and still checks the switch", async () => {
      const method = "tenuvaultApp" as const
      const clientId = TENUVAULT_CLIENT_ID
      const packs = tenantPermissionPacks({ intune: { access: "restore" } }, { azure: true, audit: false })
      const scopes = resourcePackScopes(packs, "graph")
      const record = { version: 1 as const, clientId, method, origin: "wizard" as const, createdAt: NOW, updatedAt: NOW, graphScopes: scopes }
      let enabled = true
      const cap = new ConnectionCapabilities(() => record, () => packs, async () => enabled)
      const url = new URL("https://graph.microsoft.com/beta/deviceManagement/configurationPolicies")
      const headers = { authorization: "Bearer opaque-shared-token" }
      await expect(cap.authorizeRequest(url, url, { headers }, TENANT)).rejects.toThrow("could not verify")
      expect(() => cap.requireIssuedToken(TENANT, clientId, RESOURCE_SCOPES.graph, jwt({ tid: OTHER, azp: clientId }))).toThrow("could not verify")
      cap.requireIssuedToken(TENANT, clientId, RESOURCE_SCOPES.graph, "opaque-shared-token", { grantedScopes: scopes })
      const read = cap.authorizeRequest(url, url, { headers }, TENANT)
      await expect(read).resolves.toMatchObject({ beforeDispatch: expect.any(Function) })
      const write = cap.authorizeRequest(url, url, { method: "POST", headers }, TENANT)
        .then(authorization => authorization?.beforeDispatch?.())
      await expect(write).resolves.toBeUndefined()
      enabled = false
      await expect(cap.authorizeRequest(url, url, { headers }, TENANT)).rejects.toThrow("temporarily unavailable")
      await expect(cap.requireConnectionEnabled(TENANT, clientId)).rejects.toThrow("temporarily unavailable")
    })

  it.each([["user", "usersAndDevices"], ["group", "groups"]] as const)(
    "requires checked deleted-object type and admitted scopes for %s recycle requests",
    async (type, area) => {
      const packs = tenantPermissionPacks({ entra: { access: "restore", areas: [area] } }, { azure: false, audit: false })
      const scopes = resourcePackScopes(packs, "graph")
      expect(scopes).not.toContain("User.DeleteRestore.All")
      if (type === "group") expect(scopes).toContain("Group.ReadWrite.All")
      const record = { version: 1 as const, clientId: TENUVAULT_CLIENT_ID, method: "tenuvaultApp" as const, origin: "wizard" as const, createdAt: NOW, updatedAt: NOW, graphScopes: scopes }
      const cap = new ConnectionCapabilities(() => record, () => packs, async () => true)
      const url = new URL(`https://graph.microsoft.com/beta/directory/deletedItems/${OWN}/restore`)
      const headers = { authorization: `Bearer ${jwt({ tid: TENANT, azp: TENUVAULT_CLIENT_ID, scp: [...scopes, "User.DeleteRestore.All"].join(" ") })}` }
      const send = () => cap.authorizeRequest(url, url, { method: "POST", headers }, TENANT)
        .then(authorization => authorization?.beforeDispatch?.())
      await expect(send()).rejects.toThrow("Review the restore permissions for this service in Settings > Sign-in.")
      const checked = executionMetadata.run({ directoryRecycle: { type, path: url.pathname } }, send)
      if (type === "user") await expect(checked).rejects.toThrow("Review the restore permissions for this service in Settings > Sign-in.")
      else await expect(checked).resolves.toBeUndefined()
    },
  )

  it("keeps the current connection when staged approval is missing and then records verified scopes", async () => {
    const f = fixture()
    f.enroll()
    const before = f.entries()
    f.signIn.mockRejectedValueOnce(new Error("missing approval"))
    await expect(f.connections.switch(TENANT, { method: "tenuvaultApp" })).rejects.toThrow("missing approval")
    expect(f.entries()).toEqual(before)
    f.signIn.mockResolvedValueOnce({ ...staged(TENUVAULT_CLIENT_ID), graphScopes: ["User.Read", "Policy.Read.All"] })
    await expect(f.connections.switch(TENANT, { method: "tenuvaultApp" })).rejects.toThrow("missing required permissions (Policy.Read.All)")
    expect(f.entries()).toEqual(before)
    const verified = ["openid", "User.Read"]
    f.signIn.mockResolvedValueOnce({ ...staged(TENUVAULT_CLIENT_ID), graphScopes: verified })
    const result = await f.connections.switch(TENANT, { method: "tenuvaultApp" })
    expect(result.connection).toMatchObject({ method: "tenuvaultApp", clientId: TENUVAULT_CLIENT_ID, graphScopes: verified })
    expect(f.restart().connections.get(TENANT)?.graphScopes).toEqual(verified)
  })
})

describe("Migrated Start now profiles", () => {
  it("marks stored graphCli connections as needing a sign-in method without switching silently and drops Graph CLI tokens", async () => {
    const f = fixture()
    const profile = [{ id: 1, name: "Contoso", resources: { storageAccountName: storage }, credentials: { tenantId: TENANT, appId: SETUP_HELPER_CLIENT_ID, clientSecret: "" } }]
    f.store.setMany({
      [TENANT_LIST_KEY]: JSON.stringify(profile),
      [`auth.connection.${TENANT}`]: JSON.stringify({
        version: 1, method: "graphCli", clientId: SETUP_HELPER_CLIENT_ID, ownClientId: OWN,
        origin: "wizard", createdAt: NOW, updatedAt: NOW, graphScopes: ["DeviceManagementConfiguration.Read.All"],
      }),
      [publicAccountKey(TENANT)]: JSON.stringify(staged(SETUP_HELPER_CLIENT_ID).account),
      [`auth.account.${TENANT}`]: JSON.stringify(staged(SETUP_HELPER_CLIENT_ID).account),
      [`msal.${SETUP_HELPER_CLIENT_ID}`]: "graph-cli-cache-appstore",
      [`msal.${OWN}`]: "own-app-cache-intact",
    })
    f.legacyCache.set(`msal.${SETUP_HELPER_CLIENT_ID}`, "graph-cli-cache-legacy")
    f.legacyCache.set(`msal.${OWN}`, "own-app-legacy-intact")

    const migrated = f.restart()
    expect(migrated.connections.needsSignInMethod(TENANT)).toBe(true)
    expect(migrated.connections.get(TENANT)).toMatchObject({
      method: null, clientId: "", ownClientId: OWN, origin: "wizard", needsSignInMethod: true,
    })
    expect(migrated.connections.get(TENANT)?.graphScopes).toBeUndefined()
    expect(migrated.store.get(publicAccountKey(TENANT))).toBeNull()
    expect(migrated.store.get(`auth.account.${TENANT}`)).toBeNull()
    expect(migrated.store.get(`msal.${SETUP_HELPER_CLIENT_ID}`)).toBeNull()
    expect(f.reopenLegacy().get(`msal.${SETUP_HELPER_CLIENT_ID}`)).toBeNull()
    expect(migrated.store.get(`msal.${OWN}`)).toBe("own-app-cache-intact")
    expect(f.reopenLegacy().get(`msal.${OWN}`)).toBe("own-app-legacy-intact")
    expect(JSON.parse(migrated.connections.activeProfiles()!)[0].credentials.appId).toBe("")

    const switched = await migrated.connections.switch(TENANT, { method: "tenuvaultApp" })
    expect(switched.connection).toMatchObject({ method: "tenuvaultApp", clientId: TENUVAULT_CLIENT_ID, ownClientId: OWN })
    expect(switched.connection.needsSignInMethod).toBeUndefined()
    expect(migrated.connections.needsSignInMethod(TENANT)).toBe(false)
  })
})
