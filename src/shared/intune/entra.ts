import type { Extra, IntuneType } from "./registry"

/** Configuration only. Every type stays backup-only until its restore rules are implemented. */
const limitation = "Entra ID configuration restore is not available yet."
const neverStored = ["clientSecret", "password", "privateKey", "sharedSecret", "secretKey", "tokenSeed", "seed", "tunnelKey", "keyCredentials", "passwordCredentials", "secret", "accessToken", "refreshToken", "clientAssertion", "pfx", "pkcs12", "secretText"]
const base = (folder: string, label: string, path: string, area: IntuneType["area"] = "Tenant settings"): IntuneType => ({
  folder, label, path, area, nameKey: "displayName", apiVersion: "v1.0", limitation, neverStoredKeys: neverStored,
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

export const ENTRA_TYPES: IntuneType[] = [
  {
    ...singleton("AuthorizationPolicy", "Authorization policy", "policies/authorizationPolicy"),
    additionalReadVersions: ["beta"],
    // v1.0 is an entity. Only the overrides need beta and its explicit policy ID.
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
  { ...policy("AppManagementPolicies", "App management policies", "appManagementPolicies"), neverStoredKeys: credentialRestrictions, neverStored: ["keyCredentials", "passwordCredentials"] },
  policy("TokenLifetimePolicies", "Token lifetime policies", "tokenLifetimePolicies"),
  policy("TokenIssuancePolicies", "Token issuance policies", "tokenIssuancePolicies"),
  policy("ClaimsMappingPolicies", "Claims mapping policies", "claimsMappingPolicies"),
  policy("HomeRealmDiscoveryPolicies", "Home realm discovery policies", "homeRealmDiscoveryPolicies"),
  base("ActivityBasedTimeoutPolicies", "Activity-based timeout policies", "policies/activityBasedTimeoutPolicies"),
  singleton("DeviceRegistrationPolicy", "Device registration policy", "policies/deviceRegistrationPolicy"),
  ...[["MdmEnrollmentPolicies", "MDM enrollment policies", "mobileDeviceManagementPolicies"], ["MamEnrollmentPolicies", "MAM enrollment policies", "mobileAppManagementPolicies"]].map(([folder, label, path]) => ({
    ...base(folder!, label!, `policies/${path}`), apiVersion: "beta" as const,
    extras: [{ property: "includedGroups", path: (id: string) => `policies/${path}/${id}/includedGroups?$select=id`, ids: true as const }],
  })),
  base("DirectorySettings", "Directory settings", "groupSettings"),
  { ...singleton("Organization", "Organization", "organization"), singleton: { id: "Organization", name: "Organization", collection: true } },
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
    extras: [
      // Domain-InternalFederation.Read.All may be refused even when the domain itself is readable.
      { property: "federationConfiguration", path: id => `domains/${id}/federationConfiguration`, optional: [{ status: 403 }], notConfigured: [{ status: 404, code: "Request_ResourceNotFound" }] },
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
    extras: [{ property: "certificateAuthorities", path: id => `directory/publicKeyInfrastructure/certificateBasedAuthConfigurations/${id}/certificateAuthorities` }],
  },
  {
    ...singleton("FederatedTokenValidationPolicy", "Federated token validation policy", "policies/federatedTokenValidationPolicy", "Authentication"),
    notConfigured: [{ status: 404, code: "Request_ResourceNotFound" }],
  },
  {
    ...singleton("ContinuousAccessEvaluationPolicy", "Continuous access evaluation policy", "identity/continuousAccessEvaluationPolicy", "Authentication"), apiVersion: "beta",
    notConfigured: [{ status: 404, message: "CAE settings not found" }],
  },
  { ...base("HardwareOathDevices", "Hardware OATH devices", "directory/authenticationMethodDevices/hardwareOathDevices", "Authentication"), nameKey: "serialNumber", apiVersion: "beta", inventory: true },
  base("GroupLifecyclePolicies", "Group lifecycle policies", "groupLifecyclePolicies", "Groups"),
  singleton("OwnerlessGroupPolicy", "Ownerless group policy", "policies/ownerlessGroupPolicy", "Groups"),
]
