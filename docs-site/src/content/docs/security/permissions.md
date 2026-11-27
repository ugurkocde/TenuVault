---
title: "App registration and delegated permissions"
description: The app registration TenuVault signs in with, every delegated permission it requests, and why.
---

This page covers the TenuVault app and the app registration that you create in your own tenant.

For the step-by-step setup, see [Create the app registration](/getting-started/app-registration/).

## TenuVault app permission packs

The TenuVault app's sign-in basics are `openid`, `profile`, `offline_access`, `User.Read` and `Organization.Read.All`. The desktop client defines the following permission packs for separate administrator approval, with read-only backup access and optional restore access per service.

Service restore packs include the read access needed for backup. A read/write scope stands in for its read alternative where the manifest permits it.

Installer restores with the TenuVault app require the verified Intune restore pack throughout the upload. If you change Intune to backup-only during a restore, TenuVault stops the upload at the next block or when it tries to finalize the block list.

Conditional Access writes have a separate selection. The Entra audit log pack appears when desktop Conditional Access change watching is enabled. Azure storage uses separate Azure Service Management and Azure Storage requests because their tokens have different audiences. Local storage uses neither.

| Pack | Resource | Delegated scopes and IDs |
| --- | --- | --- |
| Basics | Microsoft Graph | `openid` (`37f7f235-527c-4136-accd-4a02d197296e`)<br />`profile` (`14dad69e-099b-42c9-810b-d002981feec1`)<br />`offline_access` (`7427e0e9-2fba-42fe-b0c0-848c9e6a8182`)<br />`User.Read` (`e1fe6dd8-ba31-4d61-89e7-88639da4683d`)<br />`Organization.Read.All` (`4908d5b9-3fb2-4b1e-9336-1888b7937185`) |
| Entra ID backup | Microsoft Graph | `Agreement.Read.All` (`af2819c9-df71-4dd3-ade7-4d7c9dc653b7`)<br />`AuthenticationContext.Read.All` (`57b030f1-8c35-469c-b0d9-e4a077debe70`)<br />`Policy.Read.All` (`572fea84-0151-49b2-9301-11cb16974376`) |
| Intune backup | Microsoft Graph | `DeviceManagementApps.Read.All` (`4edf5f54-4666-44af-9de9-0144fb4b6e8c`)<br />`DeviceManagementConfiguration.Read.All` (`f1493658-876a-4c87-8fa7-edb559b3476a`)<br />`DeviceManagementManagedDevices.Read.All` (`314874da-47d6-4978-88dc-cf0d37f0bb82`)<br />`DeviceManagementRBAC.Read.All` (`49f0cc30-024c-4dfd-ab3e-82e137ee5431`)<br />`DeviceManagementScripts.Read.All` (`d32381d8-ee89-4220-9c83-b672aa68d404`)<br />`DeviceManagementServiceConfig.Read.All` (`8696daa5-bce5-4b2e-83f9-51b6defc4e1e`)<br />`GroupMember.Read.All` (`bc024368-1153-4739-b217-4326f2e966d0`) |
| Entra Conditional Access backup | Microsoft Graph | `Policy.Read.All` (`572fea84-0151-49b2-9301-11cb16974376`) |
| Azure Service Management | Azure Service Management | `user_impersonation` (`41094075-9dad-400e-a0bd-54e686782033`) |
| Azure Storage | Azure Storage | `user_impersonation` (`03e0da56-190b-40ad-a80c-ea378c433f7f`) |
| Audit log | Microsoft Graph | `AuditLog.Read.All` (`e4c9e354-4dc5-45b8-9e7c-e1393b0b1a20`) |
| Entra ID restore | Microsoft Graph | `Agreement.Read.All` (`af2819c9-df71-4dd3-ade7-4d7c9dc653b7`)<br />`AuthenticationContext.Read.All` (`57b030f1-8c35-469c-b0d9-e4a077debe70`)<br />`Policy.Read.All` (`572fea84-0151-49b2-9301-11cb16974376`) |
| Intune restore | Microsoft Graph | `DeviceManagementApps.ReadWrite.All` (`7b3f05d5-f68c-4b8d-8c59-a2ecd12f24af`)<br />`DeviceManagementConfiguration.ReadWrite.All` (`0883f392-0a7a-443d-8c76-16a6d39c7b63`)<br />`DeviceManagementManagedDevices.Read.All` (`314874da-47d6-4978-88dc-cf0d37f0bb82`)<br />`DeviceManagementRBAC.ReadWrite.All` (`0c5e8a55-87a6-4556-93ab-adc52c4d862d`)<br />`DeviceManagementScripts.ReadWrite.All` (`8b9d79d0-ad75-4566-8619-f7500ecfcebe`)<br />`DeviceManagementServiceConfig.ReadWrite.All` (`662ed50a-ac44-4eef-ad86-62eed9be2a29`)<br />`GroupMember.Read.All` (`bc024368-1153-4739-b217-4326f2e966d0`) |
| Entra Conditional Access restore | Microsoft Graph | `Policy.Read.All` (`572fea84-0151-49b2-9301-11cb16974376`)<br />`Policy.ReadWrite.ConditionalAccess` (`ad902697-1014-4ef5-81ef-2b4301988e8c`) |
| Entra ID backup with groups enabled (additional) | Microsoft Graph | `Directory.Read.All` (`06da0dbc-49e2-44d2-8312-53f166ab848a`)<br />`Group.Read.All` (`5f8c59db-677d-491f-a6b8-5f174b11ec1d`) |
| Entra ID restore with groups enabled (additional) | Microsoft Graph | `Application.Read.All` (`c79f8feb-a9db-4090-85f9-90d820caa0eb`)<br />`Directory.Read.All` (`06da0dbc-49e2-44d2-8312-53f166ab848a`)<br />`Group.ReadWrite.All` (`4e46008b-f24c-477d-8fff-7bb4ec7aafe0`)<br />`GroupMember.ReadWrite.All` (`f81125ac-d3b7-4573-a3b2-7099cc39df9e`)<br />`RoleManagement.Read.Directory` (`741c54c3-0c1e-44a1-818b-3f97ab4e8c83`)<br />`User.Read.All` (`a154be20-db9c-4678-8ab7-66f6cc099a59`) |
| Entra ID backup with devices enabled (additional) | Microsoft Graph | `Device.Read.All` (`951183d1-1a61-466f-a6d1-1fde911bfd95`) |
| Entra ID restore with devices enabled (additional) | Microsoft Graph | `Device.Read.All` (`951183d1-1a61-466f-a6d1-1fde911bfd95`) |

