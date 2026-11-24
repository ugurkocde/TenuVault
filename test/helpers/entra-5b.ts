import { readFileSync } from "node:fs"
import { GraphSession } from "../../src/main/backup/graph-session"
import { NetworkCircuit } from "../../src/main/backup/engine"
import { graphVersion, type GraphReader } from "../../src/shared/intune/read"
import type { IntuneType, Item } from "../../src/shared/intune/registry"
import type { ReadFixture } from "./entra-5a"
import { readEntries, listSnapshot, readObject, ScopeDiscoveryError } from "../../src/shared/intune/read"
import { GraphError } from "../../src/main/backup/request"
import { classifyAnswer } from "../../src/shared/backup-outcomes"
export type { ReadFixture } from "./entra-5a"

/** Uses the production list and object readers, at the engine's normal concurrency. */
export async function readEntraType(type: IntuneType, graph: GraphReader, discover?: (path: string) => Promise<Item[]>) {
  const objects: Item[] = []
  let listing = true
  try {
    const entries = await readEntries(type, graph, discover)
    listing = false
    for (let offset = 0; offset < entries.length; offset += 8) {
      const answers = await Promise.allSettled(entries.slice(offset, offset + 8).map(async item => {
        const object = type.listOnly ? listSnapshot(type, item) : await readObject(type, String(item.id), graph)
        objects.push(object)
      }))
      const failed = answers.find(answer => answer.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
    }
    return { outcome: "saved" as const, objects }
  } catch (caught) {
    const error = caught instanceof ScopeDiscoveryError ? caught.cause : caught
    if (!(error instanceof GraphError)) throw error
    return { ...classifyAnswer({ status: error.status, ...error.answer }, { mode: "app-only", ...(listing && !(caught instanceof ScopeDiscoveryError) ? { unavailable: type.unavailable } : {}) }), objects }
  }
}

export const recorded = (folder: string): ReadFixture & { objectCount: number } => JSON.parse(readFileSync(new URL(`../fixtures/entra-5b/${folder}.json`, import.meta.url), "utf8"))

export function replay(data: ReadFixture, type: IntuneType): GraphReader {
  const session = new GraphSession((async (input) => {
    const url = new URL(String(input))
    const answer = data.responses[url.pathname + url.search]
    if (!answer) throw new Error(`Fixture misses ${type.folder}: ${url.pathname}`)
    return Response.json(answer.body, { status: answer.status, headers: answer.headers })
  }) as typeof fetch, async () => "fixture", new NetworkCircuit(10), { service: "entra", isolated: true })
  const url = (path: string) => path.startsWith("https://") ? path : `https://graph.microsoft.com/${graphVersion(type)}/${path}`
  return { get: path => session.get(url(path), type.headers), list: (path, idKey) => session.list(url(path), { headers: type.headers, idKey }) as Promise<Item[]> }
}
