# Entra 5b verification fixtures

Layer base: 95cc95117b130fc82ed80b0b8ce3dfe6df36e7af. Verified 2026-11-16. The lab app held 58 application permissions. This broad token does not prove least privilege. All reads use the production GraphSession, readEntries, readObject and listSnapshot paths, with the engine's concurrency of eight. Graph writes are blocked before sending, and the GET-only guard is tested. Credentials, tokens and request headers are never recorded. Identifiers, names, domains and contact details are replaced before saving responses.

The local Graph index was queried for every primary endpoint and its sub-reads. Where its endpoint search missed administrative units and custom role definitions, the resource schemas, OpenAPI catalog and linked Microsoft Learn endpoint pages were checked. Stable availability is backed by successful v1.0 reads, except the unused detail and sub-read cases named below. The index's beta entries are not treated as proof that every sub-resource works in v1.0.

| Folder | Path | Version | Shape | Sign-in | Live outcome | Verification |
|---|---|---|---|---|---|---|
| AdministrativeUnits | `/directory/administrativeUnits` | v1.0 | list | both | saved (0) | Live through application read path |
| ApiConnectors | `/identity/apiConnectors` | v1.0 | list | app-only | skipped: license | Live refusal through application read path |
| AttributeSets | `/directory/attributeSets` | v1.0 | list | both | saved (0) | Live through application read path |
| AuthenticationEventListeners | `/identity/authenticationEventListeners` | v1.0 | list | both | saved (0) | Live through application read path |
| AuthenticationEventsFlows | `/identity/authenticationEventsFlows` | v1.0 | list | both | skipped: license | Live refusal through application read path |
| B2bManagementPolicies | `/policies/b2bManagementPolicies` | beta | list | both | saved (0) | Live through application read path |
| CrossTenantAccessDefault | `/policies/crossTenantAccessPolicy/default` | v1.0 | singleton | both | saved (1) | Live through application read path |
| CrossTenantAccessMtoTemplates | `/policies/crossTenantAccessPolicy/templates/multiTenantOrganizationIdentitySynchronization` and `.../multiTenantOrganizationPartnerConfiguration` | v1.0 | two singletons | both | saved (2) | Live through application read path |
| CrossTenantAccessPartners | `/policies/crossTenantAccessPolicy/partners` | v1.0 | list | both | saved (0) | Live through application read path |
| CrossTenantAccessPolicy | `/policies/crossTenantAccessPolicy` | v1.0 | singleton | both | saved (1) | Live through application read path |
| CustomAuthenticationExtensions | `/identity/customAuthenticationExtensions` | v1.0 | list | both | saved (0) | Live through application read path |
| CustomSecurityAttributeDefinitions | `/directory/customSecurityAttributeDefinitions` | v1.0 | list | both | saved (0) | Live through application read path |
| EntraRoleAssignments | `/roleManagement/directory/roleAssignments` | v1.0 | list | both | saved (15) | Live through application read path |
| EntraRoleDefinitions | `/roleManagement/directory/roleDefinitions` | v1.0 | list | both | saved (0) | Live through application read path |
| ExternalIdentitiesPolicy | `/policies/externalIdentitiesPolicy` | beta | singleton | both | saved (1) | Live through application read path |
| IdentityProviders | `/identity/identityProviders` | v1.0 | list | both | saved (3) | Live through application read path |
| MultiTenantOrganization | `/tenantRelationships/multiTenantOrganization` | v1.0 | singleton | both | saved (1) | Live through application read path |
| PimAlertConfigurations | `/identityGovernance/roleManagementAlerts/alertConfigurations` | beta | list | both | saved (7) | Live through application read path |
| PimGroupAssignmentSchedules | `/identityGovernance/privilegedAccess/group/assignmentSchedules` | v1.0 | list | both | saved (62) | Live through application read path |
| PimGroupEligibilitySchedules | `/identityGovernance/privilegedAccess/group/eligibilitySchedules` | v1.0 | list | both | saved (0) | Live through application read path |
| RoleAssignmentSchedules | `/roleManagement/directory/roleAssignmentSchedules` | v1.0 | list | both | saved (14) | Live through application read path |
| RoleEligibilitySchedules | `/roleManagement/directory/roleEligibilitySchedules` | v1.0 | list | both | saved (1) | Live through application read path |
| RoleManagementPolicies | `/policies/roleManagementPolicies` | v1.0 | list | both | saved (148) | Live through application read path |
| RoleManagementPolicyAssignments | `/policies/roleManagementPolicyAssignments` | v1.0 | list | both | saved (148) | Live through application read path |
| UserFlowAttributes | `/identity/userFlowAttributes` | v1.0 | list | both | skipped: license | Live refusal through application read path |
| UserFlows | `/identity/b2xUserFlows` | v1.0 | list | both | saved (0) | Live through application read path |

## Differences from the inventory

