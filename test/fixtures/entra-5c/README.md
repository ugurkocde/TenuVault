# Entra 5c verification fixtures

Layer base: c4bfee3eca8ae617c27dfae2ffbcf2c22a02d91d. Read 2026-11-16 with the lab app's 58 application permissions. The token is broad; no least-privilege or delegated verification is claimed. All 11 types use GraphSession, readEntries and readObject through the application's read path. The GET-only guard rejects Graph POST, PATCH, PUT, DELETE, HEAD and OPTIONS before sending. Credentials, tokens and request headers are never recorded. Identifiers and names are replaced in committed fixtures.

| Folder | Path | API | Shape | Sign-in | Live outcome | Verification |
|---|---|---|---|---|---|---|
| AccessPackageAssignmentPolicies | `/identityGovernance/entitlementManagement/assignmentPolicies` | v1.0 | list | both | saved (0) | Live through app read path |
| AccessPackageCatalogs | `/identityGovernance/entitlementManagement/catalogs` | v1.0 | list | both | saved (1) | Live through app read path |
| AccessPackages | `/identityGovernance/entitlementManagement/accessPackages` | v1.0 | list | both | saved (0) | Live through app read path |
| AccessReviewDefinitions | `/identityGovernance/accessReviews/definitions` | v1.0 | list | both | saved (0) | Live through app read path |
| AccessReviewPolicy | `/policies/accessReviewPolicy` | beta | singleton | both | saved (1) | Live through app read path |
| ConnectedOrganizations | `/identityGovernance/entitlementManagement/connectedOrganizations` | v1.0 | list | both | saved (0) | Live through app read path |
| EntitlementManagementSettings | `/identityGovernance/entitlementManagement/settings` | v1.0 | singleton | both | saved (1) | Live through app read path |
| LifecycleWorkflowCustomTaskExtensions | `/identityGovernance/lifecycleWorkflows/customTaskExtensions` | v1.0 | list | both | skipped: license | Live through app read path |
| LifecycleWorkflowSettings | `/identityGovernance/lifecycleWorkflows/settings` | v1.0 | singleton | both | skipped: license | Live through app read path |
| LifecycleWorkflows | `/identityGovernance/lifecycleWorkflows/workflows` | v1.0 | list | both | skipped: license | Live through app read path |
| TermsOfUseAgreements | `/identityGovernance/termsOfUse/agreements` | v1.0 | list | both | saved (0) | Live through app read path |

## Differences from the inventory

All Governance read permissions are now granted. Entitlement management, access review definitions and terms listing are readable. The built-in catalog has no resources; package, assignment policy, connected organization, review and agreement collections are empty. Lifecycle workflows, custom task extensions and settings return an explicit HTTP 403 Access denied license refusal requiring ID Governance. Each declares the recorded status, code and license-message prefix for its own list or singleton read. This is incomplete coverage, not an empty covered list or a missing permission. Detail/sub-read license errors and unknown license responses fail visibly.

Catalogs use the stable v1.0 catalogs path; assignment policies use assignmentPolicies. Resource roles and scopes are expanded under catalog resources, not read from invented catalog-level resourceRoles/resourceScopes collections. Package resourceRoleScopes expand role and scope. Assignment policy questions and custom extension stages are expanded, and missing required expansions fail visibly. The local beta index was checked for every primary resource, legacy catalog/assignment paths, relationships, task and file schemas, and carried-over endpoints. Stable sub-read contracts were also checked against Microsoft Learn. The catalog resource expansion was read live successfully, but returned no resources.

## Limits and reruns

- Each type has a shared 120-second and 500 actual GET budget across list, detail, sub-read, expanded page and retry requests. It ends only that type. Tests exercise request exhaustion and throttled object reads while Intune is saved.
- Every .documented.json file is synthetic, based on documented configuration schemas. These cover nonempty shapes and do not claim a successful nonempty lab read. Tasks, sponsors, resource role scopes, assignment policy approvers, review definitions and localized file metadata need future nonempty live verification.
- Workflow versions and execution history are excluded; current tasks are included. Review instances and decisions, agreement acceptances and terms PDFs are excluded. fileData is removed recursively, including inline base64 PDFs. Terms metadata JSON is limited to 1 MiB.
- Both carried-over .probe.json files are diagnostics only. DirectoryRoleAccessReviewPolicy and application proxy connector groups return 200 with the broad app token, but no requestable read permission was confirmed. The former has no permission in the index; the latter publishes delegated Directory.ReadWrite.All only. Both remain outside the manifest and registry and are listed as exclusions in the docs.
- No Governance type awaits an application permission grant. Rerun all three lifecycle types in a licensed tenant. No delegated read was possible. Empty relationships still need nonempty lab data.
- Existing tenant scope and disabled-service behavior are covered by the unchanged 5a compatibility tests and the golden backup tests. All five configuration manifest areas now have a registry completeness test. No folder name, permission or LEGACY_FOLDERS entry changed. Restore remains none.

## References

- https://learn.microsoft.com/en-us/graph/api/accesspackagecatalog-list-resources?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/accesspackage-list-resourcerolescopes?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/agreement-list-files?view=graph-rest-1.0
