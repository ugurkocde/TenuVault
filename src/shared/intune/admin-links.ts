import { DEFENDER_TYPES } from "./defender"
import type { Item } from "./registry"

/**
 * Where an admin opens a restored object: the Intune admin center, or the Entra admin center for
 * Conditional Access and directory configuration. Original Intune and Conditional Access addresses
 * were checked against a live tenant in November 2026. Directory configuration opens its setting
 * area; policies with no dedicated portal editor open the applications or Conditional Access list.
 * A link never invents the parameters of an individual object page.
 */

const INTUNE = "https://intune.microsoft.com"
const ENTRA = "https://entra.microsoft.com"

export interface AdminLink {
  url: string
  center: "Intune" | "Entra" | "Defender"
  /** False when the link opens the list the object is in, not the object itself. */
  exact: boolean
}

const enc = encodeURIComponent
const str = (value: unknown) => (typeof value === "string" ? value : "")
const intune = (hash: string, exact: boolean): AdminLink => ({ url: `${INTUNE}/#view/${hash}`, center: "Intune", exact })
const entra = (hash: string, exact: boolean): AdminLink => ({ url: `${ENTRA}/#view/${hash}`, center: "Entra", exact })

const DEVICES = (page: string) => intune(`Microsoft_Intune_DeviceSettings/DevicesMenu/~/${page}`, false)
const APPS = (page: string) => intune(`Microsoft_Intune_DeviceSettings/AppsMenu/~/${page}`, false)
const ENROLLMENT = (page: string) => intune(`Microsoft_Intune_DeviceSettings/DevicesEnrollmentMenu/~/${page}`, false)
export const TENANT_ADMIN = (page: string) => intune(`Microsoft_Intune_DeviceSettings/TenantAdminMenu/~/${page}`, false)
const ROLES = (page: string) => intune(`Microsoft_Intune_DeviceSettings/RolesLandingMenuBlade/~/${page}`, false)
const SECURITY = (page: string) => intune(`Microsoft_Intune_Workflows/SecurityManagementMenu/~/${page}`, false)
const CONDITIONAL_ACCESS = (page: string) => entra(`Microsoft_AAD_ConditionalAccess/ConditionalAccessBlade/~/${page}`, false)

/** Legacy profiles and compliance policies share one page; the journey selects the Graph collection. */
const configurationPage = (id: string, journey: 0 | 1) =>
  intune(`Microsoft_Intune_DeviceSettings/ConfigurationMenuBlade/~/properties/configurationId/${enc(id)}/policyType~/0/policyJourneyState~/${journey}`, true)

/** Windows PowerShell scripts are type 0, macOS shell scripts type 1. */
const scriptPage = (id: string, type: 0 | 1) =>
  intune(`Microsoft_Intune_DeviceSettings/ConfigureWMPolicyMenuBlade/~/properties/policyId/${enc(id)}/policyType~/${type}`, true)

const APP_PROTECTION_TYPE: Record<string, string> = {
  AppProtectionIOS: "#microsoft.graph.iosManagedAppProtection",
  AppProtectionAndroid: "#microsoft.graph.androidManagedAppProtection",
  AppProtectionWindows: "#microsoft.graph.windowsManagedAppProtection",
}

/** Device limit and platform restrictions have their own lists; the rest (such as the enrollment status page) are under Windows enrollment. */
function enrollmentList(item: Item): AdminLink {
  const type = str(item["@odata.type"]).toLowerCase()
  if (type.includes("limit")) return ENROLLMENT("deviceLimitEnrollmentRestrictions")
  if (type.includes("platformrestriction")) return ENROLLMENT("deviceTypeEnrollmentRestrictions")
  return ENROLLMENT("windowsEnrollment")
}

/**
 * The admin center page for an object of a backup folder, with the ID it has in the tenant now
 * (the new ID of a copy). item is the restored object, for the fields some pages need.
 */
