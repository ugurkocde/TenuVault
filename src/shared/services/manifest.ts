/**
 * The permission manifest: which Microsoft permissions a choice of services, areas and access levels
 * needs for a sign-in mode, and what a set of granted permissions lacks for it. Everything that
 * lists permissions takes them from here or is held to it by test/permission-parity.test.ts: the
 * setup in the app, both setup scripts, the Backup Reader, the handoff text and the docs tables.
 *
 * The permissions of each area are defined once, in ./modules. This file only reads them.
 */

import { MODULES, MODULE_BY_ID, meets, type AccessLevel, type GrantedPermissions, type ModuleId, type PermissionArea, type ServiceSelection, type SignInMode } from "./modules"
import { OPTIONAL_PERMISSIONS, type OptionalPermissionId } from "./optional-permissions"
import { GROUP_READ_PERMISSION } from "../group-access"

/** What a setup asks Microsoft for: the services to cover, each with its access level and the opt-in areas that are on. */
export type PermissionChoice = Partial<Record<ModuleId, { access: AccessLevel; areas?: readonly string[] }>>

/** The permissions of one Microsoft API. */
export interface ApiPermissions {
  api: string
  appId: string
  permissions: readonly string[]
}

export const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000"

/** What every sign-in needs, whatever is backed up: the admin's own profile and the organization's name and domains. */
export const BASE_PERMISSIONS: readonly string[] = ["User.Read", "Organization.Read.All"]

/** New desktop registrations also support group lookup. Existing registrations can add it separately. */
export const DESKTOP_BASE_PERMISSIONS: readonly string[] = [...BASE_PERMISSIONS, GROUP_READ_PERMISSION]

/** The Azure APIs a signed-in admin uses to pick a storage account and to read and write backups in it. */
const AZURE_APIS: readonly ApiPermissions[] = [
  { api: "Azure Service Management", appId: "797f4846-ba00-4fd7-ba43-dac1f8f63013", permissions: ["user_impersonation"] },
  { api: "Azure Storage", appId: "e406a681-f3d4-42a8-90b6-c2b029497af1", permissions: ["user_impersonation"] },
]

/**
 * The order services come in a permission list. It keeps Conditional Access policies before Intune
 * permissions in the default registration.
 */
export const REQUEST_ORDER: readonly ModuleId[] = ["conditionalAccess", "intune", "entra", "defender"]

/**
 * What a setup asks for when the admin makes no choice, as it always has: Intune with restore, and
 * reading Conditional Access, so that service can be turned on later without new consent.
 */
export const DEFAULT_SETUP_CHOICE: PermissionChoice = { intune: { access: "restore" }, conditionalAccess: { access: "backup" } }

/** What a Backup Reader reads when the admin makes no choice, as it always has: Intune. */
export const DEFAULT_READER_CHOICE: PermissionChoice = { intune: { access: "backup" } }

/** Whether a choice covers the area: every area that is not opt-in for the sign-in mode, and an opt-in one that is listed. */
function covers(area: PermissionArea, areas: readonly string[] | undefined, mode: SignInMode): boolean {
  return !(area.optIn || (mode === "application" && area.appOnlyOptIn)) || areas?.includes(area.id) === true
}

// Restore access must use the narrower permissions of the enabled operations. Backup reads keep their own requirements.
const NEVER_REQUESTED_FOR_RESTORE = new Set(["Organization.ReadWrite.All", "Directory.ReadWrite.All", "Directory.Read.All"])

/**
 * The permissions to add for an area, given the ones already `held`: for every group nothing held
 * satisfies, the first permission. Restore permissions are settled first, so a ReadWrite permission
 * stands in for its Read one instead of both being asked for. A restore permission that setup never
 * asks for is left out, so the area keeps its read permission.
 */
export function areaPermissions(area: PermissionArea, access: AccessLevel, mode: SignInMode, held: ReadonlySet<string> = new Set()): string[] {
  const added: string[] = []
  const settle = (needs: readonly PermissionArea["parts"][number]["backup"][], restore = false) => {
    for (const need of needs) {
      const needed = need[mode]
      if (needed === "unsupported") continue
      for (const group of needed) {
        if (restore && NEVER_REQUESTED_FOR_RESTORE.has(group[0]!)) continue
        if (!group.some((permission) => held.has(permission) || added.includes(permission))) added.push(group[0]!)
      }
    }
  }
  if (access === "restore") {
    const reads = area.restoreReview ? [{ delegated: area.restoreReview, application: "unsupported" } as const] : []
    settle([...reads, ...area.parts.filter((part) => !part.restoreNotRequested).map((part) => part.restore)], true)
  }
  settle(area.parts.map((part) => part.backup))
  return added
}

