---
title: "Change reports"
description: A report of what changed in Intune between two backups, setting by setting, with who made each change. Save it as PDF, Markdown or JSON, or have it sent by email after every scheduled backup.
---

A change report documents what changed in a tenant between two backups: every added, changed and deleted item, the settings that changed with their old and new values, the settings of new and deleted items (up to 300 per item), and who made each change according to the Intune and Entra audit logs. Reports are made from your backups and the audit logs only. Nothing in the tenant is changed.

Open **Reports** in the sidebar. The page works on the tenant selected in the tenant switcher.

## What your plan includes

| Feature | Community | Pro | MSP |
| --- | --- | --- | --- |
| Generate change reports | No | Yes | Yes |
| Save as PDF, Markdown or JSON | No | Yes | Yes |
| Send by email, on demand or after every scheduled backup | No | Yes | Yes |
| PDF with your logo and colors | No | Yes, with [PDF branding](/settings/#pdf-branding) | Yes, with [PDF branding](/settings/#pdf-branding) |

Reports generated on a paid plan stay readable and can still be saved as PDF, Markdown or JSON after a downgrade. See [Plans and features](/licensing/).

## Generate a report

1. Open **Reports**.
2. Under **New change report**, choose the period:
   * **Since the previous backup**: the newest complete backup compared with the one before it.
   * **Last 7 days** or **Last 30 days**: the newest complete backup compared with the newest complete backup at least that many days older. When the history is shorter, the oldest complete backup is used.
   * **Choose two backups**: pick the older and the newer backup yourself.
3. Click **Generate report**.

The report runs in the background and shows in the activity panel, so you can open another page meanwhile. It needs two complete backups. Backups that failed, are still running or completed with warnings are not offered by the first three periods; with **Choose two backups** you can pick a backup that completed with warnings, and items it could not read may then show as deleted or added.

## Read a report

Click a report in the **Reports** list to open it. It has these parts, in the app and in every saved format:

* **Summary**: how many items were changed, added and deleted, and how many of them have matching audit events.
* **Deleted**: each deleted item with the settings it had, and the backup that still holds it, so you can [restore](/restore/) it.
* **Changed**: each changed item with the settings that changed, before and after. A renamed item shows its previous name.
* **Added**: each new item with the settings it has, including its assignments.
* **Other activity**: audit events in the same period that match no item in the report. This is where you see a change that was made and undone between the two backups, or a change to something TenuVault does not back up.
* **Not compared**: files that could not be read and were left out.

Each item lists at most 300 settings. An item with more says how many are not listed; the backup itself holds the full item.

Under each item, the report lists the audit events about it: what was done, by whom and when, for example "Updated by admin@contoso.com, 6 Nov 2026, 14:02 UTC (Intune: Patch DeviceConfiguration)". Times are in UTC, so a report reads the same wherever it is opened.

The settings use the same readable names and values as [drift detection](/drift/). Assignments name the group by its object ID. Secret values, such as passwords, keys and encrypted OMA-URI values, are never shown: a changed secret appears as one **Secret values** row without its value.

## Who made a change

TenuVault reads the audit events between the times the two backups started and matches them to the report's items by the object's ID. When an event names no ID, it is matched by the item's name.

* Intune changes come from the Intune audit log, which TenuVault can already read with its standard permissions. Your account needs an Intune role that can read audit logs.
* Conditional Access changes come from the Entra audit log, which needs the optional delegated `AuditLog.Read.All` permission. It is only read when the report contains Conditional Access policies, named locations or authentication strengths. Without the permission, those items have no actors and the report says why. See [Permissions](/security/permissions/).
* Intune and Entra keep audit events for a limited time, so reports of older backups can have fewer matching events.
* A change made during a backup can appear in the audit events of one report and in the item changes of the next.

When the audit log cannot be read at all, the report is still made and says that who made the changes is unknown, and why. In the app, a throttled read (429) suggests generating the report again in a few minutes. [Cloud backup reports](/backups/cloud/#change-reports-by-email) arrive by email instead, so they only name the reason, for example "Microsoft Graph throttled the Intune audit log request."

## Save a report

Open a report and click **PDF**, **Markdown** or **JSON**:

* **PDF**: a printable document for auditors and change review. With [PDF branding](/settings/#pdf-branding) it carries your company name, logo and colors and does not mention TenuVault.
* **Markdown**: for a wiki, a Git repository or another tool. Text from the tenant is escaped, so policy names cannot add links or HTML.
* **JSON**: the full report as stored, for automation.

The newest 12 reports per tenant are kept on this computer, encrypted with the other app data. **Remove** deletes one.

## Send reports by email

Email is sent through Microsoft Graph as the signed-in admin, like [email notifications](/notifications/#email). It needs the optional delegated `Mail.Send` permission; see [Permissions](/security/permissions/).

1. Under **Email and automation**, enter the **Recipients**: any email address, inside or outside your organization, or a distribution list. Separate addresses with commas.
2. Click **Save recipients**.
3. Open a report and click **Send by email**.

The message shows the summary and the first 20 changes, with the report attached as a PDF or as Markdown (**Attach as**). A PDF too large to send in one message is replaced by the Markdown file; when that is too large as well, the message says to open the report in TenuVault. A copy is kept in the signed-in admin's Sent Items. Every send is recorded in the [audit log](/audit-log/) as **Send change report**, with the number of recipients.

### Choose what recipients see

* **Show setting values**: turn this off to list which settings changed without their values, for example for recipients outside your organization.
* **Name who made each change**: turn this off to leave admin names out. Names are personal data; send them only where your policies allow.

Both apply to reports generated after you change them.

## A report after every scheduled backup

Turn on **Make a report after every scheduled backup and send it**. After each scheduled backup that completes, TenuVault compares it with the backup before it, saves the report and sends it to the recipients.

* With **Send nothing when nothing changed** on (the default), a report with no changes is saved but not sent.
* A backup that completed with warnings is not compared, so it gets no report.
* Without recipients, reports are saved but not sent.
* The outcome of the last automatic report shows under **Email and automation**.

Like the scheduled backups themselves, this runs only while TenuVault is running on this computer, and it needs your sign-in to the tenant: a backup made with the [Backup Reader](/backups/backup-reader/) still gets a report only while you are signed in.

## Reports for cloud backups

[Cloud backups](/backups/cloud/) that run in Azure can produce the same report with no computer on: the backup runbook builds it and the [Azure watcher](/notifications/#alerts-while-this-computer-is-off-the-azure-watcher) emails it, with the report attached as HTML and Markdown. The content is the same as in the app, apart from the wording of the audit log note described above. Those reports are emailed only; they do not appear in the **Reports** list. See [Change reports by email](/backups/cloud/#change-reports-by-email) for how to turn them on and what to know first.

## Related pages

* [Compare backups](/backups/compare/): the changes of one backup in Backup History
* [Drift detection](/drift/): act on recent changes, with revert and restore
* [Notifications](/notifications/): alerts and Intune change digests in Teams, email or webhooks
