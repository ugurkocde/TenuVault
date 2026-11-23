import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { MODULES, type PermissionArea } from "../src/shared/services/modules"
import { areaPermissions, graphPermissions, knownPermissions, missingForChoice, readerRoles, readerScriptArguments } from "../src/shared/services/manifest"
import { typeForFolder, restoreCapability } from "../src/shared/intune/registry"
import { restoreMatrixRow } from "../src/shared/intune/restore-matrix"

it("requests restore permissions only for enabled types, with exactly their least-privileged write permission", () => {
  const expected: Record<string, string> = {
    TokenLifetimePolicies: "Policy.ReadWrite.ApplicationConfiguration", ActivityBasedTimeoutPolicies: "Policy.ReadWrite.ApplicationConfiguration",
    AccessReviewPolicy: "Policy.ReadWrite.AccessReview", CrossTenantAccessPolicy: "Policy.ReadWrite.CrossTenantAccess", AccessPackageCatalogs: "EntitlementManagement.ReadWrite.All",
    EntraCompanyBranding: "OrganizationalBranding.ReadWrite.All", AuthenticationFlowsPolicy: "Policy.ReadWrite.AuthenticationFlows",
  }
  const directory: Record<string, string[][]> = { Applications: [["Application.ReadWrite.All"]], Users: [["User.Create"], ["User.ReadUpdate.All"], ["User.ReadWrite.All"], ["Application.Read.All"]], Groups: [["Group.ReadWrite.All"], ["GroupMember.ReadWrite.All"], ["User.Read.All"], ["Application.Read.All"], ["Policy.Read.All"], ["RoleManagement.Read.Directory"]] }
  const found: string[] = []
  for (const module of MODULES.filter(module => ["entra", "defender"].includes(module.id))) for (const area of module.areas) for (const part of area.parts) {
    for (const folder of part.folders) {
      const type = typeForFolder(folder)
      if (!type) continue
      if (directory[folder]) {
        expect(restoreCapability(type), folder).toBe("create")
        expect(part.restore.delegated, folder).toEqual(directory[folder])
        expect(restoreMatrixRow(folder)!.directoryRestore!.phase).toBe("enabled")
        continue
      }
      if (!expected[folder]) { expect(restoreCapability(type), folder).toBe("none"); expect(part.restore.delegated, folder).toBe("unsupported"); continue }
      found.push(folder)
      expect(restoreCapability(type), folder).not.toBe("none")
      expect(part.restore.delegated, folder).toEqual(folder === "TokenLifetimePolicies" ? [[expected[folder]], ["Application.Read.All", "Application.ReadWrite.All"]] : [[expected[folder]]])
      for (const write of [restoreMatrixRow(folder)!.create, restoreMatrixRow(folder)!.update].filter(Boolean)) expect(write!.permissions, folder).toEqual([expected[folder]])
    }
  }
  expect(found.sort()).toEqual(Object.keys(expected).sort())
})
const excludedRestore = ["Organization.ReadWrite.All", "Directory.ReadWrite.All", "Directory.Read.All"]

it("restore minus backup for every area and sign-in mode excludes Directory.Read.All, Directory.ReadWrite.All and Organization.ReadWrite.All", () => {
  for (const mode of ["delegated", "application"] as const) {
    for (const permission of excludedRestore) {
      const area: PermissionArea = {
        id: "test", label: "Test", folders: ["Test"],
        parts: [{ folders: ["Test"], backup: { delegated: [["Directory.Read.All"]], application: [["Directory.Read.All"]] }, restore: { delegated: [[permission, "Policy.ReadWrite.CrossTenantAccess"]], application: [[permission, "Policy.ReadWrite.CrossTenantAccess"]] } }],
      }
      expect(areaPermissions({ ...area, parts: area.parts.map(part => ({ ...part, backup: { delegated: "unsupported", application: "unsupported" } })) }, "restore", mode), permission).toEqual([])
      expect(areaPermissions(area, "backup", mode), permission).toEqual(["Directory.Read.All"])
      // Restore access includes the selected backup reads, but never adds a broad scope for a write.
      expect(areaPermissions(area, "restore", mode), permission).toEqual(["Directory.Read.All"])
    }
    for (const module of MODULES) for (const area of module.areas) {
      const backup = areaPermissions(area, "backup", mode)
      const additions = areaPermissions(area, "restore", mode).filter(scope => !backup.includes(scope))
      for (const permission of excludedRestore) expect(additions, `${module.id}/${area.id}/${mode}`).not.toContain(permission)
      const writeOnly = { ...area, parts: area.parts.map(part => ({ ...part, backup: { delegated: "unsupported", application: "unsupported" } as const })) }
      for (const permission of excludedRestore) expect(areaPermissions(writeOnly, "restore", mode), `${module.id}/${area.id}`).not.toContain(permission)
    }
  }
})

