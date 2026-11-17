import type { RestoreActor } from "../../shared/intune/restore-guards"

/** The token comes from the main-process signed-in connection, never from a renderer request. */
export function requireRestoreActor(token: string, actor: RestoreActor): void {
  let claims: { scp?: unknown; oid?: unknown; tid?: unknown; appid?: unknown; azp?: unknown; idtyp?: unknown }
  try { claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) } catch { throw new Error("A signed-in admin is required for this restore.") }
  if (!claims || claims.idtyp === "app" || typeof claims.scp !== "string" || !claims.scp.trim() || typeof claims.oid !== "string" || typeof claims.tid !== "string" ||
    claims.oid.toLowerCase() !== actor.userId.toLowerCase() || claims.tid.toLowerCase() !== actor.tenantId.toLowerCase() ||
    String(claims.azp ?? claims.appid ?? "").toLowerCase() !== actor.clientId.toLowerCase()) throw new Error("A signed-in admin for this tenant and connection is required for this restore.")
}
