---
title: "Create the app registration"
description: Create the app registration TenuVault signs in with.
---

TenuVault signs in through an app registration that lives in your own tenant. A PowerShell setup script creates it in one step and prints the two values you enter in the app: the tenant ID and the client ID.

You do this once per tenant. Every admin who uses TenuVault in that tenant signs in through the same app registration.

## What the script creates

| Setting | Value |
| --- | --- |
| Name | **TenuVault Desktop** (change it with `-DisplayName`) |
| Supported account types | Accounts in this organizational directory only (single tenant) |
| Client type | Public client: no client secret and no certificate |
| Redirect URIs | `http://localhost` (browser sign-in) |
| Permissions | Delegated permissions only, listed below |
| Admin consent | Granted tenant-wide for all of the permissions below |
| Enterprise application | Hidden from users' My Apps portal |
| Sign-in restriction | Optional: only members of one group can sign in (`-AllowedGroupId`) |

Because the app is a public client with delegated permissions, every call runs as the signed-in admin. MFA, Conditional Access and your Intune role apply, and changes are attributed to that admin in the Entra and Intune audit logs.

### Delegated permissions

| API | Permission |
| --- | --- |
| Microsoft Graph | `User.Read` |
| Microsoft Graph | `Organization.Read.All` |
| Microsoft Graph | `Policy.Read.All` |
| Microsoft Graph | `DeviceManagementConfiguration.ReadWrite.All` |
| Microsoft Graph | `DeviceManagementApps.ReadWrite.All` |
| Microsoft Graph | `DeviceManagementServiceConfig.ReadWrite.All` |
| Microsoft Graph | `DeviceManagementScripts.ReadWrite.All` |
| Microsoft Graph | `DeviceManagementRBAC.ReadWrite.All` |
| Microsoft Graph | `DeviceManagementManagedDevices.Read.All` |
| Azure Service Management | `user_impersonation` |
| Azure Storage | `user_impersonation` |

The two Azure permissions are only used when backups go to your Azure storage account: Azure Service Management lists your subscriptions and storage accounts in the storage picker, and Azure Storage reads and writes the backup files. For what each permission is used for, see [App registration and delegated permissions](/security/permissions/).

## Before you start

* An account with **Global Administrator**, **Privileged Role Administrator** or **Cloud Application Administrator**, which can grant admin consent.
* PowerShell: Windows PowerShell 5.1 or PowerShell 7 on Windows, PowerShell 7 (`pwsh`) on macOS.
* The Microsoft Graph PowerShell modules `Microsoft.Graph.Applications` and `Microsoft.Graph.Identity.SignIns`. If they are missing, the script installs them for the current user from the PowerShell Gallery.
* Optional: the object ID of a security group, if only its members should be able to sign in.

## Get the script

The setup script is built into TenuVault.

1. Start TenuVault. If it shows **Welcome to TenuVault**, select a plan first; see [Choose a plan on first launch](/getting-started/first-launch/). You can change your plan later.
2. On the **Prepare** step of **Set up TenuVault**, select **Copy setup script**. You also find this button in **Tenants** > **Connect tenant** under **First time? Create an app registration**.
3. Paste the script into a text editor and save it as `New-TenuVaultDesktopApp.ps1`.

If someone else creates the app registration for you, send them the saved file.

## Run the script

1. Open PowerShell in the folder where you saved the script.
2. Run the script with the parameters you need:

   ```powershell
   ./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com
   ```

   To limit sign-in to the members of one security group:

   ```powershell
   ./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com -DisplayName "TenuVault Desktop" -AllowedGroupId 00000000-0000-0000-0000-000000000000
   ```

