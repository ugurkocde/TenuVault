import type { Item } from "./registry"

export type ReferenceKind = "objectId" | "appId" | "appRoleId" | "templateId"
export interface RestoreMapping { kind: ReferenceKind; folder: string; source: string; target: string }
export interface RestoreDependency { key: string; requires: string[] }

/** Namespace and folder are part of identity. The same text in another namespace is unrelated. */
export function rememberMapping(mappings: RestoreMapping[], mapping: RestoreMapping): void {
  const previous = mappings.find(entry => entry.kind === mapping.kind && entry.folder === mapping.folder && entry.source.toLowerCase() === mapping.source.toLowerCase())
  if (previous && previous.target.toLowerCase() !== mapping.target.toLowerCase()) throw new Error("An ambiguous reference mapping was refused.")
  if (!previous) mappings.push(mapping)
}
export function mappedReference(mappings: readonly RestoreMapping[], kind: ReferenceKind, folder: string, source: string): string | undefined {
  const matches = mappings.filter(entry => entry.kind === kind && entry.folder === folder && entry.source.toLowerCase() === source.toLowerCase())
  const targets = new Set(matches.map(entry => entry.target.toLowerCase()))
  if (targets.size > 1) throw new Error("An ambiguous reference mapping was refused.")
  return matches[0]?.target
}

/** Cycles are blocked with their dependents. No arbitrary order is allowed to bypass a prerequisite. */
export function dependencyOrder(nodes: RestoreDependency[]): { order: string[]; blocked: Record<string, string> } {
  if (new Set(nodes.map(node => node.key)).size !== nodes.length) throw new Error("Duplicate restore item key")
  const pending = new Map(nodes.map(node => [node.key, node]))
  const order: string[] = []
  const blocked: Record<string, string> = {}
  while (pending.size) {
    let progress = false
    for (const [key, node] of pending) {
      const missing = node.requires.find(ref => blocked[ref] || (!pending.has(ref) && !order.includes(ref)))
      if (missing) { blocked[key] = `Prerequisite ${missing} is unavailable.`; pending.delete(key); progress = true }
      else if (node.requires.every(ref => order.includes(ref))) { order.push(key); pending.delete(key); progress = true }
    }
    if (!progress) {
      for (const key of pending.keys()) blocked[key] = "A reference cycle or a prerequisite in that cycle requires separate review."
      break
    }
  }
  return { order, blocked }
}

export interface ReplacedReference { path: string; property: string; mapping: RestoreMapping }

/** Reports every occurrence for review. It does not rewrite arbitrary text or mix ID namespaces. */
export function replacedReferenceReport(snapshots: Array<{ path: string; snapshot: Item }>, mappings: readonly RestoreMapping[]): ReplacedReference[] {
  const report: ReplacedReference[] = []
  for (const { path, snapshot } of snapshots) {
    const walk = (value: unknown, property: string) => {
      if (typeof value === "string") {
        for (const mapping of mappings) if (mapping.source !== mapping.target && value.toLowerCase().includes(mapping.source.toLowerCase())) report.push({ path, property, mapping })
      } else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) walk(child, property ? `${property}.${key}` : key)
    }
    walk(snapshot, "")
  }
  return report
}
