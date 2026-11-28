# Entra 5a verification fixtures

Layer base: ccdd5d12. Lab reads: 2026-11-15. The app token held 58 application permissions. No least-privilege isolation is claimed from that broad token. All endpoint reads used the application GraphSession, organizationReader and readObject paths. Graph writes were blocked and the guard was asserted. Credentials and tokens were never logged or recorded. Identifiers, domains, names and contact details were replaced before writing these fixtures.

Each type has its own sanitized live response file. Four additional `.documented.json` files use resource schemas from the local Microsoft Graph index, with synthetic values, for the admin-only side. They are not evidence of a delegated lab read. `legacy-everything.json` freezes the Intune folder order from the layer base. The local index was checked for all primary paths and relationships; its catalog is beta, so stable version availability was also checked by successful v1.0 lab reads.

| Folder | Path | Version | Shape | Sign-in | Live outcome | Verification |
|---|---|---|---|---|---|---|
| ActivityBasedTimeoutPolicies | `/policies/activityBasedTimeoutPolicies` | v1.0 | list | both | saved (0) | Live through read path |
| AdminConsentRequestPolicy | `/policies/adminConsentRequestPolicy` | v1.0 | singleton | both | saved (1) | Live through read path |
| AppManagementPolicies | `/policies/appManagementPolicies` | v1.0 | list | both | saved (0) | Live through read path |
| AuthenticationContexts | `/identity/conditionalAccess/authenticationContextClassReferences` | v1.0 | list | both | saved (0) | Live through read path |
| AuthenticationFlowsPolicy | `/policies/authenticationFlowsPolicy` | v1.0 | singleton | both | saved (1) | Live through read path |
| AuthenticationMethodsPolicy | `/policies/authenticationMethodsPolicy` | v1.0 | singleton | both | saved (1) | Live through read path |
| AuthorizationPolicy | `/policies/authorizationPolicy` | v1.0 | singleton | both | saved (1) | Live through read path |
| CertificateBasedAuthConfigurations | `/organization/{organizationId}/certificateBasedAuthConfiguration` | v1.0 | list | both | saved (0) | Live through read path |
| CertificateBasedAuthPki | `/directory/publicKeyInfrastructure/certificateBasedAuthConfigurations` | v1.0 | list | both | saved (0) | Live through read path |
| ClaimsMappingPolicies | `/policies/claimsMappingPolicies` | v1.0 | list | both | saved (0) | Live through read path |
| ContinuousAccessEvaluationPolicy | `/identity/continuousAccessEvaluationPolicy` | beta | singleton | both | notConfigured | Live through read path |
| DefaultAppManagementPolicy | `/policies/defaultAppManagementPolicy` | v1.0 | singleton | both | saved (1) | Live through read path |
| DeviceRegistrationPolicy | `/policies/deviceRegistrationPolicy` | v1.0 | singleton | both | saved (1) | Live through read path |
| DirectorySettings | `/groupSettings` | v1.0 | list | both | saved (0) | Live through read path |
| Domains | `/domains` | v1.0 | list | both | saved (4) | Live through read path |
| EntraCompanyBranding | `/organization/{organizationId}/branding` | v1.0 | singleton | both | saved (1) | Live through read path |
| FederatedTokenValidationPolicy | `/policies/federatedTokenValidationPolicy` | v1.0 | singleton | both | notConfigured | Live through read path |
| GroupLifecyclePolicies | `/groupLifecyclePolicies` | v1.0 | list | both | saved (0) | Live through read path |
| HardwareOathDevices | `/directory/authenticationMethodDevices/hardwareOathDevices` | beta | list | both | saved (0) | Live through read path |
| HomeRealmDiscoveryPolicies | `/policies/homeRealmDiscoveryPolicies` | v1.0 | list | both | saved (0) | Live through read path |
| MamEnrollmentPolicies | `/policies/mobileAppManagementPolicies` | beta | list | admin | skipped: signedIn | Live app-only refusal; documented admin shape |
| MdmEnrollmentPolicies | `/policies/mobileDeviceManagementPolicies` | beta | list | admin | skipped: signedIn | Live app-only refusal; documented admin shape |
| OnPremisesSynchronization | `/directory/onPremisesSynchronization` | v1.0 | list | admin | skipped: permission | Live app-only refusal; documented admin shape |
| Organization | `/organization` | v1.0 | one-item collection | both | saved (1) | Live through read path |
| OwnerlessGroupPolicy | `/policies/ownerlessGroupPolicy` | v1.0 | singleton | admin | skipped: permission | Live app-only refusal; documented admin shape |
| PermissionGrantPolicies | `/policies/permissionGrantPolicies` | v1.0 | list | both | saved (14) | Live through read path |
| PermissionGrantPreApprovalPolicies | `/policies/permissionGrantPreApprovalPolicies` | beta | list | both | saved (0) | Live through read path |
| SecurityDefaults | `/policies/identitySecurityDefaultsEnforcementPolicy` | v1.0 | singleton | both | saved (1) | Live through read path |
| TokenIssuancePolicies | `/policies/tokenIssuancePolicies` | v1.0 | list | both | saved (0) | Live through read path |
| TokenLifetimePolicies | `/policies/tokenLifetimePolicies` | v1.0 | list | both | saved (0) | Live through read path |

## Differences and limits

- Branding requires `Accept-Language: 0` for default branding. A wildcard gets 400; an unconfigured locale can get 404. The default and its localization list were read successfully. JSON is capped at 1 MiB; images and custom CSS streams are excluded.
- The v1.0 device registration response includes an ID in this lab, although the earlier research described it as ID-less. Its stored singleton identity does not rely on a Graph ID.
- The authorization policy root uses v1.0. Default user role overrides exist only under the explicit beta path `/policies/authorizationPolicy/authorizationPolicy/defaultUserRoleOverrides`, not directly below the v1.0 singleton path.
- All four lab domains were managed. Their federation sub-resource returns 404, stored as an empty list. A scripted 403 proves domains and DNS metadata are kept with incomplete coverage when federation reads are refused. No federated domain was available for a live nonempty federation read.
- The newly granted permissions allow permission grant policies and their condition sets, the pre-approval list, and the PKI list to be read. Empty policy and PKI lists do not verify their detail or relationship reads live; those use schema-shaped offline responses and sorted-ID tests.
- Security defaults answers 200 with Retry-After 1209600. The engine regression test proves that this successful response never pauses or ends the backup.
- Four types require a signed-in admin: MDM enrollment, MAM enrollment, on-premises synchronization, ownerless group policy. The app-only side was read and refused; the admin side uses explicitly labelled documented fixtures. Rerun these with a delegated admin, not with more application permissions.
- No selected type awaits an application read permission grant. Nonempty appliesTo, includedGroups and certificate-authority relationships still need future live data; offline tests exercise their stored shapes.
- Service principal creation policies and on-premises authentication policies were refused. The Entra admin center restriction and feature rollout list answer a broad app token but do not establish a requestable read permission for that mode. All four remain outside the manifest and registry, with the reasons on the Entra backup docs page.

The read path keeps permission grant includes and excludes as condition sets. They are policy definitions, not expanded users or groups. AppliesTo and includedGroups relationships store sorted unique IDs only. App management passwordCredentials and keyCredentials are credential restriction definitions, not credentials: restrictions are preserved while actual top-level credentials and nested secretText values are stripped.
