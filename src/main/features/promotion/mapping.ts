import { GROUP_CHECK_REQUIRED } from "../../../shared/group-access"
import { usableReference, type Mapping, type ReferenceKind, type ReferenceResolution } from "../../../shared/intune/reference-mapping"
import type { IntuneType, Item, Json } from "../../../shared/intune/registry"
import { cleanAssignment } from "../../../shared/intune/registry"
import { isGraphId } from "../../../shared/security"
import { containsRedaction, containsSecret } from "../change-sets/model"

/**
 * Pure model of promotion target resolution (#145): which tenant-specific references a
 * Settings Catalog policy carries and how reviewed mappings translate them into
 * destination-tenant objects. No Electron, no network.
 *
 * Rules: source GUIDs are never replayed into another tenant; a display-name match is only a
 * suggestion until the admin confirms the mapping; exclusions stay exclusions (or are
 * dropped explicitly), never includes; filter types are preserved exactly.
 */

export { resolveReferences, type Mapping, type ReferenceKind, type ReferenceResolution } from "../../../shared/intune/reference-mapping"

export interface DependencyFinding {
  code: "missing-mapping" | "rejected-mapping" | "unsupported-type" | "unsupported-target" | "ordering" | "unknown-membership" | "exclusion-unsupported" | "exclusion-dropped" | "display-name-only" | "assignments-excluded" | "secret-values" | "scope-tags-kept" | "scope-tag-default" | "sync-link-missing" | "sync-unconfirmed"
  severity: "blocking" | "warning" | "info"
  message: string
}

/** What the destination reads must stay the same for a plan to remain valid. */
export interface TargetReads {
  /** The destination policy to update; its content is checked by the change set's target fingerprint. */
  policyId: string | null
  /** Registry folder for re-checking the destination tags frozen into an update. */
  policyFolder?: string
  /** Re-plan if secrets appear in a destination whose plan did not acknowledge them. */
  requireUnredacted?: boolean
  filterIds: string[]
  scopeTagIds: string[]
  reusableSettingIds: string[]
  groupIds: string[]
}

const REFERENCE_VALUE = "#microsoft.graph.deviceManagementConfigurationReferenceSettingValue"
const SECRET_VALUE = /SecretSettingValue$/i

const TARGET_KINDS: Record<string, { target: "group" | "allDevices" | "allLicensedUsers"; intent: "include" | "exclude" }> = {
  "#microsoft.graph.groupassignmenttarget": { target: "group", intent: "include" },
  "#microsoft.graph.exclusiongroupassignmenttarget": { target: "group", intent: "exclude" },
  "#microsoft.graph.alldevicesassignmenttarget": { target: "allDevices", intent: "include" },
  "#microsoft.graph.alllicensedusersassignmenttarget": { target: "allLicensedUsers", intent: "include" },
}

const str = (value: Json | undefined): string | null => (typeof value === "string" && value ? value : null)

/** Walks every object in a JSON value. */
function visit(value: Json, callback: (object: Item) => void): void {
  if (Array.isArray(value)) return value.forEach((entry) => visit(entry, callback))
  if (!value || typeof value !== "object") return
  callback(value)
  for (const entry of Object.values(value)) visit(entry, callback)
}

/** Direct assignments only: assignments inherited from a policy set come back with the set. */
export function directAssignments(snapshot: Item | null): Item[] {
  return (Array.isArray(snapshot?.assignments) ? (snapshot!.assignments as Item[]) : []).filter((assignment) => typeof assignment.source !== "string" || assignment.source === "direct")
}

/** Every tenant-specific reference in a Settings Catalog snapshot, deduplicated. */
export function extractReferences(snapshot: Item, includeAssignments: boolean): Array<{ kind: ReferenceKind; sourceId: string }> {
  const found = new Map<string, { kind: ReferenceKind; sourceId: string }>()
  const add = (kind: ReferenceKind, id: string | null) => {
    if (id) found.set(`${kind}:${id.toLowerCase()}`, { kind, sourceId: id })
  }
  for (const tag of Array.isArray(snapshot.roleScopeTagIds) ? snapshot.roleScopeTagIds : []) add("scopeTag", str(tag))
  visit(snapshot.settings ?? null, (object) => {
    if (object["@odata.type"] === REFERENCE_VALUE) add("reusableSetting", str(object.value))
  })
  if (includeAssignments) {
    for (const assignment of directAssignments(snapshot)) {
      const target = (assignment.target ?? {}) as Item
      add("group", str(target.groupId))
      const filterType = str(target.deviceAndAppManagementAssignmentFilterType)
      if (filterType && filterType !== "none") add("filter", str(target.deviceAndAppManagementAssignmentFilterId))
    }
  }
  return [...found.values()]
}

