import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { MODULE_BY_ID, meets } from "../src/shared/services/modules"
import { BASE_PERMISSIONS } from "../src/shared/services/manifest"
import { isPackWriteScope, minimumScopes, permissionPackTable, PRIVILEGED_ENTRA_PACK, servicePack, tenantPermissionPacks } from "../src/shared/services/permission-packs"
import { privilegedRestoreConsent } from "../src/main/restore/privileged-consent"
import published from "./fixtures/published-pack-scope-ids.json"

describe("TenuVault app permission packs", () => {
  it("keeps optional features and privileged writes out of normal requests", () => {
    const basic = tenantPermissionPacks({}, { azure: false, audit: false })
    expect(basic.map(pack => pack.id)).toEqual(["basics"])
    expect(basic[0]?.scopes).toEqual(["openid", "profile", "offline_access", "User.Read", "Organization.Read.All"])
    const packs = tenantPermissionPacks({
      entra: { access: "restore", areas: ["applications", "groups", "usersAndDevices"] },
      intune: { access: "backup" },
      defender: { access: "restore" },
      conditionalAccess: { access: "backup" },
    }, { azure: true, audit: true })
    expect(packs.map(pack => pack.id)).toEqual(["basics", "defender-restore", "entra-restore", "intune-backup", "conditionalAccess-backup", "management", "storage", "audit"])
    expect(packs.find(pack => pack.id === "intune-backup")?.scopes).toContain("GroupMember.Read.All")
    expect(packs.flatMap(pack => pack.scopes)).not.toEqual(expect.arrayContaining(["Organization.ReadWrite.All"]))
    expect(packs.flatMap(pack => pack.scopes)).not.toContain("Directory.ReadWrite.All")
    expect(packs.flatMap(pack => pack.scopes).filter(scope => PRIVILEGED_ENTRA_PACK.scopes.includes(scope))).toEqual([])
    expect(packs.flatMap(pack => pack.scopes)).not.toContain("Policy.ReadWrite.ConditionalAccess")
    expect(servicePack("conditionalAccess", "restore").scopes).toEqual(["Policy.Read.All", "Policy.ReadWrite.ConditionalAccess"])
    expect(servicePack("defender", "restore").scopes).toEqual(servicePack("defender", "backup").scopes)
  })

  it("minimizes overlapping alternatives even when no group forces the shared scope", () => {
    expect(minimumScopes([["A", "C"], ["B", "C"], ["A", "C", "D"], ["X", "Y"], ["Y", "Z"]])).toEqual(["C", "Y"])
    expect(minimumScopes([["A", "B"], ["B", "C"], ["C"]], new Set(["A"]))).toEqual(["C"])
    expect(() => minimumScopes([[]])).toThrow("uncovered requirement")
  })

  it.each(["defender", "entra", "intune", "conditionalAccess"] as const)("covers the manifest's %s reads, with or without restore access", id => {
    const module = MODULE_BY_ID.get(id)!
    for (const access of ["backup", "restore"] as const) {
      const pack = servicePack(id, access, module.areas.filter(area => area.optIn).map(area => area.id))
      const held = new Set([...pack.scopes, ...BASE_PERMISSIONS])
      if (access === "backup") expect(pack.scopes.some(isPackWriteScope)).toBe(false)
      for (const part of module.areas.flatMap(area => area.parts)) {
        if (part.backup.delegated !== "unsupported") expect(meets(part.backup.delegated, held), part.folders.join(", ")).toBe(true)
        if (access === "restore" && !part.restoreNotRequested && part.restore.delegated !== "unsupported") {
          const available = part.restore.delegated.filter(group => group.some(scope => !PRIVILEGED_ENTRA_PACK.scopes.includes(scope) &&
            !["Directory.ReadWrite.All", "Organization.ReadWrite.All"].includes(scope)))
          expect(meets(available, held), part.folders.join(", ")).toBe(true)
        }
      }
    }
  })

  it("substitutes required writes for Intune reads and keeps managed devices read-only", () => {
    const restore = servicePack("intune", "restore").scopes
    expect(restore).toContain("DeviceManagementConfiguration.ReadWrite.All")
    expect(restore).not.toContain("DeviceManagementConfiguration.Read.All")
    expect(restore).toContain("DeviceManagementManagedDevices.Read.All")
    expect(restore).not.toContain("DeviceManagementManagedDevices.ReadWrite.All")
  })

  it("checks the docs table against the packs and resource service principal IDs", () => {
    const docs = readFileSync(new URL("../docs-site/src/content/docs/security/permissions.md", import.meta.url), "utf8")
    expect(docs).toContain(permissionPackTable(published))
  })

  it("only plans temporary privileged consent at method B restore execution", () => {
    expect(privilegedRestoreConsent("graphCli", "EntraRoleAssignments")).toBeNull()
    expect(privilegedRestoreConsent("ownApp", "Applications")).toBeNull()
    expect(privilegedRestoreConsent("tenuvaultApp", "Users")).toBeNull()
    expect(privilegedRestoreConsent("tenuvaultApp", "Applications")).toEqual({
      pack: PRIVILEGED_ENTRA_PACK,
      cleanup: { label: "Remove this permission", checked: true, operationScopesOnly: true, required: true },
    })
  })
})
