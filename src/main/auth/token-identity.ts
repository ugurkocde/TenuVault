import { createHash } from "node:crypto"
import { grantedPermissions } from "../../shared/services/token"
import { isGuid, normalizeGuid } from "../../shared/security"

export const accessTokenDigest = (token: string) => createHash("sha256").update(token).digest("hex")

/** A Microsoft bearer may be opaque. Claims here only describe a decodable JWT. */
export function accessTokenClaims(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return
  const [, payload, signature, extra] = token.split(".")
  if (!payload || !signature || extra !== undefined) return
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (claims && typeof claims === "object" && !Array.isArray(claims)) return claims as Record<string, unknown>
  } catch { /* Opaque or malformed bearer. */ }
}

/** Local comparison with the connection used to acquire the token. Microsoft validates the token itself. */
export function tokenIdentity(token: string): { tenantId: string | null; clientId: string | null; decoded: boolean } {
  const guid = (value: unknown) => isGuid(value) ? normalizeGuid(value) : null
  const claims = accessTokenClaims(token)
  if (!claims) return { decoded: false, tenantId: null, clientId: null }
  const { tid, azp, appid } = claims
  const clientId = guid(azp ?? appid)
  return { decoded: true, tenantId: guid(tid), clientId: azp && appid && guid(appid) !== clientId ? null : clientId }
}

/** MSAL supplies the granted scopes when a shared-client access token is opaque. */
export function sharedTokenScopes(token: string, acquiredScopes: readonly string[] = []): ReadonlySet<string> {
  if (!tokenIdentity(token).decoded) return new Set(acquiredScopes.map(scope => scope.split("/").at(-1)!))
  const granted = grantedPermissions(token)
  return granted?.kind === "delegated" ? granted.permissions : new Set()
}
