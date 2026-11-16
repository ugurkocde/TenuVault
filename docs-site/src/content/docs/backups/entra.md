---
title: Entra ID configuration backups
description: Back up Entra ID tenant settings, authentication, external identities, roles, PIM policies and administrative units with TenuVault.
---

Entra ID configuration backups cover **56 types**: 20 in **Tenant settings**, eight in **Authentication**, 14 in **External identities**, 12 in **Roles and PIM**, and two tenant-wide settings in the opt-in **Groups** area. Conditional Access adds its [three existing types](/backups/conditional-access/) through an independent switch. Intune still has 41 types. With every supported service and area enabled, the desktop registry has 100 types.

Turn on **Entra ID** in **Settings > Services and permissions**. Existing tenants keep Entra ID off after updating, even with an **Everything** backup scope. **Groups** must be enabled separately. The scope picker offers only types of services and opt-in areas that are on. Areas without types in this build say so in Settings and setup.

These new types are **backup and comparison only**. Restore, drift revert, Sync, cross-tenant copy and restoring imported backups cannot write them. A selected type that cannot be read gives **coverage incomplete**, with its cause in backup results. An empty list is a covered answer, not a missing backup. The federated token validation and continuous access evaluation policies can be **not configured**.

## Coverage

**Both** means the signed-in admin or the optional Backup Reader with application permissions. **Admin** means a signed-in admin only. Holding the permission does not replace an admin role or license. All rows exclude passwords, client secrets, private keys, shared secrets, credential values, tokens, OATH seeds and tunnel keys at every depth. Public certificates are allowed.

Paths are relative to Microsoft Graph. `{organizationId}` is resolved through the organization's ID, not a name. A singleton is stored under a stable type ID, including an object that Graph returns without an ID. Reference sub-collections are stored as sorted unique IDs, without expanding people or groups.