const unique = (values: readonly string[]) => [...new Set(values)]

/** The areas a choice covers, service by service in request order. */
function chosenAreas(choice: PermissionChoice, mode: SignInMode): { area: PermissionArea; access: AccessLevel }[] {
  return REQUEST_ORDER.flatMap((id) => {
    const picked = choice[id]
    return picked ? MODULE_BY_ID.get(id)!.areas.filter((area) => covers(area, picked.areas, mode)).map((area) => ({ area, access: picked.access })) : []
  })
}

/**
 * The permissions to ask Microsoft for, per API. A signed-in admin gets delegated permissions for
 * Microsoft Graph and the two Azure APIs; app-only access gets Microsoft Graph application
 * permissions and nothing else, because its storage access is an Azure role. `optional` adds
 * delegated permissions that single features need.
 *
 * Each area brings its own list, and a permission two areas share is asked for once. App-only
 * permissions are sorted by name, as the Backup Reader script has always listed them.
 */
export function requestedPermissions(choice: PermissionChoice, mode: SignInMode, optional: readonly OptionalPermissionId[] = []): ApiPermissions[] {
  const services = chosenAreas(choice, mode).flatMap(({ area, access }) => areaPermissions(area, access, mode))
  if (mode === "application") return [{ api: "Microsoft Graph", appId: GRAPH_APP_ID, permissions: unique(services).sort() }]
  const extra = OPTIONAL_PERMISSIONS.filter((entry) => optional.includes(entry.id)).flatMap((entry) => entry.permissions)
  return [{ api: "Microsoft Graph", appId: GRAPH_APP_ID, permissions: unique([...DESKTOP_BASE_PERMISSIONS, ...services, ...extra]) }, ...AZURE_APIS]
}

/** The Microsoft Graph permissions of a choice. */
export function graphPermissions(choice: PermissionChoice, mode: SignInMode, optional: readonly OptionalPermissionId[] = []): readonly string[] {
  return requestedPermissions(choice, mode, optional)[0]!.permissions
}

/** The first permission of every group of every area, for backup and restore: what TenuVault would name to grant. */
function namedByServices(mode: SignInMode): string[] {
  return unique(
    MODULES.flatMap((module) =>
      module.areas.flatMap((area) => [
        ...(mode === "delegated" ? area.restoreReview?.map(group => group[0]!) ?? [] : []),
        ...area.parts.flatMap((part) => [part.backup[mode], part.restore[mode]].flatMap((needed) => (needed === "unsupported" ? [] : needed.map((group) => group[0]!)))),
      ]),
    ),
  )
}

/**
 * Every permission the manifest can name for a sign-in mode, per API: what any choice asks for,
 * the restore permissions an admin adds by hand, and the optional ones. A permission outside it is
 * not TenuVault's.
 */
export function knownPermissions(mode: SignInMode): ApiPermissions[] {
  if (mode === "application") return [{ api: "Microsoft Graph", appId: GRAPH_APP_ID, permissions: namedByServices(mode) }]
  const graph = unique([...BASE_PERMISSIONS, ...namedByServices(mode), ...OPTIONAL_PERMISSIONS.flatMap((entry) => entry.permissions)])
  return [{ api: "Microsoft Graph", appId: GRAPH_APP_ID, permissions: graph }, ...AZURE_APIS]
}

/**
 * Whether tenant-wide consent for these delegated Microsoft Graph permissions shows that an
 * administrator approved a registration for TenuVault's work.
 *
 * For Intune, one of the Intune permissions a setup without choices asks for does. They are used
 * for Intune alone, and they are exactly what counted before services could be chosen: the read
 * permissions a default setup never asks for do not count, nor does the write permission for
 * managed devices.
 *
 * For Entra ID and Defender it takes more than half of what backing the service up asks for,
 * opt-in areas left out. A single permission of those services, such as User.Read.All or
 * Policy.Read.All, is something administrators grant to many apps, so it proves nothing; neither
 * do the permissions every sign-in has.
 *
 * A service that asks for fewer than three permissions of its own, which is Conditional Access,
 * has no "more than half" worth counting. For it, it takes everything a setup for that service
 * alone asks Microsoft Graph for to back it up: its own permission together with the ones every
 * sign-in has.
 */
