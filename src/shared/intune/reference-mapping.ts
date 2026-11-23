import type { GroupState } from "./group-reads"

export type ReferenceKind = "group" | "filter" | "scopeTag" | "reusableSetting"

export interface Mapping {
  kind: ReferenceKind
  sourceId: string
  targetId: string
  /** The admin reviewed this mapping. Unconfirmed mappings (for example name suggestions) are never used. */
  confirmed: boolean
}

export interface ReferenceResolution {
  kind: ReferenceKind
  sourceId: string
  sourceName: string | null
  targetId: string | null
  targetName: string | null
  /**
   * portable: the same built-in object exists in every tenant (Default scope tag).
   * mapped: verified in the target. mapped-unverified: an original ID or confirmed mapping
   * could not be read in the target. missing: no confirmed mapping. rejected: the
   * confirmed target does not exist or has the wrong kind.
   */
  state: "portable" | "mapped" | "mapped-unverified" | "missing" | "rejected"
  /** A candidate with the same display name. Never used without explicit confirmation. */
  suggestion: { targetId: string; targetName: string } | null
}

export function referenceTargetId(kind: ReferenceKind, sourceId: string, mappings: Mapping[], sameTenant: boolean): string | null {
  const mapping = mappings.find((entry) => entry.kind === kind && entry.sourceId.toLowerCase() === sourceId.toLowerCase() && entry.confirmed === true)
  return mapping?.targetId ?? (sameTenant ? sourceId : null)
}

export const usableReference = (reference: ReferenceResolution, allowUnverifiedGroup = false) =>
  reference.state === "mapped" || reference.state === "portable" ||
  (reference.state === "mapped-unverified" && (reference.kind !== "group" || allowUnverifiedGroup))

export async function suggestGroups(references: ReferenceResolution[], names: (name: string) => Promise<Map<string, string>>) {
  await Promise.all(references.map(async (reference) => {
    if (reference.kind !== "group" || !reference.sourceName || !["missing", "rejected"].includes(reference.state)) return
    const matches = [...await names(reference.sourceName)]
      .filter(([, name]) => name.trim().toLowerCase() === reference.sourceName!.trim().toLowerCase())
    if (matches.length === 1) reference.suggestion = { targetId: matches[0]![0], targetName: matches[0]![1] }
  }))
}

/**
 * Resolves each reference with the confirmed mappings and what the target tenant holds.
 * `targetObjects` has the objects read in the target per kind (id to name), or null for a kind
 * that could not be read. Group verification uses the result of reading each ID.
 */
export function resolveReferences(
  references: Array<{ kind: ReferenceKind; sourceId: string }>,
  input: {
    mappings: Mapping[]
    sourceNames: Partial<Record<ReferenceKind, Map<string, string>>>
    targetObjects: Partial<Record<ReferenceKind, Map<string, string> | null>>
    groupStates: ReadonlyMap<string, GroupState>
    sameTenant: boolean
  },
): ReferenceResolution[] {
  return references.map(({ kind, sourceId }) => {
    const sourceName = input.sourceNames[kind]?.get(sourceId.toLowerCase()) ?? null
    const base = { kind, sourceId, sourceName }
    if (kind === "scopeTag" && sourceId === "0") return { ...base, targetId: "0", targetName: "Default", state: "portable", suggestion: null }
    const targetId = referenceTargetId(kind, sourceId, input.mappings, input.sameTenant)
    const objects = input.targetObjects[kind]
    const group = targetId && kind === "group" ? input.groupStates.get(targetId.toLowerCase()) : undefined
    const name = targetId ? objects?.get(targetId.toLowerCase()) : undefined
    const state: ReferenceResolution["state"] = !targetId ? "missing"
      : kind === "group" ? group?.state === "found" ? "mapped"
        : group?.state === "missing" || group?.state === "unassignable" ? "rejected" : "mapped-unverified"
      : kind === "scopeTag" && targetId === "0" ? "mapped"
      : !objects ? "mapped-unverified" : name === undefined ? "rejected" : "mapped"
    let suggestion: ReferenceResolution["suggestion"] = null
    if ((state === "missing" || state === "rejected") && sourceName && objects) {
      const matches = [...objects].filter(([, name]) => name.trim().toLowerCase() === sourceName.trim().toLowerCase())
      if (matches.length === 1) suggestion = { targetId: matches[0]![0], targetName: matches[0]![1] }
    }
    return { ...base, targetId, targetName: group?.name ?? name ?? (kind === "scopeTag" && targetId === "0" ? "Default" : null), state, suggestion }
  })
}
