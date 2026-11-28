import { graphContinuation } from "../../shared/graph-continuation"
import { typeForFolder, type Item } from "../../shared/intune/registry"
import type { RestoreMatrixRow } from "../../shared/intune/restore-matrix"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import { restoreFingerprint } from "./guarded-run"

/** Descriptor lookup shared by the transport and per-contract lost-response tests. GET only. */
export async function findCreatedByDescriptor(row: RestoreMatrixRow, sent: Item, request: (url: string) => Promise<Item | null>): Promise<Item[]> {
  const root = `https://graph.microsoft.com/${row.create?.version ?? row.update?.version ?? "v1.0"}/`
  if (row.detection.kind === "singleton") { const current = await request(root + row.readPath); return current ? [current] : [] }
  if (row.detection.kind === "id") throw new RestoreSafetyError("This type has no verified create reconciliation key. Its create path remains blocked.")
  const keys = row.detection.properties ?? []
  if (!keys.length || keys.some(key => !(key in sent))) throw new RestoreSafetyError("The descriptor's create detection key is missing.")
  const type = typeForFolder(row.folder)!
  const start = root + row.readPath + (type.filter ? `?$filter=${encodeURIComponent(type.filter)}` : "")
  let next: string | undefined = start
  const seen = new Set<string>()
  const matches: Item[] = []
  while (next) {
    if (seen.size >= 10_000) throw new RestoreSafetyError("Create detection did not finish reading every page.")
    const url = graphContinuation(start, next, seen, type.filter)
    const page = await request(url)
    if (!Array.isArray(page?.value)) throw new RestoreSafetyError("Create detection returned an incomplete collection.")
    for (const candidate of page.value) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new RestoreSafetyError("Create detection returned an invalid object.")
      if (keys.every(key => restoreFingerprint({ value: candidate[key] ?? null }) === restoreFingerprint({ value: sent[key] ?? null }))) matches.push(candidate)
    }
    if (page["@odata.nextLink"] !== undefined && typeof page["@odata.nextLink"] !== "string") throw new RestoreSafetyError("Create detection returned an invalid continuation.")
    next = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined
  }
  return matches
}
