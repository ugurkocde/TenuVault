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
   * mapped: confirmed and read in the target. mapped-unverified: confirmed but the target could
   * not be read (groups without Group.Read.All). missing: no confirmed mapping. rejected: the
   * confirmed target does not exist or has the wrong kind.
   */
  state: "portable" | "mapped" | "mapped-unverified" | "missing" | "rejected"
  /** A candidate with the same display name. Never used without explicit confirmation. */
  suggestion: { targetId: string; targetName: string } | null
}

/**
 * Resolves each reference with the confirmed mappings and what the target tenant holds.
 * `targetObjects` has the objects read in the target per kind (id to name), or null for a kind
 * that could not be read. Group states can come from individual reads or a complete listing.
 */
export function resolveReferences(
  references: Array<{ kind: ReferenceKind; sourceId: string }>,
  input: {
    mappings: Mapping[]
    sourceNames: Partial<Record<ReferenceKind, Map<string, string>>>
    targetObjects: Partial<Record<ReferenceKind, Map<string, string> | null>>
    groupStates: Map<string, { state: "found" | "missing" | "unknown"; name: string | null }>
    sameTenant: boolean
    strict?: boolean
  },
): ReferenceResolution[] {
  return references.map(({ kind, sourceId }) => {
    const sourceName = input.sourceNames[kind]?.get(sourceId.toLowerCase()) ?? null
    const base = { kind, sourceId, sourceName }
    if (kind === "scopeTag" && sourceId === "0") return { ...base, targetId: "0", targetName: "Default", state: "portable", suggestion: null }
    const mapping = input.mappings.find((entry) => entry.kind === kind && entry.sourceId.toLowerCase() === sourceId.toLowerCase() && entry.confirmed === true)
    // Within one tenant a reference points at the same object; it is still read to prove it exists.
    const targetId = mapping?.targetId ?? (input.sameTenant ? sourceId : null)
    const objects = input.targetObjects[kind]
    const group = targetId && kind === "group" ? input.groupStates.get(targetId.toLowerCase()) : undefined
    const name = targetId ? objects?.get(targetId.toLowerCase()) : undefined
    const state: ReferenceResolution["state"] = !targetId ? "missing"
      : kind === "group" ? group?.state === "found" || (input.strict && name !== undefined) ? "mapped"
        : group?.state === "missing" || (input.strict && objects) ? "rejected" : "mapped-unverified"
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
