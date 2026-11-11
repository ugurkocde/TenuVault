---
title: "Create the app registration"
description: Create the app registration TenuVault signs in through an app registration in your own tenant. In **Set up TenuVault**, open **Connect**, headed **Connect your tenant**, and select **Set up with Microsoft sign-in**. TenuVault creates or reuses the registration, grants admin consent and signs you in, with no IDs to copy.

You do this once per tenant. Every admin in that tenant can use the same registration. Setup takes a few minutes. The PowerShell script remains available if another person is the admin or you prefer to read the script first.

## Set up inside TenuVault

Use a Global Administrator, Privileged Role Administrator or Cloud Application Administrator with consent rights. The admins who use TenuVault also need an Intune role.

1. Select **Set up with Microsoft sign-in**. Choose your admin account in the browser. Microsoft asks you to approve **Microsoft Graph Command Line Tools**, Microsoft's public sign-in app, with delegated `Application.ReadWrite.All` and `DelegatedPermissionGrant.ReadWrite.All` permissions. These let setup create the registration and grant admin consent. They are not permissions of the resulting TenuVault registration.
2. TenuVault checks the tenant's plan before writing to Graph. It resolves the default permissions listed below and creates **TenuVault Desktop**, its enterprise application and tenant-wide delegated consent. If a registration has the same name, notes beginning with `Used by the TenuVault desktop app`, single-tenant audience and `http://localhost` public-client redirect URI, setup reuses it, choosing the newest matching registration. It adds missing consent without removing existing scopes. A different app with the same name is left alone.
3. The checklist shows **Wait for Microsoft to publish it**. Before the last item, it says **Your browser opens once more. There is nothing to enter this time.** The second sign-in uses the account you just chose. After sign-in you continue to **Storage**.

TenuVault keeps the setup token in memory only, with no persistent cache, and drops it when setup ends. No setup token reaches the renderer. The approval of **Microsoft Graph Command Line Tools** remains for that admin afterwards. Remove it in **Entra admin center > Enterprise applications > Microsoft Graph Command Line Tools > Permissions**. Removing that approval does not remove the TenuVault registration.

Expand **What the setup does** to review the permissions and the optional **Tenant ID or domain** field. Guest or partner admins can enter the target tenant there. Empty means the tenant of the account you sign in with. **Cancel** stops waiting for the setup browser sign-in.

If the final sign-in fails, the **Sign in** step keeps the IDs and shows the error. If publication takes longer, it says **Microsoft is still publishing the app registration. Wait a moment, then sign in.** Use **Sign in with Microsoft** after waiting briefly. You do not need to create another registration.

If provisioning fails after this run created the application, setup tries to remove it and reports whether cleanup succeeded. A reused registration is never deleted. Changes to a reused registration's consent can remain after an interrupted setup; retry setup to finish.

To remove TenuVault's access, delete **TenuVault Desktop** from **Entra admin center > App registrations** and remove its enterprise application if it remains. Backups already saved on this computer or in your own Azure storage stay there.

## What the setup creates

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
| Group read | Optional: also request `Group.Read.All` (`-IncludeGroupRead`), off by default |

Because the app is a public client with delegated permissions, every call runs as the signed-in admin. MFA, Conditional Access and your Intune role apply, and changes are attributed to that admin in the Entra and Intune audit logs.

This page is only about the app registration you sign in with. It never gets application permissions or a credential. The optional [Backup Reader](/backups/backup-reader/) for scheduled backups under strict Conditional Access is a second, separate app registration with its own setup script and its own page; do not add its permissions or certificate to this one.

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

The table above is the default permission set. It does not change unless you opt in. With `-IncludeGroupRead` the script adds one more delegated Microsoft Graph permission, `Group.Read.All`. Only the hygiene unresolved groups check uses it, to tell whether a group referenced by a policy assignment exists. Without it that check stays unknown and no group is reported as missing. With `-IncludeConditionalAccessRestore` it adds `Policy.ReadWrite.ConditionalAccess`, which restoring [Conditional Access](/backups/conditional-access/) needs; backing Conditional Access up only needs the default `Policy.Read.All`.

## Before you start

* An account with **Global Administrator**, **Privileged Role Administrator** or **Cloud Application Administrator**, which can grant admin consent.
* For the script alternative, PowerShell: Windows PowerShell 5.1 or PowerShell 7 on Windows, PowerShell 7 (`pwsh`) on macOS.
* A browser on the same computer. The script alternative opens it for the sign-in. It needs no PowerShell modules and installs nothing. In a remote shell without a browser, use `-UseDeviceCode` instead; Conditional Access often blocks device code flow.
* Optional: the object ID of a security group, if only its members should be able to sign in.

## Use the setup script instead

On **Connect**, select **Use the setup script instead** to reveal the script checklist:

