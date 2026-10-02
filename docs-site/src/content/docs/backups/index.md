---
title: "Run a backup"
description: Start a backup, choose what it covers, follow its progress and read the result.
---

A backup is a complete copy of your Intune configuration at one point in time. This page shows how to start one, choose what it covers, follow it while it runs and read the result.

## How a backup works

TenuVault reads your Intune configuration through Microsoft Graph (beta) with your own delegated sign-in. It saves every object as its own file, together with its assignments, in a new backup folder named after the start time in UTC, for example `backup-2026-09-28-020000`. When all objects are read, it writes a summary with the item counts, the result and a fingerprint of every item, which later lets TenuVault [compare backups](/backups/compare/).

Backups go to the storage you chose for the tenant: encrypted on this device, or encrypted in your own Azure storage account. See [Backup storage and retention](/backups/storage/).

For the full list of object types, see [What gets backed up](/backups/coverage/).

## Before you start

* You are signed in to the tenant. See [Sign in to your tenant](/getting-started/connect-tenant/).
* Your license covers the tenant. A tenant that is not licensed is not backed up.
* The tenant has a storage location. If not, TenuVault asks you to "Choose where backups for this tenant are stored in Settings first."
* For backups to your Azure storage account: the tenant is on Pro or MSP, and you have saved your recovery key in **Settings**. TenuVault does not upload to Azure until you have. See [Encryption and recovery key](/security/encryption/).

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
| Tray or menu bar icon | **Back up all tenants now** | Backs up every connected tenant with its saved choice. See [Schedule backups](/backups/schedules/#the-tray-icon). |

TenuVault runs one backup per tenant at a time. If you start a backup while one is already running for the same tenant, you follow the running one.

## Choose what to back up

The **Back up** dialog offers three choices:

| Choice | What it covers |
| --- | --- |
| **Everything except apps** | "Policies, scripts, updates, enrollment and tenant settings." Every type except apps. App categories, policy sets, app configuration and app protection policies are still included. |
| **Everything** | "Also app details and assignments. Installer files are never included." All 39 types. |
| **Custom** | "Choose areas and individual types." |

With **Custom**, TenuVault lists the areas (for example **Device configuration** or **Enrollment**). Tick an area to include all of its types, or expand it to tick individual types. When the tenant has an earlier backup, each area and type shows how many items it held last time, and the dialog estimates the total number of items.

The line under the choices shows how many of the 39 types the backup covers. **Start backup** is unavailable until at least one type is ticked ("Choose at least one type.").

When apps are included, a note explains that apps are saved as their Intune details and assignments, which makes them the slowest type to back up, and that installer files are never downloaded.

### The saved backup choice

Each tenant has a saved backup choice. Automatic backups, **Back up all tenants now** and **Backup Selected** use it, and the **Back up** dialog starts from it.

* A tenant without a saved choice uses **Everything except apps**. The Schedule tab shows it as "(default)".
* To change the saved choice from the **Back up** dialog, pick a different choice and tick **Also use this for automatic backups of** the tenant before you start.
* To change it without running a backup, open **Backup & Restore**, then the **Schedule** tab, and edit **What to back up**. See [Schedule backups](/backups/schedules/#choose-what-automatic-backups-cover).

A backup that leaves out types never ages out the only copy of those types. See [Retention](/backups/storage/#retention).

## Follow a running backup

The **Backup Progress** dialog shows:

* a progress bar with the current step, for example "Reading Intune configuration..." or "Backing up" a type
* **Status**, **Job ID** and **Start Time**, then **End Time** and **Duration** when the backup ends
* the error, if the backup fails
* **Show Job Output**, which opens the backup log

Click **Run in Background**, or close the dialog, to keep working. The backup continues and a panel in the lower right corner of the window shows its progress. Expand the panel for details and **Show Output**, or dismiss it with the close button. The panel shows **Backup in progress**, **Backup completed** or **Backup failed**.

:::caution
Backups run inside TenuVault. If you quit TenuVault while a backup runs, the backup stops and is shown as **Incomplete**. Closing the window is fine when TenuVault keeps running in the tray. See [Schedule backups](/backups/schedules/#keep-tenuvault-running).
:::

### The backup log

The log lists what TenuVault did, with a time stamp per line. Typical lines:

| Log line | Meaning |
| --- | --- |
| "Leaving out N of 39 types: ..." | The backup choice excludes these types |
| "Found N ... (N built-in skipped)." | Items found for a type. Built-in objects Intune recreates itself are skipped. |
| "Backed up N ..." | All items of a type are saved |
| "Skipped ...: access was denied. The app registration may lack the permission or admin consent, or your Intune role may not allow it." | Microsoft Graph refused access to this type: a permission or its admin consent is missing, or your Intune role does not cover it. The backup continues without it. |
| "Could not read ...: ..." | A whole type could not be listed. The backup completes with warnings. |
| "Could not back up "name": ..." | One item could not be read. The backup completes with warnings. |
| "Removed N backups older than N days." | Retention removed old backups |
| "Older backups were kept because this backup is incomplete." | Retention was skipped because of warnings |
| "Backup completed: N policies in ..." | The final count and duration |

If Microsoft Graph throttles requests, TenuVault pauses and retries automatically. If your sign-in expires during a backup, the backup stops instead of reporting every remaining item as a warning. Sign in again and run a new backup.

## Read the result

A backup ends with one of these results:

| Result | Meaning |
| --- | --- |
| **Complete** | Every item of every included type was saved |
| **Completed with warnings** | Some items or types could not be read. The rest was saved. The log and **Backup Details** list what is missing. |
| **Failed** | No item could be saved |
| **Incomplete** | The backup stopped before it finished, for example because TenuVault was closed, the sign-in expired or the storage could not be reached. It holds only part of the tenant. |
| **Running** | The backup has not written its summary yet. A backup without a summary that started less than six hours ago is shown as running; after that it is shown as incomplete. |

The **Backup Progress** dialog shows **Failed** with the error for every backup that stopped, including the ones the timeline later lists as incomplete.

Types skipped because access was denied do not make the backup incomplete. **Backup Details** lists them: "Left out because access was denied". Open the app registration in Microsoft Entra, go to **API permissions** and select **Grant admin consent for &lt;your tenant&gt;**, or run the setup script again. Then sign out of the tenant in TenuVault and sign in again. If every permission already shows **Granted**, check that your Intune role covers these items. See [Create the app registration](/getting-started/app-registration/#3-add-the-delegated-permissions).

## Backup history

The **Backup History** tab of **Backup & Restore** shows the **Backup Timeline**: every backup in the tenant's storage, newest first. Click **Refresh** to reload it.

Each entry shows:

* the date and time
* what the backup covered: **Everything**, **Everything except apps**, or the number of types, for example "12 of 39 types"
* how it started: **Manual**, **Scheduled** or **From tray**
* the result, when it is not **Complete**
* **Items**, **Size**, **Duration** and **Changes** since the previous backup (see [Compare backups](/backups/compare/))

Click an entry to open its **Backup Details**:

| Part | What it shows |
| --- | --- |
| Buttons | **View Changes** ([Compare backups](/backups/compare/)), **Download** ([export as ZIP](/backups/storage/#export-a-backup-as-a-zip-file)) and **Restore from this backup** ([Restore items](/restore/)) |
| Warnings | Why a backup is incomplete, how many items or types could not be read, and which types were left out for missing permissions |
| Totals | **Items**, **Size**, **Duration** and **Changes since the previous backup** |
| **Contents** | Item counts per area. Expand an area for counts per type, and to see how many of its types the backup did not include. Areas left out entirely show **Not included**. |
| **About this backup** | **Status**, **Started** (how it started), **Included**, **Stored** and **Backup ID** |

**Restore from this backup** is unavailable while a backup is running or when it holds no items.

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
