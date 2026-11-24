---
title: "Drift detection"
description: Compare Defender, Entra ID and Intune backups, then revert supported changes or restore a copy.
---

Drift detection shows what changed in your Defender, Entra ID and Intune configuration between two backups: added and deleted policies, changes to policy settings, and changes to covered directory records. By default it compares your two newest complete backups, and you can pick any other pair. Where the policy type supports restore, you can revert the change or restore a separate copy. Conditional Access is part of Entra ID coverage.

TenuVault compares backups, not the live tenant. To include the latest changes, run a backup first. See [Run a backup](/backups/).

For the product overview, see [Intune drift detection](https://www.tenuvault.com/intune-drift-detection). For an investigation walkthrough, follow the guide to [detect configuration drift in Intune](https://www.tenuvault.com/guides/detect-intune-configuration-drift).

## Requirements

* The tenant is signed in and has a storage location.
* At least two complete backups of the tenant exist. Backups that failed, are still running, stopped early or whose summary could not be read cannot be compared, because missing policies would show up as deleted.

If there are not enough complete backups, the page says **Two complete backups are needed**, with **Back up now** to start a backup from this page and a link to **Backup & Restore**.

## Run drift detection

1. Select the tenant in the tenant switcher.
2. Open **Drift Detection** in the sidebar.

The first time you open the page for a tenant, TenuVault compares its two newest complete backups in the background. After that, the page shows the last result straight away, without comparing again.

### Pick the backups to compare

At the top of the page, choose:

* **Baseline (older)**: the backup to compare from
* **Comparison (newer)**: the backup to compare with

Each list offers only the backups that can be compared, with their date and time and, when it was recorded, how they started (**Manual**, **Scheduled** or **From tray**). Backups that completed with warnings are offered and marked. Backups that did not finish or whose summary could not be read are not listed; a line under the lists says how many there are and links to **Backup & Restore**, where they are shown. Choosing a backup keeps the older of the two as the baseline: choosing the backup that is already chosen on the other side, or a baseline newer than the comparison, puts them in order. The swap button between the lists exchanges them as they are. The baseline must be older than the comparison.

When only two backups can be compared, they are already chosen, and the page says so and offers **Back up now**. A backup started there is added to the lists when it finishes, even if you open another page meanwhile, so you can compare it with an older one.

Click **Compare** to compare the chosen pair, or to compare the shown pair again. When another pair is chosen, **Use the latest two backups** under the lists picks the two newest complete backups, for example after a new backup.

### Scans run in the background

A comparison runs in the background, so you can open other pages while it works:

* While you stay on the page, the scan fills it with its progress: the current step, how many policies of the total were compared so far, and a progress bar. A previous result stays underneath and comes back unchanged if the scan does not finish.
* While a scan runs, a spinner shows next to **Drift Detection** in the sidebar.
* When the scan is ready and you are on another page, a message says so with a **View results** link. When the TenuVault window is not in front, a system notification appears instead.
* Click **Cancel scan** to stop it. No further backup files are read and the previous result stays.

Each tenant runs one scan at a time. The last result of every tenant is kept on this device, so switching tenants shows that tenant's own result or its running scan.

## Read the results

Above the results, a line names the two compared backups, for example "Baseline: Oct 1, 2026, 10:00 (manual) → Comparison: Oct 6, 2026, 02:00 (scheduled)". Under it are the number of changes, how many policies were **added** (in the comparison backup but not the baseline), **modified** (settings changed) and **deleted** (in the baseline but no longer in the comparison backup), how many policies were checked and when the comparison ran.

The same colors mark each change type everywhere on the page: green for added, amber for modified and red for deleted. Each change also carries its type as a word.

If a backed-up file could not be read, a notice lists it. That item is left out of the result; the rest is compared normally.

The changes are grouped by type, with the number of changes per type. Each change shows the item name, its change type, its previous name if it was renamed, and for a modified item the number of changed settings and the first of their names.

When the two backups hold the same configuration, the page says "No drift between" followed by the dates of the two backups.

Copies TenuVault made with **Restore as copy** are listed as added and marked **Likely restored copy**; see below.

### Filter the changes

Above the list, narrow it down with:

* **Search policy or setting**: matches the policy name, its previous name, its type, and the names and property paths of its changed settings. Every word you type must match, in any order, so "firewall domain" finds a firewall profile with a changed domain profile setting. Upper and lower case do not matter.
* **All**, **Added**, **Modified** and **Deleted**: shows one change type. Each button shows how many changes it would show with the current search and policy type.
* **All policy types**: shows one policy type. This list appears when the result holds more than one type.

While a filter is active, the page shows how many of the changes are shown, for example "12 of 148 changes shown", with **Clear filters** next to it. When nothing matches, the page says **No changes match the filters**. The filters reset when you switch tenants.

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

<figure class="docs-screenshot">
  <a href="/images/screenshots/drift-results.webp" aria-label="Open full-size screenshot: drift results">
    <img src="/images/screenshots/drift-results.webp" alt="Drift results group added, modified and deleted policies, with filters for reviewing changes" width="2880" height="2000" loading="lazy" decoding="async" />
  </a>
  <figcaption>Drift results group added, modified and deleted policies, with filters for reviewing changes. Example comparison data. Select the image to view it full size.</figcaption>
</figure>

## What drift detection compares

* Types read in full by both backups. When either backup excluded a type or did not confirm a complete read, the results list it under **Types not compared** and leave it out of added, modified and deleted totals. See [What gets backed up](/backups/coverage/).
* Policy assignments are compared only when the policy type was read in full. If Microsoft Graph leaves assignments out of a policy response, TenuVault reads them separately where Graph supports it. A failed read or an assignment entry with a missing ID makes the type unread. A valid empty assignment list can show assignments that were removed.
* Changes to IDs, version numbers, creation and modification times, the description and the reference IDs of encrypted values are ignored.
* Items whose fingerprint (recorded in each backup) is the same in both backups are unchanged and are not read again, so comparisons of large tenants finish faster. Backups made by earlier versions without fingerprints are compared file by file.
* Lists of settings are matched by the setting itself, so an added, removed or reordered setting is reported as that setting, not as a change to every setting after it.
* Earlier TenuVault versions saved Settings Catalog policies (including endpoint security and Settings Catalog compliance policies) without their assignments. When the older backup comes from such a version, the assignments of these policies are not compared, so the first backup that includes them does not show every assigned policy as changed. Their settings are still compared.
* New policies whose name starts with **[Restored]** are reported as added and marked **Likely restored copy**. TenuVault creates copies with this prefix when you restore, and a policy created in Intune can carry the same prefix, so the result stays visible.

### Examples by service

For backups that record per-type outcomes, only complete reads are compared. For older backups, TenuVault uses the recorded scope and excludes types with known failures. If an older backup recorded a read failure without naming the type, the comparison shows a coverage warning. Some reported additions or deletions may be policies that backup failed to read.

| Service | Example of coverage shown as unknown |
| --- | --- |
| Defender | One backup could not read attack simulations. |
| Entra ID | One backup could not read named locations. |
| Intune | One backup left apps out of its scope. |

### Severity

Every change also has a severity. It appears in the exported report and in **Check all** on the Tenants page:

| Severity | When |
| --- | --- |
| Critical | A compliance policy was deleted, or a changed setting's name contains passwordRequired, encryption, jailbreak, firewall, antivirus, bitLocker or secureByDefault (**Mark devices with no compliance policy assigned as** in the compliance policy settings) |
| Warning | Any other deleted policy, or a changed compliance policy, device configuration profile or compliance policy settings |
| Info | Everything else |

On Community, a completed comparison shows a note only when at least one changed or deleted policy still has a Revert or Recreate action. Added policies, policies already reverted and changes caused by a revert are excluded from the count. The note says: **Pro reverts these {N} changed or deleted policies with one click and records the change in the audit log.** A **See plans** link appears beside it.

## Act on a change

For **modified** and **deleted** policies that were not reverted yet, the expanded card offers two actions:

| Button | What it does | Plans |
| --- | --- | --- |
| **Revert** (modified policies) | Puts the existing policy back to its backed-up version. The current settings are overwritten and reach devices at their next check-in. Assignments stay as they are. | Pro and MSP |
| **Recreate** (deleted policies) | Recreates the policy from the backup under its original name. Assignments are not restored. | Pro and MSP |
| **Restore previous version as copy** (modified policies) | Creates a new, unassigned policy with the "[Restored]" prefix and the backed-up settings. The current policy stays intact. | All plans |
| **Restore as copy** (deleted policies) | Creates the deleted policy again as a new, unassigned policy with the "[Restored]" prefix | All plans |

To run an action:

1. Click the action button.
2. Read the confirmation, which names the item and what will happen.
3. Click the confirming button to go ahead, or **Cancel**. It names the action: **Revert policy** or **Recreate policy** (shown in red, since they change the live policy), or **Create copy**.

A progress dialog shows each step: **Fetching policy from backup**, **Preparing policy data**, **Applying changes to the tenant** (or **Creating a policy in the tenant**), **Updating metadata** and **Refreshing drift detection**, which compares the same two backups again in the background. It cannot be cancelled once started. When it finishes, click **Done**, or the link to open the relevant admin center. If a step fails, the dialog shows **Operation Failed** with the reason.

TenuVault records every revert and restore in the tenant's backup storage, so the change is marked **Reverted** and its history shows in later results. Each action is also recorded in the [audit log](/audit-log/).

An action that Intune cannot run is greyed out and shows its reason under the buttons instead of failing halfway. The common case is a deleted app that uses an installer file, such as a Win32 or line-of-business app: the configuration backup holds only the app details, so neither **Recreate** nor **Restore as copy** is offered. If its supported Win32 installer was captured earlier, use [App Backup’s restore flow](/apps/app-backup/#restore-to-the-same-or-another-tenant) to create an unassigned app. Otherwise obtain and upload the original installer through Intune. A changed installer app can still be **Reverted** in place; only restoring it as a copy is unavailable. Store, web and Microsoft 365 apps need no installer and keep both actions. See [What cannot be restored](/restore/limitations/).

:::note
**Revert** and **Recreate** work with every backup that records this tenant, on this device or in your Azure storage account, after the same checks as a restore: the file must be listed in the backup's manifest and match its recorded fingerprint. A backup that does not record its tenant shows "This backup does not record its tenant. Restore it as a copy instead."; use **Restore previous version as copy** for it. An Azure backup that an earlier TenuVault version encrypted needs the recovery key of the device that made it; see [Older encrypted Azure backups](/security/encryption/#older-encrypted-azure-backups).

When TenuVault picks the two backups to compare, it skips backups it cannot open, such as older encrypted ones without their key. A backup you choose yourself that cannot be opened says why.
:::

For restoring several policies, choosing assignments or restoring into another tenant, use the restore wizard instead. See [Restore supported configuration](/restore/).

## Export a drift report

Click **Export** and choose:

* **CSV, one row per changed setting**: the columns Item, Item type, Change, Severity, Previous name, Setting, Setting path, Before and After, plus the policy's ID. Added and deleted policies get one row without a setting.
* **JSON**: the tenant, when the comparison ran, the two compared backups, the number of added, modified and deleted policies, files that could not be read, and every policy with its changed settings (readable values and the values as stored)

CSV and JSON include any types left out of the comparison and warn when an older backup could not identify the type of a failed read. You can export those notices even when the compared types show no changes. Drift alerts carry the same notices. Inventory stored in separate companion backups is outside the interactive policy comparison. Change reports show whether that inventory was compared.

The export holds the changes the page shows. While a filter is active, the menu says how many changes it exports, only those changes are written, the file name ends in `-filtered`, and the JSON file names the filter in its `filter` field, for example `search: firewall; change: modified`. Clear the filters to export every change.

The file is named after the tenant and the two compared backups, for example `drift-contoso-backup-2026-10-06-020000-to-backup-2026-10-07-020000.csv`. **Export** is unavailable when no drift was found or no change matches the filters.

## Check drift across tenants

With MSP, you can check all tenants at once:

1. Open **Tenants** and switch to the list view.
2. In the **Drift** column header, click **Check all**.

TenuVault compares each tenant's two newest complete backups, one tenant after another. This check does not change the result shown on the Drift Detection page. The **Drift** column then shows **No drift**, the number of changes and how many are critical, or **Not available** when the check failed (hover for the reason, for example when the tenant has fewer than two complete backups).

## Where drift appears elsewhere

Backup History uses the same comparison coverage as **View Changes**. When there are no confirmed changes and some types could not be compared, the history card says **No changes found in the types compared** and shows how many types were left out.

* The **Drift** tile on the [Dashboard](/tenants/#the-tenant-dashboard) shows when backups were last compared, and **Check drift** opens this page.
* Every comparison is recorded in the [audit log](/audit-log/) as "Detect drifts".

## Plan requirements

| Feature | Community | Pro | MSP |
| --- | --- | --- | --- |
| Drift detection and export | Yes | Yes | Yes |
| Restore a copy from a drift | Yes | Yes | Yes |
| **Revert** and **Recreate** | No | Yes | Yes |
| **Check all** across tenants | No | No | Yes |

## Related pages

* [Intune drift detection](https://www.tenuvault.com/intune-drift-detection): what drift detection catches, on the product site
* [Roll back an Intune policy change](https://www.tenuvault.com/guides/roll-back-intune-policy-change)
* [Intune audit logs and diffs or drift detection](https://www.tenuvault.com/compare/intune-drift-audit-logs-vs-backup-comparison): when audit logs are enough, on the product site
