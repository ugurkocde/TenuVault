---
title: "Backup storage and retention"
description: Where backups are kept, how to change the location, how long backups are kept, and how to export and import backup archives.
---

Each tenant keeps its backups in one location: encrypted on this device, or in your own Azure storage account, where Azure encrypts them at rest. This page covers both locations, how to change a tenant's location, how long backups are kept, and how to move a backup archive.

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

Lab builds use **TenuVault Lab Backups** in Documents by default. If you previously chose a folder in Lab, it stays selected. If Lab and the stable app share a folder, save the Lab recovery key before switching Lab to its own folder. Import that key in the stable app to read the existing Lab backups there.

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

  When files are affected for different reasons, the notice says so and lists them by reason. When TenuVault cannot tell the reasons, the notice says the files may have been made with another recovery key or may be damaged, and still offers **Import recovery key**. It also says how many backups in the list are marked **Unavailable**. **Open backup folder** opens the tenant's own folder. **Details** lists the first ten files by their encrypted name on disk, so you can find them; these names do not match backup or policy names. The reason an unavailable backup shows also names its affected files. When no backup can be listed, the timeline says "No readable backups found for this tenant".
* **Retention is paused** while any file in the folder is damaged or any backup is unavailable. Nothing in the folder is deleted, and the backup log says why: "Retention is paused." A damaged file may hold the only copy of what an older backup has.
* New backups are still saved.
* Damaged files are never changed or removed by TenuVault. To recover, import the recovery key the files were made with, or restore the damaged files from a copy. A file that cannot be recovered can be removed from the folder by hand. If it belonged to a backup with a manifest, that backup then stays unavailable because its manifest lists a missing file, and you can remove the rest of that backup's folder too.

If TenuVault closes during cleanup, it may leave encrypted files in a hidden folder named `.retired-*` inside the backup folder. Refresh Backup History after a minute. TenuVault puts an unambiguous file back when its original path is free and the storage supports hard links. Otherwise it keeps the file and reports interrupted cleanup. To recover it manually, close TenuVault on every device using that folder and copy the backup folder somewhere safe. Find the reported `.retired-` folder and move the encrypted `.tvb` file up one level, keeping its exact name. If that name is already present, preserve both files separately and determine which copy you need before moving either one. Reopen TenuVault and refresh Backup History.

TenuVault checks each file's header when it reads the inventory. Damage further into a file is found when the file is read, and that read fails with the reason instead of returning damaged content. From then on, that backup is unavailable and retention is paused, as for other damage, also after TenuVault restarts. TenuVault keeps that in `.tenuvault-damaged.json` in the tenant's backup folder, which holds the encrypted file names only, and removes the entry once the file is restored or removed. TenuVault never writes over a damaged file.

<figure class="docs-screenshot">
  <a href="/images/screenshots/settings-storage.webp" aria-label="Open full-size screenshot: settings storage">
    <img src="/images/screenshots/settings-storage.webp" alt="Storage and recovery holds the folder, ZIP import and recovery-key controls" width="2880" height="2000" loading="lazy" decoding="async" />
  </a>
  <figcaption>Storage and recovery holds the folder, ZIP import and recovery-key controls. Example local folder; no recovery key is displayed. Select the image to view it full size.</figcaption>
</figure>

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
| `intune-backups-large` | Large backups: claims and manifests under `backup-large-<UTC start time>/`, snapshots and shards under `payload/backup-large-<UTC start time>/` |
| `intune-backups` | One folder per backup, named `backup-` and the UTC start time, with one file per object in a folder per type and a `metadata.json` summary |
| `audit-logs` | The tenant's [audit log](/audit-log/), one file per event |

Ordinary types always use `intune-backups`, including when a run also selects large types. A mixed run saves ordinary snapshots first and a companion `backup-large-...` folder with the same UTC start time and run ID. History shows one backup when reciprocal records name each other, their own folders, the same nonempty run ID and the same tenant. An ownership claim can identify an unfinished half in that row, but only two complete manifests can certify a complete run. Status and coverage combine both halves. A cancelled, running, interrupted, missing or unreadable companion makes the run incomplete, with a reason for each large type. A mismatched link never joins folders. Ordinary snapshots remain available for restore and comparison independently.

