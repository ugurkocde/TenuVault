---
title: "Backup Reader for scheduled backups"
description: An optional read-only identity that keeps scheduled backups running when Conditional Access session controls end your sign-in.
---

TenuVault normally works only as you, the signed-in admin. When a Conditional Access policy ends your session at night, for example with sign-in frequency, scheduled backups stop until you sign in again. The **Backup Reader** is an optional, read-only identity that only scheduled backups use, so they keep running.

Before you add it, check whether a policy change is simpler: see [Conditional Access and TenuVault](/security/conditional-access/).

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
| Delete or overwrite backups for good | No. It has no delete permission. Blob versioning keeps any blob it overwrites. |
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
* To run the setup script: a **Global Administrator** or **Privileged Role Administrator** (granting application permissions needs one of these roles) and the `Microsoft.Graph.Applications` PowerShell module.
* For backups in Azure: an Azure administrator who can create a custom role and assign it on the storage account's resource group, for example **Owner** or **User Access Administrator**.

## Set it up

1. In TenuVault, open **Settings** > **Background**, find **Backup Reader**, choose the tenant and select **Set up the Backup Reader**.
2. Select **Save certificate**. This saves the public certificate as a `.cer` file.
3. Run the setup script with that file. Copy it with **Copy setup script** or [download it](/downloads/New-TenuVaultBackupReader.ps1):

   ```powershell
   ./New-TenuVaultBackupReader.ps1 -CertificatePath "./TenuVault Backup Reader 1A2B3C4D.cer" -TenantId contoso.onmicrosoft.com
   ```

   It creates the app registration, sets exactly the read permissions, uploads the certificate, grants admin consent and prints the **application (client) ID**.
4. **Backups in Azure Storage only:** an Azure administrator runs the storage script with the reader's application ID:

   ```powershell
   ./New-TenuVaultStorage.ps1 -AdminGroupId <group object ID> -BackupReaderAppId <application ID>
   ```

   It creates the backup container, the **TenuVault Backup Writer** role and its assignment on the container, turns on blob versioning, and adds a lifecycle rule that removes previous blob versions after 30 days (change it with `-VersionRetentionDays`). Current backups are never removed by that rule.
5. Back in TenuVault, enter the application ID and select **Verify**. TenuVault asks Microsoft for a token with the certificate, checks the tenant, the app and its permissions, and records them. New certificates and permissions can take a few minutes to apply.

From the next scheduled backup on, the backup log shows "Reading as the tenant's Backup Reader (app-only, read-only)."

## How Backup Reader backups differ

* **Masked values.** Profiles with encrypted OMA-URI values are saved with `****` and listed in the backup's metadata. They count as a warning. Restoring such a profile from that backup is blocked, because it would send `****` to devices. Run a manual backup to capture the values; retention keeps the newest backup that has them in plain text.
* **Left-out types.** Without the device inventory permission, device categories and device clean-up rules are left out and listed as "not readable by the Backup Reader". A change that writes those types needs a backup that has them, which TenuVault makes with your sign-in before the change anyway.
* **Retention in Azure Storage.** The Backup Reader cannot delete, so expired backups stay until the next backup made with your sign-in, which applies retention to all backups of the tenant with the usual protections. Backups on this device follow retention as usual.
* **Audit log.** The tenant audit log is written with your sign-in, so Backup Reader backups do not add an entry there. Each backup records how it ran (`Trigger`, `AuthMode` and `RunId`) in its own metadata, and the reader's sign-ins appear in Entra ID under **Service principal sign-ins**.
* **License.** A license key keeps working with the Backup Reader alone. A license your organization shared with the tenant is confirmed with your Microsoft sign-in, so sign in to TenuVault at least once every 14 days.

## Renew the certificate

The certificate is valid for one year. From 30 days before it expires, TenuVault shows a reminder on the **Backup Reader** card and, after scheduled backups, a desktop notification once a week. After it expires, scheduled backups use your own sign-in again.

1. Select **Renew certificate** and save the new certificate.
2. Run the setup script with the new file and the reader's application ID:

   ```powershell
   ./New-TenuVaultBackupReader.ps1 -CertificatePath ./renewal.cer -AppId <application ID>
   ```

3. Select **Verify**. TenuVault switches to the new certificate once Microsoft accepts it; until then it keeps using the old one.

Remove the old certificate from the app registration afterwards, in Entra ID > **App registrations** > **TenuVault Backup Reader** > **Certificates & secrets**.

## More than one computer

Each computer that runs scheduled backups has its own certificate. Set up the Backup Reader on each computer, and run the setup script with `-AppId` so all certificates go onto the same app registration. The certificate name shows the computer it belongs to.

## Remove it

* **On one computer:** select **Remove** on the **Backup Reader** card. The private key is deleted and scheduled backups use your sign-in again. Remove the computer's certificate from the app registration too.
* **Everywhere:** delete the **TenuVault Backup Reader** app registration in Entra ID, and the **TenuVault Backup Writer** role assignment on the storage account.

When a computer is retired or lost, remove its certificate from the app registration right away.

## Troubleshooting

| Message | Cause | Fix |
| --- | --- | --- |
| Microsoft refused the Backup Reader (AADSTS700027) | Microsoft does not know the certificate: it was not uploaded, or not yet applied. | Run the setup script with the saved certificate, wait a few minutes and verify again. |
| Microsoft refused the Backup Reader (AADSTS7000222) | The certificate expired. | Renew the certificate. |
| Microsoft refused the Backup Reader (AADSTS53003) | A Conditional Access policy for workload identities blocked it, for example from this network. | Check the policy and the network the computer uses. |
| The Backup Reader has permissions beyond read-only backup | Someone added a permission, for example a write permission. | Run the setup script again; it removes other permissions. Then verify again. |
| The Backup Reader is missing permissions or their admin consent | A permission was removed or consent is missing. | Run the setup script again, then verify again. |
| The Backup Reader's Microsoft Graph permissions changed since they were verified | The permissions differ from the last verification, even by a read permission. | Check the change, then select **Verify again**. |
| Container not found or access denied when writing to Azure Storage | The storage script has not run with `-BackupReaderAppId`, or the role assignment has not applied yet. | Run the storage script with `-BackupReaderAppId` and wait a few minutes. |

A refused Backup Reader stops that night's backup without retries, notifies you once and tries again at the next scheduled time. A network failure is retried like any other scheduled backup.

## Related pages

* [Conditional Access and TenuVault](/security/conditional-access/)
* [Schedule backups](/backups/schedules/)
* [App registration and delegated permissions](/security/permissions/)
