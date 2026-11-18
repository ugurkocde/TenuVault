import { ENTRA_AREAS } from "../../shared/services/entra"
import { restoreMatrixRow } from "../../shared/intune/restore-matrix"
import { RestoreSafetyError, writableSnapshot, addsOnlyPayload } from "../../shared/intune/restore-guards"
import type { Item, Json } from "../../shared/intune/registry"
import type { GraphReader } from "../../shared/intune/read"
import { restoreFingerprint, type GuardedStep } from "./guarded-run"

export const ENTRA_CONFIGURATION_FOLDERS = ENTRA_AREAS.filter(area => ["tenantSettings", "authentication"].includes(area.id)).flatMap(area => area.folders)
export const isEntraConfiguration = (folder: string): boolean => ENTRA_CONFIGURATION_FOLDERS.includes(folder)

export function configurationConfirmation(folder: string): string {
  if (folder === "AuthenticationMethodsPolicy") return "authentication-methods"
  if (folder === "AuthorizationPolicy") return "authorization"
  if (folder === "SecurityDefaults") return "security-defaults"
  if (/Certificate|Federated/.test(folder) || folder === "Domains") return "federation-and-certificates"
  if (/Authentication/.test(folder)) return "authentication"
  if (/PermissionGrant/.test(folder)) return "permission-grants"
  if (/AppManagement/.test(folder)) return "app-management"
  if (/Token|ClaimsMapping|HomeRealm|ActivityBased/.test(folder)) return "sign-in-policy"
  if (folder === "DeviceRegistrationPolicy") return "device-registration"
  return "configuration"
}

// Evidence and payload gaps remain explicit even after a type acquires a parent write contract.
export const CONFIGURATION_BLOCKERS: Readonly<Record<string, string>> = {
  Organization: "Organization notification emails, phones and privacy profile are never restored in 0.6 because Microsoft requires Organization.ReadWrite.All, which TenuVault never requests.",
  PermissionGrantPreApprovalPolicies: "Pre-approval conditions need a closed polymorphic schema and reference resolution.",
  DefaultAppManagementPolicy: "Credential restriction schemas and their one-way transitions need verification. Credential values are never restored.",
  AppManagementPolicies: "Credential restriction schemas, application bindings and their one-way transitions need verification.",
  TokenIssuancePolicies: "Legacy token issuance definitions need a supported definition schema and live evidence.",
  ClaimsMappingPolicies: "Claims transformations, signing-key requirements and application bindings need verification.",
  HomeRealmDiscoveryPolicies: "Home realm discovery definitions and federation relationships need verification.",
  DeviceRegistrationPolicy: "Device registration selectors, local administrator settings and lock-out effects need verification.",
  MdmEnrollmentPolicies: "No documented parent write contract and stable create key have been settled.",
  MamEnrollmentPolicies: "No documented parent write contract and stable create key have been settled.",
  Domains: "Domains cannot be restored. Federation configurations need separate verified child contracts.",
  OnPremisesSynchronization: "On-premises synchronization flags belong to the synchronization server and are never restored.",
  AuthenticationMethodsPolicy: "Authentication methods and method configurations remain blocked: a change affecting the signed-in admin is refused until usable-method and target resolution is proven. Lab verification is identical-value-only.",
  CertificateBasedAuthConfigurations: "Certificate authority chains and organization-scoped create reconciliation need verification.",
  CertificateBasedAuthPki: "PKI create remains blocked until recycle-bin-first restoration, certificate authority children and reconciliation are verified.",
  FederatedTokenValidationPolicy: "Federated domain validation keys and relationship checks need verification.",
  ContinuousAccessEvaluationPolicy: "Legacy CAE migration is a one-way action, not configuration restore. Restore access is not requested.",
  HardwareOathDevices: "Hardware OATH seeds are never returned and credentials are never restored.",
}

