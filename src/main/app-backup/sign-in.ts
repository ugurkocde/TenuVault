import { isGuid } from "../../shared/security"
import { RESOURCE_SCOPES } from "../../shared/constants"
import { sourceTenant } from "../app-sources/store"
import type { AuthManager } from "../auth/msal"

export async function appRestoreToken(
  auth: AuthManager,
  tenant: string,
  client: string,
  authorizeRestore: () => Promise<void>,
): Promise<string> {
  return (await auth.getAccessToken(tenant, client, RESOURCE_SCOPES.graph, false, authorizeRestore)).accessToken
}

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