| Folder | What is saved | Path | Version | Sign-in | Additional limits |
|---|---|---|---|---|---|
| AuthorizationPolicy | Authorization settings and default user role overrides | `/policies/authorizationPolicy` | v1.0, overrides beta | Both | Role and permission references stay as IDs |
| SecurityDefaults | Security defaults settings | `/policies/identitySecurityDefaultsEnforcementPolicy` | v1.0 | Both | No restore; successful Retry-After headers do not pause backups |
| AdminConsentRequestPolicy | Consent request settings and reviewers | `/policies/adminConsentRequestPolicy` | v1.0 | Both | Reviewer references stay as IDs |
| PermissionGrantPolicies | Permission grant conditions, including includes and excludes | `/policies/permissionGrantPolicies` | v1.0 | Both | Condition sets are configuration, not expanded directory objects |
| PermissionGrantPreApprovalPolicies | Permission pre-approval policies | `/policies/permissionGrantPreApprovalPolicies` | beta | Both | Credentials excluded |
| DefaultAppManagementPolicy | Default application and service principal restrictions | `/policies/defaultAppManagementPolicy` | v1.0 | Both | Restrictions are saved; credential values are excluded |
| AppManagementPolicies | Custom app restrictions and appliesTo IDs | `/policies/appManagementPolicies` | v1.0 | Both | No application objects are expanded |
| TokenLifetimePolicies | Token lifetime definitions and appliesTo IDs | `/policies/tokenLifetimePolicies` | v1.0 | Both | Definitions are JSON strings, not issued tokens |
| TokenIssuancePolicies | Token issuance definitions and appliesTo IDs | `/policies/tokenIssuancePolicies` | v1.0 | Both | No issued tokens |
| ClaimsMappingPolicies | Claims definitions and appliesTo IDs | `/policies/claimsMappingPolicies` | v1.0 | Both | No user claims or user objects |
| HomeRealmDiscoveryPolicies | Home realm discovery definitions and appliesTo IDs | `/policies/homeRealmDiscoveryPolicies` | v1.0 | Both | No application objects |
| ActivityBasedTimeoutPolicies | Activity timeout definitions | `/policies/activityBasedTimeoutPolicies` | v1.0 | Both | Credentials excluded |
| DeviceRegistrationPolicy | Device join, registration and local admin settings | `/policies/deviceRegistrationPolicy` | v1.0 | Both | Device objects and LAPS passwords excluded |
| MdmEnrollmentPolicies | MDM enrollment settings and included group IDs | `/policies/mobileDeviceManagementPolicies` | beta | Admin | The Backup Reader leaves it out |
| MamEnrollmentPolicies | MAM enrollment settings and included group IDs | `/policies/mobileAppManagementPolicies` | beta | Admin | The Backup Reader leaves it out |
| DirectorySettings | Customized directory settings and values | `/groupSettings` | v1.0 | Both | **Custom banned password words are stored**; they are configuration, not passwords |
| Organization | Organization properties | `/organization` | v1.0 | Both | Can include notification addresses, organization contact details and public reference data |
| EntraCompanyBranding | Default branding text, layout and localization JSON | `/organization/{organizationId}/branding` | v1.0 | Both | Images and custom CSS streams excluded; total stored JSON limited to 1 MiB |
| Domains | Domain properties, federation settings and DNS record metadata | `/domains` | v1.0 | Both | No DNS writes; a refused federation sub-read keeps domain properties with incomplete coverage |
| OnPremisesSynchronization | On-premises synchronization feature flags | `/directory/onPremisesSynchronization` | v1.0 | Admin | Connect rules, credentials and connector configuration excluded |
| AuthenticationMethodsPolicy | Method policy and embedded method configurations | `/policies/authenticationMethodsPolicy` | v1.0 | Both | No per-user authentication methods, enrollment data or secrets; beta-only methods and passkey profiles excluded |
| AuthenticationFlowsPolicy | Authentication flow policy | `/policies/authenticationFlowsPolicy` | v1.0 | Both | Credentials excluded |
| AuthenticationContexts | Authentication context definitions | `/identity/conditionalAccess/authenticationContextClassReferences` | v1.0 | Both | No sign-in history |
| CertificateBasedAuthConfigurations | Legacy trusted public certificate configuration | `/organization/{organizationId}/certificateBasedAuthConfiguration` | v1.0 | Both | Public certificates only, never private keys |
| CertificateBasedAuthPki | PKI configuration and certificate authorities | `/directory/publicKeyInfrastructure/certificateBasedAuthConfigurations` | v1.0 | Both | Public certificates only, never private keys |
| FederatedTokenValidationPolicy | Federated token validation settings | `/policies/federatedTokenValidationPolicy` | v1.0 | Both | No tokens; 404 means not configured |
| ContinuousAccessEvaluationPolicy | Legacy continuous access evaluation settings | `/identity/continuousAccessEvaluationPolicy` | beta | Both | No tokens; the specific unset-policy 404 means not configured |
| HardwareOathDevices | Hardware OATH device metadata | `/directory/authenticationMethodDevices/hardwareOathDevices` | beta | Both | No seeds; inventory counted separately from policies |
| GroupLifecyclePolicies | Tenant-wide group expiration policy | `/groupLifecyclePolicies` | v1.0 | Both | Groups area opt-in; group objects and membership excluded |
| OwnerlessGroupPolicy | Tenant-wide ownerless group notification policy | `/policies/ownerlessGroupPolicy` | v1.0 | Admin | Groups area opt-in; the Backup Reader leaves it out |

Company branding uses `Accept-Language: 0` to read the default branding, then lists its localizations. See Microsoft's [branding read contract](https://learn.microsoft.com/en-us/graph/api/organizationalbranding-get?view=graph-rest-1.0). Stream properties such as background images, logos, favicon and custom CSS are not downloaded. URL metadata may be present but does not contain the binary content. If JSON exceeds 1 MiB, the type fails visibly instead of saving truncated configuration.

A managed domain can return 404 for federationConfiguration, stored as an empty list only when the domain explicitly reports Managed authentication. For a federated domain or an unknown authentication type, that 404 leaves the federation property unread and coverage incomplete. A 403 for that sub-read also leaves the property absent and reports incomplete coverage. The parent domain and remaining DNS records are preserved if their reads and the file write succeed. A later read or storage failure is reported as a failure, even after an optional sub-read was refused.

Company branding is reported as not configured only when the branding endpoint itself returns its documented not-found answer. A failed organization lookup leaves branding unread with incomplete coverage.

## External identities

