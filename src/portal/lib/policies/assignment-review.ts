import { listAll, createListingMemo } from "../../../main/features/change-sets/graph"
import { parseMappings, type Mapping } from "../../../main/features/promotion/mapping"
import { isGuid } from "../../../shared/security"
import { resolveRestoreAssignments, restoreReferences, type AssignmentKind, type ReferenceNames } from "../../../shared/intune/restore-assignments"
import { typeForFolder, type Item } from "../../../shared/intune/registry"
import { groupNamePath, readGroupStates, type GroupState } from "../../../shared/intune/group-reads"
import { referenceTargetId, suggestGroups } from "../../../shared/intune/reference-mapping"
import type { GraphCall } from "./graph-restore"

const collections = {
  filter: "deviceManagement/assignmentFilters",
  scopeTag: "deviceManagement/roleScopeTags",
}

export type AssignmentMappings = Record<string, Mapping[]>
export type SkippedAssignments = Record<string, string[]>

export function parseAssignmentMappings(value: unknown, destinations: string[]): AssignmentMappings {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Assignment mappings must be grouped by destination tenant.")
  const pairs = Object.entries(value).map(([id, entries]) => {
    if (!isGuid(id) || !destinations.includes(id)) throw new Error("An assignment mapping names an unselected destination tenant.")
    return [id, parseMappings(entries)]
  })
  return Object.fromEntries(pairs)
}

export function parseSkippedAssignments(value: unknown, paths: string[]): SkippedAssignments {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Skipped assignments must be grouped by backup file.")
  const selected = new Set(paths)
  return Object.fromEntries(Object.entries(value).map(([path, skipped]) => {
    if (!selected.has(path) || !Array.isArray(skipped) || skipped.length > 500 || skipped.some((index) => typeof index !== "string" || !/^\d+$/.test(index))) {
      throw new Error("Choose assignments to skip from selected backup files.")
    }
    return [path, skipped]
  }))
}

export function assignmentDirectory(graph: GraphCall) {
  const memo = createListingMemo()
  const reads = new Map<AssignmentKind, Promise<Map<string, string> | null>>()
  const groups = new Map<string, Promise<GroupState>>()
  const names = async (path: string) => {
    const items = await listAll(graph, path, memo)
    if (items.some((item) => typeof item.id !== "string")) return null
    return new Map(items.map((item) => [(item.id as string).toLowerCase(), String(item.displayName ?? "")]))
  }
  return {
    objects(kind: Exclude<AssignmentKind, "group">) {
      const existing = reads.get(kind)
      if (existing) return existing
      const read = names(`${collections[kind]}?$select=id,displayName`).catch(() => null)
      reads.set(kind, read)
      return read
    },
    async groups(ids: string[]) {
      const valid = [...new Set(ids.filter(isGuid).map((id) => id.toLowerCase()))]
      const fresh = valid.filter((id) => !groups.has(id))
      const pending = readGroupStates(graph, fresh)
      for (const id of fresh) groups.set(id, pending.then((result) => result.get(id)!))
      return new Map(await Promise.all(valid.map(async (id) => [id, await groups.get(id)!] as const)))
    },
    suggestions: (name: string) => names(groupNamePath(name)).then((results) => results ?? new Map<string, string>()).catch(() => new Map<string, string>()),
  }
}

export type AssignmentDirectory = ReturnType<typeof assignmentDirectory>

function backupNames(metadata: Record<string, unknown> | null, kind: AssignmentKind): Map<string, string> {
  const all = metadata?.AssignmentReferenceNames
  if (!all || typeof all !== "object" || !Object.hasOwn(all, kind)) return new Map()
  const names = (all as Record<string, unknown>)[kind]
  if (!names || typeof names !== "object") return new Map()
  return new Map(Object.entries(names).flatMap(([id, name]) => typeof name === "string" ? [[id.toLowerCase(), name]] : []))
}

export function assignmentReviewer(source: AssignmentDirectory, target: AssignmentDirectory, metadata: Record<string, unknown> | null, sameTenant: boolean, mappings: Mapping[], skipped: SkippedAssignments) {
  const recorded = {
    group: backupNames(metadata, "group"),
    filter: backupNames(metadata, "filter"),
    scopeTag: backupNames(metadata, "scopeTag"),
  }
  const targetObjects: ReferenceNames = {}
  const typeForPath = (path: string) => {
    const folder = path.split("/")[1]
    return typeForFolder(folder === "DeviceCompliancePolicies" ? "CompliancePolicies" : folder ?? "")
  }
  const targetGroupIds = (references: ReturnType<typeof restoreReferences>) => references.flatMap(({ kind, sourceId }) => {
    if (kind !== "group") return []
    const targetId = referenceTargetId(kind, sourceId, mappings, sameTenant)
    return targetId ? [targetId] : []
  })
  const sourceGroupIds = (references: ReturnType<typeof restoreReferences>) => references.flatMap(({ kind, sourceId, name }) =>
    kind === "group" && !name && !recorded.group.has(sourceId.toLowerCase()) ? [sourceId] : [])
  return {
    async preload(items: Iterable<[string, Item]>) {
      const references = [...items].flatMap(([path, snapshot]) => {
        const type = typeForPath(path)
        return type && type.restore !== "metadata" ? restoreReferences(type, snapshot) : []
      })
      const ids = targetGroupIds(references)
      const originals = sourceGroupIds(references)
      if (source === target) await target.groups([...ids, ...originals])
      else await Promise.all([target.groups(ids), source.groups(originals)])
    },
    async review(path: string, snapshot: Item, includeSuggestions = false) {
      const type = typeForPath(path)
      if (!type || type.restore === "metadata") return undefined
      const references = restoreReferences(type, snapshot).filter((entry) => entry.kind !== "scopeTag" || entry.sourceId !== "0")
      const sourceNames: ReferenceNames = {}
      const groupStates = await target.groups(targetGroupIds(references))
      const sourceGroups = await source.groups(sourceGroupIds(references))
      const groupNames = new Map<string, string>()
      for (const { kind, sourceId, name } of references) {
        if (kind !== "group") continue
        const key = sourceId.toLowerCase()
        const label = recorded.group.get(key) ?? name ?? sourceGroups.get(key)?.name
        if (label) groupNames.set(key, label)
      }
      sourceNames.group = groupNames
      const otherReferences = references.filter((entry): entry is typeof entry & { kind: Exclude<AssignmentKind, "group"> } => entry.kind !== "group")
      await Promise.all([...new Set(otherReferences.map((entry) => entry.kind))].map(async (kind) => {
        const [original, destination] = await Promise.all([source.objects(kind), target.objects(kind)])
        const named = new Map<string, string>()
        for (const { sourceId } of otherReferences.filter((reference) => reference.kind === kind)) {
          const key = sourceId.toLowerCase()
          const name = recorded[kind].get(key) ?? original?.get(key)
          if (name) named.set(key, name)
        }
        sourceNames[kind] = named
        targetObjects[kind] = destination
      }))
      const result = resolveRestoreAssignments(type, snapshot, { sameTenant, mappings, skipped: new Set(skipped[path] ?? []), targetObjects, sourceNames, groupStates })
      if (includeSuggestions) await suggestGroups(result.review.references, target.suggestions)
      return result
    },
    objects() {
      return Object.fromEntries(Object.entries(targetObjects).filter(([kind]) => kind !== "group").map(([kind, names]) => [kind, {
        readable: names !== null,
        objects: [...names ?? []].map(([id, name]) => ({ id, name })),
        ...(names === null ? { reason: "Check your Microsoft Graph read permissions for this object type." } : {}),
      }]))
    },
  }
}
