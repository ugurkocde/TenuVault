import { expect, it } from "vitest"
import { graphPermissions, DEFAULT_SETUP_CHOICE } from "../src/shared/services/manifest"
import { directoryAdmission } from "../src/main/restore/directory-9a-io"
import { restoreMatrixRow } from "../src/shared/intune/restore-matrix"
import { typeForFolder, restoreCapability } from "../src/shared/intune/registry"
import type { GuardedStep } from "../src/main/restore/guarded-run"
it("requests only admitted directory operation scopes above each area's unchanged backup requirements", () => {
  const operations = { groups: ["Group.ReadWrite.All", "GroupMember.ReadWrite.All", "User.Read.All", "Application.Read.All", "Policy.Read.All", "RoleManagement.Read.Directory"], usersAndDevices: ["User.Create", "User.ReadUpdate.All", "User.ReadWrite.All", "Application.Read.All"] }
  for (const [area, permissions] of Object.entries(operations)) {
    const backup = graphPermissions({ entra: { access: "backup", areas: [area] } }, "delegated")
    const restore = graphPermissions({ entra: { access: "restore", areas: [area] } }, "delegated")
    for (const permission of permissions) expect(restore).toContain(permission)
    for (const forbidden of ["Organization.ReadWrite.All", "Directory.ReadWrite.All", "User.DeleteRestore.All", "User.EnableDisableAccount.All", "User.Invite.All", "LicenseAssignment.ReadWrite.All", "RoleManagement.ReadWrite.Directory"]) expect(restore).not.toContain(forbidden)
    expect(restore.includes("Directory.Read.All")).toBe(backup.includes("Directory.Read.All"))
    expect(graphPermissions({ entra: { access: "restore", areas: [area] } }, "application")).toEqual(graphPermissions({ entra: { access: "backup", areas: [area] } }, "application"))
  }
  expect(graphPermissions(DEFAULT_SETUP_CHOICE, "delegated")).not.toContain("User.Create")
})
it("keeps every unsupported directory action blocked at the final transport", () => {
  for (const [folder, actions] of [["Users", ["license", "invite", "recycle"]], ["Groups", ["recycle"]]] as const) {
    expect(restoreCapability(typeForFolder(folder)!)).toBe("create")
    for (const action of actions) expect(directoryAdmission({ folder, directory: { action }, desired: {} } as GuardedStep)).toBeTruthy()
  }
  expect(directoryAdmission({ folder: "Users", directory: { action: "update" }, desired: { accountEnabled: true } } as unknown as GuardedStep)).toContain("Account activation")
  expect(restoreMatrixRow("Groups")!.directoryRestore!.evidence).not.toHaveProperty("dynamic rule")
})
