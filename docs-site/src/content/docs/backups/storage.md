---
title: "Backup storage and retention"
description: Where backups are kept, how to change the location, how long backups are kept, and how to export and import a backup as a ZIP file.
---

Each tenant keeps its backups in one location: encrypted on this device, or encrypted in your own Azure storage account. This page covers both locations, how to change a tenant's location, how long backups are kept, and how to move a backup as a ZIP file.

## Storage locations

| | This device | Your Azure storage account |
| --- | --- | --- |
| Plans | All plans | Pro and MSP |
| Where | A folder on this computer or a network share | A storage account in your Azure subscription |
| Encryption | AES-256-GCM, key protected by Windows or the macOS Keychain | AES-256-GCM before upload, with the same key |
| Readable on another computer | With your recovery key | With your recovery key |
| What you need | Nothing else | The **Storage Blob Data Contributor** role on the storage account, and your recovery key saved |

TenuVault never sends backups to a TenuVault server. For the encryption details and the recovery key, see [Encryption and recovery key](/security/encryption/).

## Backups on this device

By default, backups are stored in the **TenuVault Backups** folder in your Documents folder. Every file is encrypted, and file names reveal nothing about your policies.

To manage the folder, open **Settings**, go to **Storage and recovery** and use the **Backups on this device** card:

* **Folder** shows the current folder.
* **Change folder** lets you pick another folder. A network share works, since the files are encrypted.
* **Open folder** opens the folder in Explorer or Finder.

:::caution
Changing the folder does not move existing backups. Move the folder's contents yourself to keep them visible in TenuVault.
:::

The encryption key is protected by your Windows account or macOS Keychain. Without the recovery key, backups can only be read on this device. Save it with **Save recovery key** on the same card. See [Encryption and recovery key](/security/encryption/).

## Backups in your Azure storage account

Use your own storage account when you want backups off the admin's computer, for example to share them between admins. This needs Pro or MSP.

Before you choose it:

1. Make sure your account has the **Storage Blob Data Contributor** role on the storage account. New role assignments can take a few minutes to apply.
2. If the storage account's firewall restricts networks, allow your computer's public IP address or connect through an allowed network.
3. Save your recovery key in **Settings**. TenuVault does not upload a backup to Azure until you have: "Save your current backup recovery key in Settings before the first encrypted Azure backup."

To choose the storage account:

1. In the storage step of setup, or in **Change storage** (see below), choose **Your Azure storage account, encrypted**.
2. TenuVault lists the storage accounts your account can see, with their resource group and region. Choose one in **Storage account**.
3. Click **Check access**. TenuVault creates the `intune-backups` container if needed and writes and deletes a test file. When it works, the button shows **Access confirmed**.

If the check fails, TenuVault explains why:

| Message | What to do |
| --- | --- |
| "You do not have write access to storage account ..." | Ask an Azure administrator for the **Storage Blob Data Contributor** role on the account |
| "Storage account ... rejected the request from this network." | Allow your computer's public IP address in the storage account's networking settings, or use a network it allows |
| "Storage account ... could not be reached." | Check your network connection and the storage account name |
| "No storage accounts found that your account can see." | Ask an Azure administrator to create one and give you access |

### What is stored in the storage account

| Container | Contents |
| --- | --- |
| `intune-backups` | One folder per backup, named `backup-` and the UTC start time, with one file per object in a folder per type and a `metadata.json` summary |
| `audit-logs` | The tenant's [audit log](/audit-log/), one file per event |

Backup file contents are encrypted before upload. Blob names, which include the type and the object's display name, are not encrypted, so anyone who can list the container can see them. Audit log events are stored as plain JSON.

## Change where a tenant's backups go

1. Open **Settings** and go to the **Sign-in** section.
2. In the **Tenants** card, click **Change storage** next to the tenant.
3. In **Backup storage for** *tenant*, choose the new location. For Azure, choose the storage account and click **Check access**.
4. Click **Save**.

New backups go to the new location. Existing backups stay where they are, and TenuVault lists them only while their location is selected for the tenant.

## Retention

TenuVault deletes old backups automatically so storage does not grow without limit.

To choose how long backups are kept:

1. Open **Settings** and go to **Background and retention**.
2. In **Keep backups for**, choose **7 days**, **14 days**, **30 days**, **60 days**, **90 days**, **180 days**, **365 days** or **Forever**.

The default is 30 days. The setting applies to every tenant on this computer. The **Kept for** field on the **Schedule** tab shows the value that applies to the selected tenant.

How retention works:

* Old backups are deleted at the end of each backup that finished without warnings. A backup that completed with warnings, failed or was incomplete deletes nothing: "Older backups were kept because this backup is incomplete."
* The backup that just finished is never deleted, so at least the newest backup is always kept.
* A backup that left out some types never removes the newest copy of those types. For example, if your daily backups leave out apps, the newest backup that includes apps is kept even after it ages out. The log says "Kept N older backup(s) because they hold the newest copy of types this backup leaves out."
* Retention deletes backup folders only. It does not delete audit log events.

:::caution
Retention applies to every backup in the tenant's storage location, including backups made from other computers. If several admins share one Azure storage account, the shortest retention setting among them wins.
:::

On Community, backups are kept for 30 days at most. A longer setting, or **Forever**, counts as 30 days for Community tenants. Pro and MSP tenants keep what you choose.

## Export a backup as a ZIP file

1. Open **Backup & Restore**, select a backup in the **Backup Timeline**.
2. In **Backup Details**, click **Download**.

TenuVault saves `backup-...zip` with the backup's files, its `metadata.json` and a `tenuvault-manifest.json` that names the source tenant. If any file cannot be read, the download fails instead of producing a partial archive. The download is recorded in the [audit log](/audit-log/).

:::danger
The ZIP file is not encrypted. It holds your Intune configuration in plain JSON, including encrypted OMA-URI values in plain text. Protect it like the configuration itself.
:::

## Import a backup from a ZIP file

You can import a ZIP file exported by TenuVault, for example to restore a backup on another computer. The import stores the backup on this device. It never changes Intune.

1. Open **Settings**, go to **Storage and recovery**, and in **Backups on this device** click **Import backup ZIP**.
2. Choose the ZIP file.
3. TenuVault checks the archive and shows **Review backup archive** with the number of policy snapshots, the source tenant ID, the backup ID and the file's SHA-256 hash.
4. Click **Import locally**.

TenuVault confirms the import and tells you which tenant it belongs to. To see and restore the backup, the tenant must use **This device** as its storage location (see [Change where a tenant's backups go](#change-where-a-tenants-backups-go)). Then open **Backup & Restore** and restore it as usual.

The archive must meet these conditions:

* It is smaller than 32 MiB.
* It was exported by TenuVault and contains `tenuvault-manifest.json` with the source tenant.
* It is a complete backup: it finished without warnings, and every file matches the backup's inventory. Archives with missing, changed or extra files are refused.
* Your license covers the source tenant.
* The same backup is not already on this device.

:::caution
The archive declares its source tenant, but it is not signed. Import only files from a source you trust.
:::
