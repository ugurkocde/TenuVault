import type { AuthenticationResult } from "@azure/msal-node"
import type { RestoreActor } from "../../shared/intune/restore-guards"
import { normalizeGuid } from "../../shared/security"
import { grantedPermissions } from "../../shared/services/token"

type ActorIdentity = Pick<RestoreActor, "tenantId" | "clientId" | "userId">

/** Evidence from the same tenant-scoped MSAL acquisition as the bearer. Kept in memory. */
export interface RestoreAuthorization extends ActorIdentity {
  scopes?: readonly string[]
}

const adminRequired = "A signed-in admin for this tenant and connection is required for this restore."

function restoreTokenClaims(token: string): Record<string, unknown> | undefined {
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
    if (claims && typeof claims === "object" && !Array.isArray(claims)) return claims as Record<string, unknown>
  } catch { /* MSAL can supply evidence for an opaque bearer. */ }
}

function tokenActor(claims: Record<string, unknown> | undefined): ActorIdentity | undefined {
  if (!claims) return
  const { scp, oid, tid, appid, azp, idtyp } = claims
  const clientId = azp ?? appid
  if (idtyp !== "app" && typeof scp === "string" && scp.trim() && typeof oid === "string" && oid &&
    typeof tid === "string" && tid && typeof clientId === "string" && clientId) {
    return { userId: oid, tenantId: tid, clientId }
  }
}

export function restorePermissions(token: string, scopes?: readonly string[]) {
  const claims = grantedPermissions(token)
  if (scopes === undefined) return claims
  const permissions = scopes.flatMap(scope => {
    const name = scope.replace(/^https:\/\/graph\.microsoft\.com\//i, "")
    return /^[a-zA-Z][\w.-]*$/.test(name) && !["openid", "profile", "offline_access"].includes(name) ? [name] : []
  })
  if (!restoreTokenClaims(token)) return { kind: "delegated" as const, permissions: new Set(permissions) }
  if (claims?.kind !== "delegated") return claims
  // A readable bearer must carry every scope the restore relies on.
  return { kind: "delegated" as const, permissions: new Set(permissions.filter(scope => claims.permissions.has(scope))) }
}

function sameActor(identity: ActorIdentity, actor: ActorIdentity): boolean {
  return normalizeGuid(identity.userId) === normalizeGuid(actor.userId) &&
    normalizeGuid(identity.tenantId) === normalizeGuid(actor.tenantId) &&
    normalizeGuid(identity.clientId) === normalizeGuid(actor.clientId)
}

/** The bearer and account come from main-process sign-in, never from a renderer request. */
export function requireRestoreActor(token: string, actor: ActorIdentity, authorization?: RestoreAuthorization): void {
  if (!token || (authorization && !sameActor(authorization, actor))) throw new Error(adminRequired)
  const claims = restoreTokenClaims(token)
  if (claims || authorization?.scopes === undefined) {
    const identity = tokenActor(claims)
    if (!identity || !sameActor(identity, actor)) throw new Error(adminRequired)
  }
  const granted = restorePermissions(token, authorization?.scopes)
  if (granted?.kind !== "delegated" || !granted.permissions.size) throw new Error(adminRequired)
}

export function restoreSignIn(tenantId: string, stored: { clientId: string; homeAccountId: string }, result: Pick<AuthenticationResult, "account" | "accessToken" | "tenantId" | "scopes">) {
  const { account, accessToken: token } = result
  if (account && (!account.homeAccountId || account.homeAccountId !== stored.homeAccountId ||
    normalizeGuid(account.tenantId) !== normalizeGuid(tenantId))) throw new Error(adminRequired)
  if (result.tenantId && normalizeGuid(result.tenantId) !== normalizeGuid(tenantId)) throw new Error(adminRequired)
  const fallback = account?.localAccountId ? undefined : tokenActor(restoreTokenClaims(token))
  const userId = account?.localAccountId || fallback?.userId
  if (!userId) throw new Error(adminRequired)
  const identity = { tenantId: normalizeGuid(tenantId), clientId: normalizeGuid(stored.clientId), userId: normalizeGuid(userId) }
  const authorization = { ...(fallback ?? identity), scopes: result.scopes }
  requireRestoreActor(token, identity, authorization)
  return { ...identity, token, authorization, auditActor: { username: account?.username || userId, name: account?.name } }
}
