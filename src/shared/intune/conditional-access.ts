import type { Item, Json, ReviewChange, Step } from "./registry"

/**
 * Entra Conditional Access: how policies, named locations and authentication strengths are made safe
 * to restore. Verified against Microsoft Graph beta with test objects (created, patched and deleted):
 *
 * - A policy write rejects the expanded `grantControls.authenticationStrength` object that reads return
 *   (error 1007); only `{ id }` is accepted.
 * - Graph accepts user, group and named location IDs that do not exist and stores them silently, so a
 *   restored exclusion of a deleted break-glass account would protect nobody. References are checked
 *   by TenuVault before writing.
 * - A PATCH of `conditions` merges, so a property left out keeps its live value; restores send the
 *   whole snapshot.
 * - Authentication strength names are at most 30 characters; PATCH accepts only displayName and
 *   description (allowedCombinations returns 405) and combinations change through
 *   updateAllowedCombinations; combination configurations are their own collection.
 */

/** The state of a policy that is evaluated but never blocks or grants anything. */
export const REPORT_ONLY = "enabledForReportingButNotEnforced"

const ENFORCEMENT: Record<string, number> = { disabled: 0, [REPORT_ONLY]: 1, enabled: 2 }
const rank = (state: Json | undefined) => (typeof state === "string" && state in ENFORCEMENT ? ENFORCEMENT[state]! : 1)

/**
 * The state a created policy gets: never enforced. An enabled policy comes back in report-only mode so a
 * restore can never lock anyone out; the admin turns it on in Entra after checking its sign-in impact.
 */
export function createState(backup: Json | undefined): string {
  return backup === "disabled" ? "disabled" : REPORT_ONLY
}

/**
 * The state written when replacing a live policy: the backed-up state, but never more enforcement than
 * the policy has now. Putting back an enabled policy that is now off or report-only writes report-only.
 */
export function replaceState(backup: Json | undefined, live: Json | undefined): string {
  const wanted = typeof backup === "string" && backup in ENFORCEMENT ? backup : REPORT_ONLY
  return rank(wanted) > Math.max(rank(live), ENFORCEMENT[REPORT_ONLY]!) ? REPORT_ONLY : wanted
}

/** Microsoft creates and maintains these policies; admins can only change their state and exclusions. */
export function isMicrosoftManaged(item: Item): boolean {
  return typeof item.displayName === "string" && /^microsoft-managed:/i.test(item.displayName.trim())
}

export const MICROSOFT_MANAGED =
  "Microsoft creates and maintains this policy, so TenuVault keeps it for drift detection only and never recreates or overwrites it. Change its state or exclusions in Entra."

const object = (value: Json | undefined): Item | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Item) : undefined)
const strings = (value: Json | undefined): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [])
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Service-wide IDs every tenant shares: built-in authentication strengths and the MFA trusted IPs location. */
const BUILT_IN = /^00000000-0000-0000-0000-0000000000[0-9a-f]{2}$/i

/** The policy body a write accepts: the authentication strength as a reference only. */
export function policyBody(payload: Item): Item {
  const grant = object(payload.grantControls)
  if (grant) {
    const strength = object(grant.authenticationStrength)
    grant.authenticationStrength = strength && typeof strength.id === "string" ? { id: strength.id } : null
  }
  return payload
}

export type ReferenceKind = "user" | "group" | "role" | "application" | "servicePrincipal" | "namedLocation" | "authenticationStrength" | "termsOfUse"

export interface PolicyReference {
  kind: ReferenceKind
  id: string
  /** Where it sits, such as conditions.users.excludeGroups. */
  path: string
  /** An exclusion: if the object is gone, the exclusion protects nobody. */
  exclude: boolean
}

/**
 * Every tenant object a policy points to by ID. Keywords such as All, None, GuestsOrExternalUsers,
 * Office365 or AllTrusted, and service-wide built-in IDs, are not references.
 */
