---
title: Defender configuration backups
description: Back up the Microsoft Defender configuration exposed by Microsoft Graph, with explicit coverage limits.
---

TenuVault backs up 17 Defender configuration types when you enable **Defender** in **Settings > Services and permissions**. Defender starts off for existing tenants. Manual backups use the signed-in admin. Scheduled backups use that sign-in or a configured Backup Reader. All supported types accept both modes. Restore, Copy to Tenants and drift revert are not available for these types.

## Enable backups

Select Defender during setup or turn it on in **Settings > Services and permissions**. Review the permissions for the areas you use.

## Coverage

| Type | API | What is stored and excluded |
|---|---|---|
| Custom detection rules (`DefenderCustomDetectionRules`) | v1.0 | Query, schedule period, alert and response action configuration. No detector ID, author profiles, run details, status or next run time. Device group references remain IDs. |
| Case type configurations (`DefenderCaseTypeConfigurations`) | beta | Custom fields, allowed status definitions and SLA policies. No cases, tasks, activities or investigation data. |
| Security workbooks (`DefenderWorkbooks`) | beta | Name and complete JSON document, explicitly selected on the detail read. No creator UPN, updater UPN, timestamps or ETag. Documents over 4 MiB are reported unread. Workbook section order is preserved. These are security workbooks, not Excel files. |
| Attack simulations (`DefenderAttackSimulations`) | v1.0 | Campaign definition, authored launch and completion dates, training settings, target selectors and payload, landing page and login page IDs. No reports, run history or generated status. |
| Simulation automations (`DefenderAttackSimulationAutomations`) | v1.0 | The automation definition Graph exposes. No runs, last run time, next run time or runtime status. |
| Training campaigns (`DefenderAttackSimulationTrainingCampaigns`) | beta | Campaign schedule and training definition, including authored launch and completion dates. No reports or execution state, including `campaignSchedule.status`. |
| Tenant payloads (`DefenderAttackSimulationPayloads`) | v1.0 | Tenant-authored payloads and their detail, including message HTML and coach marks. No Microsoft global catalog content. |
| Tenant landing pages (`DefenderAttackSimulationLandingPages`) | v1.0 | Tenant-authored metadata and localized content details. No Microsoft global pages. |
| Tenant login pages (`DefenderAttackSimulationLoginPages`) | v1.0 | Tenant-authored page configuration and content. No Microsoft global pages. |
| Tenant notifications (`DefenderAttackSimulationNotifications`) | v1.0 | Tenant-authored metadata and localized notification details. No Microsoft global notifications. |
| User reported settings policies (`DefenderEmailSubmissionPolicies`) | beta | Reporting options, configured reporting and notification mailbox addresses, reviewer IDs where returned. These mailbox addresses are policy configuration and are intentionally stored. |
| Identity sensor settings (`DefenderIdentitySensors`) | v1.0 | Sensor identity and settings. No health, deployment or service status, issue counts or software version. No deployment access key is ever requested. |
| Identity automatic auditing (`DefenderIdentityAutoAuditing`) | v1.0 | Tenant-wide automatic auditing configuration. |
| Identity sensor activation (`DefenderIdentitySensorActivation`) | v1.0 | Tenant-wide activation mode. No activation actions are called. |
| Secure Score control states (`DefenderSecureScoreControlStates`) | v1.0 | Only controls with explicit non-default tenant control state updates. No Microsoft catalog fields, daily scores, update timestamps or personal profiles. A tenant with no changed controls has nothing to save and is covered after the full list is read. |
| Defender role definitions (`DefenderRoleDefinitions`) | beta | Unified RBAC role configuration and permissions. |
| Defender role assignments (`DefenderRoleAssignments`) | beta | Unified RBAC assignments, principal IDs, role IDs and scope IDs. No expanded principal profiles. |

Attack content sends `source eq 'tenant'` on every list page and refuses global content in list and detail answers. Campaign references to Microsoft pages or payloads are IDs only; the referenced global content itself is excluded. People are stored only by object ID. Graph's address-book campaign targets expose email addresses instead of IDs, so those addresses are omitted rather than resolved into people. Campaigns with these targets are records of the exposed definition, not complete executable copies. Author names, user principal names and personal email addresses are excluded.

