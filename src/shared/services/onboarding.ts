import { expandedEntraScope } from "../intune/entra-scope"
import { INTUNE_TYPES, restoreCapability } from "../intune/registry"
import { checkedChoice, type PermissionChoice } from "./manifest"
import { MODULES, moduleForFolder, type ModuleId } from "./modules"

import { BACKUP_SERVICES } from "./presentation"

export const DEFAULT_ONBOARDING_CHOICE: PermissionChoice = { intune: { access: "backup" } }
export const ONBOARDING_ENTRA_CHOICE: PermissionChoice = {
  ...DEFAULT_ONBOARDING_CHOICE, conditionalAccess: { access: "backup" }, entra: { access: "backup" },
}


/** Keep the read permission included by every earlier Intune setup, without enabling its backups. */
export function onboardingPermissions(choice: PermissionChoice): PermissionChoice {
  return choice.intune ? { conditionalAccess: { access: "backup" }, ...choice } : choice
}

export function hasOnboardingBackups(choice: PermissionChoice): boolean {
  return INTUNE_TYPES.some(type => {
    const found = moduleForFolder(type.folder)
    return found && choice[found.module.id] && (!found.area.optIn || choice[found.module.id]?.areas?.includes(found.area.id))
  })
}

export function canRequestRestore(id: ModuleId): boolean {
  return INTUNE_TYPES.some(type => moduleForFolder(type.folder)?.module.id === id && !["none", "metadata"].includes(restoreCapability(type)))
}

export function checkedOnboardingChoice(value: unknown): PermissionChoice {
  const choice = checkedChoice(value)
  for (const module of MODULES) if (choice[module.id]?.access === "restore" && !canRequestRestore(module.id)) throw new Error(`Restore access is not available for ${module.label} yet.`)
  return choice
}

export function choiceLabel(choice: PermissionChoice): string {
  const names = BACKUP_SERVICES.flatMap(({ id, label }) => {
    if (choice[id]) return [label]
    return id === "entra" && choice.conditionalAccess ? ["Entra ID (Conditional Access)"] : []
  })
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "a service"
}

export const PERSONAL_DATA: Record<string, string> = {
  applications: "Stores app registration and enterprise app definitions, credential metadata, owner IDs, consent grants and role assignment IDs. Federated credential subjects and notification addresses can identify people. No passwords or private keys are stored.",
  groups: "Stores group properties and the object IDs of members and owners. These identify people and their group memberships.",
  usersAndDevices: expandedEntraScope ? "Stores allowlisted user identity, job, organization, account state, licenses and manager ID, device inventory and organizational contacts. These can include names, email addresses and device identifiers. Passwords and credentials are never stored." : "Stores device inventory, which can include device names and identifiers.",
}
