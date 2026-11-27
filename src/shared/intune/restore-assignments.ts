import { GROUP_CHECK_GUIDANCE, GROUP_CHECK_REQUIRED } from "../group-access"
import type { GroupState } from "./group-reads"
import type { Mapping, ReferenceKind, ReferenceResolution } from "./reference-mapping"
import { resolveReferences, usableReference } from "./reference-mapping"
import { isGraphId, isGuid } from "../security"
import { assignmentsUnread } from "./read"
import type { IntuneType, Item, Json } from "./registry"

export type AssignmentKind = Extract<ReferenceKind, "group" | "filter" | "scopeTag">
export type ReferenceNames = Partial<Record<AssignmentKind, Map<string, string> | null>>
export interface AssignmentReview {
  references: ReferenceResolution[]
  assignments: Array<{ key: string; index: number; references: ReferenceResolution[]; skipped: boolean; blocked: boolean; label: string }>
  errors: string[]
  warnings: string[]
  allAssignmentsSkipped: boolean
}

export const referenceKey = (kind: ReferenceKind, id: string) => `${kind}:${id.toLowerCase()}`

function kindOf(key: string, role = false): AssignmentKind | undefined {
  if (role && ["members", "scopeMembers", "resourceScopes"].includes(key)) return "group"
  switch (key) {
    case "groupId": return "group"
    case "deviceAndAppManagementAssignmentFilterId": return "filter"
    case "roleScopeTagIds":
    case "roleScopeTags": return "scopeTag"
  }
}

/** Walk only the reference properties of a restore assignment or the policy's scope tag lists. */
function rewrite(value: Json, resolve: (kind: AssignmentKind, id: string) => string, key = "", role = false): Json {
  if (Array.isArray(value)) return value.map((entry) => rewrite(entry, resolve, key, role))
  if (value && typeof value === "object") {
    const scopeTagTarget = isScopeTagGroupTarget(value)
    const entries = Object.entries(value).map(([field, entry]) => [
      field, rewrite(entry, resolve, scopeTagTarget && field === "entraObjectId" ? "groupId" : field, role),
    ])
    return Object.fromEntries(entries)
  }
  const kind = kindOf(key, role)
  return kind && typeof value === "string" && value ? resolve(kind, value) : value
}

const tags = ["roleScopeTagIds", "roleScopeTags"] as const

export function isScopeTagGroupTarget(target: Item): boolean {
  return /(?:^|\.)scopeTagGroupAssignmentTarget$/i.test(String(target["@odata.type"] ?? ""))
}

export const LEGACY_SCOPE_TAG_ASSIGNMENT_WARNING = "This scope tag's assignment is stored in an older format and is not restored. Assign it in Intune."

export function isLegacyScopeTagAssignment(type: IntuneType, entry: Json): boolean {
  return type.folder === "ScopeTags" && entry !== null && typeof entry === "object" && !Array.isArray(entry) && entry.target === undefined &&
    (Array.isArray(entry.members) || Array.isArray(entry.scopeMembers))
}

export function hasLegacyScopeTagAssignments(type: IntuneType, snapshot: Item): boolean {
  return type.folder === "ScopeTags" && Array.isArray(snapshot.assignments) && snapshot.assignments.some(
    (entry) => isLegacyScopeTagAssignment(type, entry),
  )
}

function directRows(type: IntuneType, snapshot: Item) {
  const role = type.folder === "RoleDefinitions"
  if (assignmentsUnread(type, snapshot) || (!type.assign && !role && type.folder !== "PolicySets")) return []
  const value = snapshot[role ? "roleAssignments" : "assignments"]
  if (!Array.isArray(value)) return []
  return value.flatMap<{ index: number; entry: Item | null; role: boolean }>((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [{ index, entry: null, role }]
    if (isLegacyScopeTagAssignment(type, entry)) return []
    if (!role && typeof entry.source === "string" && entry.source !== "direct" && type.folder !== "PolicySets") return []
    const target = entry.target as Item | undefined
    if (type.exclusionsUnsupported && String(target?.["@odata.type"] ?? "").toLowerCase().includes("exclusion")) return []
    if (!target || typeof target !== "object" || Array.isArray(target)) return [{ index, entry, role }]
    const { groupName: _name, deviceAndAppManagementAssignmentFilterId, ...rest } = target
    const activeFilter = target.deviceAndAppManagementAssignmentFilterType !== "none" && deviceAndAppManagementAssignmentFilterId !== undefined
    return [{ index, entry: { ...entry, target: { ...rest, ...(activeFilter ? { deviceAndAppManagementAssignmentFilterId } : {}) } }, role }]
  })
}

/** IDs and optional backup names, in order, for the references the restore can write. */
export function restoreReferences(type: IntuneType, snapshot: Item) {
  const references = new Map<string, { kind: AssignmentKind; sourceId: string; name?: string }>()
  const add = (kind: AssignmentKind, id: string) => {
    const key = referenceKey(kind, id)
    if (!references.has(key)) references.set(key, { kind, sourceId: id })
    return id
  }
  for (const key of tags) if (Array.isArray(snapshot[key])) rewrite(snapshot[key], add, key)
  for (const { entry, index, role } of directRows(type, snapshot)) {
    if (!entry) continue
    rewrite(entry, add, "", role)
    const target = (Array.isArray(snapshot.assignments) ? (snapshot.assignments[index] as Item)?.target : undefined) as Item | undefined
    if (typeof target?.groupId === "string" && typeof target.groupName === "string") {
      const reference = references.get(referenceKey("group", target.groupId))
      if (reference) reference.name = target.groupName
    }
  }
  return [...references.values()]
}

