import { describe, expect, it } from "vitest"
import { optionalPermissionStatus } from "../src/shared/services/optional-permissions"

describe("optional permissions", () => {
  it("reports each optional permission from a delegated token, counting ReadWrite as Read", () => {
    const status = optionalPermissionStatus({ kind: "delegated", permissions: new Set(["Mail.Send", "GroupMember.Read.All", "User.ReadWrite.All", "Group.Read.All"]) })
    const byId = Object.fromEntries(status.map((entry) => [entry.id, entry]))
    expect(byId.notificationEmail).toMatchObject({ granted: true, missing: [] })
    expect(byId.groupRecipients).toMatchObject({ granted: true, missing: [] })
    expect(byId.conditionalAccessWatching).toMatchObject({ granted: false, missing: ["AuditLog.Read.All"], setupSwitch: "-IncludeAuditLog" })
    expect(byId.groupRead).toMatchObject({ granted: true })
  })

  it("names only the missing half of a pair", () => {
    const status = optionalPermissionStatus({ kind: "delegated", permissions: new Set(["GroupMember.Read.All"]) })
    expect(status.find((entry) => entry.id === "groupRecipients")).toMatchObject({ granted: false, missing: ["User.Read.All"] })
  })

  it("cannot judge an unreadable or app-only token", () => {
    expect(optionalPermissionStatus(undefined).every((entry) => entry.granted === null)).toBe(true)
    expect(optionalPermissionStatus({ kind: "application", permissions: new Set(["AuditLog.Read.All"]) }).every((entry) => entry.granted === null)).toBe(true)
  })
})
