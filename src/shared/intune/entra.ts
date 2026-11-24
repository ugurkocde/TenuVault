import { includesEntraFolder } from "./entra-scope"
import { restoreMatrixRow } from "./restore-matrix"
import type { Extra, IntuneType } from "./registry"
import { ENTRA_DIRECTORY_TYPES } from "./entra-directory"
import { isGuid } from "../security"
import { accessPackageCatalogSnapshot, entraSnapshot } from "./entra-snapshot"
import { sortedIds } from "./read"
import { GraphResponseValidationError } from "../graph-response-validation"

/** Configuration restore capabilities come only from individually verified matrix subsets. */
const limitation = "Entra ID configuration restore is not available yet."
const neverStored = ["clientSecret", "password", "privateKey", "sharedSecret", "secretKey", "tokenSeed", "seed", "tunnelKey", "keyCredentials", "passwordCredentials", "secret", "accessToken", "refreshToken", "clientAssertion", "pfx", "pkcs12", "secretText"]
const base = (folder: string, label: string, path: string, area: IntuneType["area"] = "Tenant settings"): IntuneType => ({
  folder, label, path, area, restoreSafety: "identity", nameKey: "displayName", apiVersion: "v1.0", ...(restoreMatrixRow(folder)?.configurationRestore?.capability ? { restore: restoreMatrixRow(folder)!.configurationRestore!.capability } : { limitation: restoreMatrixRow(folder)?.configurationRestore?.blockedReason ?? limitation }), neverStoredKeys: neverStored, normalizeSnapshot: entraSnapshot,
})
const singleton = (folder: string, label: string, path: string, area?: IntuneType["area"]): IntuneType => ({
  ...base(folder, label, path, area), singleton: { id: folder, name: label },
})
const appliesTo = (path: string): Extra[] => [{ property: "appliesTo", path: id => `${path}/${id}/appliesTo?$select=id`, ids: true }]
const policy = (folder: string, label: string, collection: string): IntuneType => ({
  ...base(folder, label, `policies/${collection}`), extras: appliesTo(`policies/${collection}`),
})
const credentialRestrictions = neverStored.filter(key => key !== "keyCredentials" && key !== "passwordCredentials")
const organization = "organization/{organizationId}"
const brandingStreams = ["backgroundImage", "bannerLogo", "customCSS", "favicon", "headerLogo", "squareLogo", "squareLogoDark"]

