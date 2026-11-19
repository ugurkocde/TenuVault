---
title: Entra ID configuration backups
description: Back up Entra ID tenant settings, authentication, external identities, roles, PIM policies, administrative units and governance with TenuVault.
---

Entra ID backups cover **74 types**, including seven opt-in directory inventories and **67 configuration types**: 20 in **Tenant settings**, eight in **Authentication**, 14 in **External identities**, 12 in **Roles and PIM**, 11 in **Governance**, and two tenant-wide settings in the opt-in **Groups** area. Conditional Access adds its [three existing types](/backups/conditional-access/) through an independent switch. Intune still has 41 types. With every supported service and area enabled, the desktop registry has 135 types.

Turn on **Entra ID** in **Settings > Services and permissions**. Existing tenants keep Entra ID off after updating, even with an **Everything** backup scope. **Groups** must be enabled separately. The scope picker offers only types of services and opt-in areas that are on. Areas without types in this build say so in Settings and setup.

Seven configuration types support individually confirmed restore subsets: token lifetime policies, activity-based timeout policies, company branding, authentication flows, the cross-tenant parent policy name, unpublished access-package catalogs and the access-review ownership flag. See [restore safety and limitations](/restore/identity/). Users and Groups also have separately reviewed directory restore subsets described below. Other types remain backup and comparison only. Sync, drift revert and cross-tenant copy cannot write these new types. A selected type that cannot be read gives **coverage incomplete**, with its cause in backup results. An empty list is a covered answer, not a missing backup. The federated token validation and continuous access evaluation policies can be **not configured**.

## Coverage

**Both** means the signed-in admin or the optional Backup Reader with application permissions. **Admin** means a signed-in admin only. Holding the permission does not replace an admin role or license. All rows exclude passwords, client secrets, private keys, shared secrets, credential values, tokens, OATH seeds and tunnel keys at every depth. Public certificates are allowed.

Paths are relative to Microsoft Graph. `{organizationId}` is resolved through the organization's ID, not a name. A singleton is stored under a stable type ID, including an object that Graph returns without an ID. Reference sub-collections are stored as sorted unique IDs, without expanding people or groups.

