---
title: "Drift detection"
description: Pick two backups and see every Intune setting that changed between them, then revert it or restore a copy.
---

Drift detection shows what changed in your Intune configuration between two backups: new items, changed settings and deleted items. By default it compares your two newest complete backups, and you can pick any other pair. From each change you can put the item back to its backed-up version, or restore it as a separate copy.

TenuVault compares backups, not the live tenant. To include the latest changes, run a backup first. See [Run a backup](/backups/).

## Requirements

* The tenant is signed in and has a storage location.
* At least two complete backups of the tenant exist. Backups that failed, are still running or stopped early cannot be compared, because missing items would show up as deleted.

If there are not enough complete backups, the page says **Two complete backups are needed** and links to **Backup & Restore**.

## Run drift detection

1. Select the tenant in the tenant switcher.
2. Open **Drift Detection** in the sidebar.

The first time you open the page for a tenant, TenuVault compares its two newest complete backups in the background. After that, the page shows the last result straight away, without comparing again.

### Pick the backups to compare

At the top of the page, choose:

* **Baseline (older)**: the backup to compare from
* **Comparison (newer)**: the backup to compare with

Each backup is listed with its date and time and how it started (**Manual**, **Scheduled** or **From tray**). Backups that did not complete are shown but cannot be chosen. Backups that completed with warnings can be chosen and are marked, because items they could not read may show up as deleted or added. A backup that is already chosen on one side cannot be chosen on the other, and the swap button between the two lists exchanges them. The baseline must be older than the comparison.

Click **Compare** to compare the chosen pair, or to compare the shown pair again. When another pair is chosen, **Use the latest two backups** under the lists picks the two newest complete backups, for example after a new backup.

### Scans run in the background

A comparison runs in the background, so you can open other pages while it works:

* The page shows **Comparing backups** with the current step and how many policies of the total were compared so far.
* While a scan runs, a spinner shows next to **Drift Detection** in the sidebar.
* When the scan is ready and you are on another page, a message says so with a **View results** link. When the TenuVault window is not in front, a system notification appears instead.
* Click **Cancel scan** to stop it. No further backup files are read and the previous result stays.

Each tenant runs one scan at a time. The last result of every tenant is kept on this device, so switching tenants shows that tenant's own result or its running scan.

## Read the results

Above the results, a line names the two compared backups, for example "Baseline: Oct 1, 2026, 10:00 (manual) → Comparison: Oct 6, 2026, 02:00 (scheduled)". Under it are the number of changes, how many items were **added** (in the comparison backup but not the baseline), **modified** (settings changed) and **deleted** (in the baseline but no longer in the comparison backup), how many items were checked and when the comparison ran.

The same colors mark each change type everywhere on the page: green for added, amber for modified and red for deleted. Each change also carries its type as a word.

If a backed-up file could not be read, a notice lists it. That item is left out of the result; the rest is compared normally.

The changes are grouped by type, with the number of changes per type. Each change shows the item name, its change type, its previous name if it was renamed, and for a modified item the number of changed settings and the first of their names.

When the two backups hold the same configuration, the page says "No drift between" followed by the dates of the two backups.

Copies TenuVault made with **Restore as copy** are not listed as added; see below.

### Look at one change

Click a change to expand it (or press Enter or Space on it), and click it again to collapse it. The expanded card shows:

* **Changed settings**: for a modified item, every changed setting with its value **Before** and **After**
* For an added or deleted item: its type, name, ID and the backup file it is stored in
* **Revert History**: earlier reverts of this item, if any

Changed settings are named so you can read them:

* Settings Catalog settings use the name Intune shows for them, for example "Do not display the password reveal button" for `device_vendor_msft_policy_config_credentialsui_disablepasswordreveal`, and their choices use Intune's option names, such as **Enabled**. TenuVault reads these names from Microsoft Graph when the scan runs. When Graph cannot be reached, the name is derived from the setting's ID instead, for example "Defender: Allow cloud protection".
* Custom OMA-URI settings use their name.
* Other properties are written out, for example "Password minimum length" for `passwordMinimumLength`.

The original property path is shown in small print under each name. Values show as they are; a setting without a value shows **Not set**. Lists and objects open as formatted JSON, and long values are cut off with **Show more**. Hover over a shortened choice to see its full value.

A change marked **Reverted** was already reverted with TenuVault. A change marked **Result of Revert** appeared because you reverted the item between the two backups; no action is needed.

## What drift detection compares

