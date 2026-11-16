import type { IntuneType } from "../intune/registry"
import { moduleForFolder } from "./modules"

/** Configuration contributes to backup counts and comparison. Device inventory is counted separately.
 * Hygiene and audit alerts have rules for Intune and Conditional Access only. New Entra configuration
 * is compared in backups and reports, without inventing audit actors or Intune hygiene findings.
 */
export function backupTypeUse(type: IntuneType) {
  const service = moduleForFolder(type.folder)?.module.id
  const auditService = !type.inventory && (service === "intune" || service === "conditionalAccess") ? service : undefined
  return { policyCount: !type.inventory, compare: true, hygiene: !type.inventory && service !== "entra" && service !== "defender", auditService }
}