1. **Save the setup script.** Select **Save setup script** and choose a folder in the save dialog. By default it is saved to your Documents folder as `New-TenuVaultDesktopApp.ps1`. TenuVault saves the copy of the script it ships with. **Copy script** copies it instead; paste it into a text editor and save it as `New-TenuVaultDesktopApp.ps1`.
2. **Run it in PowerShell.** The card shows the exact command, with a copy button. After you saved the script, the command first changes to the folder you chose (`cd`) and then runs the script. If PowerShell refuses to run it, the card suggests `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` first; see [Execution policy](#execution-policy).
3. **Sign in in your browser.** The script opens your browser. Choose your admin account. Microsoft may first ask you to consent to Microsoft Graph Command Line Tools, which the script signs in through to create the app registration.
4. **Return to TenuVault.** The script prints the Tenant id and the Application (client) id and copies them to your clipboard. TenuVault fills them in on the next step.

The card names the roles that can run the script: Global Administrator, Privileged Role Administrator or Cloud Application Administrator. Expand **Permissions the app registration gets** to see the delegated permissions per API before anyone consents, and the tip to add `-AllowedGroupId` with a group's object ID to limit sign-in to a group of admins.

The buttons under the checklist:

| Button | What it does |
| --- | --- |
| **Someone else is the admin? Copy instructions** | Copies a ready-to-send message for your Entra administrator: what TenuVault is, who can run the script, the script download link, the command, the `-AllowedGroupId` option, the permissions it grants and the two values to send back. TenuVault keeps your place, so you can close it and continue when they reply. |
| **Create it by hand instead** | Opens [Create the app registration manually](#create-the-app-registration-manually) on this page. |
| **Setup guide** | Opens this page. |

If the app registration already exists, select **I already have an app registration** to continue to [Sign in to your tenant](/getting-started/connect-tenant/).

## Get the script without TenuVault

[Download `New-TenuVaultDesktopApp.ps1`](/downloads/New-TenuVaultDesktopApp.ps1) and save it to a folder of your choice. If someone else creates the app registration for you, send them this link, or use **Someone else is the admin? Copy instructions** in TenuVault.

## Run the script

1. Open PowerShell in the folder where you saved the script. On macOS, use PowerShell 7 (`pwsh`).
2. Run the script with the parameters you need:

   ```powershell
   ./New-TenuVaultDesktopApp.ps1
   ```

   To create it in a specific tenant:

   ```powershell
   ./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com
   ```

   To limit sign-in to the members of one security group:

   ```powershell
   ./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com -DisplayName "TenuVault Desktop" -AllowedGroupId 00000000-0000-0000-0000-000000000000
   ```

   To also let the hygiene unresolved groups check read whether referenced groups exist:

   ```powershell
   ./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com -IncludeGroupRead
   ```

3. Sign in with your admin account in the browser the script opens. It asks you to choose an account, so a browser that is already signed in with another account does not pick that one.

   * The script signs in through **Microsoft Graph Command Line Tools**, the Microsoft app that Microsoft Graph PowerShell also signs in through. If Microsoft asks you to consent to it, accept. It requests `Application.ReadWrite.All` and `DelegatedPermissionGrant.ReadWrite.All` to create the app and grant consent, and `AppRoleAssignment.ReadWrite.All` only with `-AllowedGroupId`.
   * The script also prints the sign-in address. Open it by hand if the browser does not open, or if you need another browser or browser profile, for example the one Conditional Access accepts.
   * The script waits up to 15 minutes for the sign-in. Ctrl+C cancels. Nothing is created before you are signed in.
   * In a remote shell without a browser, run `./New-TenuVaultDesktopApp.ps1 -UseDeviceCode`: the script prints an address and a code to enter in a browser on any device.
4. Wait for the script to finish. While it grants admin consent, it lists the delegated permissions per API. At the end it prints:

   ```
   Done. Copy the two lines below and paste them into the Sign in step of Set up TenuVault:
     Tenant id:                <tenant id>
     Application (client) id:  <client id>
   ```

5. The script also copies both lines to your clipboard, when the computer it runs on offers one. Return to TenuVault: on the **Sign in** step it fills in the tenant ID and the client ID from the clipboard when both fields are empty. Otherwise paste both lines into **Paste the script output**. See [Sign in to your tenant](/getting-started/connect-tenant/). The tenant ID is always printed as a GUID, even if you passed a domain.

:::note
The script also ends with a reminder about admin roles. The roles TenuVault Desktop needs are listed in [Requirements](/getting-started/requirements/#admins-who-use-tenuvault).
:::

If a step fails after the app registration was created, the script removes it again. If it cannot remove it, it names the app registration to delete in the Microsoft Entra admin center. A run that you stop with Ctrl+C while it creates the app registration can leave it behind; delete it in the Microsoft Entra admin center before you run the script again.

If an app registration with the same name already exists, the script prints a note with its client ID. It still creates a new one and leaves the existing one unchanged.

### Parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `-TenantId` | No | Tenant ID or domain to create the app registration in. Defaults to the tenant of the account you sign in with. |
| `-DisplayName` | No | Name of the app registration. Default: `TenuVault Desktop`. |
| `-AllowedGroupId` | No | Object ID of a security group. When set, user assignment is required on the enterprise application and only members of this group can sign in to TenuVault. |
| `-IncludeGroupRead` | No | Switch. When set, also requests the delegated `Group.Read.All` permission so the hygiene unresolved groups check can run. Off by default, so the default permission set is unchanged. Because each run creates a new app registration, use this on a fresh run and sign in with the new client ID, or add `Group.Read.All` to an existing registration manually and grant admin consent. |
| `-UseDeviceCode` | No | Switch. Signs in with a device code instead of opening a browser on this computer, for remote shells without a browser. Conditional Access often blocks device code flow, so only use it when the browser sign-in is not possible. |

### Execution policy

If PowerShell refuses to run the saved script because of the execution policy, or because Windows marks the downloaded file as coming from the internet, allow scripts for the current session only and run it again:

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

[Sign in to your tenant](/getting-started/connect-tenant/) with the two values the script printed.
