import { moduleForFolder, type ModuleId } from "./modules"
import { INTUNE_TYPES } from "../intune/registry"

export const BACKUP_SERVICES = [
  { id: "entra", label: "Entra ID" },
  { id: "intune", label: "Intune" },
] as const

export type BackupService = typeof BACKUP_SERVICES[number]["id"]

/** Display order only. Permission requests and stored module IDs keep their own order. */
export const DISPLAY_MODULE_ORDER: readonly ModuleId[] = ["entra", "conditionalAccess", "intune"]

export function backupServiceForFolder(folder: string): BackupService | undefined {
  const id = moduleForFolder(folder)?.module.id
  return id === "conditionalAccess" ? "entra" : id
}

/** The portal for a backup folder, a backup file path, or a restore journal request path. */
export function restoreAdminCenter(folderOrPath: string): string {
  const path = folderOrPath.toLowerCase().replace(/^(?:https:\/\/graph\.microsoft\.com)?\/?(?:beta\/)?/, "")
  const parts = path.split("/")
  const folder = parts.at(-2) ?? path
  const type = INTUNE_TYPES.find(type => {
    const collection = type.path.toLowerCase()
    return path === collection || path.startsWith(`${collection}/`)
  })
  const service = backupServiceForFolder(folder) ?? (type && backupServiceForFolder(type.folder))
  if (service === "entra") return "the Microsoft Entra admin center"
  if (service === "intune" || ["deviceappmanagement", "devicemanagement", "deviceenrollment"].includes(parts[0] ?? "")) return "the Microsoft Intune admin center"
  return "the target service’s admin center"
}

export function compareBackupServices(left: string, right: string): number {
  const rank = (folder: string) => {
    const index = BACKUP_SERVICES.findIndex(service => service.id === backupServiceForFolder(folder))
    return index === -1 ? BACKUP_SERVICES.length : index
  }
  return rank(left) - rank(right)
}