- The lab now has the newly granted read permissions. Roles, schedules, policy mappings, alerts and custom attribute lists can be read. The 148 role management policies each return their configurable rules through `$expand=rules`. Policy assignments use the full list response after list and detail fields matched, avoiding 148 redundant detail reads. A throttled mapping-detail experiment was rerun successfully through this list-only path. The engine follows expanded continuation pages. Derived `effectiveRules` failed on its v1.0 URL with a 400 route error and is explicitly excluded, never represented as an empty read.
- PIM endpoints reject the fetch implementation's wildcard Accept-Language with CultureNotFoundException. All role and PIM reads use Accept-Language en-US. This is request metadata, not a tenant setting.
- Identity provider listing returns three providers. An implicit EmailOtpSignup provider returns 404 from its detail path although it exists in the list. The type uses the complete list response and never converts that 404 into not configured.
- API connectors and user-flow attributes now return HTTP 400 AADB2C99039 saying that self-service sign-up is not enabled. Authentication event flows return HTTP 403 requiring EnableMsGraphAuthenticationEventListener. These are tenant feature availability refusals, classified as license or not onboarded, not permission failures or covered empty lists.
- Multitenant organization returns an inactive singleton and an empty tenant list. It is stored as read, not classified as absent.

## PIM group discovery and permissions

The PIM resource discovery endpoint returned zero resources. A separately labelled probe of the assignment schedules endpoint for the first directory group returned two schedules. Therefore resource discovery cannot establish complete schedule coverage. Production instead lists group IDs with an advanced filter for cloud-only security or Microsoft 365 groups with assigned membership. Microsoft documents dynamic and synchronized groups as unsupported. An unfiltered experiment returned ResourceTypeNotSupported for an unsupported group; this refusal is never converted to an empty answer. The supported filter returned 63 group IDs.

Group-ID enumeration adds GroupMember.Read.All to the Roles and PIM area for both modes. The existing narrow schedule read scopes remain the setup defaults. The broader application PrivilegedAccess.Read.AzureADGroup is accepted as an alternative schedule permission, confirmed by the live filtered probes. The local index lists only the least-privileged entry for /groups, so Microsoft Learn's higher-privilege table and permissions reference also establish GroupMember.Read.All. Both generated setup scripts and docs tables follow the manifest.

Each schedule type costs the paged group-ID list plus one paged schedule collection per supported group. Discovery sends ConsistencyLevel eventual and preserves the advanced supported-group filter on every page. Complete list responses are stored directly, avoiding a detail read per schedule. Group profiles, names and memberships are never fetched by discovery or saved as group backups. In the lab the final read costs 64 GETs per type: one discovery page and 63 schedule lists. Eligibility schedules are empty; assignment schedules contain 62 objects. Discovery pages, schedule pages or an unsupported scope that cannot be read leave the type incomplete. No unread group is counted as covered.

The `.probe.json` files and `pim-resource-discovery.json` are diagnostic evidence of the discovery gap and permission acceptance, separate from production coverage. They do not claim that a directory group was a PIM resource. Both complete group fan-outs are now verified live. The lab lacks the two narrow application schedule scopes, but holds their accepted broader alternative. No delegated read is claimed.

## Limits and deferred live checks

- API connectors remain app-only. The manifest's APIConnectors.Read.All delegated entry is still unconfirmed; no delegated call was made. Manual backups record an explicit skip and incomplete coverage, and do not record a loss of access. Verify a delegated read before enabling this mode.
- Nonempty cross-tenant partner synchronization, custom role definitions, administrative unit members and scoped role membership IDs, user-flow providers/attributes/languages, custom security attribute allowed values and attribute sets have no lab data. Their descriptor and storage shapes are covered by documented synthetic offline reads. Do not treat those as nonempty live verification.
- Rerun AuthenticationEventsFlows, UserFlowAttributes and ApiConnectors in a tenant with the relevant feature enabled. Their lab refusals, not successful configuration reads, are recorded here.
- No new primary type has a not-configured declaration. A sub-read 404 always fails its object; no lookup or discovery error becomes a covered empty answer.
- Directory object backups and restore remain outside this part. All 26 types have restore capability none. Derived effective rules, schedule instances, activation history, alert incidents, partner profiles, user attribute values and credential material are excluded. Public certificates are allowed as public configuration.

## Reference documentation

- [PIM resource discovery, excluded as a complete source](https://learn.microsoft.com/en-us/graph/api/privilegedaccessgroup-list-resources?view=graph-rest-1.0)
- [PIM eligibility schedule filters](https://learn.microsoft.com/en-us/graph/api/privilegedaccessgroup-list-eligibilityschedules?view=graph-rest-1.0)
- [Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference#privilegedaccessreadazureadgroup)
- [Administrative units](https://learn.microsoft.com/en-us/graph/api/directory-list-administrativeunits?view=graph-rest-1.0)
- [Partner identity synchronization](https://learn.microsoft.com/en-us/graph/api/crosstenantidentitysyncpolicypartner-get?view=graph-rest-1.0)

- [Supported PIM groups](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/concept-pim-for-groups)
- [Group discovery and permissions](https://learn.microsoft.com/en-us/graph/api/group-list?view=graph-rest-1.0)
