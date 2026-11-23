import { groupNamePath, readGroupStates } from "../../../shared/intune/group-reads"
import { referenceTargetId, suggestGroups } from "../../../shared/intune/reference-mapping"
import { assignmentsUnread } from "../../../shared/intune/read"
import type { GraphCall } from "../../../portal/lib/policies/graph-restore"
import { GROUP_CHECK_REQUIRED } from "../../../shared/group-access"
import { toGroup } from "../../oib/assignments"
import { itemName, typeForFolder, type Item } from "../../../shared/intune/registry"
import { isGraphId, isGuid } from "../../../shared/security"
import type { Plan } from "../../../shared/plans"
import type { FeatureDeps } from "../deps"
import { FeatureError } from "../route"
import { createListingMemo, GraphReadError, getOne, listAll, readCurrent, sameNameIds, type ListingMemo } from "../change-sets/graph"
import { containsRedaction, hashOf, sanitizeSnapshot, unsupportedReason } from "../change-sets/model"
import { extractReferences, referenceFindings, resolveReferences, translate, type DependencyFinding, type Mapping, type ReferenceKind, type ReferenceResolution, type TargetReads } from "./mapping"

/**
 * Destination resolution for promotion (#145) against live destination objects.
 *
 * Resolving reads the source object, maps every tenant-specific reference through confirmed
 * mappings to objects read in the destination, and records a hash of the destination state it
 * relied on. `staleTargets` re-reads that state before any write so a plan never writes
 * against dependencies that changed after review.
 */

export interface ResolveInput {
  sourceTenantId: string
  folder: string
  sourceObjectId: string
  /** Existing destination object to update, chosen explicitly; null creates a new object. */
  targetObjectId: string | null
  includeAssignments: boolean
  verifyAssignments?: boolean
  dropUnsupportedExclusions: boolean
  acknowledgeRedacted?: boolean
  mappings: Mapping[]
  /** A source snapshot already read and sanitized. */
  sourceSnapshot: Item
}

export interface ResolvedTarget {
  sourceName: string
  references: ReferenceResolution[]
  findings: DependencyFinding[]
  blocked: boolean
  targetReads: TargetReads
  targetStateHash: string
  /** The translated body and assignments to write; null when blocked. */
  proposed: { body: Item | null; assignments: Item[] | null }
}

const LISTS: Record<Exclude<ReferenceKind, "group">, { path: string; select: string }> = {
  filter: { path: "deviceManagement/assignmentFilters", select: "id,displayName,platform,rule,lastModifiedDateTime" },
  scopeTag: { path: "deviceManagement/roleScopeTags", select: "id,displayName" },
  reusableSetting: { path: "deviceManagement/reusablePolicySettings", select: "id,displayName,settingDefinitionId,lastModifiedDateTime,version" },
}

/**
 * Checks the source tenant of a two-tenant action. The source must be passed in
 * `targetTenants` so the route checked its license; on Pro both tenants must be covered by
 * the same license, or each by a Pro trial. MSP bulk or portfolio endpoints are not involved.
 */
export function requireSourceTenant(context: { tenantId: string; plan: Plan; deps: FeatureDeps; targetTenants: string[] }, sourceTenantId: unknown, options: { distinct?: boolean } = {}): string {
  if (!isGuid(sourceTenantId)) throw new FeatureError("Choose the source tenant.")
  const source = sourceTenantId.toLowerCase()
  if (source === context.tenantId) {
    if (options.distinct) throw new FeatureError("Choose a source tenant different from the destination.")
    return source
  }
  if (!context.targetTenants.includes(source)) throw new FeatureError("The source tenant must be named in targetTenants so its license is checked.")
  if (context.plan === "pro" && !context.deps.sameLicense(source, context.tenantId)) throw new FeatureError("On Pro, both tenants must be the two tenants covered by the same license, or two tenants that each run a Pro trial.", 403)
  return source
}