* All types both backups include. If one backup left out apps, apps are not compared. See [What gets backed up](/backups/coverage/).
* Changes to IDs, version numbers, creation and modification times, the description and the reference IDs of encrypted values are ignored.
* Items whose fingerprint (recorded in each backup) is the same in both backups are unchanged and are not read again, so comparisons of large tenants finish faster. Backups made by earlier versions without fingerprints are compared file by file.
* Lists of settings are matched by the setting itself, so an added, removed or reordered setting is reported as that setting, not as a change to every setting after it.
* Earlier TenuVault versions saved Settings Catalog policies (including endpoint security and Settings Catalog compliance policies) without their assignments. When the older backup comes from such a version, the assignments of these policies are not compared, so the first backup that includes them does not show every assigned policy as changed. Their settings are still compared.
* New items whose name starts with **[Restored]** are not reported as drift. These are the copies TenuVault creates when you restore.

### Severity

Every change also has a severity. It appears in the exported report and in **Check all** on the Tenants page:

| Severity | When |
| --- | --- |
| Critical | A compliance policy was deleted, or a changed setting's name contains passwordRequired, encryption, jailbreak, firewall, antivirus or bitLocker |
| Warning | Any other deleted item, or a changed compliance policy or device configuration profile |
| Info | Everything else |

## Act on a change

For **modified** and **deleted** items that were not reverted yet, the expanded card offers two actions:

| Button | What it does | Plans |
| --- | --- | --- |
| **Revert** (modified items) | Puts the existing item back to its backed-up version. The current settings are overwritten and reach devices at their next check-in. Assignments stay as they are. | Pro and MSP |
| **Recreate** (deleted items) | Recreates the item from the backup under its original name. Assignments are not restored. | Pro and MSP |
| **Restore previous version as copy** (modified items) | Creates a new, unassigned item with the "[Restored]" prefix and the backed-up settings. The current item is not changed. | All plans |
| **Restore as copy** (deleted items) | Creates the deleted item again as a new, unassigned item with the "[Restored]" prefix | All plans |

To run an action:

1. Click the action button.
2. Read the confirmation, which names the item and what will happen.
3. Click the confirming button to go ahead, or **Cancel**. It names the action: **Revert policy** or **Recreate policy** (shown in red, since they change the live item), or **Create copy**.

A progress dialog shows each step: **Fetching policy from backup**, **Preparing policy data**, **Applying changes to Intune** (or **Creating new policy in Intune**), **Updating metadata** and **Refreshing drift detection**, which compares the same two backups again in the background. It cannot be cancelled once started. When it finishes, click **Done**, or **View in Intune** to open the Intune admin center. If a step fails, the dialog shows **Operation Failed** with the reason.

TenuVault records every revert and restore in the tenant's backup storage, so the change is marked **Reverted** and its history shows in later results. Each action is also recorded in the [audit log](/audit-log/).

:::caution
**Revert** and **Recreate** only work with backups TenuVault has encrypted and can verify. Older unencrypted backups show "Unverified legacy snapshots cannot revert live policies. Review and restore a copy instead." Use **Restore previous version as copy** for those.
:::

For restoring several items, choosing assignments or restoring into another tenant, use the restore wizard instead. See [Restore items](/restore/).

## Export a drift report

Click **Export** and choose:

* **CSV, one row per changed setting**: the columns Item, Item type, Change, Severity, Previous name, Setting, Setting path, Before and After, plus the item's ID. Added and deleted items get one row without a setting.
* **JSON**: the tenant, when the comparison ran, the two compared backups, the number of added, modified and deleted items, files that could not be read, and every item with its changed settings (readable values and the values as stored)

The file is named after the tenant and the two compared backups, for example `drift-contoso-backup-2026-10-06-020000-to-backup-2026-10-07-020000.csv`. **Export** is unavailable when no drift was found.

## Check drift across tenants

With MSP, you can check all tenants at once:

1. Open **Tenants** and switch to the list view.
2. In the **Drift** column header, click **Check all**.

TenuVault compares each tenant's two newest complete backups, one tenant after another. This check does not change the result shown on the Drift Detection page. The **Drift** column then shows **No drift**, the number of changes and how many are critical, or **Not available** when the check failed (hover for the reason, for example when the tenant has fewer than two complete backups).

## Where drift appears elsewhere

* The **Drift** tile on the [Dashboard](/tenants/#the-tenant-dashboard) shows when backups were last compared, and **Check drift** opens this page.
* Every comparison is recorded in the [audit log](/audit-log/) as "Detect drifts".

## Plan requirements

| Feature | Community | Pro | MSP |
| --- | --- | --- | --- |
| Drift detection and export | Yes | Yes | Yes |
| Restore a copy from a drift | Yes | Yes | Yes |
| **Revert** and **Recreate** | No | Yes | Yes |
| **Check all** across tenants | No | No | Yes |
