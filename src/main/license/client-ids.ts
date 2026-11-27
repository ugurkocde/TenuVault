import { isGuid } from "../../shared/security"
import { SETUP_HELPER_CLIENT_ID, TENUVAULT_CLIENT_ID } from "../../shared/tenant-connection"

/** Allowed client IDs for organization license sharing: the tenant's own registration (if any) and the TenuVault app. */
export function organizationClientIds(ownClientId: string | null | undefined): string[] {
  const ids = new Set<string>()
  if (isGuid(ownClientId) && ownClientId.toLowerCase() !== SETUP_HELPER_CLIENT_ID) ids.add(ownClientId.toLowerCase())
  ids.add(TENUVAULT_CLIENT_ID)
  return [...ids]
}