export const ENTRA_5A_TYPES: IntuneType[] = [
  {
    ...singleton("AuthorizationPolicy", "Authorization policy", "policies/authorizationPolicy"),
    // The beta alias returns a collection. The explicit policy ID returns the entity.
    betaReadPath: "policies/authorizationPolicy/authorizationPolicy",
    additionalReadVersions: ["beta"],
    extras: [{ property: "defaultUserRoleOverrides", path: () => "https://graph.microsoft.com/beta/policies/authorizationPolicy/authorizationPolicy/defaultUserRoleOverrides" }],
  },
  singleton("SecurityDefaults", "Security defaults", "policies/identitySecurityDefaultsEnforcementPolicy"),
  singleton("AdminConsentRequestPolicy", "Admin consent request policy", "policies/adminConsentRequestPolicy"),
  {
    ...base("PermissionGrantPolicies", "Permission grant policies", "policies/permissionGrantPolicies"),
    // These are condition sets, not relationships to directory objects. Keep their configuration.
    extras: ["includes", "excludes"].map(property => ({ property, path: id => `policies/permissionGrantPolicies/${id}/${property}` })),
  },
  { ...base("PermissionGrantPreApprovalPolicies", "Permission grant pre-approval policies", "policies/permissionGrantPreApprovalPolicies"), apiVersion: "beta" },
  { ...singleton("DefaultAppManagementPolicy", "Default app management policy", "policies/defaultAppManagementPolicy"), neverStoredKeys: credentialRestrictions, neverStored: ["keyCredentials", "passwordCredentials"] },
  { ...policy("AppManagementPolicies", "App management policies", "appManagementPolicies"), detailEnvelope: { "v1.0": "singleValueArray", beta: "singleValueArray" }, neverStoredKeys: credentialRestrictions, neverStored: ["keyCredentials", "passwordCredentials"] },
  policy("TokenLifetimePolicies", "Token lifetime policies", "tokenLifetimePolicies"),
  policy("TokenIssuancePolicies", "Token issuance policies", "tokenIssuancePolicies"),
  policy("ClaimsMappingPolicies", "Claims mapping policies", "claimsMappingPolicies"),
  policy("HomeRealmDiscoveryPolicies", "Home realm discovery policies", "homeRealmDiscoveryPolicies"),
  { ...base("ActivityBasedTimeoutPolicies", "Activity-based timeout policies", "policies/activityBasedTimeoutPolicies"), detailEnvelope: { "v1.0": "singleValueArray", beta: "singleValueArray" } },
  singleton("DeviceRegistrationPolicy", "Device registration policy", "policies/deviceRegistrationPolicy"),
  ...[["MdmEnrollmentPolicies", "MDM enrollment policies", "mobileDeviceManagementPolicies"], ["MamEnrollmentPolicies", "MAM enrollment policies", "mobileAppManagementPolicies"]].map(([folder, label, path]) => ({
    ...base(folder!, label!, `policies/${path}`), apiVersion: "beta" as const, detailEnvelope: { beta: "valueObject" as const },
    extras: [{ property: "includedGroups", path: (id: string) => `policies/${path}/${id}/includedGroups?$select=id`, ids: true as const }],
  })),
  { ...base("DirectorySettings", "Directory settings", "groupSettings"), betaReadPath: "settings" },
  { ...singleton("Organization", "Organization", "organization"), singleton: { id: "Organization", name: "Organization", collection: true }, neverStored: ["onPremisesLastSyncDateTime", "onPremisesLastPasswordSyncDateTime", "onPremisesSyncStatus"] },
  {
    ...singleton("EntraCompanyBranding", "Company branding", `${organization}/branding`),
    extras: [{ property: "localizations", path: () => `${organization}/branding/localizations` }],
    maxSnapshotBytes: 1024 * 1024,
    // Graph rejects fetch's default wildcard locale when reading branding.
    headers: { "Accept-Language": "0" },
    neverStored: [...brandingStreams, ...brandingStreams.map(key => `localizations.${key}`)],
    notConfigured: [{ status: 404, code: "Request_ResourceNotFound" }],
  },
  {
    ...base("Domains", "Domains", "domains"),
    neverStored: ["federationConfiguration.signingCertificateUpdateStatus"],
    extras: [
      // Domain-InternalFederation.Read.All may be refused even when the domain itself is readable.
      { property: "federationConfiguration", path: id => `domains/${id}/federationConfiguration`, optional: [{ status: 403 }, { status: 404, code: "Request_ResourceNotFound" }], notConfigured: [{ status: 404, code: "Request_ResourceNotFound" }], notConfiguredWhen: parent => parent.authenticationType === "Managed" },
      { property: "verificationDnsRecords", path: id => `domains/${id}/verificationDnsRecords` },
      { property: "serviceConfigurationRecords", path: id => `domains/${id}/serviceConfigurationRecords` },
    ],
  },
  base("OnPremisesSynchronization", "On-premises synchronization", "directory/onPremisesSynchronization"),
  // The parent returns its method configurations. The collection rejects listing and $select.
  singleton("AuthenticationMethodsPolicy", "Authentication methods policy", "policies/authenticationMethodsPolicy", "Authentication"),
  singleton("AuthenticationFlowsPolicy", "Authentication flows policy", "policies/authenticationFlowsPolicy", "Authentication"),
  base("AuthenticationContexts", "Authentication contexts", "identity/conditionalAccess/authenticationContextClassReferences", "Authentication"),
  base("CertificateBasedAuthConfigurations", "Certificate-based authentication configurations", `${organization}/certificateBasedAuthConfiguration`, "Authentication"),
  {
    ...base("CertificateBasedAuthPki", "Certificate-based authentication PKI", "directory/publicKeyInfrastructure/certificateBasedAuthConfigurations", "Authentication"),
    detailEnvelope: { "v1.0": "valueObject", beta: "valueObject" },
    neverStored: ["status", "statusDetails"],
    extras: [{ property: "certificateAuthorities", path: id => `directory/publicKeyInfrastructure/certificateBasedAuthConfigurations/${id}/certificateAuthorities` }],
  },
  {
    ...singleton("FederatedTokenValidationPolicy", "Federated token validation policy", "policies/federatedTokenValidationPolicy", "Authentication"),
    detailEnvelope: { beta: "valueObject" },
    notConfigured: [{ status: 404, code: "Request_ResourceNotFound" }],
  },
  {
    ...singleton("ContinuousAccessEvaluationPolicy", "Continuous access evaluation policy", "identity/continuousAccessEvaluationPolicy", "Authentication"), apiVersion: "beta",
    notConfigured: [{ status: 404, message: "CAE settings not found" }],
  },
  { ...base("HardwareOathDevices", "Hardware OATH devices", "directory/authenticationMethodDevices/hardwareOathDevices", "Authentication"), detailEnvelope: { beta: "valueObject" }, nameKey: "serialNumber", apiVersion: "beta", inventory: true, neverStored: ["lastUsedDateTime", "status"] },
  base("GroupLifecyclePolicies", "Group lifecycle policies", "groupLifecyclePolicies", "Groups"),
  singleton("OwnerlessGroupPolicy", "Ownerless group policy", "policies/ownerlessGroupPolicy", "Groups"),
]