| Folder or configuration | What is saved | Path | Version | Sign-in | Limits or exclusion reason |
|---|---|---|---|---|---|
| AuthorizationPolicy | Authorization settings and default user role overrides | `/policies/authorizationPolicy` | v1.0, overrides beta | Both | Role and permission references stay as IDs |
| SecurityDefaults | Security defaults settings | `/policies/identitySecurityDefaultsEnforcementPolicy` | v1.0 | Both | No restore; successful Retry-After headers do not pause backups |
| AdminConsentRequestPolicy | Consent request settings and reviewers | `/policies/adminConsentRequestPolicy` | v1.0 | Both | Reviewer queries and IDs are retained without personal labels |
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
| Organization | Organization properties | `/organization` | v1.0 | Both | Configured notification addresses and organization contact details are stored; synchronization run times and status are excluded |
| EntraCompanyBranding | Default branding text, layout and localization JSON | `/organization/{organizationId}/branding` | v1.0 | Both | Images and custom CSS streams excluded; total stored JSON limited to 1 MiB |
| Domains | Domain properties, federation settings and DNS record metadata | `/domains` | v1.0 | Both | Federation certificate refresh status and last-run time are excluded; a refused federation sub-read keeps domain properties with incomplete coverage |
| OnPremisesSynchronization | On-premises synchronization feature flags | `/directory/onPremisesSynchronization` | v1.0 | Admin | Connect rules, credentials and connector configuration excluded |
| AuthenticationMethodsPolicy | Method policy and embedded method configurations | `/policies/authenticationMethodsPolicy` | v1.0 | Both | Target IDs, target types and method settings are stored; target names and personal profiles are excluded |
| AuthenticationFlowsPolicy | Authentication flow policy | `/policies/authenticationFlowsPolicy` | v1.0 | Both | Credentials excluded |
| AuthenticationContexts | Authentication context definitions | `/identity/conditionalAccess/authenticationContextClassReferences` | v1.0 | Both | No sign-in history |
| CertificateBasedAuthConfigurations | Legacy trusted public certificate configuration | `/organization/{organizationId}/certificateBasedAuthConfiguration` | v1.0 | Both | Public certificates only, never private keys |
| CertificateBasedAuthPki | PKI configuration and certificate authorities | `/directory/publicKeyInfrastructure/certificateBasedAuthConfigurations` | v1.0 | Both | Public certificates are stored; upload status and status details are excluded |
| FederatedTokenValidationPolicy | Federated token validation settings | `/policies/federatedTokenValidationPolicy` | v1.0 | Both | No tokens; 404 means not configured |
| ContinuousAccessEvaluationPolicy | Legacy continuous access evaluation settings | `/identity/continuousAccessEvaluationPolicy` | beta | Both | No tokens; the specific unset-policy 404 means not configured |
| HardwareOathDevices | Hardware OATH device metadata | `/directory/authenticationMethodDevices/hardwareOathDevices` | beta | Both | Assignee ID only; assignee names, last-use time, activation status and secret seeds are excluded |
| GroupLifecyclePolicies | Tenant-wide group expiration policy | `/groupLifecyclePolicies` | v1.0 | Both | Groups area opt-in; group objects and memberships are the separate Groups inventory type |
| OwnerlessGroupPolicy | Tenant-wide ownerless group notification policy | `/policies/ownerlessGroupPolicy` | v1.0 | Admin | Groups area opt-in; the Backup Reader leaves it out |
| CrossTenantAccessPolicy | Root policy and allowed clouds | `/policies/crossTenantAccessPolicy` | v1.0 | Both | Credentials and runtime history excluded |
| CrossTenantAccessDefault | Default B2B access settings | `/policies/crossTenantAccessPolicy/default` | v1.0 | Both | User and group targets retain IDs and target types without names |
| CrossTenantAccessPartners | Partner settings with identity synchronization; keyed by tenant ID; partner names excluded | `/policies/crossTenantAccessPolicy/partners` | v1.0 | Both | Partner and target IDs are retained without names or personal profiles |
| CrossTenantAccessMtoTemplates | Two templates, read separately under fixed identities | `/policies/crossTenantAccessPolicy/templates/multiTenantOrganizationIdentitySynchronization` and `.../multiTenantOrganizationPartnerConfiguration` | v1.0 | Both | Target IDs, target types and template configuration are retained without personal labels |
| ExternalIdentitiesPolicy | Guest leave and data removal settings | `/policies/externalIdentitiesPolicy` | beta | Both | Credentials and runtime history excluded |
| B2bManagementPolicies | Legacy B2B domain restrictions | `/policies/b2bManagementPolicies` | beta | Both | Credentials and runtime history excluded |
| IdentityProviders | Provider configuration from the complete list; client secrets excluded | `/identity/identityProviders` | v1.0 | Both | Credentials and runtime history excluded |
| UserFlows | Self-service user flows with provider IDs, attribute assignments and language configuration | `/identity/b2xUserFlows` | v1.0 | Both | Credentials and runtime history excluded |
| UserFlowAttributes | User flow attribute definitions | `/identity/userFlowAttributes` | v1.0 | Both | Credentials and runtime history excluded |
| AuthenticationEventsFlows | Authentication event flow definitions; workforce tenants may lack the feature | `/identity/authenticationEventsFlows` | v1.0 | Both | Credentials and runtime history excluded |
| AuthenticationEventListeners | Event listener configuration | `/identity/authenticationEventListeners` | v1.0 | Both | Credentials and runtime history excluded |
| CustomAuthenticationExtensions | Extension endpoint and application references; credentials excluded | `/identity/customAuthenticationExtensions` | v1.0 | Both | Credentials and runtime history excluded |
| ApiConnectors | Connector configuration; authentication configuration, passwords and certificate credentials excluded | `/identity/apiConnectors` | v1.0 | App-only | Credentials and runtime history excluded |
| MultiTenantOrganization | Organization settings and tenant references; tenant names excluded | `/tenantRelationships/multiTenantOrganization` | v1.0 | Both | Member tenant IDs and desired role/state are retained; names and transition processing status/details are excluded |
| EntraRoleDefinitions | Custom roles only, isBuiltIn eq false; no small page-size limit | `/roleManagement/directory/roleDefinitions` | v1.0 | Both | Credentials and runtime history excluded |
| EntraRoleAssignments | Principal, role and scope IDs; no expanded principals | `/roleManagement/directory/roleAssignments` | v1.0 | Both | Principal IDs are stored; any returned principal profiles are reduced to IDs |
| RoleEligibilitySchedules | Eligibility configuration and principal IDs | `/roleManagement/directory/roleEligibilitySchedules` | v1.0 | Both | Principal IDs and configured schedule dates are stored; request status and principal profiles are excluded |
| RoleAssignmentSchedules | Assignment schedule configuration and principal IDs | `/roleManagement/directory/roleAssignmentSchedules` | v1.0 | Both | Principal IDs and configured schedule dates are stored; request status and principal profiles are excluded |
| RoleManagementPolicies | Directory-role policies with their configurable rules; derived effectiveRules excluded | `/policies/roleManagementPolicies` | v1.0 | Both | Approver IDs/selectors and modifier ID only; effective rules and personal labels excluded; configured notification recipient emails are stored |
| RoleManagementPolicyAssignments | Directory-role policy-to-role mappings | `/policies/roleManagementPolicyAssignments` | v1.0 | Both | Credentials and runtime history excluded |
| PimGroupEligibilitySchedules | Eligibility schedules scoped to each discovered PIM group | `/identityGovernance/privilegedAccess/group/eligibilitySchedules` | v1.0 | Both | Principal IDs and configured schedule dates are stored; request status and principal profiles are excluded |
| PimGroupAssignmentSchedules | Assignment schedules scoped to each discovered PIM group | `/identityGovernance/privilegedAccess/group/assignmentSchedules` | v1.0 | Both | Principal IDs and configured schedule dates are stored; request status and principal profiles are excluded |
| PimAlertConfigurations | Directory-role alert settings | `/identityGovernance/roleManagementAlerts/alertConfigurations` | beta | Both | Alert configuration is stored; no alert incidents, runtime history or principal profiles |
| AdministrativeUnits | Unit properties, dynamic rules, member and scoped-role-membership IDs; no expanded people | `/directory/administrativeUnits` | v1.0 | Both | Credentials and runtime history excluded |
| AttributeSets | Custom security attribute sets | `/directory/attributeSets` | v1.0 | Both | Credentials and runtime history excluded |
| CustomSecurityAttributeDefinitions | Definitions with allowed values; user attribute assignments excluded | `/directory/customSecurityAttributeDefinitions` | v1.0 | Both | Credentials and runtime history excluded |
| AccessPackageCatalogs | Catalog properties and resources with roles and scopes | `/identityGovernance/entitlementManagement/catalogs` | v1.0 | Both | Resource definitions only; actor names and pending-onboarding state excluded; actor objects retain IDs |
| AccessPackages | Package settings, catalog ID, resource role scopes and incompatible package/group IDs | `/identityGovernance/entitlementManagement/accessPackages` | v1.0 | Both | No assignments, requests or subject profiles; actor names excluded and actor objects retain IDs |
| AccessPackageAssignmentPolicies | Assignment policy definitions, questions, extension stage configuration, approval stages and access package ID | `/identityGovernance/entitlementManagement/assignmentPolicies` | v1.0 | Both | Subject types, IDs, manager levels and rules retained; subject descriptions and profile labels excluded; policy description retained; on-behalf requestors sorted by normalized identity |
| ConnectedOrganizations | Organization configuration, identity sources and sponsor IDs | `/identityGovernance/entitlementManagement/connectedOrganizations` | v1.0 | Both | Sponsors are sorted unique IDs; actor names excluded and actor objects retain IDs |
| EntitlementManagementSettings | External-user lifecycle settings | `/identityGovernance/entitlementManagement/settings` | v1.0 | Both | Singleton; no external user objects |
| AccessReviewDefinitions | Review definitions, scopes, reviewers and recurrence | `/identityGovernance/accessReviews/definitions` | v1.0 | Both | Reviewer queries/selectors and creator ID only; personal labels, request status, instances and decisions excluded |
| AccessReviewPolicy | Tenant-wide review policy | `/policies/accessReviewPolicy` | beta | Both | Singleton with a stable stored ID |
| LifecycleWorkflows | Current workflow configuration and tasks with arguments | `/identityGovernance/lifecycleWorkflows/workflows` | v1.0 | Both | Current tasks and configured schedule switches retained; next/last execution times, quarantine state, computed execution/preview scopes, versions, runs and results excluded |
| LifecycleWorkflowCustomTaskExtensions | Custom task endpoint and authentication resource references | `/identityGovernance/lifecycleWorkflows/customTaskExtensions` | v1.0 | Both | No credential values or actor names; returned actor objects retain IDs |
| LifecycleWorkflowSettings | Workflow schedule settings | `/identityGovernance/lifecycleWorkflows/settings` | v1.0 | Both | Singleton; Governance licensing may be required |
| TermsOfUseAgreements | Agreement settings and localized file metadata | `/identityGovernance/termsOfUse/agreements` | v1.0 | Both | PDF fileData and acceptances excluded; stored JSON limited to 1 MiB |
| ServicePrincipalCreationPolicies | Not covered | /policies/servicePrincipalCreationPolicies | n/a | n/a | No requestable read permission proven; app-only refusal |
| EntraUxSetting | Not covered | /admin/entra/uxSetting | n/a | n/a | Broad token reads it, but no requestable read permission is established |
| FeatureRolloutPolicies | Not covered | /policies/featureRolloutPolicies | n/a | n/a | Application permission unconfirmed; no delegated verification |
| OnPremisesAuthenticationPolicies | Not covered | /policies/onPremisesAuthenticationPolicy | n/a | n/a | Delegated permission unverified; app-only refused |
| DirectoryRoleAccessReviewPolicy | Not covered | /policies/directoryRoleAccessReviewPolicy | n/a | n/a | Broad app token returns 200; index publishes no read permission; least privilege unproven |
| ApplicationProxyConnectorGroups | Not covered | /onPremisesPublishingProfiles/applicationProxy/connectorGroups | n/a | n/a | Broad app token returns 200; index lists delegated Directory.ReadWrite.All only; no read permission confirmed |
| SSPR configuration | Not covered | Not exposed by these Graph APIs | n/a | n/a | Only the admin SSPR flag in authorization policy is included |
| Legacy MFA settings | Not covered | Not exposed by these Graph APIs | n/a | n/a | Trusted IPs, app passwords, remembered MFA and lockout excluded |
| Legacy Identity Protection policies and notifications | Not covered | Not exposed by these Graph APIs | n/a | n/a | Current Conditional Access equivalents use the independent switch |
| Diagnostic settings, Azure RBAC, management groups, elevated access | Not covered | Azure Resource Manager | n/a | n/a | Outside Microsoft Graph configuration coverage |
| Entra Connect rules and connector configuration | Not covered | On-premises server | n/a | n/a | Only synchronization feature flags are covered |
| Verified ID authorities and contracts | Not covered | Separate Verified ID API | n/a | n/a | Outside these Graph endpoints |
| Enterprise State Roaming, preview toggles, LinkedIn connections, My Apps collections, My Groups toggles | Not covered | Not exportable through these endpoints | n/a | n/a | Group creation rights exposed in authorization and directory settings are covered |
| Global Secure Access | Not covered | /networkAccess | n/a | n/a | Outside 0.6 |
| Secrets and user authentication methods | Not covered | Not exported | n/a | n/a | Passwords, private keys, app and provider secrets, API connector credentials, OATH seeds and tunnel keys excluded |
| Runtime and history data | Not covered | Review instances, decisions, acceptances, workflow versions/runs, sign-in and audit history | n/a | n/a | Current configuration only |
| Binary branding and terms content | Not covered | Branding streams, custom CSS and agreement fileData | n/a | n/a | JSON configuration and file metadata only; no binary streaming in this layer |

