/** Shapes copied from read-only Lokka v1.0 GETs on 2026-11-21, with identifiers replaced. */
export const graphAssignment = {
  id: "Qe5RwabPwECXojkc2nUc_2P1LAoBohVEh8q84QiTtLA", deletedDateTime: null,
  appRoleId: "abcdef00-0000-4000-8000-000000000090", createdDateTime: "2022-01-16T22:17:01.0657668Z",
  principalDisplayName: "Sample client", principalId: "abcdef00-0000-4000-8000-000000000012", principalType: "ServicePrincipal",
  resourceDisplayName: "Sample API", resourceId: "abcdef00-0000-4000-8000-000000000010",
}
export const graphUser = { id: "abcdef00-0000-4000-8000-000000000001", displayName: "Sample user", userType: "Member" }
export const graphApplication = { id: "abcdef00-0000-4000-8000-000000000002", appId: "abcdef00-0000-4000-8000-000000000003", displayName: "Sample registration", description: null, notes: null, tags: [] }
export const graphServicePrincipal = { id: "abcdef00-0000-4000-8000-000000000004", appId: graphApplication.appId, displayName: "Sample registration", appOwnerOrganizationId: "abcdef00-0000-4000-8000-000000000005", servicePrincipalType: "Application" }
export const graphGroup = { id: "abcdef00-0000-4000-8000-000000000006", displayName: "Sample group", description: null, securityEnabled: true, mailEnabled: false, groupTypes: [], membershipRule: null }
export const graphUserPolicy = { conditions: {
  userRiskLevels: [], signInRiskLevels: [], clientAppTypes: ["browser"], servicePrincipalRiskLevels: [], insiderRiskLevels: null,
  locations: null, devices: null, clientApplications: null, authenticationFlows: null,
  applications: { includeApplications: ["All"], excludeApplications: [], includeUserActions: [], includeAuthenticationContextClassReferences: [], applicationFilter: null },
  users: { includeUsers: [], excludeUsers: [], includeGroups: [graphGroup.id], excludeGroups: [], includeRoles: [], excludeRoles: [], includeGuestsOrExternalUsers: null, excludeGuestsOrExternalUsers: null },
  platforms: { includePlatforms: ["windows"], excludePlatforms: [] },
} }
/** The lab has no workload policy. This variant follows the verified Learn v1.0 schema. */
export const graphWorkloadPolicy = { conditions: { ...graphUserPolicy.conditions, users: null, clientApplications: { includeServicePrincipals: ["ServicePrincipalsInMyTenant"], excludeServicePrincipals: [], servicePrincipalFilter: null } } }
