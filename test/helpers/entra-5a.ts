import { readFileSync } from "node:fs"
import { classifyAnswer } from "../../src/shared/backup-outcomes"
import { GraphError } from "../../src/main/backup/request"
import { detailPath, listPath, listSnapshot, organizationReader, readObject, type GraphReader } from "../../src/shared/intune/read"
import type { IntuneType, Item } from "../../src/shared/intune/registry"

export interface ReadFixture {
  folder: string
  outcome: string
  cause?: string
  responses: Record<string, { status: number; body: Item; headers?: Record<string, string> }>
}

/** The real list and object read, also used for fixtures of empty and refused lab answers. */
export async function readEntraType(type: IntuneType, reader: GraphReader) {
  const graph = organizationReader(reader)
  const objects: Item[] = []
  let partial: unknown
  try {
    const entries = type.singleton ? [{ id: type.singleton.id, ...await graph.get(detailPath(type, type.singleton.id)) }] : await graph.list(listPath(type))
    for (const item of entries) objects.push(type.listOnly ? listSnapshot(type, item) : await readObject(type, String(item.id ?? type.singleton?.id), graph, { onUnreadExtra: (_key, error) => { partial = error } }))
    if (partial) throw partial
    return { outcome: "saved" as const, objects }
  } catch (error) {
    if (!(error instanceof GraphError)) throw error
    return { ...classifyAnswer({ status: error.status, ...error.answer }, { mode: "app-only", notConfigured: type.notConfigured }), objects }
  }
}

/** Recorded app responses, supplemented with labelled documented shapes for delegated-only types. */
export function entraFixtureResponses(folder: string): ReadFixture["responses"] {
  const suffix = ["MdmEnrollmentPolicies", "MamEnrollmentPolicies", "OnPremisesSynchronization", "OwnerlessGroupPolicy"].includes(folder) ? ".documented" : ""
  return (JSON.parse(readFileSync(new URL(`../fixtures/entra-5a/${folder}${suffix}.json`, import.meta.url), "utf8")) as ReadFixture).responses
}