const external = (folder: string, label: string, path: string) => base(folder, label, path, "External identities")
const roles = (folder: string, label: string, path: string) => ({ ...base(folder, label, path, "Roles and PIM"), headers: { "Accept-Language": "en-US" } })
const directoryScope = "scopeId eq '/' and scopeType eq 'DirectoryRole'"
// Bound group fan-out so large or throttled tenants leave time to save other services.
export const PIM_GROUP_READ_BUDGET_MS = 120_000
export const PIM_GROUP_SCHEDULE_REQUEST_LIMIT = 500
const selfServiceUnavailable = [{ status: 400, code: "AADB2C99039", message: "The feature self service sign up is not enabled for the tenant" }]
const groupSchedules = (folder: string, label: string, collection: string): IntuneType => ({
  ...roles(folder, label, `identityGovernance/privilegedAccess/group/${collection}`),
  listOnly: true,
  neverStored: ["status"],
  headers: { "Accept-Language": "en-US", "ConsistencyLevel": "eventual" },
  listSource: { budget: { durationMs: PIM_GROUP_READ_BUDGET_MS, maxRequests: PIM_GROUP_SCHEDULE_REQUEST_LIMIT }, path: "groups?$select=id&$top=999&$count=true&$filter=" + encodeURIComponent("(securityEnabled eq true or groupTypes/any(c:c eq 'Unified')) and onPremisesSyncEnabled ne true and not groupTypes/any(c:c eq 'DynamicMembership')"), filter: id => `groupId eq '${id.replaceAll("'", "''")}'` },
})