it("never requests organization or directory write roles through setup, remediation, or reader choices", () => {
  const all = Object.fromEntries(MODULES.map(module => [module.id, { access: "restore", areas: module.areas.filter(area => area.optIn || area.appOnlyOptIn).map(area => area.id) }]))
  for (const mode of ["delegated", "application"] as const) {
    for (const permission of excludedRestore.slice(0, 2)) {
      expect(graphPermissions(all, mode)).not.toContain(permission)
      expect(missingForChoice(all, { kind: mode, permissions: new Set() })).not.toContain(permission)
      expect(knownPermissions(mode)[0]!.permissions).not.toContain(permission)
    }
    const backup = graphPermissions({ entra: { access: "backup", areas: ["groups", "applications"] } }, mode)
    const restore = graphPermissions({ entra: { access: "restore", areas: ["groups", "applications"] } }, mode)
    expect(backup).toContain("Directory.Read.All")
    expect(restore).toContain("Directory.Read.All")
    for (const permission of excludedRestore) expect(restore.filter(scope => !backup.includes(scope))).not.toContain(permission)
    expect(graphPermissions({ entra: { access: "restore" } }, mode)).not.toContain("Directory.Read.All")
  }
  for (const script of ["New-TenuVaultDesktopApp.ps1", "New-TenuVaultBackupReader.ps1"]) expect(readFileSync(new URL(`../resources/${script}`, import.meta.url), "utf8")).not.toMatch(/['"](?:Organization\.ReadWrite\.All|Directory\.ReadWrite\.All)['"]/)
})

it("preserves Directory.Read.All during renewal while never repeating the excluded write roles", () => {
  const writes = excludedRestore.slice(0, 2)
  const roles = [...readerRoles(), "Directory.Read.All"]
  expect(readerScriptArguments(roles)).toBe(` -Permissions ${roles.sort().join(",")}`)
  expect(readerScriptArguments(["Directory.Read.All"])).toBe(" -Permissions Directory.Read.All")
  expect(readerScriptArguments([...roles, ...writes])).toBe(readerScriptArguments(roles))
  expect(readerScriptArguments(writes)).toBe(" -Permissions None")
})

it("already requests the documented owner read permission for the same Applications backup choice", () => {
  const applications = MODULES.find(module => module.id === "entra")!.areas.find(area => area.id === "applications")!
  for (const mode of ["delegated", "application"] as const) {
    expect(areaPermissions(applications, "backup", mode)).toContain("Directory.Read.All")
    const backup = graphPermissions({ entra: { access: "backup", areas: ["applications"] } }, mode)
    const restore = graphPermissions({ entra: { access: "restore", areas: ["applications"] } }, mode)
    expect(restore.filter(scope => !backup.includes(scope))).not.toContain("Directory.Read.All")
    expect(graphPermissions({ entra: { access: "restore" } }, mode)).not.toContain("Application.ReadWrite.All")
  }
  for (const folder of ["Applications", "ServicePrincipals"]) expect(restoreMatrixRow(folder)!.directoryRestore!.contracts!.find(row => row.action === "owner")!.delegated).toEqual(["Application.ReadWrite.All", "Directory.Read.All"])
})
it("adds only the admitted application write permission after delegated restore opt-in", () => {
  const added = ["Application.ReadWrite.All"]
  const backup = graphPermissions({ entra: { access: "backup", areas: ["applications"] } }, "delegated")
  const restore = graphPermissions({ entra: { access: "restore", areas: ["applications"] } }, "delegated")
  const applications = MODULES.find(module => module.id === "entra")!.areas.find(area => area.id === "applications")!
  const backupArea = areaPermissions(applications, "backup", "delegated")
  expect(areaPermissions(applications, "restore", "delegated").filter(scope => !backupArea.includes(scope)).sort()).toEqual(added.sort())
  for (const scope of added) {
    expect(backup).not.toContain(scope)
    expect(graphPermissions({ entra: { access: "restore" } }, "delegated")).not.toContain(scope)
    expect(graphPermissions({ entra: { access: "restore", areas: ["applications"] } }, "application")).not.toContain(scope)
    expect(readerRoles({ entra: { access: "backup", areas: ["applications"] } })).not.toContain(scope)
  }
  for (const scope of ["AppRegistration.Create", "Application.ReadWrite.OwnedBy", "AppRoleAssignment.ReadWrite.All", "DelegatedPermissionGrant.ReadWrite.All"]) expect(restore).not.toContain(scope)
})

it("adds only delegated read access to the Roles and PIM review tier", () => {
  const roles = MODULES.find(module => module.id === "entra")!.areas.find(area => area.id === "roles")!
  const backup = areaPermissions(roles, "backup", "delegated")
  expect(areaPermissions(roles, "restore", "delegated").filter(scope => !backup.includes(scope))).toEqual(["Application.Read.All", "User.Read.All"])
  expect(areaPermissions(roles, "restore", "application")).toEqual(areaPermissions(roles, "backup", "application"))
  for (const part of roles.parts) expect(part.restore.delegated).toBe("unsupported")
})
