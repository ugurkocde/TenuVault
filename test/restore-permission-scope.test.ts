import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { MODULES } from "../src/shared/services/modules"
import { graphPermissions, knownPermissions } from "../src/shared/services/manifest"
import { typeForFolder, restoreCapability } from "../src/shared/intune/registry"
import { restoreMatrixRow } from "../src/shared/intune/restore-matrix"

it("requests restore permissions only for enabled types, with exactly their least-privileged write permission", () => {
  const expected: Record<string, string> = {
    TokenLifetimePolicies: "Policy.ReadWrite.ApplicationConfiguration", ActivityBasedTimeoutPolicies: "Policy.ReadWrite.ApplicationConfiguration",
    EntraCompanyBranding: "OrganizationalBranding.ReadWrite.All", AuthenticationFlowsPolicy: "Policy.ReadWrite.AuthenticationFlows",
  }
  const found: string[] = []
  for (const module of MODULES.filter(module => ["entra", "defender"].includes(module.id))) for (const area of module.areas) for (const part of area.parts) {
    for (const folder of part.folders) {
      const type = typeForFolder(folder)
      if (!type) continue
      if (!expected[folder]) { expect(restoreCapability(type), folder).toBe("none"); expect(part.restore.delegated, folder).toBe("unsupported"); continue }
      found.push(folder)
      expect(restoreCapability(type), folder).not.toBe("none")
      expect(part.restore.delegated, folder).toEqual([[expected[folder]], ["Application.Read.All", "Application.ReadWrite.All"]])
      for (const write of [restoreMatrixRow(folder)!.create, restoreMatrixRow(folder)!.update].filter(Boolean)) expect(write!.permissions, folder).toEqual([expected[folder]])
    }
  }
  expect(found.sort()).toEqual(Object.keys(expected).sort())
})
it("never requests the retired organization role through any setup or reader choice", () => {
  const all = Object.fromEntries(MODULES.map(module => [module.id, { access: "restore", areas: module.areas.filter(area => area.optIn || area.appOnlyOptIn).map(area => area.id) }]))
  for (const mode of ["delegated", "application"] as const) {
    expect(graphPermissions(all, mode)).not.toContain("Organization.ReadWrite.All")
    expect(knownPermissions(mode)[0]!.permissions).not.toContain("Organization.ReadWrite.All")
  }
  for (const script of ["New-TenuVaultDesktopApp.ps1", "New-TenuVaultBackupReader.ps1"]) expect(readFileSync(new URL(`../resources/${script}`, import.meta.url), "utf8")).not.toMatch(/['"]Organization\.ReadWrite\.All['"]/)
})