export function adminCenterLink(folder: string, id: string, item: Item = {}): AdminLink | undefined {
  if (!id) return undefined
  if (DEFENDER_TYPES.some(type => type.folder === folder)) return { url: "https://security.microsoft.com", center: "Defender", exact: false }
  const name = str(item.displayName) || str(item.name)
  switch (folder) {
    case "AuthorizationPolicy": return entra("Microsoft_AAD_IAM/UsersManagementMenuBlade/~/UserSettings", false)
    case "SecurityDefaults": return entra("Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/Properties", false)
    case "AdminConsentRequestPolicy": return entra("Microsoft_AAD_IAM/ConsentPoliciesMenuBlade/~/AdminConsentSettings", false)
    case "PermissionGrantPolicies":
    case "PermissionGrantPreApprovalPolicies": return entra("Microsoft_AAD_IAM/ConsentPoliciesMenuBlade/~/UserSettings", false)
    case "DefaultAppManagementPolicy":
    case "AppManagementPolicies":
    case "TokenLifetimePolicies":
    case "TokenIssuancePolicies":
    case "ClaimsMappingPolicies":
    case "HomeRealmDiscoveryPolicies":
    case "ActivityBasedTimeoutPolicies": return entra("Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/~/AppAppsPreview", false)
    case "DeviceRegistrationPolicy": return entra("Microsoft_AAD_Devices/DevicesMenuBlade/~/DeviceSettings", false)
    case "MdmEnrollmentPolicies":
    case "MamEnrollmentPolicies": return entra("Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/Mobility", false)
    case "DirectorySettings": return entra("Microsoft_AAD_IAM/GroupsManagementMenuBlade/~/General", false)
    case "Organization": return entra("Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/Properties", false)
    case "EntraCompanyBranding": return entra("Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/LoginPageConfiguration", false)
    case "Domains": return entra("Microsoft_AAD_IAM/DomainNamesBlade", false)
    case "OnPremisesSynchronization": return entra("Microsoft_AAD_Connect_Provisioning/AADConnectMenuBlade/~/Overview", false)
    case "AuthenticationMethodsPolicy":
    case "AuthenticationFlowsPolicy":
    case "HardwareOathDevices": return entra("Microsoft_AAD_IAM/AuthenticationMethodsMenuBlade/~/AdminAuthMethods", false)
    case "AuthenticationContexts": return CONDITIONAL_ACCESS("AuthenticationContext")
    case "CertificateBasedAuthConfigurations":
    case "CertificateBasedAuthPki": return entra("Microsoft_AAD_IAM/AuthenticationMethodsMenuBlade/~/CertificateBasedAuthentication", false)
    case "FederatedTokenValidationPolicy":
    case "ContinuousAccessEvaluationPolicy": return CONDITIONAL_ACCESS("Policies")
    case "GroupLifecyclePolicies": return entra("Microsoft_AAD_IAM/GroupsManagementMenuBlade/~/Lifecycle", false)
    case "OwnerlessGroupPolicy": return entra("Microsoft_AAD_IAM/GroupsManagementMenuBlade/~/General", false)
    case "CrossTenantAccessPolicy":
    case "CrossTenantAccessDefault":
    case "CrossTenantAccessPartners":
    case "CrossTenantAccessMtoTemplates": return entra("Microsoft_AAD_IAM/CompanyRelationshipsMenuBlade/~/Settings", false)
    case "ExternalIdentitiesPolicy":
    case "B2bManagementPolicies": return entra("Microsoft_AAD_IAM/CompanyRelationshipsMenuBlade/~/Settings", false)
    case "IdentityProviders": return entra("Microsoft_AAD_IAM/IdentityProvidersMenuBlade/~/AllIdentityProviders", false)
    case "UserFlows":
    case "UserFlowAttributes":
    case "AuthenticationEventsFlows":
    case "ApiConnectors": return entra("Microsoft_AAD_IAM/CompanyRelationshipsMenuBlade/~/UserFlows", false)
    case "AuthenticationEventListeners":
    case "CustomAuthenticationExtensions": return entra("Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/~/CustomAuthenticationExtensions", false)
    case "MultiTenantOrganization": return entra("Microsoft_AAD_IAM/CompanyRelationshipsMenuBlade/~/MultitenantOrganization", false)
    case "EntraRoleDefinitions":
    case "EntraRoleAssignments": return entra("Microsoft_AAD_IAM/RolesManagementMenuBlade/~/AllRoles", false)
    case "RoleEligibilitySchedules":
    case "RoleAssignmentSchedules":
    case "RoleManagementPolicies":
    case "RoleManagementPolicyAssignments":
    case "PimAlertConfigurations": return entra("Microsoft_Azure_PIMCommon/CommonMenuBlade/~/aadroles", false)
    case "PimGroupEligibilitySchedules":
    case "PimGroupAssignmentSchedules": return entra("Microsoft_Azure_PIMCommon/CommonMenuBlade/~/aadgroup", false)
    case "AdministrativeUnits": return entra("Microsoft_AAD_IAM/AdministrativeUnitsMenuBlade/~/AllAdministrativeUnits", false)
    case "AttributeSets":
    case "CustomSecurityAttributeDefinitions": return entra("Microsoft_AAD_IAM/CustomSecurityAttributesMenuBlade/~/AttributeSets", false)
    case "AccessPackageCatalogs":
    case "AccessPackages":
    case "AccessPackageAssignmentPolicies":
    case "ConnectedOrganizations":
    case "EntitlementManagementSettings": return entra("Microsoft_AAD_ERM/DashboardBlade", false)
    case "AccessReviewDefinitions":
    case "AccessReviewPolicy": return entra("Microsoft_AAD_ERM/AccessReviewsBlade", false)
    case "LifecycleWorkflows":
    case "LifecycleWorkflowCustomTaskExtensions":
    case "LifecycleWorkflowSettings": return entra("Microsoft_AAD_LifecycleWorkflows/LifecycleWorkflowsMenuBlade/~/overview", false)
    case "TermsOfUseAgreements": return CONDITIONAL_ACCESS("TermsOfUse")
    case "DeviceConfigurations": return configurationPage(id, 0)
    case "CompliancePolicies":
    case "DeviceCompliancePolicies": return configurationPage(id, 1)
    case "ConfigurationPolicies": {
      const template = (item.templateReference ?? {}) as Item
      const technology = str(item.technologies) || "mdm"
      const platform = str(item.platforms) || "windows10"
      const assigned = Array.isArray(item.assignments) && item.assignments.length > 0
      return intune(`Microsoft_Intune_Workflows/PolicySummaryBlade/policyId/${enc(id)}/isAssigned~/${assigned}/technology/${enc(technology)}/templateId/${enc(str(template.templateId))}/platformName/${enc(platform)}`, true)
    }
    case "Apps": return intune(`Microsoft_Intune_Apps/SettingsMenu/~/0/appId/${enc(id)}`, true)
    case "PowerShellScripts": return scriptPage(id, 0)
    case "ShellScripts": return scriptPage(id, 1)
    case "Remediations": return intune(`Microsoft_Intune_Enrollment/UXAnalyticsScriptMenu/~/properties/id/${enc(id)}/scriptName/${enc(name)}/isFirstParty~/false`, true)
    case "AppProtectionIOS":
    case "AppProtectionAndroid":
    case "AppProtectionWindows": {
      const type = str(item["@odata.type"]) || APP_PROTECTION_TYPE[folder]!
      return intune(`Microsoft_Intune/PolicyInstanceMenuBlade/~/0/policyId/${enc(id)}/policyOdataType/${enc(type)}/policyName/${enc(name)}`, true)
    }
    case "AutopilotProfiles": return intune(`Microsoft_Intune_Enrollment/AutopilotMenuBlade/~/properties/apProfileId/${enc(id)}`, true)
    // The device list; Intune opens a single device only from the list.
    case "AutopilotDevices": return intune("Microsoft_Intune_Enrollment/AutopilotDevices.ReactView/filterOnManualRemediationRequired~/false", false)
    case "FeatureUpdateProfiles": return intune(`Microsoft_Intune_DeviceConfiguration/FeatureUpdateProfile.ReactView/profileId/${enc(id)}`, true)
    case "ConditionalAccessPolicies": return entra(`Microsoft_AAD_ConditionalAccess/PolicyBlade/policyId/${enc(id)}`, true)
    case "CompliancePolicySettings": return intune("Microsoft_Intune_DeviceSettings/DevicesComplianceMenu/~/policySettings", true)

    case "GroupPolicyConfigurations":
    case "HardwareConfigurations": return DEVICES("configuration")
    case "ComplianceSettingsPolicies":
    case "ComplianceScripts":
    case "NotificationTemplates": return DEVICES("compliance")
    case "CustomAttributeScripts": return intune("Microsoft_Intune_DeviceSettings/DevicesMacOsMenu/~/customAttributes", false)
    case "QualityUpdateProfiles":
    case "QualityUpdatePolicies":
    case "DriverUpdateProfiles": return DEVICES("windows10Update")
    case "PolicySets": return DEVICES("policySets")
    case "DeviceCategories": return DEVICES("deviceCategories")
    case "DeviceCleanupRules": return DEVICES("deviceCleanUp")
    case "AssignmentFilters": return DEVICES("assignmentFilters")
    case "AppCategories": return APPS("appCategories")
    case "AppConfigurationPolicies":
    case "ManagedAppConfigurations": return APPS("configuration")
    case "EnrollmentConfigurations": return enrollmentList(item)
    case "AppleEnrollmentProfiles":
    case "AppleAutomatedEnrollment": return ENROLLMENT("appleEnrollment")
    case "AndroidEnrollmentProfiles": return ENROLLMENT("androidEnrollment")
    case "EndpointSecurityIntents": return SECURITY("overview")
    case "ReusablePolicySettings": return SECURITY("firewall")
    case "ScopeTags": return ROLES("scopeTags")
    case "RoleDefinitions": return ROLES("roles")
    case "TermsAndConditions": return TENANT_ADMIN("termsAndConditions")
    case "Branding": return TENANT_ADMIN("companyPortalBranding")
    case "MultiAdminApprovalPolicies": return TENANT_ADMIN("multiAdminApproval")
    case "NamedLocations": return CONDITIONAL_ACCESS("NamedLocations")
    case "AuthenticationStrengths": return CONDITIONAL_ACCESS("AuthStrengths")
    default: return undefined
  }
}

/** The list page of a policy type Sync and Dev to Prod write, for a link to several policies at once. */
export function adminCenterListLink(folder: string): AdminLink | undefined {
  switch (folder) {
    case "ConfigurationPolicies":
    case "DeviceConfigurations": return DEVICES("configuration")
    case "CompliancePolicies": return DEVICES("compliance")
    case "EndpointSecurityIntents": return SECURITY("overview")
    default: return undefined
  }
}

/** The same link opened in a given tenant, so an admin of several tenants lands in the right one. */
export function inTenant(url: string, tenantId: string | undefined): string {
  return tenantId ? url.replace("/#view/", `/#@${enc(tenantId)}/view/`) : url
}
