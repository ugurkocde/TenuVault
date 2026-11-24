---
title: "App registration and delegated permissions"
description: The app registration TenuVault signs in with, every delegated permission it requests, and why.
---

This page covers the app registration that you create in your own tenant and the delegated permission packs for the gated TenuVault app method.

For the step-by-step setup, see [Create the app registration](/getting-started/app-registration/).

## TenuVault app permission packs

This catalog describes the requests configured in the desktop client. Availability of the shared app depends on tenant validation and the license service. Service restore packs include the read access needed for backup. A read/write scope stands in for its read alternative where the manifest permits it.

Conditional Access writes have a separate selection. The Entra audit log pack appears when desktop Conditional Access change watching is enabled. Azure storage uses separate Azure Service Management and Azure Storage requests because their tokens have different audiences. Local storage uses neither. Defender has no admitted Graph restore operation in this version, so its restore selection adds no write scopes.

| Pack | Resource | Delegated scopes and IDs |
| --- | --- | --- |
| Basics | Microsoft Graph | `openid` (`37f7f235-527c-4136-accd-4a02d197296e`)<br />`profile` (`14dad69e-099b-42c9-810b-d002981feec1`)<br />`offline_access` (`7427e0e9-2fba-42fe-b0c0-848c9e6a8182`)<br />`User.Read` (`e1fe6dd8-ba31-4d61-89e7-88639da4683d`)<br />`Organization.Read.All` (`4908d5b9-3fb2-4b1e-9336-1888b7937185`) |
| Defender backup | Microsoft Graph | `AttackSimulation.Read.All` (`104a7a4b-ca76-4677-b7e7-2f4bc482f381`)<br />`CaseManagement.Read.All` (`7bdc421c-99cd-4b67-a749-aa8e92775f7e`)<br />`CustomDetection.Read.All` (`b13ff42e-f321-4d7d-a462-141c46a1b832`)<br />`RoleManagement.Read.Defender` (`dd689728-6eb8-4deb-bd38-2924a935f3de`)<br />`SecurityEvents.Read.All` (`64733abd-851e-478a-bffb-e47a14b18235`)<br />`SecurityIdentitiesAutoConfig.Read.All` (`8ff90903-1ecb-4f3a-b8b2-42120374ecd6`)<br />`SecurityIdentitiesSensors.Read.All` (`2c221239-7c5c-4b30-9355-d84663bfcd96`)<br />`ThreatSubmission.Read.All` (`7083913a-4966-44b6-9886-c5822a5fd910`)<br />`Workbooks.Read.All` (`e37141d2-4e2c-459d-8e5b-5214ae4af482`) |
| Entra ID backup | Microsoft Graph | `APIConnectors.Read.All` (`1b6ff35f-31df-4332-8571-d31ea5a4893f`)<br />`AccessReview.Read.All` (`ebfcd32b-babb-40f4-a14b-42706e83bd28`)<br />`Agreement.Read.All` (`af2819c9-df71-4dd3-ade7-4d7c9dc653b7`)<br />`AuthenticationContext.Read.All` (`57b030f1-8c35-469c-b0d9-e4a077debe70`)<br />`CustomAuthenticationExtension.Read.All` (`b2052569-c98c-4f36-a5fb-43e5c111e6d0`)<br />`CustomSecAttributeDefinition.Read.All` (`ce026878-a0ff-4745-a728-d4fedd086c07`)<br />`Directory.Read.All` (`06da0dbc-49e2-44d2-8312-53f166ab848a`)<br />`Domain.Read.All` (`2f9ee017-59c1-4f1d-9472-bd5529a7b311`)<br />`EntitlementManagement.Read.All` (`5449aa12-1393-4ea2-a7c7-d0e06c1a56b2`)<br />`EventListener.Read.All` (`f7dd3bed-5eec-48da-bc73-1c0ef50bc9a1`)<br />`IdentityProvider.Read.All` (`43781733-b5a7-4d1b-98f4-e8edff23e1a9`)<br />`IdentityUserFlow.Read.All` (`2903d63d-4611-4d43-99ce-a33f3f52e343`)<br />`LifecycleWorkflows.Read.All` (`9bcb9916-765a-42af-bf77-02282e26b01a`)<br />`MultiTenantOrganization.Read.All` (`526aa72a-5878-49fe-bf4e-357973af9b06`)<br />`OnPremDirectorySynchronization.Read.All` (`f6609722-4100-44eb-b747-e6ca0536989d`)<br />`Policy.Read.All` (`572fea84-0151-49b2-9301-11cb16974376`)<br />`Policy.Read.B2BManagementPolicy` (`4b293250-121d-4cb4-acc7-5280438c18a6`)<br />`Policy.Read.PermissionGrant` (`414de6ea-2d92-462f-b120-6e2a809a6d01`)<br />`PrivilegedAssignmentSchedule.Read.AzureADGroup` (`02a32cc4-7ab5-4b58-879a-0586e0f7c495`)<br />`PrivilegedEligibilitySchedule.Read.AzureADGroup` (`8f44f93d-ecef-46ae-a9bf-338508d44d6b`)<br />`PublicKeyInfrastructure.Read.All` (`04a4b2a2-3f26-4fc8-87ee-9c46e68db175`)<br />`RoleManagement.Read.Directory` (`741c54c3-0c1e-44a1-818b-3f97ab4e8c83`)<br />`RoleManagementAlert.Read.Directory` (`cce71173-f76d-446e-97ff-efb2d82e11b1`) |
| Intune backup | Microsoft Graph | `DeviceManagementApps.Read.All` (`4edf5f54-4666-44af-9de9-0144fb4b6e8c`)<br />`DeviceManagementConfiguration.Read.All` (`f1493658-876a-4c87-8fa7-edb559b3476a`)<br />`DeviceManagementManagedDevices.Read.All` (`314874da-47d6-4978-88dc-cf0d37f0bb82`)<br />`DeviceManagementRBAC.Read.All` (`49f0cc30-024c-4dfd-ab3e-82e137ee5431`)<br />`DeviceManagementScripts.Read.All` (`d32381d8-ee89-4220-9c83-b672aa68d404`)<br />`DeviceManagementServiceConfig.Read.All` (`8696daa5-bce5-4b2e-83f9-51b6defc4e1e`)<br />`GroupMember.Read.All` (`bc024368-1153-4739-b217-4326f2e966d0`) |
| Entra Conditional Access backup | Microsoft Graph | `Policy.Read.All` (`572fea84-0151-49b2-9301-11cb16974376`) |
| Azure Service Management | Azure Service Management | `user_impersonation` (`41094075-9dad-400e-a0bd-54e686782033`) |
| Azure Storage | Azure Storage | `user_impersonation` (`03e0da56-190b-40ad-a80c-ea378c433f7f`) |
| Audit log | Microsoft Graph | `AuditLog.Read.All` (`e4c9e354-4dc5-45b8-9e7c-e1393b0b1a20`) |
| Defender restore | Microsoft Graph | `AttackSimulation.Read.All` (`104a7a4b-ca76-4677-b7e7-2f4bc482f381`)<br />`CaseManagement.Read.All` (`7bdc421c-99cd-4b67-a749-aa8e92775f7e`)<br />`CustomDetection.Read.All` (`b13ff42e-f321-4d7d-a462-141c46a1b832`)<br />`RoleManagement.Read.Defender` (`dd689728-6eb8-4deb-bd38-2924a935f3de`)<br />`SecurityEvents.Read.All` (`64733abd-851e-478a-bffb-e47a14b18235`)<br />`SecurityIdentitiesAutoConfig.Read.All` (`8ff90903-1ecb-4f3a-b8b2-42120374ecd6`)<br />`SecurityIdentitiesSensors.Read.All` (`2c221239-7c5c-4b30-9355-d84663bfcd96`)<br />`ThreatSubmission.Read.All` (`7083913a-4966-44b6-9886-c5822a5fd910`)<br />`Workbooks.Read.All` (`e37141d2-4e2c-459d-8e5b-5214ae4af482`) |
| Entra ID restore | Microsoft Graph | `APIConnectors.Read.All` (`1b6ff35f-31df-4332-8571-d31ea5a4893f`)<br />`AccessReview.Read.All` (`ebfcd32b-babb-40f4-a14b-42706e83bd28`)<br />`Agreement.Read.All` (`af2819c9-df71-4dd3-ade7-4d7c9dc653b7`)<br />`Application.Read.All` (`c79f8feb-a9db-4090-85f9-90d820caa0eb`)<br />`AuthenticationContext.Read.All` (`57b030f1-8c35-469c-b0d9-e4a077debe70`)<br />`CustomAuthenticationExtension.Read.All` (`b2052569-c98c-4f36-a5fb-43e5c111e6d0`)<br />`CustomSecAttributeDefinition.Read.All` (`ce026878-a0ff-4745-a728-d4fedd086c07`)<br />`Directory.Read.All` (`06da0dbc-49e2-44d2-8312-53f166ab848a`)<br />`Domain.Read.All` (`2f9ee017-59c1-4f1d-9472-bd5529a7b311`)<br />`EntitlementManagement.ReadWrite.All` (`ae7a573d-81d7-432b-ad44-4ed5c9d89038`)<br />`EventListener.Read.All` (`f7dd3bed-5eec-48da-bc73-1c0ef50bc9a1`)<br />`IdentityProvider.Read.All` (`43781733-b5a7-4d1b-98f4-e8edff23e1a9`)<br />`IdentityUserFlow.Read.All` (`2903d63d-4611-4d43-99ce-a33f3f52e343`)<br />`LifecycleWorkflows.Read.All` (`9bcb9916-765a-42af-bf77-02282e26b01a`)<br />`MultiTenantOrganization.Read.All` (`526aa72a-5878-49fe-bf4e-357973af9b06`)<br />`OnPremDirectorySynchronization.Read.All` (`f6609722-4100-44eb-b747-e6ca0536989d`)<br />`OrganizationalBranding.ReadWrite.All` (`15ce63de-b141-4c9a-a9a5-241bf27c6aaf`)<br />`Policy.Read.All` (`572fea84-0151-49b2-9301-11cb16974376`)<br />`Policy.Read.B2BManagementPolicy` (`4b293250-121d-4cb4-acc7-5280438c18a6`)<br />`Policy.Read.PermissionGrant` (`414de6ea-2d92-462f-b120-6e2a809a6d01`)<br />`Policy.ReadWrite.AccessReview` (`4f5bc9c8-ea54-4772-973a-9ca119cb0409`)<br />`Policy.ReadWrite.ApplicationConfiguration` (`b27add92-efb2-4f16-84f5-8108ba77985c`)<br />`Policy.ReadWrite.AuthenticationFlows` (`edb72de9-4252-4d03-a925-451deef99db7`)<br />`Policy.ReadWrite.CrossTenantAccess` (`014b43d0-6ed4-4fc6-84dc-4b6f7bae7d85`)<br />`PrivilegedAssignmentSchedule.Read.AzureADGroup` (`02a32cc4-7ab5-4b58-879a-0586e0f7c495`)<br />`PrivilegedEligibilitySchedule.Read.AzureADGroup` (`8f44f93d-ecef-46ae-a9bf-338508d44d6b`)<br />`PublicKeyInfrastructure.Read.All` (`04a4b2a2-3f26-4fc8-87ee-9c46e68db175`)<br />`RoleManagement.Read.Directory` (`741c54c3-0c1e-44a1-818b-3f97ab4e8c83`)<br />`RoleManagementAlert.Read.Directory` (`cce71173-f76d-446e-97ff-efb2d82e11b1`) |
| Intune restore | Microsoft Graph | `DeviceManagementApps.ReadWrite.All` (`7b3f05d5-f68c-4b8d-8c59-a2ecd12f24af`)<br />`DeviceManagementConfiguration.ReadWrite.All` (`0883f392-0a7a-443d-8c76-16a6d39c7b63`)<br />`DeviceManagementManagedDevices.Read.All` (`314874da-47d6-4978-88dc-cf0d37f0bb82`)<br />`DeviceManagementRBAC.ReadWrite.All` (`0c5e8a55-87a6-4556-93ab-adc52c4d862d`)<br />`DeviceManagementScripts.ReadWrite.All` (`8b9d79d0-ad75-4566-8619-f7500ecfcebe`)<br />`DeviceManagementServiceConfig.ReadWrite.All` (`662ed50a-ac44-4eef-ad86-62eed9be2a29`)<br />`GroupMember.Read.All` (`bc024368-1153-4739-b217-4326f2e966d0`) |
| Entra Conditional Access restore | Microsoft Graph | `Policy.Read.All` (`572fea84-0151-49b2-9301-11cb16974376`)<br />`Policy.ReadWrite.ConditionalAccess` (`ad902697-1014-4ef5-81ef-2b4301988e8c`) |
| Privileged Entra restore | Microsoft Graph | `Application.ReadWrite.All` (`bdfbf15f-ee85-4955-8675-146e8e5296b5`)<br />`AppRoleAssignment.ReadWrite.All` (`84bccea3-f856-4a8a-967b-dbe0a3d53a64`)<br />`DelegatedPermissionGrant.ReadWrite.All` (`41ce6ca6-6826-4807-84f1-1c82854f7ee5`)<br />`RoleManagement.ReadWrite.Directory` (`d01b97e9-cbc0-49fe-810a-750afd5527a3`)<br />`RoleEligibilitySchedule.ReadWrite.Directory` (`62ade113-f8e0-4bf9-a6ba-5acb31db32fd`)<br />`RoleAssignmentSchedule.ReadWrite.Directory` (`8c026be3-8e26-4774-9372-8d5d6f21daff`)<br />`PrivilegedEligibilitySchedule.ReadWrite.AzureADGroup` (`ba974594-d163-484e-ba39-c330d5897667`)<br />`PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup` (`06dbc45d-6708-4ef0-a797-f797ee68bf4b`)<br />`AdministrativeUnit.ReadWrite.All` (`7b8a2d34-6b3f-4542-a343-54651608ad81`) |
| Entra ID backup with groups enabled (additional) | Microsoft Graph | `Group.Read.All` (`5f8c59db-677d-491f-a6b8-5f174b11ec1d`) |
| Entra ID restore with groups enabled (additional) | Microsoft Graph | `Group.ReadWrite.All` (`4e46008b-f24c-477d-8fff-7bb4ec7aafe0`)<br />`GroupMember.ReadWrite.All` (`f81125ac-d3b7-4573-a3b2-7099cc39df9e`)<br />`User.Read.All` (`a154be20-db9c-4678-8ab7-66f6cc099a59`) |
| Entra ID backup with users and devices enabled (additional) | Microsoft Graph | None |
| Entra ID restore with users and devices enabled (additional) | Microsoft Graph | `User.Create` (`d8ce6a2a-46ff-438e-96bc-020f23870a55`)<br />`User.DeleteRestore.All` (`4bb440cd-2cf2-4f90-8004-aa2acd2537c5`)<br />`User.ReadUpdate.All` (`f8b099f1-a6ce-4e00-8fff-5f783ff4faeb`)<br />`User.ReadWrite.All` (`204e0828-b5ca-4ad8-b9f3-f32a958e7cc4`) |
| Entra ID backup with applications enabled (additional) | Microsoft Graph | `Synchronization.Read.All` (`7aa02aeb-824f-4fbe-a3f7-611f751f5b55`) |
| Entra ID restore with applications enabled (additional) | Microsoft Graph | `Synchronization.Read.All` (`7aa02aeb-824f-4fbe-a3f7-611f751f5b55`) |

