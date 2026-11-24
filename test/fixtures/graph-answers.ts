import type { SkipCause } from "../../src/shared/backup-outcomes"

/**
 * How Microsoft Graph refuses a read of an Entra ID or Defender endpoint.
 *
 * "lab" answers were returned by the lab tenant on 2026-11-14 to GET requests with an app-only
 * token: status, error code and message are as received, and the body is rebuilt in the shape
 * Graph sends (without innerError, which holds only request IDs and a date). "inventory" answers
 * are the ones the research recorded as text (tasks/0.6-research/entra-inventory.md and
 * defender-inventory.md), with the code a guess. "documented" is Microsoft's documented answer
 * that the lab never produced.
 */
export interface GraphAnswerFixture {
  name: string
  source: "lab" | "inventory" | "documented"
  endpoint: string
  status: number
  /** The response body as Graph sends it. */
  body: string
  /** What the body yields as error code and message. */
  answer: { code?: string; message?: string }
  /**
   * What the answer means for the type, when the token holds the type's permission (`held`), when
   * it does not or that is unknown (`notHeld`), for a signed-in admin and for the Backup Reader.
   */
  expect: { delegatedHeld: SkipCause | "failed"; otherwise: SkipCause | "failed" }
}

const graph = (code: string, message: string) => JSON.stringify({ error: { code, message } })