export const ENTRA_5B_TYPES: IntuneType[] = [
  { ...singleton("CrossTenantAccessPolicy", "Cross-tenant access policy", "policies/crossTenantAccessPolicy", "External identities"), detailEnvelope: { "v1.0": "valueObject", beta: "valueObject" } },
  singleton("CrossTenantAccessDefault", "Cross-tenant access defaults", "policies/crossTenantAccessPolicy/default", "External identities"),
  {
    ...external("CrossTenantAccessPartners", "Cross-tenant access partners", "policies/crossTenantAccessPolicy/partners"), idKey: "tenantId",
    extras: [{ property: "identitySynchronization", path: id => `policies/crossTenantAccessPolicy/partners/${id}/identitySynchronization`, object: true }],
    neverStored: ["displayName", "identitySynchronization.displayName"],
  },
  {
    ...external("CrossTenantAccessMtoTemplates", "Multitenant organization templates", "policies/crossTenantAccessPolicy/templates"),
    staticIds: ["multiTenantOrganizationIdentitySynchronization", "multiTenantOrganizationPartnerConfiguration"],
  },
  { ...singleton("ExternalIdentitiesPolicy", "External identities policy", "policies/externalIdentitiesPolicy", "External identities"), detailEnvelope: { beta: "valueObject" }, apiVersion: "beta" },
  { ...external("B2bManagementPolicies", "B2B management policies", "policies/b2bManagementPolicies"), apiVersion: "beta" },
  { ...external("IdentityProviders", "Identity providers", "identity/identityProviders"), listOnly: true },
  {
    ...external("UserFlows", "User flows", "identity/b2xUserFlows"), unorderedCollections: { userAttributeAssignments: "id", languages: "id" },
    extras: [
      { property: "identityProviders", path: id => `identity/b2xUserFlows/${id}/identityProviders?$select=id`, ids: true },
      ...["userAttributeAssignments", "languages"].map(property => ({ property, path: (id: string) => `identity/b2xUserFlows/${id}/${property}` })),
    ],
  },
  { ...external("UserFlowAttributes", "User flow attributes", "identity/userFlowAttributes"), unavailable: selfServiceUnavailable },
  { ...external("AuthenticationEventsFlows", "Authentication events flows", "identity/authenticationEventsFlows"), detailEnvelope: { "v1.0": "valueObject", beta: "valueObject" }, unavailable: [{ status: 403, code: "AADB2C", message: "requires feature: 'EnableMsGraphAuthenticationEventListener'" }] },
  external("AuthenticationEventListeners", "Authentication event listeners", "identity/authenticationEventListeners"),
  external("CustomAuthenticationExtensions", "Custom authentication extensions", "identity/customAuthenticationExtensions"),
  // No delegated call has established APIConnectors.Read.All. Keep this type app-only.
  { ...external("ApiConnectors", "API connectors", "identity/apiConnectors"), backupMode: "application", unavailable: selfServiceUnavailable, neverStoredKeys: [...neverStored, "authenticationConfiguration", "certificate", "certificateData"] },
  {
    ...singleton("MultiTenantOrganization", "Multitenant organization", "tenantRelationships/multiTenantOrganization", "External identities"),
    unorderedCollections: { tenants: "tenantId" },
    extras: [{ property: "tenants", path: () => "tenantRelationships/multiTenantOrganization/tenants" }],
    neverStored: ["tenants.displayName", "tenants.transitionDetails.status", "tenants.transitionDetails.details"],
  },
  { ...roles("EntraRoleDefinitions", "Custom Entra role definitions", "roleManagement/directory/roleDefinitions"), filter: "isBuiltIn eq false", skip: item => item.isBuiltIn === true ? "Built-in role" : undefined },
  roles("EntraRoleAssignments", "Entra role assignments", "roleManagement/directory/roleAssignments"),
  { ...roles("RoleEligibilitySchedules", "Role eligibility schedules", "roleManagement/directory/roleEligibilitySchedules"), neverStored: ["status"] },
  { ...roles("RoleAssignmentSchedules", "Role assignment schedules", "roleManagement/directory/roleAssignmentSchedules"), neverStored: ["status"] },
  {
    ...roles("RoleManagementPolicies", "Role management policies", "policies/roleManagementPolicies"), filter: directoryScope,
    expand: "rules", unorderedCollections: { rules: "id" }, neverStored: ["effectiveRules"],
  },
  { ...roles("RoleManagementPolicyAssignments", "Role management policy assignments", "policies/roleManagementPolicyAssignments"), filter: directoryScope, listOnly: true },
  groupSchedules("PimGroupEligibilitySchedules", "PIM group eligibility schedules", "eligibilitySchedules"),
  groupSchedules("PimGroupAssignmentSchedules", "PIM group assignment schedules", "assignmentSchedules"),
  { ...roles("PimAlertConfigurations", "PIM alert configurations", "identityGovernance/roleManagementAlerts/alertConfigurations"), apiVersion: "beta", filter: directoryScope },
  {
    ...roles("AdministrativeUnits", "Administrative units", "directory/administrativeUnits"),
    additionalReadVersions: ["beta"],
    unorderedCollections: { scopedRoleMembers: "id" },
    normalizeSnapshot: snapshot => {
      if (Array.isArray(snapshot.members)) {
        const members = snapshot.members.map(entry => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new GraphResponseValidationError("Microsoft Graph returned an invalid administrative unit member")
          return entry
        })
        const types = members.flatMap(entry => {
          const type = entry["@odata.type"]
          return isGuid(entry.id) && typeof type === "string" && /^#microsoft\.graph\.[a-zA-Z]+$/.test(type)
            ? [[entry.id.toLowerCase(), type.slice("#microsoft.graph.".length)] as const] : []
        })
        snapshot = { ...snapshot, members: sortedIds(members, "members"), ...(types.length ? { memberTypes: Object.fromEntries(types) } : {}) }
      }
      if (!Array.isArray(snapshot.scopedRoleMembers)) return entraSnapshot(snapshot)
      return entraSnapshot({ ...snapshot, scopedRoleMembers: snapshot.scopedRoleMembers.map(entry => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry
        const member = entry.roleMemberInfo
        return {
          id: entry.id ?? null,
          roleId: isGuid(entry.roleId) ? entry.roleId : null,
          roleMemberInfo: { id: member && typeof member === "object" && !Array.isArray(member) && isGuid(member.id) ? member.id : null },
        }
      }) })
    },
    select: "id,displayName,description,visibility,membershipType,membershipRule,membershipRuleProcessingState,isMemberManagementRestricted",
    extras: [
      { property: "members", path: id => `https://graph.microsoft.com/beta/directory/administrativeUnits/${id}/members?$select=id&$top=999` },
      { property: "scopedRoleMembers", path: id => `https://graph.microsoft.com/beta/directory/administrativeUnits/${id}/scopedRoleMembers?$select=id,roleId,roleMemberInfo` },
    ],
  },
  roles("AttributeSets", "Attribute sets", "directory/attributeSets"),
  {
    ...roles("CustomSecurityAttributeDefinitions", "Custom security attribute definitions", "directory/customSecurityAttributeDefinitions"), unorderedCollections: { allowedValues: "id" },
    extras: [{ property: "allowedValues", path: id => `directory/customSecurityAttributeDefinitions/${id}/allowedValues` }],
  },
]

