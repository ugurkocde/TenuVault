---
title: "App registration and delegated permissions"
description: The app registration TenuVault signs in with, every delegated permission it requests, and why.
---

TenuVault signs in through an app registration that you create in your own tenant. This page describes exactly what that app registration contains, which permissions it requests, and how you can restrict or revoke it.

For the step-by-step setup, see [Create the app registration](/getting-started/app-registration/).

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

Both sign in through **Microsoft Graph Command Line Tools**, Microsoft's own sign-in app, with the delegated scopes `Application.ReadWrite.All` and `DelegatedPermissionGrant.ReadWrite.All`. They need them only to create the app registration and grant consent. With `-AllowedGroupId` the script also requests `AppRoleAssignment.ReadWrite.All`, to assign the group. TenuVault itself never uses these scopes: they are not permissions of the TenuVault app registration.

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

| Permission | Why TenuVault needs it |
| --- | --- |
| `User.Read` | Signs you in and reads your own basic profile. |
| `Organization.Read.All` | Reads your organization's name and verified domains for the tenant overview. |
| `Policy.Read.All` | Backs up Entra Conditional Access policies, named locations and authentication strengths, when the Conditional Access service is turned on for the tenant. Read only. See [Conditional Access backups](/backups/conditional-access/). |
| `DeviceManagementConfiguration.ReadWrite.All` | Backs up and restores device configuration profiles, Settings Catalog and endpoint security policies, administrative templates, compliance policies, security baselines, Windows update profiles, assignment filters, policy sets, compliance notification templates and related configuration. Also used by the OpenIntuneBaseline section to read, create and update the OIB policies you choose, and by Framework coverage to read and create Settings Catalog policies. |
| `DeviceManagementApps.ReadWrite.All` | Backs up and restores apps, app categories, app configuration policies and app protection policies. |
| `DeviceManagementServiceConfig.ReadWrite.All` | Backs up and restores enrollment configurations, Windows Autopilot deployment profiles and devices, Apple enrollment profiles, terms and conditions and Company Portal branding. For Autopilot devices, restore only sets the group tag, the assigned user and its friendly name, and the device name of registered devices. Your Intune role also needs to allow reading Autopilot devices for backups and updating them for restores; Intune Administrator does both. |
| `DeviceManagementScripts.ReadWrite.All` | Backs up and restores Windows PowerShell scripts, macOS shell scripts, macOS custom attributes, remediations and compliance scripts. |
| `DeviceManagementRBAC.ReadWrite.All` | Backs up and restores Intune roles, role assignments, scope tags and multi admin approval policies. |
| `DeviceManagementManagedDevices.Read.All` | Reads device categories and device clean-up rules for backups, and the managed device count and compliance rate shown in the tenant overview. Read only: TenuVault cannot change or wipe devices. |
| `Group.Read.All` (optional, with `-IncludeGroupRead` or added manually) | Reads whether a group referenced by a policy assignment exists for the hygiene check. Also allows App Backup to read names and visibility of groups referenced by app assignments. Not requested by default; unreadable group information remains unknown. |
| `Device.Read.All` (optional, added manually) | Lets App Backup read the capture PC's transitive Entra group memberships before backup. Not requested by default. Missing permission leaves device-group targeting unknown; it does not prevent offline export or an explicit capture attempt. |
| `Policy.ReadWrite.ConditionalAccess` (optional, only with `-IncludeConditionalAccessRestore`) | Restores Conditional Access policies, named locations and authentication strengths. Not requested by default, so the default permission set cannot change Conditional Access. A restore also needs the Conditional Access Administrator or Security Administrator role, and restored policies start in report-only mode. |
| `Mail.Send` (optional, only with `-IncludeNotifications`) | Sends notification email and [change reports](/reports/) as the signed-in admin (`POST /me/sendMail`). Not requested by default. Only notification channels of kind email and reports sent by email use it. |
| `GroupMember.Read.All` (optional, with `-IncludeNotifications` or added manually) | Resolves Entra group recipients of notification email, guests excluded. Also permits App Backup to read names and visibility of groups referenced by app assignments. Not requested by default. Sending to a list address needs no group permission. |
| `User.Read.All` (optional, only with `-IncludeNotifications`) | Reads mail address and user type of those group members so they can be addressed and guests excluded. Without it, Graph returns member objects with those fields empty and group recipients resolve to nobody. |
| `AuditLog.Read.All` (optional, only with `-IncludeAuditLog`) | Reads Conditional Access, named location and authentication strength changes from the Entra audit log (`GET /auditLogs/directoryAudits`) for notification change watching, and to name who changed them in [change reports](/reports/). Not requested by default. Only ids, times, activity names, target names and the actor are used. For updates, the policy versions Graph includes in each event are compared in memory to name the settings that changed; the policy content and its values are never kept or sent. |