**Download** exports a complete mixed run as one uncompressed POSIX tar (archive version 3), containing both original folders, both manifests, ordinary snapshots, large indexes and large snapshots. Import validates fingerprints, reciprocal identity, paths, entry kinds and finite inventory-based allowances before publishing the manifests. The 32 GiB total cap still applies. Ordinary-only backups retain their existing ZIP format and importer. When the companion is incomplete or unreadable, **Download ordinary only** creates a labeled ZIP with no companion dependency. Its imported copy is labeled ordinary-only and holds only the ordinary types.

If the companion is temporarily unavailable, Backup History offers **Download** and **Download ordinary only** side by side. Select **Download** to check storage again and retry the full archive. For backups on this device, wait for the archive save to finish or cancel it before changing the backup folder.

Retention evaluates a verified mixed pair together. It deletes both expired halves only when the current backup covers both, after verifying every file in both inventories. Owned incomplete or missing companions and orphaned halves have an extra 7-day recovery grace after retention. Unreadable or unverified halves stay for manual review. An orphaned large companion is shown as incomplete with recovery guidance. Storage holds or an interrupted deletion can still leave partial files, as with ordinary backups; completion manifests are removed before payloads, so remnants cannot appear as a complete run. Restore the missing half from a trusted archive or keep the surviving snapshots for recovery.

Companion resolution reuses history's already-read manifests and adds zero requests for discovered pairs. After successful discovery, an absent companion is missing without an additional GET. Failed or partial discovery allows at most 8 direct companion manifest GETs per history request, with the rest marked unresolved and the cause shown. No snapshot or shard enumeration is needed. The ordinary 500-folder Azure summary remains 503 requests cold and 3 warm, including authentication and large discovery. A single complete mixed run takes 5 cold Azure summary requests (authentication, two listings, two manifests), or 7 locally with the two container-properties reads.

Ordinary snapshots are published before the large phase starts. Missing, unreadable or unwritable large storage never prevents ordinary capture, history, comparison, retention or restore. If large storage cannot be used, the run counts as unsuccessful and names each unread large type. It shows **Storage not provisioned for large backups** or the storage response and recovery guidance. The ordinary manifest records these in `LargeBackupOutcomes` separately from ordinary coverage. An interrupted large phase leaves the already published ordinary backup usable. Ordinary-only runs never start large discovery or large remnant cleanup. Deleting a verified complete pair verifies the files in both inventories before starting removal.

History omits large entries when large discovery fails and shows a warning with the provisioning step, while returning every ordinary backup. Comparison discovery and change reports use the same rule. A local import containing only large backups works without an ordinary container.

For a Backup Reader provisioned by 0.5.x, ask your Azure administrator to rerun `New-TenuVaultStorage.ps1 -BackupReaderAppId <application ID>` with the usual storage arguments. It provisions `intune-backups-large` and the container-scoped **TenuVault Backup Writer** assignment. Check the identity being used has access to that container. Keep the reader's existing narrow role; a broader Contributor role is unnecessary. See [Storage write access for the Backup Reader](/backups/backup-reader/#step-3-your-azure-administrator-storage-write-access-azure-backups-only).

