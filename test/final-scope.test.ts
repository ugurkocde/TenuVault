import { readFileSync } from "node:fs"
import { expect, it, vi } from "vitest"
import { compareBackups } from "../src/shared/intune/backup-changes"
import { INTUNE_TYPES, typeForFolder } from "../src/shared/intune/registry"
import { restoreMatrixRow } from "../src/shared/intune/restore-matrix"
import { MODULES, moduleForFolder } from "../src/shared/services/modules"
import { backupNeed } from "../src/shared/services/modules"
import { servicePack } from "../src/shared/services/permission-packs"
import { ModuleSettings } from "../src/main/services/settings"
import { DirectoryRestoreService, type DirectoryPage } from "../src/main/restore/directory-service"
import { restoreFingerprint } from "../src/main/restore/guarded-run"
import { RecoveryAccounts } from "../src/main/restore/safety-resolvers"
import { DEFERRED_RESTORE_MESSAGE } from "../src/shared/intune/directory-review-folders"
import { IdentityRestoreService } from "../src/main/restore/service"
import { memoryStore } from "./helpers"

const retiredFolder = "DefenderCustomDetectionRules"
const extraFolder = "CrossTenantAccessPolicy"
const deviceAndAccess = [
  "DeviceRegistrationPolicy", "MdmEnrollmentPolicies", "MamEnrollmentPolicies",
  "AuthenticationMethodsPolicy", "AuthenticationContexts", "TermsOfUseAgreements",
  "Groups", "GroupLifecyclePolicies", "OwnerlessGroupPolicy", "EntraDevices",
]

it("exposes only device and access folders in stable and derives the requested scopes from them", () => {
  expect(MODULES.map(module => module.id)).toEqual(["intune", "conditionalAccess", "entra"])
  expect(INTUNE_TYPES.filter(type => moduleForFolder(type.folder)?.module.id === "entra").map(type => type.folder).sort())
    .toEqual(deviceAndAccess.sort())
  expect(servicePack("entra", "backup").scopes).toEqual(["Agreement.Read.All", "AuthenticationContext.Read.All", "Policy.Read.All"])
  expect(servicePack("entra", "restore").scopes).toEqual(servicePack("entra", "backup").scopes)
  expect(backupNeed("EntraDevices", "delegated")).toBeDefined()
  expect(moduleForFolder("EntraDevices")?.area.optIn).toBe(true)
  expect(typeForFolder(extraFolder)).toBeUndefined()
  expect(restoreMatrixRow(extraFolder)).toBeUndefined()
})

it("ignores a retired service setting and extra backup data without reporting deletion", () => {
  const store = memoryStore()
  store.set("services.modules", JSON.stringify({ tenant: { defender: { enabled: true } } }))
  expect(new ModuleSettings(store).selection("tenant").services).toEqual(["intune"])
  const before = { Scope: { Included: [retiredFolder, extraFolder] }, Items: {
    [retiredFolder + "/rule"]: { file: "Rule.json", hash: "before" },
    [extraFolder + "/policy"]: { file: "Policy.json", hash: "before" },
  } }
  expect(compareBackups(before, { ...before, Items: {} })).toEqual([])
  expect(typeForFolder(retiredFolder)).toBeUndefined()
  expect(restoreMatrixRow(retiredFolder)).toBeUndefined()
})

it.each([retiredFolder, extraFolder])("refuses restore for %s before connecting", async folder => {
  const connection = vi.fn()
  const service = new IdentityRestoreService({} as never, {} as never, connection)
  await expect(service.prepare("tenant", { path: "backup/" + folder + "/item.json" } as never, "update")).rejects.toThrow("backup-only")
  expect(connection).not.toHaveBeenCalled()
})

const tenant = "00000000-0000-4000-8000-000000000001"
const clientId = "00000000-0000-4000-8000-000000000002"
const userId = "00000000-0000-4000-8000-000000000003"
const objectId = "00000000-0000-4000-8000-000000000004"
const options = { stage: "object", exactMembers: false, exactOwners: false } as const

function savedLabDirectoryPages() {
  const memory = memoryStore()
  const store = { ...memory, partitioned: true as const, keys: () => [...memory.values.keys()] }
  const settings = new ModuleSettings(store)
  settings.setChoice(tenant, { entra: { access: "restore", areas: ["usersAndDevices", "groups"] } })
  const actor = { tenantId: tenant, clientId, userId, recoveryAccountIds: [] }
  const connect = vi.fn(async () => { throw new Error("Unexpected online connection") })
  const fetch = vi.fn<typeof globalThis.fetch>()
  const service = new DirectoryRestoreService(store, new RecoveryAccounts(store), connect, async () => actor, fetch, () => [], settings)
  const savePage = (folder: "Users" | "Groups", runId: string) => {
    const request = { runId, path: `backup/${folder}/${objectId}.json`, snapshot: { id: objectId }, origin: "restore" as const }
    const source = { path: request.path, fingerprint: restoreFingerprint(request.snapshot) }
    const page: DirectoryPage = {
      run: { version: 1, tenant, id: runId, actor, origin: "restore", source, entries: [], mappings: [] },
      rows: [], more: false, options,
    }
    store.set(`restore.directory.review.${tenant}.${runId}`, JSON.stringify(page))
    return { request, fingerprint: restoreFingerprint({ source, rows: [], options }) }
  }
  const users = savePage("Users", "00000000-0000-4000-8000-000000000005")
  const groups = savePage("Groups", "00000000-0000-4000-8000-000000000006")
  store.set(`restore.directory.pages.${tenant}`, JSON.stringify([users.request.runId, groups.request.runId]))
  return { service, connect, fetch, users, groups }
}

it.each(["prepare", "resume", "execute", "reconcile"] as const)("refuses Users restore in stable at %s", async action => {
  const { service, connect, fetch, users: { request, fingerprint } } = savedLabDirectoryPages()
  const entryPoints = {
    prepare: () => service.prepare(tenant, request, options, async () => { throw new Error("Unexpected backup read") }),
    resume: () => service.resume(tenant, request),
    execute: () => service.execute(tenant, request, fingerprint, {}),
    reconcile: () => service.saved(tenant, request.runId, "reconcile"),
  }
  await expect(entryPoints[action]()).rejects.toThrow(DEFERRED_RESTORE_MESSAGE)
  expect(connect).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it("lists a saved Groups preview while hiding a saved lab Users preview in stable", async () => {
  const { service, groups: { request } } = savedLabDirectoryPages()
  expect((await service.unfinished(tenant)).pages).toEqual([{ runId: request.runId, path: request.path }])
})

it.each(["resources/New-TenuVaultDesktopApp.ps1", "resources/New-TenuVaultBackupReader.ps1", "resources/runbooks/Invoke-TenuVaultBackup.ps1"])("omits the retired service from %s", file => {
  expect(readFileSync(file, "utf8")).not.toMatch(/DefenderCustomDetectionRules|['"]Defender['"]|CustomDetection\.Read/)
})
