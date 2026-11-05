import type { GrantedPermissions } from "./modules"

/**
 * Delegated permissions the setup script only adds with a switch. Each serves one feature;
 * without it that feature fails while everything else keeps working. The app shows their
 * status from the signed-in token so an admin can add them before a feature fails.
 */
export type OptionalPermissionId = "notificationEmail" | "groupRecipients" | "conditionalAccessWatching" | "groupRead"

export interface OptionalPermission {
  id: OptionalPermissionId
  /** What the permission is used for, as a short label. */
  label: string
  /** Every permission listed is needed. */
  permissions: readonly string[]
  /** The New-TenuVaultDesktopApp.ps1 switch that adds it to a new app registration. */
  setupSwitch: string
}

export const OPTIONAL_PERMISSIONS: readonly OptionalPermission[] = [
  { id: "notificationEmail", label: "Notification email", permissions: ["Mail.Send"], setupSwitch: "-IncludeNotifications" },
  { id: "groupRecipients", label: "Entra group recipients of notification email", permissions: ["GroupMember.Read.All", "User.Read.All"], setupSwitch: "-IncludeNotifications" },
  { id: "conditionalAccessWatching", label: "Conditional Access change watching", permissions: ["AuditLog.Read.All"], setupSwitch: "-IncludeAuditLog" },
  { id: "groupRead", label: "Hygiene check for groups that no longer exist", permissions: ["Group.Read.All"], setupSwitch: "-IncludeGroupRead" },
]

export interface OptionalPermissionStatus extends OptionalPermission {
  /** Permissions of the list the token does not carry. */
  missing: string[]
  /** Null when the token could not be read. */
  granted: boolean | null
}

/** A broader ReadWrite permission covers the Read one, as Microsoft Graph treats it. */
function covers(granted: ReadonlySet<string>, permission: string): boolean {
  return granted.has(permission) || (permission.endsWith(".Read.All") && granted.has(permission.replace(/\.Read\.All$/, ".ReadWrite.All")))
}

export function optionalPermissionStatus(granted: GrantedPermissions | undefined): OptionalPermissionStatus[] {
  return OPTIONAL_PERMISSIONS.map((entry) => {
    if (!granted || granted.kind !== "delegated") return { ...entry, permissions: [...entry.permissions], missing: [], granted: null }
    const missing = entry.permissions.filter((permission) => !covers(granted.permissions, permission))
    return { ...entry, permissions: [...entry.permissions], missing, granted: missing.length === 0 }
  })
}
