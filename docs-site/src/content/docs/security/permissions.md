---
title: "App registration and delegated permissions"
description: The app registration TenuVault signs in with, every delegated permission it requests, and why.
---

TenuVault signs in through an app registration that you create in your own tenant. This page describes exactly what that app registration contains, which permissions it requests, and how you can restrict or revoke it.

For the step-by-step setup, see [Create the app registration](/getting-started/app-registration/).

## What the setup creates

Use **Set up with Microsoft sign-in** on **Connect** in **Set up TenuVault**. It creates the registration below or reuses the newest matching TenuVault registration. Matching requires the name `TenuVault Desktop`, notes beginning with `Used by the TenuVault desktop app`, single-tenant audience and the public-client `http://localhost` redirect URI. Existing consent scopes are preserved and missing scopes are added.

The alternative **Use the setup script instead** reveals **Save setup script** and **Copy script**. Both paths list **Permissions the app registration gets** before consent.

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

### Who can run setup

The desktop setup script needs no modules and installs nothing. It signs in through your browser. You need one of these roles:

* Global Administrator
* Privileged Role Administrator
* Cloud Application Administrator

Both paths sign in through **Microsoft Graph Command Line Tools**, Microsoft's own public client. The admin approves delegated `Application.ReadWrite.All` and `DelegatedPermissionGrant.ReadWrite.All` to create the registration and grant consent. Only the script's optional `-AllowedGroupId` adds `AppRoleAssignment.ReadWrite.All` for group assignment.

For in-app setup, the token stays in main-process memory only for the setup, with no cache plugin or persistent token storage. The renderer never receives it. The approval remains for that admin in the tenant. To revoke it, open **Entra admin center > Enterprise applications > Microsoft Graph Command Line Tools > Permissions**. This is separate from the TenuVault registration's default delegated scopes below.

Delete **TenuVault Desktop** in **App registrations**, and its enterprise application if it remains, to remove TenuVault's sign-in registration and consent. Your stored backups remain. Setup removes a newly created application on provisioning failure where possible; it never deletes a reused registration.

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
| `Group.Read.All` (optional, only with `-IncludeGroupRead`) | Reads whether a group referenced by a policy assignment exists, so the hygiene unresolved groups check can report missing groups. Not requested by default. Without it that check stays unknown. TenuVault reads group existence only (`GET groups/{id}?$select=id`); it does not list groups or read membership. |
| `Policy.ReadWrite.ConditionalAccess` (optional, only with `-IncludeConditionalAccessRestore`) | Restores Conditional Access policies, named locations and authentication strengths. Not requested by default, so the default permission set cannot change Conditional Access. A restore also needs the Conditional Access Administrator or Security Administrator role, and restored policies start in report-only mode. |
| `Mail.Send` (optional, only with `-IncludeNotifications`) | Sends notification email and [change reports](/reports/) as the signed-in admin (`POST /me/sendMail`). Not requested by default. Only notification channels of kind email and reports sent by email use it. |
| `GroupMember.Read.All` (optional, only with `-IncludeNotifications`) | Resolves the members of an Entra group picked as an email notification recipient, at send time only, guests excluded. Not requested by default. Sending to a list address needs no group permission. |
| `User.Read.All` (optional, only with `-IncludeNotifications`) | Reads mail address and user type of those group members so they can be addressed and guests excluded. Without it, Graph returns member objects with those fields empty and group recipients resolve to nobody. |
| `AuditLog.Read.All` (optional, only with `-IncludeAuditLog`) | Reads Conditional Access, named location and authentication strength changes from the Entra audit log (`GET /auditLogs/directoryAudits`) for notification change watching, and to name who changed them in [change reports](/reports/). Not requested by default. Only ids, times, activity names, target names and the actor are used. For updates, the policy versions Graph includes in each event are compared in memory to name the settings that changed; the policy content and its values are never kept or sent. |

:::note
**About `Policy.Read.All`:** only the opt-in Conditional Access service uses it, to read Conditional Access policies, named locations and authentication strengths. If you do not turn that service on and your security review requires it, you can remove this permission from the app registration.
:::

### Check what the app registration allows

**Settings** > **Services and permissions** lists each service TenuVault covers (Intune, and the opt-in Entra Conditional Access) with whether the tenant's app registration may back it up and restore it, and which permission is missing. With several tenants it starts with an overview of every tenant and service. For a missing permission it offers a link to the app registration's API permissions in Entra and, where TenuVault knows the permission's ID, Azure CLI commands that add it to the existing app registration. A backup type left out or a restore stopped for a missing permission links to this card.

TenuVault reads this from the sign-in it already has, without a new request to Microsoft; after you add a permission and grant consent, select **Check again**. Roles are not part of this check, because roles you can activate with Privileged Identity Management do not show until you activate them.

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

The app registration above never changes. If Conditional Access session controls stop scheduled backups at night, you can add a second, separate app registration, the **TenuVault Backup Reader**, with `New-TenuVaultBackupReader.ps1`. It has read-only Microsoft Graph application permissions (`DeviceManagementConfiguration.Read.All`, `DeviceManagementApps.Read.All`, `DeviceManagementServiceConfig.Read.All`, `DeviceManagementScripts.Read.All`, `DeviceManagementRBAC.Read.All`, and optionally `DeviceManagementManagedDevices.Read.All` and `Policy.Read.All`) and a certificate credential, never a secret. Only scheduled backups use it, and TenuVault refuses it when its Microsoft Graph token carries any other Graph permission. TenuVault cannot see application permissions for other APIs or Azure role assignments, so review those in Entra ID and on the storage account; `New-TenuVaultStorage.ps1` warns about broader roles on the storage account but does not remove them. See [Backup Reader for scheduled backups](/backups/backup-reader/) for what it can and cannot do, and [Conditional Access and TenuVault](/security/conditional-access/) for options that need no application permissions.

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

## Related pages

* [A client secret or a delegated sign-in for Intune automation](https://www.tenuvault.com/compare/intune-graph-client-secret-vs-delegated-sign-in): what an app-only script with a client secret exposes, on the product site
* [Security and privacy](/security/)
* [Network connections and data flows](/security/data-flows/)
* [Create the app registration](/getting-started/app-registration/)
* [Deploy TenuVault in your organization](/deploy/)
