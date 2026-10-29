---
title: "Audit log"
description: See what TenuVault did for a tenant, who did it and whether it worked, and export the history.
---

The audit log is TenuVault's own operation history. It is not a complete Microsoft tenant audit: it does not show changes made in the Intune admin center, by other tools or by other administrators. Use the Microsoft Entra and Intune audit logs for those.

The audit log records the actions TenuVault performs for a tenant: backups, downloads, restores, reverts, baseline deployments and change set applies and rollbacks. Each entry names the admin who was signed in, what was done, and whether it worked. The log is stored with the tenant's backups, in your own storage.

## What is recorded

| Action | Event type | Recorded when |
| --- | --- | --- |
| Start backup | BACKUP STARTED | You start a backup from the app, including **Backup Selected** |
| Scheduled backup | BACKUP COMPLETED, BACKUP FAILED or BACKUP CANCELLED | An automatic backup, or a backup started with **Back up all tenants now**, ends |
| Cancel backup | BACKUP_CANCELLED | You cancel an automatic backup, or one started with **Back up all tenants now**, before its manifest PUT starts |
| Download backup | BACKUP DOWNLOADED | You download a backup as a ZIP file |
| Restore backup as policy copies | RESTORE COMPLETED or RESTORE FAILED | A restore with **Create copies** ends |
| Restore backup in place | RESTORE COMPLETED or RESTORE FAILED | A restore with **Replace in place** ends |
| Revert policy to the backed-up version in place | POLICY REVERTED | **Revert** or **Recreate** on the Drift Detection page |
| Restore policy as an unassigned copy | POLICY RESTORED | **Restore as copy** or **Restore previous version as copy** on the Drift Detection page |
| Create unassigned baseline policy | POLICY CREATED | A policy is created from [Framework coverage](/baselines/frameworks/), one entry per policy |
| Deploy OpenIntuneBaseline policies | POLICY CREATED | An [OpenIntuneBaseline](/baselines/quick-start/) deployment ends, with the counts of created, updated, skipped and failed policies |
| Reset OpenIntuneBaseline policy drift | POLICY RESTORED | **Fix drift** in OpenIntuneBaseline Policy Validation ends |
| Undo OpenIntuneBaseline run | POLICY REVERTED | An OpenIntuneBaseline deployment or drift fix is undone |
| Apply change set | CHANGE_SET_APPLIED | An apply of a reviewed change set ends in promotion, a baseline upgrade, a custom baseline deployment or standard adoption, with the counts of verified, failed, uncertain and not attempted operations |
| Roll back change set | CHANGE_SET_ROLLED_BACK | An apply of a rollback change set ends, with the same operation counts |

Each entry has a result: **SUCCESS**, **FAILURE**, or **PARTIAL** for a cancelled backup or when a restore, deployment or change set apply worked for some items and not for others, or left an operation uncertain. It also has a severity: **INFO** for success and cancellation, **WARNING** for partial restores, deployments and change set applies, and **ERROR** for failures. A **BACKUP_CANCELLED** event records **PARTIAL** with **INFO**.

The user is the admin signed in to the tenant when the action ran. Read-only drift scans, including opening Drift Detection and **Check all**, no longer add audit events. Earlier drift check events remain readable.

:::note
Automatic backups that TenuVault refused to run because of the license are not in the audit log, because the tenant's storage is not opened without a license. They are listed on the **Schedule** tab. See [Schedule backups](/backups/schedules/#license-and-plan-checks).

Scheduled backups made by the optional [Backup Reader](/backups/backup-reader/) also add no entry here: the audit log is written with an admin's sign-in, and a Backup Reader run has none. Those runs are recorded in the backup's own metadata (`Trigger`, `AuthMode`, `RunId`). Their token requests can also appear in Entra ID under **Service principal sign-ins**, grouped and not one per backup (a cached token can serve several runs), so use the backup metadata to confirm a specific run.
:::

## Where the log is stored

The audit log lives in the tenant's backup storage, in a container named `audit-logs`, with one file per event grouped by UTC day:

* **This device:** encrypted like the backups.
* **Your Azure storage account:** stored as plain JSON. Anyone with read access to the container can read it.

