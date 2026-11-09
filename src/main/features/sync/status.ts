import type { GraphCall } from "../../../portal/lib/policies/graph-restore"
import { comparableSnapshot, sameSnapshot } from "../../../shared/intune/compare"
import { typeForFolder, type Item } from "../../../shared/intune/registry"
import type { FeatureDeps } from "../deps"
import { readCurrent } from "../change-sets/graph"
import { hashOf, sanitizeSnapshot, writableBody } from "../change-sets/model"
import { parseLinkKey, syncLinks } from "./links"

/**
 * Whether each linked policy is still in sync, by comparing both sides with the hashes stored
 * when the link was written. Read only: nothing is planned or written.
 *
 * in-sync: neither side moved. changed: the source, the target or both moved since the link.
 * missing-in-target: the linked target object is gone. missing-in-source: the source policy is
 * gone. unknown: a side could not be read, or the target was not read back when it was linked
 * and the source did not move, so a target edit cannot be told.
 */
export interface SyncStatusEntry {
  folder: string
  sourceId: string
  sourceName: string
  targetPolicyId: string
  targetName: string
  linkedAt: string
  state: "in-sync" | "changed" | "missing-in-target" | "missing-in-source" | "unknown"
  changedIn: "source" | "target" | "both" | null
  /** Whether source and target hold the same writable configuration now; null when one side is missing. Supporting information only. */
  identical: boolean | null
  error: string | null
}

export interface SyncStatus {
  targets: Array<{ targetTenantId: string; links: SyncStatusEntry[]; error: string | null }>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function syncStatus(deps: FeatureDeps, sourceTenantId: string, targetTenantIds: string[]): Promise<SyncStatus> {
  const source = sourceTenantId.toLowerCase()
  let sourceGraph: GraphCall | null = null
  let sourceError: string | null = null
  try {
    sourceGraph = await deps.graph(source)
  } catch (error) {
    sourceError = `The source tenant could not be read: ${messageOf(error)}`
  }
  // Each source policy is read once, however many targets link it.
  const sourceReads = new Map<string, Promise<Item | null>>()
  const targets: SyncStatus["targets"] = []
  for (const target of targetTenantIds) {
    const links = Object.entries(syncLinks(deps, target, source))
    if (!links.length) {
      targets.push({ targetTenantId: target, links: [], error: null })
      continue
    }
    let targetGraph: GraphCall
    try {
      targetGraph = await deps.graph(target)
    } catch (error) {
      targets.push({ targetTenantId: target, links: [], error: `The target tenant could not be read: ${messageOf(error)}` })
      continue
    }
    const entries: SyncStatusEntry[] = []
    for (const [key, link] of links) {
      const { folder, sourceId } = parseLinkKey(key)
      const base = { folder, sourceId, sourceName: link.sourceName, targetPolicyId: link.targetPolicyId, targetName: link.targetName, linkedAt: link.linkedAt }
      const type = typeForFolder(folder)
      if (!type) {
        entries.push({ ...base, state: "unknown", changedIn: null, identical: null, error: `${folder} is not an Intune type TenuVault knows.` })
        continue
      }
      try {
        if (!sourceGraph) throw new Error(sourceError ?? "The source tenant could not be read.")
        const graph = sourceGraph
        if (!sourceReads.has(key)) sourceReads.set(key, readCurrent(graph, type, sourceId))
        const sourceLive = await sourceReads.get(key)!
        const targetLive = await readCurrent(targetGraph, type, link.targetPolicyId)
        if (!targetLive) {
          entries.push({ ...base, state: "missing-in-target", changedIn: null, identical: null, error: null })
          continue
        }
        if (!sourceLive) {
          entries.push({ ...base, state: "missing-in-source", changedIn: null, identical: null, error: null })
          continue
        }
        const sourceSnapshot = sanitizeSnapshot(type, sourceLive).snapshot
        const targetSnapshot = sanitizeSnapshot(type, targetLive).snapshot
        const sourceMoved = hashOf(comparableSnapshot(sourceSnapshot)) !== link.sourceHash
        const targetMoved = link.targetHash === null ? null : hashOf(comparableSnapshot(targetSnapshot)) !== link.targetHash
        const identical = sameSnapshot(writableBody(type, sourceSnapshot), writableBody(type, targetSnapshot))
        if (targetMoved === null && !sourceMoved) {
          entries.push({ ...base, state: "unknown", changedIn: null, identical, error: "The target was not read back when it was linked, so a change there cannot be told." })
          continue
        }
        const changedIn = sourceMoved && targetMoved ? "both" : sourceMoved ? "source" : targetMoved ? "target" : null
        entries.push({ ...base, state: changedIn ? "changed" : "in-sync", changedIn, identical, error: null })
      } catch (error) {
        entries.push({ ...base, state: "unknown", changedIn: null, identical: null, error: messageOf(error) })
      }
    }
    targets.push({ targetTenantId: target, links: entries, error: null })
  }
  return { targets }
}
