import { GROUP_READ_PERMISSION } from "../group-access"
import { BASE_PERMISSIONS, GRAPH_APP_ID, type PermissionChoice } from "./manifest"
import { MODULE_BY_ID, type AccessLevel, type ModuleId, type Requirement } from "./modules"
import { OPTIONAL_PERMISSIONS } from "./optional-permissions"

export const PACK_RESOURCES = {
  graph: { audience: "https://graph.microsoft.com", appId: GRAPH_APP_ID, label: "Microsoft Graph" },
  // The ARM audience includes a trailing slash, even before the scope delimiter.
  management: { audience: "https://management.azure.com/", appId: "797f4846-ba00-4fd7-ba43-dac1f8f63013", label: "Azure Service Management" },
  storage: { audience: "https://storage.azure.com", appId: "e406a681-f3d4-42a8-90b6-c2b029497af1", label: "Azure Storage" },
} as const

export type PackResource = keyof typeof PACK_RESOURCES
export interface PermissionPack {
  id: string
  label: string
  resource: PackResource
  scopes: string[]
}

const IDENTITY_SCOPES = ["openid", "profile", "offline_access"]
const SERVICES = ["defender", "entra", "intune", "conditionalAccess"] as const
const SERVICE_EXTRAS: Partial<Record<ModuleId, string[]>> = { intune: [GROUP_READ_PERMISSION] }
const PRIVILEGED_WRITES = [
  "Application.ReadWrite.All", "AppRoleAssignment.ReadWrite.All", "DelegatedPermissionGrant.ReadWrite.All",
  "RoleManagement.ReadWrite.Directory", "RoleEligibilitySchedule.ReadWrite.Directory", "RoleAssignmentSchedule.ReadWrite.Directory",
  "PrivilegedEligibilitySchedule.ReadWrite.AzureADGroup", "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup",
  "AdministrativeUnit.ReadWrite.All",
]
const EXCLUDED = new Set(["Organization.ReadWrite.All", "Directory.ReadWrite.All", ...PRIVILEGED_WRITES])
export const isPackWriteScope = (scope: string) => /ReadWrite|\.Create\b|\.ReadUpdate\b/.test(scope)
const unique = (scopes: string[]) => [...new Set(scopes)]

/** Every group requires one of its alternatives. Select the fewest additional scopes. */
export function minimumScopes(requirements: Requirement, held: ReadonlySet<string> = new Set()): string[] {
  const groups = requirements.filter(group => !group.some(scope => held.has(scope)))
  if (groups.some(group => !group.length)) throw new Error("A permission pack has an uncovered requirement.")
  const forced = unique(groups.filter(group => group.length === 1).flat())
  const remaining = groups.filter(group => !group.some(scope => forced.includes(scope)))
  if (!remaining.length) return forced

  // Solve independent groups separately so unrelated alternatives never multiply the search.
  const component = new Set([remaining[0]!])
  const candidates = new Set(remaining[0]!)
  for (let size = 0; size !== candidates.size;) {
    size = candidates.size
    for (const group of remaining) {
      if (!group.some(scope => candidates.has(scope))) continue
      component.add(group)
      for (const scope of group) candidates.add(scope)
    }
  }
  const pivot = [...component].sort((a, b) => a.length - b.length)[0]!
  let best: string[] | undefined
  for (const scope of pivot) {
    const rest = minimumScopes([...component].filter(group => !group.includes(scope)))
    if (!best || rest.length + 1 < best.length) best = [scope, ...rest]
  }
  return [...forced, ...best!, ...minimumScopes(remaining.filter(group => !component.has(group)))]
}

