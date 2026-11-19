import type { RestoreProtection } from "./restore-matrix"
import type { Item, Json } from "./registry"

export class RestoreSafetyError extends Error {}
/** No send is outstanding: cancellation occurred before sending or after a definite throttle. */
export class RestoreWriteDeferredError extends RestoreSafetyError {}
export class RestoreWriteRefusedError extends RestoreSafetyError {
  constructor(status: number) { super(`Microsoft Graph refused this write (${status}). Review restore access in Services in Settings and preview this item again.`) }
}

export type RestoreOrigin = "restore" | "repair" | "drift" | "sync" | "import" | "cross-tenant"
export interface RestoreActor {
  tenantId: string
  userId: string
  clientId: string
  applicationObjectId?: string
  servicePrincipalId?: string
  recoveryAccountIds: string[]
}
export interface SafetyReferences {
  /** All affected principals, including indirect membership and ownership, resolved by the reader. */
  principals: string[]
  applications: string[]
  complete: boolean
  /** Remaining effective holders after this item, including group and eligible assignments. */
  remainingAdministrators?: { global: string[]; privilegedRole: string[] }
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const assignments = new Set(["EntraRoleAssignments", "DefenderRoleAssignments", "RoleEligibilitySchedules", "RoleAssignmentSchedules", "PimGroupEligibilitySchedules", "PimGroupAssignmentSchedules"])

/** These restrictions remain in force even when a later layer enables a type. */
export function restoreOriginBlocker(folder: string, origin: RestoreOrigin): string | undefined {
  if (origin === "import" && (assignments.has(folder) || folder === "OAuth2PermissionGrants")) return "Role assignments and consent grants from imported backups are never restored."
  if (origin === "cross-tenant") return "Entra ID and Defender policies and directory objects cannot be copied to another tenant in this release."
  return undefined
}

/** Unresolved protection evidence is a refusal, never permission to proceed. */
export function guardRestoreItem(actor: RestoreActor, folder: string, id: string | undefined, references: SafetyReferences, removes: boolean, protections: readonly RestoreProtection[] = ["identity-references", "remaining-administrators"]): void {
  if (!actor.tenantId || !actor.userId || !actor.clientId || (protections.length > 0 && (!actor.applicationObjectId || !actor.servicePrincipalId)) || !Array.isArray(actor.recoveryAccountIds) || !references.complete) throw new RestoreSafetyError("A safety reference could not be resolved. This item was blocked.")
  const protectedPrincipals = [actor.userId, actor.servicePrincipalId, ...actor.recoveryAccountIds].filter((id): id is string => !!id)
  const targets = [...references.principals, ...(id && ["Users", "ServicePrincipals"].includes(folder) ? [id] : [])]
  if (targets.some(target => protectedPrincipals.some(protectedId => !!protectedId && same(target, protectedId)))) throw new RestoreSafetyError("The signed-in admin, TenuVault connection and recovery accounts are protected, including their roles and authentication methods.")
  const apps = [...references.applications, ...(id && folder === "Applications" ? [id] : [])]
  if (apps.some(target => [actor.clientId, actor.applicationObjectId, actor.servicePrincipalId].some(protectedId => !!protectedId && same(target, protectedId)))) throw new RestoreSafetyError("The TenuVault app registration and enterprise app are protected.")
  if (protections.includes("remaining-administrators") && removes && (assignments.has(folder) || folder === "Groups" || folder === "AdministrativeUnits")) {
    const remaining = references.remainingAdministrators
    if (!remaining?.global.length || !remaining.privilegedRole.length) throw new RestoreSafetyError("Removing the last Global Administrator or Privileged Role Administrator is refused, including when their remaining access cannot be verified.")
  }
}

/** Collections retain live entries unless this particular item has explicit removal approval. */
export function addsOnly(current: Json[], desired: Json[], allowRemoval = false): Json[] {
  if (allowRemoval) return structuredClone(desired)
  const key = (value: Json): string => {
    if (Array.isArray(value)) return JSON.stringify(value.map(key))
    if (value && typeof value === "object") return JSON.stringify(Object.keys(value).sort().map(k => [k, key(value[k]!)]))
    return JSON.stringify(value)
  }
  const merged = new Map(current.map(value => [key(value), value]))
  for (const value of desired) merged.set(key(value), value)
  return structuredClone([...merged.values()])
}
export function mergeConsentScopes(current: string, desired: string, allowRemoval = false): string {
  return (addsOnly(current.split(/\s+/).filter(Boolean), desired.split(/\s+/).filter(Boolean), allowRemoval) as string[]).sort().join(" ")
}

/** Projects the captured live state onto the same closed payload schema used by the write. */
export function writableSnapshot(current: Item, properties: readonly string[]): Item {
  return Object.fromEntries(properties.filter(key => key in current).map(key => [key, structuredClone(current[key]!)]))
}

/** Every array in a new-service payload uses adds-only behavior, even if a caller omits a hint. */
export function addsOnlyPayload(current: Item | null, desired: Item, allowRemoval = false): Item {
  if (allowRemoval) return structuredClone(desired)
  const walk = (live: Json | undefined, proposed: Json): Json => {
    if (Array.isArray(live)) {
      if (!Array.isArray(proposed)) throw new RestoreSafetyError("Removing a collection needs an explicit choice for this item.")
      return addsOnly(live, proposed)
    }
    if (proposed && typeof proposed === "object" && !Array.isArray(proposed)) {
      const object = live && typeof live === "object" && !Array.isArray(live) ? live : {}
      return Object.fromEntries(Object.entries(proposed).map(([key, value]) => [key, walk(object[key], value)]))
    }
    if (live && typeof live === "object" && !Array.isArray(live) && proposed === null) {
      const containsArray = (value: Json): boolean => Array.isArray(value) || (!!value && typeof value === "object" && Object.values(value).some(containsArray))
      if (containsArray(live)) throw new RestoreSafetyError("Removing collection entries needs an explicit choice for this item.")
    }
    return structuredClone(proposed)
  }
  return walk(current ?? undefined, desired) as Item
}