export function policyReferences(policy: Item): PolicyReference[] {
  const references: PolicyReference[] = []
  const conditions = object(policy.conditions) ?? {}
  const add = (kind: ReferenceKind, parent: Item | undefined, base: string, key: string) => {
    for (const id of strings(parent?.[key])) {
      if (GUID.test(id) && !BUILT_IN.test(id)) references.push({ kind, id, path: `${base}.${key}`, exclude: key.startsWith("exclude") })
    }
  }
  const users = object(conditions.users)
  for (const key of ["includeUsers", "excludeUsers"]) add("user", users, "conditions.users", key)
  for (const key of ["includeGroups", "excludeGroups"]) add("group", users, "conditions.users", key)
  for (const key of ["includeRoles", "excludeRoles"]) add("role", users, "conditions.users", key)
  const applications = object(conditions.applications)
  for (const key of ["includeApplications", "excludeApplications"]) add("application", applications, "conditions.applications", key)
  const clients = object(conditions.clientApplications)
  for (const key of ["includeServicePrincipals", "excludeServicePrincipals"]) add("servicePrincipal", clients, "conditions.clientApplications", key)
  const locations = object(conditions.locations)
  for (const key of ["includeLocations", "excludeLocations"]) add("namedLocation", locations, "conditions.locations", key)
  const grant = object(policy.grantControls)
  const strength = object(grant?.authenticationStrength)
  if (typeof strength?.id === "string" && GUID.test(strength.id) && !BUILT_IN.test(strength.id)) {
    references.push({ kind: "authenticationStrength", id: strength.id, path: "grantControls.authenticationStrength", exclude: false })
  }
  add("termsOfUse", grant, "grantControls", "termsOfUse")
  return references
}

/**
 * Where a reference is read back to check that it exists. Roles and applications are left out: their
 * IDs are mostly service-wide (role templates, Microsoft app IDs) and reading them needs directory
 * permissions TenuVault does not ask for.
 */
export function referencePath(reference: PolicyReference): string | undefined {
  const id = encodeURIComponent(reference.id)
  switch (reference.kind) {
    case "user": return `users/${id}?$select=id`
    case "group": return `groups/${id}?$select=id`
    case "servicePrincipal": return `servicePrincipals/${id}?$select=id`
    case "namedLocation": return `identity/conditionalAccess/namedLocations/${id}`
    case "authenticationStrength": return `identity/conditionalAccess/authenticationStrength/policies/${id}`
    default: return undefined
  }
}

/** Kinds whose IDs only exist in the tenant they were made in, so a copy to another tenant needs them recreated or mapped. */
export const TENANT_KINDS: ReadonlySet<ReferenceKind> = new Set(["user", "group", "servicePrincipal", "namedLocation", "authenticationStrength", "termsOfUse"])

const KIND_LABEL: Record<ReferenceKind, string> = {
  user: "user",
  group: "group",
  role: "role",
  application: "app",
  servicePrincipal: "workload identity",
  namedLocation: "named location",
  authenticationStrength: "authentication strength",
  termsOfUse: "terms of use",
}

export const referenceLabel = (reference: PolicyReference) => `${reference.exclude ? "excluded" : "included"} ${KIND_LABEL[reference.kind]} ${reference.id}`.replace(/^included (named location|authentication strength|terms of use)/, "$1")

const KIND_PLURAL: Record<ReferenceKind, string> = {
  user: "users",
  group: "groups",
  role: "roles",
  application: "apps",
  servicePrincipal: "workload identities",
  namedLocation: "named locations",
  authenticationStrength: "authentication strengths",
  termsOfUse: "terms of use",
}

