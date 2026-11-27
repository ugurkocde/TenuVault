import JSZip from "jszip"
import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiHost } from "../src/main/api/host"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
import { ConnectionCapabilities } from "../src/main/auth/connection-capabilities"
import { AuthManager } from "../src/main/auth/msal"
import { publicAccountKey } from "../src/main/auth/stores"
import { TENANT_LIST_KEY, TenantConnections, type StagedSignIn } from "../src/main/auth/tenant-connections"
import { WizardSignIn } from "../src/main/auth/wizard-sign-in"
import { scheduledCoverage } from "../src/main/backup/schedule-prepare"
import { BackupScheduler } from "../src/main/backup/scheduler"
import { LicenseService } from "../src/main/license/service"
import { handleLocalBlobRequest } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { SecureStore } from "../src/main/storage/secure-store"
import { POST as downloadBackup } from "../src/portal/app/api/download-backup/route"
import { POST as listBackupContents } from "../src/portal/app/api/list-backup-contents/route"
import { POST as listBackups } from "../src/portal/app/api/list-backups/route"
import { localStorageAccountName, RESOURCE_SCOPES } from "../src/shared/constants"
import { SIGN_IN_METHODS, SETUP_HELPER_CLIENT_ID, TENUVAULT_CLIENT_ID, type SignInMethod } from "../src/shared/tenant-connection"
import { memoryStore } from "./helpers"

const TENANT = "aaaaaaaa-1111-4111-8111-111111111111"
const OWN = "bbbbbbbb-2222-4222-8222-222222222222"
const NOW = "2026-11-27T12:00:00.000Z"
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function cipher() {
  return {
    encrypt: (text: string) => Buffer.from(Buffer.from(text).map(byte => byte ^ 0xff)),
    decrypt: (value: Buffer) => value.map(byte => byte ^ 0xff).toString(),
  }
}