export function showsApproval(consented: ReadonlySet<string>): boolean {
  const has = (permission: string) => consented.has(permission)
  return MODULES.some((module) => {
    const areas = module.areas.filter((area) => !area.optIn)
    if (module.id === "intune") return areas.flatMap((area) => areaPermissions(area, DEFAULT_SETUP_CHOICE.intune!.access, "delegated")).some(has)
    const own = (permissions: string[]) => unique(permissions).filter((permission) => !BASE_PERMISSIONS.includes(permission))
    const asked = own(areas.flatMap((area) => areaPermissions(area, "backup", "delegated")))
    if (asked.length < 3) return [...BASE_PERMISSIONS, ...asked].every(has)
    const lacking = own(areas.flatMap((area) => areaPermissions(area, "backup", "delegated", consented)))
    return (asked.length - lacking.length) * 2 > asked.length
  })
}

/** The Microsoft Graph permissions to add so the granted ones cover a choice; empty when they do. */
export function missingForChoice(choice: PermissionChoice, granted: GrantedPermissions): string[] {
  const base = granted.kind === "delegated" ? BASE_PERMISSIONS.filter((permission) => !granted.permissions.has(permission)) : []
  const held = new Set(granted.permissions)
  const missing = [...base]
  for (const { area, access } of chosenAreas(choice, granted.kind)) {
    for (const permission of areaPermissions(area, access, granted.kind, held)) {
      held.add(permission)
      missing.push(permission)
    }
  }
  // In the order a request for them would list them.
  return granted.kind === "application" ? missing.sort() : missing
}

/**
 * A choice that came from outside the main process, checked: at least one service, each a known
 * one with backup or restore as its access and only its own opt-in areas. Anything else is refused,
 * so a setup never asks for less or more than the admin was shown.
 */
export function checkedChoice(value: unknown): PermissionChoice {
  const invalid = () => new Error("Choose the services to set up, each with backup or restore as its access.")
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid()
  const choice: PermissionChoice = {}
  for (const [id, picked] of Object.entries(value)) {
    const module = MODULE_BY_ID.get(id as ModuleId)
    if (!module || !picked || typeof picked !== "object") throw invalid()
    const { access, areas } = picked as { access?: unknown; areas?: unknown }
    if (access !== "backup" && access !== "restore") throw invalid()
    if (areas !== undefined && (!Array.isArray(areas) || areas.some((area) => !module.areas.some((known) => known.optIn && known.id === area)))) throw invalid()
    choice[module.id] = { access, ...(areas ? { areas: [...(areas as string[])] } : {}) }
  }
  if (!Object.keys(choice).length) throw invalid()
  return choice
}

/** The name of a service in the setup scripts' -Services and -RestoreAccess parameters. */
export const SCRIPT_SERVICE: Readonly<Record<ModuleId, string>> = { intune: "Intune", conditionalAccess: "ConditionalAccess", entra: "Entra", defender: "Defender" }

/** The name of an opt-in area in the setup scripts' -Areas parameter. */
export const scriptArea = (id: string) => id.charAt(0).toUpperCase() + id.slice(1)

const sameChoice = (a: PermissionChoice, b: PermissionChoice) => JSON.stringify(sortedChoice(a)) === JSON.stringify(sortedChoice(b))
const sortedChoice = (choice: PermissionChoice) => MODULES.flatMap((module) => (choice[module.id] ? [[module.id, choice[module.id]!.access, [...(choice[module.id]!.areas ?? [])].sort()]] : []))

/** The opt-in areas of a choice as an -Areas parameter, or nothing. */
function areasArgument(choice: PermissionChoice): string {
  const areas = MODULES.flatMap((module) => module.areas.filter((area) => area.optIn && choice[module.id]?.areas?.includes(area.id)).map((area) => scriptArea(area.id)))
  return areas.length ? ` -Areas ${areas.join(",")}` : ""
}

/**
 * The parameters that make New-TenuVaultDesktopApp.ps1 ask for a choice, with a leading space; empty
 * for the choice the script makes by itself.
 */
export function setupScriptArguments(choice: PermissionChoice): string {
  if (sameChoice(choice, DEFAULT_SETUP_CHOICE)) return ""
  const services = MODULES.filter((module) => choice[module.id])
  const restore = services.filter((module) => choice[module.id]!.access === "restore").map((module) => SCRIPT_SERVICE[module.id])
  return ` -Services ${services.map((module) => SCRIPT_SERVICE[module.id]).join(",")} -RestoreAccess ${restore.join(",") || "None"}${areasArgument(choice)}`
}

/** The application permissions a Backup Reader gets for a choice. */
export function readerRoles(choice: PermissionChoice = DEFAULT_READER_CHOICE): readonly string[] {
  return graphPermissions(choice, "application")
}

/** Every application permission a Backup Reader may hold: the read permission of any area of any service. */
export const READER_ALLOWED_ROLES: ReadonlySet<string> = new Set(knownPermissions("application")[0]!.permissions)

