---
title: "Run a configuration backup"
description: "Back up Defender, Entra ID and Intune configuration on your device or in your own Azure storage account."
faq:
  - question: "How do I back up Microsoft tenant configuration?"
    answer: "In TenuVault, select the tenant, open Backup & Restore and click Run Backup. Keep the saved backup choice or change it, then click Start backup. TenuVault saves supported configuration for the services and areas in your backup choice."
  - question: "What does a configuration backup include?"
    answer: "TenuVault covers 17 Defender types, 77 Entra ID types including Conditional Access, and 41 Intune types. The backup includes the services and areas you enable and the types you select. App installer content is captured separately with App Backup."
  - question: "Does Microsoft Intune have a built-in backup?"
    answer: "No. Intune has no native backup, point-in-time restore or recycle bin for policies, so a deleted or changed policy cannot be recovered from the Intune portal. A backup tool such as TenuVault saves the configuration through Microsoft Graph before something goes wrong."
  - question: "Where are configuration backups stored?"
    answer: "On every plan, backups are encrypted with AES-256-GCM and stored in a local folder or on a network share. On Pro and MSP they can go to your own Azure storage account instead, where Azure encrypts them at rest and your role assignments decide which admins can read them. Backups are never sent to a TenuVault server."
  - question: "How often should I run a backup?"
    answer: "On a schedule, so a recent backup always exists before you need it. Community includes manual and weekly scheduled backups. Pro and MSP add daily schedules. Also run a manual backup before any large policy change."
---

A configuration backup captures the selected Defender, Entra ID and Intune policies and settings that TenuVault can read at run time. Use **Backup & Restore** to choose what to back up, follow the run and check its coverage before relying on it for recovery.

## How a backup works

TenuVault uses your signed-in account for manual backups. It saves each supported object as its own file, with assignment references where supported, in a new backup folder named after the start time in UTC, for example `backup-2026-09-28-020000`. When all objects are read, it writes a summary with the item counts, the result and a fingerprint of every item, which later lets TenuVault [compare backups](/backups/compare/).

Backups go to the storage you chose for the tenant: encrypted on this device, or in your own Azure storage account, which every admin with access shares. See [Backup storage and retention](/backups/storage/).

For the full list of object types, see [What gets backed up](/backups/coverage/).

To retrieve supported Win32 installer content from Intune, use [free App Backup](/apps/app-backup/) on an enrolled Windows PC. Its encrypted installer store is separate from configuration backup storage and remains accessible while signed out. Capture requires no local installer file.

## Browse backups by service

Below **Backup & Restore**, the sidebar's **Services** group lists **Defender**, **Entra ID** and **Intune**. Select an enabled service to open this page filtered to its policies. A service marked **Off** opens **Settings > Services and permissions** instead. While service status is loading or unavailable, each link opens filtered backup contents without an **Off** badge. Only a confirmed off service opens Settings.

The **Service** filter offers **All**, **Defender**, **Entra ID** and **Intune**. It narrows **Contents**, **Trends by policy type**, large inventory and the **Restore** type lists. Backup contents group the areas under their services. Conditional Access appears under Entra ID and keeps its own backup switch. If only Conditional Access is on, the Entra ID sidebar link still opens backup contents. The filter stays in the page address across reloads, tab changes and back/forward navigation. Choose **All** to clear the highlighted sidebar service. An unknown service in an address shows All.

The timeline, totals, downloads and **Run Backup** still cover the whole backup. This view does not change the tenant's saved backup scope or which services new backups include. Turn services on or off in Settings.

![Entra ID selected in the sidebar and the backup Service filter](/images/sidebar/entra-active-light.png)

## Before you start

* You are signed in to the tenant. See [Sign in to your tenant](/getting-started/connect-tenant/).
* Your license covers the tenant. A tenant that is not licensed is not backed up.
* The tenant has a storage location. If not, TenuVault asks you to "Choose where backups for this tenant are stored in Settings first."
* For backups to your Azure storage account: the tenant is on Pro or MSP, and your account has the **Storage Blob Data Contributor** role on the storage account. No recovery key is needed. See [Encryption and recovery key](/security/encryption/).

## Start a backup

