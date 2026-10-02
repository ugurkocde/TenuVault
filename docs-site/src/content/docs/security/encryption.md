---
title: "Encryption and recovery key"
description: How TenuVault encrypts your backups and local data, and how to keep your recovery key safe.
---

TenuVault encrypts every backup on your machine before it is written to disk or uploaded to Azure. The encryption key never leaves your machine unless you save the recovery key yourself. This page explains what is encrypted, with which keys, and how to use the recovery key.

## What is encrypted, and how

| Data | Where it lives | Protection |
| --- | --- | --- |
| Backups on this device | The backup folder you choose | AES-256-GCM, with the TenuVault backup key |
| Backups in Azure | The `intune-backups` container in your storage account | AES-256-GCM on your machine before upload, with the same backup key |
| Audit log and tenant metadata on this device | The backup folder you choose | AES-256-GCM, with the TenuVault backup key |
| Audit log and tenant metadata in Azure | The `audit-logs` and `tenant-metadata` containers | Not encrypted by TenuVault. Protected by your storage account's own encryption and access control. |
| Microsoft token cache | Your user profile | Windows DPAPI or the macOS Keychain |
| Tenant profiles, license key, backup keys and settings | Your user profile | Windows DPAPI or the macOS Keychain |
| Backup ZIP exports | Wherever you save them | Not encrypted. See [ZIP exports are not encrypted](#zip-exports-are-not-encrypted). |

## The backup key

The first time TenuVault needs it, it generates a random 256-bit master key on your machine. The key is stored in TenuVault's encrypted app store, which is protected by your operating system account:

* **Windows:** DPAPI, bound to your Windows user account.
* **macOS:** the Keychain.

Only your user account on this machine can unlock it. Another Windows user, or the same data copied to another machine, cannot read it. That is why you need the recovery key to read your backups anywhere else.

If the operating system cannot provide this protection, TenuVault refuses to start rather than store keys or tokens in plain text.

## Backups on this device

When you choose **This device, encrypted** as storage:

* Every backup file is encrypted with AES-256-GCM, which also detects any change to the file.
* File names are derived from a keyed hash, so the folder reveals neither policy names nor content.
* The default folder is `TenuVault Backups` in your Documents folder. You can change it under **Settings** > **Storage and recovery** with **Change folder**. Changing the folder does not move existing backups.
* Because the files are encrypted, you can keep the folder on a network share.

## Backups in Azure

When you choose **Your Azure storage account, encrypted** as storage:

* Each backup file is encrypted with AES-256-GCM on your machine before it is uploaded. Microsoft and anyone with access to the storage account see only ciphertext.
* The encryption binds each file to its tenant, storage account and full file path. A file that is copied to another location or changed in any way fails verification and is not used for a restore.
* TenuVault blocks uploads until you have saved the current recovery key. If you try to back up first, TenuVault shows: "Save your current backup recovery key in Settings before the first encrypted Azure backup."
* Azure Storage's own server-side encryption still applies, but it cannot replace your recovery key: without the key, TenuVault cannot read the backups.

:::note
The audit log and tenant metadata that TenuVault keeps in Azure are not encrypted by TenuVault. Control access to them with Azure role assignments on the storage account.
:::

## The recovery key

The recovery key is a copy of your backup keys. You need it to:

* Read your backups on another machine.
* Read your backups after reinstalling TenuVault, or after your Windows or macOS user profile is reset.
* Share Azure backups with another admin's machine.

:::danger
Without the recovery key, backups can only be read on the machine and user account that created them. If that machine or profile is lost, the backups cannot be decrypted by anyone, including TenuVault.
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

The imported key becomes the key for new backups. Keys that were already on the machine are kept, so backups made with them stay readable.

:::caution
After you import a key, the current key changes. Click **Save recovery key** again to save a bundle that contains all keys. If you store backups in Azure, TenuVault blocks new uploads until you save this new bundle.
:::

## ZIP exports are not encrypted

The **Download** button on a backup creates a ZIP file with the backup's content in plain JSON, so you can read or archive it outside TenuVault. Protect these files like any other copy of your Intune configuration. Configuration can include sensitive values, such as the plain-text values of secret OMA-URI settings captured in a backup.

## If TenuVault cannot unlock its data

If the operating system refuses access to TenuVault's encrypted store, for example because a macOS Keychain prompt was denied or the data was created by another Windows user, TenuVault shows **TenuVault cannot unlock its saved data.** with two choices:

* **Quit:** nothing is changed. Fix the cause (allow Keychain access, or start TenuVault as the user who created the data) and start again.
* **Start over:** the unreadable data is kept aside as a backup file and TenuVault starts empty. You sign in to your tenants and activate your license again. To read existing backups, import your recovery key.

## What encryption does not protect against

* Someone who has both your backup files and your recovery key can read your backups. Store the key like a password.
* A storage administrator can still delete backups or deny access to them. Keep independent copies of important backups.
* Once a backup is decrypted and shown in TenuVault, for example in the restore preview, its content is visible to the signed-in admin.

## Related pages

* [Security and privacy](/security/)
* [Choose where backups are stored](/getting-started/choose-storage/)
* [Backup storage and retention](/backups/storage/)
* [Disaster recovery](/restore/disaster-recovery/)
