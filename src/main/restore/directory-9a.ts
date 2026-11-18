import { randomBytes } from "node:crypto"
import type { Item } from "../../shared/intune/registry"
import { RestoreSafetyError, guardRestoreItem, type RestoreActor } from "../../shared/intune/restore-guards"
import { restoreFingerprint, type GuardedRun, type GuardedStep } from "./guarded-run"

export type DirectoryAction = "create" | "update" | "recycle" | "invite" | "member" | "owner" | "manager" | "license"
export interface DirectoryIntent {
  action: DirectoryAction
  principalId?: string
  /** Exact membership/ownership is selected for this resource, never the whole run. */
  exact?: boolean
}
export interface DirectoryReview {
  principal: { id: string; name: string; type: string } | null
  resource: { id: string; name: string; type: string }
  privilege: string
  scope: string
  approvals: string[]
  notices: string[]
  blocker?: string
  roleAssignable: boolean
  changes: Array<{ property: string; before: unknown; after: unknown }>
}
export const DIRECTORY_9A_BLOCKER = "Directory restore is staged. Live lab lifecycle and cleanup evidence are required before this operation is admitted."
export const NEVER_RESTORED = {
  "Application and service principal credentials": "Secrets and private keys were never backed up.",
  "Federated identity credentials": "Trust credentials must be established again by the owner.",
  "User passwords and authentication methods": "Sign-in credentials were never backed up. A recreated account needs sign-in setup in Entra.",
  "Dynamic group members": "Membership follows the restored rule and is not written directly.",
  "Microsoft first-party service principals": "Microsoft manages these service identities.",
  "Activated PIM instances": "An activation cannot be replayed as an assignment or eligibility.",
  "On-premises synchronized objects": "The source directory owns these objects, including formerly synced identities.",
  Devices: "Devices are created by device registration.",
  Domains: "Domain ownership and federation cannot be recovered by replaying a backup.",
} as const
const fail = (message: string): never => { throw new RestoreSafetyError(message) }
export function cloudObject(snapshot: Item): void {
  if (snapshot.onPremisesSyncEnabled === true || snapshot.onPremisesImmutableId || snapshot.onPremisesLastSyncDateTime) fail(NEVER_RESTORED["On-premises synchronized objects"])
}
const strings = (source: Item, fields: readonly string[]): Item => Object.fromEntries(fields.filter(key => source[key] !== undefined).map(key => {
  const value = source[key]
  if (value !== null && typeof value !== "string") fail("A directory property has an unsupported value.")
  return [key, value!]
}))
/** The password exists only in the final transport body, never in a step, preview or journal. */
export function disabledUserBody(body: Item): Item {
  return { ...body, accountEnabled: false, passwordProfile: { password: randomBytes(48).toString("base64url") + "aA1!", forceChangePasswordNextSignIn: true } }
}
export function directoryPayload(folder: string, action: "create" | "update", source: Item): Item {
  cloudObject(source)
  if (folder === "Users") {
    if (source.userType === "Guest") fail("Guests must be restored through an invitation, not user creation.")
    const input = action === "create" && !source.mailNickname && typeof source.userPrincipalName === "string" ? { ...source, mailNickname: source.userPrincipalName.split("@")[0]!.slice(0, 64) } : source
    const result = strings(input, ["displayName", "givenName", "surname", "jobTitle", "department", "officeLocation", "usageLocation", ...(action === "create" ? ["mailNickname", "userPrincipalName"] : [])])
    if (action === "create") {
      if (!["displayName", "mailNickname", "userPrincipalName"].every(key => typeof result[key] === "string" && result[key])) fail("User creation needs a name, alias and UPN.")
      result.accountEnabled = false
    } else if (source.accountEnabled !== undefined) {
      if (typeof source.accountEnabled !== "boolean") fail("The account state must be explicit.")
      result.accountEnabled = source.accountEnabled
    }
    return result
  }
  if (folder !== "Groups") fail("This is not a staged directory type.")
  if (!Array.isArray(source.groupTypes) || source.groupTypes.some(value => !["Unified", "DynamicMembership"].includes(String(value)))) fail("The group type could not be resolved.")
  const groupTypes = source.groupTypes as string[]
  const unified = groupTypes.includes("Unified")
  if (!unified && (source.mailEnabled !== false || source.securityEnabled !== true)) fail("Mail-enabled security and distribution groups cannot be restored through Graph.")
  const result = strings(source, ["displayName", "description", ...(action === "create" ? ["mailNickname"] : [])])
  if (groupTypes.includes("DynamicMembership")) {
    if (typeof source.membershipRule !== "string" || !source.membershipRule) fail("A dynamic group needs its rule.")
    result.membershipRule = source.membershipRule!; result.membershipRuleProcessingState = "On"
  }
  if (action === "create") {
    if (!result.displayName || !result.mailNickname) fail("Group creation needs a name and alias.")
    Object.assign(result, { groupTypes: source.groupTypes, mailEnabled: unified, securityEnabled: source.securityEnabled === true })
    if (source.isAssignableToRole === true) {
      if (groupTypes.includes("DynamicMembership") || source.securityEnabled !== true) fail("Role-assignable groups must be static security groups.")
      result.isAssignableToRole = true; result.visibility = "Private"
    }
  }
  return result
}
export const directoryApproval = (step: GuardedStep, run: Pick<GuardedRun, "id" | "tenant" | "actor" | "origin" | "source">, kind: string): string => restoreFingerprint({
  run: run.id, tenant: run.tenant, actor: { ...run.actor, recoveryAccountIds: [] }, origin: run.origin, source: run.source ?? null,
  step: { ...step, directoryApprovals: undefined }, kind,
} as unknown as Item)
export function approveDirectory(step: GuardedStep, run: GuardedRun, kind: string): void {
  step.directoryApprovals ??= {}
  step.directoryApprovals[kind] = directoryApproval(step, run, kind)
}
export function requireDirectoryApprovals(step: GuardedStep, run: GuardedRun | undefined, kinds: string[]): void {
  if (!run || kinds.some(kind => step.directoryApprovals?.[kind] !== directoryApproval(step, run, kind))) fail("Approve each directory relationship and security response separately from its current preview.")
}
export function directoryReview(step: GuardedStep, live: Item | null, principal: Item | null, actor: RestoreActor, excludedFromCA: boolean): DirectoryReview {
  const intent = step.directory ?? fail("A directory intent is required.")
  const resource = { id: step.targetId ?? step.sourceId, name: String(live?.displayName ?? step.desired.displayName ?? "Unresolved resource"), type: step.folder === "Users" ? "user" : "group" }
  const person = principal && typeof principal.id === "string" && typeof principal.displayName === "string" && typeof principal["@odata.type"] === "string"
    ? { id: principal.id, name: principal.displayName, type: principal["@odata.type"].replace("#microsoft.graph.", "") } : null
  const approvals = ["directory-item"], notices: string[] = []
  let blocker: string | undefined
  const relationship = ["member", "owner", "manager"].includes(intent.action)
  if (relationship && !person) blocker = "The principal no longer resolves to a name and type. This item is blocked."
  if (intent.action === "member" && Array.isArray(live?.groupTypes) && live.groupTypes.includes("DynamicMembership")) blocker = NEVER_RESTORED["Dynamic group members"]
  if (person && !["user", "group"].includes(person.type)) blocker = "This principal type needs its own verified permission contract."
  if (person && ["owner", "manager"].includes(intent.action) && person.type !== "user") blocker = "This relationship requires a user principal. Other types need a separate verified contract."
  const roleAssignable = live?.isAssignableToRole === true || step.desired.isAssignableToRole === true
  const privileged = roleAssignable || excludedFromCA
  if (roleAssignable) notices.push("This group can confer a directory role.")
  if (excludedFromCA) notices.push("This group is excluded from Conditional Access policies.")
  if ((["member", "owner"].includes(intent.action) && privileged) || step.desired.isAssignableToRole === true) approvals.push("privileged-relationship")
  if ((intent.action === "update" && live?.accountEnabled === false && step.desired.accountEnabled === true) || (["member", "owner"].includes(intent.action) && privileged && step.desired.present === true)) {
    approvals.push("security-response"); notices.push("The current state looks deliberate. This restore may undo a security response.")
  }
  if (["member", "owner"].includes(intent.action) && step.desired.present === false) {
    if (!intent.exact || !step.allowRemoval) blocker = "Removal requires exact membership or ownership for this group."
    approvals.push("exact-group")
  }
  if (intent.action === "recycle") {
    approvals.push("security-response", "recycle-relationships")
    notices.push("Recycle-bin restore keeps the ID and can recover previous relationships and account state. Review these as a possible reversal of a security response.")
  }
  if (intent.action === "create") notices.push("Recreation gets a new ID. Review policy references to the old ID before activation.")
  if (step.folder === "Users" && intent.action === "create") notices.push("The user starts disabled. Set up sign-in and enable the account in Entra. The random password is never retained or shown.")
  const groupTypes = live?.groupTypes ?? step.desired.groupTypes
  if (step.folder === "Groups" && Array.isArray(groupTypes) && groupTypes.includes("Unified")) notices.push("Only the Microsoft 365 directory object is restored. Teams, SharePoint and mailbox content are not restored.")
  try {
    guardRestoreItem(actor, step.folder, step.targetId ?? step.sourceId, { complete: true, principals: person ? [person.id] : [], applications: [] }, false, ["identity-references"])
  } catch (error) { blocker = (error as Error).message }
  return { roleAssignable, changes: Object.entries(step.desired).filter(([key, value]) => JSON.stringify(live?.[key]) !== JSON.stringify(value)).map(([property, after]) => ({ property, before: live?.[property] ?? null, after })), principal: person, resource, privilege: intent.action, scope: `${actor.tenantId}/${resource.type}/${resource.id}`, approvals, notices, ...(blocker ? { blocker } : {}) }
}