export function servicePack(id: ModuleId, access: AccessLevel, optedIn: readonly string[] = []): PermissionPack {
  const module = MODULE_BY_ID.get(id)!
  const areas = module.areas.filter(area => !area.optIn || optedIn.includes(area.id))
  const parts = areas.flatMap(area => area.parts)
  const restores = access === "restore" ? [
    ...areas.flatMap(area => area.restoreReview ?? []),
    ...parts.flatMap(part => part.restoreNotRequested || part.restore.delegated === "unsupported" ? [] : part.restore.delegated),
  ].map(group => group.filter(scope => !EXCLUDED.has(scope))).filter(group => group.length > 0) : []
  const reads = parts.flatMap(part => part.backup.delegated === "unsupported" ? [] : part.backup.delegated)
  // A write scope may replace its read alternative only when an operation calls for it.
  const eligibleWrites = new Set(restores.filter(group => group.every(isPackWriteScope)).flat())
  const requirements = [
    ...restores.map(group => group.filter(scope => !isPackWriteScope(scope) || eligibleWrites.has(scope))),
    ...reads.map(group => group.filter(scope => !EXCLUDED.has(scope) && (!isPackWriteScope(scope) || eligibleWrites.has(scope)))),
    ...(SERVICE_EXTRAS[id] ?? []).map(scope => [scope]),
  ]
  return {
    id: `${id}-${access}`,
    label: `${module.label} ${access === "backup" ? "backup" : "restore"}`,
    resource: "graph",
    scopes: minimumScopes(requirements, new Set(BASE_PERMISSIONS)).sort(),
  }
}

export const PRIVILEGED_ENTRA_PACK: PermissionPack = {
  id: "entra-privileged", label: "Privileged Entra restore", resource: "graph", scopes: PRIVILEGED_WRITES,
}

export function tenantPermissionPacks(choice: PermissionChoice, features: { azure: boolean; audit: boolean }): PermissionPack[] {
  return [
    { id: "basics", label: "Basics", resource: "graph", scopes: [...IDENTITY_SCOPES, ...BASE_PERMISSIONS] },
    ...SERVICES.flatMap(id => {
      const picked = choice[id]
      return picked ? [servicePack(id, picked.access, picked.areas)] : []
    }),
    ...(features.azure ? (["management", "storage"] as const).map(resource => ({
      id: resource, label: PACK_RESOURCES[resource].label, resource, scopes: ["user_impersonation"],
    })) : []),
    ...(features.audit ? [{
      id: "audit", label: "Audit log", resource: "graph" as const,
      scopes: [...OPTIONAL_PERMISSIONS.find(permission => permission.id === "conditionalAccessWatching")!.permissions],
    }] : []),
  ]
}

export function resourcePackScopes(packs: readonly PermissionPack[], resource: PackResource): string[] {
  return unique(packs.filter(pack => pack.resource === resource).flatMap(pack => pack.scopes))
}

export function resourceScopes(resource: PackResource, scopes: readonly string[]): string[] {
  return scopes.map(scope => IDENTITY_SCOPES.includes(scope) ? scope : `${PACK_RESOURCES[resource].audience}/${scope}`)
}

export function missingPackScopes(scopes: readonly string[], granted: ReadonlySet<string>): string[] {
  // OIDC scopes govern ID and refresh tokens, and do not reliably appear in access-token scp.
  return scopes.filter(scope => !IDENTITY_SCOPES.includes(scope) && !granted.has(scope))
}

/** Check against the same catalog used for the consent UI, including the optional Entra areas. */
export function permissionPackTable(published: Readonly<Record<PackResource, Readonly<Record<string, string>>>>): string {
  const table = ["| Pack | Resource | Delegated scopes and IDs |", "| --- | --- | --- |"]
  const row = (pack: PermissionPack) => {
    const scopes = pack.scopes.map(scope => {
      const id = published[pack.resource][scope]
      if (!id) throw new Error(`Resolve the delegated ID for ${scope} on ${pack.resource}.`)
      return `\`${scope}\` (\`${id}\`)`
    })
    table.push(`| ${pack.label} | ${PACK_RESOURCES[pack.resource].label} | ${scopes.join("<br />") || "None"} |`)
  }
  for (const pack of [
    ...tenantPermissionPacks({ defender: { access: "backup" }, entra: { access: "backup" }, intune: { access: "backup" }, conditionalAccess: { access: "backup" } }, { azure: true, audit: true }),
    ...SERVICES.map(id => servicePack(id, "restore")),
    PRIVILEGED_ENTRA_PACK,
  ]) row(pack)
  for (const area of MODULE_BY_ID.get("entra")!.areas.filter(area => area.optIn)) {
    for (const access of ["backup", "restore"] as const) {
      const base = servicePack("entra", access)
      const selected = servicePack("entra", access, [area.id])
      row({ ...selected, label: `${selected.label} with ${area.label.toLowerCase()} enabled (additional)`, scopes: selected.scopes.filter(scope => !base.scopes.includes(scope)) })
    }
  }
  return table.join("\n")
}
