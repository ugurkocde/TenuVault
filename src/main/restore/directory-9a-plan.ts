import { SortedSpool } from "../backup/sorted-spool"
import type { Item } from "../../shared/intune/registry"
import { isGuid } from "../../shared/security"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import { restoreFingerprint, type GuardedStep } from "./guarded-run"
import { cloudObject, directoryPayload, relationshipDifference } from "./directory-9a"
import type { directory9aIO } from "./directory-9a-io"

/** Object metadata precedes separately paged relationship previews. Recreated IDs must be resolved before the latter. */
export async function directoryObjectStep(folder: "Users" | "Groups", snapshot: Item, io: ReturnType<typeof directory9aIO>, guestRedirect?: string, mappedTargetId?: string): Promise<GuardedStep> {
  if (!isGuid(snapshot.id)) throw new RestoreSafetyError("The source directory object ID is missing.")
  cloudObject(snapshot)
  const located = await io.locate(folder, mappedTargetId ?? snapshot.id)
  if (mappedTargetId && located.action === "create") throw new RestoreSafetyError("The previously mapped directory object is missing. Resolve its mapping before recreating it.")
  const action = located.action === "create" && folder === "Users" && snapshot.userType === "Guest" ? "invite" : located.action
  let desired: Item
  if (action === "invite") {
    if (typeof snapshot.mail !== "string" || !guestRedirect || new URL(guestRedirect).protocol !== "https:") throw new RestoreSafetyError("Review a guest's invitation email address and HTTPS redirect before inviting them.")
    desired = { invitedUserEmailAddress: snapshot.mail, invitedUserDisplayName: String(snapshot.displayName ?? ""), inviteRedirectUrl: guestRedirect, sendInvitationMessage: false }
  } else desired = action === "recycle" ? { restored: true } : directoryPayload(folder, action, snapshot)
  return { key: `${folder}:${snapshot.id}:${action}`, folder, sourceId: snapshot.id, ...(located.action !== "create" ? { targetId: mappedTargetId ?? snapshot.id } : {}), operation: located.action === "create" ? "create" : "update", directory: { action }, desired, properties: Object.keys(desired), preview: restoreFingerprint(located.current), requires: [] }
}
/** Reference mappings can reorder IDs. Sort encrypted bounded runs before an exact comparison. */
export async function* mappedDirectoryIds(source: AsyncIterable<string>, map: (id: string) => Promise<string>, signal?: AbortSignal): AsyncGenerator<string> {
  const spool = new SortedSpool<{ id: string }>(500_000, signal)
  try {
    let page: Array<{ id: string }> = []
    for await (const id of source) {
      const target = await map(id)
      if (!isGuid(target)) throw new RestoreSafetyError("A principal mapping is unresolved.")
      page.push({ id: target.toLowerCase() })
      if (page.length === 1000) { await spool.add(page); page = [] }
    }
    await spool.add(page)
    for await (const entry of spool.entries()) yield entry.id
  } finally { await spool.close() }
}
export async function* directoryRelationshipSteps(folder: "Users" | "Groups", sourceId: string, targetId: string, snapshot: Item, io: ReturnType<typeof directory9aIO>, relationships?: { members: { saved: AsyncIterable<string>; current: AsyncIterable<string> }; owners: { saved: AsyncIterable<string>; current: AsyncIterable<string> }; exactMembers?: boolean; exactOwners?: boolean; savedIdsAreTargets?: boolean; signal?: AbortSignal; mapPrincipal: (source: string) => Promise<string> }): AsyncGenerator<GuardedStep> {
  if (!isGuid(sourceId) || !isGuid(targetId)) throw new RestoreSafetyError("Resolve the restored object ID before reviewing relationships.")
  const make = async (action: "manager" | "license" | "member" | "owner", desired: Item, principalId?: string, exact = false): Promise<GuardedStep> => {
    const step: GuardedStep = { key: `${folder}:${sourceId}:${action}:${principalId ?? JSON.stringify(desired)}`, folder, sourceId, targetId, operation: "update", directory: { action, ...(principalId ? { principalId } : {}), ...(exact ? { exact: true } : {}) }, desired, properties: Object.keys(desired), requires: [], ...(exact ? { allowRemoval: true } : {}), preview: "" }
    step.preview = restoreFingerprint(await io.read(step, targetId))
    return step
  }
  if (folder === "Users") {
    const manager = snapshot.manager as Item | undefined
    if (manager?.id) {
      if (manager.complete !== true || !isGuid(manager.id)) throw new RestoreSafetyError("The manager reference is incomplete.")
      const id = relationships ? await relationships.mapPrincipal(manager.id) : manager.id
      yield await make("manager", { principalId: id }, id)
    }
    if (Array.isArray(snapshot.assignedLicenses)) for (const license of snapshot.assignedLicenses) {
      const step = await make("license", { assignedLicenses: [license] })
      const current = await io.read(step, targetId)
      if (!(current?.assignedLicenses as Item[] | undefined)?.length) yield step
    }
  } else if (relationships) {
    for (const [action, streams, exact] of [["member", relationships.members, relationships.exactMembers], ["owner", relationships.owners, relationships.exactOwners]] as const) {
      if (action === "member" && Array.isArray(snapshot.groupTypes) && snapshot.groupTypes.includes("DynamicMembership")) continue
      const saved = relationships.savedIdsAreTargets ? streams.saved : mappedDirectoryIds(streams.saved, relationships.mapPrincipal, relationships.signal)
      for await (const change of relationshipDifference(saved, streams.current, exact)) {
        const id = change.id
        yield await make(action, { principalId: id, present: change.present }, id, exact)
      }
    }
  }
}
