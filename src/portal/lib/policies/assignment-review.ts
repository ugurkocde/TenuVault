import { listAll, createListingMemo } from "../../../main/features/change-sets/graph"
import { parseMappings, type Mapping } from "../../../main/features/promotion/mapping"
import { isGuid } from "../../../shared/security"
import { resolveRestoreAssignments, restoreReferences, type AssignmentKind, type ReferenceNames } from "../../../shared/intune/restore-assignments"
import { typeForFolder, type Item } from "../../../shared/intune/registry"
import type { GraphCall } from "./graph-restore"

const collections: Record<AssignmentKind, string> = {
  group: "groups",
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
  return (kind: AssignmentKind) => {
    const existing = reads.get(kind)
    if (existing) return existing
    const read = listAll(graph, `${collections[kind]}?$select=id,displayName`, memo)
      .then((items) => {
        if (items.some((item) => typeof item.id !== "string")) return null
        return new Map(items.map((item) => [(item.id as string).toLowerCase(), String(item.displayName ?? "")]))
      })
      .catch(() => null)
    reads.set(kind, read)
    return read
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
  return {
    async review(path: string, snapshot: Item) {
      const folder = path.split("/")[1]
      const type = typeForFolder(folder === "DeviceCompliancePolicies" ? "CompliancePolicies" : folder ?? "")
      if (!type || type.restore === "metadata") return undefined
      const references = restoreReferences(type, snapshot).filter((entry) => entry.kind !== "scopeTag" || entry.sourceId !== "0")
      const sourceNames: ReferenceNames = {}
      await Promise.all([...new Set(references.map((entry) => entry.kind))].map(async (kind) => {
        const [original, destination] = await Promise.all([source(kind), target(kind)])
        const named = new Map<string, string>()
        for (const { sourceId } of references.filter((reference) => reference.kind === kind)) {
          const key = sourceId.toLowerCase()
          const name = recorded[kind].get(key) ?? original?.get(key)
          if (name) named.set(key, name)
        }
        sourceNames[kind] = named
        targetObjects[kind] = destination
      }))
      return resolveRestoreAssignments(type, snapshot, { sameTenant, mappings, skipped: new Set(skipped[path] ?? []), targetObjects, sourceNames })
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