Object collections without an authored order are sorted by stable identity, including role assignment principals and inherited role references. Detection scope names, response action device groups and sensor domain controller references are also treated as unordered sets. Workbook document order is preserved. Advancing run state does not make unchanged configuration appear changed. Each type has a shared 120-second and 500-request read budget across its pages, details, retries and sub-reads. Exhausting it leaves that type incomplete and other types continue.

## Permissions and verification

The [permissions page](/security/permissions/#defender-and-entra-id-permission-packs) lists the read permissions per area. A permission in the token does not establish the admin's role, product license or onboarding. Defender for Identity requires its license and workspace; attack simulations require the corresponding Defender for Office 365 entitlement. Beta APIs may change.

An exact recorded Defender for Identity onboarding refusal or case-management inactive-account refusal is **license or not onboarded**, never missing permission. That result can come only from the type's own list or singleton request. A failed detail or relationship remains incomplete. User reported settings policies are saved from either documented wrapped responses or bare policy responses when the policy ID matches. The recorded threat-submission HTML 401 page is a permission refusal and does not refresh or end your sign-in. Empty RBAC 403 and detection-role 403 answers are permission refusals. Other services continue when a Defender endpoint throttles or refuses a read. No unread list counts as empty coverage.

Compare, drift, dashboard policy counts and change reports include Defender configuration. Intune hygiene and audit change watching have no Defender rules. Change reports do not assign Intune or Conditional Access audit actors to Defender changes, even if the names or IDs match. The Azure Automation runbook does not back up Defender in 0.6; use desktop manual or scheduled backups.

## What Microsoft Graph does not expose

These Defender settings are **not backed up** by this service:

* Anti-phishing, Safe Links, Safe Attachments, anti-spam, anti-malware and quarantine policies.
* The Tenant Allow/Block List.
* Defender for Endpoint settings, device groups and indicators.
* Alert tuning and suppression rules, and automated investigation settings.
* Defender for Cloud Apps policies.

Intune's mobile threat defense connector and endpoint security policies remain Intune types. Including Defender does not add these Intune policies when Intune is off. Operational alerts, incidents, submissions, reports, investigations, daily Secure Score measurements, legacy threat indicators and Purview are excluded.

## Deferred Graph configuration

| Type | Why it is not covered |
|---|---|
| Cloud scopes (`/security/zones`) | The lab app does not hold `Zone.Read.All`; the list returns an empty-message 403. No successful read permission verification is claimed. This beta endpoint is global-cloud only. |
| Content repositories (`/security/contentManagement/repositories`) | Microsoft documents delegated `Repository.Read.All` only. The app-only lab call returns access denied. No signed-in admin read was available to verify the permission. |

Workbooks were previously deferred. They are now included: the lab app holds `Workbooks.Read.All` and the list answers 200. Its delegated and application identifiers were checked against Microsoft's Graph service principal, and Microsoft's [workbook read contract](https://learn.microsoft.com/en-us/graph/api/security-workbook-get?view=graph-rest-beta) lists both modes. The broad lab token is not a least-privilege test.

## Verification limits

The lab read on 2026-11-16 saved the user reported settings policy. Detection rules, workbooks, attack simulation lists and unified RBAC lists were empty. Identity endpoints returned their onboarding refusal; case management returned the inactive-tenant refusal. Secure Score returned HTTP 504 repeatedly, including isolated and smaller-page probes, so a successful current live read could not be verified. That remains a failed read, never a permission or licensing result. Nonempty definitions and sub-resources use labelled documented synthetic fixtures. No delegated live read is claimed.

## Restore

Defender restore remains blocked. A disabled, never-matching custom detection fixture was created in the lab, but its detectionAction read-back contained service-added null fields, empty mappings and empty action collections that the closed candidate could not reconcile. Update and restore were not attempted. Cleanup removed the fixture. No CustomDetection.ReadWrite.All scope is requested. Workflow execution, detection activation and automated response actions are not enabled by these tests. See [restore safety](/restore/identity/) for per-type reasons.
