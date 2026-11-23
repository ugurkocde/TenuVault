import { READ_ONLY_REGISTRATION_MESSAGE } from "../app-registration"
import { READER_REQUIRED_ROLES } from "./backup-permissions"
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
  if (typeof scp === "string") return { kind: "delegated", permissions: new Set(scp.split(/\s+/).filter(Boolean)) }
  if (Array.isArray(roles)) return { kind: "application", permissions: new Set(roles.filter((role): role is string => typeof role === "string")) }
  return undefined
}


export function isTenantWriteScope(scope: string): boolean {
  return /^(DeviceManagement[^.]*|Policy)\.ReadWrite\./i.test(scope)
}

/** Classify delegated .default tokens. A token requested for specific scopes can omit consented writes. */
export function isReadOnlyRegistration(granted: GrantedPermissions | undefined): boolean {
  if (granted?.kind !== "delegated") return false
  const scopes = granted.permissions
  return READER_REQUIRED_ROLES.some(scope => scopes.has(scope))
    && ![...scopes].some(isTenantWriteScope)
}

export class ReadOnlyRegistrationError extends Error {
  readonly status = 409

  constructor() {
    super(READ_ONLY_REGISTRATION_MESSAGE)
  }
}

/** Fail before preparing a write when the workflow already has the Graph token. */
export function requireWritableRegistration(token: string): void {
  if (isReadOnlyRegistration(grantedPermissions(token))) {
    throw new ReadOnlyRegistrationError()
  }
}
