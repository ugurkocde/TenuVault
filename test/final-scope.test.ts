import { readFileSync } from "node:fs"
import { expect, it, vi } from "vitest"
import { compareBackups } from "../src/shared/intune/backup-changes"
import { INTUNE_TYPES, typeForFolder } from "../src/shared/intune/registry"
import { restoreMatrixRow } from "../src/shared/intune/restore-matrix"
import { MODULES, moduleForFolder } from "../src/shared/services/modules"
import { backupNeed } from "../src/shared/services/modules"
import { servicePack } from "../src/shared/services/permission-packs"
import { ModuleSettings } from "../src/main/services/settings"
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

it.each(["resources/New-TenuVaultDesktopApp.ps1", "resources/New-TenuVaultBackupReader.ps1", "resources/runbooks/Invoke-TenuVaultBackup.ps1"])("omits the retired service from %s", file => {
  expect(readFileSync(file, "utf8")).not.toMatch(/DefenderCustomDetectionRules|['"]Defender['"]|CustomDetection\.Read/)
})
