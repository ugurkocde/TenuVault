import { restorePermissions } from "./restore-actor"
import { restoreAccessGuidance } from "../../shared/services/modules"
import { GRAPH_CLI_READ_ONLY, sharedSignInMethod } from "../../shared/tenant-connection"

/** Preview and dispatch report exactly the same missing operation scopes. */
export function directoryPermissionBlocker(token: string, permissions: readonly string[], clientId: string, scopes?: readonly string[]): string | undefined {
  if (sharedSignInMethod(clientId) === "graphCli") return GRAPH_CLI_READ_ONLY
  const granted = restorePermissions(token, scopes)
  const missing = permissions.filter(permission => granted?.kind !== "delegated" || !granted.permissions.has(permission))
  if (missing.length) return `This restore needs ${missing.join(" and ")}. ${restoreAccessGuidance(clientId)}`
}