The Entra area rows list scopes added when an individual area is enabled. When several areas are selected together, TenuVault resolves their overlapping requirements as one pack.

Stable restore access covers supported Intune and Conditional Access policies and individually reviewed group operations. The base Entra restore pack has the same read permissions as Entra backup.

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

### Entra ID permission packs

Choose services during setup or use `-Services` with the [setup script](/getting-started/app-registration/#parameters). The app requests the read permissions for the selected areas and the write permissions for eligible areas selected for restore.

#### Entra ID

<!-- permissions:entra:begin -->
| Area | Backup | Restore adds |
| --- | --- | --- |
| Device settings | `Policy.Read.All` | None |
| Authentication | `Policy.Read.All`, `AuthenticationContext.Read.All` | None |
| Terms of use | `Agreement.Read.All` | None |
| Groups (only when you turn the area on) | `Group.Read.All`, `Directory.Read.All` | `Group.ReadWrite.All`, `GroupMember.ReadWrite.All`, `User.Read.All`, `Application.Read.All`, `Policy.Read.All`, `RoleManagement.Read.Directory` |
| Devices (only when you turn the area on) | `Device.Read.All` | None |
<!-- permissions:entra:end -->

Conditional Access has an independent switch under Entra ID. See its [backup and restore permissions](/backups/conditional-access/#permissions).

The **Groups** and **Devices** areas are off by default. Group lifecycle policy backup adds `Directory.Read.All`. Group restore adds delegated write access for group properties and membership, and read access for identity and administrator safety checks. No group restore rights are requested when the Groups area is off.

## Check what the app registration allows

**Settings > Services and permissions** shows Entra ID and Intune, with Conditional Access as a separately controlled area inside Entra ID. A tenant selector opens that tenant's report. The cards show requested access, current permissions and verification from prior runs. Expand **Areas and access** for the details of each area.

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

The app registration above never changes. If Conditional Access session controls stop scheduled backups at night, you can add a second, separate app registration, the **TenuVault Backup Reader**, with `New-TenuVaultBackupReader.ps1`. It has read-only Microsoft Graph application permissions (`DeviceManagementConfiguration.Read.All`, `DeviceManagementApps.Read.All`, `DeviceManagementServiceConfig.Read.All`, `DeviceManagementScripts.Read.All`, `DeviceManagementRBAC.Read.All`, and optionally `DeviceManagementManagedDevices.Read.All` and `Policy.Read.All`) and a certificate credential, never a secret. For a tenant that backs up Entra ID, it gets the read permissions of those services instead or as well; the [Backup Reader page](/backups/backup-reader/#permissions) lists them. Only scheduled backups use it, and TenuVault refuses it when its Microsoft Graph token carries any other Graph permission. TenuVault cannot see application permissions for other APIs or Azure role assignments, so review those in Entra ID and on the storage account; `New-TenuVaultStorage.ps1` warns about broader roles on the storage account but does not remove them. See [Backup Reader for scheduled backups](/backups/backup-reader/) for what it can and cannot do, and [Conditional Access and TenuVault](/security/conditional-access/) for options that need no application permissions.

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

The device registration policy, authentication methods, authentication contexts and terms of use can be read by the Backup Reader with their application roles. MDM and MAM enrollment policies and the ownerless group policy require a signed-in admin. See [Entra ID coverage](/backups/entra/) and [Backup Reader permissions](/backups/backup-reader/).
