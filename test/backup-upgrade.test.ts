import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { BackupKeys } from "../src/main/backup/keys"
import { localInventoryProblem } from "../src/main/backup/local-inventory"
import { readBackupSettings } from "../src/main/backup/settings"
import { legacyAzureReader, registerStorageToken } from "../src/main/storage/azure-seal"
import { handleLocalBlobRequest } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { SecureStore } from "../src/main/storage/secure-store"
import { POST as listBackups } from "../src/portal/app/api/list-backups/route"
import { BACKUP_CONTAINER, BACKUP_OWNER_FILE, localStorageAccountName } from "../src/shared/constants"

const fixture = fileURLToPath(new URL("./fixtures/backup-upgrade/", import.meta.url))
const tenant = "11111111-1111-1111-1111-111111111111"
const account = localStorageAccountName(tenant)
const older = "backup-2026-11-01-020000"
const newer = "backup-2026-11-02-020000"
const policyNames = ["CompliancePolicies/alpha.json", "DeviceConfigurations/beta.json"] as const
const alpha = { id: "alpha", displayName: "Synthetic compliance policy" }
const beta = { id: "beta", displayName: "Synthetic device configuration" }
const cipher = { encrypt: (text: string) => Buffer.from(text), decrypt: (data: Buffer) => data.toString() }

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tv-backup-upgrade-"))
  cpSync(fixture, root, { recursive: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

function openProfile() {
  const file = join(root, "app-state.bin")
  const encrypt = vi.fn(cipher.encrypt)
  const state = new SecureStore(file, { ...cipher, encrypt })
  state.open()
  return { file, state, encrypt, keys: new BackupKeys(state), local: join(root, "local") }
}

it("lists and decrypts every TVB1 and TVB2 blob written by 0.5.x without inventory warnings", async () => {
  const { keys, local } = openProfile()
  const store = new LocalBlobStore(local, keys.keyring())
  expect(await localInventoryProblem(store, local, tenant)).toBeNull()
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const { hostname } = new URL(request.url)
    if (hostname === "login.microsoftonline.com") return Response.json({ access_token: "synthetic" })
    if (hostname === `${account}.blob.core.windows.net`) return handleLocalBlobRequest(store, request)
    throw new Error(`Unexpected request to ${hostname}`)
  })
  for (const summary of [false, true]) {
    const response = await listBackups(new NextRequest("http://tenuvault.internal/api/list-backups", {
      method: "POST",
      body: JSON.stringify({
        tenantId: tenant, appId: "22222222-2222-2222-2222-222222222222", clientSecret: "synthetic",
        storageAccountName: account, subscriptionId: "local", resourceGroupName: "local", summary,
      }),
    }))
    expect(response.status).toBe(200)
    const history = await response.json()
    expect(history.backups).toMatchObject([newer, older].map(id => ({ id, status: "Success", totalPolicies: 2 })))
    expect(history.warnings ?? []).toEqual([])
    expect(history.damagedFiles ?? 0).toBe(0)
  }

  for (const folder of [older, newer]) {
    const expected = {
      [policyNames[0]]: alpha,
      [policyNames[1]]: beta,
      [BACKUP_OWNER_FILE]: { Source: "TenuVault Desktop", TenantId: tenant, RunId: folder },
      "metadata.json": {
        Status: "Success", TenantId: tenant, RunId: folder,
        Items: { "CompliancePolicies/alpha": { file: "alpha.json" }, "DeviceConfigurations/beta": { file: "beta.json" } },
      },
    }
    const listed = await store.list(account, BACKUP_CONTAINER, `${folder}/`)
    expect(listed.map(({ name }) => name)).toEqual(Object.keys(expected).sort().map(name => `${folder}/${name}`))
    for (const [name, value] of Object.entries(expected)) {
      const { data } = await store.get(account, BACKUP_CONTAINER, `${folder}/${name}`)
      expect(JSON.parse(data.toString())).toEqual(value)
    }
  }
})

it("keeps the stored keyring when the upgraded profile opens and reads backup settings", async () => {
  const { file, state, encrypt, keys, local } = openProfile()
  const original = readFileSync(join(fixture, "app-state.bin"))
  const serialized: string = JSON.parse(original.toString())["backup.keyring"]
  const expected: string[] = JSON.parse(serialized)
  expect(expected).toHaveLength(2)
  expect(keys.existingKeyring().map(key => key.toString("base64"))).toEqual(expected)
  expect(keys.keyring().map(key => key.toString("base64"))).toEqual(expected)
  expect(await readBackupSettings(local, keys, state)).toMatchObject({ hasLocalBackups: true })
  expect(encrypt).not.toHaveBeenCalled()
  expect(readFileSync(file)).toEqual(original)

  // An unrelated setting can re-encrypt app state while preserving the existing key order.
  state.set("unrelated-setting", "updated")
  expect(openProfile().state.get("backup.keyring")).toBe(serialized)
})

it("opens an older sealed Azure blob with the retained key and reads plain Azure JSON", async () => {
  const { keys } = openProfile()
  const sealedUrl = `https://fixture.blob.core.windows.net/${BACKUP_CONTAINER}/${older}/${policyNames[0]}`
  const plainUrl = `https://fixture.blob.core.windows.net/${BACKUP_CONTAINER}/${newer}/${policyNames[1]}`
  const token = "synthetic-upgrade-storage-token"
  registerStorageToken(token, tenant)
  const read = legacyAzureReader(async input => String(input) === sealedUrl
    ? new Response(new Uint8Array(readFileSync(join(root, "legacy-azure.bin"))))
    : Response.json(beta), () => keys.keyring())
  expect(await (await read(sealedUrl, { headers: { Authorization: `Bearer ${token}` } })).json()).toEqual(alpha)
  expect(await (await read(plainUrl)).json()).toEqual(beta)
})

it("warns in a shared folder, refuses deletion and reads both sets after recovery key import", async () => {
  const { keys, local } = openProfile()
  const lab = new BackupKeys(new SecureStore(join(root, "lab", "app-state.bin"), cipher))
  const labStore = new LocalBlobStore(local, lab.keyring())
  const labBackup = "backup-2026-11-03-020000/metadata.json"
  await labStore.put(account, BACKUP_CONTAINER, labBackup, Buffer.from('{"Status":"Success","Items":{}}'), "application/json", true)
  const dir = join(local, account, BACKUP_CONTAINER)
  const files = () => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name))] as const)
  const mixed = files()
  const stable = new LocalBlobStore(local, keys.keyring())
  expect(await localInventoryProblem(stable, local, tenant)).toContain("key this device does not have")
  expect(await localInventoryProblem(labStore, local, tenant)).toContain("key this device does not have")
  for (const name of [labBackup, `${newer}/metadata.json`]) {
    await expect(stable.delete(account, BACKUP_CONTAINER, name)).rejects.toThrow("Nothing in the backup folder is deleted")
  }
  expect(files()).toEqual(mixed)

  const stableKeys = keys.existingKeyring()
  keys.importRecoveryKey(lab.exportRecoveryKey())
  expect(keys.existingKeyring()).toEqual([...lab.existingKeyring(), ...stableKeys])
  const recovered = new LocalBlobStore(local, keys.keyring())
  expect(await localInventoryProblem(recovered, local, tenant)).toBeNull()
  expect(await recovered.list(account, BACKUP_CONTAINER)).toHaveLength(9)
  expect(files()).toEqual(mixed)
})
