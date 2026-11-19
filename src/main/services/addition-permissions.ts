import { graphPermissions, type PermissionChoice } from "../../shared/services/manifest"
import { canRequestRestore } from "../../shared/services/onboarding"
import { MODULES, type ModuleId } from "../../shared/services/modules"
import type { ModuleSetting } from "./settings"

/** Renderer requests may only name permissions justified by the saved service and area choices. */
export function additionPermissions(settings: Record<ModuleId, ModuleSetting>): readonly string[] {
  const choice: PermissionChoice = {}
  for (const module of MODULES) {
    const setting = settings[module.id]
    if (setting.enabled) choice[module.id] = {
      access: setting.access === "restore" && canRequestRestore(module.id) ? "restore" : "backup",
      areas: Object.keys(setting.areas).filter(area => setting.areas[area]),
    }
  }
  return graphPermissions(choice, "delegated")
}
