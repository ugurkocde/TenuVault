---
title: "Backup Reader for scheduled backups"
description: An optional read-only identity that keeps scheduled backups running when Conditional Access session controls end your sign-in.
---

TenuVault normally works only as you, the signed-in admin. When a Conditional Access policy ends your session at night, for example with sign-in frequency, scheduled backups stop until you sign in again. The **Backup Reader** is an optional, read-only identity that only scheduled backups use, so they keep running.

Before you add it, check whether a policy change is simpler: see [Conditional Access and TenuVault](/security/conditional-access/). When the real problem is that no computer is reliably on at backup time, [cloud backups](/backups/cloud/) move the schedule into your own Azure Automation account instead: same read-only roles, no certificate to renew per computer, but Azure resources and a recovery key in Key Vault to own.

## What it is

* A **separate app registration** in your tenant, "TenuVault Backup Reader", created by a setup script. Your existing TenuVault app registration does not change.
* A **certificate credential**. TenuVault creates the key pair on your computer. The private key stays in TenuVault's encrypted store (Windows DPAPI or the macOS Keychain) and is never shown or exported. Only the public certificate is uploaded.
* **Read-only application permissions** for Microsoft Graph, and for Azure Storage a role that can write backups but not delete them.
* Used **only by scheduled backups**. Backups you start yourself, backups from the tray, the backup before a change, restores, reverts and every other change use your own sign-in, MFA and Conditional Access.

## What it can and cannot do