Company branding uses `Accept-Language: 0` to read the default branding, then lists its localizations. See Microsoft's [branding read contract](https://learn.microsoft.com/en-us/graph/api/organizationalbranding-get?view=graph-rest-1.0). Stream properties such as background images, logos, favicon and custom CSS are not downloaded. URL metadata may be present but does not contain the binary content. If JSON exceeds 1 MiB, the type fails visibly instead of saving truncated configuration.

A managed domain can return 404 for federationConfiguration, stored as an empty list only when the domain explicitly reports Managed authentication. For a federated domain or an unknown authentication type, that 404 leaves the federation property unread and coverage incomplete. A 403 for that sub-read also leaves the property absent and reports incomplete coverage. The parent domain and remaining DNS records are preserved if their reads and the file write succeed. A later read or storage failure is reported as a failure, even after an optional sub-read was refused.

Company branding is reported as not configured only when the branding endpoint itself returns its documented not-found answer. A failed organization lookup leaves branding unread with incomplete coverage.

## Directory references and stored addresses

All 67 configuration types normalize directory references before storage, comparison and fingerprinting. People are referenced by ID. Subject sets retain their Graph type and selectors, including user, group, connected organization and service principal IDs, manager levels, fallback flags, membership rules and reviewer queries. Graph-provided subject descriptions, names, UPNs and profile email fields are excluded at every depth. This also applies to nested approval and escalation stages, fallback reviewers, on-behalf requestors, lifecycle scopes and returned principal or actor objects. Older actor fields returned as names rather than ID objects are omitted; actor GUID strings are retained as IDs. Existing backups are not rewritten. Comparing a new backup with an older one that contains excluded fields can show those removals once.