Audit events are recorded for every plan. Viewing, exporting and cleaning them up needs Pro or MSP. Each event records the tenant it belongs to, and the app shows and exports only the selected tenant's events, even when several tenants share one Azure storage account. After a downgrade or when a license ends, the recorded history stays in the tenant's storage.

Backup retention does not delete audit events. If you change where a tenant's backups go, the audit log shown is the one in the newly selected storage.

Entries for policies created from Framework coverage are written to the audit log on this device, even when the tenant's backups go to Azure.

### Events that could not be saved yet

If TenuVault cannot write an event, for example because the storage is unreachable, it keeps the event and tries again each time the audit log is loaded, for example when you refresh the Audit Log page, up to 100 events at a time. The page then shows how many events remain unsaved:

* If they "are kept encrypted on this device", keep this installation until they are saved.
* If they "are held in memory for this session", keep TenuVault open until they are saved.

If an upgrade retries an event that was already saved, the table, totals and exports show it once.

## View the audit log

1. Select the tenant in the tenant switcher.
2. Open **Audit Log** in the sidebar.

The page shows, for the selected dates:

| Card | What it shows |
| --- | --- |
| **Total Events** | Number of events |
| **Success Rate** | Share of events with the result SUCCESS |

Below the cards, the table lists the events, newest first, with **Timestamp**, **Event** (type icon and severity), **User**, **Action**, **Resource** and **Result**. The table shows 50 events per page; use **Previous** and **Next**, or type a page number.

**Auto-refresh** is on by default and reloads the page every 30 seconds; the time of the last reload is shown next to it. **Refresh** reloads right away.

## Find events

* **Search**: type in **Search by user, action, or resource...** and click **Search**. The search also looks in each event's details.
* **From:** and **To:**: the date range. The default is the last 7 calendar days, including today. Dates use your local time zone and include the full first and last days, so today's events appear throughout the day. Each request can cover at most 90 days. To export a longer history, use separate ranges of up to 90 days.
* **Filters**: choose one or more values in **Event Type**, **Severity** and **Result**. Event types are limited to the backup, restore, policy and change set actions listed above. Severity offers **INFO**, **WARNING** and **ERROR**.

The cards, table and exports all follow the date range and filters. Picker dates are converted once from your local day to UTC instants. Stored paths and day listings use UTC, and entries are filtered by their event timestamp, so events near midnight are included correctly in every time zone. Older files grouped by local day remain readable.

Audit listings and event reads share a limit of six at a time per storage account, across log searches, totals and exports. The dashboard requests only its latest 20 matching events on Pro or MSP and skips audit history on Community. New event files carry their timestamp in the storage listing so the app can stop reading once the requested page is complete. Older files need an initial bounded read to establish event order; unchanged files are cached for subsequent refreshes. The event read cache keeps only the latest observed ETag for each file, counts serialized content and cache key bytes against a 32 MiB budget, and evicts the least recently used files. Search filters can require additional reads to find matching events. Exports and totals still include every match in the selected range.

## Export the audit log

1. Set the date range, search and filters you want.
2. Click **Export** and choose **Export as JSON** or **Export as CSV**.

The export holds every matching event of the selected tenant, not just the current page. The file is named `tenuvault-operation-history-` followed by the date, and you choose where it is saved.

* Both formats start with a notice that this is TenuVault's own operation history, the tenant, the export date and how many recorded events were still waiting to be saved (those are not in the export).
* **CSV** columns: Timestamp, Operation, Event type, Actor, Affected scope, Outcome, Severity, Correlation ID and Details. Actor shows "Not recorded" when the admin was not known; Outcome is Succeeded, Failed, Partial or Unknown.
* **JSON** contains the notice, the filter used and every event with its details.

Exports never contain tokens, credentials, client secrets or keys. Policy payloads, request bodies and stack traces in event details are omitted, and long text is shortened.

## Plan requirements

| Feature | Community | Pro | MSP |
| --- | --- | --- | --- |
| Events are recorded | Yes | Yes | Yes |
| View, search and export the audit log (JSON, CSV) | No | Yes | Yes |
| Remove entries older than 90 days | No | Yes | Yes |

On Community, the Audit Log page shows what the audit log includes, marked **Pro**, with **See plans**, instead of the events. Events recorded on Community stay in the tenant's storage and become visible after an upgrade.
