---
title: "Audit log"
description: See what TenuVault did for a tenant, who did it and whether it worked, and export the history.
---

The audit log is TenuVault's own operation history. It is not a complete Microsoft tenant audit: it does not show changes made in the Intune admin center, by other tools or by other administrators. Use the Microsoft Entra and Intune audit logs for those.

The audit log records the actions TenuVault performs for a tenant: backups, downloads, restores, reverts, baseline deployments and change set applies and rollbacks. Each job records what ran, which identity ran it and the result. The log is stored with the tenant’s backups, in your own storage.

## What is recorded

| Action | Event type | Recorded when |
| --- | --- | --- |
| Complete backup | BACKUP_COMPLETED, BACKUP_FAILED or BACKUP_CANCELLED | A manual, scheduled, tray, Backup Reader or cloud backup run ends |
| Start backup | BACKUP_STARTED | An earlier desktop version recorded the request to start a backup |
| Download backup | BACKUP DOWNLOADED | You download a backup as a ZIP file |
| Restore backup as policy copies | RESTORE COMPLETED or RESTORE FAILED | A restore with **Create copies** ends |
| Restore app backup | RESTORE_COMPLETED or RESTORE_FAILED | An [App Backup restore](/apps/app-backup/) records the app metadata and installer publication result |
| Restore backup in place | RESTORE COMPLETED or RESTORE FAILED | A restore with **Replace in place** ends |
| Revert policy to the backed-up version in place | POLICY REVERTED | **Revert** or **Recreate** on the Drift Detection page |
| Restore policy as an unassigned copy | POLICY RESTORED | **Restore as copy** or **Restore previous version as copy** on the Drift Detection page |
| Create unassigned baseline policy | POLICY CREATED | A policy is created from [Framework coverage](/baselines/frameworks/), one entry per policy |
| Deploy OpenIntuneBaseline policies | POLICY CREATED | An [OpenIntuneBaseline](/baselines/quick-start/) deployment ends, with the counts of created, updated, skipped and failed policies |
| Reset OpenIntuneBaseline policy drift | POLICY RESTORED | **Fix drift** in OpenIntuneBaseline Policy Validation ends |
| Undo OpenIntuneBaseline run | POLICY REVERTED | An OpenIntuneBaseline deployment or drift fix is undone |
| Apply change set | CHANGE_SET_APPLIED | An apply of a reviewed change set ends in promotion, a baseline upgrade, a custom baseline deployment or standard adoption, with the counts of verified, failed, uncertain and not attempted operations |
| Roll back change set | CHANGE_SET_ROLLED_BACK | An apply of a rollback change set ends, with the same operation counts |
| Approve change set | CHANGE_SET_APPROVED | A reviewer approves a change set's reviewed content and target state, with the recorded actor and decision. Nothing is written to the tenant |
| Reject change set | CHANGE_SET_REJECTED | A reviewer rejects a change set that was not applied, with the recorded actor and decision |
| Review hygiene finding | GOVERNANCE_FINDING_REVIEWED | A finding in Conflicts and hygiene is acknowledged, marked false positive, or reopened, with the decision |
| Document or revise customization | GOVERNANCE_CUSTOMIZATION_RECORDED | An organization customization is documented or revised in Governance, with its record reference |
| Retire customization | GOVERNANCE_CUSTOMIZATION_RETIRED | An organization customization is retired, with its record reference |
| Start standard adoption | GOVERNANCE_STANDARD_ADOPTED | An adoption of a golden standard is started for this customer tenant. Applying it later is recorded as a change set apply |

Each entry has a result: **SUCCESS**, **FAILURE**, or **PARTIAL** for a cancelled backup or when a restore, deployment or change set apply worked for some items and not for others, or left an operation uncertain. It also has a severity: **INFO** for success and cancellation, **WARNING** for partial restores, deployments and change set applies, and **ERROR** for failures. A **BACKUP_CANCELLED** event records **PARTIAL** with **INFO**.

Restore events can show changed top-level policy fields and verified Settings Catalog definition IDs. For in-place restores, the setting list shows the IDs that differ from the live policy. When Microsoft Graph cannot verify a definition ID, the event shows the parent settings field. Audit records field names and setting IDs, without their values.

The **User** column shows the signed-in administrator, Backup Reader service principal or cloud managed identity that ran the job. Read-only drift scans, including opening Drift Detection and **Check all**, no longer add audit events. Earlier drift check events remain readable.

:::note
Automatic backups that TenuVault refused to run because of the license are not in the audit log, because the tenant's storage is not opened without a license. They are listed on the **Schedule** tab. See [Schedule backups](/backups/schedules/#license-and-plan-checks).

Backup Reader and cloud backups record the same run ID in backup metadata and the audit event. Their Microsoft Entra sign-in histories can group several runs that reused a token.
:::