Policy names and policy descriptions remain configuration. Configured notification email addresses are also stored, including role management rule `notificationRecipients`, organization notification addresses and group lifecycle `alternateNotificationEmails`. These configured destinations are retained even when they address an individual. Ownerless-group sender email settings and lifecycle email configuration remain part of the policy.

Execution state is excluded rather than fingerprinted: workflow next-run time, quarantine and computed scopes/results; PIM schedule request status; review-series status; hardware OATH last use and activation status; synchronization run times; federation certificate refresh results; PKI upload status; resource onboarding state; and multitenant transition processing details. Configured schedule start/end dates, recurrence, enabled flags, desired tenant role/state, and public certificates remain stored.

## Roles and PIM


PIM group schedules first list group IDs with `$select=id`, `$top=999` and an advanced filter for security or Microsoft 365 groups that are cloud-only and use assigned membership, then read schedules filtered by each group ID. This adds `GroupMember.Read.All` to the area because schedule permissions cannot list groups. The group list reads IDs only; group profiles and memberships are not backed up by this discovery. The PIM resources endpoint is insufficient: it returned zero resources in the lab while a directory group returned assignment schedules.

Each backup discovers candidate group IDs once and shares them between both PIM group schedule types. Each type has a 120-second budget, including discovery waits and throttling, and at most 500 schedule GET requests, including retries and continuation pages. Shared group discovery also has a 120-second limit. If a limit is reached, that schedule type is reported as not fully read with coverage incomplete. Other types and services, including Intune, continue and are saved. Cancelling the backup cancels pending discovery and schedule requests.

