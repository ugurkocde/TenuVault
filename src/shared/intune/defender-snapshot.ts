import type { Item, Json } from "./registry"

export function tenantControlStates(item: Item): Item[] {
  const updates = item.controlStateUpdates
  if (!Array.isArray(updates) || updates.some(update => !update || typeof update !== "object" || Array.isArray(update) || typeof update.state !== "string")) throw new Error("Microsoft Graph did not return control state updates")
  return (updates as Item[]).filter(update => String(update.state).toLowerCase() !== "default")
}

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const references = new Set(["principal", "principals", "user", "users", "targetUsers", "author", "authors", "createdBy", "lastModifiedBy", "modifiedBy", "updatedBy", "policyReviewers", "reviewers", "payload", "loginPage", "landingPage"])
const profiles = new Set(["userPrincipalName", "mail", "givenName", "surname", "principalName", "accountTargetEmails", "email", "emailAddress", "createdByUpn", "lastUpdatedByUpn"])
const sets = new Set(["principalIds", "appScopeIds", "directoryScopeIds", "resourceScopes", "allowedResourceActions", "excludedResourceActions", "payloadTags", "supportedLocales", "assignedTo", "mitreTechniques", "recommendedActions", "accountTargetIds", "scopeNames", "deviceGroupNames", "domainControllerDnsNames"])

/** People are references by ID. Configured reporting mailbox addresses remain policy settings. */
export function defenderSnapshot(snapshot: Item): Item {
  const identity = (value: Json): Json | undefined => {
    if (Array.isArray(value)) return value.map(identity).filter((entry): entry is Json => entry !== undefined)
    if (typeof value === "string") return guid.test(value) ? { id: value } : undefined
    if (value === null) return null
    if (typeof value !== "object") return undefined
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      if (["id", "userId", "groupId", "principalId", "applicationId", "tenantId"].includes(key)) return [[key, child]]
      if (["user", "application", "group", "servicePrincipal"].includes(key)) {
        const kept = identity(child)
        if (kept !== undefined) return [[key, kept]]
      }
      return []
    }))
  }
  const visit = (value: Json, path = ""): Json => {
    if (!value || typeof value !== "object") return value
    if (Array.isArray(value)) return value.map(entry => visit(entry, path))
    if (/\.(?:user|identity|emailIdentity)$/.test(String(value["@odata.type"]))) return identity(value) ?? {}
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      // Graph's address-book targets have emails only. Do not resolve or persist people by email.
      if (profiles.has(key)) return []
      // Training assignedTo is an enum collection; a Secure Score assignee is a person.
      if (references.has(key) || (key === "assignedTo" && !path.startsWith("trainingSetting"))) {
        const kept = identity(child)
        return kept === undefined ? [] : [[key, kept]]
      }
      const normalized = visit(child, path ? `${path}.${key}` : key)
      return [[key, sets.has(key) && Array.isArray(normalized) && normalized.every(entry => typeof entry === "string") ? [...normalized].sort() : normalized]]
    }))
  }
  return visit(snapshot) as Item
}