The Entra area rows list scopes added when an individual area is enabled. When several areas are selected together, TenuVault resolves their overlapping requirements as one pack. The privileged Entra pack is reserved for future, temporary restore access. Normal backup, restore, setup and permission repair requests exclude it.

## What the setup creates

In TenuVault, **Set up with Microsoft sign-in** on the **Connect** step of **Set up TenuVault** creates the app registration below. The setup script, `New-TenuVaultDesktopApp.ps1`, creates the same one from PowerShell; it is available as a [download from this site](/downloads/New-TenuVaultDesktopApp.ps1), under **Use the setup script instead** on the Connect step (**Save setup script** or **Copy script**) and in the public repository. The Connect step lists these permissions under **Permissions the app registration gets** before anyone consents.

| Setting | Value |
| --- | --- |
| Name | `TenuVault Desktop` by default. Change it with `-DisplayName`. |
| Supported account types | Single tenant (accounts in your organization only). |
| Client type | Public client. |
| Credentials | None. No client secret and no certificate. |
| Redirect URIs | `http://localhost` (sign-in through your system browser). |
| Permissions | Delegated permissions only, listed below. No application permissions. |
| Consent | Tenant-wide admin consent for the delegated permissions. |
| Enterprise app | Hidden from the My Apps portal. |
| Notes field | "Used by the TenuVault desktop app. Delegated permissions only, no credentials." |