The request cost is one shared paged group-ID list plus a paged schedule list per supported directory group for each schedule type. Every schedule is stored from its complete list response. In the lab, discovery took one GET across 63 supported groups, followed by 63 eligibility GETs and 63 assignment GETs, 127 GETs in total. They found zero eligibility schedules and 62 assignment schedules. Every supported group must be checked before an empty result can mean complete coverage; a refused group lookup or page leaves coverage incomplete.

Role management policy lists and mappings keep `scopeId eq '/' and scopeType eq 'DirectoryRole'` on every page. Role policy rules are expanded from each policy, with continuation pages read when present. PIM requests send `Accept-Language: en-US` because the service rejects the wildcard language header. Role policy rules and other unordered configuration collections are stored in stable ID order, including appended pages, so a different response order does not create a change. No schedule instances, activation history, alert incidents or expanded principal profiles are stored. PIM features can require P2 or Governance licensing.

API connectors are **app-only** in this build. Microsoft documents only a delegated write scope, and no delegated read has been verified. Manual backups leave this type out with incomplete coverage and the cause "needs the Backup Reader; a signed-in admin cannot read it". This restriction is separate from missing permissions. Scheduled backups with the Backup Reader can read it when the feature is enabled. Authentication event flows, user-flow attributes and API connectors may answer that a feature is unavailable in a workforce tenant. That is reported as unavailable or not onboarded, not as a missing permission or an empty covered list.

