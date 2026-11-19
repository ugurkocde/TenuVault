import { area, part, type PermissionArea } from "./areas"

/**
 * The areas of Entra ID with the Microsoft Graph permissions each folder needs. A folder is the
 * name its backup type is stored under; the types themselves are added to the registry separately,
 * so a folder listed here may not be backed up by this version yet.
 *
 * Every permission was checked against Microsoft's permission model and permissions reference, and
 * where the lab tenant could answer, against a live read. test/fixtures/permission-verification.json
 * records the result for each one; a permission that is not recorded there fails a test.
 *
 * Left out, because Microsoft publishes no read permission TenuVault could ask for: service
 * principal creation policies, the Entra admin center setting, the directory role access review
 * policy, feature rollout policies, on-premises authentication policies and application proxy
 * connector groups.
 */
export const ENTRA_AREAS: readonly PermissionArea[] = [
  area({ id: "tenantSettings", label: "Tenant settings" }, [
    part(["AuthorizationPolicy"], [["Policy.Read.All", "Policy.ReadWrite.Authorization"]], [["Policy.Read.All"]], "unsupported"),
    part(["SecurityDefaults"], [["Policy.Read.All"]], [["Policy.Read.All"]], "unsupported"),
    part(["AdminConsentRequestPolicy"], [["Policy.Read.All", "Policy.ReadWrite.ConsentRequest", "Directory.Read.All", "Directory.ReadWrite.All"]], [["Policy.Read.All"]], "unsupported"),
    part(["PermissionGrantPolicies"], [["Policy.Read.PermissionGrant", "Policy.ReadWrite.PermissionGrant"]], [["Policy.Read.PermissionGrant"]], "unsupported"),
    part(["PermissionGrantPreApprovalPolicies"], [["Policy.Read.PermissionGrant", "Policy.ReadWrite.PermissionGrant"]], [["Policy.Read.PermissionGrant"]], "unsupported"),
    part(["DefaultAppManagementPolicy"], [["Policy.Read.All", "Policy.ReadWrite.ApplicationConfiguration"]], [["Policy.Read.All"]], "unsupported"),
    part(["AppManagementPolicies", "TokenIssuancePolicies", "ClaimsMappingPolicies", "HomeRealmDiscoveryPolicies"], [["Policy.Read.All", "Policy.ReadWrite.ApplicationConfiguration"]], [["Policy.Read.All"]], "unsupported"),
    part(["TokenLifetimePolicies"], [["Policy.Read.All", "Policy.ReadWrite.ApplicationConfiguration"]], [["Policy.Read.All"]], [["Policy.ReadWrite.ApplicationConfiguration"], ["Application.Read.All", "Application.ReadWrite.All"]]),
    part(["ActivityBasedTimeoutPolicies"], [["Policy.Read.All", "Policy.ReadWrite.ApplicationConfiguration"]], [["Policy.Read.All"]], [["Policy.ReadWrite.ApplicationConfiguration"]]),
    // For app-only access Microsoft lists Policy.Read.DeviceConfiguration only, so the Backup Reader gets that one.
    part(["DeviceRegistrationPolicy"], [["Policy.Read.All", "Policy.Read.DeviceConfiguration", "Policy.ReadWrite.DeviceConfiguration"]], [["Policy.Read.DeviceConfiguration"]], "unsupported"),
    part(["MdmEnrollmentPolicies", "MamEnrollmentPolicies"], [["Policy.Read.All", "Policy.ReadWrite.MobilityManagement"]], "unsupported", "unsupported"),
    // The lab token held Directory.Read.All, so GroupSettings.Read.All is from Microsoft's permission model, not a live read.
    part(["DirectorySettings"], [["GroupSettings.Read.All", "GroupSettings.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"]], [["GroupSettings.Read.All"]], "unsupported"),
    part(["Organization"], [["Organization.Read.All", "Directory.Read.All", "Directory.ReadWrite.All"]], [["Organization.Read.All"]], "unsupported"),
    part(["EntraCompanyBranding"], [["Organization.Read.All", "OrganizationalBranding.Read.All", "OrganizationalBranding.ReadWrite.All"]], [["Organization.Read.All"]], [["OrganizationalBranding.ReadWrite.All"]]),
    // Domains remain backup-only. Microsoft's page for one federation setting lists Domain.Read.All; its list page names only Domain-InternalFederation.Read.All.
    part(["Domains"], [["Domain.Read.All", "Domain.ReadWrite.All"]], [["Domain.Read.All"]], "unsupported"),
    // Never restored: the flags belong to the sync server.
    part(["OnPremisesSynchronization"], [["OnPremDirectorySynchronization.Read.All", "OnPremDirectorySynchronization.ReadWrite.All"]], "unsupported", "unsupported"),
  ]),
  area({ id: "authentication", label: "Authentication" }, [
    part(["AuthenticationMethodsPolicy"], [["Policy.Read.All", "Policy.Read.AuthenticationMethod", "Policy.ReadWrite.AuthenticationMethod"]], [["Policy.Read.All"]], "unsupported"),
    part(["AuthenticationFlowsPolicy"], [["Policy.Read.All", "Policy.ReadWrite.AuthenticationFlows"]], [["Policy.Read.All"]], [["Policy.ReadWrite.AuthenticationFlows"]]),
    // The lab token also held Policy.Read.ConditionalAccess, so the live read does not prove Policy.Read.All covers it.
    part(["AuthenticationContexts"], [["AuthenticationContext.Read.All", "AuthenticationContext.ReadWrite.All", "Policy.ReadWrite.ConditionalAccess"]], [["AuthenticationContext.Read.All"]], "unsupported"),
    part(["CertificateBasedAuthConfigurations"], [["Organization.Read.All"]], [["Organization.Read.All"]], "unsupported"),
    part(["CertificateBasedAuthPki"], [["PublicKeyInfrastructure.Read.All", "PublicKeyInfrastructure.ReadWrite.All"]], [["PublicKeyInfrastructure.Read.All"]], "unsupported"),
    part(["FederatedTokenValidationPolicy"], [["Policy.Read.All", "Policy.ReadWrite.FedTokenValidation"]], [["Policy.Read.All"]], "unsupported"),
    // A legacy setting that Conditional Access replaced. Its write permission changes every Conditional Access policy, so setup never asks for it on Entra ID's account.
    part(["ContinuousAccessEvaluationPolicy"], [["Policy.Read.All"]], [["Policy.Read.All"]], "unsupported"),
    // Never restored: Microsoft never returns the token seeds.
    part(["HardwareOathDevices"], [["Policy.Read.All"]], [["Policy.Read.All"]], "unsupported"),
  ]),
  area({ id: "externalIdentities", label: "External identities" }, [
    part(["CrossTenantAccessPolicy"], [["Policy.Read.All", "Policy.ReadWrite.CrossTenantAccess"]], [["Policy.Read.All"]], [["Policy.ReadWrite.CrossTenantAccess"]]),
    part(["CrossTenantAccessDefault", "CrossTenantAccessPartners", "CrossTenantAccessMtoTemplates"], [["Policy.Read.All", "Policy.ReadWrite.CrossTenantAccess"]], [["Policy.Read.All"]], "unsupported"),
    part(["ExternalIdentitiesPolicy"], [["Policy.Read.All", "Policy.ReadWrite.ExternalIdentities"]], [["Policy.Read.All"]], "unsupported"),
    // The lab read succeeded app-only with Policy.Read.All alone, but Microsoft lists only the B2B management permissions, so those are what TenuVault asks for.
    part(["B2bManagementPolicies"], [["Policy.Read.B2BManagementPolicy", "Policy.ReadWrite.B2BManagementPolicy"]], [["Policy.Read.B2BManagementPolicy"]], "unsupported"),
    part(["IdentityProviders"], [["IdentityProvider.Read.All", "IdentityProvider.ReadWrite.All"]], [["IdentityProvider.Read.All"]], "unsupported"),
    part(["UserFlows", "UserFlowAttributes"], [["IdentityUserFlow.Read.All", "IdentityUserFlow.ReadWrite.All"]], [["IdentityUserFlow.Read.All"]], "unsupported"),
    part(["AuthenticationEventsFlows", "AuthenticationEventListeners"], [["EventListener.Read.All", "EventListener.ReadWrite.All"]], [["EventListener.Read.All"]], "unsupported"),
    part(["CustomAuthenticationExtensions"], [["CustomAuthenticationExtension.Read.All", "CustomAuthenticationExtension.ReadWrite.All"]], [["CustomAuthenticationExtension.Read.All"]], "unsupported"),
    // Microsoft's pages list only APIConnectors.ReadWrite.All; the refusal in the lab names APIConnectors.Read.All as enough.
    part(["ApiConnectors"], [["APIConnectors.Read.All", "APIConnectors.ReadWrite.All"]], [["APIConnectors.Read.All"]], "unsupported"),
    // Never restored: joining needs both tenants.
    part(["MultiTenantOrganization"], [["MultiTenantOrganization.Read.All", "MultiTenantOrganization.ReadWrite.All"]], [["MultiTenantOrganization.Read.All"]], "unsupported"),
  ]),
  area({ id: "roles", label: "Roles and PIM" }, [
    part(["EntraRoleDefinitions", "EntraRoleAssignments"], [["RoleManagement.Read.Directory", "RoleManagement.ReadWrite.Directory", "Directory.Read.All", "Directory.ReadWrite.All"]], [["RoleManagement.Read.Directory"]], "unsupported"),
    part(["RoleEligibilitySchedules"], [["RoleManagement.Read.Directory", "RoleEligibilitySchedule.Read.Directory", "RoleEligibilitySchedule.ReadWrite.Directory", "RoleManagement.ReadWrite.Directory"]], [["RoleManagement.Read.Directory"]], "unsupported"),
    part(["RoleAssignmentSchedules"], [["RoleManagement.Read.Directory", "RoleAssignmentSchedule.Read.Directory", "RoleAssignmentSchedule.ReadWrite.Directory", "RoleManagement.ReadWrite.Directory"]], [["RoleManagement.Read.Directory"]], "unsupported"),
    part(["RoleManagementPolicies"], [["RoleManagement.Read.Directory", "RoleManagementPolicy.Read.Directory", "RoleManagementPolicy.ReadWrite.Directory", "RoleManagement.ReadWrite.Directory"]], [["RoleManagement.Read.Directory"]], "unsupported"),
    // Never restored: a read-only mapping of policy to role.
    part(["RoleManagementPolicyAssignments"], [["RoleManagement.Read.Directory", "RoleManagementPolicy.Read.Directory", "RoleManagementPolicy.ReadWrite.Directory", "RoleManagement.ReadWrite.Directory"]], [["RoleManagement.Read.Directory"]], "unsupported"),
    // Schedule discovery needs group IDs: PIM resources omit groups that still have schedules.
    part(["PimGroupEligibilitySchedules"], [["PrivilegedEligibilitySchedule.Read.AzureADGroup", "PrivilegedEligibilitySchedule.ReadWrite.AzureADGroup"], ["GroupMember.Read.All", "Group.Read.All", "Directory.Read.All"]], [["PrivilegedEligibilitySchedule.Read.AzureADGroup", "PrivilegedAccess.Read.AzureADGroup"], ["GroupMember.Read.All"]], "unsupported"),
    part(["PimGroupAssignmentSchedules"], [["PrivilegedAssignmentSchedule.Read.AzureADGroup", "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup"], ["GroupMember.Read.All", "Group.Read.All", "Directory.Read.All"]], [["PrivilegedAssignmentSchedule.Read.AzureADGroup", "PrivilegedAccess.Read.AzureADGroup"], ["GroupMember.Read.All"]], "unsupported"),
    part(["PimAlertConfigurations"], [["RoleManagementAlert.Read.Directory", "RoleManagementAlert.ReadWrite.Directory"]], [["RoleManagementAlert.Read.Directory"]], "unsupported"),
    // Scoped role members are read and written with the role management permission.
    part(["AdministrativeUnits"], [["AdministrativeUnit.Read.All", "AdministrativeUnit.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"], ["RoleManagement.Read.Directory", "RoleManagement.ReadWrite.Directory", "Directory.Read.All", "Directory.ReadWrite.All"]], [["AdministrativeUnit.Read.All"], ["RoleManagement.Read.Directory"]], "unsupported"),
    part(["AttributeSets", "CustomSecurityAttributeDefinitions"], [["CustomSecAttributeDefinition.Read.All", "CustomSecAttributeDefinition.ReadWrite.All"]], [["CustomSecAttributeDefinition.Read.All"]], "unsupported"),
  ]),
  area({ id: "governance", label: "Governance" }, [
    part(["AccessPackageCatalogs"], [["EntitlementManagement.Read.All", "EntitlementManagement.ReadWrite.All"]], [["EntitlementManagement.Read.All"]], [["EntitlementManagement.ReadWrite.All"]]),
    part(["AccessPackages", "AccessPackageAssignmentPolicies", "ConnectedOrganizations", "EntitlementManagementSettings"], [["EntitlementManagement.Read.All", "EntitlementManagement.ReadWrite.All"]], [["EntitlementManagement.Read.All"]], "unsupported"),
    part(["AccessReviewDefinitions"], [["AccessReview.Read.All", "AccessReview.ReadWrite.All"]], [["AccessReview.Read.All"]], "unsupported"),
    part(["AccessReviewPolicy"], [["Policy.Read.All", "Policy.ReadWrite.AccessReview"]], [["Policy.Read.All"]], [["Policy.ReadWrite.AccessReview"]]),
    part(["LifecycleWorkflows", "LifecycleWorkflowCustomTaskExtensions", "LifecycleWorkflowSettings"], [["LifecycleWorkflows.Read.All", "LifecycleWorkflows.ReadWrite.All"]], [["LifecycleWorkflows.Read.All"]], "unsupported"),
    // Microsoft's pages list delegated access only; the refusal of an app-only read in the lab names the application role.
    part(["TermsOfUseAgreements"], [["Agreement.Read.All", "Agreement.ReadWrite.All"]], [["Agreement.Read.All"]], "unsupported"),
  ]),
  area({ id: "groups", label: "Groups", optIn: true, personalData: true }, [
    part(["Groups"], [["Group.Read.All", "Group.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"]], [["Group.Read.All"]], [["Group.ReadWrite.All"], ["GroupMember.ReadWrite.All"], ["User.Read.All"], ["Application.Read.All"], ["Policy.Read.All"], ["RoleManagement.Read.Directory"]]),
    // Microsoft offers no narrower permission. The write permission changes the whole directory, so setup never asks for it.
    part(["GroupLifecyclePolicies"], [["Directory.Read.All", "Directory.ReadWrite.All"]], [["Directory.Read.All"]], "unsupported"),
    part(["OwnerlessGroupPolicy"], [["Group.Read.All", "Group.ReadWrite.All"]], "unsupported", "unsupported"),
  ]),
  area({ id: "usersAndDevices", label: "Users and devices", optIn: true, personalData: true }, [
    part(["Users"], [["User.Read.All", "User.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"]], [["User.Read.All"]], [["User.Create"], ["User.ReadUpdate.All"], ["User.ReadWrite.All"], ["Application.Read.All"]]),
    // Never restored: a device object is created by registration.
    part(["EntraDevices"], [["Device.Read.All", "Directory.Read.All", "Directory.ReadWrite.All"]], [["Device.Read.All"]], "unsupported"),
    // Never restored: contacts are managed through Exchange.
    part(["OrgContacts"], [["OrgContact.Read.All", "Directory.Read.All", "Directory.ReadWrite.All"]], [["OrgContact.Read.All"]], "unsupported"),
  ]),
  area({ id: "applications", label: "Applications", optIn: true, personalData: true }, [
    part(["Applications"], [["Application.Read.All", "Application.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"]], [["Application.Read.All"]], "unsupported"),
    // Provisioning jobs are read with the synchronization permission. App role assignments are written with AppRoleAssignment.ReadWrite.All.
    part(["ServicePrincipals"], [["Application.Read.All", "Application.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"], ["Synchronization.Read.All", "Synchronization.ReadWrite.All"]], [["Application.Read.All"], ["Synchronization.Read.All"]], "unsupported"),
    // Microsoft offers no narrower read permission.
    part(["OAuth2PermissionGrants"], [["Directory.Read.All", "DelegatedPermissionGrant.ReadWrite.All", "Directory.ReadWrite.All"]], [["Directory.Read.All"]], "unsupported"),
  ]),
]
