---
title: "App registration and delegated permissions"
description: The app registration TenuVault signs in with, every delegated permission it requests, and why.
---

TenuVault signs in through an app registration that you create in your own tenant. This page describes exactly what that app registration contains, which permissions it requests, and how you can restrict or revoke it.

For the step-by-step setup, see [Create the app registration](/getting-started/app-registration/).

## What the setup script creates

The setup script, `New-TenuVaultDesktopApp.ps1`, is available as a [download from this site](/downloads/New-TenuVaultDesktopApp.ps1), from the sign-in screen in TenuVault (**Copy setup script**) and in the public repository. It creates:

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

At the end, the script prints your tenant ID and the application (client) ID. You enter these in TenuVault when you sign in.

### Who can run the script

You need the `Microsoft.Graph.Applications` and `Microsoft.Graph.Identity.SignIns` PowerShell modules (the script installs missing modules for the current user at the version of your installed `Microsoft.Graph.Authentication` module, so all Graph modules load at one version) and one of these roles:

* Global Administrator
* Privileged Role Administrator
* Cloud Application Administrator

The script connects to Microsoft Graph with the delegated scopes `Application.ReadWrite.All`, `DelegatedPermissionGrant.ReadWrite.All` and `AppRoleAssignment.ReadWrite.All`. It needs them only to create the app registration, grant consent and, if you use `-AllowedGroupId`, assign the group. TenuVault itself never uses these scopes.

## Why delegated permissions matter

Delegated permissions let an app act on behalf of a signed-in user. They never grant access on their own:

* **TenuVault can never do more than you can.** The effective access is the overlap between the delegated permissions and the roles of the admin who signs in. An admin with a read-only Intune role cannot restore or change anything through TenuVault, even though the app registration requests write permissions.
* **There is no background identity.** Without application permissions and without a secret, the app registration cannot get a token by itself. Every token belongs to a person who signed in.
* **Your sign-in controls apply.** MFA, Conditional Access and sign-in frequency apply to every TenuVault session.
* **Changes are traceable.** Writes appear under the signed-in admin's name in the Intune and Entra audit logs.

## Delegated permissions

### Microsoft Graph

| Permission | Why TenuVault needs it |
| --- | --- |
| `User.Read` | Signs you in and reads your own basic profile. |
| `Organization.Read.All` | Reads your organization's name and verified domains for the tenant overview. |
| `Policy.Read.All` | Requested by the setup script. See the note below the table. |
| `DeviceManagementConfiguration.ReadWrite.All` | Backs up and restores device configuration profiles, Settings Catalog and endpoint security policies, administrative templates, compliance policies, security baselines, Windows update profiles, assignment filters, policy sets, compliance notification templates and related configuration. Also used by the OpenIntuneBaseline section to read, create and update the OIB policies you choose, and by Framework coverage to read and create Settings Catalog policies. |
| `DeviceManagementApps.ReadWrite.All` | Backs up and restores apps, app categories, app configuration policies and app protection policies. |
| `DeviceManagementServiceConfig.ReadWrite.All` | Backs up and restores enrollment configurations, Windows Autopilot deployment profiles, Apple enrollment profiles, terms and conditions and Company Portal branding. |
| `DeviceManagementScripts.ReadWrite.All` | Backs up and restores Windows PowerShell scripts, macOS shell scripts, macOS custom attributes, remediations and compliance scripts. |
| `DeviceManagementRBAC.ReadWrite.All` | Backs up and restores Intune roles, role assignments, scope tags and multi admin approval policies. |
| `DeviceManagementManagedDevices.Read.All` | Reads device categories and device clean-up rules for backups, and the managed device count and compliance rate shown in the tenant overview. Read only: TenuVault cannot change or wipe devices. |
| `Group.Read.All` (optional, only with `-IncludeGroupRead`) | Reads whether a group referenced by a policy assignment exists, so the hygiene unresolved groups check can report missing groups. Not requested by default. Without it that check stays unknown. TenuVault reads group existence only (`GET groups/{id}?$select=id`); it does not list groups or read membership. |
| `Mail.Send` (optional, only with `-IncludeNotifications`) | Sends notification email as the signed-in admin (`POST /me/sendMail`). Not requested by default. Only notification channels of kind email use it. |
| `GroupMember.Read.All` (optional, only with `-IncludeNotifications`) | Resolves the members of an Entra group picked as an email notification recipient, at send time only, guests excluded. Not requested by default. Sending to a list address needs no group permission. |

:::note
**About `Policy.Read.All`:** the setup script requests this permission, but no feature in the current version of TenuVault Desktop calls an API that requires it. TenuVault Desktop does not back up Conditional Access or other Entra policies. If your security review requires it, you can remove this permission from the app registration.
:::

### Azure Service Management

| Permission | Why TenuVault needs it |
| --- | --- |
| `user_impersonation` | Lists the Azure subscriptions and storage accounts you can see, so you can pick a storage account for backups. Used only when you choose **Your Azure storage account, encrypted** as backup storage. TenuVault only reads these lists; it does not create or change subscriptions or storage accounts. |

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

## Notification email and group recipients (optional)

Email notification channels send as the signed-in admin and can resolve Entra group recipients. Both are off unless you opt in with `-IncludeNotifications` on a fresh registration, or by adding the delegated `Mail.Send` and `GroupMember.Read.All` permissions to an existing registration and granting admin consent:

```powershell
./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com -IncludeNotifications
```

See [Notifications](/notifications/) for what is sent. The Azure watcher has its own managed identity and its own application roles (`DeviceManagementApps.Read.All`, and only when used, `Mail.Send` restricted to one mailbox in Exchange and `GroupMember.Read.All`); the watcher setup script prints exactly what it granted.

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
* Sign-in frequency to control how long a TenuVault session lasts before you sign in again.

## Related pages

* [Security and privacy](/security/)
* [Network connections and data flows](/security/data-flows/)
* [Create the app registration](/getting-started/app-registration/)
* [Deploy TenuVault in your organization](/deploy/)
