---
title: "Audit log"
description: See what TenuVault did for a tenant, who did it and whether it worked, and export the history.
---

The audit log is TenuVault's own operation history. It is not a complete Microsoft tenant audit: it does not show changes made in the Intune admin center, by other tools or by other administrators. Use the Microsoft Entra and Intune audit logs for those.

The audit log records the actions TenuVault performs for a tenant: backups, downloads, drift checks, restores, reverts and baseline deployments. Each entry names the admin who was signed in, what was done, and whether it worked. The log is stored with the tenant's backups, in your own storage.

## What is recorded

| Action | Event type | Recorded when |
| --- | --- | --- |
| Start backup | BACKUP STARTED | You start a backup from the app, including **Backup Selected** |
| Scheduled backup | BACKUP COMPLETED or BACKUP FAILED | An automatic backup, or a backup started with **Back up all tenants now**, ends |
| Download backup | BACKUP DOWNLOADED | You download a backup as a ZIP file |
| Detect drifts | POLICY DRIFT DETECTED | Drift detection runs, including **Check all** on the Tenants page |
| Restore backup as policy copies | RESTORE COMPLETED or RESTORE FAILED | A restore with **Create copies** ends |
| Restore backup in place | RESTORE COMPLETED or RESTORE FAILED | A restore with **Replace in place** ends |
| Revert policy to the backed-up version in place | POLICY REVERTED | **Revert** or **Recreate** on the Drift Detection page |
| Restore policy as an unassigned copy | POLICY RESTORED | **Restore as copy** or **Restore previous version as copy** on the Drift Detection page |
| Create unassigned baseline policy | POLICY CREATED | A policy is created from [Framework coverage](/baselines/frameworks/), one entry per policy |
| Deploy OpenIntuneBaseline policies | POLICY CREATED | An [OpenIntuneBaseline](/baselines/quick-start/) deployment ends, with the counts of created, updated, skipped and failed policies |
| Reset OpenIntuneBaseline policy drift | POLICY RESTORED | **Fix drift** in OpenIntuneBaseline Policy Validation ends |
| Undo OpenIntuneBaseline run | POLICY REVERTED | An OpenIntuneBaseline deployment or drift fix is undone |

Each entry has a result: **SUCCESS**, **FAILURE**, or **PARTIAL** when a restore or deployment worked for some items and not for others. It also has a severity: **INFO** for success, **WARNING** for partial results and **ERROR** for failures.

The user is the admin signed in to the tenant when the action ran.

:::note
Automatic backups that TenuVault refused to run because of the license are not in the audit log, because the tenant's storage is not opened without a license. They are listed on the **Schedule** tab. See [Schedule backups](/backups/schedules/#license-and-plan-checks).
:::

## Where the log is stored

The audit log lives in the tenant's backup storage, in a container named `audit-logs`, with one file per event grouped by day:

* **This device:** encrypted like the backups.
* **Your Azure storage account:** stored as plain JSON. Anyone with read access to the container can read it.

Audit events are recorded for every plan. Viewing, exporting and cleaning them up needs Pro or MSP. Each event records the tenant it belongs to, and the app shows and exports only the selected tenant's events, even when several tenants share one Azure storage account. After a downgrade or when a license ends, the recorded history stays in the tenant's storage.

Backup retention does not delete audit events. If you change where a tenant's backups go, the audit log shown is the one in the newly selected storage.

Entries for policies created from Framework coverage are written to the audit log on this device, even when the tenant's backups go to Azure.

### Events that could not be saved yet

If TenuVault cannot write an event, for example because the storage is unreachable, it keeps the event and tries again each time the audit log is loaded, for example when you refresh the Audit Log page, up to 100 events at a time. The page then shows how many events remain unsaved:

* If they "are kept encrypted on this device", keep this installation until they are saved.
* If they "are held in memory for this session", keep TenuVault open until they are saved.

## View the audit log

1. Select the tenant in the tenant switcher.
2. Open **Audit Log** in the sidebar.

The page shows, for the selected dates:

| Card | What it shows |
| --- | --- |
| **Total Events** | Number of events |
| **Success Rate** | Share of events with the result SUCCESS |
| **Critical Events** | Reserved for critical events. No current action records one, so it shows 0 |
| **Security Alerts** | Reserved for security and critical events. No current action records one, so it stays empty |

Below the cards, the table lists the events, newest first, with **Timestamp**, **Event** (type icon and severity), **User**, **Action**, **Resource** and **Result**. The table shows 50 events per page; use **Previous** and **Next**, or type a page number.

**Auto-refresh** is on by default and reloads the page every 30 seconds; the time of the last reload is shown next to it. **Refresh** reloads right away.

## Find events

* **Search**: type in **Search by user, action, or resource...** and click **Search**. The search also looks in each event's details.
* **From:** and **To:**: the date range. The default is the last 7 days.
* **Filters**: choose one or more values in **Event Type**, **Severity** and **Result**.

The cards, table and exports all follow the date range and filters.

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
