import type { ServicesStatus } from "../../shared/ipc"
import { INTUNE_TYPES } from "../../shared/intune/registry"
import { checkModules, moduleForFolder, MODULES } from "../../shared/services/modules"
import { grantedPermissions } from "../../shared/services/token"
import { optionalPermissionStatus, type OptionalPermissionStatus } from "../../shared/services/optional-permissions"
import type { ModuleSettings } from "./settings"

/** Services with at least one type TenuVault backs up in this version. */
const WITH_TYPES = new Set(INTUNE_TYPES.map((type) => moduleForFolder(type.folder)?.module.id))

/**
 * The tenant's service modules with what its app registration may do with each, from the Microsoft
 * Graph token TenuVault already holds. `refresh` asks for a new token, so permissions consented
 * since the last one show; without it the check costs no request at all.
 *
 * A service whose types are not part of this version yet is left out: it has nothing to back up and
 * no permissions to check, so listing it could only show a readiness it does not have.
 */
export async function servicesStatus(
  tenantId: string,
  settings: ModuleSettings,
  graphToken: (forceRefresh: boolean) => Promise<{ accessToken: string; expiresOn?: Date | null }>,
  refresh = false,
): Promise<ServicesStatus> {
  const enabled = settings.get(tenantId)
  const listed = MODULES.filter((module) => WITH_TYPES.has(module.id))
  let checks: ReturnType<typeof checkModules> | null = null
  let optional: OptionalPermissionStatus[] = optionalPermissionStatus(undefined)
  let checkedAt: string | null = null
  let error: string | undefined
  try {
    const token = await graphToken(refresh)
    const granted = grantedPermissions(token.accessToken)
    if (granted) {
      checks = checkModules(granted, listed)
      optional = optionalPermissionStatus(granted)
      checkedAt = issuedAt(token.accessToken) ?? new Date().toISOString()
    } else error = "The permissions in the Microsoft Graph token could not be read."
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }
  return {
    tenantId,
    checkedAt,
    optional,
    ...(error ? { error } : {}),
    modules: listed.map((module) => ({
      id: module.id,
      label: module.label,
      description: module.description,
      switchable: module.switchable,
      enabled: enabled[module.id].enabled,
      access: enabled[module.id].access,
      roles: module.roles,
      ...(module.restoreAccess ? { restoreAccess: { permissions: [...module.restoreAccess.permissions], newSetupSwitch: module.restoreAccess.newSetupSwitch } } : {}),
      check: checks?.find((check) => check.id === module.id) ?? null,
    })),
  }
}

/** The token's issue time (iat), so the page can say how current the check is. */
function issuedAt(token: string): string | undefined {
  try {
    const part = token.split(".")[1] ?? ""
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { iat?: unknown }
    return typeof claims.iat === "number" ? new Date(claims.iat * 1000).toISOString() : undefined
  } catch {
    return undefined
  }
}
