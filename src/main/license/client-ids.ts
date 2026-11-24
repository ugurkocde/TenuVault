import { isGuid } from "../../shared/security"
import { GRAPH_CLI_CLIENT_ID, TENUVAULT_CLIENT_ID } from "../../shared/tenant-connection"

/** Only a key holder's explicit choice adds the shared Microsoft public client. */
export function organizationClientIds(ownClientId: string | null | undefined, allowGraphCli = false): string[] {
  const ids = new Set<string>()
  if (isGuid(ownClientId) && ownClientId.toLowerCase() !== GRAPH_CLI_CLIENT_ID) ids.add(ownClientId.toLowerCase())
  ids.add(TENUVAULT_CLIENT_ID)
  if (allowGraphCli) ids.add(GRAPH_CLI_CLIENT_ID)
  return [...ids]
}
