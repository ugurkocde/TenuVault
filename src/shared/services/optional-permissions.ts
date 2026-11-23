import type { GrantedPermissions } from "./modules"

import { GROUP_READ_PERMISSION, GROUP_READ_PERMISSIONS } from "../group-access"

/** Feature permissions shown separately from service modules. */
export type OptionalPermissionId = "notificationEmail" | "groupRecipients" | "conditionalAccessWatching" | "groupRead"

export interface OptionalPermission {
  id: OptionalPermissionId
  /** What the permission is used for, as a short label. */
  label: string
  /** Every permission listed is needed. */
  permissions: readonly string[]
  /** The setup switch for permissions outside the default registration. */
  setupSwitch?: string
}

export const OPTIONAL_PERMISSIONS: readonly OptionalPermission[] = [
  { id: "notificationEmail", label: "Notification email", permissions: ["Mail.Send"], setupSwitch: "-IncludeNotifications" },
  { id: "groupRecipients", label: "Entra group recipients of notification email", permissions: ["GroupMember.Read.All", "User.Read.All"], setupSwitch: "-IncludeNotifications" },
  { id: "conditionalAccessWatching", label: "Conditional Access change watching", permissions: ["AuditLog.Read.All"], setupSwitch: "-IncludeAuditLog" },
  { id: "groupRead", label: "Group read: group names, member counts and checks for assignments, Copy to Tenants mappings and the hygiene group check", permissions: [GROUP_READ_PERMISSION] },
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
    const missing = entry.permissions.filter((permission) => permission === GROUP_READ_PERMISSION
      ? !GROUP_READ_PERMISSIONS.some(scope => granted.permissions.has(scope))
      : !covers(granted.permissions, permission))
    return { ...entry, permissions: [...entry.permissions], missing, granted: missing.length === 0 }
  })
}