export function resolveRestoreAssignments(type: IntuneType, snapshot: Item, input: {
  sameTenant: boolean
  mappings: Mapping[]
  skipped: ReadonlySet<string>
  sourceNames: ReferenceNames
  targetObjects: ReferenceNames
  groupStates: ReadonlyMap<string, GroupState>
}): { snapshot: Item; review: AssignmentReview } {
  const references = restoreReferences(type, snapshot)
  const sourceNames: Partial<Record<AssignmentKind, Map<string, string>>> = {}
  for (const { kind, sourceId, name } of references) {
    const names = sourceNames[kind] ??= new Map()
    const label = input.sourceNames[kind]?.get(sourceId.toLowerCase()) ?? name
    if (label) names.set(sourceId.toLowerCase(), label)
  }
  const resolutions = resolveReferences(references, {
    ...input,
    sourceNames,
  })
  const byKey = new Map(resolutions.map((reference) => [referenceKey(reference.kind, reference.sourceId), reference]))
  const errors: string[] = []
  const unverified = new Set<ReferenceResolution>()
  const uses = new Set<ReferenceResolution>()
  const canUse = (reference: ReferenceResolution) =>
    usableReference(reference, input.sameTenant && reference.targetId?.toLowerCase() === reference.sourceId.toLowerCase())
  let invalidTargetId = false
  const translate = (kind: AssignmentKind, id: string) => {
    const reference = byKey.get(referenceKey(kind, id))!
    uses.add(reference)
    if (!canUse(reference) || !reference.targetId) return id
    if (kind === "group" ? isGuid(reference.targetId) : isGraphId(reference.targetId)) return reference.targetId
    invalidTargetId = true
    return id
  }

  const next = { ...snapshot }
  for (const key of tags) {
    const value = snapshot[key]
    if (!Array.isArray(value)) continue
    uses.clear()
    invalidTargetId = false
    const mapped = rewrite(value, translate, key) as Json[]
    if (invalidTargetId || mapped.some((tag) => !isGraphId(tag)) || [...uses].some((reference) => !canUse(reference))) errors.push("Map each unresolved scope tag before restoring. Choose Default if appropriate.")
    for (const reference of uses) if (reference.state === "mapped-unverified") unverified.add(reference)
    next[key] = [...new Set(mapped)]
  }

  const property = type.folder === "RoleDefinitions" ? "roleAssignments" : "assignments"
  const rows = snapshot[property]
  if (rows !== undefined && !Array.isArray(rows)) errors.push("The backup does not contain a valid assignment list.")
  const assignments: AssignmentReview["assignments"] = []
  const replacements = new Map<number, Item | null>()
  for (const { entry, index, role } of directRows(type, snapshot)) {
    uses.clear()
    invalidTargetId = false
    const mapped = entry ? rewrite(entry, translate, "", role) as Item : null
    const key = String(index)
    const skipped = input.sameTenant && input.skipped.has(key)
    const unreadableGroup = [...uses].some((reference) => reference.kind === "group" && reference.state === "mapped-unverified" && !canUse(reference))
    const unresolved = [...uses].some((reference) => !canUse(reference))
    const target = entry?.target as Item | undefined
    const invalid = invalidTargetId || !entry || (!role && (!target || typeof target["@odata.type"] !== "string" ||
      (/(?:^|\.)(?:exclusion)?groupAssignmentTarget$/i.test(target["@odata.type"]) && !isGuid(target.groupId)) ||
      (isScopeTagGroupTarget(target) && !isGuid(target.entraObjectId)) ||
      (typeof target.deviceAndAppManagementAssignmentFilterType === "string" &&
        !["", "none"].includes(target.deviceAndAppManagementAssignmentFilterType) &&
        !isGuid(target.deviceAndAppManagementAssignmentFilterId))))
    const blocked = !skipped && (unresolved || invalid)
    if (blocked && unreadableGroup) errors.push(GROUP_CHECK_REQUIRED)
    else if (blocked) errors.push(`Assignment ${index + 1} has a missing or invalid target. Confirm a mapping${input.sameTenant ? " or skip the assignment" : ""}.`)
    if (!skipped) for (const reference of uses) if (reference.state === "mapped-unverified" && canUse(reference)) unverified.add(reference)
    if (unresolved || invalid || skipped || [...uses].some((reference) => reference.state === "mapped-unverified")) assignments.push({
      key, index, references: [...uses], skipped, blocked,
      label: role ? (typeof entry?.displayName === "string" ? entry.displayName : "Role assignment")
        : /exclusion/i.test(String(target?.["@odata.type"] ?? "")) ? "Excluded group" : "Included target",
    })
    replacements.set(index, skipped ? null : mapped)
  }
  const legacySkipped = hasLegacyScopeTagAssignments(type, snapshot)
  if (Array.isArray(rows) && (replacements.size || legacySkipped)) {
    next[property] = rows.flatMap((entry, index) => replacements.has(index) ? replacements.get(index) ?? [] : [entry])
      .filter((entry) => !isLegacyScopeTagAssignment(type, entry))
  }
  const allAssignmentsSkipped = (legacySkipped || replacements.size > 0) && assignments.filter((entry) => entry.skipped).length === replacements.size
  const warnings = [...unverified].map((reference) => reference.kind === "group"
    ? `${GROUP_CHECK_GUIDANCE} Restore will use the original group ID ${reference.targetId}.`
    : `Could not verify ${reference.kind === "scopeTag" ? "scope tag" : reference.kind} ${reference.targetName ?? reference.targetId} in the destination. Restore will use this ID.`)
  if (legacySkipped) warnings.push(LEGACY_SCOPE_TAG_ASSIGNMENT_WARNING)
  return { snapshot: next, review: { references: resolutions, assignments, errors: [...new Set(errors)], warnings, allAssignmentsSkipped } }
}