While it grants admin consent, the script lists the delegated permissions per API. At the end, it prints your tenant ID and the application (client) ID. You paste these two lines into the **Sign in** step of **Set up TenuVault**.

### Who can run the setup

Both the setup in TenuVault and the script need one of these roles, because they create the app registration and grant tenant-wide admin consent:

* Global Administrator
* Cloud Application Administrator
* Application Administrator

A Privileged Role Administrator can grant the consent, but can create the app registration only when users in the tenant may register applications, so the setup does not count on that role.

Both sign in through **Microsoft Graph Command Line Tools**, Microsoft's own sign-in app, with the delegated scopes `Application.ReadWrite.All` and `DelegatedPermissionGrant.ReadWrite.All`. They need them only to create the app registration and grant consent. With `-AllowedGroupId` the script also requests `AppRoleAssignment.ReadWrite.All`, to assign the group. These two permissions are outside the normal packs for the shared TenuVault app and the permissions of the desktop registration this setup creates.

TenuVault keeps the setup sign-in in memory only and drops it when the setup ends. The script needs no PowerShell modules and installs nothing. The approval of Microsoft Graph Command Line Tools stays in your tenant, for the account that gave it, as long as **Consent on behalf of your organization** was left unticked; to remove it, open **Entra admin center** > **Enterprise applications** > **Microsoft Graph Command Line Tools** > **Permissions**.

To remove TenuVault's access to the tenant, delete **TenuVault Desktop** under **Entra admin center** > **App registrations**. Backups you already saved stay where they are.

## Why delegated permissions matter

Delegated permissions let an app act on behalf of a signed-in user. They never grant access on their own:

