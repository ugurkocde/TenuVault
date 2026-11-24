import { graphCliCoverage } from "../../shared/services/graph-cli-coverage"
import { GRAPH_CLI_NEXT_STEP, GRAPH_CLI_UNAVAILABLE } from "../../shared/tenant-connection"
import { accessTokenClaims } from "./token-identity"
import { missingForChoice, type PermissionChoice } from "../../shared/services/manifest"
import { missingPackScopes } from "../../shared/services/permission-packs"
import { sharedTokenScopes } from "./token-identity"
import { ConnectionSwitchError } from "./switch-failure"
import type { ModuleId } from "../../shared/services/modules"
import type { SignInMethod } from "../../shared/tenant-connection"
import type { ModuleSetting } from "../services/settings"

export function connectionCoverage(settings: Record<ModuleId, ModuleSetting>, method: SignInMethod, token: string, graphScopes?: string[], grantedScopes?: readonly string[]): string[] {
  const permissions = method === "graphCli" ? graphCliScopes(token, grantedScopes) : sharedTokenScopes(token, grantedScopes)
  if (!permissions) return []
  if (!permissions.size) throw new ConnectionSwitchError("switch_failed", "Microsoft did not return verifiable delegated permissions. Sign in again to check coverage.")
  if (method === "tenuvaultApp" && graphScopes) return missingPackScopes(graphScopes, permissions)
  return missingForChoice(connectionChoice(settings, method), { kind: "delegated", permissions })
}

export function connectionChoice(settings: Record<ModuleId, ModuleSetting>, method?: SignInMethod): PermissionChoice {
  return Object.fromEntries(Object.entries(settings).filter(([, setting]) => setting.enabled).map(([service, setting]) => [
    service, { access: method === "graphCli" ? "backup" : setting.access, areas: Object.keys(setting.areas).filter(area => setting.areas[area]) },
  ]))
}

// Only an explicit token response grant can describe an opaque token. Never use MSAL's
// AuthenticationResult.scopes, which may be populated from the request.
export function graphCliScopes(token: string, explicit?: readonly string[]): ReadonlySet<string> | undefined {
  if (!accessTokenClaims(token) && explicit === undefined) return undefined
  return sharedTokenScopes(token, explicit)
}

export function verifyGraphCliGrant(token: string, explicit?: readonly string[]): string[] | undefined {
  const permissions = graphCliScopes(token, explicit)
  if (!permissions) return
  if (!graphCliCoverage(permissions).some(service => service.readable?.length)) {
    throw new ConnectionSwitchError("unavailable", `${GRAPH_CLI_UNAVAILABLE} ${GRAPH_CLI_NEXT_STEP}`)
  }
  return [...permissions].sort()
}