/** Objects of the destination a non-group mapping can point to. */
export async function mappableObjects(deps: FeatureDeps, tenantId: string, kind: unknown): Promise<{ objects: Array<{ id: string; name: string }>; readable: boolean; reason?: string }> {
  if (kind !== "filter" && kind !== "scopeTag" && kind !== "reusableSetting") throw new FeatureError("Choose filter, scopeTag or reusableSetting.")
  try {
    const items = await listAll(await deps.graph(tenantId), `${LISTS[kind].path}?$select=${LISTS[kind].select}`)
    return { objects: items.map((item) => ({ id: String(item.id ?? ""), name: String(item.displayName ?? "") })), readable: true }
  } catch (error) {
    return { objects: [], readable: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Listings of one pass, kept apart per tenant so source and destination never share. */
export interface TargetListings {
  source: ListingMemo
  target: ListingMemo
}

/** id (lowercase) to display name of a list, or null when it cannot be read (for example 403). */
async function names(graph: GraphCall, kind: Exclude<ReferenceKind, "group">, memo?: ListingMemo): Promise<Map<string, string> | null> {
  try {
    const items = await listAll(graph, `${LISTS[kind].path}?$select=${LISTS[kind].select}`, memo)
    return new Map(items.filter((item) => typeof item.id === "string").map((item) => [(item.id as string).toLowerCase(), String(item.displayName ?? "")]))
  } catch (error) {
    if (error instanceof GraphReadError && (error.status === 401 || error.status === 403)) return null
    throw error
  }
}

/** Whether the tenant can verify the group and whether Intune can assign it. */
export async function groupState(graph: GraphCall, id: string): Promise<{ state: "found" | "missing" | "unknown" | "unassignable"; name: string | null }> {
  try {
    const group = await getOne(graph, `groups/${encodeURIComponent(id)}?$select=id,displayName,securityEnabled,groupTypes`)
    if (!group) return { state: "missing", name: null }
    const verified = toGroup(group)
    if (verified?.id !== id.toLowerCase()) throw new FeatureError("Microsoft Graph did not return the requested group.", 502)
    return { state: verified.kind === "other" ? "unassignable" : "found", name: verified.displayName }
  } catch (error) {
    if (error instanceof GraphReadError && (error.status === 401 || error.status === 403)) return { state: "unknown", name: null }
    throw error
  }
}

class DestinationGroupError extends FeatureError {
  constructor(message: string, readonly code: DependencyFinding["code"], status: number) {
    super(message, status)
  }
}

/**
 * Hash of the destination objects a plan relied on: mapped filters (including their rule),
 * scope tags, reusable settings and groups. Destination tags and unacknowledged redaction
 * are checked here so changes require a new plan. The change set's target fingerprint owns
 * the remaining content, so a retry after a verified update still matches.
 */
export async function targetStateHash(graph: GraphCall, reads: TargetReads, policySnapshot?: Item | null, memo?: ListingMemo): Promise<string> {
  const state: Record<string, unknown> = {}
  if (reads.policyId && reads.policyFolder) {
    const type = typeForFolder(reads.policyFolder)!
    const policy = policySnapshot === undefined ? await readCurrent(graph, type, reads.policyId) : policySnapshot
    state.policyScopeTags = policy ? policy.roleScopeTagIds ?? null : "missing"
    if (reads.requireUnredacted) {
      const sanitized = policy ? sanitizeSnapshot(type, policy) : null
      state.policyRedacted = sanitized ? sanitized.redacted || containsRedaction(sanitized.snapshot) : null
    }
  }
  const subset = async (kind: Exclude<ReferenceKind, "group">, ids: string[]) => {
    if (!ids.length) return []
    try {
      const items = await listAll(graph, `${LISTS[kind].path}?$select=${LISTS[kind].select}`, memo)
      // Timestamps and versions are kept on purpose: any edit of a relied-on object invalidates the plan.
      const fields = LISTS[kind].select.split(",")
      return ids.map((id) => {
        const item = items.find((entry) => typeof entry.id === "string" && entry.id.toLowerCase() === id.toLowerCase())
        return item ? Object.fromEntries(fields.map((field) => [field, item[field] ?? null])) : { id, missing: true }
      })
    } catch (error) {
      if (error instanceof GraphReadError && (error.status === 401 || error.status === 403)) return "unreadable"
      throw error
    }
  }
  state.filters = await subset("filter", reads.filterIds)
  state.scopeTags = await subset("scopeTag", reads.scopeTagIds.filter((id) => id !== "0"))
  state.reusableSettings = await subset("reusableSetting", reads.reusableSettingIds)
  state.groups = await Promise.all(reads.groupIds.map(async (id) => {
    const group = await groupState(graph, id)
    if (group.state === "unknown") throw new DestinationGroupError(GROUP_CHECK_REQUIRED, "unknown-membership", 403)
    if (group.state === "missing") throw new DestinationGroupError(`The mapped destination group (${id}) does not exist in the target tenant.`, "rejected-mapping", 409)
    if (group.state === "unassignable") throw new DestinationGroupError(`Intune cannot assign the distribution list "${group.name ?? id}". Choose a security or Microsoft 365 group.`, "rejected-mapping", 409)
    return { id: id.toLowerCase(), ...group }
  }))
  return hashOf(state)
}

/**
 * Resolves one source policy against the destination: references through confirmed mappings,
 * blocking findings, the translated content and the destination state it relied on. Reads only.
 */
export async function resolveTarget(deps: FeatureDeps, destinationTenantId: string, input: ResolveInput, listings?: TargetListings): Promise<ResolvedTarget> {
  const target = destinationTenantId.toLowerCase()
  const source = input.sourceTenantId.toLowerCase()
  const type = typeForFolder(input.folder)
  if (!type) throw new FeatureError(`${input.folder} is not an Intune type TenuVault knows.`)
  if (!isGraphId(input.sourceObjectId)) throw new FeatureError("Choose the source object.")
  if (input.targetObjectId !== null && !isGraphId(input.targetObjectId)) throw new FeatureError("The target object ID is invalid.")
  const sameTenant = source === target
  let sourceGraph: GraphCall
  let targetGraph: GraphCall
  try {
    ;[sourceGraph, targetGraph] = await Promise.all([deps.graph(source), deps.graph(target)])
  } catch (error) {
    throw new FeatureError(`The tenants could not be read. ${error instanceof Error ? error.message : String(error)}`, 502)
  }
  const read = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof FeatureError) throw error
      throw new FeatureError(`${what} could not be read. ${error instanceof Error ? error.message : String(error)}`, error instanceof GraphReadError && error.status === 403 ? 403 : 502)
    }
  }
  const sanitized = sanitizeSnapshot(type, input.sourceSnapshot)
  const sourceSnapshot = sanitized.snapshot
  const findings: DependencyFinding[] = []
  const unsupported = unsupportedReason(type.folder, input.targetObjectId ? "update" : "create")
  if (unsupported) findings.push({ code: "unsupported-type", severity: "blocking", message: unsupported })

  const targetPolicy = input.targetObjectId ? await read("The destination object", () => readCurrent(targetGraph, type, input.targetObjectId!)) : null
  const sourceTags = Array.isArray(sourceSnapshot.roleScopeTagIds) ? sourceSnapshot.roleScopeTagIds.map(String) : []
  const destinationTags = Array.isArray(targetPolicy?.roleScopeTagIds) ? targetPolicy.roleScopeTagIds.map(String) : []
  const references = extractReferences(sourceSnapshot, input.includeAssignments).filter((reference) => !input.targetObjectId || reference.kind !== "scopeTag")
  const kinds = new Set(references.map((reference) => reference.kind))
  const targetObjects: Partial<Record<ReferenceKind, Map<string, string> | null>> = {}
  const sourceNames: Partial<Record<ReferenceKind, Map<string, string>>> = {}
  const targetListings = listings?.target ?? createListingMemo()
  const sourceListings = sameTenant ? targetListings : listings?.source ?? createListingMemo()
  for (const kind of ["filter", "scopeTag", "reusableSetting"] as const) {
    if (!kinds.has(kind) && !(kind === "scopeTag" && input.targetObjectId && (sourceTags.length || destinationTags.length))) continue
    targetObjects[kind] = await read("Destination objects", () => names(targetGraph, kind, targetListings))
    sourceNames[kind] = (sameTenant ? targetObjects[kind] : await read("Source objects", () => names(sourceGraph, kind, sourceListings))) ?? new Map()
  }
  const sourceGroupIds = references.filter((entry) => entry.kind === "group").map((entry) => entry.sourceId)
  const targetGroupIds = sourceGroupIds.flatMap((id) => referenceTargetId("group", id, input.mappings, sameTenant) ?? [])
  const [groupStates, originals] = await Promise.all([
    read("The destination group", async () => new Map(await Promise.all(
      [...new Set(targetGroupIds.map((id) => id.toLowerCase()))].map(async (id) => [id, await groupState(targetGraph, id)] as const),
    ))),
    readGroupStates(sourceGraph, sourceGroupIds),
  ])
  sourceNames.group = new Map(sourceGroupIds.flatMap((id) => {
    const name = originals.get(id.toLowerCase())?.name
    return name ? [[id.toLowerCase(), name]] : []
  }))
  const resolutions = resolveReferences(references, { mappings: input.mappings, sourceNames, targetObjects, groupStates, sameTenant })
  if (input.verifyAssignments) {
    await suggestGroups(resolutions, async (name) => {
      const groups = await listAll(targetGraph, groupNamePath(name), targetListings).catch(() => [])
      return new Map(groups.flatMap((group) => typeof group.id === "string" ? [[group.id.toLowerCase(), String(group.displayName ?? "")]] : []))
    })
  }
  findings.push(...referenceFindings(resolutions.filter((reference) => input.verifyAssignments || reference.kind !== "scopeTag" || reference.state === "mapped-unverified")))
  if (input.verifyAssignments) {
    if (assignmentsUnread(type, sourceSnapshot) || !Array.isArray(sourceSnapshot.assignments)) {
      findings.push({ code: "unsupported-target", severity: "blocking", message: "Source assignments could not be read. Check the source policy before copying its assignments." })
    }
  }
  const translated = translate(type, sourceSnapshot, resolutions, { includeAssignments: input.includeAssignments, dropUnsupportedExclusions: input.dropUnsupportedExclusions, destinationSnapshot: input.targetObjectId ? targetPolicy : undefined, acknowledgeRedacted: input.acknowledgeRedacted, verifyScopeTags: input.verifyAssignments })
  findings.push(...translated.findings)

  if (input.targetObjectId && !targetPolicy) findings.push({ code: "missing-mapping", severity: "blocking", message: "The chosen destination object does not exist in the destination tenant." })
  if (targetPolicy) {
    const destinationSnapshot = sanitizeSnapshot(type, targetPolicy)
    if (destinationSnapshot.redacted || containsRedaction(destinationSnapshot.snapshot)) findings.push({ code: "secret-values", severity: input.acknowledgeRedacted === true ? "warning" : "blocking", message: "The destination policy holds values Intune masks. Promotion can remove these secrets and they must be set again in the destination. Acknowledge this in the planner to continue. Automatic rollback cannot recover them." })
    if (hashOf([...new Set(sourceTags)].sort()) !== hashOf([...new Set(destinationTags)].sort())) {
      const labels = (ids: string[], lookup: Map<string, string> | null | undefined) => ids.map((id) => {
        const name = lookup?.get(id.toLowerCase()) || (id === "0" ? "Default" : null)
        return name ? `"${name}" (${id})` : id
      }).join(", ") || "none"
      findings.push({ code: "scope-tags-kept", severity: "info", message: `Scope tags of the destination are kept. Source: ${labels(sourceTags, sourceNames.scopeTag)}. Destination: ${labels(destinationTags, targetObjects.scopeTag)}.` })
    }
  }
  const sourceName = itemName(type, sourceSnapshot)
  if (!input.targetObjectId) {
    const existing = await read("Destination objects", () => sameNameIds(targetGraph, type, sourceName, targetListings))
    if (existing.length) findings.push({ code: "display-name-only", severity: "warning", message: `${existing.length} object(s) named "${sourceName}" already exist in the destination. A name match is not a mapping: choose one explicitly to update it, or a new object is created next to it.` })
  }

  const confirmed = (kind: ReferenceKind) => resolutions.filter((entry) => entry.kind === kind && entry.targetId && entry.state !== "missing" && entry.state !== "rejected").map((entry) => entry.targetId!)
  const targetReads: TargetReads = { policyId: input.targetObjectId, policyFolder: type.folder, requireUnredacted: input.acknowledgeRedacted !== true, filterIds: confirmed("filter"), scopeTagIds: input.targetObjectId ? destinationTags : confirmed("scopeTag"), reusableSettingIds: confirmed("reusableSetting"), groupIds: resolutions.flatMap(entry => entry.kind === "group" && entry.state === "mapped" && entry.targetId ? [entry.targetId] : []) }
  const stateHash = await read("The destination state", () => targetStateHash(targetGraph, targetReads, targetPolicy, targetListings)).catch(error => {
    if (!(error instanceof DestinationGroupError)) throw error
    if (!findings.some(finding => finding.message === error.message)) findings.push({ code: error.code, severity: "blocking", message: error.message })
    return ""
  })
  const blocked = findings.some((finding) => finding.severity === "blocking") || !translated.body
  return {
    sourceName,
    references: resolutions,
    findings,
    blocked,
    targetReads,
    targetStateHash: stateHash,
    proposed: { body: blocked ? null : translated.body, assignments: blocked ? null : translated.assignments },
  }
}