* **TenuVault can never do more than you can.** The effective access is the overlap between the delegated permissions and the roles of the admin who signs in. An admin with a read-only Intune role cannot restore or change anything through TenuVault, even though the app registration requests write permissions.
* **There is no background identity.** Without application permissions and without a secret, the app registration cannot get a token by itself. Every token belongs to a person who signed in. The only exception is the optional [Backup Reader](#optional-the-backup-reader), a separate app registration you add yourself.
* **Your sign-in controls apply.** MFA, Conditional Access and sign-in frequency apply to every TenuVault session.
* **Changes are traceable.** Writes appear under the signed-in admin's name in the Intune and Entra audit logs.

## Delegated permissions

### Microsoft Graph

The default setup includes the Intune permission pack, shared profile reads and Conditional Access read access.

| Permission | Why TenuVault needs it |
| --- | --- |
| `User.Read` | Signs you in and reads your own basic profile. |
| `Organization.Read.All` | Reads your organization's name and verified domains for the tenant overview. |
| `GroupMember.Read.All` | Searches groups by name, reads group properties and membership counts, and checks whether referenced or selected groups exist. Used by OpenIntuneBaseline, promotion group mappings, Conflicts and hygiene, App Backup and notification group recipients. Included in new app registrations. |
| `Policy.Read.All` | Backs up Entra Conditional Access policies, named locations and authentication strengths, when the Conditional Access area is turned on under Entra ID for the tenant. Read only. See [Conditional Access backups](/backups/conditional-access/). |
| `DeviceManagementConfiguration.ReadWrite.All` | Backs up and restores device configuration profiles, Settings Catalog and endpoint security policies, administrative templates, compliance policies, security baselines, Windows update profiles, assignment filters, policy sets, compliance notification templates and related configuration. Also used by the OpenIntuneBaseline section to read, create and update the OIB policies you choose, and by Framework coverage to read and create Settings Catalog policies. |
| `DeviceManagementApps.ReadWrite.All` | Backs up and restores apps, app categories, app configuration policies and app protection policies. |
| `DeviceManagementServiceConfig.ReadWrite.All` | Backs up and restores enrollment configurations, Windows Autopilot deployment profiles and devices, Apple enrollment profiles, terms and conditions and Company Portal branding. For Autopilot devices, restore only sets the group tag, the assigned user and its friendly name, and the device name of registered devices. Your Intune role also needs to allow reading Autopilot devices for backups and updating them for restores; Intune Administrator does both. |
| `DeviceManagementScripts.ReadWrite.All` | Backs up and restores Windows PowerShell scripts, macOS shell scripts, macOS custom attributes, remediations and compliance scripts. |
| `DeviceManagementRBAC.ReadWrite.All` | Backs up and restores Intune roles, role assignments, scope tags and multi admin approval policies. |
| `DeviceManagementManagedDevices.Read.All` | Reads device categories and device clean-up rules for backups, and the managed device count and compliance rate shown in the tenant overview. Read only: TenuVault cannot change or wipe devices. |
| `Device.Read.All` (optional, added manually) | Lets App Backup read the capture PC's transitive Entra group memberships before backup. Not requested by default. Missing permission leaves device-group targeting unknown; it does not prevent offline export or an explicit capture attempt. |
| `Policy.ReadWrite.ConditionalAccess` (optional, only with `-IncludeConditionalAccessRestore`) | Restores Conditional Access policies, named locations and authentication strengths. Not requested by default, so the default permission set cannot change Conditional Access. A restore also needs the Conditional Access Administrator or Security Administrator role, and restored policies start in report-only mode. |
| `Mail.Send` (optional, only with `-IncludeNotifications`) | Sends notification email and [change reports](/reports/) as the signed-in admin (`POST /me/sendMail`). Not requested by default. Only notification channels of kind email and reports sent by email use it. |
| `User.Read.All` (optional, only with `-IncludeNotifications`) | Reads mail address and user type of those group members so they can be addressed and guests excluded. Without it, Graph returns member objects with those fields empty and group recipients resolve to nobody. |
| `AuditLog.Read.All` (optional, only with `-IncludeAuditLog`) | Reads Conditional Access, named location and authentication strength changes from the Entra audit log (`GET /auditLogs/directoryAudits`) for notification change watching, and to name who changed them in [change reports](/reports/). Not requested by default. Only ids, times, activity names, target names and the actor are used. For updates, the policy versions Graph includes in each event are compared in memory to name the settings that changed; the policy content and its values are never kept or sent. |

:::note
**About `Policy.Read.All`:** Conditional Access uses it to read policies, named locations and authentication strengths. Entra ID configuration backups also use it. Remove it only if neither selected service needs those reads.
:::

### Defender and Entra ID permission packs

Choose services during setup or use `-Services` with the [setup script](/getting-started/app-registration/#parameters). The app requests the read permissions for the selected areas and the write permissions for eligible areas selected for restore.

#### Defender

<!-- permissions:defender:begin -->
| Area | Backup | Restore adds |
| --- | --- | --- |
| Detection and response | `CustomDetection.Read.All`, `Workbooks.Read.All`, `CaseManagement.Read.All` | None |
| Email and collaboration | `AttackSimulation.Read.All`, `ThreatSubmission.Read.All` | None |
| Identity | `SecurityIdentitiesSensors.Read.All`, `SecurityIdentitiesAutoConfig.Read.All` | None |
| Posture and access | `SecurityEvents.Read.All`, `RoleManagement.Read.Defender` | None |
<!-- permissions:defender:end -->

#### Entra ID

<!-- permissions:entra:begin -->
| Area | Backup | Restore adds |
| --- | --- | --- |
| Tenant settings | `Policy.Read.All`, `Policy.Read.PermissionGrant`, `GroupSettings.Read.All`, `Organization.Read.All`, `Domain.Read.All`, `OnPremDirectorySynchronization.Read.All` | `Policy.ReadWrite.ApplicationConfiguration`, `Application.Read.All`, `OrganizationalBranding.ReadWrite.All` |
| Authentication | `Policy.Read.All`, `AuthenticationContext.Read.All`, `Organization.Read.All`, `PublicKeyInfrastructure.Read.All` | `Policy.ReadWrite.AuthenticationFlows` |
| External identities | `Policy.Read.All`, `Policy.Read.B2BManagementPolicy`, `IdentityProvider.Read.All`, `IdentityUserFlow.Read.All`, `EventListener.Read.All`, `CustomAuthenticationExtension.Read.All`, `APIConnectors.Read.All`, `MultiTenantOrganization.Read.All` | `Policy.ReadWrite.CrossTenantAccess` |
| Roles and PIM | `RoleManagement.Read.Directory`, `PrivilegedEligibilitySchedule.Read.AzureADGroup`, `GroupMember.Read.All`, `PrivilegedAssignmentSchedule.Read.AzureADGroup`, `RoleManagementAlert.Read.Directory`, `AdministrativeUnit.Read.All`, `CustomSecAttributeDefinition.Read.All` | `Application.Read.All`, `User.Read.All` |
| Governance | `EntitlementManagement.Read.All`, `AccessReview.Read.All`, `Policy.Read.All`, `LifecycleWorkflows.Read.All`, `Agreement.Read.All` | `EntitlementManagement.ReadWrite.All`, `Policy.ReadWrite.AccessReview` |
| Groups (only when you turn the area on) | `Group.Read.All`, `Directory.Read.All` | `Group.ReadWrite.All`, `GroupMember.ReadWrite.All`, `User.Read.All`, `Application.Read.All`, `Policy.Read.All`, `RoleManagement.Read.Directory` |
| Users and devices (only when you turn the area on) | `User.Read.All`, `Device.Read.All`, `OrgContact.Read.All` | `User.Create`, `User.ReadUpdate.All`, `User.ReadWrite.All`, `User.DeleteRestore.All`, `Application.Read.All` |
| Applications (only when you turn the area on) | `Application.Read.All`, `Synchronization.Read.All`, `Directory.Read.All` | `Application.ReadWrite.All` |
<!-- permissions:entra:end -->

Conditional Access has an independent switch under Entra ID. See its [backup and restore permissions](/backups/conditional-access/#permissions).

How to read the tables:

* **Backup** is what reading the area needs. No write permission is ever requested to back up.
* **Restore adds** is what restore access adds to it. Tenant settings also includes Application.Read.All for the token lifetime policy binding read. The seven enabled subsets cannot change protected identities or the connected registration, so unrelated identity and administrator reads are skipped. A write permission also covers reading, so with restore access the read permission of the same name is not requested as well.
* Groups, users and devices, and applications are backed up only when you turn the area on, with `-Areas`. Groups and users and devices hold personal data.
* `Directory.Read.All` is a backup read permission only in the opt-in Groups and Applications areas because Microsoft offers no narrower read permission for group lifecycle policies and delegated permission grants. It also reads users, groups and applications. It is never a restore permission, even when a setup includes both backup and restore access.
* No Entra ID or Defender write permission is requested for a blocked type. Organization.ReadWrite.All is never requested for backup or restore. Organization notification emails, phones and privacy profile stay backup-only in 0.6 because Microsoft requires that permission to write them. Company branding uses OrganizationalBranding.ReadWrite.All.
* Intune defaults remain unchanged: `DeviceManagementManagedDevices.ReadWrite.All` is not requested for device categories and cleanup rules. Adding a permission manually does not enable a blocked Entra ID or Defender contract.
* What a signed-in admin can do also depends on their Entra role: Global Reader reads these settings, and a restore needs the administrator role of the setting, such as Security Administrator or Privileged Role Administrator.

Some settings stay out because no requestable read permission was verified for them: service principal creation policies, the setting that restricts access to the Entra admin center, the directory role access review policy, feature rollout policies, on-premises authentication policies, application proxy connector groups, and in Defender cloud scopes and content repositories. Workbooks now have a published read contract and a successful application read and are included. Cloud scopes lack a lab grant; repositories require a delegated verification.

#### Restore write permissions in 0.6

These are all write permissions requested for the supported Entra ID configuration restores. Each is the least-privileged delegated permission in Microsoft's per-operation table, checked on 2026-11-18. The linked permission reference explains its full reach. Grants belong to the registration, so a narrow restore payload does not narrow the scope of the grant itself.

| Permission and Microsoft reference | Restore that needs it | Why and least privilege | When requested |
| --- | --- | --- | --- |
| [Policy.ReadWrite.ApplicationConfiguration](https://learn.microsoft.com/en-us/graph/permissions-reference#policyreadwriteapplicationconfiguration) | Token lifetime and activity-based timeout policy create/update | Writes the closed non-default policy definitions. It is the least-privileged permission in the [token create](https://learn.microsoft.com/en-us/graph/api/tokenlifetimepolicy-post-tokenlifetimepolicies?view=graph-rest-1.0), [token update](https://learn.microsoft.com/en-us/graph/api/tokenlifetimepolicy-update?view=graph-rest-1.0), [timeout create](https://learn.microsoft.com/en-us/graph/api/activitybasedtimeoutpolicy-post-activitybasedtimeoutpolicies?view=graph-rest-1.0) and [timeout update](https://learn.microsoft.com/en-us/graph/api/activitybasedtimeoutpolicy-update?view=graph-rest-1.0) tables. Microsoft offers no narrower delegated permission for these writes. | Only after an admin opts into Entra ID restore access, which includes Tenant settings. |
| [OrganizationalBranding.ReadWrite.All](https://learn.microsoft.com/en-us/graph/permissions-reference#organizationalbrandingreadwriteall) | Default company-branding username hint update or clear | [Updates branding](https://learn.microsoft.com/en-us/graph/api/organizationalbranding-update?view=graph-rest-1.0). It is the least-privileged option; the broader Organization.ReadWrite.All alternative is never requested. | Only after an admin opts into Entra ID restore access, which includes Tenant settings. |
| [Policy.ReadWrite.AuthenticationFlows](https://learn.microsoft.com/en-us/graph/permissions-reference#policyreadwriteauthenticationflows) | Self-service sign-up state update | [Updates authentication flows](https://learn.microsoft.com/en-us/graph/api/authenticationflowspolicy-update?view=graph-rest-1.0). It is Microsoft's least-privileged delegated option, with none narrower. | Only after an admin opts into Entra ID restore access, which includes Authentication. |
| [Policy.ReadWrite.CrossTenantAccess](https://learn.microsoft.com/en-us/graph/permissions-reference#policyreadwritecrosstenantaccess) | Parent cross-tenant policy display-name update | [Updates parent metadata](https://learn.microsoft.com/en-us/graph/api/crosstenantaccesspolicy-update?view=graph-rest-1.0). It is Microsoft's least-privileged delegated option. The permission can change relationships, but this restore writes only displayName. | Only after an admin opts into Entra ID restore access, which includes External identities. |
| [EntitlementManagement.ReadWrite.All](https://learn.microsoft.com/en-us/graph/permissions-reference#entitlementmanagementreadwriteall) | Unpublished, externally hidden user-managed catalog create/update | [Creates catalogs](https://learn.microsoft.com/en-us/graph/api/entitlementmanagement-post-catalogs?view=graph-rest-1.0) and [updates catalog metadata](https://learn.microsoft.com/en-us/graph/api/accesspackagecatalog-update?view=graph-rest-1.0). This broad permission is the least-privileged delegated permission Microsoft offers. No narrower delegated permission exists. Resources, packages and assignments are not restored. Entitlement-management roles are separate; Microsoft's application-role alternatives do not enable app-only restore. | Only after an admin opts into Entra ID restore access, which includes Governance. |
| [Policy.ReadWrite.AccessReview](https://learn.microsoft.com/en-us/graph/permissions-reference#policyreadwriteaccessreview) | Access-review ownership flag update | [Updates isGroupOwnerManagementEnabled](https://learn.microsoft.com/en-us/graph/api/accessreviewpolicy-update?view=graph-rest-beta), allowing group owners to manage reviews. It is Microsoft's least-privileged delegated option, with none narrower. This beta write does not create or run a review. | Only after an admin opts into Entra ID restore access, which includes Governance. |

Services and permissions and the setup script request the union of these scopes for the selected service's enabled areas, only after restore opt-in. Entra ID restore access includes the Governance catalog permission, which the permission preview names before the registration is changed. Each policy still requires its own preview and confirmation. Opt-in does not activate workflows or detection rules. Blocked and never-restorable types add no write scope. Defender and Roles and PIM restore access add no write permissions.

Token lifetime restore also requests the read permission [Application.Read.All](https://learn.microsoft.com/en-us/graph/permissions-reference#applicationreadall), solely for the [policy binding read](https://learn.microsoft.com/en-us/graph/api/tokenlifetimepolicy-list-appliesto?view=graph-rest-1.0). The enabled metadata operations need no directory-object lookup. Organization.ReadWrite.All and Directory.ReadWrite.All are never requested. Directory.Read.All is never requested for restore operations; selecting the opt-in Groups or Applications backup area includes that read permission independently of restore access. Existing grants are not revoked.

## Check what the app registration allows

**Settings > Services and permissions** shows Defender, Entra ID and Intune, with Conditional Access as a separately controlled area inside Entra ID. A tenant selector opens that tenant's report. The cards show requested access, current permissions and verification from prior runs. Expand **Areas and access** for the details of each area.

The connection check requests a fresh token without opening a sign-in window. **Permissions present** describes the token, not the admin's role, license or whether the service is onboarded. **Verified by the last backup** names the date and sign-in that read the selected types. After granting permissions, select **Check again**, then run a backup to verify access.

Policy sets in **Apps and app protection** use `DeviceManagementConfiguration.Read.All` for backup and `DeviceManagementConfiguration.ReadWrite.All` for restore. The write permission also covers backup. The standard Intune setup already requests the appropriate Configuration permission for the selected access level. If your signed-in backup lacks the read permission, **Backup Details** marks policy sets **Not read** and names the required permission. If your sign-in lacks the write permission, the restore preview blocks the policy set and shows the missing scope. **Settings > Services and permissions** shows how to add it. [List policy sets](https://learn.microsoft.com/en-us/graph/api/intune-policyset-policyset-list?view=graph-rest-beta), [Update policy set contents and assignments](https://learn.microsoft.com/en-us/graph/api/intune-policyset-policyset-update?view=graph-rest-beta).

When Intune is enabled, the app-only [Backup Reader](/backups/backup-reader/#permissions) requires the `DeviceManagementConfiguration.Read.All` application role. Without it, the scheduled backup fails its credential check before reading policies and reports “The Backup Reader is missing permissions or their admin consent” with the missing role.

For missing permissions, expand **Add the missing permissions**. The four routes name exactly the missing manifest permissions for the selected access level:

* **Add in the app** opens a Microsoft sign-in and an exact preview before you approve additions. It requires the same tenant and account you are connected with. See [adding access to an existing registration](/getting-started/app-registration/#add-a-service-an-area-or-restore-access).
* **Azure CLI commands**, for Bash or zsh, resolve delegated permission IDs from Microsoft's Graph service principal, read the connected registration's declared Graph scopes and add only missing scope declarations. They stop after a failed or cancelled login, a tenant mismatch, or any failed lookup or add. They never create another registration.
* **Registration in Entra** opens API permissions for that client ID and lists the exact names to add.
* **Text for your administrator** includes the tenant ID, client ID, permission names and next steps.

Run the CLI route as an **Application Administrator**. The Azure CLI session needs delegated **DelegatedPermissionGrant.ReadWrite.All** access. The commands add only missing `(id, type: Scope)` declarations for Microsoft Graph, so rerunning them does not append duplicates. They then merge only the missing scopes with the existing tenant-wide Microsoft Graph scopes. They update an existing grant in place with `PATCH /oauth2PermissionGrants/{id}`. Only when no tenant-wide grant exists do they use `POST /oauth2PermissionGrants`, with the registration's service principal object ID as `clientId` and the Graph service principal object ID as `resourceId`. They never delete grants or consent other pending permissions.

These changes are not transactional: an earlier permission declaration can remain saved if a later step fails. If a consent PATCH or POST fails, both the commands and the copied administrator text warn: consent may have changed because the request may have been applied; check consent in Entra before retrying. Avoid concurrent consent changes while running the commands: the merged scopes reflect the grant read before the update. If individual Graph grants exist, the commands stop before changing anything, so your administrator can review those grants separately.

The Entra link includes both the connected tenant and client ID. The portal's **Grant admin consent** action consents the registration's full declared set, including other pending permissions. Review those separately before using that action. See Microsoft's [update grant API](https://learn.microsoft.com/en-us/graph/api/oauth2permissiongrant-update?view=graph-rest-1.0) and [create grant API](https://learn.microsoft.com/en-us/graph/api/oauth2permissiongrant-post?view=graph-rest-1.0) for the request bodies, permissions and supported admin roles.

Backup and restore permission status are shown separately. If backup permissions are present but restore permissions are missing, the card says **Backup permissions are present. Restore needs: ...** and names the **Backup and restore** access level that asks for them. This does not prove a backup can read the selected types; run a backup to verify access. Choose **Backup** under **Areas and access** if you only want backup permissions requested.

![Backup permissions present with a restore-only gap](/images/services/restore-only-gap-light.png)

The **Access to request** choice grants nothing and never blocks a restore the current token permits. Restore permissions are available in the in-app flow only for services with a restore capability. Choosing Backup does not request new write permissions for the tenant registration.

The in-app route signs in through Microsoft Graph Command Line Tools with setup-only `Application.ReadWrite.All` and `DelegatedPermissionGrant.ReadWrite.All` access. This access is held in memory for the flow, expires after ten minutes at the preview, and is separate from the tenant connection. Use an Application Administrator, Cloud Application Administrator, Privileged Role Administrator or Global Administrator; tenant consent policies can require a higher role.

It reads the exact connected client ID and refuses registrations that are not single-tenant public clients with only root-path `http://localhost` or `http://127.0.0.1` redirects (with or without a port), have secrets, certificates or federated credentials, have credentials on their enterprise application, lack tenant-wide consent for the connected Graph scopes, or have individual Graph consent. These cases can be reviewed using the other routes.

The consent check and final token refresh use delegated permissions carried by the connected access token. An unreadable or app-only token requires another delegated sign-in. Scope names and registration GUIDs are compared without regard to letter case, so case-only differences do not stop an approved change. Existing scopes keep their spelling when consent is updated.

Before confirmation it shows the registration name and client ID, the delegated permissions to declare, and the scopes to add to tenant-wide Graph consent. On confirmation it finishes the connection and trust checks, then reads the exact application immediately before the declaration PATCH. Before the consent PATCH it repeats those checks and reads the exact tenant-wide Graph grant by ID last. Each write is built from that last read with no intervening network or connection check. If the state differs from the approved preview, it stops and shows the current declarations and consent. If declarations were already written, the result says so and leaves consent untouched. A fresh preview is required. It keeps unknown declarations and scopes, compares declaration IDs without regard to case, and never consents other pending permissions. The existing grant is patched in place, never deleted or recreated.

Microsoft Graph replaces `requiredResourceAccess` and the grant's `scope` value as a whole. Its [application update documentation](https://learn.microsoft.com/en-us/graph/api/application-update?view=graph-rest-1.0) and [grant update documentation](https://learn.microsoft.com/en-us/graph/api/oauth2permissiongrant-update?view=graph-rest-1.0) offer no documented conditional update using `If-Match` for these resources, so TenuVault does not rely on that header. A change by someone else in the same second can be lost. TenuVault reads again right before writing to make this unlikely. Avoid changing this registration or its consent in Entra or another application while adding permissions. An overwritten change that was never observed cannot be detected afterwards.

After each write, the app compares the read-back with the last pre-write value. Entries outside the approved additions must be unchanged. An observed concurrent addition, revocation or other change produces a partial result that says another change happened at the same time and asks you to check in Entra, even if all requested additions are present. No further write follows that result.

Declaration and consent are read back with at most four attempts per verification step. A failed or unanswered write is not automatically retried; it may have been applied, so the result explains the uncertainty and what the read-back verified. A partial result lists verified additions and permissions still missing or unverified, without promising rollback. Start a new preview to reconcile and retry. Finally the tenant token is refreshed and connection health is checked. If either fails, the result stays partial and offers Check again or another sign-in. The Backup Reader is not changed.

![A missing permission with the commands, registration link and administrator request](/images/services/missing-permission-light.png)

### Azure Service Management

| Permission | Why TenuVault needs it |
| --- | --- |
| `user_impersonation` | Lists the Azure subscriptions and storage accounts you can see, so you can pick a storage account for backups. Used only when you choose **Your Azure storage account** as backup storage. TenuVault only reads these lists; it does not create or change subscriptions or storage accounts. |

### Azure Storage

| Permission | Why TenuVault needs it |
| --- | --- |
| `user_impersonation` | Reads and writes backup files in your storage account. Used only when you store backups in Azure. |

Delegated storage access also requires an Azure role on the storage account itself. The admin who signs in needs **Storage Blob Data Contributor** on the storage account.

## Roles your admins need

The app registration only defines what TenuVault may request. What each admin can actually do depends on their own roles:

| Task | Role |
| --- | --- |
| Back up, compare and restore Intune configuration | An Intune role such as Intune Administrator. A custom Intune role with fewer rights limits TenuVault in the same way. |
| Store backups in Azure | Storage Blob Data Contributor on the storage account. |

## Group read (GroupMember.Read.All)

New TenuVault app registrations include the delegated `GroupMember.Read.All` permission. It reads group names, basic properties and membership counts. The broader `Group.Read.All` also grants access to group content that TenuVault does not need for these checks.

* [OpenIntuneBaseline assignments](/baselines/quick-start/#find-groups) uses it to search for groups, show names and member counts, and check every selected group before writing an assignment.
* [Dev to Prod](/changes/#dev-to-prod) uses it to find and verify destination groups when assignments are included in a promotion.
* [Conflicts and hygiene](/governance/#conflicts-and-hygiene) uses it to check whether groups referenced in assignments still exist.

If group access is missing, OpenIntuneBaseline deploys new policies unassigned. The Assignments workflow and group mappings are unavailable, and hygiene reports unresolved groups as unknown.

To add group read to an existing registration:

1. In TenuVault, select **Open in Entra** on the group access card. You can also find the registration in **Microsoft Entra admin center > App registrations > TenuVault Desktop > API permissions**.
2. Select **Add a permission > Microsoft Graph > Delegated permissions**. Search for `GroupMember.Read.All` and select **Add permissions**.
3. Select **Grant admin consent** for the tenant.
4. In TenuVault, select **Check again** on the group access card or in **Settings > Services and permissions**. TenuVault refreshes the token without a new sign-in. If consent is still pending, wait a few minutes and check again. For hygiene, run a new scan after the check succeeds.

## See which feature permissions are granted

**Settings > Services and permissions** lists the permissions below under **Feature permissions**. TenuVault checks the token for each feature, shows a link to Entra when a permission is missing, and lists setup switches where applicable. Notifications shows the same status where each permission is used.

## Notification email and group recipients (optional)

Email notification channels send as the signed-in admin and can resolve Entra group recipients. For a new registration, `-IncludeNotifications` adds delegated `Mail.Send` and `User.Read.All` alongside the default `GroupMember.Read.All`. For an existing registration, add any missing permissions in Entra and grant admin consent.

In **Services and permissions**, **Entra group recipients of notification email** checks `User.Read.All` or `User.ReadWrite.All`. The **Group read** row checks the group membership access also required for those recipients.

```powershell
./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com -IncludeNotifications
```

See [Notifications](/notifications/) for what is sent. The Azure watcher has its own managed identity and its own application roles (`DeviceManagementApps.Read.All`, `AuditLog.Read.All` only with `-IncludeConditionalAccess`, and only when used, `Mail.Send` restricted to one mailbox in Exchange); the watcher setup script prints exactly what it granted.

## Conditional Access change watching (optional)

Notification change watching can also report changes to Conditional Access policies, named locations and authentication strengths. Those changes are in the Entra audit log, which needs the delegated `AuditLog.Read.All` permission. It is off unless you opt in with `-IncludeAuditLog` on a fresh registration, or by adding the delegated permission to an existing registration and granting admin consent. The signed-in admin also needs a role that can read audit logs, such as Security Reader, Global Reader or Reports Reader:

```powershell
./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com -IncludeAuditLog
```

The Azure watcher uses the application role `AuditLog.Read.All` instead. Its setup script with `-IncludeConditionalAccess` turns the watching on, and grants the role when `-GrantGraphRoles` is also given (Global Administrator); without it, assign `AuditLog.Read.All` to the watcher's managed identity yourself.

## Optional: the Backup Reader

The app registration above never changes. If Conditional Access session controls stop scheduled backups at night, you can add a second, separate app registration, the **TenuVault Backup Reader**, with `New-TenuVaultBackupReader.ps1`. It has read-only Microsoft Graph application permissions (`DeviceManagementConfiguration.Read.All`, `DeviceManagementApps.Read.All`, `DeviceManagementServiceConfig.Read.All`, `DeviceManagementScripts.Read.All`, `DeviceManagementRBAC.Read.All`, and optionally `DeviceManagementManagedDevices.Read.All` and `Policy.Read.All`) and a certificate credential, never a secret. For a tenant that backs up Entra ID or Defender, it gets the read permissions of those services instead or as well; the [Backup Reader page](/backups/backup-reader/#permissions) lists them. Only scheduled backups use it, and TenuVault refuses it when its Microsoft Graph token carries any other Graph permission. TenuVault cannot see application permissions for other APIs or Azure role assignments, so review those in Entra ID and on the storage account; `New-TenuVaultStorage.ps1` warns about broader roles on the storage account but does not remove them. See [Backup Reader for scheduled backups](/backups/backup-reader/) for what it can and cannot do, and [Conditional Access and TenuVault](/security/conditional-access/) for options that need no application permissions.

## Restrict sign-in to a group

By default, tenant-wide admin consent lets any user in the tenant sign in to the app registration. Access is still limited by each user's own Intune role, but you can narrow it further.

Run the setup script with `-AllowedGroupId` and the object ID of a security group:

```powershell
./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com -AllowedGroupId <group object ID>
```

The script sets **Assignment required** on the enterprise app and assigns the group. Only members of that group can then sign in to TenuVault. You can change the assigned users and groups later in the Microsoft Entra admin center, under **Enterprise applications**.

## Revoke access

Because the app registration lives in your tenant, you can revoke TenuVault's access at any time without contacting anyone:

* **Remove consent:** in the Microsoft Entra admin center, open the enterprise app, go to **Permissions** and revoke the granted permissions. TenuVault can no longer obtain tokens with them.
* **Delete the app registration:** TenuVault can no longer sign in to your tenant at all.
* **Disable sign-in:** set **Enabled for users to sign-in?** to **No** on the enterprise app.

:::caution
Revoking access affects every admin who uses TenuVault with this app registration, including scheduled backups on their machines. Backups that already exist are not deleted: backups on a device stay in their folder, and backups in Azure stay in your storage account. To restore access, grant consent again, or run the setup script again to create a new app registration and sign in with its client ID.
:::

## Use your own policies

You can target the app registration with your own controls, for example:

* A Conditional Access policy that requires a compliant device or phishing-resistant MFA for TenuVault sign-ins. TenuVault signs in through your system browser, so device-based conditions are checked there. See [Conditional Access](/getting-started/requirements/#conditional-access) for the supported browsers.
* Sign-in frequency to control how long a TenuVault session lasts before you sign in again. Scheduled backups stop when the session ends; see [Conditional Access and TenuVault](/security/conditional-access/) for ways to keep them running.

## Connection health evidence

Health checks run silently and never open a sign-in window or hold up a backup. Their observations stay in the encrypted app state on this device. Admin evidence belongs to the tenant, signed-in account ID and connected registration. Reader evidence also identifies the active credential by its public certificate thumbprint. Storage evidence belongs to the current storage connection and signed-in account.

Changing an account, registration, storage connection or reader credential clears the affected connection's earlier checks and backup verification. Changing back does not restore that evidence. Registration permission history and unacknowledged registration changes are retained separately. Signing out removes account IDs and account-bound evidence; removing the tenant removes its health history.

A loss needs two distinct refused backups after that connection previously read the policy type. Timeouts, stopped runs, types that are not configured and types left out by scope or by the reader neither establish nor clear a loss. Looking at a report's changes acknowledges only the notices in that report. Newer notices remain, and an acknowledged loss stays in the area's health until a backup reads the type again or its evidence expires. Health retains at most twenty recent report receipts; an older receipt has no effect, so refresh the report before acknowledging it.

## Related pages

* [A client secret or a delegated sign-in for Intune automation](https://www.tenuvault.com/compare/intune-graph-client-secret-vs-delegated-sign-in): what an app-only script with a client secret exposes, on the product site
* [Security and privacy](/security/)
* [Network connections and data flows](/security/data-flows/)
* [Create the app registration](/getting-started/app-registration/)
* [Deploy TenuVault in your organization](/deploy/)


## Entra ID configuration reads

[Entra ID coverage](/backups/entra/) lists the 74 supported types, their sign-in modes and omissions. The manifest's Tenant settings area uses Policy.Read.All, Policy.Read.PermissionGrant, Policy.Read.DeviceConfiguration, GroupSettings.Read.All, Organization.Read.All and Domain.Read.All for application reads. Authentication also uses AuthenticationContext.Read.All and PublicKeyInfrastructure.Read.All. Authentication methods use the existing Policy.Read.All permission. PIM group discovery adds GroupMember.Read.All to the area. Governance uses EntitlementManagement.Read.All, AccessReview.Read.All, Policy.Read.All, LifecycleWorkflows.Read.All and Agreement.Read.All for both modes. Governance or P2 licensing is separate from permissions; an exact recorded lifecycle license refusal is shown as license or not onboarded. Review decisions, workflow history, terms PDF content and credentials are excluded. Directory role review defaults and application proxy connector groups remain outside coverage because no requestable read permission was proven, even though a broad app token reads them.

MDM and MAM enrollment policies, ownerless group policy and on-premises synchronization require a signed-in admin. The optional Groups area uses Directory.Read.All for group lifecycle policies and delegated Group.Read.All for ownerless group policy. The optional Applications area uses Directory.Read.All for delegated permission grants. These are backup reads, never restore permissions. The Groups switch now also enables group object and membership backups. Domain federation settings may need access beyond the readable domain list; refusal preserves domain properties and reports incomplete coverage. Only the individually verified subsets on the [restore safety page](/restore/identity/) support restore.

Directory settings include custom banned password words. Organization properties can include contact details and notification addresses. Public certificates are stored for certificate-based authentication; private keys, credential values and token seeds are excluded recursively. Branding stores at most 1 MiB of JSON and omits image and CSS streams.

External identities and Roles and PIM now contribute 26 additional backup types. PIM group discovery requires the additional read permission `GroupMember.Read.All`; the narrowly scoped schedule permissions alone cannot discover which groups to read. Group-ID enumeration was verified live app-only and is documented for both modes. API connectors remain app-only until a delegated read is verified. The setup manifest still records the unconfirmed delegated permission; its presence never enables that backup type for an admin sign-in. Credential fields are removed recursively, including the entire API connector authentication configuration. See [Entra ID backups](/backups/entra/) for feature availability and omissions.

Defender adds `Workbooks.Read.All` for both delegated and application backup in Detection and response. No workbook write permission is requested. The new [Defender coverage page](/backups/defender/) distinguishes policy mailbox configuration, which is kept, from personal profiles, which are excluded.

## Opt-in directory reads

Directory areas remain off until requested. Users use `User.Read.All`, devices use `Device.Read.All`, contacts use `OrgContact.Read.All`, groups use `Group.Read.All`, applications use `Application.Read.All`, and consent grants use `Directory.Read.All`. Group lifecycle policies also use `Directory.Read.All`. Both are backup reads in the opt-in Groups and Applications areas, never restore permissions. Enterprise apps retain the manifest's existing `Application.Read.All` and `Synchronization.Read.All` requirement. Restore write permissions are added only after opt-in. Directory.ReadWrite.All and Organization.ReadWrite.All are never requested. The Backup Reader setup already marks all three directory areas opt-in; rerunning it without those area arguments does not add their application roles. Enabling Entra ID alone never enables these inventories.

Some assigned enterprise app policy references can require access beyond the base application read permission. TenuVault records those refusals as incomplete relationships and never asks for an application write permission to improve backup coverage. Hidden membership can require `Member.Read.Hidden`. The Backup Reader does not request or accept that extra application role in this release. A refused hidden membership read stays incomplete. See [directory coverage and limitations](/backups/entra/#opt-in-directory-inventories).

Existing Backup Readers holding Directory.Read.All continue to pass the read-only permission allowlist, and certificate renewal preserves that permission. Group lifecycle policy and delegated permission grant coverage remains available when the corresponding backup area is selected.

For every area and sign-in mode, restore access adds none of `Directory.Read.All`, `Directory.ReadWrite.All` or `Organization.ReadWrite.All` beyond backup access for the same selection; Groups and Applications restore retain their existing Directory.Read.All backup reads.

### Directory restore permissions

These permissions are requested only after the admin explicitly selects restore access for Users and devices, Groups, or Roles and PIM. Backup, Backup Reader provisioning and renewal are unchanged. The Users and devices restore pack includes the recycle permission ahead of operation approval. Restore adds no Directory.Read.All above the same backup area selection. TenuVault never requests Directory.ReadWrite.All or Organization.ReadWrite.All.

| Permission | Why it is needed and least privilege |
| --- | --- |
| `User.Create` | [Create a disabled replacement user](https://learn.microsoft.com/en-us/graph/api/user-post-users?view=graph-rest-1.0). This is the current operation table's least-privileged delegated permission. Only after Users and devices restore opt-in. |
| `User.ReadUpdate.All` | [Restore a user's display name](https://learn.microsoft.com/en-us/graph/api/user-update?view=graph-rest-1.0). Least-privileged delegated option for another user's profile. Other profile properties and account state stay unchanged. Only after Users and devices restore opt-in. |
| `User.ReadWrite.All` | [Assign the saved manager](https://learn.microsoft.com/en-us/graph/api/user-post-manager?view=graph-rest-1.0). Microsoft offers no narrower delegated manager permission. This broad permission also satisfies the area's existing user reads. Only after Users and devices restore opt-in. |
| `User.DeleteRestore.All` | [Restore deleted users](https://learn.microsoft.com/en-us/graph/api/directory-deleteditems-restore?view=graph-rest-beta). Microsoft lists this as the least-privileged delegated permission. The Users and devices restore pack includes it. The restore evidence gate still blocks recycle recovery. |
| `Group.ReadWrite.All` | [Create security groups](https://learn.microsoft.com/en-us/graph/api/group-post-groups?view=graph-rest-1.0), [restore nonempty descriptions](https://learn.microsoft.com/en-us/graph/api/group-update?view=graph-rest-1.0) and [add owners](https://learn.microsoft.com/en-us/graph/api/group-post-owners?view=graph-rest-1.0). Least-privileged delegated permission, though it has broader Microsoft 365 content reach than this closed directory subset uses. Microsoft also lists it as the least-privileged delegated permission to restore a deleted group. Only after Groups restore opt-in. |
| `GroupMember.ReadWrite.All` | [Add user members](https://learn.microsoft.com/en-us/graph/api/group-post-members?view=graph-rest-1.0) and [remove user members](https://learn.microsoft.com/en-us/graph/api/group-delete-members?view=graph-rest-1.0). Least-privileged delegated option. Exact member removals require a separate choice and individual approval and apply only to ordinary security groups. Conditional Access targeted-group removals are blocked because membership changes can affect policy enforcement; remove those members in Microsoft Entra. Only after Groups restore opt-in. |
| `User.Read.All` | [Resolve user names and protection details](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0) for group relationships and Roles and PIM review, including on-premises sync status. Added by Groups or Roles and PIM restore opt-in when the selected permissions do not already cover this read. |
| `Application.Read.All` | [Resolve the connected registration](https://learn.microsoft.com/en-us/graph/api/application-list?view=graph-rest-1.0) and [enterprise app](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-list?view=graph-rest-1.0) for protection, and resolve service principal names in Roles and PIM review. Added after either directory area's restore opt-in, Roles and PIM restore opt-in, or the existing token-policy restore opt-in. |
| `Policy.Read.All` | [Read Conditional Access exclusions](https://learn.microsoft.com/en-us/graph/api/conditionalaccessroot-list-policies?view=graph-rest-1.0) before group relationship writes. Least-privileged read option. Excluded groups remain blocked. Only added by Groups restore opt-in when not already present. |
| `RoleManagement.Read.Directory` | [Read current directory role assignments](https://learn.microsoft.com/en-us/graph/api/rbacapplication-list-roleassignments?view=graph-rest-1.0) and their definitions before security-group creation. Least-privileged read option. A fresh Groups Administrator or Global Administrator assignment prevents the [implicit caller ownership of non-admin group creation](https://learn.microsoft.com/en-us/graph/api/group-post-groups?view=graph-rest-1.0). The restore guard uses it only after Groups restore opt-in. Entra backup already requests this read permission; restore adds no directory-role write permission. |

User.Create and User.ReadUpdate.All appear in Microsoft's current operation tables and [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference), but the older local index and permission model do not contain their current least-privilege entries. Setup uses the published delegated identifiers. The app-only lab token held a union of roles, so its accepted writes do not isolate each alternative permission or prove a delegated sign-in.

Account activation, recycle recovery, guest invitations, licenses, dynamic rules, role-assignable groups, nested principals and Microsoft 365 group restore remain blocked. The restore packs do not request `User.EnableDisableAccount.All`, `User.Invite.All`, `LicenseAssignment.ReadWrite.All` or `RoleManagement.ReadWrite.Directory` for those blocked operations. See [directory restore](/restore/identity/#users-and-groups) for the reasons.

The lab soft-deletes every test group. Microsoft's [permanent-delete table](https://learn.microsoft.com/en-us/graph/api/directory-deleteditems-delete?view=graph-rest-1.0) does not support application-mode group deletion. The owner approved leaving these prefixed groups in deleted items, where Entra removes them after 30 days. Test users are permanently removed. Later runs use unique names and never restore earlier runs' groups.

Group link restore also refuses a resource with any current directory membership, including parent groups, directory roles and administrative units. This avoids granting inherited privilege through an unverified ancestor. The lookup uses existing group read access.

User display-name and manager changes are blocked when Conditional Access group targeting or exclusions exist or cannot be completely read. Their dynamic-membership effects need a separate verified review. Every access addition and manager change also has separate privilege and security-response approvals.

### Application restore permissions

Application restore permissions are requested only after opt-in to restore access for the Applications area. Blocked operations add no permission. The Backup Reader continues to use its backup-only permissions.

| Permission | Why it is needed and least privilege |
| --- | --- |
| `Application.ReadWrite.All` | Requested only after opt-in to the Applications area with restore access. It lets the signed-in admin's token manage all app registrations and enterprise apps in the tenant, including credentials, limited by the admin's own Entra role. It also allows managing app role assignments exposed by APIs other than Microsoft Graph. Microsoft lists it as the least-privileged delegated permission for [updating an application](https://learn.microsoft.com/en-us/graph/api/application-update?view=graph-rest-1.0). See the [permission reference](https://learn.microsoft.com/en-us/graph/permissions-reference#applicationreadwriteall). TenuVault only writes nonempty displayName and description changes, enforced in its own writer. No application-mode write role is requested for the desktop or Backup Reader. |

Before preview and again before sending, TenuVault refuses TenuVault Desktop, the Backup Reader registration it knows on this device or recognizes by name, and Microsoft first-party apps. Application identity must resolve to exactly one matching enterprise app with a known owner tenant; missing or ambiguous identity blocks the restore. The owner tenant comes from the documented [servicePrincipal appOwnerOrganizationId property](https://learn.microsoft.com/en-us/graph/api/resources/serviceprincipal?view=graph-rest-1.0).

The [application-owner table](https://learn.microsoft.com/en-us/graph/api/application-post-owners?view=graph-rest-1.0) and [enterprise-app-owner table](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-owners?view=graph-rest-1.0) require delegated Application.ReadWrite.All plus Directory.Read.All. The same Applications backup choice already requests Directory.Read.All for consent inventory. Restore never adds Directory.Read.All beyond that backup choice. This permission is not the owner blocker: fixture service-principal owners were verified, but the production user-owner resolver and typed service-principal owner mappings lack matching live evidence. Owner restore remains blocked and adds no permission.

Delegated consent remains blocked after inconsistent live lifecycle results: one complete cycle matched, but a later deletion returned HTTP 400. No DelegatedPermissionGrant.ReadWrite.All permission is requested. Microsoft lists it as the least-privileged permission for [grant creation](https://learn.microsoft.com/en-us/graph/api/oauth2permissiongrant-post?view=graph-rest-1.0) and [scope updates](https://learn.microsoft.com/en-us/graph/api/oauth2permissiongrant-update?view=graph-rest-1.0), but the live evidence does not meet admission requirements.

Enterprise app metadata and app role assignment restore remain blocked after live HTTP 400 refusals during metadata change and assignment recreation. No AppRoleAssignment.ReadWrite.All permission is requested. The documented [app-role contract](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignments?view=graph-rest-1.0) requires AppRoleAssignment.ReadWrite.All plus Application.Read.All; it remains a candidate only.

Application registration creation remains blocked. The current [create table](https://learn.microsoft.com/en-us/graph/api/application-post-applications?view=graph-rest-1.0) names AppRegistration.Create, but the lab did not isolate that permission. Delegated ownership and unique reconciliation after a lost response are not verified. Non-gallery enterprise app creation lacks verified delegated ownership and inherited-access safety. Gallery creation also lacks saved template provenance. No creation-specific permission is requested.

[Recycle recovery](https://learn.microsoft.com/en-us/graph/api/directory-deleteditems-restore?view=graph-rest-1.0) can recover credentials and previous access. Matching fixture IDs and metadata do not certify that recovered state. Recovery and policy bindings remain blocked. Organization.ReadWrite.All and Directory.ReadWrite.All are never requested.

The isolated lab uses the existing union of application roles, including Application.ReadWrite.OwnedBy, Application.ReadWrite.All, Application.Read.All and Directory.Read.All. This proves accepted fixture calls and read-back, not permission isolation or an interactive delegated sign-in. Each run records its own object IDs outside the repository, permanently deletes only its own prefixed applications and service principals, and audits both active and deleted collections. No credentials are created.

Roles and PIM restore access adds delegated `Application.Read.All` for the connected registration, enterprise app and service principal names, and `User.Read.All` for principal names and on-premises sync status. Group reads use the existing `GroupMember.Read.All`. The review blocks unresolved principals and scopes. These permissions enable review only. They add no role, PIM or administrative unit write access.
