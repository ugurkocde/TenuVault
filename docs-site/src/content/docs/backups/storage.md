---
title: "Backup storage and retention"
description: Where backups are kept, how to change the location, how long backups are kept, and how to export and import a backup as a ZIP file.
---

Each tenant keeps its backups in one location: encrypted on this device, or in your own Azure storage account, where Azure encrypts them at rest. This page covers both locations, how to change a tenant's location, how long backups are kept, and how to move a backup as a ZIP file.

## Storage locations

| | This device | Your Azure storage account |
| --- | --- | --- |
| Plans | All plans | Pro and MSP |
| Where | A folder on this computer or a network share | A storage account in your Azure subscription |
| Encryption | AES-256-GCM by TenuVault, key protected by Windows or the macOS Keychain | Azure Storage encryption at rest; TenuVault stores plain JSON policies |
| Who can read them | This device, or another computer with your recovery key | Everyone with a blob data role on the storage account, from any computer |
| What you need | Nothing else | The **Storage Blob Data Contributor** role on the storage account |

TenuVault never sends backups to a TenuVault server. For the protection details, who is trusted, and the recovery key, see [Encryption and recovery key](/security/encryption/).

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

### A folder with backups this device cannot read

If the folder already holds backups made with a different key, for example by TenuVault on another computer or before a reinstall, this device cannot read them. The same applies when backup files are damaged, or when files a backup lists are missing. Your other backups stay usable (see [Damaged backup files](#damaged-backup-files)), but nothing in the folder is deleted until this is resolved. To show this up front, TenuVault reads the tenant's backup inventory in the folder, exactly as a backup would, and shows **This folder has backups this device cannot read** on the **Storage** step of tenant setup, on the **Backups on this device** card in **Settings**, and on **All tenants**. **Settings** and **All tenants** show it only for tenants connected on this device, so a shared folder that also holds another device's tenants does not trigger it. The notice offers two ways out:

* **Import recovery key**: paste the recovery key of the installation that made the backups. They become readable, and new backups use that key.
* **Choose another folder**: keep this device's backups in a different, empty folder. The existing backups stay where they are. Use this when the files are damaged and you have no copy to restore them from.

TenuVault reads the inventory again after either action, and the notice disappears from every open page once the folder is readable. The notice is a warning: **Continue** during tenant setup and **Save** in **Settings** > **Change storage** stay available, and new backups to the tenant are still saved. While a backup or retention is writing to the folder, a check that sees the folder change does not warn; the folder is checked again when you open the page again or change the folder or key. If the check does not answer within 15 seconds, for example on an unresponsive network share, no warning is shown and the first backup reports any problem.

### Damaged backup files

A damaged or unreadable file affects only what it belongs to:

* **When TenuVault can tell which backup the file belongs to** (from that backup's manifest, its `metadata.json` or ownership marker, or the file's own name), only that backup becomes **Unavailable**. Backup History still lists it, with the reason, but it cannot be downloaded, compared or restored. Every other backup works as before.
* **When it cannot tell**, for example for a file made with another installation's key, backups with a complete manifest stay usable, because their manifest shows that every one of their files is present and readable. Older backups made before TenuVault recorded the item list in the manifest become **Unavailable**, because none of them can be checked. A backup that is still being written, or that stopped before it wrote its manifest, is shown as running or incomplete as before.
* Backup History shows **Some backups may be missing from this list** above the Backup Timeline, with what is wrong and what to do. TenuVault tells the cases apart:
  * **Another recovery key, or damaged**: no key on this device opens the file. It was most likely made with the recovery key of another device or an earlier installation. **Import recovery key** in the notice imports that key, and the list is read again. If some files still cannot be read, the notice says how many. If the list cannot be read again, it says so; select **Refresh** to try again.
  * **Could not be opened**: the file system refused to read the file, with the error code, such as EACCES. Check the folder's permissions and that a sync app such as OneDrive has downloaded the files, then select **Refresh**.
  * **The same backup items twice**: two files hold the same item, for example after a backup folder was copied in by hand. Keep one copy of each, then select **Refresh**.
  * **Damaged or incomplete**: restore the files from a copy, then select **Refresh**.

  When files are affected for different reasons, the notice says so and lists them by reason. When TenuVault cannot tell the reasons, the notice says the files may have been made with another recovery key or may be damaged, and still offers **Import recovery key**. It also says how many backups in the list are marked **Unavailable**. **Open backup folder** opens the tenant's own folder. **Show file names** lists the first ten files by their encrypted name on disk, so you can find them; these names do not match backup or policy names. The reason an unavailable backup shows also names its affected files. When no backup can be listed, the timeline says "No readable backups found for this tenant".
* **Retention is paused** while any file in the folder is damaged or any backup is unavailable. Nothing in the folder is deleted, and the backup log says why: "Retention is paused." A damaged file may hold the only copy of what an older backup has.
* New backups are still saved.
* Damaged files are never changed or removed by TenuVault. To recover, import the recovery key the files were made with, or restore the damaged files from a copy. A file that cannot be recovered can be removed from the folder by hand. If it belonged to a backup with a manifest, that backup then stays unavailable because its manifest lists a missing file, and you can remove the rest of that backup's folder too.

TenuVault checks each file's header when it reads the inventory. Damage further into a file is found when the file is read, and that read fails with the reason instead of returning damaged content. From then on, that backup is unavailable and retention is paused, as for other damage, also after TenuVault restarts. TenuVault keeps that in `.tenuvault-damaged.json` in the tenant's backup folder, which holds the encrypted file names only, and removes the entry once the file is restored or removed. TenuVault never writes over a damaged file.

## Backups in your Azure storage account

Use your own storage account when you want backups off the admin's computer, for example to share them between admins: every admin with access to the account sees, compares and restores the same backups, with no key to hand over. See [Work with other admins in one tenant](/getting-started/multiple-admins/). This needs Pro or MSP. If no storage account exists yet, [Create a storage account for TenuVault](/getting-started/create-storage-account/) covers the recommended settings, a setup script for your Azure administrator, and the role assignments for your admin group.

Before you choose it:

1. Make sure your account has the **Storage Blob Data Contributor** role on the storage account. New role assignments can take a few minutes to apply.
2. If the storage account's firewall restricts networks, allow your computer's public IP address or connect through an allowed network.

No recovery key is needed for Azure storage. The choice is complete once access is confirmed.

To choose the storage account:

1. In the storage step of setup, or in **Change storage** (see below), choose **Your Azure storage account**.
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

Backup files are plain JSON, protected by Azure encryption at rest and your role assignments. Anyone who can read the container can read them, including the plain-text values of secret OMA-URI settings that a backup keeps so a restore can put them back. Anyone who can write to it is trusted like an Intune admin, because a restore writes what it finds there. Grant blob data roles on the account only to your Intune admin group. Audit log events are stored as plain JSON too. Backups made by earlier TenuVault versions stay encrypted with the key of the device that made them; see [Older encrypted Azure backups](/security/encryption/#older-encrypted-azure-backups).

With the optional [Backup Reader](/backups/backup-reader/), scheduled backups write to `intune-backups` as that read-only app instead of as you. An Azure administrator grants it the custom **TenuVault Backup Writer** role on this container only (read and write, no delete, no container creation) and turns on blob versioning; see [Let the Backup Reader write backups](/getting-started/create-storage-account/#optional-let-the-backup-reader-write-backups). Backup Reader runs write nothing to `audit-logs`; see [Audit log](/audit-log/).

With [cloud backups](/backups/cloud/), a runbook in your own Azure Automation account writes to `intune-backups` as its managed identity with the same writer role, and records each run in a `cloud-backup-status-<tenant>.json` blob in the same container. [Cloud backups](/backups/cloud/) describes how the runbook stores them. Cloud runs also write nothing to `audit-logs`.

## Change where a tenant's backups go

The Schedule tab shows the current location in step 1 and changes it there; the same chooser exists in Settings.

1. Open **Backup & Restore**, then **Schedule**, and click **Change storage** in step 1. Or open **Settings**, go to the **Sign-in** section, and click **Change storage** next to the tenant in the **Tenants** card.
2. In **Backup storage for** *tenant*, choose the new location. For Azure, choose the storage account and click **Check access**.
3. Click **Save**.

New backups go to the new location. Existing backups stay where they are, and TenuVault lists them only while their location is selected for the tenant.

## Retention

TenuVault deletes old backups automatically so storage does not grow without limit.

To choose how long backups are kept:

1. Open **Settings** and go to **Background runner**.
2. In **Keep backups for**, choose **7 days**, **14 days**, **30 days**, **60 days**, **90 days**, **180 days**, **365 days** or **Forever**.

The default is 30 days. The setting applies to every tenant on this computer. The **Kept for** field on the **Schedule** tab shows the value that applies to the selected tenant.

How retention works:

* In Azure storage, a scheduled backup made by the [Backup Reader](/backups/backup-reader/) or by [cloud backups](/backups/cloud/) deletes nothing, because those identities have no delete permission. Expired backups stay until the next backup made with an admin's own sign-in, which then applies retention to all of the tenant's backups with the usual protections. Backups stored on this device are unaffected and follow retention on every run.
* Old backups are deleted at the end of each backup that saved every selected policy. A backup that failed or left policies unsaved deletes nothing: "Older backups were kept because this backup is incomplete." Cleanup itself can add a warning: if the metadata of an older backup cannot be read, for example an Azure backup an earlier TenuVault version encrypted with a key this device does not have, that backup and any backup without a recorded tenant are kept, while other eligible backups are still removed.
* The backup that just finished is never deleted, so at least the newest backup is always kept.
* A backup that left out some types never removes the newest complete copy of those types. For example, if your daily backups leave out apps, the newest backup that includes apps and finished without warnings is kept even after it ages out. A backup that finished with warnings may miss items, so it does not count as holding the newest copy. The log says "Kept N older backup(s) because they hold the newest copy of types this backup leaves out."
* If cancellation or the job deadline arrives after the manifest PUT starts, TenuVault lets that commit finish within its retry limits, stopping requests and retry waits no later than two minutes after the 30 minute deadline. An unfinished commit fails with the job deadline message. A successful commit remains completed. The warning "Retention was interrupted; older backups are cleaned up on the next run" appears only if retention is enabled (more than zero days), every selected item was saved and cancellation or expiry interrupted retention. Runs that never attempted retention do not report that warning. The scheduler records completion instead of spending another retry attempt on a duplicate backup. A failed manifest commit still fails the job.
* A run that fails, is cancelled or times out after it claimed its folder, and before its manifest PUT was sent, writes a manifest with status `Failed` (`Cancelled` when you cancelled it), the trigger, the tenant, what it saved and the error. The write only creates the manifest: it never replaces one that is already there, and it gives up after 30 seconds. It is skipped when the storage itself stopped the run (no response, or repeated 401 or 403 responses). A failed or cancelled backup is never used as a complete backup or as the newest copy of a type, selected items it lists can still be restored one by one, and retention removes it once it is older than the retention period.
* A run that could not record its result, for example because TenuVault was closed or the storage could not be reached, leaves a folder without a manifest. Backup History lists it as incomplete. These folders are left in place regardless of their age or ownership marker. New backup folders contain an ownership marker.
* Backups on this device: while files in the folder are damaged or a backup is unavailable, retention deletes nothing and logs "Retention is paused." with the reason. See [Damaged backup files](#damaged-backup-files).
* Retention deletes backup folders only. It does not delete audit log events.

The `.tenuvault-owner.json` marker records `Source` and `TenantId` before policy uploads. In Azure it is plain JSON like the backup itself, and in a storage account several tenants share, it and `metadata.json` decide which tenant a backup belongs to: each tenant lists, restores and downloads only its own backups. It is excluded from downloaded ZIPs. When the manifest names no tenant, the marker supplies the backup's ownership for the backup list, restore, drift detection and retention; a marker that cannot be read or names no tenant is never treated as a backup without a tenant. Normal retention still requires readable metadata. Storage immutability policies and legal holds still apply. The marker is deleted last during retention of an expired backup so interrupted deletion retains ownership evidence. A marker does not make a folder without a manifest eligible for deletion.

:::caution
Retention applies to every backup in the tenant's storage location, including backups made from other computers. If several admins share one Azure storage account, the shortest retention setting among them wins. See [Work with other admins in one tenant](/getting-started/multiple-admins/).
:::

On Community, backups are kept for 30 days at most. A longer setting, or **Forever**, counts as 30 days for Community tenants. Pro and MSP tenants keep what you choose.

On Community, when the oldest listed backup is at least 23 days old, a line above **Backup Timeline** shows its date, explains removal after the next complete backup and describes longer retention included in TenuVault Pro and MSP.

## Export a backup as a ZIP file

1. Open **Backup & Restore**, select a backup in the **Backup Timeline**.
2. In **Backup Details**, click **Download**.

TenuVault saves `backup-...zip` with the backup's files, its `metadata.json` and a `tenuvault-manifest.json` that names the source tenant. If any file cannot be read, the download fails instead of producing a partial archive. The download is recorded in the [audit log](/audit-log/).

A download is refused before it starts when the backup's files total more than 32 MiB or the backup has more than 5000 files, the same limits that apply to [importing a backup ZIP](#import-a-backup-from-a-zip-file). Restore such a backup from **Backup Details** instead of downloading it, or choose a smaller backup.

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

## Related pages

* [Intune backup](https://www.tenuvault.com/intune-backup): storage options and plans, on the product site