type Schema = "nullable-string" | "string" | "boolean" | "number" | readonly [Schema] | { readonly [key: string]: Schema }
const stringList = ["string"] as const
const schemas: Record<string, Record<string, Schema>> = {
  AuthorizationPolicy: { allowEmailVerifiedUsersToJoinOrganization: "boolean", allowInvitesFrom: "string", allowUserConsentForRiskyApps: "boolean", allowedToSignUpEmailBasedSubscriptions: "boolean", allowedToUseSSPR: "boolean", blockMsolPowerShell: "boolean", description: "string", displayName: "string", guestUserRoleId: "string" },
  SecurityDefaults: { isEnabled: "boolean" },
  AdminConsentRequestPolicy: { isEnabled: "boolean", notifyReviewers: "boolean", remindersEnabled: "boolean", requestDurationInDays: "number", reviewers: [{ query: "string", queryType: "string", queryRoot: "string" }] },
  PermissionGrantPolicies: { id: "string", displayName: "string", description: "string" },
  TokenLifetimePolicies: { definition: stringList, displayName: "string", description: "string", isOrganizationDefault: "boolean" },
  ActivityBasedTimeoutPolicies: { definition: stringList, displayName: "string", isOrganizationDefault: "boolean" },
  DirectorySettings: { templateId: "string", values: [{ name: "string", value: "string" }] },
  EntraCompanyBranding: { usernameHintText: "nullable-string" },
  AuthenticationFlowsPolicy: { selfServiceSignUp: { isEnabled: "boolean" } },
  AuthenticationContexts: { displayName: "string", description: "string", isAvailable: "boolean" },
}
function validate(value: Json, schema: Schema): boolean {
  if (schema === "nullable-string") return value === null || typeof value === "string"
  if (typeof schema === "string") return typeof value === schema && (schema !== "number" || Number.isFinite(value))
  if (Array.isArray(schema)) return Array.isArray(value) && value.length <= 1000 && value.every(child => validate(child, schema[0]!))
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([key, child]) => Object.hasOwn(schema, key) && validate(child, (schema as Record<string, Schema>)[key]!))
}
const metadata = new Set(["id", "@odata.type", "@odata.context", "@odata.etag", "createdDateTime", "modifiedDateTime", "deletedDateTime"])
const readOnly: Record<string, readonly string[]> = {
  SecurityDefaults: ["displayName", "description"],
  AdminConsentRequestPolicy: ["version"],
  DirectorySettings: ["displayName"],
  AuthenticationFlowsPolicy: ["displayName", "description"],
  Organization: ["businessPhones", "city", "country", "countryLetterCode", "defaultUsageLocation", "displayName", "isMultipleDataLocationsForServicesEnabled", "onPremisesLastSyncDateTime", "onPremisesSyncEnabled", "onPremisesSyncStatus", "partnerTenantType", "postalCode", "preferredLanguage", "state", "street", "tenantType", "directorySizeQuota", "assignedPlans", "provisionedPlans", "verifiedDomains"],
}
const emptyExtras = new Set(["appliesTo", "includes", "excludes", "localizations"])

/** Closed, deliberately partial builders. Unsupported children are refused rather than silently lost. */
export function configurationPayload(folder: string, operation: GuardedStep["operation"], snapshot: Item): Item {
  const blocked = CONFIGURATION_BLOCKERS[folder]
  if (blocked) throw new RestoreSafetyError(blocked)
  const schema = schemas[folder], contract = restoreMatrixRow(folder)?.[operation]
  if (!schema || !contract) throw new RestoreSafetyError("This configuration operation has no reviewed builder.")
  for (const [key, value] of Object.entries(snapshot)) {
    if (readOnly[folder]?.includes(key)) continue
    if (metadata.has(key) && !(key === "id" && contract.properties.includes(key))) continue
    if (emptyExtras.has(key) && Array.isArray(value) && value.length === 0) continue
    if (!contract.properties.includes(key) || !schema[key] || !validate(value, schema[key]!)) throw new RestoreSafetyError(`The ${folder} property ${key} needs a reviewed request builder.`)
  }
  const desired = writableSnapshot(snapshot, contract.properties)
  if (folder === "EntraCompanyBranding" && desired.usernameHintText === "") desired.usernameHintText = null
  if (!Object.keys(desired).length) throw new RestoreSafetyError("There are no supported configuration properties to restore.")
  if (folder === "PermissionGrantPolicies" && String(snapshot.id ?? "").startsWith("microsoft-")) throw new RestoreSafetyError("Microsoft-managed permission grant policies are never restored.")
  if (folder === "DirectorySettings" && (!Array.isArray(desired.values) || desired.values.some(value => !value || typeof value !== "object" || Array.isArray(value) || typeof value.name !== "string" || typeof value.value !== "string"))) throw new RestoreSafetyError("Directory setting values need both a name and a value.")
  if (folder === "AuthenticationFlowsPolicy" && typeof (desired.selfServiceSignUp as Item)?.isEnabled !== "boolean") throw new RestoreSafetyError("The sign-up state must be explicit.")
  if (folder === "AdminConsentRequestPolicy" && (!Number.isInteger(desired.requestDurationInDays) || Number(desired.requestDurationInDays) < 1 || Number(desired.requestDurationInDays) > 60 || !["isEnabled", "notifyReviewers", "remindersEnabled", "reviewers"].every(key => key in desired))) throw new RestoreSafetyError("Consent request replacement needs the complete configuration and a duration from 1 to 60 days.")
  if (["TokenLifetimePolicies", "ActivityBasedTimeoutPolicies"].includes(folder) && desired.isOrganizationDefault === true) throw new RestoreSafetyError("Organization-default policies are not part of the verified restore subset.")
  if (["TokenLifetimePolicies", "ActivityBasedTimeoutPolicies"].includes(folder) && (operation === "create" || "definition" in desired)) {
    const policy = folder === "TokenLifetimePolicies" ? "TokenLifetimePolicy" : "ActivityBasedTimeoutPolicy"
    const definitionSchema: Schema = folder === "TokenLifetimePolicies" ? { Version: "number", AccessTokenLifetime: "string" } : { Version: "number", ApplicationPolicies: [{ ApplicationId: "string", WebSessionIdleTimeout: "string" }] }
    if (!Array.isArray(desired.definition) || desired.definition.length !== 1) throw new RestoreSafetyError("Exactly one supported policy definition is required.")
    let parsed: Item
    try { parsed = JSON.parse(String(desired.definition[0])) } catch { throw new RestoreSafetyError("The policy definition is invalid JSON.") }
    if (!validate(parsed, { [policy]: definitionSchema }) || !parsed[policy] || (parsed[policy] as Item).Version !== 1) throw new RestoreSafetyError("The policy definition contains unsupported properties.")
  }
  return desired
}

