import { createHash } from "node:crypto"
import type { Item } from "../../shared/intune/registry"
import { LARGE_SHARD_ITEMS, relationPath } from "../../shared/large-backup"
import { directoryObjectId } from "../../shared/intune/entra-directory"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import { appIdentity, appPayload, APP_POLICY_REFERENCES, restorableApp } from "./directory-9b"
import { isRestorePersistenceError, restoreFingerprint, type GuardedStep } from "./guarded-run"
import type { directory9bIO } from "./directory-9b-io"

type IO = ReturnType<typeof directory9bIO>
export async function applicationObjectStep(folder: string, snapshot: Item, io: IO, readSource: (folder: string, id: string) => Promise<Item>, mapped?: string): Promise<GuardedStep> {
  if (!directoryObjectId(folder, snapshot.id)) throw new RestoreSafetyError("The application source identity is missing.")
  if (folder === "OAuth2PermissionGrants") return consentStep(snapshot, io, readSource)
  restorableApp(snapshot, folder)
  const located = await io.locate(folder, mapped ?? snapshot.id as string)
  const expectedAppId = appIdentity(snapshot.appId)
  if (located.current && appIdentity(located.current.appId) !== expectedAppId) throw new RestoreSafetyError("The saved application app ID does not match the live target.")
  if (mapped && located.action === "create") throw new RestoreSafetyError("The mapped application is missing. Resolve its mapping before recreation.")
  const gallery = folder === "ServicePrincipals" && Array.isArray(snapshot.tags) && snapshot.tags.includes("WindowsAzureActiveDirectoryGalleryApplicationPrimaryV1")
  const action = located.action === "create" && gallery ? "gallery" : located.action
  // Backup v1 does not capture template provenance. Never guess a gallery template from its name.
  const unresolved = gallery && action === "gallery" ? "Gallery recreation requires verified applicationTemplateId provenance. This backup does not contain it." : undefined
  const desired = action === "recycle" ? { restored: true } : appPayload(folder, action, snapshot)
  const metadataNotices = action === "update" ? ["displayName", "description"].filter(field => snapshot[field] !== undefined && (typeof snapshot[field] !== "string" || !(snapshot[field] as string).trim())).map(field => `${field}: clearing a null or empty value is blocked. Only nonempty metadata changes are offered.`) : []
  return { key: `${folder}:${snapshot.id}:${action}`, folder, sourceId: snapshot.id as string, ...(located.action === "create" ? {} : { targetId: mapped ?? snapshot.id as string }), operation: located.action === "create" ? "create" : "update", directory: { action, expectedAppId, ...(metadataNotices.length ? { metadataNotices } : {}), ...(unresolved ? { unresolved } : {}) }, desired, properties: Object.keys(desired), preview: restoreFingerprint(located.current), requires: [] }
}
async function appRef(id: unknown, io: IO, readSource: (folder: string, id: string) => Promise<Item>) {
  const saved = await readSource("ServicePrincipals", appIdentity(id))
  if (String(saved.id).toLowerCase() !== appIdentity(id)) throw new RestoreSafetyError("The saved application reference did not match.")
  return io.resolveApp(appIdentity(saved.appId))
}
async function consentStep(snapshot: Item, io: IO, readSource: (folder: string, id: string) => Promise<Item>): Promise<GuardedStep> {
  const client = await appRef(snapshot.clientId, io, readSource), resource = await appRef(snapshot.resourceId, io, readSource)
  if (!["Principal", "AllPrincipals"].includes(String(snapshot.consentType)) || typeof snapshot.scope !== "string" || !snapshot.scope.trim()) throw new RestoreSafetyError("Consent type and scopes must be explicit.")
  if (snapshot.consentType === "AllPrincipals" && snapshot.principalId !== null) throw new RestoreSafetyError("Tenant-wide consent must not have a principal ID.")
  if (snapshot.consentType === "Principal") throw new RestoreSafetyError("Principal-specific consent needs a verified typed user mapping. Raw saved principal IDs are never replayed.")
  const desired = { clientId: client.id!, resourceId: resource.id!, principalId: null, consentType: snapshot.consentType!, scope: snapshot.scope }
  const step: GuardedStep = { key: `OAuth2PermissionGrants:${snapshot.id}:consent`, folder: "OAuth2PermissionGrants", sourceId: snapshot.id as string, operation: "create", directory: { action: "consent", clientAppId: appIdentity(client.appId), resourceAppId: appIdentity(resource.appId) }, desired, properties: Object.keys(desired), preview: "", requires: [] }
  const current = await io.read(step)
  if (current) { step.operation = "update"; step.targetId = current.id as string }
  step.preview = restoreFingerprint(current)
  return step
}
/** Read the same bounded, authenticated relationship shards as 9a. Verify before publishing any page. */
async function* savedRelationships(path: string, snapshot: Item, kind: string, read: (path: string) => Promise<unknown>, ids: boolean) {
  const declaration = snapshot[kind] as Item | undefined
  if (!declaration || declaration.complete !== true || declaration.format !== (ids ? "sorted-id-shards-v1" : "sorted-object-shards-v1") || !Number.isSafeInteger(declaration.count) || Number(declaration.count) < 0 || Number(declaration.count) > 500_000 || declaration.shards !== Math.ceil(Number(declaration.count) / LARGE_SHARD_ITEMS)) throw new RestoreSafetyError("The saved application relationship inventory is incomplete.")
  const hash = createHash("sha256")
  let previous = ""
  for (let part = 0; part < Number(declaration.shards); part++) {
    const rows = await read(path.split("/")[0] + "/" + relationPath(path.split("/")[1]!, snapshot.id as string, kind, part))
    if (!Array.isArray(rows) || rows.length !== Math.min(LARGE_SHARD_ITEMS, Number(declaration.count) - part * LARGE_SHARD_ITEMS)) throw new RestoreSafetyError("Invalid application relationship shard.")
    for (const row of rows) {
      const id = ids ? row : row?.id
      if (typeof id !== "string" || id <= previous) throw new RestoreSafetyError("Invalid application relationship order.")
      previous = id; hash.update(JSON.stringify(row) + "\n"); yield row as string | Item
    }
  }
  if (hash.digest("hex") !== declaration.hash) throw new RestoreSafetyError("The application relationship fingerprint did not match.")
}
export async function* applicationRelationshipSteps(path: string, snapshot: Item, targetId: string, io: IO, read: (path: string) => Promise<unknown>, readSource: (folder: string, id: string) => Promise<Item>): AsyncGenerator<GuardedStep> {
  const folder = path.split("/")[1]!
  const make = (suffix: string, action: "owner" | "app-role" | "policy", desired: Item): GuardedStep => ({ key: `${folder}:${snapshot.id}:${suffix}`, folder, sourceId: snapshot.id as string, targetId, operation: "update", directory: { action }, desired, properties: Object.keys(desired), preview: "", requires: [] })
  for await (const id of savedRelationships(path, snapshot, "owners", read, true)) {
    const step = make("owner:" + id, "owner", { present: true, principalId: appIdentity(id) })
    step.directory!.principalId = appIdentity(id)
    yield step
  }
  if (folder !== "ServicePrincipals") return
  for (const kind of ["appRoleAssignments", "appRoleAssignedTo"]) for await (const row of savedRelationships(path, snapshot, kind, read, false)) {
    const saved = row as Item
    const step = make(`${kind}:${saved.id}`, "app-role", {})
    try {
      const resource = await readSource("ServicePrincipals", appIdentity(saved.resourceId)), principal = await readSource("ServicePrincipals", appIdentity(saved.principalId))
      if (resource.id !== saved.resourceId || principal.id !== saved.principalId) throw new RestoreSafetyError("The saved relationship references did not match.")
      step.directory = { action: "app-role", clientAppId: appIdentity(principal.appId), resourceAppId: appIdentity(resource.appId) }
      step.desired = { appRoleId: appIdentity(saved.appRoleId) }; step.properties = Object.keys(step.desired)
      // Resolve live endpoints only for the current review page. Inventory storage retains app IDs.
      step.sourceId = String(saved.id); step.operation = "create"; delete step.targetId
    } catch (error) {
      if (isRestorePersistenceError(error)) throw error
      step.directory!.unresolved = error instanceof RestoreSafetyError ? error.message : "A saved principal is unresolved. This item is blocked."
    }
    yield step
  }
  for (const [kind, dependency] of Object.entries(APP_POLICY_REFERENCES)) {
    if (!snapshot[kind]) continue
    for await (const id of savedRelationships(path, snapshot, kind, read, true)) {
      const step = make(`${kind}:${id}`, "policy", { policyId: appIdentity(id), configurationFolder: dependency })
      step.directory!.unresolved = `Resolve the ${dependency} layer 8 configuration mapping before binding this policy. Policy contents are never replayed as app properties.`
      yield step
    }
  }
}
