import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { BACKUP_ONLY_GRAPH_PERMISSIONS, READ_ONLY_REGISTRATION_MESSAGE, desktopAppPermissions } from "../src/shared/app-registration"
import { DEVICE_INVENTORY_ROLE, READER_REQUIRED_ROLES } from "../src/shared/services/backup-permissions"
import { grantedPermissions, isReadOnlyRegistration, requireWritableRegistration } from "../src/shared/services/token"

const token = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`
const scopes = BACKUP_ONLY_GRAPH_PERMISSIONS.join(" ")

describe("interactive backup-only registration", () => {
  it("reuses the Backup Reader's required and optional read permissions", () => {
    const script = readFileSync(new URL("../resources/New-TenuVaultBackupReader.ps1", import.meta.url), "utf8")
    const roles = script.match(/\$roles = @\(([\s\S]*?)\)/)?.[1]?.match(/DeviceManagement\w+\.Read\.All/g)
    expect(roles).toEqual(READER_REQUIRED_ROLES)
    expect(BACKUP_ONLY_GRAPH_PERMISSIONS.filter(scope => scope.startsWith("DeviceManagement"))).toEqual([...READER_REQUIRED_ROLES, DEVICE_INVENTORY_ROLE])
    expect(desktopAppPermissions("backup-only").slice(1)).toEqual(desktopAppPermissions().slice(1))
  })

  it("checks the delegated scp claim, including after new consent", () => {
    const readOnly = token({ scp: scopes, roles: ["DeviceManagementConfiguration.ReadWrite.All"] })
    const full = token({ scp: scopes + " DeviceManagementConfiguration.ReadWrite.All" })
    expect(isReadOnlyRegistration(grantedPermissions(readOnly))).toBe(true)
    expect(() => requireWritableRegistration(readOnly)).toThrow(READ_ONLY_REGISTRATION_MESSAGE)
    expect(isReadOnlyRegistration(grantedPermissions(full))).toBe(false)
    expect(() => requireWritableRegistration(full)).not.toThrow()
    expect(isReadOnlyRegistration(grantedPermissions(token({ roles: BACKUP_ONLY_GRAPH_PERMISSIONS })))).toBe(false)
    expect(isReadOnlyRegistration(grantedPermissions(token({ scp: "User.Read DeviceManagementManagedDevices.Read.All" })))).toBe(false)
    expect(isReadOnlyRegistration(grantedPermissions("opaque"))).toBe(false)
  })
})
