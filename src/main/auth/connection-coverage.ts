import { missingForChoice, type PermissionChoice } from "../../shared/services/manifest"
import { grantedPermissions } from "../../shared/services/token"
import type { ModuleId } from "../../shared/services/modules"
import type { SignInMethod } from "../../shared/tenant-connection"
import type { ModuleSetting } from "../services/settings"

export function connectionCoverage(settings: Record<ModuleId, ModuleSetting>, method: SignInMethod, token: string): string[] {
  const granted = grantedPermissions(token)
  if (granted?.kind !== "delegated" || !granted.permissions.size) throw new Error("Microsoft did not return delegated permissions. Sign in again to check coverage.")
  const choice: PermissionChoice = Object.fromEntries(Object.entries(settings).filter(([, setting]) => setting.enabled).map(([service, setting]) => [
    service, { access: method === "graphCli" ? "backup" : setting.access, areas: Object.keys(setting.areas).filter(area => setting.areas[area]) },
  ]))
  return missingForChoice(choice, granted)
}