## Where the log is stored

The audit log lives in the tenant's backup storage, in a container named `audit-logs`, with one file per event grouped by UTC day:

* **This device:** encrypted like the backups.
* **Your Azure storage account:** stored as plain JSON. Anyone with read access to the container can read it.

Audit events are recorded for every plan. Viewing, exporting and cleaning them up needs Pro or MSP. Each event records the tenant it belongs to, and the app shows and exports only the selected tenant's events, even when several tenants share one Azure storage account. After a downgrade or when a license ends, the recorded history stays in the tenant's storage.

Backup retention does not delete audit events. If you change where a tenant's backups go, the audit log shown is the one in the newly selected storage.

Framework coverage policy creation records are written to the tenant’s configured storage. When Azure storage is shared, every producer with the audit writer role can read and add entries in that container. The app filters the selected tenant’s history by tenant ID.

### Events that could not be saved yet

If TenuVault cannot write an event, it keeps the event in a retry queue. The desktop retries in the background, including after restart. Refreshing **Audit Log** can retry pending desktop entries in the selected tenant. Backup Reader retries use the Reader registration that ran the backup. The page shows the number of events waiting for delivery:

* If they "are kept encrypted on this device", keep this installation until they are saved.
* If they "are held in memory for this session", keep TenuVault open until they are saved.

Replaying an event keeps its original ID and date. The table, totals and exports count it once. The backup outcome remains available while audit delivery is pending. For cloud jobs, check [cloud backup status and replay](/backups/cloud/#audit-events-and-replay).

## View the audit log

1. Select the tenant in the tenant switcher.
2. Open **Audit Log** in the sidebar.

The page shows, for the selected dates:

| Card | What it shows |
| --- | --- |
| **Total Events** | Number of events |
| **Success Rate** | Share of events with the result SUCCESS |

Below the cards, the table lists the events, newest first, with **Timestamp**, **Event** (type icon and severity), **User**, **Action**, **Resource** and **Result**. Change set and Governance decision entries link back to their deciding screen under the resource (**Open deciding screen**). Links from those screens (**View in Audit Log**) open this page with the search or event filter already applied. The table shows 50 events per page; use **Previous** and **Next**, or type a page number.

Open **Job details** on a restore to see its operation and run IDs, source backup, destination tenant and per-item outcomes. Created and updated items show the recorded fields for planned, applied or verified steps. Partial and pending items can have earlier applied steps. An unchanged item required no write. A skipped or unattempted item had no write dispatched. An uncertain item needs review in Intune. **Change details unavailable** appears when the event lacks evidence for a diff, including older restore entries.

Cross-tenant restores appear under each destination. Retry attempts have their own run IDs. Their operation ID relates them to the original restore, including Intune approval submission and completion. The approver is shown when Microsoft returns their identity. Raw justification text stays in Intune.

**Auto-refresh** is on by default and reloads the page every 30 seconds; the time of the last reload is shown next to it. **Refresh** reloads right away.

<figure class="docs-screenshot">
  <a href="/images/screenshots/audit-log.webp" aria-label="Open full-size screenshot: audit log">
    <img src="/images/screenshots/audit-log.webp" alt="Audit Log offers event filters, search and export for the selected tenant" width="2880" height="2000" loading="lazy" decoding="async" />
  </a>
  <figcaption>Audit Log offers event filters, search and export for the selected tenant. All entries here are example data. Select the image to view it full size.</figcaption>
</figure>

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
* **CSV** columns: Timestamp, Operation, Event type, Actor, Affected scope, Outcome, Severity, Correlation ID and Details. Actor shows “Not recorded” when the identity was unavailable. The job detail includes the producer, specific status and every item where recorded.
* **JSON** contains the notice, the filter used and every event with its details.

Exports include field names and setting definition IDs. Policy values, payloads, raw error messages, scripts, decision notes and request bodies are omitted. New events use the same daily format as earlier releases. Large jobs store detail pages with the root event so the job is counted once.

## Plan requirements

| Feature | Community | Pro | MSP |
| --- | --- | --- | --- |
| Events are recorded | Yes | Yes | Yes |
| View, search and export the audit log (JSON, CSV) | No | Yes | Yes |
| Remove entries older than 90 days | No | Yes | Yes |

On Community, the **Audit Log** entry in the sidebar and **View All Activity** on the dashboard show a **Pro** badge and still open the page. The Audit Log page shows what the audit log includes, marked **Pro**, with **See plans**, instead of the events. Events recorded on Community stay in the tenant's storage and become visible after an upgrade.

## Related pages

* [Intune audit logs or a backup](https://www.tenuvault.com/compare/intune-audit-logs-vs-intune-backup): what Microsoft's audit logs record and what they cannot restore, on the product site
* [Drift detection](/drift/)