describe("0.6 removal of Start now (main process and data)", () => {
  it("exposes only TenuVault app first and your own app registration, and rejects graphCli", async () => {
    expect(Object.keys(SIGN_IN_METHODS)).toEqual(["tenuvaultApp", "ownApp"])
    expect(SIGN_IN_METHODS.tenuvaultApp).toBe("TenuVault app")
    expect(SIGN_IN_METHODS.ownApp).toBe("Your own app registration")

    const wizard = new WizardSignIn({
      connected: () => false,
      enabled: async () => true,
      stage: vi.fn(),
      fetch: vi.fn() as unknown as typeof fetch,
      startTrial: vi.fn(),
      checkLicense: vi.fn(),
      releaseLicense: vi.fn(),
      enroll: vi.fn(),
    })
    await expect(wizard.stage(TENANT, "graphCli" as "tenuvaultApp", { intune: { access: "backup" } })).resolves.toMatchObject({
      error: { code: "invalid_request" },
    })
  })

  it("enables the TenuVault app on 0.6 stable when health allows it and honors the server kill switch", async () => {
    vi.stubGlobal("__TV_LAB_BUILD__", false)
    const { publicKey } = generateKeyPairSync("ed25519")
    let enabled = true
    const license = new LicenseService({
      store: memoryStore(),
      persist: false,
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      apiBase: "https://www.tenuvault.com",
      appVersion: "0.6.0",
      fetch: (async () => Response.json({ connectMethods: { tenuvaultApp: enabled } })) as typeof fetch,
    })
    expect(await license.tenuvaultAppEnabled(true)).toBe(true)
    expect(license.connectMethodEnabledNow("tenuvaultApp")).toBe(true)
    enabled = false
    expect(await license.tenuvaultAppEnabled(true)).toBe(false)
    expect(license.connectMethodEnabledNow("tenuvaultApp")).toBe(false)
  })

  it("reads legacy license records containing graphCliShared tolerantly without failing", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const installId = "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f"
    const payload = {
      v: 2, sub: "paid", act: "act-1", plan: "pro", tenants: 2, tenantId: TENANT,
      installId, status: "granted", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400,
    }
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
    const token = `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`
    const store = memoryStore()
    store.set("license.installId", installId)
    store.set("license.state", JSON.stringify({
      key: "PAID-KEY",
      activations: { [TENANT]: { activationId: "act-1", token, shared: true, graphCliShared: true } },
    }))
    const license = new LicenseService({
      store,
      persist: true,
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      apiBase: "https://www.tenuvault.com",
      appVersion: "0.6.0",
      fetch: vi.fn() as unknown as typeof fetch,
    })
    const status = license.status([TENANT])
    expect(status.tenants[0]).toMatchObject({ tenantId: TENANT, entitled: true, shared: true })
  })

  it("migrates stored graphCli profiles without switching silently and drops Graph CLI tokens and caches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-start-now-mig-"))
    dirs.push(dir)
    const appStore = new SecureStore(join(dir, "app.bin"), cipher())
    const tokenStore = new SecureStore(join(dir, "tokens.bin"), cipher())
    const storageAccount = localStorageAccountName(TENANT)
    appStore.setMany({
      [TENANT_LIST_KEY]: JSON.stringify([{
        id: 1, name: "Contoso",
        resources: { storageAccountName: storageAccount },
        credentials: { tenantId: TENANT, appId: SETUP_HELPER_CLIENT_ID, clientSecret: "" },
      }]),
      [`auth.connection.${TENANT}`]: JSON.stringify({
        version: 1, method: "graphCli", clientId: SETUP_HELPER_CLIENT_ID, ownClientId: OWN,
        origin: "wizard", createdAt: NOW, updatedAt: NOW,
      }),
      [publicAccountKey(TENANT)]: JSON.stringify({ tenantId: TENANT, clientId: SETUP_HELPER_CLIENT_ID, username: "admin@contoso.test", homeAccountId: "h1" }),
      [`auth.account.${TENANT}`]: JSON.stringify({ tenantId: TENANT, clientId: SETUP_HELPER_CLIENT_ID, username: "admin@contoso.test", homeAccountId: "h1" }),
      [`msal.${SETUP_HELPER_CLIENT_ID}`]: "cached-graph-cli-tokens",
    })
    tokenStore.set(`msal.${SETUP_HELPER_CLIENT_ID}`, "legacy-graph-cli-tokens")

    const connections = new TenantConnections({
      store: appStore,
      legacyCache: tokenStore,
      signIn: {
        tenuvaultApp: async (): Promise<StagedSignIn> => ({
          account: { tenantId: TENANT, clientId: TENUVAULT_CLIENT_ID, username: "admin@contoso.test", homeAccountId: "h2" },
          accessToken: `x.${Buffer.from(JSON.stringify({ tid: TENANT, scp: "User.Read" })).toString("base64url")}.x`,
          cacheWrites: () => ({ [`msal.${TENUVAULT_CLIENT_ID}`]: "tv-cache" }),
        }),
      },
      coverage: () => [],
      now: () => new Date(NOW),
    })
    connections.migrate()

    expect(connections.needsSignInMethod(TENANT)).toBe(true)
    expect(connections.get(TENANT)).toMatchObject({ method: null, clientId: "", ownClientId: OWN, needsSignInMethod: true })
    expect(appStore.get(publicAccountKey(TENANT))).toBeNull()
    expect(appStore.get(`auth.account.${TENANT}`)).toBeNull()
    expect(appStore.get(`msal.${SETUP_HELPER_CLIENT_ID}`)).toBeNull()
    expect(tokenStore.get(`msal.${SETUP_HELPER_CLIENT_ID}`)).toBeNull()
  })

  it("keeps encrypted local backups and keyring intact and readable without a sign-in method", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-readable-"))
    dirs.push(dir)
    const key = randomBytes(32)
    const localStore = new LocalBlobStore(dir, [key])
    const storageAccount = localStorageAccountName(TENANT)
    const backupId = "backup-2026-11-27-120000"
    const policy = { id: "pol-1", displayName: "Contoso BitLocker", "@odata.type": "#microsoft.graph.deviceConfiguration" }
    const metadata = {
      Timestamp: NOW,
      EndTime: NOW,
      DurationSeconds: 1,
      TenantId: TENANT,
      Status: "Success",
      BackupType: "Manual",
      TotalPolicies: 1,
      Summary: { DeviceConfigurations: 1 },
      Items: { "DeviceConfigurations/pol-1": { file: "BitLocker.json", hash: "abc" } },
    }
    await localStore.createContainer(storageAccount, "intune-backups")
    await localStore.put(storageAccount, "intune-backups", `${backupId}/backup-metadata.json`, Buffer.from(JSON.stringify(metadata)), "application/json")
    await localStore.put(storageAccount, "intune-backups", `${backupId}/backup-summary.json`, Buffer.from(JSON.stringify({ status: "Success", totalPolicies: 1, failures: 0 })), "application/json")
    await localStore.put(storageAccount, "intune-backups", `${backupId}/DeviceConfigurations/BitLocker.json`, Buffer.from(JSON.stringify(policy)), "application/json")

    const getDelegatedToken = vi.fn(async () => { throw new Error("No sign-in method should be needed for local backups.") })
    const host = new ApiHost({
      routes: {
        "/api/list-backups": { POST: listBackups },
        "/api/list-backup-contents": { POST: listBackupContents },
        "/api/download-backup": { POST: downloadBackup },
      },
    })
    const bridgedFetch = createBridgedFetch({
      dispatch: request => host.dispatch(request),
      getDelegatedToken,
      handleLocalBlob: request => handleLocalBlobRequest(localStore, request),
      fetch: async input => {
        throw new Error(`Unexpected network call: ${String(input)}`)
      },
    })
    vi.stubGlobal("fetch", bridgedFetch)

    const migratedCredentials = {
      tenantId: TENANT,
      appId: "",
      clientSecret: "",
      storageAccountName: storageAccount,
      subscriptionId: "local",
      resourceGroupName: "local",
    }

    const listRes = await host.dispatch(new Request("http://tenuvault.internal/api/list-backups", {
      method: "POST", body: JSON.stringify(migratedCredentials),
    }))
    expect(listRes.status).toBe(200)
    const listBody = await listRes.json()
    expect(listBody.backups).toHaveLength(1)
    expect(listBody.backups[0]).toMatchObject({ id: backupId, totalPolicies: 1 })

    const contentsRes = await host.dispatch(new Request("http://tenuvault.internal/api/list-backup-contents", {
      method: "POST", body: JSON.stringify({ ...migratedCredentials, backupId }),
    }))
    expect(contentsRes.status).toBe(200)
    const contentsBody = await contentsRes.json()
    expect(contentsBody.content.groups[0]?.policies[0]).toMatchObject({ displayName: "BitLocker" })

    const downloadRes = await host.dispatch(new Request("http://tenuvault.internal/api/download-backup", {
      method: "POST", body: JSON.stringify({ ...migratedCredentials, backupId }),
    }))
    expect(downloadRes.status).toBe(200)
    const archive = await JSZip.loadAsync(Buffer.from(await downloadRes.arrayBuffer()))
    const entry = Object.keys(archive.files).find(name => name.endsWith("DeviceConfigurations/BitLocker.json"))
    expect(entry).toBeDefined()
    expect(JSON.parse(await archive.file(entry!)!.async("string"))).toMatchObject({ id: "pol-1", displayName: "Contoso BitLocker" })
    expect(getDelegatedToken).not.toHaveBeenCalled()
  })

  it("pauses scheduled backups with a clear notice until a new sign-in method is chosen", async () => {
    const store = memoryStore()
    let nowMs = new Date(2026, 10, 27, 11, 55, 0).getTime()
    let needsMethod = true
    const run = vi.fn(async () => ({ status: "Completed" as const, message: "Backup completed." }))
    const onPaused = vi.fn()
    const fakeLicense = {
      plan: () => "pro" as const,
      coverageEndedAt: () => undefined,
      communityPendingTenants: () => [] as string[],
    }
    const scheduler = new BackupScheduler(
      store,
      run,
      () => undefined,
      () => new Date(nowMs),
      tenantId => scheduledCoverage(fakeLicense, tenantId, { storageAccountName: localStorageAccountName(tenantId) }, needsMethod),
      undefined,
      () => undefined,
      onPaused,
    )
    scheduler.set({
      tenantId: TENANT,
      enabled: true,
      frequency: "daily",
      time: "12:00",
    })

    nowMs = new Date(2026, 10, 27, 12, 5, 0).getTime()
    await scheduler.tick()
    expect(run).not.toHaveBeenCalled()
    expect(onPaused).toHaveBeenCalledExactlyOnceWith(TENANT, "signInMethod")
    expect(scheduler.list()[0]?.pausedReason).toBe("Paused: Start now was removed in 0.6. Choose a sign-in method")

    // Second tick must not spam notifications or run.
    nowMs += 60_000
    await scheduler.tick()
    expect(onPaused).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()

    // Choosing a sign-in method clears the pause and runs the due schedule.
    needsMethod = false
    nowMs += 60_000
    await scheduler.tick()
    expect(run).toHaveBeenCalledOnce()
    expect(scheduler.list()[0]?.pausedReason).toBeUndefined()
    expect(scheduler.list()[0]?.lastStatus).toBe("Completed")
  })

  it("keeps Graph Command Line Tools restricted to the one-time setup helper and blocks it as a connection or backup/restore client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-helper-iso-"))
    dirs.push(dir)
    const appStore = new SecureStore(join(dir, "app.bin"), cipher())
    const connections = new TenantConnections({ store: appStore, signIn: {}, coverage: () => [] })
    expect(() => connections.enroll(TENANT, { method: "ownApp", clientId: SETUP_HELPER_CLIENT_ID }, "[]", {
      account: { tenantId: TENANT, clientId: SETUP_HELPER_CLIENT_ID, username: "admin@contoso.test", homeAccountId: "h" },
      accessToken: "token",
      cacheWrites: () => ({}),
    })).toThrow("setup helper")
    await expect(connections.switch(TENANT, { method: "graphCli" as SignInMethod })).rejects.toThrow("Unsupported sign-in method")

    const auth = new AuthManager({
      fetch: vi.fn() as unknown as typeof fetch,
      cachePlugin: () => ({ beforeCacheAccess: async () => undefined, afterCacheAccess: async () => undefined }),
      openBrowser: vi.fn(async () => undefined),
      accountStore: { get: () => null, set: vi.fn(), delete: vi.fn(), list: () => [] },
    })
    await expect(auth.signIn(TENANT, SETUP_HELPER_CLIENT_ID)).rejects.toThrow("setup helper")
    await expect(auth.reauthenticate(TENANT, SETUP_HELPER_CLIENT_ID)).rejects.toThrow("setup helper")

    const own = { version: 1 as const, method: "ownApp" as const, clientId: OWN, origin: "wizard" as const, createdAt: NOW, updatedAt: NOW }
    const caps = new ConnectionCapabilities(() => own)
    const helperToken = `x.${Buffer.from(JSON.stringify({ tid: TENANT, azp: SETUP_HELPER_CLIENT_ID, scp: "DeviceManagementConfiguration.ReadWrite.All" })).toString("base64url")}.x`
    await expect(caps.authorizeRequest(
      new URL("https://graph.microsoft.com/beta/deviceManagement/configurationPolicies"),
      "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies",
      { method: "GET", headers: { Authorization: `Bearer ${helperToken}` } },
      TENANT,
    )).rejects.toThrow("setup helper")
  })

  it("rejects SETUP_HELPER and TenuVault client IDs in bindReaderToken", () => {
    const own = { version: 1 as const, method: "ownApp" as const, clientId: OWN, origin: "wizard" as const, createdAt: NOW, updatedAt: NOW }
    const caps = new ConnectionCapabilities(() => own)
    expect(() => caps.bindReaderToken(TENANT, SETUP_HELPER_CLIENT_ID, RESOURCE_SCOPES.graph, "opaque-helper-reader")).toThrow("setup helper")
    expect(() => caps.bindReaderToken(TENANT, SETUP_HELPER_CLIENT_ID.toUpperCase(), RESOURCE_SCOPES.graph, "opaque-helper-reader-upper")).toThrow("setup helper")
    expect(() => caps.bindReaderToken(TENANT, TENUVAULT_CLIENT_ID, RESOURCE_SCOPES.graph, "opaque-tv-reader")).toThrow("could not verify")
    expect(() => caps.bindReaderToken(TENANT, TENUVAULT_CLIENT_ID.toUpperCase(), RESOURCE_SCOPES.graph, "opaque-tv-reader-upper")).toThrow("could not verify")
    expect(() => caps.bindReaderToken(TENANT, OWN, RESOURCE_SCOPES.graph, "opaque-own-reader")).not.toThrow()
  })
})
