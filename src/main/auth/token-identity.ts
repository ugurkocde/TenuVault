import { isGuid } from "../../shared/security"

/** Local comparison with the connection used to acquire the token. Microsoft validates the token itself. */
export function tokenIdentity(token: string): { tenantId: string | null; clientId: string | null } {
  const guid = (value: unknown) => isGuid(value) ? value.toLowerCase() : null
  try {
    const [, payload, signature, extra] = token.split(".")
    if (payload && signature && extra === undefined) {
      const { tid, azp, appid } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
      const clientId = guid(azp ?? appid)
      return { tenantId: guid(tid), clientId: azp && appid && guid(appid) !== clientId ? null : clientId }
    }
  } catch { /* Opaque or malformed token. */ }
  return { tenantId: null, clientId: null }
}
