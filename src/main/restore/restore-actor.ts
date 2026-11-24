import type { AuthenticationResult } from "@azure/msal-node"
import type { RestoreActor } from "../../shared/intune/restore-guards"
import { normalizeGuid } from "../../shared/security"
import { grantedPermissions } from "../../shared/services/token"
import { accessTokenClaims } from "../auth/token-identity"

type ActorIdentity = Pick<RestoreActor, "tenantId" | "clientId" | "userId">

/** Evidence from the same tenant-scoped MSAL acquisition as the bearer. Kept in memory. */
export interface RestoreAuthorization extends ActorIdentity {
  scopes?: readonly string[]
}

const adminRequired = "A signed-in admin for this tenant and connection is required for this restore."

function tokenActor(token: string): ActorIdentity | undefined {
  const claims = accessTokenClaims(token)
  if (!claims) return
  const { scp, oid, tid, appid, azp, idtyp } = claims
  const clientId = azp ?? appid
  if (idtyp !== "app" && typeof scp === "string" && scp.trim() && typeof oid === "string" && oid &&
    typeof tid === "string" && tid && typeof clientId === "string" && clientId &&
    !(typeof azp === "string" && typeof appid === "string" && normalizeGuid(azp) !== normalizeGuid(appid))) {
    return { userId: oid, tenantId: tid, clientId }
  }
}

export function restorePermissions(token: string, scopes?: readonly string[]) {
  if (scopes === undefined) return grantedPermissions(token)
  const permissions = scopes.flatMap(scope => {
    const name = scope.replace(/^https:\/\/graph\.microsoft\.com\//i, "")
    return /^[a-zA-Z][\w.-]*$/.test(name) && !["openid", "profile", "offline_access"].includes(name) ? [name] : []
  })
  return { kind: "delegated" as const, permissions: new Set(permissions) }
}

function sameActor(identity: ActorIdentity, actor: ActorIdentity): boolean {
  return normalizeGuid(identity.userId) === normalizeGuid(actor.userId) &&
    normalizeGuid(identity.tenantId) === normalizeGuid(actor.tenantId) &&
    normalizeGuid(identity.clientId) === normalizeGuid(actor.clientId)
}

/** The bearer and account come from main-process sign-in, never from a renderer request. */
export function requireRestoreActor(token: string, actor: ActorIdentity, authorization?: RestoreAuthorization): void {
  if (!token || (authorization && !sameActor(authorization, actor))) throw new Error(adminRequired)
  if (authorization?.scopes === undefined) {
    const claims = tokenActor(token)
    if (!claims || !sameActor(claims, actor)) throw new Error(adminRequired)
  }
  const granted = restorePermissions(token, authorization?.scopes)
  if (granted?.kind !== "delegated" || !granted.permissions.size) throw new Error(adminRequired)
}

export function restoreSignIn(tenantId: string, stored: { clientId: string; homeAccountId: string }, result: Pick<AuthenticationResult, "account" | "accessToken" | "tenantId" | "scopes">) {
  const { account, accessToken: token } = result
  if (account && (!account.homeAccountId || account.homeAccountId !== stored.homeAccountId ||
    normalizeGuid(account.tenantId) !== normalizeGuid(tenantId))) throw new Error(adminRequired)
  if (result.tenantId && normalizeGuid(result.tenantId) !== normalizeGuid(tenantId)) throw new Error(adminRequired)
  const fallback = account?.localAccountId ? undefined : tokenActor(token)
  const userId = account?.localAccountId || fallback?.userId
  if (!userId) throw new Error(adminRequired)
  const identity = { tenantId: normalizeGuid(tenantId), clientId: normalizeGuid(stored.clientId), userId: normalizeGuid(userId) }
  const authorization = { ...(fallback ?? identity), scopes: result.scopes }
  requireRestoreActor(token, identity, authorization)
  return { ...identity, token, authorization, auditActor: { username: account?.username || userId, name: account?.name } }
}
