import { grantedPermissions } from "../../shared/services/token"

/** Preview and dispatch report exactly the same missing operation scopes. */
export function directoryPermissionBlocker(token: string, permissions: readonly string[]): string | undefined {
  const granted = grantedPermissions(token)
  const missing = permissions.filter(permission => granted?.kind !== "delegated" || !granted.permissions.has(permission))
  if (missing.length) return `The signed-in connection lacks this operation's least-privileged permission: ${missing.join(", ")}.`
}