/** "a", "a and b", "a, b and c". */
const listed = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`)

/** Kinds that decide who a policy applies to: users, groups and workload identities. */
const ASSIGNEE_KINDS: ReadonlySet<ReferenceKind> = new Set(["user", "group", "servicePrincipal"])

/**
 * The restore warning for references TenuVault could not check: why (the app registration cannot read
 * that kind of object, or Microsoft did not answer) and what to do. The advice depends on what each
 * reference does, and does not assume the policy is off (a replace keeps a live policy enforced):
 * a deleted excluded account protects nobody, a deleted included one narrows who the policy applies
 * to, and a deleted named location or authentication strength breaks the condition or control that
 * uses it.
 */
export function uncheckedReferencesWarning(cause: "forbidden" | "unanswered", references: PolicyReference[]): string | undefined {
  if (!references.length) return undefined
  const labels = listed(references.map(referenceLabel))
  const verb = references.length === 1 ? "exists" : "exist"
  const kinds = listed([...new Set(references.map((reference) => KIND_PLURAL[reference.kind]))])
  const why = cause === "forbidden"
    ? `The app registration has no permission to read ${kinds}, so TenuVault did not check that ${labels} still ${verb}.`
    : `Microsoft did not answer when TenuVault checked that ${labels} still ${verb}.`
  const assignees = references.filter((reference) => ASSIGNEE_KINDS.has(reference.kind))
  const advice = [
    ...(assignees.some((reference) => reference.exclude)
      ? ["Check the excluded accounts and groups in Entra: an exclusion of a deleted account, such as an emergency access account, protects nobody."]
      : []),
    ...(assignees.some((reference) => !reference.exclude)
      ? ["If an included user, group or workload identity was deleted, the policy applies to fewer of them than in the backup."]
      : []),
    ...(references.some((reference) => reference.kind === "namedLocation")
      ? ["Check the named locations in Entra: the policy's location condition depends on them."]
      : []),
    ...(references.some((reference) => reference.kind === "authenticationStrength")
      ? ["Check the authentication strength in Entra: the policy's grant control depends on it."]
      : []),
  ]
  return [why, ...advice].join(" ")
}

/**
 * What the restore result tells the admin about the policy it wrote: the state it was given and the
 * session controls that affect how long people, TenuVault included, stay signed in.
 */
export function policyWarnings(snapshot: Item, written: Item): string[] {
  const warnings: string[] = []
  if (snapshot.state !== written.state) {
    warnings.push(`Restored in ${written.state === REPORT_ONLY ? "report-only mode" : String(written.state)} instead of ${String(snapshot.state)}, so it cannot lock anyone out. Check its sign-in impact in Entra, then turn it on.`)
  }
  const frequency = object(object(written.sessionControls)?.signInFrequency)
  if (frequency?.isEnabled === true) {
    warnings.push("This policy sets a sign-in frequency. Once enforced it can end the TenuVault sign-in of the admins it covers, and scheduled backups then need a new sign-in or the Backup Reader.")
  }
  if (object(object(written.conditions)?.clientApplications)) {
    warnings.push("This policy targets workload identities. Check that it does not block the TenuVault Backup Reader before you turn it on.")
  }
  return warnings
}

const list = (value: Json | undefined) => {
  const entries = strings(value)
  return entries.length ? entries.join(", ") : "none"
}

const LOCKOUT = "Removing an exclusion applies the policy to accounts it skipped, such as emergency access accounts. Check them before the policy is enforced."

/** What replacing a live policy with the backed-up one changes, for the restore review. */
export function policyChanges(snapshot: Item, current: Item): ReviewChange[] {
  const changes: ReviewChange[] = []
  const written = replaceState(snapshot.state, current.state)
  if (current.state !== snapshot.state) {
    changes.push({
      label: "State",
      from: String(current.state ?? "unknown"),
      to: String(snapshot.state ?? "unknown"),
      restored: written === snapshot.state,
      ...(written !== snapshot.state ? { warning: `Restore writes ${written === REPORT_ONLY ? "report-only" : written}: it never turns on enforcement the policy does not have now.` } : {}),
    })
  }
  const users = (item: Item) => object(object(item.conditions)?.users) ?? {}
  for (const key of ["includeUsers", "excludeUsers", "includeGroups", "excludeGroups", "includeRoles", "excludeRoles"]) {
    const from = list(users(current)[key])
    const to = list(users(snapshot)[key])
    if (from === to) continue
    const removedExclusion = key.startsWith("exclude") && strings(users(current)[key]).some((id) => !strings(users(snapshot)[key]).includes(id))
    changes.push({ label: `Users: ${key}`, from, to, restored: true, ...(removedExclusion ? { warning: LOCKOUT } : {}) })
  }
  const compare = (label: string, pick: (item: Item) => Json | undefined, warning?: string) => {
    const from = JSON.stringify(pick(current) ?? null)
    const to = JSON.stringify(pick(snapshot) ?? null)
    if (from !== to) changes.push({ label, from, to, restored: true, ...(warning ? { warning } : {}) })
  }
  const grant = (item: Item) => {
    const controls = object(item.grantControls)
    if (!controls) return null
    const strength = object(controls.authenticationStrength)
    return { operator: controls.operator ?? null, builtInControls: controls.builtInControls ?? null, authenticationStrength: strength?.id ?? null, termsOfUse: controls.termsOfUse ?? null }
  }
  compare("Applications", (item) => object(item.conditions)?.applications)
  compare("Locations", (item) => object(item.conditions)?.locations)
  compare("Grant controls", grant, "Changing grant controls changes what people must do to sign in.")
  compare("Session controls", (item) => item.sessionControls, "Session controls such as sign-in frequency decide how long people stay signed in, TenuVault included.")
  return changes
}

/** Combination configurations without the IDs Graph assigns, in a comparable form. */
const configurations = (item: Item): Item[] =>
  (Array.isArray(item.combinationConfigurations) ? (item.combinationConfigurations as Item[]) : []).map((entry) => {
    const copy: Item = {}
    for (const [key, value] of Object.entries(entry)) if ((key !== "id" && !key.includes("@odata.")) || key === "@odata.type") copy[key] = Array.isArray(value) ? [...strings(value)].sort() : value
    return copy
  })

const sameSet = (a: Json | undefined, b: Json | undefined) => JSON.stringify([...strings(a)].sort()) === JSON.stringify([...strings(b)].sort())

/** Requests that put a live authentication strength back to the snapshot. */
export function strengthUpdate(payload: Item, snapshot: Item, current: Item): Step[] {
  const steps: Step[] = [{ method: "PATCH", path: "{collection}/{id}", body: { displayName: payload.displayName ?? null, description: payload.description ?? "" }, kind: "content" }]
  const wanted = configurations(snapshot)
  const live = Array.isArray(current.combinationConfigurations) ? (current.combinationConfigurations as Item[]) : []
  const liveClean = configurations(current)
  const key = (entry: Item) => JSON.stringify(Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))))
  // A configuration's slot: its type and the combinations it restricts. A changed restriction in the same
  // slot is updated in place, so a failed restore never leaves the method without its restriction.
  const slot = (entry: Item) => `${String(entry["@odata.type"])}|${JSON.stringify(entry.appliesToCombinations ?? [])}`
  const used = new Set<number>()
  const added: Item[] = []
  const updates: Step[] = []
  for (const entry of wanted) {
    const same = liveClean.findIndex((candidate, index) => !used.has(index) && key(candidate) === key(entry))
    if (same >= 0) { used.add(same); continue }
    const inPlace = liveClean.findIndex((candidate, index) => !used.has(index) && slot(candidate) === slot(entry) && typeof live[index]?.id === "string")
    if (inPlace >= 0) {
      used.add(inPlace)
      updates.push({ method: "PATCH", path: `{collection}/{id}/combinationConfigurations/${encodeURIComponent(live[inPlace]!.id as string)}`, body: entry, kind: "content" })
    } else added.push(entry)
  }
  // Configurations go first, so none still names a combination that is about to be removed.
  live.forEach((entry, index) => {
    if (!used.has(index) && typeof entry.id === "string") steps.push({ method: "DELETE", path: `{collection}/{id}/combinationConfigurations/${encodeURIComponent(entry.id)}`, body: {}, kind: "content" })
  })
  steps.push(...updates)
  if (!sameSet(snapshot.allowedCombinations, current.allowedCombinations)) {
    steps.push({ method: "POST", path: "{collection}/{id}/updateAllowedCombinations", body: { allowedCombinations: strings(snapshot.allowedCombinations) }, kind: "content" })
  }
  for (const entry of added) steps.push({ method: "POST", path: "{collection}/{id}/combinationConfigurations", body: entry, kind: "content" })
  return steps
}

/** The create body of an authentication strength: its configurations without the IDs Graph assigned. */
export function strengthBody(payload: Item): Item {
  payload.combinationConfigurations = configurations(payload)
  return payload
}