/**
 * Reasons the destination objects the plan relied on changed since planning; empty when all
 * are unchanged. Read failures fail closed.
 */
export async function staleTargets(deps: FeatureDeps, tenantId: string, items: Array<{ sourceName: string; targetReads: TargetReads; targetStateHash: string }>): Promise<string[]> {
  if (!items.length) return []
  let graph: GraphCall
  try {
    graph = await deps.graph(tenantId)
  } catch (error) {
    return [`The destination could not be re-checked: ${error instanceof Error ? error.message : String(error)}`]
  }
  const reasons: string[] = []
  const listings = createListingMemo()
  for (const item of items) {
    // Plans made before destination tags and redaction were part of the hash cannot be re-checked.
    if (item.targetReads.policyId && !item.targetReads.policyFolder) {
      reasons.push(`The destination objects "${item.sourceName}" relied on were planned before destination policy checks existed. Plan again.`)
      continue
    }
    try {
      if (await targetStateHash(graph, item.targetReads, undefined, listings) !== item.targetStateHash) reasons.push(`The destination objects "${item.sourceName}" relied on changed after planning. Plan again.`)
    } catch (error) {
      if (error instanceof DestinationGroupError) reasons.push(`"${item.sourceName}": ${error.message} Plan again.`)
      else reasons.push(`The destination objects of "${item.sourceName}" could not be re-checked: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return reasons
}