:::note
**About `Policy.Read.All`:** only the opt-in Conditional Access service uses it, to read Conditional Access policies, named locations and authentication strengths. If you do not turn that service on and your security review requires it, you can remove this permission from the app registration.
:::

### Entra ID and Defender

The setup requests the permissions above unless you choose other services. When you choose **Entra ID** or **Defender**, with `-Services` on the [setup script](/getting-started/app-registration/#parameters), the app registration gets the read permissions of that service, and its write permissions only for a service you also name in `-RestoreAccess`. A service you leave out brings no permission. Every permission below is a delegated Microsoft Graph permission.

**Entra ID**

<!-- permissions:entra:begin -->
| Area | Backup | Restore adds |
| --- | --- | --- |
| Tenant settings | `Policy.Read.All`, `Policy.Read.PermissionGrant`, `GroupSettings.Read.All`, `Organization.Read.All`, `Domain.Read.All`, `OnPremDirectorySynchronization.Read.All` | `Policy.ReadWrite.Authorization`, `Policy.ReadWrite.SecurityDefaults`, `Policy.ReadWrite.ConsentRequest`, `Policy.ReadWrite.PermissionGrant`, `Policy.ReadWrite.ApplicationConfiguration`, `Policy.ReadWrite.DeviceConfiguration`, `Policy.ReadWrite.MobilityManagement`, `GroupSettings.ReadWrite.All`, `Organization.ReadWrite.All`, `Domain-InternalFederation.ReadWrite.All` |
| Authentication | `Policy.Read.All`, `AuthenticationContext.Read.All`, `Organization.Read.All`, `PublicKeyInfrastructure.Read.All` | `Policy.ReadWrite.AuthenticationMethod`, `Policy.ReadWrite.AuthenticationFlows`, `AuthenticationContext.ReadWrite.All`, `Organization.ReadWrite.All`, `PublicKeyInfrastructure.ReadWrite.All`, `Policy.ReadWrite.FedTokenValidation` |
| External identities | `Policy.Read.All`, `Policy.Read.B2BManagementPolicy`, `IdentityProvider.Read.All`, `IdentityUserFlow.Read.All`, `EventListener.Read.All`, `CustomAuthenticationExtension.Read.All`, `APIConnectors.Read.All`, `MultiTenantOrganization.Read.All` | `Policy.ReadWrite.CrossTenantAccess`, `Policy.ReadWrite.ExternalIdentities`, `Policy.ReadWrite.B2BManagementPolicy`, `IdentityProvider.ReadWrite.All`, `IdentityUserFlow.ReadWrite.All`, `EventListener.ReadWrite.All`, `CustomAuthenticationExtension.ReadWrite.All`, `APIConnectors.ReadWrite.All` |
| Roles and PIM | `RoleManagement.Read.Directory`, `PrivilegedEligibilitySchedule.Read.AzureADGroup`, `GroupMember.Read.All`, `PrivilegedAssignmentSchedule.Read.AzureADGroup`, `RoleManagementAlert.Read.Directory`, `AdministrativeUnit.Read.All`, `CustomSecAttributeDefinition.Read.All` | `RoleManagement.ReadWrite.Directory`, `PrivilegedEligibilitySchedule.ReadWrite.AzureADGroup`, `PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup`, `RoleManagementAlert.ReadWrite.Directory`, `AdministrativeUnit.ReadWrite.All`, `CustomSecAttributeDefinition.ReadWrite.All` |
| Governance | `EntitlementManagement.Read.All`, `AccessReview.Read.All`, `Policy.Read.All`, `LifecycleWorkflows.Read.All`, `Agreement.Read.All` | `EntitlementManagement.ReadWrite.All`, `AccessReview.ReadWrite.All`, `Policy.ReadWrite.AccessReview`, `LifecycleWorkflows.ReadWrite.All`, `Agreement.ReadWrite.All` |
| Groups (only when you turn the area on) | `Group.Read.All`, `Directory.Read.All` | `Group.ReadWrite.All` |
| Users and devices (only when you turn the area on) | `User.Read.All`, `Device.Read.All`, `OrgContact.Read.All` | `User.ReadWrite.All` |
| Applications (only when you turn the area on) | `Application.Read.All`, `Synchronization.Read.All`, `Directory.Read.All` | `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`, `DelegatedPermissionGrant.ReadWrite.All` |
<!-- permissions:entra:end -->

**Defender**

<!-- permissions:defender:begin -->
| Area | Backup | Restore adds |
| --- | --- | --- |
| Detection and response | `CustomDetection.Read.All`, `Workbooks.Read.All`, `CaseManagement.Read.All` | `CustomDetection.ReadWrite.All` |
| Email and collaboration | `AttackSimulation.Read.All`, `ThreatSubmission.Read.All` | `ThreatSubmissionPolicy.ReadWrite.All` |
| Identity | `SecurityIdentitiesSensors.Read.All`, `SecurityIdentitiesAutoConfig.Read.All` | `SecurityIdentitiesSensors.ReadWrite.All`, `SecurityIdentitiesAutoConfig.ReadWrite.All` |
| Posture and access | `SecurityEvents.Read.All`, `RoleManagement.Read.Defender` | `SecurityEvents.ReadWrite.All`, `RoleManagement.ReadWrite.Defender` |
<!-- permissions:defender:end -->

How to read the tables:

* **Backup** is what reading the area needs. No write permission is ever requested to back up.
* **Restore adds** is what restore access adds to it. A write permission also covers reading, so with restore access the read permission of the same name is not requested as well.
* Groups, users and devices, and applications are backed up only when you turn the area on, with `-Areas`. Groups and users and devices hold personal data.
* `Directory.Read.All` is part of the Groups and Applications areas because Microsoft offers no narrower permission for group expiration policies and for delegated permission grants. It also reads users, groups and applications.
* Two write permissions are never requested, because they reach far beyond the settings they would restore: `Directory.ReadWrite.All`, which restoring group expiration policies needs, and `Policy.ReadWrite.ConditionalAccess` for the legacy continuous access evaluation policy. For Intune, `DeviceManagementManagedDevices.ReadWrite.All` stays out in the same way. Add one by hand if you want to restore those settings.
* What a signed-in admin can do also depends on their Entra role: Global Reader reads these settings, and a restore needs the administrator role of the setting, such as Security Administrator or Privileged Role Administrator.

Some settings stay out because no requestable read permission was verified for them: service principal creation policies, the setting that restricts access to the Entra admin center, the directory role access review policy, feature rollout policies, on-premises authentication policies, application proxy connector groups, and in Defender cloud scopes and content repositories. Workbooks now have a published read contract and a successful application read and are included. Cloud scopes lack a lab grant; repositories require a delegated verification.

### Check what the app registration allows

**Settings > Services and permissions** shows Intune, Entra ID and Defender, with Conditional Access as a separately controlled area inside Entra ID. A tenant selector opens that tenant's report. Entra ID has [67 configuration types](/backups/entra/). Each area states when this build has no types for it yet. Defender has [17 configuration backup types](/backups/defender/), with no restore yet.

The connection check requests a fresh token without opening a sign-in window. **Permissions present** describes the token, not the admin's role, license or whether the service is onboarded. **Verified by the last backup** names the date and sign-in that read the selected types. After granting permissions, select **Check again**, then run a backup to verify access.

For missing permissions, expand **Add the missing permissions**. The four routes name exactly the missing manifest permissions for the selected access level:

* **Add in the app** opens a Microsoft sign-in and an exact preview before you approve additions. It requires the same tenant and account you are connected with. See [adding access to an existing registration](/getting-started/app-registration/#add-a-service-an-area-or-restore-access).
* **Azure CLI commands**, for Bash or zsh, resolve delegated permission IDs from Microsoft's Graph service principal, read the connected registration's declared Graph scopes and add only missing scope declarations. They stop after a failed or cancelled login, a tenant mismatch, or any failed lookup or add. They never create another registration.
* **Registration in Entra** opens API permissions for that client ID and lists the exact names to add.
* **Text for your administrator** includes the tenant ID, client ID, permission names and next steps.

Run the CLI route as an **Application Administrator**. Azure CLI needs delegated **DelegatedPermissionGrant.ReadWrite.All** access or a documented higher permission such as **Directory.ReadWrite.All**. The commands add only missing `(id, type: Scope)` declarations for Microsoft Graph, so rerunning them does not append duplicates. They then merge only the missing scopes with the existing tenant-wide Microsoft Graph scopes. They update an existing grant in place with `PATCH /oauth2PermissionGrants/{id}`. Only when no tenant-wide grant exists do they use `POST /oauth2PermissionGrants`, with the registration's service principal object ID as `clientId` and the Graph service principal object ID as `resourceId`. They never delete grants or consent other pending permissions.

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

## Let the hygiene unresolved groups check run (optional)

By default the app registration does not request `Group.Read.All`, so the hygiene unresolved groups check cannot tell whether a referenced group exists. It reports those references as unknown, never as missing and never as fine. No other hygiene rule uses this permission, and no other rule changes when you add it.

To opt in, run the setup script with `-IncludeGroupRead` on a fresh registration and sign in with the new client ID, or add the delegated `Group.Read.All` permission to an existing registration in the Microsoft Entra admin center and grant admin consent:

```powershell
./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com -IncludeGroupRead
```

The hygiene scan shows the same remediation next to the unresolved groups unknown until group reads succeed. After consent, sign in again and run a new hygiene scan.

## See which optional permissions are granted

**Settings > Services and permissions** lists the optional permissions below under **Optional permissions**, read from the sign-in TenuVault already holds: granted, not granted (with the permission that is missing, the setup switch for a new app registration and a link to the app registration in Entra), or not checkable. The Notifications section shows the same status where each is used, before a test mail or a Conditional Access poll fails.

## Notification email and group recipients (optional)

Email notification channels send as the signed-in admin and can resolve Entra group recipients. Both are off unless you opt in with `-IncludeNotifications` on a fresh registration, or by adding the delegated `Mail.Send`, `GroupMember.Read.All` and `User.Read.All` permissions to an existing registration and granting admin consent:

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

MDM and MAM enrollment policies, ownerless group policy and on-premises synchronization require a signed-in admin. The optional Groups area uses Directory.Read.All for group lifecycle policies and delegated Group.Read.All for ownerless group policy. The Groups switch now also enables group object and membership backups. Domain federation settings may need access beyond the readable domain list; refusal preserves domain properties and reports incomplete coverage. All new types have no restore capability, regardless of permissions held by the sign-in.

Directory settings include custom banned password words. Organization properties can include contact details and notification addresses. Public certificates are stored for certificate-based authentication; private keys, credential values and token seeds are excluded recursively. Branding stores at most 1 MiB of JSON and omits image and CSS streams.

External identities and Roles and PIM now contribute 26 additional backup types. PIM group discovery requires the additional read permission `GroupMember.Read.All`; the narrowly scoped schedule permissions alone cannot discover which groups to read. Group-ID enumeration was verified live app-only and is documented for both modes. API connectors remain app-only until a delegated read is verified. The setup manifest still records the unconfirmed delegated permission; its presence never enables that backup type for an admin sign-in. Credential fields are removed recursively, including the entire API connector authentication configuration. See [Entra ID backups](/backups/entra/) for feature availability and omissions.

Defender adds `Workbooks.Read.All` for both delegated and application backup in Detection and response. No workbook write permission is requested. The new [Defender coverage page](/backups/defender/) distinguishes policy mailbox configuration, which is kept, from personal profiles, which are excluded.

## Opt-in directory reads

Directory areas remain off until requested. Users use `User.Read.All`, devices use `Device.Read.All`, contacts use `OrgContact.Read.All`, groups use `Group.Read.All`, applications use `Application.Read.All`, and consent grants use `Directory.Read.All`. Enterprise apps retain the manifest's existing `Application.Read.All` and `Synchronization.Read.All` requirement. This release does not expand the permission manifest or grant additional permissions. The Backup Reader setup already marks all three directory areas opt-in; rerunning it without those area arguments does not add their application roles. Enabling Entra ID alone never enables these inventories.

Some assigned enterprise app policy references can require access beyond the base application read permission. TenuVault records those refusals as incomplete relationships and never asks for an application write permission to improve backup coverage. Hidden membership can require manually granted `Member.Read.Hidden`; its absence never turns a partial group into complete coverage. See [directory coverage and limitations](/backups/entra/#opt-in-directory-inventories).
