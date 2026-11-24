import type { Item, Json } from "./registry"

const subjectTypes = new Set(["subjectSet", "userSet", "singleUser", "singleServicePrincipal", "groupMembers", "connectedOrganizationMembers", "internalSponsors", "externalSponsors", "requestorManager", "targetManager", "targetUserSponsors", "targetApplicationOwners", "targetAgentIdentitySponsorsOrOwners", "attributeRuleMembers", "ruleBasedSubjectSet", "groupBasedSubjectSet"])
const subjectCollections = new Set(["specificAllowedTargets", "allowedRequestors", "onBehalfRequestors", "primaryApprovers", "fallbackPrimaryApprovers", "escalationApprovers", "fallbackEscalationApprovers", "primaryReviewers", "fallbackReviewers", "reviewers", "backupReviewers", "defaultReviewers"])
// Selectors and behavior are configuration. Graph's subject descriptions are directory labels.
const subjectKeys = new Set(["@odata.type", "id", "userId", "groupId", "connectedOrganizationId", "servicePrincipalId", "managerLevel", "isBackup", "rule", "membershipRule", "query", "queryType", "queryRoot", "scopeType"])
const references = new Set(["principal", "user", "assignedTo", "createdBy", "modifiedBy", "lastModifiedBy", "addedBy"])
const identityTypes = new Set(["user", "identity", "userIdentity", "servicePrincipal", "group", "accessPackageSubject"])
const identityKeys = new Set(["id", "userId", "groupId", "servicePrincipalId", "tenantId", "objectId", "connectedOrganizationId"])
const profileKeys = new Set(["userPrincipalName", "mail", "givenName", "surname", "principalName"])
const targetCollections = new Set(["includeTargets", "excludeTargets", "targets"])
const targetLabels = new Set(["displayName", "description", "name", "email"])

/** Keep directory references without personal profiles, on both detail and list-only reads. */
export function entraSnapshot(snapshot: Item): Item {
  const reference = (value: Json): Json | undefined => {
    if (value === null) return null
    if (Array.isArray(value)) return value.map(reference).filter((entry): entry is Json => entry !== undefined)
    if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return { id: value }
    // Older entitlement responses can return an actor's name as a string, with no ID to retain.
    if (typeof value !== "object") return undefined
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      if (identityKeys.has(key)) return [[key, child]]
      if (["user", "application", "group", "servicePrincipal"].includes(key)) {
        const kept = reference(child)
        if (kept !== undefined) return [[key, kept]]
      }
      return []
    }))
  }
  const visit = (value: Json, property = ""): Json => {
    if (!value || typeof value !== "object") return value
    if (Array.isArray(value)) return value.map(entry => visit(entry, property))
    const type = String(value["@odata.type"] ?? "").split(".").at(-1)!
    if (identityTypes.has(type)) return reference(value)!
    const subject = subjectTypes.has(type) || subjectCollections.has(property)
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      if (profileKeys.has(key) || (subject && !subjectKeys.has(key)) || (targetCollections.has(property) && targetLabels.has(key))) return []
      if (references.has(key)) {
        const kept = reference(child)
        return kept === undefined ? [] : [[key, kept]]
      }
      return [[key, visit(child, key)]]
    }))
  }
  return visit(snapshot) as Item
}

/** Keep the same stored catalog fields across Graph versions. */
export function accessPackageCatalogSnapshot(snapshot: Item): Item {
  const { catalogStatus, catalogType, ...content } = snapshot
  if (catalogStatus === "Unpublished" || catalogStatus === "Published") {
    content.state = catalogStatus.toLowerCase()
  } else if (catalogStatus !== undefined) {
    // An unknown beta status cannot fall back to an older state's value.
    delete content.state
    content.catalogStatus = catalogStatus
  }
  if (catalogType !== undefined) {
    content.catalogType = catalogType === "UserManaged" ? "userManaged" : catalogType === "ServiceDefault" ? "serviceDefault" : catalogType
  }
  if (Array.isArray(content.resources)) content.resources = content.resources.map(resource => {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) return resource
    const { accessPackageResourceRoles, accessPackageResourceScopes, ...fields } = resource
    if (accessPackageResourceRoles !== undefined) fields.roles = accessPackageResourceRoles
    if (accessPackageResourceScopes !== undefined) fields.scopes = accessPackageResourceScopes
    return fields
  })
  return content
}