Provider secrets, API connector credentials, passwords, private keys, token seeds and tunnel keys are never stored. Public certificates may be stored as public configuration. Administrative unit relationships and user-flow provider relationships store sorted unique IDs. Cross-tenant targets stay as ID references in their access settings. Partner tenant IDs are retained; no partner profiles are fetched.

## Comparison, counts and other features

All 67 types can be compared between backups, including singletons. Reports show configuration changes without inventing audit actors. Hardware OATH devices are inventory and do not increase policy counts. The other 66 types count as configuration on backup lists, results and dashboards. Hygiene has no rules for these Entra ID types and excludes them. Live change watching and audit alert suggestions continue to cover Intune and Conditional Access only; new Entra settings do not masquerade as Intune policies.

Azure Automation cloud backups remain limited to Intune and the separately configured Conditional Access types in 0.6. Use desktop manual or desktop scheduled backups for these Entra ID types. The Backup Reader cannot read the four Admin-only types above.

## Governance verification and limits

Governance and PIM features can require Entra ID P2 or ID Governance. Lifecycle workflows require the applicable Governance license. The lab's 58-permission app token read the General catalog, entitlement settings and access review policy. Access packages, assignment policies, connected organizations, review definitions and agreements returned covered empty lists. All three lifecycle endpoints returned HTTP 403 with code `Access denied` and an explicit insufficient-license message. Those exact answers on each type's own list or singleton read are classified as license or not onboarded, with incomplete coverage. They do not say the app lacks a permission. Detail and sub-read errors keep their own meaning; unknown license errors fail visibly.

Each Governance type has a shared 120-second deadline starting at its first read and at most 500 actual Graph GETs, including list pages, detail reads, sub-collections, retries and expanded pages. Reaching a limit ends only that type with incomplete coverage. Other types and services continue. Cancellation also interrupts these reads. No unread resource or page is counted as covered.

Catalog resources use v1.0 `catalogs/{id}/resources?$expand=roles,scopes`, rather than the older beta catalog paths. Package resource role scopes include their role and scope definitions. Assignment policies expand their questions and custom extension stage settings. A required expanded collection omitted by Graph fails the read instead of counting as covered. Expanded pages are followed, including nested roles and scopes. Unordered collections are sorted by stable identity; ID-less reviewer queries, normalized subject selectors (including on-behalf requestors) and identity sources use their complete stored content. Directory labels do not participate in that identity. Approval stage order is retained, and tasks keep their execution sequence settings.

Workflow versions are history and are excluded. Only current workflow tasks are saved. Access reviews save definitions only, without instances or decisions. Terms of use store agreement settings and localized file metadata (name, language, default/version flags and dates), with a 1 MiB JSON limit. PDF content is excluded even when Graph returns it inline as base64 `fileData`, similar to the excluded branding binary streams. Export those files separately if you need them.

Nonempty package relationships, sponsors, review definitions, terms files and licensed lifecycle configurations were unavailable in this lab. Their offline fixtures are labelled documented synthetic configuration. No delegated Governance read or least-privilege isolated token read is claimed. No Governance type needs another application permission grant in this lab. Rerun lifecycle reads in a licensed tenant, and the other empty collections with configuration present.

The table above is the complete configuration inventory across all three Entra parts, including exclusions and their reasons. Azure Automation remains Intune and Conditional Access only.

## Screenshots