/** Whether the snapshot carries Settings Catalog secret values, which cannot be copied. */
export function hasSecretValues(snapshot: Item): boolean {
  let found = false
  visit(snapshot.settings ?? null, (object) => {
    if (typeof object["@odata.type"] === "string" && SECRET_VALUE.test(object["@odata.type"])) found = true
  })
  return found
}

/** Findings about references: missing, rejected, name-only suggestions and ordering prerequisites. */
export function referenceFindings(references: ReferenceResolution[]): DependencyFinding[] {
  const label: Record<ReferenceKind, string> = { group: "group", filter: "assignment filter", scopeTag: "scope tag", reusableSetting: "reusable setting" }
  const findings: DependencyFinding[] = []
  for (const reference of references) {
    const name = reference.sourceName ? `"${reference.sourceName}"` : "an unnamed object"
    if (reference.state === "missing") {
      if (reference.suggestion) findings.push({ code: "display-name-only", severity: "blocking", message: `The ${label[reference.kind]} ${name} has a target candidate with the same name ("${reference.suggestion.targetName}"). A name match is not proof: confirm the mapping explicitly.` })
      else findings.push({ code: "missing-mapping", severity: "blocking", message: `The ${label[reference.kind]} ${name} has no confirmed target mapping.` })
      if (reference.kind !== "group") findings.push({ code: "ordering", severity: "blocking", message: `If the ${label[reference.kind]} ${name} does not exist in the target yet, create it there first, then map it.` })
    }
    if (reference.state === "rejected") findings.push({ code: "rejected-mapping", severity: "blocking", message: reference.kind === "group" && reference.targetName
      ? `Intune cannot assign the distribution list "${reference.targetName}". Choose a security or Microsoft 365 group.`
      : `The mapped target of the ${label[reference.kind]} ${name} does not exist in the target tenant.` })
    if (reference.state === "mapped-unverified" && reference.kind === "group") {
      if (!findings.some(finding => finding.message === GROUP_CHECK_REQUIRED)) findings.push({ code: "unknown-membership", severity: "blocking", message: GROUP_CHECK_REQUIRED })
    } else if (reference.state === "mapped-unverified") findings.push({ code: "unknown-membership", severity: "warning", message: `The mapped ${label[reference.kind]} ${reference.targetName ? `"${reference.targetName}"` : reference.targetId} could not be read in the target tenant; its existence and membership are unknown.` })
  }
  return findings
}

/**
 * Translates the source configuration into the target tenant with confirmed mappings.
 * Updates keep the destination's scope tags; creates map tags or use Default with a warning.
 * Returns null for the body when another tenant-specific reference is unresolved, so a source
 * GUID is never written. Assignments are translated only when included; exclusions keep their
 * exclusion target type, and on types that store exclusions as includes they are blocked
 * unless `dropUnsupportedExclusions` explicitly drops them.
 */
