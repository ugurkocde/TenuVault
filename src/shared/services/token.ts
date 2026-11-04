import type { GrantedPermissions } from "./modules"

/**
 * The permissions an access token carries, read from its claims without verifying it: delegated
 * tokens list scopes in `scp` (space separated), app-only tokens list application permissions in
 * `roles`. Only used to tell the admin what is missing and to stop a write that Microsoft would
 * refuse; Microsoft Graph still enforces every permission itself. Undefined when the token cannot
 * be read, so a check that cannot run never blocks anything.
 */
export function grantedPermissions(token: string | undefined): GrantedPermissions | undefined {
  if (!token) return undefined
  const part = token.split(".")[1]
  if (!part) return undefined
  let claims: unknown
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    claims = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
  if (!claims || typeof claims !== "object") return undefined
  const { scp, roles } = claims as { scp?: unknown; roles?: unknown }
  if (typeof scp === "string") return { kind: "delegated", permissions: new Set(scp.split(" ").filter(Boolean)) }
  if (Array.isArray(roles)) return { kind: "application", permissions: new Set(roles.filter((role): role is string => typeof role === "string")) }
  return undefined
}
