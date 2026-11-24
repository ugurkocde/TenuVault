vi.hoisted(() => vi.stubGlobal("__TV_LAB_EXPANDED_ENTRA__", true))

import { expect, it, vi } from "vitest"
import { buildConsentUrl, HANDOFF_REDIRECT } from "../src/main/auth/pack-consent"
import { DirectoryRestoreService } from "../src/main/restore/directory-service"
import { RecoveryAccounts } from "../src/main/restore/safety-resolvers"
import { DEFERRED_RESTORE_MESSAGE, DIRECTORY_REVIEW_FOLDERS } from "../src/shared/intune/directory-review-folders"
import { RESTORE_MATRIX, restoreMatrixRow } from "../src/shared/intune/restore-matrix"
import { writeBlocker } from "../src/shared/intune/restore-plan"
import { typeForFolder } from "../src/shared/intune/registry"
import { graphPermissions, knownPermissions, missingForChoice, type PermissionChoice } from "../src/shared/services/manifest"
import { APPLICATION_METADATA_RESTORE_PACK, PRIVILEGED_ENTRA_PACK, PRIVILEGED_WRITES, tenantPermissionPacks } from "../src/shared/services/permission-packs"

const tenant = "275f92b5-ed69-46e5-9bce-b116b89da203"
const folders = [
  "Applications", "ServicePrincipals", "OAuth2PermissionGrants", "EntraRoleDefinitions", "EntraRoleAssignments",
  "RoleManagementPolicies", "RoleEligibilitySchedules", "RoleAssignmentSchedules", "PimGroupEligibilitySchedules",
  "PimGroupAssignmentSchedules", "PimAlertConfigurations", "AdministrativeUnits",
]
const choice: PermissionChoice = {
  conditionalAccess: { access: "restore" },
  entra: { access: "restore", areas: ["applications", "usersAndDevices", "groups"] },
}

it.each(folders)("%s is excluded from restore selection and refuses dispatch with every privileged scope", async folder => {
  const type = typeForFolder(folder)!
  expect(writeBlocker(type, "create")).toBe(DEFERRED_RESTORE_MESSAGE)
  expect(writeBlocker(type, "update")).toBe(DEFERRED_RESTORE_MESSAGE)
  expect(DIRECTORY_REVIEW_FOLDERS).not.toContain(folder)
  expect(restoreMatrixRow(folder)).toBeUndefined()

  const store = { partitioned: true as const, keys: () => [], get: () => null, set: vi.fn(), delete: vi.fn() }
  const token = `header.${Buffer.from(JSON.stringify({ scp: PRIVILEGED_WRITES.join(" ") })).toString("base64url")}.signature`
  const connect = vi.fn(async () => ({ tenantId: tenant, clientId: tenant, userId: tenant, token }))
  const fetch = vi.fn<typeof globalThis.fetch>()
  const service = new DirectoryRestoreService(store, new RecoveryAccounts(store), connect, connect, fetch)
  await expect(service.execute(tenant, {
    path: `backup/${folder}/${tenant}.json`, snapshot: { id: tenant }, runId: tenant, origin: "restore",
  }, "fingerprint", {})).rejects.toThrow(DEFERRED_RESTORE_MESSAGE)
  expect(connect).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  expect(store.set).not.toHaveBeenCalled()
})

it("keeps privileged scopes out of restore packs, consent URLs, repairs and the published matrix", () => {
  const packs = tenantPermissionPacks(choice, { azure: true, audit: true })
  const consent = (pack: typeof packs[number]) => new URL(buildConsentUrl(tenant, pack, HANDOFF_REDIRECT, "a".repeat(43))).searchParams.get("scope")!
  const repair = missingForChoice(choice, { kind: "delegated", permissions: new Set() })
  const matrix = RESTORE_MATRIX.flatMap(row => [
    ...[row.create, row.update, ...row.supplementalWrites].flatMap(write => write?.permissions ?? []),
    ...(row.directoryRestore?.contracts ?? []).flatMap(contract => [...contract.delegated, ...contract.application]),
  ])
  for (const scope of PRIVILEGED_WRITES) {
    expect([...packs.flatMap(pack => pack.scopes), ...graphPermissions(choice, "delegated"), ...knownPermissions("delegated")[0]!.permissions, ...repair, ...matrix]).not.toContain(scope)
    for (const pack of packs) expect(consent(pack)).not.toContain(scope)
  }
  for (const pack of [APPLICATION_METADATA_RESTORE_PACK, PRIVILEGED_ENTRA_PACK]) expect(() => consent(pack)).toThrow(DEFERRED_RESTORE_MESSAGE)
})
