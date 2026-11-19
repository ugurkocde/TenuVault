import { moduleForFolder } from "../../shared/services/modules"

export const BACKUP_SERVICES = [
  { id: "intune", label: "Intune" },
  { id: "entra", label: "Entra ID" },
  { id: "defender", label: "Defender" },
] as const

export type BackupService = typeof BACKUP_SERVICES[number]["id"]
export type BackupServiceFilter = BackupService | "all"

export function parseBackupService(value: string | null): BackupServiceFilter {
  return BACKUP_SERVICES.find(service => service.id === value)?.id ?? "all"
}

/** Conditional Access has its own switch, but belongs under Entra ID in navigation. */
export function matchesBackupService(folder: string, service: BackupServiceFilter): boolean {
  if (service === "all") return true
  const id = moduleForFolder(folder)?.module.id
  return id === service || (service === "entra" && id === "conditionalAccess")
}
