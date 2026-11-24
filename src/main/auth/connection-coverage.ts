import { missingForChoice, type PermissionChoice } from "../../shared/services/manifest"
import { missingPackScopes } from "../../shared/services/permission-packs"
import { sharedTokenScopes } from "./token-identity"
import { ConnectionSwitchError } from "./switch-failure"
import type { ModuleId } from "../../shared/services/modules"
import type { SignInMethod } from "../../shared/tenant-connection"
import type { ModuleSetting } from "../services/settings"

export function connectionCoverage(settings: Record<ModuleId, ModuleSetting>, method: SignInMethod, token: string, graphScopes?: string[], grantedScopes?: readonly string[]): string[] {
  const permissions = sharedTokenScopes(token, grantedScopes)
  if (!permissions.size) throw new ConnectionSwitchError("switch_failed", "Microsoft did not return verifiable delegated permissions. Sign in again to check coverage.")
  if (method === "tenuvaultApp" && graphScopes) return missingPackScopes(graphScopes, permissions)
  return missingForChoice(connectionChoice(settings, method), { kind: "delegated", permissions })
}

export function connectionChoice(settings: Record<ModuleId, ModuleSetting>, method?: SignInMethod): PermissionChoice {
  return Object.fromEntries(Object.entries(settings).filter(([, setting]) => setting.enabled).map(([service, setting]) => [
    service, { access: method === "graphCli" ? "backup" : setting.access, areas: Object.keys(setting.areas).filter(area => setting.areas[area]) },
  ]))
}