const HTML_401 = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\r\n<html xmlns="http://www.w3.org/1999/xhtml">\r\n<head>\r\n<title>401 - Unauthorized: Access is denied due to invalid credentials.</title>\r\n</head>\r\n<body>\r\n<div id="header"><h1>Server Error</h1></div>\r\n<div id="content">\r\n <div class="content-container"><fieldset>\r\n  <h2>401 - Unauthorized: Access is denied due to invalid credentials.</h2>\r\n  <h3>You do not have permission to view this directory or page using the credentials that you supplied.</h3>\r\n </fieldset></div>\r\n</div>\r\n</body>\r\n</html>\r\n`

const MISSING_ROLES = "Missing application roles. API required roles: CustomDetection.ReadWrite.All,CustomDetection.Read.All, application roles: Policy.Read.ConditionalAccess,DeviceManagementManagedDevices.Read.All,Device.Read.All,SecurityEvents.Read.All,Group.Read.All,Directory.Read.All,User.Read.All,Policy.Read.All."

export const GRAPH_ANSWERS: GraphAnswerFixture[] = [
  {
    name: "an HTML page instead of an error (user reported settings policy)",
    source: "lab",
    endpoint: "beta/security/threatSubmission/emailThreatSubmissionPolicies",
    status: 401,
    body: HTML_401,
    answer: {},
    expect: { delegatedHeld: "permission", otherwise: "permission" },
  },
  {
    name: "an endpoint that takes no app-only call (mobility management policies)",
    source: "lab",
    endpoint: "beta/policies/mobileDeviceManagementPolicies",
    status: 401,
    body: graph("AccessDenied", "Unsupported app-only call."),
    answer: { code: "AccessDenied", message: "Unsupported app-only call." },
    expect: { delegatedHeld: "signedIn", otherwise: "signedIn" },
  },
  {
    name: "a sign-in Microsoft no longer accepts",
    source: "documented",
    endpoint: "any",
    status: 401,
    body: graph("InvalidAuthenticationToken", "Access token has expired or is not yet valid."),
    answer: { code: "InvalidAuthenticationToken", message: "Access token has expired or is not yet valid." },
    expect: { delegatedHeld: "failed", otherwise: "failed" },
  },
  {
    name: "a refusal with no body at all (Defender unified RBAC)",
    source: "lab",
    endpoint: "beta/roleManagement/defender/roleDefinitions",
    status: 403,
    body: "",
    answer: {},
    expect: { delegatedHeld: "role", otherwise: "permission" },
  },
  {
    name: "a tenant that never onboarded the product (Defender for Identity)",
    source: "lab",
    endpoint: "v1.0/security/identities/sensors",
    status: 403,
    body: graph("Forbidden", "Tenant is not onboarded to Microsoft Defender for Identity. After license is purchased, first login to portal and sensor are required. For more info: https://learn.microsoft.com/en-us/defender-for-identity/deploy/deploy-defender-identity"),
    answer: { code: "Forbidden", message: "Tenant is not onboarded to Microsoft Defender for Identity. After license is purchased, first login to portal and sensor are required. For more info: https://learn.microsoft.com/en-us/defender-for-identity/deploy/deploy-defender-identity" },
    expect: { delegatedHeld: "license", otherwise: "license" },
  },
  {
    name: "a product that is not active in the tenant (case management)",
    source: "lab",
    endpoint: "beta/security/caseManagement/caseTypeConfigurations",
    status: 400,
    body: graph("badRequest", "Tenant's account is not active."),
    answer: { code: "badRequest", message: "Tenant's account is not active." },
    expect: { delegatedHeld: "license", otherwise: "license" },
  },
  {
    name: "a feature only another kind of tenant has (authentication events flows)",
    source: "lab",
    endpoint: "v1.0/identity/authenticationEventsFlows",
    status: 403,
    body: graph("AADB2C", "Unauthorized. Access to this Api requires feature: 'EnableMsGraphAuthenticationEventListener' for the tenant: 'ffc10f05-e837-4803-81b1-7c4dee678c2a'."),
    answer: { code: "AADB2C", message: "Unauthorized. Access to this Api requires feature: 'EnableMsGraphAuthenticationEventListener' for the tenant: 'ffc10f05-e837-4803-81b1-7c4dee678c2a'." },
    expect: { delegatedHeld: "license", otherwise: "license" },
  },
  {
    name: "application roles named in the refusal (custom detection rules)",
    source: "lab",
    endpoint: "v1.0/security/rules/detectionRules",
    status: 403,
    body: graph("Forbidden", MISSING_ROLES),
    answer: { code: "Forbidden", message: MISSING_ROLES },
    expect: { delegatedHeld: "permission", otherwise: "permission" },
  },
  {
    name: "application permissions named in the refusal (identity providers)",
    source: "lab",
    endpoint: "v1.0/identity/identityProviders",
    status: 403,
    body: graph("AADB2C", "The application does not have any of the required application permissions (IdentityProvider.Read.All, IdentityProvider.ReadWrite.All) to access the resource. "),
    answer: { code: "AADB2C", message: "The application does not have any of the required application permissions (IdentityProvider.Read.All, IdentityProvider.ReadWrite.All) to access the resource. " },
    expect: { delegatedHeld: "permission", otherwise: "permission" },
  },
  {
    name: "permission scopes named in a body without the error wrapper (PIM eligibility schedules)",
    source: "lab",
    endpoint: "v1.0/roleManagement/directory/roleEligibilitySchedules",
    status: 403,
    body: JSON.stringify({ errorCode: "PermissionScopeNotGranted", message: "Authorization failed due to missing permission scope RoleEligibilitySchedule.Read.Directory,RoleEligibilitySchedule.ReadWrite.Directory,RoleManagement.ReadWrite.Directory,RoleManagement.Read.Directory,RoleManagement.Read.All.", instanceAnnotations: [] }),
    answer: { code: "PermissionScopeNotGranted", message: "Authorization failed due to missing permission scope RoleEligibilitySchedule.Read.Directory,RoleEligibilitySchedule.ReadWrite.Directory,RoleManagement.ReadWrite.Directory,RoleManagement.Read.Directory,RoleManagement.Read.All." },
    expect: { delegatedHeld: "permission", otherwise: "permission" },
  },
  {
    name: "a refusal that names nothing (permission grant policies)",
    source: "lab",
    endpoint: "v1.0/policies/permissionGrantPolicies",
    status: 403,
    body: graph("Authorization_RequestDenied", "Insufficient privileges to complete the operation."),
    answer: { code: "Authorization_RequestDenied", message: "Insufficient privileges to complete the operation." },
    expect: { delegatedHeld: "role", otherwise: "permission" },
  },
  {
    name: "a refusal that names nothing, in other words (entitlement management)",
    source: "lab",
    endpoint: "beta/identityGovernance/entitlementManagement/accessPackageCatalogs",
    status: 403,
    body: graph("UnAuthorized", "User is not authorized to perform the operation. Reason: Unauthorized"),
    answer: { code: "UnAuthorized", message: "User is not authorized to perform the operation. Reason: Unauthorized" },
    expect: { delegatedHeld: "role", otherwise: "permission" },
  },
  {
    name: "a refusal that points to the permissions page (lifecycle workflows)",
    source: "lab",
    endpoint: "v1.0/identityGovernance/lifecycleWorkflows/workflows",
    status: 403,
    body: graph("Access denied", "Insufficient privileges to complete the operation. For a full list of supported delegated and application permissions required to use Lifecycle Workflows, see: https://learn.microsoft.com/en-us/graph/permissions-reference#lifecycle-workflows-permissions"),
    answer: { code: "Access denied", message: "Insufficient privileges to complete the operation. For a full list of supported delegated and application permissions required to use Lifecycle Workflows, see: https://learn.microsoft.com/en-us/graph/permissions-reference#lifecycle-workflows-permissions" },
    expect: { delegatedHeld: "role", otherwise: "permission" },
  },
  {
    name: "a short refusal (content repositories)",
    source: "inventory",
    endpoint: "beta/security/contentManagement/repositories",
    status: 403,
    body: graph("Forbidden", "Access denied."),
    answer: { code: "Forbidden", message: "Access denied." },
    expect: { delegatedHeld: "role", otherwise: "permission" },
  },
  {
    name: "a list that needs a filter it did not get (PIM role policies)",
    source: "lab",
    endpoint: "v1.0/policies/roleManagementPolicies",
    status: 400,
    body: JSON.stringify({ errorCode: "MissingProvider", message: "The provider is missing.", instanceAnnotations: [] }),
    answer: { code: "MissingProvider", message: "The provider is missing." },
    expect: { delegatedHeld: "failed", otherwise: "failed" },
  },
  {
    name: "a path that does not exist in this Graph version (training campaigns in v1.0)",
    source: "inventory",
    endpoint: "v1.0/security/attackSimulation/trainingCampaigns",
    status: 400,
    body: graph("BadRequest", "Resource not found for the segment 'trainingCampaigns'."),
    answer: { code: "BadRequest", message: "Resource not found for the segment 'trainingCampaigns'." },
    expect: { delegatedHeld: "failed", otherwise: "failed" },
  },
  {
    name: "a tenant-wide policy that was never set, for a type that does not declare the answer",
    source: "lab",
    endpoint: "v1.0/policies/federatedTokenValidationPolicy",
    status: 404,
    body: graph("Request_ResourceNotFound", "Resource '' does not exist or one of its queried reference-property objects are not present."),
    answer: { code: "Request_ResourceNotFound", message: "Resource '' does not exist or one of its queried reference-property objects are not present." },
    expect: { delegatedHeld: "failed", otherwise: "failed" },
  },
]

/** Answers that mean "never set up" for the type that declares them. */
export const NOT_CONFIGURED_ANSWERS = [
  {
    name: "a tenant-wide policy that was never set (federated token validation policy)",
    source: "lab" as const,
    status: 404,
    body: graph("Request_ResourceNotFound", "Resource '' does not exist or one of its queried reference-property objects are not present."),
    declared: [{ status: 404, code: "Request_ResourceNotFound" }],
  },
  {
    name: "a legacy setting that was never made (continuous access evaluation policy)",
    source: "inventory" as const,
    status: 404,
    body: graph("NotFound", "CAE settings not found"),
    declared: [{ status: 404, message: "CAE settings not found" }],
  },
]
