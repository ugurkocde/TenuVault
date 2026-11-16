import type { IntuneType } from "./registry"
import { defenderSnapshot, tenantControlStates } from "./defender-snapshot"

const secrets = ["clientSecret", "password", "privateKey", "sharedSecret", "secretKey", "tokenSeed", "seed", "tunnelKey", "keyCredentials", "passwordCredentials", "secret", "accessToken", "refreshToken", "clientAssertion", "pfx", "pkcs12", "secretText", "deploymentAccessKey"]
const base = (folder: string, label: string, path: string, area: IntuneType["area"]): IntuneType => ({
  folder, label, path, area, nameKey: "displayName", apiVersion: "v1.0",
  limitation: "Defender configuration restore is not available yet.",
  neverStoredKeys: secrets, normalizeSnapshot: defenderSnapshot, unavailable: [],
  readBudget: { durationMs: 120_000, maxRequests: 500 },
})
const attack = "security/attackSimulation"
const campaign = (folder: string, label: string, collection: string): IntuneType => ({
  ...base(folder, label, `${attack}/${collection}`, "Email and collaboration"),
  // Launch and completion dates are authored campaign settings. Runs and generated schedules are data.
  neverStored: ["report", "runs", "status", "lastRunDateTime", "nextRunDateTime", "lastRunDetails", "lastModifiedDateTime"],
  unorderedCollections: { "trainingSetting.trainingAssignmentMappings": "$content" },
})
const content = (folder: string, label: string, collection: string): IntuneType => ({
  ...base(folder, label, `${attack}/${collection}`, "Email and collaboration"), filter: "source eq 'tenant'",
  skip: item => item.source !== "tenant" ? "Microsoft or unknown-source content" : undefined,
  normalizeSnapshot: item => {
    // Recheck the detail response too: a filtered list never authorizes storing global content.
    if (item.source !== "tenant") throw new Error("Microsoft Graph returned non-tenant attack simulation content")
    return defenderSnapshot(item)
  },
  neverStored: ["lastModifiedDateTime"],
})
const identity = (folder: string, label: string, path: string): IntuneType => ({
  ...base(folder, label, `security/identities/${path}`, "Identity"),
  unavailable: [{ status: 403, code: "Forbidden", message: "Tenant is not onboarded to Microsoft Defender for Identity. After license is purchased, first login to portal and sensor are required." }],
})
const reference = (property: string) => ({ property, object: true as const, path: (id: string) => `${attack}/simulations/${id}/${property}?$select=id` })

export const DEFENDER_TYPES: IntuneType[] = [
  {
    ...base("DefenderCustomDetectionRules", "Custom detection rules", "security/rules/detectionRules", "Detection and response"),
    neverStored: ["detectorId", "createdBy", "lastModifiedBy", "lastRunDetails", "status", "schedule.nextRunDateTime", "lastModifiedDateTime"],
    unorderedCollections: { "detectionAction.responseActions": "$content", "detectionAction.alertTemplate.impactedAssets": "$content" },
  },
  {
    ...base("DefenderCaseTypeConfigurations", "Case type configurations", "security/caseManagement/caseTypeConfigurations", "Detection and response"), apiVersion: "beta",
    unavailable: [{ status: 400, code: "badRequest", message: "Tenant's account is not active." }],
    extras: ["customFields", "statuses", "slaPolicies"].map(property => ({ property, path: id => `security/caseManagement/caseTypeConfigurations/${id}/${property}` })),
    unorderedCollections: { customFields: "id", statuses: "id", "statuses.customStatuses": "id", slaPolicies: "id" },
  },
  {
    ...base("DefenderWorkbooks", "Security workbooks", "security/workbooks", "Detection and response"), apiVersion: "beta", nameKey: "name",
    // The list omits content. The detail GET must explicitly select the complete document.
    select: "id,name,content",
    normalizeSnapshot: item => {
      if (!item.content || typeof item.content !== "object" || Array.isArray(item.content)) throw new Error("Microsoft Graph did not return workbook content")
      return defenderSnapshot(item)
    },
    neverStored: ["createdByUpn", "lastUpdatedByUpn", "createdAtDateTime", "updatedAtDateTime", "etag", "@odata.etag"], maxSnapshotBytes: 4 * 1024 * 1024,
  },
  {
    ...campaign("DefenderAttackSimulations", "Attack simulations", "simulations"),
    extras: [
      ...["payload", "loginPage", "landingPage"].map(reference),
      ...["includedAccountTarget", "excludedAccountTarget"].map(property => ({ property, object: true as const, path: (id: string) => `${attack}/simulations/${id}/${property}` })),
    ],
  },
  campaign("DefenderAttackSimulationAutomations", "Simulation automations", "simulationAutomations"),
  { ...campaign("DefenderAttackSimulationTrainingCampaigns", "Training campaigns", "trainingCampaigns"), apiVersion: "beta" },
  {
    ...content("DefenderAttackSimulationPayloads", "Tenant simulation payloads", "payloads"),
    extras: [{ property: "detail", object: true, path: id => `${attack}/payloads/${id}/detail` }],
    unorderedCollections: { "detail.coachMarks": "$content" },
  },
  {
    ...content("DefenderAttackSimulationLandingPages", "Tenant simulation landing pages", "landingPages"),
    extras: [{ property: "details", path: id => `${attack}/landingPages/${id}/details` }], unorderedCollections: { details: "id" },
  },
  content("DefenderAttackSimulationLoginPages", "Tenant simulation login pages", "loginPages"),
  {
    ...content("DefenderAttackSimulationNotifications", "Tenant simulation notifications", "endUserNotifications"),
    extras: [{ property: "details", path: id => `${attack}/endUserNotifications/${id}/details` }], unorderedCollections: { details: "id" },
  },
  {
    ...base("DefenderEmailSubmissionPolicies", "User reported settings policies", "security/threatSubmission/emailThreatSubmissionPolicies", "Email and collaboration"), apiVersion: "beta",
    unorderedCollections: { policyReviewers: "$content" },
  },
  {
    ...identity("DefenderIdentitySensors", "Identity sensor settings", "sensors"),
    neverStored: ["deploymentStatus", "healthStatus", "openHealthIssuesCount", "serviceStatus", "version", "createdDateTime"],
  },
  { ...identity("DefenderIdentityAutoAuditing", "Identity automatic auditing", "settings/autoAuditingConfiguration"), singleton: { id: "DefenderIdentityAutoAuditing", name: "Identity automatic auditing" } },
  { ...identity("DefenderIdentitySensorActivation", "Identity sensor activation", "sensorCandidateActivationConfiguration"), singleton: { id: "DefenderIdentitySensorActivation", name: "Identity sensor activation" } },
  {
    ...base("DefenderSecureScoreControlStates", "Secure Score control states", "security/secureScoreControlProfiles", "Posture and access"), listOnly: true,
    skip: item => tenantControlStates(item).length ? undefined : "Default Microsoft control state",
    normalizeSnapshot: item => defenderSnapshot({ id: item.id!, controlStateUpdates: tenantControlStates(item) }),
    unorderedCollections: { controlStateUpdates: "$content" },
    neverStoredKeys: [...secrets, "updatedDateTime"],
  },
  {
    ...base("DefenderRoleDefinitions", "Defender role definitions", "roleManagement/defender/roleDefinitions", "Posture and access"), apiVersion: "beta",
    unorderedCollections: { rolePermissions: "$content" },
  },
  {
    ...base("DefenderRoleAssignments", "Defender role assignments", "roleManagement/defender/roleAssignments", "Posture and access"), apiVersion: "beta",
  },
]
