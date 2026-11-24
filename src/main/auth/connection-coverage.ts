import { missingForChoice, type PermissionChoice } from "../../shared/services/manifest"
import { missingPackScopes } from "../../shared/services/permission-packs"
import { grantedPermissions } from "../../shared/services/token"
import type { ModuleId } from "../../shared/services/modules"
import type { SignInMethod } from "../../shared/tenant-connection"
import type { ModuleSetting } from "../services/settings"

export function connectionCoverage(settings: Record<ModuleId, ModuleSetting>, method: SignInMethod, token: string, graphScopes?: string[], grantedScopes?: readonly string[]): string[] {
  const granted = grantedScopes === undefined ? grantedPermissions(token) : { kind: "delegated" as const, permissions: new Set(grantedScopes) }
  if (granted?.kind !== "delegated" || !granted.permissions.size) throw new Error("Microsoft did not return delegated permissions. Sign in again to check coverage.")
  if (method === "tenuvaultApp" && graphScopes) return missingPackScopes(graphScopes, granted.permissions)
  return missingForChoice(connectionChoice(settings, method), granted)
}

export function connectionChoice(settings: Record<ModuleId, ModuleSetting>, method?: SignInMethod): PermissionChoice {
  return Object.fromEntries(Object.entries(settings).filter(([, setting]) => setting.enabled).map(([service, setting]) => [
    service, { access: method === "graphCli" ? "backup" : setting.access, areas: Object.keys(setting.areas).filter(area => setting.areas[area]) },
  ]))
}