export function configurationApproval(step: GuardedStep): string {
  return restoreFingerprint({ folder: step.folder, operation: step.operation, sourceId: step.sourceId, targetId: step.targetId ?? null, preview: step.preview, desired: step.desired, allowRemoval: step.allowRemoval === true })
}
export function requireConfigurationApproval(step: GuardedStep): void {
  if (!isEntraConfiguration(step.folder)) return
  if (step.confirmation?.kind !== configurationConfirmation(step.folder) || step.confirmation.fingerprint !== configurationApproval(step)) throw new RestoreSafetyError("Confirm this configuration separately after reviewing its exact difference. It is never part of restore all.")
}
export function configurationDifference(step: GuardedStep, current: Item | null): Array<{ property: string; before: Json; after: Json }> {
  const desired = addsOnlyPayload(current, step.desired, step.allowRemoval)
  return Object.entries(desired).filter(([key, value]) => restoreFingerprint({ value }) !== restoreFingerprint({ value: current?.[key] ?? null })).map(([property, after]) => ({ property, before: current?.[property] ?? null, after }))
}

/** Called again at the final send boundary. Unknown relationships fail closed. */
export async function checkConfigurationLockout(reader: GraphReader, step: GuardedStep, current: Item | null, desired: Item): Promise<void> {
  if (["TokenLifetimePolicies", "ActivityBasedTimeoutPolicies"].includes(step.folder) && current && current.isOrganizationDefault !== false) throw new RestoreSafetyError("Organization-default policies are not part of the verified restore subset.")
  if (step.folder === "TokenLifetimePolicies" && current) {
    const bindings = await reader.list(`policies/tokenLifetimePolicies/${encodeURIComponent(step.targetId ?? step.sourceId)}/appliesTo?$select=id`)
    if (bindings.length) throw new RestoreSafetyError("Bound token policies need a separately verified restore contract.")
  }
  if (step.folder === "SecurityDefaults" && desired.isEnabled === true) {
    const policies = await reader.list("identity/conditionalAccess/policies?$select=id,state")
    if (policies.some(policy => !["enabled", "disabled", "enabledForReportingButNotEnforced"].includes(String(policy.state)))) throw new RestoreSafetyError("Conditional Access state could not be resolved.")
    if (policies.some(policy => policy.state === "enabled")) throw new RestoreSafetyError("Security defaults cannot be enabled while Conditional Access policies are enabled.")
  }
  if (["AuthenticationMethodsPolicy", "AuthorizationPolicy"].includes(step.folder) && (!current || restoreFingerprint(writableSnapshot(current, Object.keys(desired))) !== restoreFingerprint(desired))) throw new RestoreSafetyError("A change that could remove the signed-in admin's usable authentication or authorization is refused. Only identical-value verification is allowed until safety references are proven.")
}
