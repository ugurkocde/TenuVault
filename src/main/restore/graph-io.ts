import { accessPackageCatalogSnapshot } from "../../shared/intune/entra-snapshot"
import { checkConfigurationLockout, configurationPayload, isEntraConfiguration, requireConfigurationApproval } from "./entra-configuration"
import { safetyReader } from "./safety-reader"
import { restorePermissionBlocker } from "../../shared/services/modules"
import { isGraphId, normalizeGuid } from "../../shared/security"
import { restoreCapability, typeForFolder, type Item } from "../../shared/intune/registry"
import { findCreatedByDescriptor } from "./create-detection"
import { restoreMatrixRow, verifiedWriteContract } from "../../shared/intune/restore-matrix"
import { addsOnlyPayload, RestoreSafetyError, RestoreWriteRefusedError, type RestoreActor, type SafetyReferences } from "../../shared/intune/restore-guards"
import { requireRestoreActor, restorePermissions, type RestoreAuthorization } from "./restore-actor"
import { restoreFingerprint, type GuardedIO, type GuardedStep } from "./guarded-run"

/** GET and write transport for the guarded writer. It never acquires or refreshes a sign-in. */
export function guardedGraphIO(token: string, actor: RestoreActor, references: GuardedIO["references"], fetchImpl: typeof fetch = fetch, referenceScan?: GuardedIO["replacedReferences"], authorization?: RestoreAuthorization): GuardedIO {
  requireRestoreActor(token, actor, authorization)
  const contract = (step: GuardedStep) => {
    const row = restoreMatrixRow(step.folder)
    const write = row?.[step.operation]
    if (!row || !write || !verifiedWriteContract(write) || !write.properties.length || !write.permissions.length) throw new RestoreSafetyError("This write contract has not been verified against the Graph index and Microsoft documentation.")
    if (write.blockedReason) throw new RestoreSafetyError(write.blockedReason)
    const granted = restorePermissions(token, authorization?.scopes)
    const manifestBlocker = restorePermissionBlocker(step.folder, granted)
    if (manifestBlocker) throw new RestoreSafetyError(manifestBlocker)
    if (granted?.kind !== "delegated" || !write.permissions.some(permission => granted.permissions.has(permission))) throw new RestoreSafetyError("The signed-in connection lacks the write permission. Add restore access from Services in Settings, then sign in again.")
    if (step.properties.some(key => !write.properties.includes(key)) || Object.keys(step.desired).some(key => !write.properties.includes(key))) throw new RestoreSafetyError("The write contains properties outside the verified Graph contract.")
    return { row, write }
  }
  const request = async (url: string, method = "GET", body?: Item, etag?: string, beforeSend?: () => void): Promise<Item | null> => {
    requireRestoreActor(token, actor, authorization)
    const options: RequestInit = { method, headers: { Authorization: `Bearer ${token}`, ...(new URL(url).pathname.endsWith("/branding") ? { "Accept-Language": "0" } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...(etag ? { "If-Match": etag } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) }
    beforeSend?.()
    const response = await fetchImpl(url, options)
    if (method === "GET" && response.status === 404) return null
    if (method !== "GET" && response.status >= 400 && response.status < 500 && response.status !== 408) throw new RestoreWriteRefusedError(response.status)
    if (!response.ok) throw new Error("Microsoft Graph did not confirm the restore request.")
    if (response.status === 204) return {}
    const value = await response.json() as Item
    if (new URL(url).pathname.endsWith("/branding") && value.usernameHintText === "") value.usernameHintText = null
    const snapshot = new URL(url).pathname.includes("/accessPackageCatalogs") ?
      Array.isArray(value.value) ? { ...value, value: (value.value as Item[]).map(accessPackageCatalogSnapshot) } : accessPackageCatalogSnapshot(value)
      : value
    const currentEtag = response.headers.get("etag")
    return currentEtag ? { ...snapshot, "@odata.etag": currentEtag } : snapshot
  }
  const pathOf = (step: GuardedStep, targetId?: string) => {
    const { row, write } = contract(step)
    if (targetId !== undefined && !isGraphId(targetId)) throw new RestoreSafetyError("The target object ID is invalid.")
    const root = `https://graph.microsoft.com/${write.version}/`
    const path = row.detection.kind === "singleton" ? row.readPath : targetId ? `${row.readPath}/${encodeURIComponent(targetId)}` : undefined
    return { row, write, root, path }
  }
  const resolvedPathOf = async (step: GuardedStep, targetId?: string) => {
    const result = pathOf(step, targetId)
    if (step.folder === "Organization" && targetId && normalizeGuid(targetId) !== normalizeGuid(actor.tenantId)) throw new RestoreSafetyError("Organization restore must target the connected tenant ID.")
    if (step.folder === "Organization" || result.row.readPath.includes("{organizationId}")) {
      const organizations = await request(result.root + "organization?$select=id")
      const id = Array.isArray(organizations?.value) && organizations.value.length === 1 ? (organizations.value[0] as Item)?.id : undefined
      if (typeof id !== "string" || normalizeGuid(id) !== normalizeGuid(actor.tenantId)) throw new RestoreSafetyError("The connected tenant organization could not be uniquely resolved.")
      result.path = step.folder === "Organization" ? `organization/${encodeURIComponent(actor.tenantId)}` : result.row.readPath.replace("{organizationId}", encodeURIComponent(actor.tenantId))
    }
    return result
  }
  return {
    token, authorization,
    ...(referenceScan ? { replacedReferences: referenceScan } : {}),
    type: folder => {
      const type = typeForFolder(folder)
      if (!type || type.restoreSafety !== "identity") throw new RestoreSafetyError("This writer accepts only registered identity configuration types.")
      return type
    },
    read: async (step, targetId) => {
      const { root, path } = await resolvedPathOf(step, targetId ?? step.targetId ?? (step.operation === "update" ? step.sourceId : undefined))
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
      if (step.folder === "UserFlowAttributes" && current && current.userFlowAttributeType !== "custom") throw new RestoreSafetyError("The live attribute is built-in or its custom type could not be resolved.")
      if ([current, desired].some(value => value?.isBuiltIn === true || (step.folder === "UserFlowAttributes" && value?.userFlowAttributeType !== undefined && value.userFlowAttributeType !== "custom") || value?.policyType === "builtIn" || value?.source === "global" || (typeof value?.id === "string" && value.id.startsWith("microsoft-")))) throw new RestoreSafetyError("Built-in and Microsoft-managed objects are never restored.")
      return references(step, current, desired)
    },
    write: async (step, body, targetId, beforeSend, run) => {
      if (["Users", "Groups"].includes(step.folder)) throw new RestoreSafetyError("Use the separate directory review and batch executor.")
      const type = typeForFolder(step.folder)
      if (!type || ["none", "metadata"].includes(restoreCapability(type)) || (restoreCapability(type) === "singleton" && step.operation === "create")) throw new RestoreSafetyError(type?.limitation ?? "This type cannot be restored.")
      const { row, write, root, path: readPath } = await resolvedPathOf(step, targetId)
      if (Object.keys(body).some(key => !write.properties.includes(key))) throw new RestoreSafetyError("The write body contains properties outside the verified Graph contract.")
      if (isEntraConfiguration(step.folder)) {
        requireConfigurationApproval(step, run)
        const rebuilt = configurationPayload(step.folder, step.operation, body)
        if (restoreFingerprint(rebuilt) !== restoreFingerprint(body)) throw new RestoreSafetyError("Configuration activation requires separate approval. Restore must keep execution disabled.")
      }
      // Directory and action-specific writers are intentionally deferred. This adapter cannot turn
      // a research row or a caller-provided path into permission to write them.
      if (row.disposition !== "configuration") throw new RestoreSafetyError("This type needs its own reviewed restore implementation.")
      let path = write.path
      if (step.folder === "Organization") path = `organization/${encodeURIComponent(actor.tenantId)}`
      else path = path.replace("{organizationId}", encodeURIComponent(actor.tenantId))
      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)]
      if (placeholders.length) {
        if (placeholders.length !== 1 || !targetId || placeholders[0]![1] === "organizationId") throw new RestoreSafetyError("The write path has an unresolved identity.")
        path = path.replace(placeholders[0]![0], encodeURIComponent(targetId))
      }
      if (step.operation === "update" && !readPath) throw new RestoreSafetyError("The update path has no resolved target identity.")
      const current = step.operation === "update" ? await request(root + readPath!) : null
      if (step.folder === "UserFlowAttributes" && step.operation === "update" && current?.userFlowAttributeType !== "custom") throw new RestoreSafetyError("The live attribute is built-in or its custom type could not be resolved.")
      if (step.operation === "update" && restoreFingerprint(current) !== step.preview) throw new RestoreSafetyError("The tenant changed after this preview. Preview this item again.")
      if (isEntraConfiguration(step.folder) && restoreFingerprint(body) !== restoreFingerprint(addsOnlyPayload(current, step.desired, step.allowRemoval))) throw new RestoreSafetyError("The write no longer matches the confirmed configuration difference.")
      await checkConfigurationLockout(safetyReader(token, fetchImpl), step, current, body)
      let wireBody = body
      if (step.folder === "AccessPackageCatalogs" && Object.hasOwn(body, "state")) {
        const { state, ...metadata } = body
        if (state !== "unpublished") throw new RestoreSafetyError("The catalog must remain unpublished.")
        wireBody = { ...metadata, catalogStatus: "Unpublished" }
      }
      const response = await request(root + path, write.method, wireBody, typeof current?.["@odata.etag"] === "string" ? current["@odata.etag"] : undefined, beforeSend)
      return { id: typeof response?.id === "string" ? response.id : targetId ?? (row.detection.kind === "singleton" ? step.sourceId : undefined) }
    },
  }

  async function find(step: GuardedStep, sent = step.desired): Promise<Item[]> {
    const { row } = pathOf(step)
    return findCreatedByDescriptor(row, sent, request)
  }
}