3. Sign in with your admin account when Microsoft Graph PowerShell asks you to. If you are prompted to consent to the permissions Graph PowerShell requests, accept. The script connects with `Application.ReadWrite.All`, `DelegatedPermissionGrant.ReadWrite.All` and `AppRoleAssignment.ReadWrite.All` to create the app and grant consent.
4. Wait for the script to finish. It prints:

   ```
   Done. Enter these values in TenuVault > Tenants > Add tenant:
     Tenant id:                <tenant id>
     Application (client) id:  <client id>
   ```

5. Copy the **Application (client) id**. You enter it when you [sign in to your tenant](/getting-started/connect-tenant/). The tenant ID is always printed as a GUID, even if you passed a domain.

:::note
In the app, the button is called **Connect tenant**, not **Add tenant**. The script also ends with a reminder about admin roles. The roles TenuVault Desktop needs are listed in [Requirements](/getting-started/requirements/#admins-who-use-tenuvault).
:::

### Parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `-TenantId` | No | Tenant ID or domain to create the app registration in. Defaults to the tenant of the account you sign in with. |
| `-DisplayName` | No | Name of the app registration. Default: `TenuVault Desktop`. |
| `-AllowedGroupId` | No | Object ID of a security group. When set, user assignment is required on the enterprise application and only members of this group can sign in to TenuVault. |

### Execution policy

If PowerShell refuses to run the saved script because of the execution policy, allow scripts for the current session only and run it again:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com
```

:::caution
Each run creates a new app registration with a new client ID. It does not update an existing one. If you run the script twice, delete the app registration you do not use in the Microsoft Entra admin center.
:::

## Create the app registration manually

If you cannot run PowerShell, you can create the same app registration in the [Microsoft Entra admin center](https://entra.microsoft.com). These steps reproduce every setting the script makes.

### 1. Register the app

1. Go to **Entra ID** > **App registrations** > **New registration**.
2. **Name:** `TenuVault Desktop`.
3. **Supported account types:** **Accounts in this organizational directory only** (single tenant).
4. Leave **Redirect URI** empty and select **Register**.
5. On the **Overview** page, copy the **Application (client) ID** and the **Directory (tenant) ID**.
6. Optional: under **Branding & properties**, set **Internal notes** to `Used by the TenuVault desktop app. Delegated permissions only, no credentials.` The script adds this note; it has no effect on sign-in.

### 2. Add the redirect URIs

1. Open **Authentication** and select **Add a platform** > **Mobile and desktop applications**.
2. Add the custom redirect URI `http://localhost`.
3. Select **Configure**.
4. Leave **Allow public client flows** under **Advanced settings** at **No**. TenuVault signs in through the browser and never uses device code or password flows.

Do not add a client secret or a certificate.

### 3. Add the delegated permissions

1. Open **API permissions** > **Add a permission**.
2. Select **Microsoft Graph** > **Delegated permissions** and add the nine Graph permissions listed in [Delegated permissions](#delegated-permissions). `User.Read` is usually already present.
3. Select **Add a permission** again. Under **Microsoft APIs** (or **APIs my organization uses**), choose **Azure Service Management** > **Delegated permissions** > `user_impersonation`.
4. Repeat for **Azure Storage** > **Delegated permissions** > `user_impersonation`.
5. Select **Grant admin consent for &lt;your tenant&gt;** and confirm. Every permission should show **Granted**.

### 4. Hide the app from My Apps

1. Go to **Entra ID** > **Enterprise apps** and open **TenuVault Desktop**.
2. Open **Properties**, set **Visible to users?** to **No** and save.

### 5. Optional: limit sign-in to one group

1. In the same enterprise application, open **Properties**, set **Assignment required?** to **Yes** and save.
2. Open **Users and groups** > **Add user/group**, select your security group and assign it.

:::note
Assigning a group to an enterprise application requires Microsoft Entra ID P1 or P2. Group-based assignment applies to direct members of the group only; members of nested groups cannot sign in.
:::

## Next step

[Choose a plan on first launch](/getting-started/first-launch/), then [sign in to your tenant](/getting-started/connect-tenant/) with the client ID.