export function translate(
  type: IntuneType,
  source: Item,
  references: ReferenceResolution[],
  options: { includeAssignments: boolean; dropUnsupportedExclusions: boolean; destinationSnapshot?: Item | null; acknowledgeRedacted?: boolean; verifyScopeTags?: boolean },
): { body: Item | null; assignments: Item[] | null; findings: DependencyFinding[] } {
  const findings: DependencyFinding[] = []
  const usable = (kind: ReferenceKind, id: string): string | null => {
    // The built-in Default scope tag has the same ID in every tenant.
    if (kind === "scopeTag" && id === "0") return "0"
    const reference = references.find((entry) => entry.kind === kind && entry.sourceId.toLowerCase() === id.toLowerCase())
    return reference && usableReference(reference) && reference.targetId && isGraphId(reference.targetId) ? reference.targetId : null
  }
  let unresolved = false
  const { assignments: _assignments, ...rest } = structuredClone(source)
  const body = rest as Item
  if (options.destinationSnapshot !== undefined) {
    delete body.roleScopeTagIds
    // PUT resets omitted tags to Default, so send the live destination array explicitly.
    if (Array.isArray(options.destinationSnapshot?.roleScopeTagIds)) body.roleScopeTagIds = structuredClone(options.destinationSnapshot.roleScopeTagIds)
  } else if (Array.isArray(body.roleScopeTagIds)) {
    body.roleScopeTagIds = [...new Set((body.roleScopeTagIds as Json[]).map((tag) => {
      const mapped = typeof tag === "string" ? usable("scopeTag", tag) : null
      if (!mapped && options.verifyScopeTags) unresolved = true
      if (!mapped && !options.verifyScopeTags) {
        const reference = references.find((entry) => entry.kind === "scopeTag" && entry.sourceId === tag)
        findings.push({ code: "scope-tag-default", severity: "warning", message: `The source scope tag ${reference?.sourceName ? `"${reference.sourceName}"` : String(tag)} has no usable destination mapping. The new policy uses Default (0) for this tag.` })
      }
      return mapped ?? "0"
    }))]
  }
  if (containsRedaction(source) || containsSecret(source) || hasSecretValues(source)) {
    findings.push({ code: "secret-values", severity: options.acknowledgeRedacted === true ? "warning" : "blocking", message: "The source policy holds values Intune masks. These secrets are not promoted and must be set again in the destination. Acknowledge this in the planner to continue." })
    if (options.acknowledgeRedacted !== true) unresolved = true
    else {
      // Omit whole settings that hold secrets so no incomplete setting or marker is sent.
      for (const [key, value] of Object.entries(body)) {
        if (Array.isArray(value)) body[key] = value.filter((entry) => !containsRedaction(entry) && !containsSecret(entry))
        else if (containsRedaction(value) || containsSecret(value)) delete body[key]
      }
    }
  }
  visit(body.settings ?? null, (object) => {
    if (object["@odata.type"] !== REFERENCE_VALUE) return
    const value = str(object.value)
    const mapped = value ? usable("reusableSetting", value) : null
    if (!mapped) unresolved = true
    object.value = mapped ?? ""
  })
  let assignments: Item[] | null = null
  if (options.includeAssignments) {
    assignments = []
    for (const assignment of directAssignments(source)) {
      const clean = cleanAssignment(assignment)
      const target = { ...((clean.target ?? {}) as Item) }
      const odataType = str(target["@odata.type"]) ?? "unknown"
      const kind = TARGET_KINDS[odataType.toLowerCase()]
      if (!kind) {
        findings.push({ code: "unsupported-target", severity: "blocking", message: `An assignment target of type ${odataType.replace("#microsoft.graph.", "")} is not supported by promotion.` })
        unresolved = true
        continue
      }
      if (kind.intent === "exclude" && type.exclusionsUnsupported) {
        if (options.dropUnsupportedExclusions) findings.push({ code: "exclusion-dropped", severity: "warning", message: "An exclusion was dropped explicitly because this type would store it as an include." })
        else {
          findings.push({ code: "exclusion-unsupported", severity: "blocking", message: "This type stores exclusions as includes. Drop the exclusion explicitly or leave assignments out." })
          unresolved = true
        }
        continue
      }
      if (kind.target === "group") {
        const mapped = str(target.groupId) ? usable("group", target.groupId as string) : null
        if (!mapped) unresolved = true
        target.groupId = mapped ?? ""
      }
      const filterType = str(target.deviceAndAppManagementAssignmentFilterType)
      if (filterType && filterType !== "none") {
        const mapped = str(target.deviceAndAppManagementAssignmentFilterId) ? usable("filter", target.deviceAndAppManagementAssignmentFilterId as string) : null
        if (!mapped) unresolved = true
        target.deviceAndAppManagementAssignmentFilterId = mapped ?? ""
        // The filter type (include or exclude) is preserved exactly.
        target.deviceAndAppManagementAssignmentFilterType = filterType
      } else {
        target.deviceAndAppManagementAssignmentFilterId = null
        target.deviceAndAppManagementAssignmentFilterType = "none"
      }
      assignments.push({ ...clean, target })
    }
  } else if (directAssignments(source).length) {
    findings.push({ code: "assignments-excluded", severity: "info", message: "Assignments are not copied. The object is created unassigned (or keeps its current assignments) until targeting is reviewed separately." })
  }
  return { body: unresolved ? null : body, assignments: unresolved ? null : assignments, findings }
}

/** Parses mapping input from the renderer; unknown shapes are rejected, not ignored. */
export function parseMappings(value: unknown): Mapping[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 500) throw new Error("Mappings must be a list of at most 500 entries.")
  const kinds: ReferenceKind[] = ["group", "filter", "scopeTag", "reusableSetting"]
  const seen = new Set<string>()
  return value.map((entry) => {
    const item = entry as Record<string, unknown> | null
    if (!item || !kinds.includes(item.kind as ReferenceKind) || !isGraphId(item.sourceId) || !isGraphId(item.targetId) || typeof item.confirmed !== "boolean") throw new Error("Each mapping needs a kind, a source ID, a target ID and an explicit confirmation flag.")
    const key = `${item.kind}:${(item.sourceId as string).toLowerCase()}`
    if (seen.has(key)) throw new Error("Each source object can be mapped once.")
    seen.add(key)
    return { kind: item.kind as ReferenceKind, sourceId: item.sourceId as string, targetId: item.targetId as string, confirmed: item.confirmed }
  })
}
