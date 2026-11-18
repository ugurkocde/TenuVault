import { restorePermissionBlocker } from "../../shared/services/modules"
import { isGraphId } from "../../shared/security"
import { graphContinuation } from "../../shared/graph-continuation"
import { restoreCapability, typeForFolder, type Item } from "../../shared/intune/registry"
import { restoreMatrixRow } from "../../shared/intune/restore-matrix"
import { RestoreSafetyError, RestoreWriteRefusedError, type RestoreActor, type SafetyReferences } from "../../shared/intune/restore-guards"
import { grantedPermissions } from "../../shared/services/token"
import { requireRestoreActor } from "./restore-actor"
import { restoreFingerprint, type GuardedIO, type GuardedStep } from "./guarded-run"

/** GET and write transport for the guarded writer. It never acquires or refreshes a sign-in. */
export function guardedGraphIO(token: string, actor: RestoreActor, references: GuardedIO["references"], fetchImpl: typeof fetch = fetch, referenceScan?: GuardedIO["replacedReferences"]): GuardedIO {
  requireRestoreActor(token, actor)
  const contract = (step: GuardedStep) => {
    const row = restoreMatrixRow(step.folder)
    const write = row?.[step.operation]
    if (!row || !write || write.index !== "matched" || !write.properties.length || !write.permissions.length) throw new RestoreSafetyError("This write contract has not been verified against the Graph index and Microsoft documentation.")
    if (write.blockedReason) throw new RestoreSafetyError(write.blockedReason)
    const granted = grantedPermissions(token)
    const manifestBlocker = restorePermissionBlocker(step.folder, granted)
    if (manifestBlocker) throw new RestoreSafetyError(manifestBlocker)
    if (granted?.kind !== "delegated" || !write.permissions.some(permission => granted.permissions.has(permission))) throw new RestoreSafetyError("The signed-in connection lacks the write permission. Add restore access from Services in Settings, then sign in again.")
    if (step.properties.some(key => !write.properties.includes(key)) || Object.keys(step.desired).some(key => !write.properties.includes(key))) throw new RestoreSafetyError("The write contains properties outside the verified Graph contract.")
    return { row, write }
  }
  const request = async (url: string, method = "GET", body?: Item, etag?: string, beforeSend?: () => void): Promise<Item | null> => {
    requireRestoreActor(token, actor)
    const options: RequestInit = { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...(etag ? { "If-Match": etag } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) }
    beforeSend?.()
    const response = await fetchImpl(url, options)
    if (method === "GET" && response.status === 404) return null
    if (method !== "GET" && response.status >= 400 && response.status < 500 && response.status !== 408) throw new RestoreWriteRefusedError(response.status)
    if (!response.ok) throw new Error("Microsoft Graph did not confirm the restore request.")
    if (response.status === 204) return {}
    const value = await response.json() as Item
    const currentEtag = response.headers.get("etag")
    return currentEtag ? { ...value, "@odata.etag": currentEtag } : value
  }
  const pathOf = (step: GuardedStep, targetId?: string) => {
    const { row, write } = contract(step)
    if (targetId !== undefined && !isGraphId(targetId)) throw new RestoreSafetyError("The target object ID is invalid.")
    const root = `https://graph.microsoft.com/${write.version}/`
    if (/\{organizationId\}/.test(row.readPath)) throw new RestoreSafetyError("Resolve and verify the organization ID before restoring this type.")
    const path = row.detection.kind === "singleton" ? row.readPath : targetId ? `${row.readPath}/${encodeURIComponent(targetId)}` : undefined
    return { row, write, root, path }
  }
  return {
    token,
    ...(referenceScan ? { replacedReferences: referenceScan } : {}),
    type: folder => {
      const type = typeForFolder(folder)
      if (!type || type.restoreSafety !== "identity") throw new RestoreSafetyError("This writer accepts only registered identity configuration types.")
      return type
    },
    read: async (step, targetId) => {
      const { root, path } = pathOf(step, targetId ?? step.targetId ?? (step.operation === "update" ? step.sourceId : undefined))
      if (!path) {
        const matches = await find(step)
        if (matches.length > 1) throw new RestoreSafetyError("Create detection found an ambiguous match.")
        return matches[0] ?? null
      }
      return request(root + path)
    },
    findCreated: async (step, sent) => find(step, sent),
    references: async (step, current, desired): Promise<SafetyReferences> => {
      contract(step)
      if ([current, desired].some(value => value?.isBuiltIn === true || value?.policyType === "builtIn" || value?.source === "global" || (typeof value?.id === "string" && value.id.startsWith("microsoft-")))) throw new RestoreSafetyError("Built-in and Microsoft-managed objects are never restored.")
      return references(step, current, desired)
    },
    write: async (step, body, targetId, beforeSend) => {
      const type = typeForFolder(step.folder)
      if (!type || ["none", "metadata"].includes(restoreCapability(type)) || (restoreCapability(type) === "singleton" && step.operation === "create")) throw new RestoreSafetyError(type?.limitation ?? "This type cannot be restored.")
      const { row, write, root } = pathOf(step, targetId)
      if (Object.keys(body).some(key => !write.properties.includes(key))) throw new RestoreSafetyError("The write body contains properties outside the verified Graph contract.")
      // Directory and action-specific writers are intentionally deferred. This adapter cannot turn
      // a research row or a caller-provided path into permission to write them.
      if (row.disposition !== "configuration") throw new RestoreSafetyError("This type needs its own reviewed restore implementation.")
      let path = write.path
      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)]
      if (placeholders.length) {
        if (placeholders.length !== 1 || !targetId || placeholders[0]![1] === "organizationId") throw new RestoreSafetyError("The write path has an unresolved identity.")
        path = path.replace(placeholders[0]![0], encodeURIComponent(targetId))
      }
      const current = step.operation === "update" ? await request(root + (row.detection.kind === "singleton" ? row.readPath : `${row.readPath}/${encodeURIComponent(targetId!)}`)) : null
      if (step.operation === "update" && restoreFingerprint(current) !== step.preview) throw new RestoreSafetyError("The tenant changed after this preview. Preview this item again.")
      const response = await request(root + path, write.method, body, typeof current?.["@odata.etag"] === "string" ? current["@odata.etag"] : undefined, beforeSend)
      return { id: typeof response?.id === "string" ? response.id : targetId ?? (row.detection.kind === "singleton" ? step.sourceId : undefined) }
    },
  }

  async function find(step: GuardedStep, sent = step.desired): Promise<Item[]> {
    const { row, root } = pathOf(step)
    if (row.detection.kind === "singleton") { const current = await request(root + row.readPath); return current ? [current] : [] }
    if (row.detection.kind === "id") throw new RestoreSafetyError("This type has no verified create reconciliation key. Its create path remains blocked.")
    const keys = row.detection.properties ?? []
    if (!keys.length || keys.some(key => !(key in sent))) throw new RestoreSafetyError("The descriptor's create detection key is missing.")
    const type = typeForFolder(step.folder)!
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
      next = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined
    }
    return matches
  }
}
