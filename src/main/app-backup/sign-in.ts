import { isGuid } from "../../shared/security"
import { sourceTenant } from "../app-sources/store"

/** App Backup needs the configured registration, independently of backup storage. */
export function appBackupClientId(tenant: string, serialized: string | null | undefined): string {
  const id = sourceTenant(tenant)
  let records: unknown
  try { records = JSON.parse(serialized ?? "[]") } catch { records = null }
  const record = Array.isArray(records) ? records.find(row => typeof row?.credentials?.tenantId === "string" && row.credentials.tenantId.toLowerCase() === id) : undefined
  const clientId = record?.credentials?.appId
  if (!isGuid(clientId)) throw new Error("Configure this tenant's Microsoft app registration before signing in.")
  return clientId.toLowerCase()
}