/**
 * The application permissions a Backup Reader must hold for what the tenant backs up. A service
 * without a token pre-check reads every type without asking first, so all its permissions have to
 * be there; a service with one leaves out what the reader cannot read.
 */
export function readerRequiredRoles(selection: ServiceSelection): string[] {
  const areas = MODULES.filter((module) => !module.precheck && selection.services.includes(module.id)).flatMap((module) => module.areas.filter((area) => covers(area, undefined, "application")))
  return unique(areas.flatMap((area) => areaPermissions(area, "backup", "application"))).sort()
}

/**
 * Folders the tenant backs up that a Backup Reader with these roles cannot read: its permission is
 * missing, or Microsoft Graph lets only a signed-in admin read them. Folders of a service or opt-in
 * area that is off are not listed; no backup includes them.
 */
export function readerExcludedFolders(roles: readonly string[] | null, selection: ServiceSelection): string[] {
  const held = new Set(roles ?? [])
  return MODULES.filter((module) => selection.services.includes(module.id)).flatMap((module) =>
    module.areas
      .filter((area) => !area.optIn || selection.areas?.[module.id]?.includes(area.id))
      .flatMap((area) => area.parts.filter((part) => !meets(part.backup.application, held)).flatMap((part) => part.folders)),
  )
}

/** The choice a Backup Reader's roles amount to: every service whose permissions it holds in full, with the opt-in areas it holds. */
export function readerChoice(roles: readonly string[]): PermissionChoice {
  const held = new Set(roles)
  const holds = (area: PermissionArea) => {
    const needed = areaPermissions(area, "backup", "application")
    return needed.length > 0 && needed.every((role) => held.has(role))
  }
  const choice: PermissionChoice = {}
  for (const module of MODULES) {
    const always = module.areas.filter((area) => covers(area, undefined, "application"))
    if (!always.length || !always.every(holds)) continue
    const areas = module.areas.filter((area) => !covers(area, undefined, "application") && holds(area)).map((area) => area.id)
    choice[module.id] = { access: "backup", ...(areas.length ? { areas } : {}) }
  }
  return choice
}

/**
 * The parameters that make New-TenuVaultBackupReader.ps1 set exactly the roles a reader has, with a
 * leading space, so a renewal or another computer's certificate never changes its permissions. A
 * reader for Intune, with or without Conditional Access, keeps the switches it was set up with, and
 * a reader for whole services and areas names them.
 *
 * The script grants what it is given and removes every other role. Services and areas can only
 * name whole ones, so a reader that holds part of a service, a role next to its services, or no
 * role at all gets its roles named one by one. Organization.ReadWrite.All and Directory.ReadWrite.All
 * are never repeated in a renewal request.
 */
export function readerScriptArguments(roles: readonly string[]): string {
  const choice = readerChoice(roles)
  const held = MODULES.filter((module) => choice[module.id]).map((module) => module.id)
  const rolesOf = (id: ModuleId) => readerRoles({ [id]: choice[id] })
  // A service whose permissions another one brings along is not named: Entra ID reads everything Conditional Access needs.
  const services = held.filter((id) => !rolesOf(id).every((role) => held.some((other) => other !== id && rolesOf(other).includes(role))))
  const exact = unique(roles.filter((role) => role !== "Organization.ReadWrite.All" && role !== "Directory.ReadWrite.All")).sort()
  const named = new Set(services.flatMap(rolesOf))
  if (!services.length || named.size !== exact.length || !exact.every((role) => named.has(role))) return ` -Permissions ${exact.join(",") || "None"}`
  const inventory = choice.intune?.areas?.includes("devices") ? " -IncludeDeviceCategories" : ""
  if (services[0] === "intune" && services.every((id) => id === "intune" || id === "conditionalAccess")) return `${inventory}${choice.conditionalAccess ? " -IncludeConditionalAccess" : ""}`
  return ` -Services ${services.map((id) => SCRIPT_SERVICE[id]).join(",")}${areasArgument(choice)}${inventory}`
}

/**
 * The parameters for the first setup of a tenant's Backup Reader, with a leading space: the
 * services the tenant backs up. A tenant with Intune, with or without Conditional Access, gets none,
 * so its reader starts with the five Intune permissions as before and Conditional Access stays a
 * permission the admins agree on. Opt-in areas are never added by themselves.
 */
export function readerSetupArguments(selection: ServiceSelection): string {
  const on = MODULES.filter((module) => selection.services.includes(module.id) && module.areas.some((area) => area.folders.length)).map((module) => module.id)
  if (!on.length || (on[0] === "intune" && on.every((id) => id === "intune" || id === "conditionalAccess"))) return ""
  return ` -Services ${on.map((id) => SCRIPT_SERVICE[id]).join(",")}`
}