Backup files are plain JSON, protected by Azure encryption at rest and your role assignments. Anyone who can read the container can read them, including the plain-text values of secret OMA-URI settings that a backup keeps so a restore can put them back. Anyone who can write to it is trusted like an Intune admin, because a restore writes what it finds there. Grant blob data roles on the account only to your Intune admin group. Audit log events are stored as plain JSON too. Backups made by earlier TenuVault versions stay encrypted with the key of the device that made them; see [Older encrypted Azure backups](/security/encryption/#older-encrypted-azure-backups).

With the optional [Backup Reader](/backups/backup-reader/), scheduled backups write to `intune-backups` as that read-only app instead of as you. An Azure administrator grants it the custom **TenuVault Backup Writer** role on the two backup containers (read and write, no delete, no container creation) and turns on blob versioning; see [Let the Backup Reader write backups](/getting-started/create-storage-account/#optional-let-the-backup-reader-write-backups). The current Backup Reader records terminal events in `audit-logs` after you apply the audit writer grant. Earlier Reader versions did not write those events. See [Audit log](/audit-log/).

With [cloud backups](/backups/cloud/), a runbook in your own Azure Automation account writes to `intune-backups` as its managed identity with the same writer role, and records each run in a `cloud-backup-status-<tenant>.json` blob in the same container. [Cloud backups](/backups/cloud/) describes how the runbook stores them. Cloud runbook 1.5.0 and later record terminal events in `audit-logs` with the audit writer grant. Older runbooks write backup files and status only.

## Change where a tenant's backups go

The Schedule tab shows the current location in step 1 and changes it there; the same chooser exists in Settings.

1. Open **Backup & Restore**, then **Schedule**, and click **Change storage** in step 1. Or open **Settings**, go to the **Sign-in** section, and click **Change storage** next to the tenant in the **Tenants** card.
2. In **Backup storage for** *tenant*, choose the new location. For Azure, choose the storage account and click **Check access**.
3. Click **Save**.

New backups go to the new location. Existing backups stay where they are, and TenuVault lists them only while their location is selected for the tenant.

The **TenuVault Backup Writer** role can overwrite existing blobs in `intune-backups`. The storage owner chooses whether to enable blob versioning or apply an immutability policy. The separate audit writer grant permits read and create on the audit container.

### TenuVault Lab folders

If an earlier Lab build used the stable backup folder, Lab can still browse it. Backups, archive imports and retention use a separate folder. Choose a destination outside the stable backup folder for downloads and exports. Archive saves require a new filename. In **Settings > Storage and recovery**, choose **Use the TenuVault Lab Backups folder**. If the profile has a Lab-created recovery key that only Lab used to save backups, you can choose **Copy verified Lab backups**. Lab checks the copied files and leaves the originals where they are. Unreadable files and conflicting copies are reported.

## Retention

TenuVault deletes old backups automatically so storage does not grow without limit.

To choose how long backups are kept:

1. Open **Settings** and go to **Background runner**.
2. In **Keep backups for**, choose **7 days**, **14 days**, **30 days**, **60 days**, **90 days**, **180 days**, **365 days** or **Forever**.

The default is 30 days. The setting applies to every tenant on this computer. The **Kept for** field on the **Schedule** tab shows the value that applies to the selected tenant.

How retention works:

* In Azure storage, a scheduled backup made by the [Backup Reader](/backups/backup-reader/) or by [cloud backups](/backups/cloud/) deletes nothing, because those identities have no delete permission. Expired backups stay until the next backup made with an admin's own sign-in, which then applies retention to all of the tenant's backups with the usual protections. Backups stored on this device are unaffected and follow retention on every run.
* Cleanup runs after a complete backup. Before deleting an expired backup, TenuVault checks that newer backups cover the same policy types and that every referenced policy, inventory index and relationship shard is present and readable. Local encrypted payloads must authenticate. Each policy must match the identity and fingerprints in its manifest. A mismatch stops cleanup and appears in the backup log.
* The backup that just finished is always kept. The newest verified copy of each policy type is also kept, even when later backups leave that type out.
* Azure cleanup limits how many folders it reviews per run and budgets requests and bytes for each candidate separately. A later run can resume verified work when Azure still reports the same file versions. When verification cannot finish, cleanup keeps that backup and can still remove independently verified candidates. After repeated failures, the backup results ask you to review the affected backup.
* If cancellation or the job deadline arrives after the manifest PUT starts, TenuVault lets that commit finish within its retry limits, stopping requests and retry waits no later than two minutes after the 30 minute deadline. An unfinished commit fails with the job deadline message. A successful commit remains completed. The warning "Retention was interrupted; older backups are cleaned up on the next run" appears only if retention is enabled (more than zero days), every selected item was saved and cancellation or expiry interrupted retention. Runs that never attempted retention do not report that warning. The scheduler records completion instead of spending another retry attempt on a duplicate backup. A failed manifest commit still fails the job.
* A run that fails, is cancelled or times out after it claimed its folder, and before its manifest PUT was sent, writes a manifest with status `Failed` (`Cancelled` when you cancelled it), the trigger, the tenant, what it saved and the error. The write only creates the manifest: it never replaces one that is already there, and it gives up after 30 seconds. It is skipped when the storage itself stopped the run (no response, or repeated 401 or 403 responses). A failed or cancelled backup is never used as a complete backup or as the newest copy of a type, selected items it lists can still be restored one by one, and retention removes it once it is older than the retention period.
* A run that could not record its result, for example because TenuVault was closed or the storage could not be reached, leaves a folder without a manifest. Backup History lists it as incomplete. Eligible remnants are verified before removal after the tenant's retention period plus a 7-day recovery grace. An ordinary remnant without a 0.6 run record or large companion stays in place. New backup folders contain an ownership marker; a tenant label alone does not prove that a remnant belongs to TenuVault.
* Backups on this device: while files in the folder are damaged or a backup is unavailable, retention deletes nothing and logs "Retention is paused." with the reason. See [Damaged backup files](#damaged-backup-files).
* In Azure, TenuVault removes payloads before their manifests. If a file changes during cleanup, TenuVault keeps the rest of that backup, reports any partial removal in the backup log, and proceeds with other eligible backups.
* Retention deletes backup folders only. It does not delete audit log events.

A backup that also holds Entra ID directory objects writes its `metadata.json` early and replaces it when the run ends. When an immutability policy or legal hold refuses that replacement, TenuVault creates a `run-status.json` beside it with the run's final result instead. Backup history, restore and downloads then use that result, so the backup stays usable and exports in full. Downloads leave the file itself out. A permission refusal is not treated this way: the backup fails.

The `.tenuvault-owner.json` marker records `Source` and `TenantId` before policy uploads. In Azure it is plain JSON like the backup itself, and in a storage account several tenants share, it and `metadata.json` decide which tenant a backup belongs to: each tenant lists, restores and downloads only its own backups. It is excluded from downloaded ZIPs. When the manifest names no tenant, the marker supplies the backup's ownership for the backup list, restore, drift detection and retention; a marker that cannot be read or names no tenant is never treated as a backup without a tenant. Normal retention of complete backups still requires readable metadata. Remnant cleanup also accepts a consistent app ownership claim when a manifest is missing. Storage immutability policies and legal holds still apply. The marker is deleted last during retention of an expired backup so interrupted deletion retains ownership evidence. An unfinished ordinary folder also needs a matching 0.6 run record or a large companion link before it qualifies for cleanup.

### Recovery grace and remnant cleanup

For both device and Azure storage, TenuVault removes eligible owned remnants once they are older than the tenant's retention period plus **7 days**. Before deleting the first file of an expired backup or remnant, TenuVault reads every file and authenticates encrypted contents with the available keys. Files it cannot verify keep the whole candidate in place and produce a warning. This includes incomplete or cancelled mixed runs, crashes without a manifest, missing or mismatched companions, orphaned large halves and interrupted deletions. A valid complete run still inside retention is protected. Ordinary backups with a readable manifest and no companion keep their existing retention behavior. **Forever** deletes nothing.

Cleanup requires an app ownership claim for this tenant that agrees with the manifest when one exists. Missing, forged, conflicting or foreign claims never authorize automatic deletion. The backup log reports deleted and retained half counts and bytes, including remnants kept for manual review. Claims are removed last, so the next eligible pass can finish an interrupted deletion. Azure immutability and legal holds still win.

Backup History shows a short remnant notice with known storage costs and recovery guidance. For an unfinished large half with no size manifest, it explicitly says that the full payload cost is unavailable; inspect storage for the total. Recover needed files during the grace period. Check ownership before manually removing unverified remnants. Large cleanup runs only when large storage is used; an ordinary-only backup does not enumerate the large container for retention.

:::caution
Retention applies to every backup in the tenant's storage location, including backups made from other computers. If several admins share one Azure storage account, the shortest retention setting among them wins. See [Work with other admins in one tenant](/getting-started/multiple-admins/).
:::

On Community, backups are kept for 30 days at most. A longer setting, or **Forever**, counts as 30 days for Community tenants. Pro and MSP tenants keep what you choose.

On Community, when the oldest listed backup is at least 23 days old, a line above **Backup Timeline** shows its date, explains removal after the next complete backup and describes longer retention included in TenuVault Pro and MSP.

## Export a backup as a ZIP file

1. Open **Backup & Restore**, select a backup in the **Backup Timeline**.
2. In **Backup Details**, click **Download**.

TenuVault saves `backup-...zip` with the backup's files, its `metadata.json` and a `tenuvault-manifest.json` that names the source tenant. If any file cannot be read, the download fails instead of producing a partial archive. The download is recorded in the [audit log](/audit-log/).

A ZIP download is refused before it starts when the backup's files total more than 128 MiB, one file exceeds 32 MiB, or the backup has more than 60,000 files, the total-size and file-count bounds that also apply to [importing a backup ZIP](#import-a-backup-from-a-zip-file). ZIP imports additionally cap expanded JSON at 8 MiB per file. Restore such a backup from **Backup Details** instead of downloading it, or choose a smaller backup.

:::danger
The ZIP file is not encrypted. It holds the backed-up tenant configuration in plain JSON, including encrypted OMA-URI values in plain text. Protect it like the configuration itself.
:::

## Import a backup from a ZIP file

You can import a ZIP file exported by TenuVault, for example to restore a backup on another computer. The import stores the backup on this device. It never changes Intune.

1. Open **Settings**, go to **Storage and recovery**, and in **Backups on this device** click **Import backup archive**.
2. Choose the ZIP file.
3. TenuVault checks the archive and shows **Review backup archive** with the number of policy snapshots, the source tenant ID, the backup ID and the file's SHA-256 hash.
4. Click **Import locally**.

TenuVault confirms the import and tells you which tenant it belongs to. To see and restore the backup, the tenant must use **This device** as its storage location (see [Change where a tenant's backups go](#change-where-a-tenants-backups-go)). Then open **Backup & Restore** and restore it as usual.

The archive must meet these conditions:

* A ZIP archive is at most 128 MiB, with at most 60,000 entries and at most 8 MiB of expanded JSON per file.
* It was exported by TenuVault and contains `tenuvault-manifest.json` with the source tenant.
* It is a complete backup: it finished without warnings, and every file matches the backup's inventory. Archives with missing, changed or extra files are refused.
* Your license covers the source tenant.
* The same backup is not already on this device.

:::caution
The archive declares its source tenant, but it is not signed. Import only files from a source you trust.
:::

## Large tenants

Opt-in group and device inventory uses streaming storage. Entra ID configuration (including Conditional Access) and Intune types use the ordinary snapshot format. Directory areas remain off until explicitly enabled.

Large inventories write each Graph page as it arrives, with at most 1,000 objects per page and 16 snapshot uploads in flight. Their fingerprints are sorted into index shards of at most 1,000 objects. The summary contains only the count, shard count and completeness per type. Listing a backup and deciding retention do not read an ever-growing item manifest. Before streaming starts, a small run descriptor is stored atomically inside the ownership marker. Large backups use a separate `intune-backups-large` container in Azure and the encrypted local store. Their create-only ownership claim and final `metadata.json` live under `backup-large-<UTC start time>/`; all large snapshots, indexes and relationship shards live under `payload/backup-large-<UTC start time>/`. Ordinary types from the same run stay in `intune-backups`, joined to the large folder by validated reciprocal links and shown as one history row. One listing of the `backup-large-` prefix discovers their root records without reaching any payload, including while a run is running and after a crash. A descriptor never supplies completion status; a readable final manifest does. Ordinary and older backups keep their paths in `intune-backups` and their original flat summary listing and metadata cache. History adds one discovery listing, plus one container-properties request on local storage, independent of ordinary folder count and large object count. Discovery paginates when the number of large runs exceeds a storage listing page. Rerun `New-TenuVaultStorage.ps1` with the Backup Reader option to provision both containers and its read/write role on each before using large captures with that identity. Membership relationships use separate sorted ID shards, with a count, fingerprint and completeness marker on the parent. Definition sub-collections use sorted object shards with the same markers and an 8 KiB bound per definition; they are never collected into one resident array. Encrypted temporary files hold the merge runs while sorting, using a random key held only in memory; successful, failed and cancelled runs remove them. A process crash can leave unreadable ciphertext for operating-system cleanup.

The current bounds are 500,000 objects per large type, 500,000 IDs per relationship, 250,000 Graph GET attempts or two hours per large type (including uploads and sorting), and eight hours per large backup. The existing capture phase keeps its 30-minute bound. Throttles pause the requesting service only, and a requested pause longer than five minutes ends the type. A budget or expired continuation token ends that type with incomplete coverage, while other types continue. There is no automatic continuation after a crash: the abandoned folder has no completion manifest and a new run starts from the beginning. Incomplete large backups never remove older coverage.

**Backup Details** and the restore picker browse one index shard per large type at a time. Search and selection apply to the visible page; the preview does not expand membership lists. The [individual directory review](/restore/identity/#groups) supports eligible cloud security group metadata, membership and owner changes. Exact member removal is blocked for Conditional Access targeted groups because membership changes can affect policy enforcement; remove those members in Microsoft Entra. Each change needs individual approval and must pass the documented safety checks. Other directory operations remain blocked. **Drift Detection** compares inventory fingerprints on demand, checking at most 1,000 identities and returning at most 200 changes per window. Policy change totals do not include the separately paged inventory.

### Large archives

**Download** saves a large backup as an uncompressed POSIX `.tar` archive (ustar with bounded extended path records for long Unicode policy names) through a native save dialog. It streams directly to disk and publishes the chosen file only after every indexed file has been read and verified. Tar supports more than 60,000 files and avoids compression expansion bombs. Other backups continue to export as ZIP; older TenuVault ZIP exports still import.

Use **Settings**, **Storage and recovery**, **Import backup archive** to choose either format. Large archives must contain the exact canonical inventory order. Review checks every snapshot fingerprint and relationship fingerprint before confirmation; import validates the source again, checks its digest, encrypts the files locally and writes the completion manifest last. A failed import removes its own files. Source identity is declared, not signed.

Large import limits follow the validated inventory: two manifest records, one file per object, the declared index shards, and the relationship shards declared in fingerprinted snapshots, never more than five million files. The size allowance starts at 128 MiB plus 64 KiB per object and adds at most 8 MiB plus one tar header per relationship shard, never more than 32 GiB overall or 8 MiB per file. Relationship counts, shard contents and fingerprints must all agree. Traversal, duplicate paths, links, special entries, extra files, missing files, invalid counts and truncated content are refused. Archive limits remain finite even for a hostile manifest. Tar downloads are plain JSON, just like ZIP exports; protect them with the same access controls as the backup.

### Reproduce the scale check

Run `node scripts/measure-large-backup.mjs` from the repository. It generates 100,000 synthetic users, 20,000 synthetic groups including one with 50,000 members, and 30,000 synthetic enterprise apps through a local HTTP Graph fixture. Each object carries a 1 KiB payload; every thousandth request is throttled for one second. No Microsoft tenant is contacted. The script exercises the desktop engine and encrypted local storage, records process RSS every 20 ms, checks `uptime` before and after capture, and writes a JSON report in the operating system temporary folder. `TV_MEASURE_OUTPUT` chooses another report path; `TV_MEASURE_KEEP=1` preserves the encrypted backup. The script is separate from `npm test`.

Measured on 16 November 2026 using an Apple M5 MacBook Air, 10 CPU cores, 24 GiB RAM, Darwin 27.2.0, Node v26.7.0 (`MacBook-Air-UK.local`), against encrypted local storage:

| Measurement | Result |
| --- | --- |
| Synthetic objects | 100,000 users, 20,000 groups, 30,000 enterprise apps |
| Largest membership | 50,000 IDs |
| Wall time | 1,103.432 seconds (18 minutes 23.4 seconds) |
| Peak capture-process RSS | 415,989,760 bytes (396.72 MiB), below 1 GiB |
| Graph requests | 20,223, including 20 throttles |
| Stored encrypted bytes | 232,653,471 bytes (221.88 MiB) |
| Stored files | 150,202 |
| Result | Completed, complete coverage |
| Load average before, 1/5/15 minutes | 3.49 / 7.40 / 7.40 |
| Load average after, 1/5/15 minutes | 5.35 / 7.31 / 8.63 |

The machine was shared with other sessions and test/build work, with higher load during parts of the run. RSS includes the HTTP fixture and capture engine in the same Node process; this is not an Electron window or a live Azure throughput measurement. The synthetic capture uses test-only type descriptors, not directory backup types. An optional disk probe, `TV_TEST_LARGE_IMPORT=1 npx vitest run test/large-archive.test.ts -t "more than 60000"`, also verified export, review and encrypted local import of 60,001 snapshots in an archive larger than 128 MiB. This disk probe is not enabled by `npm test`. The first sequential-upload prototype ended at its per-type budgets and recorded incomplete coverage; the successful run uses 16 bounded uploads. Real Graph latency, policy sizes, relationship counts, storage latency and computer sleep can change completion time. Large inventories with unattributed encrypted-file damage are conservatively unavailable until that damage is resolved.

### Directory types at scale

Run `TV_MEASURE_DIRECTORY=1 TV_MEASURE_OUTPUT=docs/directory-tenant-measurement.json node scripts/measure-large-backup.mjs` to reproduce the expanded Entra lab benchmark with all seven directory types. Stable captures group and device inventory. `TV_MEASURE_SCALE=0.001` selects a smaller workload for a quick check. The full measurement completed on 17 November 2026 on the same Apple M5 machine described above:

| Measurement | Result |
| --- | --- |
| Directory objects | 100,000 users, 20,000 groups, 30,000 enterprise apps, 1,000 app registrations, 500 grants, 500 devices, 100 contacts |
| Largest membership | 50,000 IDs |
| Capture wall time | 2,729.102 seconds (45 minutes 29.1 seconds) |
| Peak process RSS across capture and archive round trip | 659,079,168 bytes (628.55 MiB), below 1 GiB |
| Graph requests | 303,511, including 303 one-second throttles |
| Stored encrypted bytes in the large container | 407,349,080 bytes (388.48 MiB), 152,306 files |
| Verified tar download | 440,135,680 bytes, 28.123 seconds |
| Archive review and encrypted local import | 1,026.835 seconds (17 minutes 6.8 seconds) |
| Paged comparison after import | 152,100 unchanged objects, 154 windows, 0.303 seconds |
| Result | Completed, complete coverage, no comparison changes |
| Load average before, 1/5/15 minutes | 5.26 / 5.69 / 6.12 |
| Load average after, 1/5/15 minutes | 3.39 / 3.37 / 3.69 |

Users, groups, app registrations and enterprise apps carry 1 KiB of synthetic allowlisted text. The fixture supplies manager IDs and the large group membership; other relationship lists are empty, but every declared relationship endpoint is requested. This measures full object volume and request fan-out, not a worst case for every relationship or definition size. The same Node process hosts the HTTP fixture, capture engine, verified tar download, review, import and paged comparison. This measurement selects directory types only, so the run has no ordinary companion and the size covers the complete selected backup. These are encrypted local disk measurements, not live Graph or Azure throughput guarantees. A tenant with more relationships can reach the per-type GET or time allowance and will report incomplete coverage.

## Related pages

* [Intune backup](https://www.tenuvault.com/intune-backup): storage options and plans, on the product site
