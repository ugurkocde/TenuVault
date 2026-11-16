import { readFileSync } from "node:fs"
import { GraphSession } from "../../src/main/backup/graph-session"
import { NetworkCircuit } from "../../src/main/backup/engine"
import { GraphError } from "../../src/main/backup/request"
import { classifyAnswer } from "../../src/shared/backup-outcomes"
import { readEntries, listSnapshot, readObject, graphVersion, type GraphReader } from "../../src/shared/intune/read"
import type { IntuneType, Item } from "../../src/shared/intune/registry"

export interface DefenderFixture {
  folder: string
  outcome: string
  cause?: string
  objectCount: number
  responses: Record<string, { status: number; body: Item | string; headers?: Record<string, string> }>
}
export const recorded = (folder: string, documented = false): DefenderFixture => JSON.parse(readFileSync(new URL(`../fixtures/defender/${folder}${documented ? ".documented" : ""}.json`, import.meta.url), "utf8"))

/** The production reader and skip rules, including tenant-only content and control states. */
export async function readDefenderType(type: IntuneType, graph: GraphReader) {
  const objects: Item[] = []
  let listing = true
  try {
    const entries = await readEntries(type, graph)
    listing = false
    for (const item of entries.filter(item => !type.skip?.(item))) objects.push(type.listOnly ? listSnapshot(type, item) : await readObject(type, String(item.id), graph))
    return { outcome: "saved" as const, objects }
  } catch (error) {
    if (!(error instanceof GraphError)) throw error
    return { ...classifyAnswer({ status: error.status, ...error.answer }, { mode: "app-only", unavailable: listing ? type.unavailable : [], notConfigured: listing ? type.notConfigured : [] }), objects }
  }
}

export function replay(data: DefenderFixture, type: IntuneType): GraphReader {
  const session = new GraphSession((async input => {
    const url = new URL(String(input))
    const answer = Object.entries(data.responses).find(([path]) => decodeURIComponent(path) === decodeURIComponent(url.pathname + url.search))?.[1]
    if (!answer) throw new Error(`Fixture misses ${type.folder}: ${url.pathname}`)
    return typeof answer.body === "string" ? new Response(answer.body, { status: answer.status, headers: answer.headers }) : Response.json(structuredClone(answer.body), { status: answer.status, headers: answer.headers })
  }) as typeof fetch, async () => "fixture", new NetworkCircuit(10), { service: "defender", isolated: true })
  const url = (path: string) => path.startsWith("https://") ? path : `https://graph.microsoft.com/${graphVersion(type)}/${path}`
  return { get: path => session.get(url(path), type.headers), list: path => session.list(url(path), { headers: type.headers }) as Promise<Item[]> }
}
