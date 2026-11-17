import type { Extra, IntuneType, Item, Json } from "./registry"

// Closed schemas keep future Graph properties out of personal-data backups, including nested values.
type Schema = true | { [key: string]: Schema }
const fields = (names: string): Record<string, Schema> => Object.fromEntries(names.split(",").map(name => [name, true]))
const credential = fields("hint,keyId,displayName,startDateTime,endDateTime")
const publicKey = fields("customKeyIdentifier,keyId,displayName,startDateTime,endDateTime,type,usage")
const role = fields("id,allowedMemberTypes,description,displayName,isEnabled,origin,value")
const scope = fields("id,adminConsentDescription,adminConsentDisplayName,isEnabled,type,userConsentDescription,userConsentDisplayName,value")
const claim = { ...fields("name,source,essential"), additionalProperties: true as const }
const web = { ...fields("homePageUrl,logoutUrl,redirectUris"), implicitGrantSettings: fields("enableAccessTokenIssuance,enableIdTokenIssuance"), redirectUriSettings: fields("uri,index") }
const user = { ...fields("id,displayName,userPrincipalName,givenName,surname,mail,otherMails,proxyAddresses,userType,accountEnabled,createdDateTime,creationType,jobTitle,department,companyName,employeeId,employeeType,employeeHireDate,officeLocation,usageLocation,businessPhones,mobilePhone,streetAddress,city,state,postalCode,country,preferredLanguage,onPremisesImmutableId,onPremisesSyncEnabled,onPremisesSamAccountName,onPremisesDomainName,onPremisesSecurityIdentifier"), identities: fields("signInType,issuer,issuerAssignedId"), assignedLicenses: fields("skuId,disabledPlans"), assignedPlans: fields("assignedDateTime,capabilityStatus,service,servicePlanId"), licenseAssignmentStates: fields("skuId,disabledPlans,assignedByGroup,state,error,lastUpdatedDateTime"), manager: fields("id") }
const group = { ...fields("id,displayName,description,mail,mailNickname,mailEnabled,securityEnabled,groupTypes,visibility,membershipRule,membershipRuleProcessingState,isAssignableToRole,createdDateTime,classification,preferredDataLocation,onPremisesSyncEnabled,proxyAddresses"), assignedLicenses: fields("skuId,disabledPlans") }
const application = { ...fields("id,appId,displayName,description,signInAudience,identifierUris,groupMembershipClaims,isFallbackPublicClient,tags,notes,createdDateTime,publisherDomain"), web, spa: fields("redirectUris"), publicClient: fields("redirectUris"), api: { ...fields("acceptMappedClaims,requestedAccessTokenVersion,knownClientApplications"), oauth2PermissionScopes: scope, preAuthorizedApplications: fields("appId,delegatedPermissionIds") }, appRoles: role, requiredResourceAccess: { ...fields("resourceAppId"), resourceAccess: fields("id,type") }, optionalClaims: { idToken: claim, accessToken: claim, saml2Token: claim }, verifiedPublisher: fields("displayName,verifiedPublisherId,addedDateTime"), passwordCredentials: credential, keyCredentials: publicKey }
const principal = { ...fields("id,appId,displayName,description,accountEnabled,servicePrincipalType,appOwnerOrganizationId,appRoleAssignmentRequired,servicePrincipalNames,replyUrls,homepage,loginUrl,logoutUrl,preferredSingleSignOnMode,tags,notes,notificationEmailAddresses"), samlSingleSignOnSettings: fields("relayState"), appRoles: role, oauth2PermissionScopes: scope, passwordCredentials: credential, keyCredentials: publicKey }
const grants = fields("id,clientId,consentType,principalId,resourceId,scope")
const device = fields("id,deviceId,displayName,accountEnabled,operatingSystem,operatingSystemVersion,trustType,profileType,isManaged,isCompliant,deviceOwnership,enrollmentType,registrationDateTime,onPremisesSyncEnabled")
const contact = { ...fields("id,displayName,givenName,surname,mail,mailNickname,companyName,department,jobTitle,proxyAddresses,onPremisesSyncEnabled"), phones: fields("number,type"), addresses: fields("city,countryOrRegion,officeLocation,postalCode,state,street") }
export const DIRECTORY_SCHEMAS = { Users: user, Groups: group, Applications: application, ServicePrincipals: principal, OAuth2PermissionGrants: grants, EntraDevices: device, OrgContacts: contact }
export const DIRECTORY_EXTRA_SCHEMAS: Record<string, Schema> = {
  settings: { ...fields("id,displayName,templateId"), values: fields("name,value") },
  federatedIdentityCredentials: fields("id,name,issuer,subject,audiences,description"),
  extensionProperties: fields("id,name,dataType,isSyncedFromOnPremises,targetObjects"),
  appRoleAssignments: fields("id,appRoleId,principalId,resourceId"),
  appRoleAssignedTo: fields("id,appRoleId,principalId,resourceId"),
}
function project(value: Json, schema: Schema): Json {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(entry => project(entry, schema)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"))
  if (schema === true) {
    // Scalar fields and scalar lists never admit an unexpected object.
    if (typeof value === "object") throw new Error("A directory property has an unexpected shape")
    if (typeof value === "string" && /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|Bearer\s+[\w.-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|<RSAKeyValue>[\s\S]*<D>|data:application\/(?:x-pkcs12|pkcs12)/i.test(value)) throw new Error("A directory object contains a refused credential value")
    return value
  }
  if (typeof value !== "object") throw new Error("A directory property has an unexpected shape")
  if (Object.keys(schema).some(key => `${key}@odata.nextLink` in value)) throw new Error("A directory property was not read in full")
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key in value).map(([key, child]) => [key, project(value[key]!, child)]))
}
export const directoryExtraSnapshot = (property: string, value: Item): Item => project(value, DIRECTORY_EXTRA_SCHEMAS[property] ?? { id: true }) as Item
const neverStoredKeys = ["passwordProfile", "authentication", "authenticationMethods", "signInActivity", "clientSecret", "password", "privateKey", "sharedSecret", "secretKey", "tokenSeed", "seed", "tunnelKey", "secret", "accessToken", "refreshToken", "clientAssertion", "pfx", "pkcs12", "secretText", "key"]
const refused = [{ status: 403 }, { status: 404 }]
const ids = (path: string, property: string): Extra => ({ property, path: id => `${path}/${id}/${property}?$select=id&$top=999`, ids: true, optional: refused })
const definitions = (path: string, property: string): Extra => ({ property, path: id => `${path}/${id}/${property}?$select=${Object.keys(DIRECTORY_EXTRA_SCHEMAS[property] as object).join(",")}&$top=999`, optional: refused })
const directory = (folder: keyof typeof DIRECTORY_SCHEMAS, label: string, path: string, area: IntuneType["area"], extras?: Extra[]): IntuneType => ({
  folder, label, path, area, apiVersion: "v1.0", nameKey: "displayName", volume: "large", inventory: true, listOnly: true,
  keep: Object.keys(DIRECTORY_SCHEMAS[folder]), listQuery: `$top=999&$select=${Object.keys(DIRECTORY_SCHEMAS[folder]).filter(key => key !== "manager").join(",")}`,
  normalizeSnapshot: snapshot => project(snapshot, DIRECTORY_SCHEMAS[folder]) as Item,
  neverStoredKeys, extras, limitation: "Directory objects are inventory. Restore is not available yet.",
})
export function directoryObjectId(folder: string, id: unknown): boolean {
  return typeof id === "string" && (folder === "OAuth2PermissionGrants" ? /^[A-Za-z0-9_-]{40,160}$/.test(id) : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
}
export const MICROSOFT_ORGANIZATION_ID = "f8cdef31-a31e-4b4a-93e4-5f571e91255a"
export const ENTRA_DIRECTORY_TYPES: IntuneType[] = [
  { ...directory("Users", "Users", "users", "Users and devices"),
    listQuery: directory("Users", "Users", "users", "Users and devices").listQuery + "&$expand=manager($select=id)",
    normalizeSnapshot: snapshot => {
      const projected = project(snapshot, user) as Item
      const manager = projected.manager as Item | undefined
      if (manager && (typeof manager.id !== "string" || !directoryObjectId("Users", manager.id))) throw new Error("Invalid directory manager reference")
      return { ...projected, manager: { id: manager?.id ?? null, complete: true } }
    },
  },
  // v1.0 omits service principals from group members. These two relationships need beta.
  { ...directory("Groups", "Groups", "groups", "Groups", [{ ...ids("groups", "members"), path: id => `https://graph.microsoft.com/beta/groups/${id}/members?$select=id&$top=999` }, { ...ids("groups", "owners"), path: id => `https://graph.microsoft.com/beta/groups/${id}/owners?$select=id&$top=999` }, definitions("groups", "settings")]), additionalReadVersions: ["beta"] },
  directory("Applications", "App registrations", "applications", "Applications", [ids("applications", "owners"), definitions("applications", "federatedIdentityCredentials"), definitions("applications", "extensionProperties")]),
  { ...directory("ServicePrincipals", "Enterprise apps", "servicePrincipals", "Applications", [ids("servicePrincipals", "owners"), definitions("servicePrincipals", "appRoleAssignments"), definitions("servicePrincipals", "appRoleAssignedTo"), ...["claimsMappingPolicies", "homeRealmDiscoveryPolicies", "tokenLifetimePolicies", "tokenIssuancePolicies", "appManagementPolicies"].map(property => ids("servicePrincipals", property))]), listQuery: directory("ServicePrincipals", "Enterprise apps", "servicePrincipals", "Applications").listQuery + "&$count=true", filter: `appOwnerOrganizationId ne ${MICROSOFT_ORGANIZATION_ID}`, headers: { ConsistencyLevel: "eventual" }, skip: item => item.appOwnerOrganizationId === MICROSOFT_ORGANIZATION_ID ? "Microsoft-owned enterprise app" : undefined },
  directory("OAuth2PermissionGrants", "OAuth2 permission grants", "oauth2PermissionGrants", "Applications"),
  directory("EntraDevices", "Entra devices", "devices", "Users and devices"),
  directory("OrgContacts", "Organization contacts", "contacts", "Users and devices"),
]