| Folder | What is stored or omitted | Graph path | Version | Sign-in |
|---|---|---|---|---|
| CrossTenantAccessPolicy | Root policy and allowed clouds | `/policies/crossTenantAccessPolicy` | v1.0 | Both |
| CrossTenantAccessDefault | Default B2B access settings | `/policies/crossTenantAccessPolicy/default` | v1.0 | Both |
| CrossTenantAccessPartners | Partner settings with identity synchronization; keyed by tenant ID; partner names excluded | `/policies/crossTenantAccessPolicy/partners` | v1.0 | Both |
| CrossTenantAccessMtoTemplates | Two templates, read separately under fixed identities | `/policies/crossTenantAccessPolicy/templates/multiTenantOrganizationIdentitySynchronization` and `.../multiTenantOrganizationPartnerConfiguration` | v1.0 | Both |
| ExternalIdentitiesPolicy | Guest leave and data removal settings | `/policies/externalIdentitiesPolicy` | beta | Both |
| B2bManagementPolicies | Legacy B2B domain restrictions | `/policies/b2bManagementPolicies` | beta | Both |
| IdentityProviders | Provider configuration from the complete list; client secrets excluded | `/identity/identityProviders` | v1.0 | Both |
| UserFlows | Self-service user flows with provider IDs, attribute assignments and language configuration | `/identity/b2xUserFlows` | v1.0 | Both |
| UserFlowAttributes | User flow attribute definitions | `/identity/userFlowAttributes` | v1.0 | Both |
| AuthenticationEventsFlows | Authentication event flow definitions; workforce tenants may lack the feature | `/identity/authenticationEventsFlows` | v1.0 | Both |
| AuthenticationEventListeners | Event listener configuration | `/identity/authenticationEventListeners` | v1.0 | Both |
| CustomAuthenticationExtensions | Extension endpoint and application references; credentials excluded | `/identity/customAuthenticationExtensions` | v1.0 | Both |
| ApiConnectors | Connector configuration; authentication configuration, passwords and certificate credentials excluded | `/identity/apiConnectors` | v1.0 | App-only |
| MultiTenantOrganization | Organization settings and tenant references; tenant names excluded | `/tenantRelationships/multiTenantOrganization` | v1.0 | Both |

## Roles and PIM

| Folder | What is stored or omitted | Graph path | Version | Sign-in |
|---|---|---|---|---|
| EntraRoleDefinitions | Custom roles only, isBuiltIn eq false; no small page-size limit | `/roleManagement/directory/roleDefinitions` | v1.0 | Both |
| EntraRoleAssignments | Principal, role and scope IDs; no expanded principals | `/roleManagement/directory/roleAssignments` | v1.0 | Both |
| RoleEligibilitySchedules | Eligibility configuration and principal IDs | `/roleManagement/directory/roleEligibilitySchedules` | v1.0 | Both |
| RoleAssignmentSchedules | Assignment schedule configuration and principal IDs | `/roleManagement/directory/roleAssignmentSchedules` | v1.0 | Both |
| RoleManagementPolicies | Directory-role policies with their configurable rules; derived effectiveRules excluded | `/policies/roleManagementPolicies` | v1.0 | Both |
| RoleManagementPolicyAssignments | Directory-role policy-to-role mappings | `/policies/roleManagementPolicyAssignments` | v1.0 | Both |
| PimGroupEligibilitySchedules | Eligibility schedules scoped to each discovered PIM group | `/identityGovernance/privilegedAccess/group/eligibilitySchedules` | v1.0 | Both |
| PimGroupAssignmentSchedules | Assignment schedules scoped to each discovered PIM group | `/identityGovernance/privilegedAccess/group/assignmentSchedules` | v1.0 | Both |
| PimAlertConfigurations | Directory-role alert settings | `/identityGovernance/roleManagementAlerts/alertConfigurations` | beta | Both |
| AdministrativeUnits | Unit properties, dynamic rules, member and scoped-role-membership IDs; no expanded people | `/directory/administrativeUnits` | v1.0 | Both |
| AttributeSets | Custom security attribute sets | `/directory/attributeSets` | v1.0 | Both |
| CustomSecurityAttributeDefinitions | Definitions with allowed values; user attribute assignments excluded | `/directory/customSecurityAttributeDefinitions` | v1.0 | Both |

