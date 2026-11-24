import { grantedPermissions } from "../../shared/services/token"
import { isGuid } from "../../shared/security"

/** Local comparison with the connection used to acquire the token. Microsoft validates the token itself. */
export function tokenIdentity(token: string): { tenantId: string | null; clientId: string | null; decoded: boolean } {
  const guid = (value: unknown) => isGuid(value) ? value.toLowerCase() : null
  try {
    const [, payload, signature, extra] = token.split(".")
    if (payload && signature && extra === undefined) {
      const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
      if (!claims || typeof claims !== "object" || Array.isArray(claims)) return { tenantId: null, clientId: null, decoded: false }
      const { tid, azp, appid } = claims as Record<string, unknown>
      const clientId = guid(azp ?? appid)
      return { decoded: true, tenantId: guid(tid), clientId: azp && appid && guid(appid) !== clientId ? null : clientId }
    }
  } catch { /* Opaque or malformed token. */ }
  return { decoded: false, tenantId: null, clientId: null }
}


/** MSAL supplies the granted scopes when a shared-client access token is opaque. */
export function sharedTokenScopes(token: string, acquiredScopes: readonly string[] = []): ReadonlySet<string> {
  if (!tokenIdentity(token).decoded) return new Set(acquiredScopes.map(scope => scope.split("/").at(-1)!))
  const granted = grantedPermissions(token)
  return granted?.kind === "delegated" ? granted.permissions : new Set()
}
