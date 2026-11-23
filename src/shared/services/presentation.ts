import { moduleForFolder, type ModuleId } from "./modules"

export const BACKUP_SERVICES = [
  { id: "defender", label: "Defender" },
  { id: "entra", label: "Entra ID" },
  { id: "intune", label: "Intune" },
] as const

export type BackupService = typeof BACKUP_SERVICES[number]["id"]

/** Display order only. Permission requests and stored module IDs keep their own order. */
export const DISPLAY_MODULE_ORDER: readonly ModuleId[] = ["defender", "entra", "conditionalAccess", "intune"]

export function backupServiceForFolder(folder: string): BackupService | undefined {
  const id = moduleForFolder(folder)?.module.id
  return id === "conditionalAccess" ? "entra" : id
}

export function compareBackupServices(left: string, right: string): number {
  const rank = (folder: string) => {
    const index = BACKUP_SERVICES.findIndex(service => service.id === backupServiceForFolder(folder))
    return index === -1 ? BACKUP_SERVICES.length : index
  }
  return rank(left) - rank(right)
}