/** Sorted ID streams permit a merge difference without retaining a 50,000-member collection. */
export async function* relationshipDifference(saved: AsyncIterable<string>, current: AsyncIterable<string>, exact = false): AsyncGenerator<{ id: string; present: boolean }> {
  async function* checked(input: AsyncIterable<string>) {
    let previous = ""
    for await (const id of input) {
      if (id <= previous) fail("Relationship ID streams must be sorted and unique.")
      previous = id; yield id
    }
  }
  const a = checked(saved)[Symbol.asyncIterator](), b = checked(current)[Symbol.asyncIterator]()
  let left = await a.next(), right = await b.next()
  try {
    while (!left.done || !right.done) {
      if (right.done || (!left.done && left.value < right.value)) { yield { id: left.value!, present: true }; left = await a.next() }
      else if (left.done || right.value < left.value) { if (exact) yield { id: right.value, present: false }; right = await b.next() }
      else { left = await a.next(); right = await b.next() }
    }
  } finally { await Promise.allSettled([a.return(undefined), b.return(undefined)]) }
}
export async function previewDirectoryPage<T>(rows: AsyncIterable<T>, limit = 50): Promise<T[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("A directory preview page must contain 1 to 100 rows.")
  const page: T[] = []
  for await (const row of rows) { page.push(row); if (page.length === limit) break }
  return page
}