PIM group schedules first list group IDs with `$select=id`, `$top=999` and an advanced filter for security or Microsoft 365 groups that are cloud-only and use assigned membership, then read schedules filtered by each group ID. This adds `GroupMember.Read.All` to the area because schedule permissions cannot list groups. The group list reads IDs only; group profiles and memberships are not backed up by this discovery. The PIM resources endpoint is insufficient: it returned zero resources in the lab while a directory group returned assignment schedules.

Per schedule type, the request cost is the paged group-ID list, a paged schedule list per supported directory group, with every schedule stored from its complete list response. This can be expensive in a large tenant. In the lab, each type made 64 GETs across 63 supported groups, finding zero eligibility schedules and 62 assignment schedules. Every supported group must be checked before an empty result can mean complete coverage; a refused group lookup or page leaves coverage incomplete.

Role management policy lists and mappings keep `scopeId eq '/' and scopeType eq 'DirectoryRole'` on every page. Role policy rules are expanded from each policy, with continuation pages read when present. PIM requests send `Accept-Language: en-US` because the service rejects the wildcard language header. No schedule instances, activation history, alert incidents or expanded principal profiles are stored. PIM features can require P2 or Governance licensing.

API connectors are **app-only** in this build. Microsoft documents only a delegated write scope, and no delegated read has been verified. Manual backups leave this type out with incomplete coverage; scheduled backups with the Backup Reader can read it when the feature is enabled. Authentication event flows, user-flow attributes and API connectors may answer that a feature is unavailable in a workforce tenant. That is reported as unavailable or not onboarded, not as a missing permission or an empty covered list.

Provider secrets, API connector credentials, passwords, private keys, token seeds and tunnel keys are never stored. Public certificates may be stored as public configuration. Administrative unit relationships and user-flow provider relationships store sorted unique IDs. Cross-tenant targets stay as ID references in their access settings. Partner tenant IDs are retained; no partner profiles are fetched.

## Comparison, counts and other features

All 56 types can be compared between backups, including singletons. Reports show configuration changes without inventing audit actors. Hardware OATH devices are inventory and do not increase policy counts. The other 55 types count as configuration on backup lists, results and dashboards. Hygiene has no rules for these Entra ID types and excludes them. Live change watching and audit alert suggestions continue to cover Intune and Conditional Access only; new Entra settings do not masquerade as Intune policies.

Azure Automation cloud backups remain limited to Intune and the separately configured Conditional Access types in 0.6. Use desktop manual or desktop scheduled backups for these Entra ID types. The Backup Reader cannot read the four Admin-only types above.

## Not covered in this part

Governance, users, groups with membership, applications, enterprise apps, grants, devices and contacts have no new backup types in this part. Their manifest permissions may already be shown during setup. Turning on an area without types prepares that choice, and the app says that no types exist for it yet.

Four researched settings remain excluded because no requestable read permission was proven for the endpoint and sign-in mode:

- Service principal creation policies: the app-only read returns 403 without a confirmed read permission.
- Entra admin center restriction (`/admin/entra/uxSetting`): a broad lab token can read it, but that does not identify which permission to request.
- Feature rollout policies: an empty app-only response does not establish the undocumented application permission. The index's delegated permission has not been verified by a signed-in admin.
- On-premises authentication policies: delegated-only permission in the index, without a verified delegated read; the app-only lab read is refused.

The following configuration cannot be exported through these Microsoft Graph endpoints:

- Full SSPR scope, registration, notifications and password writeback settings. Only the admin SSPR flag in the authorization policy is included.
- Legacy MFA service settings, trusted IPs, app passwords, remember MFA and account lockout.
- Legacy Identity Protection risk policies and notification settings. Current Conditional Access equivalents remain in the separate area.
- Diagnostic log export settings, Azure RBAC, management groups and the elevated access toggle, which use Azure Resource Manager.
- Entra Connect synchronization rules and connector configuration, which live on the sync server.
- Verified ID authorities and contracts, which use a separate API.
- Enterprise State Roaming settings, preview feature toggles, LinkedIn account connections, My Apps collections and self-service My Groups toggles. Group creation rights exposed by authorization and directory settings are included.
- Global Secure Access, event history, passwords, user authentication methods, private keys, app secrets, identity provider secrets, API connector credentials and OATH seeds.
