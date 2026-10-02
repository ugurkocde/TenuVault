---
title: "Drift detection"
description: Find the Intune changes between your two newest backups, and revert them or restore a copy.
---

Drift detection shows what changed in your Intune configuration between your two newest complete backups: new items, changed settings and deleted items. From each change you can put the item back to its backed-up version, or restore it as a separate copy.

TenuVault compares backups, not the live tenant. To include the latest changes, run a backup first. See [Run a backup](/backups/).

## Requirements

* The tenant is signed in and has a storage location.
* At least two complete backups exist among the tenant's five newest backups. Backups that completed with warnings, failed, are still running or are incomplete are skipped, because missing items would show up as deleted.

If there are not enough complete backups, the page says: "Drift comparison needs two complete backups, and the latest N include fewer than two. Incomplete backups are skipped. Create a successful backup and try again."

## Run drift detection

1. Select the tenant in the tenant switcher.
2. Open **Drift Detection** in the sidebar.

Detection runs automatically when you open the page or switch tenants. To run it again, click **Run Detection Now**, or **Refresh** on the **Last Scan** card. While it runs, the page shows **Analyzing Configuration Drifts** with a progress bar.

## Read the results

The summary cards show:

| Card | What it shows |
| --- | --- |
| **Total Drifts** | All changes found between the two backups |
| **New Policies** | Items added |
| **Modified Policies** | Items changed |
| **Last Scan** | When detection last ran |

The **Scope** label shows the tenant being compared. Switch between three views:

* **List**: one card per change with the item name, type, a short description, when it was detected and the change type (**added**, **modified** or **deleted**).
* **Timeline**: the same changes along a timeline.
* **Analysis**: **Drift Trends (7 Days)** with added and modified items per day, and **Drift by Configuration Type**.

### Look at one change

In the **List** view, click a change or its **View Diff** button. The card expands and shows:

* **Impact Assessment**: what the change means for devices, for example that a deleted item is "no longer applied to devices"
* **Configuration Changes**: for a modified item, each changed setting with the old value (`-`) and the new value (`+`)
* **Detected between**: the times of the two backups compared
* **Revert History**: earlier reverts of this item, if any

A change marked **Reverted** was already reverted with TenuVault. A change marked **Result of Revert** appeared because you reverted the item between the two backups; no action is needed.

## What drift detection compares

* All types both backups include. If one backup left out apps, apps are not compared. See [What gets backed up](/backups/coverage/).
* Changes to IDs, version numbers, creation and modification times, the description and the reference IDs of encrypted values are ignored.
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
3. Click **Create Restored Policy** to go ahead, or **Cancel**.

A progress dialog shows each step: **Fetching policy from backup**, **Preparing policy data**, **Applying changes to Intune** (or **Creating new policy in Intune**), **Updating metadata** and **Refreshing drift detection**. It cannot be cancelled once started. When it finishes, click **Done**, or **View in Intune** to open the Intune admin center. If a step fails, the dialog shows **Operation Failed** with the reason.

TenuVault records every revert and restore in the tenant's backup storage, so the change is marked **Reverted** and its history shows in later results. Each action is also recorded in the [audit log](/audit-log/).

:::caution
**Revert** and **Recreate** only work with backups TenuVault has encrypted and can verify. Older unencrypted backups show "Unverified legacy snapshots cannot revert live policies. Review and restore a copy instead." Use **Restore previous version as copy** for those.
:::

For restoring several items, choosing assignments or restoring into another tenant, use the restore wizard instead. See [Restore items](/restore/).

## Export a drift report

Click **Export Report** and choose:

* **Export as JSON**: the tenant, the time of the scan, a summary by change type and by type, and every change with its details
* **Export as CSV**: one row per change with Config Name, Type, Change Type, Severity, Detected At, Impact, Affected Policies, Affected Devices, Description, From Backup and To Backup

The file is named `drift-report-` followed by the date. **Export Report** is unavailable when no drift was found.

## Check drift across tenants

With MSP, you can check all tenants at once:

1. Open **Tenants** and switch to the list view.
2. In the **Drift** column header, click **Check all**.

TenuVault compares each tenant's two newest backups, one tenant after another. The **Drift** column then shows **No drift**, the number of changes and how many are critical, or **Not available** when the check failed (hover for the reason, for example when one of the two newest backups is not complete).

## Where drift appears elsewhere

* The **Drift** tile on the [Dashboard](/tenants/#the-tenant-dashboard) shows when backups were last compared, and **Check drift** opens this page.
* Every detection is recorded in the [audit log](/audit-log/) as "Detect drifts".

## Plan requirements

| Feature | Community | Pro | MSP |
| --- | --- | --- | --- |
| Drift detection, views and export | Yes | Yes | Yes |
| Restore a copy from a drift | Yes | Yes | Yes |
| **Revert** and **Recreate** | No | Yes | Yes |
| **Check all** across tenants | No | No | Yes |