| | Backup Reader |
| --- | --- |
| Read Intune configuration | Yes, all of it in the tenant, including script contents. Intune role scope tags do not limit it. |
| Change Intune | No. TenuVault refuses a reader with any permission beyond the read list below, and stops using it when its permissions change. |
| Write backups to Azure Storage | Yes, into the backup container only. |
| Delete backups | No, provided it has only the **TenuVault Backup Writer** role (see [Permissions](#permissions)). That role has no delete permission, and if the reader overwrites a blob, blob versioning keeps the previous version for 30 days (`-VersionRetentionDays`), long enough to notice and recover it. A broader storage role assigned to the reader by hand would override this; the storage script warns about such roles and step 3 below includes the IAM check. |
| Read encrypted OMA-URI values in plain text | No. Microsoft only returns those with a write permission. Scheduled backups store them masked (`****`) and mark those profiles as not restorable from that backup; a manual backup captures them. |
| Read device categories and device clean-up rules | Only with the optional device inventory permission (see below). Otherwise scheduled backups leave them out and manual backups include them. |
| Bypass licensing | No. Scheduled backups still need a license that covers the tenant. |

### Permissions

Microsoft Graph application permissions, read-only:

| Permission | Used for |
| --- | --- |
| `DeviceManagementConfiguration.Read.All` | Configuration profiles, Settings Catalog, endpoint security, compliance and update policies, assignment filters. |
| `DeviceManagementApps.Read.All` | Apps, app configuration and app protection policies, policy sets. |
| `DeviceManagementServiceConfig.Read.All` | Enrollment configurations, Autopilot and Apple enrollment profiles, terms and conditions, branding. |
| `DeviceManagementScripts.Read.All` | PowerShell and shell scripts, custom attributes, remediations, compliance scripts. |
| `DeviceManagementRBAC.Read.All` | Intune roles, role assignments, scope tags, multi admin approval policies. |
| `DeviceManagementManagedDevices.Read.All` (optional) | Device categories and device clean-up rules. Off by default, because it also exposes the managed device inventory (device names, serial numbers, primary users). Add it with `-IncludeDeviceCategories`. |

For Azure Storage, the custom role **TenuVault Backup Writer** allows reading and writing blobs, assigned on the `intune-backups` container only. It has no delete permission and cannot create containers.

## Requirements

* **Pro or MSP** for the tenant.
* The **installed Windows or macOS app**, where scheduled backups run.
* An **Entra administrator** for the setup script (see [Who has to do what](#who-has-to-do-what)). In most companies this is not the Intune administrator who uses TenuVault, so plan for a handoff.
* For backups in Azure: an **Azure administrator** for the storage script.

## Terms on this page, in plain language

You do not need to know Entra ID app registrations to follow the setup. These are the words the other administrators will use:

| Term | What it means here |
| --- | --- |
| App registration | A definition in Entra ID that says "this app exists, here is how it proves who it is, and here is what it may ask for". TenuVault uses two: the one you sign in with (existing, unchanged) and the new Backup Reader. |
| Enterprise application (service principal) | The live copy of an app registration inside your tenant. Permissions you grant, role assignments and sign-in logs belong to this copy. The setup script creates it automatically. |
| Delegated permission | The app may act only as a signed-in person, and never beyond that person's own roles. Everything TenuVault normally does works this way. |
| Application permission | The app may act on its own, with no person signed in. The Backup Reader has only this kind, and only read permissions. |
| Admin consent | An Entra administrator approves the permissions for the whole tenant. Without it, the permissions exist on paper but Microsoft issues no token. The setup script grants it, which is why it needs a highly privileged role. |
| Certificate credential | A key pair instead of a password. The private half proves identity and never leaves the TenuVault computer. The public half (the `.cer` file) is uploaded to the app registration and is safe to send to your Entra administrator. There is no client secret. |
| Azure role assignment | A separate Azure decision: "this identity may read and write blobs in this one container". Graph permissions do not cover storage, and storage roles do not cover Intune. Azure backups need both halves. |
| Application (client) ID | The public ID of the Backup Reader app registration. The scripts print it, you type it into TenuVault once, and your Azure administrator needs it. It is not a secret. |

## Who has to do what

Setup involves up to four people. One person can hold several of these roles, but in many companies they are different people, so send each of them this page before you start.

| Person | What they do | Role they need |
| --- | --- | --- |
| **You**, the Intune administrator who uses TenuVault | Start setup in TenuVault, save the public certificate, hand it to the Entra administrator, enter the application ID they send back, select **Verify**, and confirm the first scheduled backup. | Your normal TenuVault and Intune roles. No Entra or Azure admin role. |
| **Entra administrator** | Review and run `New-TenuVaultBackupReader.ps1`. It creates the app registration and its enterprise application, sets exactly the read permissions, uploads your certificate and grants admin consent. They send you the printed tenant ID, application (client) ID and certificate thumbprint. | **Global Administrator** or **Privileged Role Administrator**. A Cloud Application Administrator can maintain app registrations, but granting these application permissions needs one of the two privileged roles, so have one of them run the script. |
| **Azure administrator** (only for backups in Azure Storage) | Run `New-TenuVaultStorage.ps1` with `-BackupReaderAppId`. It creates the backup container, the custom **TenuVault Backup Writer** role, its assignment to the Backup Reader on that container only, blob versioning, and the lifecycle rule for previous versions. | **Owner**, or **Contributor** plus **User Access Administrator**, on the storage account's resource group. User Access Administrator alone is not enough: creating the custom role and assigning it needs the role write access, and creating the container, versioning and lifecycle rule needs Contributor's storage management access. |
| **Conditional Access or security administrator** (recommended, not required) | Approve the exception in the first place, review the permission list below, and optionally restrict the Backup Reader with a Conditional Access policy for workload identities (needs Microsoft Entra Workload ID Premium). They also own the "something looks wrong" review of its sign-ins. | Whoever owns Conditional Access and app reviews in your company. |

Agree before you start:

* **The decision itself.** The Backup Reader is a standing, tenant-wide read credential for Intune configuration, including script contents. Intune scope tags do not limit it. Whoever approves app registrations at your company should approve this, ideally in a ticket or change record that links to this page and to [App registration and delegated permissions](/security/permissions/#optional-the-backup-reader).
* **Whether to add the device inventory permission.** Without `DeviceManagementManagedDevices.Read.All`, scheduled backups leave out device categories and clean-up rules. With it, the reader can also see device names, serial numbers and primary users. This is a privacy and security decision, and it changes the script command (`-IncludeDeviceCategories`) every time it runs.
* **Who owns it afterwards.** One named owner (usually you) for certificate renewals, the yearly Entra administrator appointment, and removing certificates of retired computers. Put a renewal reminder in a shared calendar or ticket system; TenuVault also warns from 30 days before expiry, but only on the computer that runs it.

## Before you start: collect this

Having these values ready saves a round of messages with each administrator:

* The tenant: its name or ID, and confirmation that the tenant is on Pro or MSP and connected in the installed app.
* Your decision on `-IncludeDeviceCategories` (see above).
* For Azure backups: the subscription ID, resource group name and storage account name of the tenant's backup storage, plus the object ID of your Intune admin security group (the storage script always needs `-AdminGroupId`, even on a rerun). Your Azure administrator can look each of these up, but the storage account name must be the one the tenant actually uses in TenuVault.
* A time when your Entra administrator (and Azure administrator) can activate their privileged role if they use PIM. An eligible role that is not activated cannot run the scripts.
* PowerShell on the administrator's computer. The scripts install their modules (`Microsoft.Graph.Applications`, or the `Az` modules) for the current user when missing. A first `Connect-MgGraph` sign-in can itself ask for consent to the Microsoft Graph PowerShell app; that is expected, and it is their admin account signing in, not TenuVault.

## Set it up

### Step 1, you: create the certificate in TenuVault

1. Open **Settings** > **Background runner**, find the **Backup Reader** card, choose the tenant and select **Set up the Backup Reader**.
2. Select **Save certificate**. This saves the public certificate as a `.cer` file. The private key stays encrypted on this computer and TenuVault cannot show or export it, so nobody needs to ask you for it.

### Step 2, your Entra administrator: create the app registration

Send them the saved `.cer` file, the script (**Copy setup script** on the card, or the [download](/downloads/New-TenuVaultBackupReader.ps1)), and whether you agreed on `-IncludeDeviceCategories`. You can copy and adjust this request:

> Please create the "TenuVault Backup Reader" app registration for scheduled Intune backups. The attached `.cer` file is a public certificate only; the private key stays on my computer. Run: `./New-TenuVaultBackupReader.ps1 -CertificatePath <file> -TenantId <our tenant>` (add `-IncludeDeviceCategories` only if we agreed on it). The script creates a single-tenant app registration with exactly five read-only Graph application permissions, uploads the certificate, removes any other permission on that app, and grants admin consent. Details and the permission list: https://docs.tenuvault.com/backups/backup-reader/ Please send me the application (client) ID and certificate thumbprint it prints.

They run:

```powershell
./New-TenuVaultBackupReader.ps1 -CertificatePath "./TenuVault Backup Reader 1A2B3C4D.cer" -TenantId contoso.onmicrosoft.com
```

What they can check afterwards in Entra ID > **App registrations** > **TenuVault Backup Reader**:

* **API permissions:** exactly the five (or six) read permissions from the table below, type **Application**, status **Granted**. Nothing else.
* **Certificates & secrets:** your certificate with its thumbprint and expiry date, and no client secret. The script never creates one; if a secret appears there, someone added it by hand.
* **Owners:** add the agreed owner here, so the registration is not tied to one person's account.
* Under **Enterprise applications**, an entry of the same name exists. Its token requests later appear in **Sign-in logs** > **Service principal sign-ins** (grouped by Microsoft; a cached token can serve several backups, so there is not one entry per backup).

Running the script again with the same values changes nothing that already matches, so a failed or interrupted run is safe to repeat. It also removes permissions that were added to the reader by hand.

### Step 3, your Azure administrator: storage write access (Azure backups only)

Skip this step when backups stay on the TenuVault computer. Otherwise send your Azure administrator the application (client) ID from step 2, the storage values you collected, and this request:

> Please let the TenuVault Backup Reader (application ID `<id>`) write backups to our backup storage, without delete access. Run: `./New-TenuVaultStorage.ps1 -AdminGroupId <Intune admin group object ID> -SubscriptionId <subscription> -ResourceGroupName <resource group> -StorageAccountName <storage account> -BackupReaderAppId <id>`. It creates the `intune-backups` container, a custom "TenuVault Backup Writer" role (read and write blobs, no delete) assigned to the reader on that container only, turns on blob versioning, and adds a lifecycle rule that removes only previous blob versions. Details: https://docs.tenuvault.com/backups/backup-reader/

They run the command from the request. The role assignment to the Backup Reader is direct and permanent; a PIM eligible assignment would never be active at night. What they can check afterwards in the Azure portal:

* The `intune-backups` container exists.
* On that container's **Access Control (IAM)**, the Backup Reader has only **TenuVault Backup Writer**. Broader roles for it on the storage account defeat the no-delete design; the script warns about them but does not remove them.
* **Data protection:** blob versioning is on. **Lifecycle management:** one rule that removes previous versions after 30 days (`-VersionRetentionDays`); it never removes current backups.
* **Networking:** if the storage firewall restricts access, the network the TenuVault computer uses must be allowed. The reader connects from that same computer, so an allowed admin computer is also an allowed reader.

### Step 4, you: verify and confirm the first backup

1. Back in TenuVault, enter the application ID and select **Verify**. TenuVault asks Microsoft for a token with the certificate, checks the tenant, the app and its permissions, and records them. It then runs the confidence test: one real Intune read with the reader's token, and for backups in Azure Storage a check that the backup container exists and the reader may use it, with a warning if step 3 has not run yet. The card keeps the result as a checklist (certificate and permissions, read test, storage, last run), and **Test now** reruns it at any time, so tonight's backup does not have to be the first proof. The card also shows the certificate thumbprint exactly as Entra ID and the script print it, with a copy button. New certificates and permissions can take a few minutes to apply, so a refusal right after the scripts usually means "wait and verify again", not a re-run.
2. Wait for the next scheduled backup, or check the backup log of that run: it shows "Reading as the tenant's Backup Reader (app-only, read-only)." Your Entra administrator can usually confirm a successful token request around that time under **Service principal sign-ins**; entries are grouped and a cached token may cover several runs, so a missing new entry alone does not mean the backup did not run app-only. The backup log line above is the reliable sign.
3. Record in your ticket or inventory: tenant, application (client) ID, each computer's certificate thumbprint (shown on the card, same value as in Entra ID) and expiry date, the agreed `-IncludeDeviceCategories` choice, the storage account (if any), and the owner. This list is what a colleague needs for a renewal or an emergency removal when you are away.

## How Backup Reader backups differ

* **Masked values.** Profiles with encrypted OMA-URI values are saved with `****` and listed in the backup's metadata. They count as a warning. Restoring such a profile from that backup is blocked, because it would send `****` to devices. Run a manual backup to capture the values; retention keeps the newest backup that has them in plain text.
* **Left-out types.** Without the device inventory permission, device categories and device clean-up rules are left out and listed as "not readable by the Backup Reader". A change that writes those types needs a backup that has them, which TenuVault makes with your sign-in before the change anyway.
* **Retention in Azure Storage.** The Backup Reader cannot delete, so expired backups stay until the next backup made with your sign-in, which applies retention to all backups of the tenant with the usual protections. Backups on this device follow retention as usual.
* **Audit log.** The tenant audit log is written with your sign-in, so Backup Reader backups do not add an entry there. Each backup records how it ran (`Trigger`, `AuthMode` and `RunId`) in its own metadata. The reader's token requests appear in Entra ID under **Service principal sign-ins**, grouped by Microsoft and not one per backup, because a cached token can serve several runs.
* **License.** A license key keeps working with the Backup Reader alone. A license your organization shared with the tenant is confirmed with your Microsoft sign-in, so sign in to TenuVault at least once every 14 days.

## Renew the certificate

The certificate is valid for one year. From 30 days before it expires, TenuVault shows a reminder on the **Backup Reader** card and, after scheduled backups, a desktop notification once a week. After it expires, scheduled backups use your own sign-in again.

Renewal needs your Entra administrator again, for each computer separately. Start as soon as the reminder appears, so their availability (and a PIM activation) does not become the reason a certificate lapses. The request is the same as in step 2 of the setup, with the renewal file and the reader's application ID.

1. Select **Renew certificate** and save the new certificate.
2. Run the setup script with the new file and the reader's application ID:

   ```powershell
   ./New-TenuVaultBackupReader.ps1 -CertificatePath ./renewal.cer -AppId <application ID>
   ```

   If the reader has the device inventory permission, add `-IncludeDeviceCategories` again: the script sets exactly the permissions you ask for, and every computer using the reader would otherwise stop until it is verified again. The command on the **Backup Reader** card already includes it.

3. Select **Verify**. TenuVault switches to the new certificate once Microsoft accepts it; until then it keeps using the old one, and the expiry reminder stays on. **Verify again** keeps checking the certificate in use, and **Cancel renewal** discards a renewal certificate you did not upload.

Remove the old certificate from the app registration afterwards, in Entra ID > **App registrations** > **TenuVault Backup Reader** > **Certificates & secrets**.

## More than one computer

Each computer that runs scheduled backups has its own certificate. Set up the Backup Reader on each computer, and run the setup script with `-AppId` so all certificates go onto the same app registration, with `-IncludeDeviceCategories` if the reader uses it. The certificate name shows the computer it belongs to.

Your Entra administrator is involved for every additional computer: each one means a saved `.cer` file from that computer and one script run with `-AppId`. Bundle several computers into one request when you can. The Azure half does not change: the storage role belongs to the app registration, not to a computer, so step 3 runs once per tenant and storage account.

## Later changes: who to ask

Keep this list with your setup record. Most later work is small, but almost none of it can be done from TenuVault alone:

| Situation | You | Colleague you need |
| --- | --- | --- |
| Certificate expires within 30 days | **Renew certificate**, save the file, verify after upload | Entra administrator: rerun the reader script with the renewal file and `-AppId`, then remove the old certificate under **Certificates & secrets** |
| New or replacement TenuVault computer | Set up the reader on it, save its certificate | Entra administrator: one script run with `-AppId` for its certificate |
| Computer retired, lost or stolen | Tell your Entra administrator immediately; select **Remove** on the computer if you still have it | Entra administrator: delete that computer's certificate from the app registration. This blocks the lost computer at once and does not affect the others. |
| You now want device categories in scheduled backups (or want them gone) | Agree the change, then **Verify again** on every computer | Entra administrator: rerun the script with (or without) `-IncludeDeviceCategories`. Security approver for adding it, because it exposes the device inventory. |
| TenuVault reports changed or extra permissions | Read the message; do not verify blindly | Entra administrator: check **API permissions** on the app registration, find who changed them, rerun the script to reset them to the read-only list. Then you verify again. |
| Scheduled backups fail with a storage access error | Note the message and time | Azure administrator: check the **TenuVault Backup Writer** assignment on the container, the storage firewall, and whether broader roles were removed or the account was replaced |
| Microsoft refuses the reader with AADSTS53003 | Note the time and the network the computer used | Conditional Access administrator: check the workload identity policy that applies to the Backup Reader |
| Suspicious reader activity | Note backup times that look wrong | Entra or security administrator: review **Service principal sign-ins**, and in an emergency delete the computer's certificate or disable the enterprise application to stop the reader tenant-wide |
| Tenant's backups move to another storage account | Change storage in TenuVault as usual | Azure administrator: run step 3 again against the new account; the reader has no access there until they do |
| Periodic review (for example with your other app registrations) | Confirm which computers still run scheduled backups | Entra administrator: compare the certificates on the registration with that list and remove certificates of computers that no longer exist |

## Remove it

Removal is two halves again: your half in TenuVault, and your colleagues' half in Entra ID and Azure. Doing only your half leaves a working certificate and permissions behind; doing only theirs leaves TenuVault trying a dead reader.

* **On one computer:** you select **Remove** on the **Backup Reader** card. The private key is deleted and scheduled backups use your sign-in again. Signing out of the tenant or removing it from TenuVault deletes the key too. Then ask your Entra administrator to remove that computer's certificate from the app registration (**Certificates & secrets**), identified by the thumbprint in your setup record.
* **Everywhere:** ask your Entra administrator to delete the **TenuVault Backup Reader** app registration in Entra ID, and your Azure administrator to remove the **TenuVault Backup Writer** assignment (and, if you no longer want it, the custom role definition) on the storage account. Then select **Remove** on each computer: until you do, its scheduled backups keep trying the reader and fail with a refusal instead of using your sign-in. Blob versioning and its lifecycle rule can stay; they do not affect other use.
* **Emergency stop:** your Entra administrator can disable the enterprise application or delete a certificate at any time. That stops the reader immediately, tenant-wide or for one computer, without waiting for anyone to open TenuVault. Scheduled backups then fail with a refusal until you select **Remove** or the reader is restored and verified again.

When a computer is retired or lost, remove its certificate from the app registration right away.

## Troubleshooting

| Message | Cause | Fix | Who |
| --- | --- | --- | --- |
| Microsoft refused the Backup Reader (AADSTS700027) | Microsoft does not know the certificate: it was not uploaded, or not yet applied. | Run the setup script with the saved certificate, wait a few minutes and verify again. | Entra administrator runs the script; you verify |
| Microsoft refused the Backup Reader (AADSTS7000222) | The certificate expired. | Renew the certificate. | You renew; Entra administrator uploads it |
| Microsoft refused the Backup Reader (AADSTS53003) | A Conditional Access policy for workload identities blocked it, for example from this network. | Check the policy and the network the computer uses. | Conditional Access administrator |
| The Backup Reader has permissions beyond read-only backup | Someone added a permission, for example a write permission. | Run the setup script again; it removes other permissions. Then verify again. | Entra administrator; you verify |
| The Backup Reader is missing permissions or their admin consent | A permission was removed or consent is missing. | Run the setup script again, then verify again. | Entra administrator; you verify |
| The Backup Reader's Microsoft Graph permissions changed since they were verified | The permissions differ from the last verification, even by a read permission. | Check the change, then select **Verify again**. | Entra administrator confirms the change was intended; you verify |
| Container not found or access denied when writing to Azure Storage | The storage script has not run with `-BackupReaderAppId`, or the role assignment has not applied yet. | Run the storage script with `-BackupReaderAppId` and wait a few minutes. | Azure administrator |

A refusal that retrying cannot fix (an unknown or expired certificate, a missing or disabled app registration, or a workload identity policy) stops that night's backup without retries, notifies you once and tries again at the next scheduled time. Network failures and transient refusals from Microsoft are retried like any other failed scheduled backup.

## Related pages

* [Conditional Access and TenuVault](/security/conditional-access/)
* [Schedule backups](/backups/schedules/)
* [Create a storage account for TenuVault](/getting-started/create-storage-account/#optional-let-the-backup-reader-write-backups): the Azure administrator's half of step 3
* [App registration and delegated permissions](/security/permissions/)
* [Settings](/settings/#backup-reader): where the card and its controls are described
