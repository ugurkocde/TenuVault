# Defender verification fixtures

Layer base: 2ef7526de3686e4011c36542f22ad31c8ebb9300. Read on 2026-11-16 through GraphSession, readEntries, readObject and listSnapshot. The lab app holds 58 application permissions, including all the Defender read permissions except Zone.Read.All. The token is broad and does not prove least privilege. No delegated read is claimed. GET only is enforced before sending Graph requests; the guard rejects POST, PATCH, PUT, DELETE, HEAD and OPTIONS. Tokens, credentials and headers are never recorded. IDs, names, domains and email addresses are replaced before fixtures are written.

| Folder | Path | API | Shape | Sign-in | Live outcome |
|---|---|---|---|---|---|
| DefenderAttackSimulationAutomations | `/security/attackSimulation/simulationAutomations` | v1.0 | list | both | saved (0) |
| DefenderAttackSimulationLandingPages | `/security/attackSimulation/landingPages` | v1.0 | list | both | saved (0) |
| DefenderAttackSimulationLoginPages | `/security/attackSimulation/loginPages` | v1.0 | list | both | saved (0) |
| DefenderAttackSimulationNotifications | `/security/attackSimulation/endUserNotifications` | v1.0 | list | both | saved (0) |
| DefenderAttackSimulationPayloads | `/security/attackSimulation/payloads` | v1.0 | list | both | saved (0) |
| DefenderAttackSimulationTrainingCampaigns | `/security/attackSimulation/trainingCampaigns` | beta | list | both | saved (0) |
| DefenderAttackSimulations | `/security/attackSimulation/simulations` | v1.0 | list | both | saved (0) |
| DefenderCaseTypeConfigurations | `/security/caseManagement/caseTypeConfigurations` | beta | list | both | skipped: license |
| DefenderCustomDetectionRules | `/security/rules/detectionRules` | v1.0 | list | both | saved (0) |
| DefenderEmailSubmissionPolicies | `/security/threatSubmission/emailThreatSubmissionPolicies` | beta | list | both | saved (1) |
| DefenderIdentityAutoAuditing | `/security/identities/settings/autoAuditingConfiguration` | v1.0 | singleton | both | skipped: license |
| DefenderIdentitySensorActivation | `/security/identities/sensorCandidateActivationConfiguration` | v1.0 | singleton | both | skipped: license |
| DefenderIdentitySensors | `/security/identities/sensors` | v1.0 | list | both | skipped: license |
| DefenderRoleAssignments | `/roleManagement/defender/roleAssignments` | beta | list | both | saved (0) |
| DefenderRoleDefinitions | `/roleManagement/defender/roleDefinitions` | beta | list | both | saved (0) |
| DefenderSecureScoreControlStates | `/security/secureScoreControlProfiles` | v1.0 | list | both | failed: HTTP 504 |
| DefenderWorkbooks | `/security/workbooks` | beta | list | both | saved (0) |

## Evidence and differences

Detection rules, workbooks, submission policy and unified RBAC now answer with their granted permissions, unlike the earlier inventory refusals. Only the submission policy has nonempty configuration. Identity returns the exact Forbidden onboarding message; case management returns badRequest with Tenant's account is not active. These are declared per type for the list or singleton request only. A detail or relationship answer cannot convert a failed read into a covered or unavailable list.

Secure Score repeatedly returned HTTP 504 UnknownError, including isolated reruns and v1.0 $top=100 and beta $top=10 probes. Its fixture records a failed live read, not a successful empty tenant or a licensing refusal. Rerun it after Microsoft's endpoint recovers. The suite intentionally fails on this external error. Documented nonempty control states prove filtering and storage offline; this does not replace a successful current live read. The earlier inventory's 200 result is historical evidence only.

Every .documented.json file is synthetic and labelled. Nonempty campaigns, content details, sensor settings, detection actions, roles, case schemas and workbook content were not available live. Simulation single links and target navigation, payload detail, landing-page details, notification details, and case customFields/statuses/slaPolicies follow their documented contracts. Missing sub-reads fail the object, not count as an empty collection. No secret action is requested. Campaign addressBook target emails are deliberately omitted; object ID selectors are kept. Reporting mailbox addresses configured in the user reported settings policy are configuration and are kept.

Control state snapshots contain only the control ID and non-default updates, without timestamps or personal profiles. Campaign definitions keep authored launch/completion dates and training enum selectors, excluding reports, runs and next/last run state. Detection rules exclude status, detector ID and next run time. Sensors exclude live health and deployment state. Unordered collections are sorted; workbook section order stays authored. Each type shares 120 seconds and 500 actual GETs across all its reads and retries.

Workbooks are the only addition to the manifest. Microsoft Learn publishes Workbooks.Read.All for both modes and a GET with the granted app permission returned 200. Its public delegated ID e37141d2-4e2c-459d-8e5b-5214ae4af482 and application ID d6559210-2a3e-46f8-90b3-e69ef5507772 were read from the Graph service principal. The local index has no workbook/case-management/Defender-RBAC entry; Microsoft Learn supplements it. Cloud scopes still lack Zone.Read.All and return empty-message 403. Repositories are delegated-only and return access denied with the app token. Their .probe.json files are diagnostics, not coverage.

No supported type needs another app permission grant. Rerun the three Identity types after onboarding, case management after activation, and all empty collections with nonempty lab data. Cloud scopes need a grant and successful read before adding a type. Repositories need a signed-in admin verification.

## Contracts checked

- https://learn.microsoft.com/en-us/graph/api/security-workbook-get?view=graph-rest-beta
- https://learn.microsoft.com/en-us/graph/api/resources/security-workbook?view=graph-rest-beta
- https://learn.microsoft.com/en-us/graph/api/security-casemanagementroot-list-casetypeconfigurations?view=graph-rest-beta
- https://learn.microsoft.com/en-us/graph/api/resources/security-casemanagement-casetypeconfiguration?view=graph-rest-beta
- https://learn.microsoft.com/en-us/graph/api/security-casemanagement-casetypeconfiguration-list-statuses?view=graph-rest-beta
- https://learn.microsoft.com/en-us/graph/api/rbacapplicationmultiple-list-roleassignments?view=graph-rest-beta
- https://learn.microsoft.com/en-us/graph/api/unifiedroledefinition-get?view=graph-rest-beta
- Local Graph index primary endpoints and resource schemas, including trainingAssignedTo enum collections, simulation targets and payload detail.

The unit replay maps historical stable routes to beta for the launch paths. This does not add live beta evidence for any nonempty detail or child response.