const governance = (folder: string, label: string, path: string): IntuneType => ({
  ...base(folder, label, path, "Governance"),
  unavailable: [],
  readBudget: { durationMs: 120_000, maxRequests: 500 },
})
const entitlement = "identityGovernance/entitlementManagement"
const workflows = "identityGovernance/lifecycleWorkflows"
const agreements = "identityGovernance/termsOfUse/agreements"
const agreementFileFields = "id,displayName,fileName,language,isDefault,isMajorVersion,createdDateTime"
const lifecycleUnavailable = [{ status: 403, code: "Access denied", message: "Insufficient license to complete this operation. User workflows require an Entra ID Governance license." }]

export const ENTRA_5C_TYPES: IntuneType[] = [
  {
    ...governance("AccessPackageCatalogs", "Access package catalogs", `${entitlement}/accessPackageCatalogs`),
    apiVersion: "beta",
    normalizeSnapshot: item => entraSnapshot(accessPackageCatalogSnapshot(item)),
    extras: [{ property: "resources", path: id => `${entitlement}/accessPackageCatalogs/${id}/accessPackageResources?$expand=accessPackageResourceRoles,accessPackageResourceScopes`, expandedCollections: ["accessPackageResourceRoles", "accessPackageResourceScopes"], expansionFallbacks: { accessPackageResourceRoles: false, accessPackageResourceScopes: false } }],
    unorderedCollections: { resources: "id", "resources.roles": "id", "resources.scopes": "id", "resources.attributes": "name", "resources.attributes.source.question.localizations": "languageCode", "resources.attributes.source.question.choices.localizations": "languageCode" },
    requiredCollections: ["resources.roles", "resources.scopes"],
    neverStored: ["resources.isPendingOnboarding"],
  },
  {
    ...governance("AccessPackages", "Access packages", `${entitlement}/accessPackages`),
    expand: "catalog($select=id),resourceRoleScopes($expand=role,scope)",
    expandedCollections: ["resourceRoleScopes"],
    expansionFallbacks: { resourceRoleScopes: false },
    extras: ["incompatibleAccessPackages", "incompatibleGroups"].map(property => ({ property, path: id => `${entitlement}/accessPackages/${id}/${property}?$select=id`, ids: true })),
    unorderedCollections: { resourceRoleScopes: "id" }, requiredCollections: ["resourceRoleScopes"],
  },
  { ...governance("AccessPackageAssignmentPolicies", "Access package assignment policies", `${entitlement}/assignmentPolicies`), expand: "accessPackage($select=id),questions,customExtensionStageSettings($expand=customExtension)",
    expandedCollections: ["questions", "customExtensionStageSettings"],
    expansionFallbacks: { questions: false, customExtensionStageSettings: false },
    requiredCollections: ["questions", "customExtensionStageSettings"],
    unorderedCollections: { questions: "id", "questions.localizations": "languageCode", "questions.choices.localizations": "languageCode", customExtensionStageSettings: "id", specificAllowedTargets: "$content", "requestorSettings.onBehalfRequestors": "$content", "requestApprovalSettings.stages.primaryApprovers": "$content", "requestApprovalSettings.stages.fallbackPrimaryApprovers": "$content", "requestApprovalSettings.stages.escalationApprovers": "$content", "requestApprovalSettings.stages.fallbackEscalationApprovers": "$content", "reviewSettings.primaryReviewers": "$content", "reviewSettings.fallbackReviewers": "$content" },
  },
  {
    ...governance("ConnectedOrganizations", "Connected organizations", `${entitlement}/connectedOrganizations`),
    unorderedCollections: { identitySources: "$content" },
    extras: ["internalSponsors", "externalSponsors"].map(property => ({ property, path: id => `${entitlement}/connectedOrganizations/${id}/${property}?$select=id`, ids: true })),
  },
  { ...governance("EntitlementManagementSettings", "Entitlement management settings", `${entitlement}/settings`), singleton: { id: "EntitlementManagementSettings", name: "Entitlement management settings" } },
  { ...governance("AccessReviewDefinitions", "Access review definitions", "identityGovernance/accessReviews/definitions"), detailEnvelope: { "v1.0": "valueObject" }, unorderedCollections: { reviewers: "$content", fallbackReviewers: "$content", backupReviewers: "$content", additionalNotificationRecipients: "$content", stageSettings: "stageId", "stageSettings.reviewers": "$content", "stageSettings.fallbackReviewers": "$content", "stageSettings.recommendationInsightsSettings": "$content", "settings.applyActions": "$content", "settings.recommendationInsightSettings": "$content", "settings.defaultReviewers": "$content", "settings.fallbackReviewers": "$content" }, neverStored: ["instances", "status"] },
  { ...governance("AccessReviewPolicy", "Access review policy", "policies/accessReviewPolicy"), detailEnvelope: { beta: "valueObject" }, apiVersion: "beta", singleton: { id: "AccessReviewPolicy", name: "Access review policy" } },
  {
    ...governance("LifecycleWorkflows", "Lifecycle workflows", `${workflows}/workflows`), unavailable: lifecycleUnavailable,
    extras: [{ property: "tasks", path: id => `${workflows}/workflows/${id}/tasks` }],
    unorderedCollections: { tasks: "id", "tasks.arguments": "name" },
    // Versions and execution history are not current configuration.
    neverStored: ["versions", "runs", "userProcessingResults", "subjectProcessingResults", "taskReports", "executionScope", "previewScope", "nextScheduleRunDateTime", "lastExecutionDateTime", "quarantineDetails"],
  },
  { ...governance("LifecycleWorkflowCustomTaskExtensions", "Lifecycle workflow custom task extensions", `${workflows}/customTaskExtensions`), unavailable: lifecycleUnavailable },
  { ...governance("LifecycleWorkflowSettings", "Lifecycle workflow settings", `${workflows}/settings`), unavailable: lifecycleUnavailable, singleton: { id: "LifecycleWorkflowSettings", name: "Lifecycle workflow settings" } },
  {
    ...governance("TermsOfUseAgreements", "Terms of use agreements", agreements), expand: `files($select=${agreementFileFields})`,
    expandedCollections: ["files"],
    expansionFallbacks: { files: `files?$select=${agreementFileFields}` },
    unorderedCollections: { files: "id" }, requiredCollections: ["files"], maxSnapshotBytes: 1024 * 1024,
    // PDFs may be returned inline as fileData, even though their transport is JSON.
    neverStoredKeys: [...neverStored, "fileData"], neverStored: ["acceptances"],
  },
]

export const ENTRA_TYPES = [...ENTRA_5A_TYPES, ...ENTRA_5B_TYPES, ...ENTRA_5C_TYPES, ...ENTRA_DIRECTORY_TYPES].filter(type => includesEntraFolder(type.folder))
