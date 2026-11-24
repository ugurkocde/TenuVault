import { restorePermissions } from "./restore-actor"

/** Preview and dispatch report exactly the same missing operation scopes. */
export function directoryPermissionBlocker(token: string, permissions: readonly string[], scopes?: readonly string[]): string | undefined {
  const granted = restorePermissions(token, scopes)
  const missing = permissions.filter(permission => granted?.kind !== "delegated" || !granted.permissions.has(permission))
  if (missing.length) return `The signed-in connection lacks this operation's least-privileged permission: ${missing.join(", ")}.`
}