1. Select the tenant in the tenant switcher.
2. Open **Backup & Restore** in the sidebar.
3. Click **Run Backup**. The **Back up** dialog opens with the tenant's saved backup choice selected.
4. Keep the choice or change it (see [Choose what to back up](#choose-what-to-back-up)).
5. Click **Start backup**.

The **Backup Progress** dialog opens. See [Follow a running backup](#follow-a-running-backup).

You can also start a backup from other places:

| Where | Button | What happens |
| --- | --- | --- |
| **Dashboard** | **Run Backup** | Opens Backup & Restore |
| **All tenants** | **Back up now** on a tenant card | Opens the **Back up** dialog; progress appears in the lower right corner |
| **Tenants** | **Backup Now** on a card, or the backup button in the list view | Opens the **Back up** dialog, then **Backup Progress** |
| **Tenants** | **Backup Selected** (MSP) | Backs up every selected tenant with its saved choice, after you confirm |
| Menu bar icon on macOS or tray icon on Windows | **Back up all tenants now** | Backs up every connected tenant with its saved choice. See [Schedule backups](/backups/schedules/#the-menu-bar-or-tray-icon). |

TenuVault runs one backup per tenant at a time. If you start a backup while one is already running for the same tenant, you follow the running one. Each backup also claims its folder before writing any policy, so a backup from another computer or an automation run that starts in the same second cannot write into the same folder. The second backup fails without writing anything, and its error names the folder that was already in use.

## Choose what to back up

The **Back up** dialog offers three choices:

| Choice | What it covers |
| --- | --- |
| **Everything except apps** | Every enabled type except Intune app details. App categories, policy sets, app configuration and app protection policies are still included. |
| **Everything** | "Also app details and assignments. Installer files are never included." Every supported type of the services and opt-in areas that are on. |
| **Custom** | "Choose areas and individual types." |

With **Custom**, TenuVault lists the areas under Defender, Entra ID and Intune, in that order. Tick an area to include all of its types, or expand it to tick individual types. When the tenant has an earlier backup, each area and type shows how many items it held last time, and the dialog estimates the total number of items.

The line under the choices shows how many of the available types the backup covers, grouped by service and area. **Start backup** is unavailable until at least one type is ticked ("Choose at least one type.").

When apps are included, a note explains that apps are saved as their Intune details and assignments, which makes them the slowest type to back up. Installer files are not downloaded by this configuration-backup workflow; [App Backup](/apps/app-backup/) handles supported installer captures separately.

### The saved backup choice

Each tenant has a saved backup choice. Automatic backups, **Back up all tenants now** and **Backup Selected** use it, and the **Back up** dialog starts from it.

* A tenant without a saved choice uses **Everything except apps**. The Schedule tab shows it as "(default)".
* To change the saved choice from the **Back up** dialog, pick a different choice and tick **Also use this for automatic backups of** the tenant before you start.
* To change it without running a backup, open **Backup & Restore**, then the **Schedule** tab, and edit **What to back up**. See [Schedule backups](/backups/schedules/#choose-what-automatic-backups-cover).

A backup that leaves out types never ages out the only copy of those types. See [Retention](/backups/storage/#retention).

<figure class="docs-screenshot">
  <a href="/images/screenshots/backup-scope.webp" aria-label="Open full-size screenshot: backup scope">
    <img src="/images/screenshots/backup-scope.webp" alt="Choose Everything except apps, Everything or Custom before starting" width="1632" height="708" loading="lazy" decoding="async" />
  </a>
  <figcaption>Choose Everything except apps, Everything or Custom before starting. Example tenant data. Select the image to view it full size.</figcaption>
</figure>

## Follow a running backup

The **Backup Progress** dialog shows:

* a progress bar with the current step, for example "Reading Intune configuration..." or "Backing up" a type, and the result when the backup ends
* **Policies saved** (**Saved so far** while it runs), **Types backed up** and **Duration**
* **Needs attention**, when a type could not be read or was left out, or some objects could not be saved. When the backup has ended, the first line says **Coverage incomplete** with how many of the selected types were not read in full (see [Coverage](#coverage)).
* each type that was backed up, with its count, the types that had nothing to back up, and the types that are not set up in this tenant
* the error, if the backup fails
* **Show raw log**, which opens the technical log with **Copy log** and the job ID

Click **Run in Background**, or close the dialog, to keep working. The backup continues and a panel in the lower right corner of the window shows its progress. Expand the panel for a short summary, the first types saved and **Show raw log**, or dismiss it with the close button. The panel shows **Backup in progress**, the result such as **Backup completed successfully** or **Backup completed with 2 warnings**, or **Backup failed**.

:::caution
Backups run inside TenuVault. If you quit TenuVault while a backup runs, the backup stops and is shown as **Incomplete**. Closing the window is fine when TenuVault keeps running in the menu bar on macOS or the tray on Windows. See [Schedule backups](/backups/schedules/#keep-tenuvault-running).
:::

### The backup log

The log lists what TenuVault did, with a time stamp per line. Typical lines:

| Log line | Meaning |
| --- | --- |
| "Leaving out N of M types: ..." | The backup choice excludes these types |
| "Intune is turned off for this tenant, so its types are not backed up. ..." | Intune is off for the tenant under **Settings** > **Services and permissions**, so this backup holds no Intune policies. Turn it on there to back them up again. |
| "Found N ... (N built-in skipped)." | Items found for a type. Built-in objects Intune recreates itself are skipped. |
| "Backed up N ..." | All items of a type are saved |
| "Skipped ... (HTTP 403): access was denied. The app registration may lack the permission or admin consent, or your Intune role may not allow it." | Microsoft Graph refused access to this type. The log includes the error code when available. The backup continues without the type. |
| "Skipped ... (HTTP ...): Microsoft refused the read ..." | The log gives the HTTP status, the error code when available, and guidance for a missing permission, a role your account lacks, or a product the tenant has no license for or never set up. The backup continues without the type. See [Coverage](#coverage). |
| "... is not set up in this tenant." | Microsoft answered that this setting was never made. There is nothing to save, and nothing is missing from the backup. |
| "Could not read ...: ..." | A whole type could not be listed. The backup completes with warnings. |
| "Could not back up "name": ..." | One item could not be read. The backup completes with warnings. |
| "Removed N backups older than N days." | Retention removed old backups |
| "Older backups were kept because this backup is incomplete." | Retention was skipped because of warnings |
| "Backup completed: N policies in ..." | The final count and duration |
| "Backup failed: nothing could be read. ..." | Every selected type was left out, so the backup holds nothing. The line names the cause most types share. See [Coverage](#coverage). |

If Microsoft Graph throttles requests, TenuVault pauses and retries automatically. If your sign-in expires during a backup, the backup stops. The log and failed-run history identify the service that needs a new sign-in and show a refusal code when available. Sign in again to that tenant and run a new backup.

For Azure Blob Storage failures, the log gives the HTTP status, the error code when available, and what to check. For `AuthenticationFailed`, sign in to the tenant again. For an unexpected `BlobNotFound`, check the configured container or backup location. Graph skip messages and Azure Blob Storage failures use built-in guidance to keep account details from provider messages out of the log.

Some Defender and Entra ID endpoints refuse a read with the same answer Microsoft gives for a sign-in that ended. TenuVault asks such a request once more with a new sign-in token. Only when the new token gets the same answer is the type left out; when no new token can be had, the backup stops and you are asked to sign in again.

## Read the result

A backup ends with one of these results:

| Result | Meaning |
| --- | --- |
| **Complete** | Every item of every included type was saved |
| **Completed with warnings** | Some items or types could not be read. The rest was saved. The log and **Backup Details** list what is missing. |
| **Failed** | No item could be saved, every selected type was left out so nothing could be read, or the backup stopped after it started saving, for example because the sign-in expired, Microsoft Graph stopped responding or the 30 minute deadline passed. It holds only the policies it saved and is never used as a complete backup. The timeline shows how it started, and retention removes it like any other backup once it is older than the retention period. |
| **Cancelled** | You cancelled the backup after it started saving. It is shown in a neutral tone, because you stopped it on purpose. Like a failed backup, it holds only the policies it saved, is never used as a complete backup, and retention removes it once it is older than the retention period. On the Dashboard it counts in the backups in storage, but not as successful or failed and not in **Success Rate**, and it does not change **Tenant Health**. Backups cancelled with an earlier version, which recorded them as failed, are shown as cancelled too. |
| **Incomplete** | The backup stopped and could not record its result, for example because TenuVault was closed or the storage could not be reached. It holds only part of the tenant. |
| **Status unknown** | The backup's summary could not be read, so whether it finished is not known. **Backup Details** shows why, for example "This backup was encrypted by an earlier TenuVault version. Import the recovery key of the device that made it to open it." for an older encrypted Azure backup, or a damaged file on this device. Import that recovery key, or select **Refresh** when the storage did not answer. Drift detection does not offer it until its summary can be read. |
| **Running** | The backup has not written its summary yet. A backup without a summary is shown as running while TenuVault runs it, or for six hours after it started, because another device may be running it or TenuVault restarted during it; after that it is shown as incomplete. On the Dashboard, one whose run failed counts as failed. |

Expand a group under **Backup Details > Contents** to see which types were saved. **Not included in this backup** identifies types outside the recorded scope. **Not read** gives the reason when available. **None in the tenant** means the backup read the type and found nothing to save.

When the tenant's Azure storage account holds older backups that an earlier TenuVault version encrypted and no recovery key on this device opens, the backup timeline shows a notice, for example "2 older Azure backups need a recovery key", with **Import recovery key**. The notice is only advice: new backups and the other backups keep working, and a backup that cannot be read is never deleted. In a storage account several tenants share, such backups may belong to another tenant. See [Older encrypted Azure backups](/security/encryption/#older-encrypted-azure-backups).

The **Backup Progress** dialog shows **Failed** with the error for every backup that failed, including the ones the timeline later lists as incomplete. A backup you cancelled shows **Cancelled** with a grey icon instead.

In a storage account that several tenants share, each backup records the tenant it belongs to. When that record could not be read, for example because the storage did not answer, the backup is left out of the list and the Dashboard, because it may be another tenant's. **Backup History** and the Dashboard then show "N backups could not be read. Select Refresh to try again." Once the record can be read, the backup is listed again, or left out if it belongs to another tenant.

The dashboard refreshes backup summaries every 30 seconds. It reuses unchanged summary metadata and reads one container inventory, including its continuation pages, instead of listing every backup folder separately. Counts, policy breakdowns and backup results stay the same.

A backup attempt can fail before any backup is saved. It does not appear in the timeline, but the Dashboard counts it as **Failed** and in **Success Rate** for the period. An automatic attempt also appears in the [Schedule status](/backups/schedules/#when-a-scheduled-backup-fails). Click a scheduled or tray failure notification to open the affected tenant's **Schedule** tab.

### Coverage

The result says whether the backup finished and can be used. Coverage says whether it holds every type you asked it to cover. Each selected type ends in exactly one outcome:

| Outcome | Meaning | Coverage |
| --- | --- | --- |
| Saved | Every object of the type was saved. A type the tenant has none of is saved with a count of 0. | Complete |
| Not set up in this tenant | Microsoft answered that the setting was never made. There is nothing to save. | Complete |
| Left out | The sign-in could not read the type. The reason names the cause: a permission or its admin consent is missing, your account has no role that can read it, the tenant has no license for the product or never set it up, or only a signed-in admin can read it and the backup ran as the Backup Reader. | Incomplete |
| Not read | The type, or some of its objects, could not be read, for example because Microsoft Graph returned an error, did not answer, or asked for a longer pause than a backup waits. | Incomplete |

A backup with a type that was left out or not read shows **Coverage incomplete** in the **Backup Progress** dialog and in **Backup Details**, with the types concerned. A type that was left out does not change the result: the backup is still **Complete**, scheduled backups do not retry it, and no failure is notified. A type that was not read makes the result **Completed with warnings**, as before.

One case is different: when every selected type was left out, the backup read nothing and holds nothing. It ends as **Failed** with "Backup failed: nothing could be read" and the cause most of the types share, for example a missing permission or a product the tenant has no license for. Scheduled backups retry it, a failure is notified, and older backups are kept. A backup whose types are all empty or not set up in the tenant did read the tenant and stays **Complete**.

A Defender or Entra ID endpoint that fails ends its own type, and the backup goes on with the other types and services. When Microsoft Graph stops answering the requests of one of these services, the rest of that service is not read and the other services are.

Types the backup choice leaves out, and the types of a service that is turned off for the tenant, are not selected. They never make coverage incomplete.

Retention follows coverage per type: an older backup stays while it holds the newest copy of a type that later backups left out or did not read.

A run can finish when an individual type is denied. If every selected type is left out, the run fails. **Backup Details** lists them: "Left out because access was denied". Open the app registration in Microsoft Entra, go to **API permissions** and select **Grant admin consent for &lt;your tenant&gt;**, or run the setup script again. Then sign out of the tenant in TenuVault and sign in again. If every permission already shows **Granted**, check that your role for the affected service covers these policies. See [Create the app registration](/getting-started/app-registration/#3-add-the-delegated-permissions).

## Backup history

The **Backup History** tab of **Backup & Restore** shows the **Backup Timeline**: every backup in the tenant's storage, newest first. Click **Refresh** to reload it.

Each entry shows:

* the date and time
* what the backup covered: **Everything**, **Everything except apps**, or the number of types, for example "12 of 135 types"
* how it started: **Manual**, **Scheduled** or **From tray**
* the result, when it is not **Complete**
* **Items**, **Size**, **Duration** and **Changes** since the previous backup (see [Compare backups](/backups/compare/))

Below the timeline, **Trends by policy type** shows one row per policy type found in the listed backups: how many backups held it, its latest item count, its latest and average stored size, the size change from the oldest to the newest backup that held it, and the latest, average and change of the whole backup duration for those backups. Each backup records one duration for the whole backup, so the duration columns are not a split by type. The trends use only the backup list already loaded for this tab. They need no extra reads and store nothing new. A type held by one backup shows **Only one backup** instead of a change, and a value a backup did not record shows **Not recorded**.

Click an entry to open its **Backup Details**:

| Part | What it shows |
| --- | --- |
| Buttons | **View Changes** ([Compare backups](/backups/compare/)), **Download** ([export as ZIP](/backups/storage/#export-a-backup-as-a-zip-file)) and **Restore from this backup** ([Restore Intune policies](/restore/)) |
| Warnings | Why a backup is incomplete, how many items or types could not be read, and which types were left out for missing permissions. **Coverage incomplete** lists every selected type the backup does not hold in full. Backups made before version 0.6 do not record coverage and show the other lines only. |
| Totals | **Items**, **Size**, **Duration** and **Changes since the previous backup** |
| **Contents** | Item counts per area. Expand an area for counts per type, and to see how many of its types the backup did not include. Areas left out entirely show **Not included**. |
| **About this backup** | **Status**, **Started** (how it started), **Included**, **Stored** and **Backup ID** |

**Restore from this backup** is unavailable while a backup is running or when it holds no items.

<figure class="docs-screenshot">
  <a href="/images/screenshots/backup-history.webp" aria-label="Open full-size screenshot: backup history">
    <img src="/images/screenshots/backup-history.webp" alt="Backup History shows the saved scope, item count, size, duration and changes for each backup" width="2880" height="2000" loading="lazy" decoding="async" />
  </a>
  <figcaption>Backup History shows the saved scope, item count, size, duration and changes for each backup. Example tenant data. Select the image to view it full size.</figcaption>
</figure>

## Where to see backups at a glance

* The [Dashboard](/tenants/#the-tenant-dashboard) shows the last backup, success rate, next automatic backup and Tenant Health of the selected tenant.
* The [All tenants](/tenants/#the-all-tenants-overview) page shows the last backup of every tenant.

## Plan requirements

| Action | Community | Pro | MSP |
| --- | --- | --- | --- |
| Manual backups to this device | Yes | Yes | Yes |
| Manual backups to your Azure storage account | No | Yes | Yes |
| Choose what to back up | Yes | Yes | Yes |
| **Backup Selected** across tenants | No | No | Yes |

If a tenant's plan does not include an action, TenuVault shows which plan does and how to upgrade.

## Related pages

* [Intune backup](https://www.tenuvault.com/intune-backup): what TenuVault backs up and why, on the product site
* [Does Microsoft Intune have a built-in backup?](https://www.tenuvault.com/guides/does-intune-have-backup)
* [Manual Intune exports or scheduled backups](https://www.tenuvault.com/compare/manual-intune-exports-vs-scheduled-backups): when exporting by hand is enough, on the product site
* [What gets backed up](/backups/coverage/)
* [Schedule backups](/backups/schedules/)
* [Restore Intune policies](/restore/)