![Governance coverage in Settings](/images/services/entra-backup-types-light.png)
![Governance coverage during setup](/images/onboarding/03-choice-governance-light.png)

See the dark-mode variants in the [Services screenshot inventory](/images/services/README.md) and [onboarding screenshot inventory](/images/onboarding/README.md).

## Graph references

- [Catalog resources and their roles and scopes](https://learn.microsoft.com/en-us/graph/api/accesspackagecatalog-list-resources?view=graph-rest-1.0)
- [Package resource role scopes](https://learn.microsoft.com/en-us/graph/api/accesspackage-list-resourcerolescopes?view=graph-rest-1.0)
- [Agreement localized file metadata](https://learn.microsoft.com/en-us/graph/api/agreement-list-files?view=graph-rest-1.0)
- [Subject set types and their policy locations](https://learn.microsoft.com/en-us/graph/api/resources/subjectset?view=graph-rest-1.0)
- [Single-user subject descriptions contain the user name](https://learn.microsoft.com/en-us/graph/api/resources/singleuser?view=graph-rest-1.0)
- [Role policy notification recipients](https://learn.microsoft.com/en-us/graph/api/resources/unifiedrolemanagementpolicynotificationrule?view=graph-rest-1.0)
- [Workflow runtime fields](https://learn.microsoft.com/en-us/graph/api/resources/identitygovernance-workflow?view=graph-rest-1.0)
- [Hardware OATH assignees and last-use metadata](https://learn.microsoft.com/en-us/graph/api/resources/hardwareoathtokenauthenticationmethoddevice?view=graph-rest-beta)
- [Federation certificate refresh status](https://learn.microsoft.com/en-us/graph/api/resources/signingcertificateupdatestatus?view=graph-rest-1.0)

## Opt-in directory inventories

All seven types use paged capture and indexes and are available to both backup sign-in modes. Users and Groups have limited restore subsets through the signed-in admin only; the other five remain backup and comparison only. New and existing tenants leave Groups, Users and devices, and Applications off until an admin enables each area. Settings and onboarding explain the personal data each area stores. The Backup Reader gets these areas' application permissions only when requested. The existing 67 configuration types retain their read path.

| Folder | What is stored | Graph path | Version | Sign-in | Excluded or limited |
| --- | --- | --- | --- | --- | --- |
| Users | Allowlisted identity, job, organization, account state, licenses and manager ID | `/users` | v1.0 | Both | No passwords, authentication methods or sign-in activity |
| Groups | Group properties, dynamic rule, role-assignable flag, settings, sorted member and owner IDs | `/groups` | v1.0; members and owners beta | Both | No mailbox, Teams or SharePoint content |
| Applications | App registration definitions, owner IDs, federated identity credentials and extension properties | `/applications` | v1.0 | Both | Password hints and credential metadata only; no secret values or certificate bytes |
| ServicePrincipals | Enterprise app properties, owner IDs, role assignment definitions and assigned policy IDs | `/servicePrincipals` | v1.0 | Both | Microsoft-owned apps excluded by default; no provisioning jobs, secrets or signing key bytes |
| OAuth2PermissionGrants | Client, resource and principal object IDs, consent type and scopes | `/oauth2PermissionGrants` | v1.0 | Both | No tokens or consent restore |
| EntraDevices | Device registration inventory | `/devices` | v1.0 | Both | No device credentials, recovery keys or registration restore |
| OrgContacts | Organization contact profiles, phones and addresses | `/contacts` | v1.0 | Both | Graph exposes these read-only; no personal mailbox contacts |

Directory imports require the sharded tar format and validate object IDs before reading snapshots. Imported snapshots and relationship definitions must satisfy the same closed property allowlists as captured Graph responses. Legacy ZIP archives cannot introduce directory objects with named files. Existing Intune ZIP archives remain supported.

The exact [property allowlists](/security/data-flows/#directory-property-allowlists) include every retained nested field. Graph cannot return application secret values or private keys. Certificate bytes are deliberately not requested. Assigned enterprise app policy references can need additional access that Graph enforces; a refusal keeps the app with incomplete coverage rather than requesting a write permission. The Microsoft-owned filter is `appOwnerOrganizationId ne f8cdef31-a31e-4b4a-93e4-5f571e91255a`, with `ConsistencyLevel: eventual` and `$count=true`. This excludes the owner tenant from the inventory, without excluding tenant-created applications based on display names or tags.

### Directory restore availability

**Review directory restore** restores disabled cloud member creation, user display names, static security-group creation/descriptions, saved managers, ordinary user member adds/removals and owner additions. Security-group creation needs fresh readable proof of a tenant-wide Groups Administrator or Global Administrator assignment, preventing implicit caller ownership. Each row needs its own approval. Exact membership is a choice for that group; owner removal remains blocked after live refusals. Saved pages resume through the same directory flow.

Account state, recycle recovery, guests, licenses, Microsoft 365 groups, dynamic rules, privileged group relationships and nested principals remain blocked with specific reasons. A recreated object gets a new ID and needs reference review. [Directory restore](/restore/identity/#users-and-groups) describes the closed subsets, approvals and limitations. Backup capture and Backup Reader provisioning and renewal are unchanged.

### Relationships and incomplete coverage

Collection and relationship GETs request `$top=999`; members, owners and policy references request `$select=id`. Graph can choose smaller pages. Every continuation is followed within the shared type budget, including retries. Up to four directory objects run concurrently, each with at most eight independent relationship reads. Snapshot uploads stay bounded at 16. A failed read drains its siblings before the object ends; no full relationship list is collected in memory. Group members and owners use beta because [v1.0 omits service principals](https://learn.microsoft.com/en-us/graph/known-issues). Definitions are bounded at 8 KiB each. Sorting uses the encrypted temporary runs described under [Large tenants](/backups/storage/#large-tenants).

An object-specific HTTP 403 or 404 on a relationship retains its parent with `complete: false` on that relationship, discards any partial list and continues to the next object. No names or Graph error text are copied into directory failure logs. Users expand only the manager ID in the paged list; an absent manager is stored as a complete null reference. The type and run report incomplete coverage, so partial relationships cannot be used as a complete comparison or restore source. A refused collection page, expired paging token, transport failure or exhausted budget ends that type with incomplete coverage; other types continue. Hidden group membership can need `Member.Read.Hidden`. This release does not request or accept that extra application role for the Backup Reader; a refused relationship remains incomplete. Graph does not expose owners for some Exchange-created, distribution and synchronized groups, and these backups cannot recover information Graph omits.

Directory objects are inventory in the dashboard and reports. Hygiene skips them. Backup comparison and drift read sorted index pages on demand. Live change watching and audit alert suggestions cover Intune and Conditional Access only. Backup completion notifications carry counts and type labels, without directory display names, UPNs or mail values. Azure Automation remains Intune and Conditional Access only.

The dashboard counts directory objects separately as inventory. A directory-only backup protects zero policies; mixed backups show the policy count and the inventory count independently, including the latest backup and activity cards.

## Verified configuration restore subsets

External identities restore writes only the parent cross-tenant policy display name. Defaults, partners and cloud endpoints are excluded. Governance restore supports unpublished, externally hidden user-managed catalog metadata without resources or assignments, and the access-review ownership flag (beta), never review definitions, decisions or notifications. Each operation needs its own preview and confirmation. The [permission table](/security/permissions/#restore-write-permissions-in-06) lists every write scope, why it is the least-privileged option and when it is requested.

Custom attributes remain blocked after a live HTTP 400 AADB2C99039 create refusal. The external-identities leave flag was verified with identical values only. Lifecycle settings returned HTTP 403 before any write; workflow writes were outside the approved lab scope. The required permissions do not establish licensing or onboarding.

Directory.Read.All is requested only as a backup read in the opt-in Groups and Applications areas, for group lifecycle policies and delegated permission grants. Microsoft offers no narrower read permission for these types. Both signed-in admin and Backup Reader setups retain this coverage. Directory.Read.All is never a restore permission. Directory.ReadWrite.All and Organization.ReadWrite.All are never requested.
