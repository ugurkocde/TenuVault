---
title: "Encryption and recovery key"
description: How TenuVault protects Intune backups on your device and in your Azure storage account, and when you need the recovery key.
---

TenuVault encrypts every backup it keeps on your device. Backups in your own Azure storage account are stored as plain JSON policies: Azure encrypts them at rest, and your Azure role assignments decide who can read them. The recovery key only matters for backups on this device, and for older Azure backups that an earlier TenuVault version encrypted. This page explains what is protected, how, and how to use the recovery key.

## What is encrypted, and how

| Data | Where it lives | Protection |
| --- | --- | --- |
| Backups on this device | The backup folder you choose | AES-256-GCM, with the TenuVault backup key |
| Backups in Azure | The `intune-backups` container in your storage account | Not encrypted by TenuVault. Azure Storage encryption at rest, HTTPS in transit, and your Azure role assignments. See [Backups in Azure](#backups-in-azure). |
| Azure backups made by TenuVault versions before plain Azure backups | The same container | AES-256-GCM with the backup key of the device that made them. See [Older encrypted Azure backups](#older-encrypted-azure-backups). |
| Cloud backups | The `intune-backups` container in your storage account | See [Cloud backups](/backups/cloud/). |
| Cloud backup result notes | `tenuvault-backup-results/cloud-backup-outcomes/` in your storage account | Not encrypted by TenuVault, so the notification watcher can alert without the recovery key. Status, backup folder name, counts, failed type names, run id and time only; no policy content. See [the result note](/backups/cloud/#the-result-note). |
| Audit log and tenant metadata on this device | The backup folder you choose | AES-256-GCM, with the TenuVault backup key |
| Audit log and tenant metadata in Azure | The `audit-logs` and `tenant-metadata` containers | Not encrypted by TenuVault. Protected by your storage account's own encryption and access control. |
| Microsoft token cache | Your user profile | Windows DPAPI or the macOS Keychain |
| Tenant profiles, license key, backup keys and settings | Your user profile | Windows DPAPI or the macOS Keychain |
| Backup ZIP exports | Wherever you save them | Not encrypted. See [ZIP exports are not encrypted](#zip-exports-are-not-encrypted). |

## The backup key

The first time TenuVault needs it, it generates a random 256-bit master key on your machine. The key is stored in TenuVault's encrypted app store, which is protected by your operating system account:

* **Windows:** DPAPI, bound to your Windows user account.
* **macOS:** the Keychain.

Only your user account on this machine can unlock it. Another Windows user, or the same data copied to another machine, cannot read it. That is why you need the recovery key to read backups on this device anywhere else.

If the operating system cannot provide this protection, TenuVault refuses to start rather than store keys or tokens in plain text.

## Backups on this device

When you choose **This device, encrypted** as storage:

* Every backup file is encrypted with AES-256-GCM, which also detects any change to the file.
* File names are derived from a keyed hash, so the folder reveals neither policy names nor content.
* New and rewritten backup files are bound to their tenant folder, so a bound file copied into another tenant's folder cannot be decrypted there. Older files stay readable and are bound when TenuVault next rewrites them.
* The default folder is `TenuVault Backups` in your Documents folder. You can change it under **Settings** > **Storage and recovery** with **Change folder**. Changing the folder does not move existing backups.
* Because the files are encrypted, you can keep the folder on a network share.

If local backup files exist or a tenant uses local storage, **Overview** and **Settings** show a persistent notice until you save the current recovery key. Select **Go to Save recovery key** to reach the export action in Settings. Local backups remain available while the notice is shown. The notice disappears after a successful export.

If TenuVault cannot check the backup folder because access is denied or a drive is offline, Settings still shows the folder and key fingerprint. The recovery notice stays visible until you save the current recovery key, even if TenuVault cannot confirm whether the folder contains backups. You can save the key while the backup folder is unavailable.

## Backups in Azure

When you choose **Your Azure storage account** as storage:

* Each backup file is uploaded as plain JSON over HTTPS. TenuVault does not encrypt it.
* Azure Storage encrypts all data at rest with Microsoft-managed keys, or with your own keys if you configure customer-managed keys on the storage account.
* Your Azure role assignments decide who can read, write and delete backups. Every admin who has access to the storage account sees, compares and restores the same backups from their own machine, with no key to hand over. See [Work with other admins in one tenant](/getting-started/multiple-admins/).
* No recovery key is needed for these backups, and none is asked for when you choose Azure storage.

### Who is trusted

Anyone who can write to the `intune-backups` container is trusted like an Intune admin. TenuVault restores what it finds there, including replacing live policies in place and restoring assignments, so a person who can change a backup file can change what a restore writes to Intune. Treat the blob data roles on the storage account like Intune admin rights:

* Grant **Storage Blob Data Contributor** (or **Storage Blob Data Reader**) only to the security group of your Intune admins. The [storage setup script](/getting-started/create-storage-account/) assigns the roles to one admin group for this reason.
* Keep blob soft delete on, so a deleted or overwritten backup can be recovered. The storage setup script turns on seven days of soft delete for blobs and containers, and blob versioning when you set up the [Backup Reader](/backups/backup-reader/).
* Review the role assignments on the storage account with your other Azure access reviews.

### Secret OMA-URI values

A backup keeps the plain-text values of secret OMA-URI settings (for example Wi-Fi keys or certificate passwords) that Microsoft Graph returns, so a restore can put them back. In Azure these values are readable by everyone who can read the `intune-backups` container. Limit read access to the storage account accordingly. This keeps restores complete: a backup with masked values (`****`) cannot restore those settings.

:::note
The audit log and tenant metadata that TenuVault keeps in Azure are not encrypted by TenuVault either. Control access to them with Azure role assignments on the storage account.
:::

### Older encrypted Azure backups

TenuVault versions before plain Azure backups encrypted each Azure backup file with AES-256-GCM on the device before upload, with that device's backup key. Those backups stay where they are and stay readable:

* On a device that has the key, they open as before, side by side with new plain backups. Retention treats them like any other backup.
* On a device without the key, each of them says "This backup was encrypted by an earlier TenuVault version. Import the recovery key of the device that made it to open it." **Backup & Restore** shows a notice with **Import recovery key** when this tenant's storage account holds such backups. Your other backups keep working, and a backup whose metadata cannot be read is never deleted by retention.
* New backups are always plain, also on a device that has the old key. Nothing is re-encrypted or rewritten.

To open older encrypted backups on a new machine, import the recovery key of the device that made them, as described in [Import a recovery key on another machine](#import-a-recovery-key-on-another-machine).

## The recovery key

The recovery key is a copy of your backup keys. You need it to:

* Read backups on this device from another machine.
* Read backups on this device after reinstalling TenuVault, or after your Windows or macOS user profile is reset.
* Read backups on this device after choosing to start over with empty app data.
* Open Azure backups that an earlier TenuVault version encrypted, on a machine other than the one that made them.

Azure backups made by this version do not need the recovery key.

:::danger
Without the recovery key, backups on this device can only be read on the machine and user account that created them. If that machine or profile is lost, those backups cannot be decrypted by anyone, including TenuVault.
:::

### Save the recovery key

1. Open **Settings** and go to **Storage and recovery**.
2. In **Backups on this device**, under **Encryption key**, click **Save recovery key**.
3. Choose where to save the file. The default name is `TenuVault recovery key <fingerprint>.txt` in your Documents folder.
4. Move the key into your password manager or another secure store, then delete the file.

The file contains the key fingerprint and the recovery key, which starts with `TVK2.`. The saved bundle includes every key this machine has used, so all older backups stay readable. The file itself warns: "Anyone with this key and your backup files can read your Intune configuration."

The **Key fingerprint** shown in Settings is a short, non-secret identifier of the current key. Use it to tell keys apart; it cannot be used to decrypt anything.

### Import a recovery key on another machine

1. Open **Settings** and go to **Storage and recovery**.
2. In **Backups on this device**, click **Import a recovery key**.
3. Paste the key (`TVK2.` bundles and older `TVK1.` keys are accepted) and click **Import**.

The imported key becomes the key for new backups on this device. Keys that were already on the machine are kept, so backups made with them stay readable. Older encrypted Azure backups made with the imported key open as well.

You can also import a key from the notice on **Backup & Restore** that lists older Azure backups this device cannot open.

:::caution
After you import a key, the current key changes. Click **Save recovery key** again to save a bundle that contains all keys.
:::

## ZIP exports are not encrypted

The **Download** button on a backup creates a ZIP file with the backup's content in plain JSON, so you can read or archive it outside TenuVault. Protect these files like any other copy of your Intune configuration. Configuration can include sensitive values, such as the plain-text values of secret OMA-URI settings captured in a backup.

## If TenuVault cannot unlock its data

If the operating system refuses access to TenuVault's encrypted store, for example because a macOS Keychain prompt was denied or the data was created by another Windows user, TenuVault shows **TenuVault cannot unlock its saved data.** with two choices:

* **Quit:** nothing is changed. Fix the cause (allow Keychain access, or start TenuVault as the user who created the data) and start again.
* **Delete backup key and start over:** the unreadable data is kept aside as a backup file and TenuVault starts empty. This deletes the backup encryption key from the active app state, along with your sign-ins and license. Backups on this device become unreadable unless you exported their recovery key, and so do Azure backups that an earlier TenuVault version encrypted with it. Azure backups made by this version stay readable. You sign in to your tenants and activate your license again.

To save the key before starting over, choose **Quit**, restore access to the saved data, then use **Settings** > **Storage and recovery** > **Save recovery key**. An unreadable saved-data copy does not replace an exported recovery key. If you already saved the key, use **Import a recovery key** in the same Settings section after starting over. Starting over leaves the backup files in their folder or Azure storage account.

If a stored backup keyring is malformed, TenuVault reports an error and preserves it instead of creating a replacement key or importing over it. Recover the original `app-state.bin` before continuing.

## What encryption does not protect against

* Someone who has both your backup files on this device and your recovery key can read them. Store the key like a password.
* Azure backups are as private as your storage account's access control. Anyone with a blob data role on it can read them, and anyone who can write to the container can change what a restore writes to Intune.
* A storage administrator can still delete backups or deny access to them. Keep soft delete on and keep independent copies of important backups.
* Once a backup is shown in TenuVault, for example in the restore preview, its content is visible to the signed-in admin.

## Related pages

* [Security and privacy](/security/)
* [Work with other admins in one tenant](/getting-started/multiple-admins/)
* [Choose where backups are stored](/getting-started/choose-storage/)
* [Backup storage and retention](/backups/storage/)
* [Disaster recovery](/restore/disaster-recovery/)
