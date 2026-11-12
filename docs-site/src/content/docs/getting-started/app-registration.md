---
title: "Create the app registration"
description: Create the app registration TenuVault signs in with.
---

TenuVault signs in through an app registration that lives in your own tenant. TenuVault creates it for you: in **Set up TenuVault**, the **Connect** step has one button, **Set up with Microsoft sign-in**. You sign in once in your browser, and TenuVault creates the app registration, grants admin consent and signs you in. There is no script to run and no ID to copy.

You do this once per tenant. Every admin who uses TenuVault in that tenant signs in through the same app registration.

If someone else is the administrator who can grant consent, or you prefer to read a script first, a [PowerShell setup script](#use-the-setup-script-instead) does the same.

## Set up with Microsoft sign-in

You need an account with **Global Administrator**, **Cloud Application Administrator** or **Application Administrator**, because the setup creates an app registration and grants tenant-wide admin consent. A Privileged Role Administrator can grant the consent, but can create the app registration only when users in the tenant may register applications, so the setup does not count on that role. TenuVault connects tenants in Microsoft's global cloud only; tenants in GCC High, DoD or Microsoft Azure operated by 21Vianet are not supported.

1. On the **Connect** step, **Connect your tenant**, select **Set up with Microsoft sign-in**.
2. Your browser opens. Choose your admin account. Microsoft asks you to approve **Microsoft Graph Command Line Tools** with two permissions, `Application.ReadWrite.All` and `DelegatedPermissionGrant.ReadWrite.All`. This is Microsoft's own sign-in app, the one Microsoft Graph PowerShell also signs in through. TenuVault uses it once, to create the app registration and grant consent. These two permissions are not permissions of the TenuVault app registration. If Microsoft also shows **Consent on behalf of your organization**, leave it unticked; the setup does not need it.
3. TenuVault shows what it is doing under **Setting up your tenant**:
   * **Create the app registration**: the app registration **TenuVault Desktop**, as described in [What the setup creates](#what-the-setup-creates). If the tenant already has a TenuVault app registration from an earlier setup, TenuVault uses that one and the list says **Use the app registration this tenant already has**, followed by **Check its admin consent**.
   * **Grant admin consent**: tenant-wide consent for the [delegated permissions](#delegated-permissions) below, and nothing else.
   * **Wait until Microsoft accepts sign-ins to it**: Microsoft needs a few seconds before a new app registration can be used.
4. When Microsoft accepts sign-ins to the app registration, your browser opens once more and signs you in to TenuVault through it. There is nothing to enter this time. TenuVault continues with the **Storage** step: [Choose where backups are stored](/getting-started/choose-storage/).

**Cancel** works in every phase of the setup. Nothing is created before you are signed in. If you cancel while TenuVault creates the app registration or grants consent, it removes the app registration it created. If you cancel while it waits for Microsoft to accept sign-ins, the app registration is complete and stays in your tenant: TenuVault says so, and the next setup uses it.

Expand **What the setup does** on the Connect step to read these steps and the permissions before you start. It also has the optional field **Tenant ID or domain (optional)**, for guest and partner admins who set up a tenant other than their own. Leave it empty to use the tenant of the account you sign in with.

### What TenuVault does with the setup sign-in

* The sign-in from step 2 is kept in memory only and dropped when the setup ends. It is never saved on the computer.
* Your approval of **Microsoft Graph Command Line Tools** stays in your tenant, for your account, as long as you left **Consent on behalf of your organization** unticked. To remove it, open **Entra admin center** > **Enterprise applications** > **Microsoft Graph Command Line Tools** > **Permissions**. Removing it does not affect the TenuVault app registration.

### An app registration that already exists

TenuVault does not create a second app registration when the tenant already has one of its own that an administrator approved before. It uses an existing app registration only when all of this is true:

* Its name starts with `TenuVault` and it carries the internal note that starts with `Used by the TenuVault desktop app`.
* It is single tenant and has the redirect URI `http://localhost` for mobile and desktop applications.
* It is still the plain desktop registration TenuVault makes: no client secret, no certificate, and no web or single-page application redirect URI.
* It has an enterprise application, and that already has tenant-wide admin consent for at least one of TenuVault's Intune permissions on Microsoft Graph.

The last point is what TenuVault relies on. A name and a note can be set by anyone who may create app registrations, which in many tenants is every member. Tenant-wide admin consent can only come from an administrator, so it shows that an administrator trusted this app registration before. An app registration that does not meet every point is left exactly as it is, and TenuVault creates its own next to it.

TenuVault changes nothing in an app registration it did not create: it adds no permission, grants no consent and removes nothing. It gives consent only to the one it creates. The **Sign in** step names the app registration it uses. If that one has no tenant-wide admin consent for some of the [default permissions](#delegated-permissions), the step lists them and waits for you instead of signing in by itself. What needs those permissions does not work until an administrator adds them and grants consent under **Entra admin center** > **App registrations** > the app registration > **API permissions**. You can sign in without them.

If several match, TenuVault uses the one whose tenant-wide admin consent covers the most of TenuVault's permissions, and among equals the oldest. One whose enterprise application has sign-in turned off is passed over while another one matches. The **Sign in** step then says how many there are and waits for you as well. Select **Sign in with Microsoft** to use the one it names. To use a different one, select **Previous**, then **I already have an app registration**, and enter its client ID.

This matters for licensing: an organization license is tied to the app registration it was shared from, so signing in through a second app registration would leave the tenant on Community. See [Manage your license](/licensing/manage/#community-although-the-tenant-has-an-organization-license).

This is also what happens when a second admin connects the same tenant on another computer, or when you run the setup again.

If your tenant does not list Azure Service Management or Azure Storage among its enterprise applications yet, the setup adds them, as the script does. They are Microsoft's own APIs, not part of TenuVault, and they stay in the tenant.

### If something goes wrong

* If your account cannot approve the setup, Microsoft says so in the browser, for example **Need admin approval**, and nothing comes back to TenuVault. Select **Cancel** on the Connect step and use one of the **Other ways to connect**: **Someone else is the admin? Copy instructions** for your Entra administrator, or **I already have an app registration**. If you decline Microsoft's request instead, TenuVault tells you which roles can approve it. Nothing is created in either case, and TenuVault stops waiting by itself after 15 minutes.
* If the tenant blocks **Microsoft Graph Command Line Tools** for your account, for example by turning its sign-in off, limiting it to assigned users or with a Conditional Access policy, the setup cannot sign in. The setup script signs in through the same app, so it is blocked too. TenuVault says so and offers **Create it by hand**: [create the app registration manually](#create-the-app-registration-manually), then select **I already have an app registration** and enter its two IDs. When Microsoft shows its own error page instead, nothing comes back to TenuVault; select **Cancel** and take the same route.
* If your account may sign in but lacks a role that can create app registrations or grant admin consent, the setup stops with a message that names the roles. If it had already created the app registration, it removes it again first.
* If a step fails after TenuVault created the app registration, TenuVault removes it again and tells you why. If it cannot remove it, it names the app registration to delete in the Microsoft Entra admin center. An app registration that existed before is never deleted.
* If the last sign-in fails or you cancel it, the **Sign in** step opens with the tenant ID and the client ID filled in. Select **Sign in with Microsoft** to try again. Nothing is created twice.
* If Microsoft takes longer than a minute and a half to accept sign-ins to the new app registration, the browser does not open again. The **Sign in** step says so. Wait a moment, then select **Sign in with Microsoft**.
* If the browser says that Microsoft cannot find the application, Microsoft has not finished publishing the new app registration. Wait a minute, select **Cancel sign-in** in TenuVault and sign in again.
* If the tenant already has a TenuVault app registration whose enterprise application has sign-in turned off, the setup stops and changes nothing. Turn sign-in on again under **Entra admin center** > **Enterprise applications** > the application the message names > **Properties**, or delete the app registration, then run the setup again.

For the messages TenuVault shows, see [Troubleshooting](/troubleshooting/).

### Remove it again

Delete **TenuVault Desktop** under **Entra admin center** > **App registrations**. That removes the sign-in and the consent. Backups you already saved stay where they are, on this computer or in your Azure storage.

## What the setup creates

| Setting | Value |
| --- | --- |
| Name | **TenuVault Desktop** (the script can change it with `-DisplayName`) |
| Supported account types | Accounts in this organizational directory only (single tenant) |
| Client type | Public client: no client secret and no certificate |
| Redirect URIs | `http://localhost` (browser sign-in) |
| Permissions | Delegated permissions only, listed below |
| Admin consent | Granted tenant-wide for all of the permissions below |
| Enterprise application | Hidden from users' My Apps portal |
| Sign-in restriction | Optional, with the script: only members of one group can sign in (`-AllowedGroupId`) |
| Group read | Optional, with the script: also request `Group.Read.All` (`-IncludeGroupRead`), off by default |

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

## Use the setup script instead

The script creates the same app registration from PowerShell and prints the two values you paste into TenuVault: the tenant ID and the client ID. Use it when another administrator grants the consent, when you want to read what runs first, or when you need one of its options, such as limiting sign-in to a group.

Before you run it:

* An account with **Global Administrator**, **Cloud Application Administrator** or **Application Administrator**, which can create the app registration and grant admin consent.
* A tenant that lets your account sign in to **Microsoft Graph Command Line Tools**, which the script signs in through, like the setup in TenuVault. If the tenant blocks it, [create the app registration manually](#create-the-app-registration-manually) instead.
* PowerShell: Windows PowerShell 5.1 or PowerShell 7 on Windows, PowerShell 7 (`pwsh`) on macOS. The script needs no PowerShell modules and installs nothing.
* A browser on the same computer, which the script opens for the sign-in. In a remote shell without a browser, use `-UseDeviceCode` instead; Conditional Access often blocks device code flow.
* Optional: the object ID of a security group, if only its members should be able to sign in.

On the **Connect** step, under **Other ways to connect**, select **Use the setup script instead**. The card **Create the app registration** is a numbered checklist:

1. **Save the setup script.** Select **Save setup script** and choose a folder in the save dialog. By default it is saved to your Documents folder as `New-TenuVaultDesktopApp.ps1`. TenuVault saves the copy of the script it ships with. **Copy script** copies it instead; paste it into a text editor and save it as `New-TenuVaultDesktopApp.ps1`.
2. **Run it in PowerShell.** The card shows the exact command, with a copy button. After you saved the script, the command first changes to the folder you chose (`cd`) and then runs the script. If PowerShell refuses to run it, the card suggests `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` first; see [Execution policy](#execution-policy).
3. **Sign in in your browser.** The script opens your browser. Choose your admin account. Microsoft may first ask you to consent to Microsoft Graph Command Line Tools, which the script signs in through to create the app registration.
4. **Return to TenuVault.** The script prints the Tenant id and the Application (client) id and copies them to your clipboard. TenuVault fills them in on the next step.

The card names the roles that can run the script: Global Administrator, Cloud Application Administrator or Application Administrator. Expand **Permissions the app registration gets** to see the delegated permissions per API before anyone consents, and the tip to add `-AllowedGroupId` with a group's object ID to limit sign-in to a group of admins.

The buttons under the checklist:

| Button | What it does |
| --- | --- |
| **Someone else is the admin? Copy instructions** | Copies a ready-to-send message for your Entra administrator: what TenuVault is, who can run the script, the script download link, the command, the `-AllowedGroupId` option, the permissions it grants and the two values to send back. TenuVault keeps your place, so you can close it and continue when they reply. |
| **Create it by hand instead** | Opens [Create the app registration manually](#create-the-app-registration-manually) on this page. |
| **Setup guide** | Opens this page. |

Select **Next: sign in** under the card when you have the two values. If the app registration already exists, for example from an earlier setup, select **I already have an app registration** instead. Both open [Sign in to your tenant](/getting-started/connect-tenant/#step-2-sign-in).

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

If you cannot run PowerShell, or your tenant blocks Microsoft Graph Command Line Tools for your account, you can create the same app registration in the [Microsoft Entra admin center](https://entra.microsoft.com). These steps reproduce every setting the script makes.

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
