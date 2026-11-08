---
title: "Alerts"
description: Get backup, restore, drift, Intune and Conditional Access change alerts in Teams, by email or webhook, for the policies you pick, with the names of the settings that changed, on this computer or from Azure while it is off.
---

Notifications tell you when a backup fails or misses its time, when a restore only partly succeeds, when drift is found between backups, when something changed in Intune or Conditional Access, and when the Backup Reader certificate or the Azure watcher needs attention. You set them up on the **Alerts** page in the sidebar, for the tenant selected there. It has four tabs: **Alerts** (what is sent where), **Channels** (Teams, email, webhooks and this computer, with the Teams card layout), **Change watching** (the Intune and Conditional Access audit logs) and **Deliveries** (what was sent, failed or is waiting to retry). **Settings** > **Notifications** links there. Notifications are a Pro feature. Turning a channel off or removing it always works, on every plan.

Nothing is sent until you add a channel and an alert. A **channel** is a destination. An **alert** picks which events go to which channels, and for Intune and Conditional Access changes, which changes: for example only updates to one compliance policy, each in its own message with the names of the settings that changed.

**Fastest start: Set up alerts.** While a tenant cannot send yet, the **Alerts** tab starts with a setup card that says what is missing. **Set up alerts** walks through four short steps: where alerts go (this computer, a Teams channel, email, or a destination you already have), what should alert you (the recommended set is ticked: backup and restore problems, policies deleted or unassigned, and Conditional Access changes, but not successful backups), whether alerts should also run from Azure while this computer is off, and a review. **Turn on alerts** then creates the destination and the alerts, turns on the change watching they need (every 15 minutes, TenuVault's own changes ignored, who made a change not included) and sends one test message. Everything it creates is an ordinary channel, alert and change watching setting, editable in the same tabs at any time. Webhooks, group recipients, several destinations, one policy or one setting, and the Teams card layout stay one click deeper in those tabs, as described below. If a step fails halfway, the setup says what was already saved and trying again continues without duplicates: alerts it recognizes by their name are kept. A test that cannot be delivered, for example because `Mail.Send` is still missing, does not undo the setup.

For the recovery options behind restore alerts, see the overview of how to [restore Intune policies](https://www.tenuvault.com/intune-restore).

## Events

| Event | When it fires | Default severity |
| --- | --- | --- |
| Backup failed | A backup saved nothing, or could not be read | Critical |
| Backup completed with warnings | A backup saved policies but some items could not be read | Warning |
| Backup succeeded | A backup finished cleanly (opt in per alert) | Info |
| No recent backup | The Azure watcher finds no backup newer than your threshold (backups a cloud run reported as failed do not count) | Critical |
| Cloud backup failed, completed with warnings or succeeded | A [cloud backup](/backups/cloud/) run in Azure ends; the Azure watcher sends it on its next run | Critical, warning or info |
| Scheduled backup missed its time | TenuVault starts more than an hour after a scheduled backup was due (it was closed or the computer was off) and runs it now; once per slot | Warning |
| Restore completed, partial or failed | A restore finishes | Info, warning or critical |
| Drift detected | A drift scan finds changes between two backups | Warning when something was deleted, else info |
| Intune changes | Change watching sees new Intune audit events | Warning when something was deleted or unassigned, else info |
| Conditional Access changes | Change watching sees new Conditional Access policy, named location or authentication strength changes | Warning when something was deleted, else info |
| Backup Reader certificate expiring | A scheduled backup finds the Backup Reader certificate within 30 days of expiry; once at 30 days, at 7 days and when it expired | Warning at 30 days, then critical |
| Watcher stale | An Azure watcher owns change alerts and its heartbeat is older than 3 hours, or missing; once per stale period | Critical |

Health review findings keep their own endpoints on the Health review screen and are unchanged.

## Channels

### This computer

A system notification on this computer. It only appears while TenuVault runs, including in the tray.

### Webhook

TenuVault posts a signed JSON event to an https address you control, for example a ticketing system, Slack incoming webhook or your own automation. The body is one event object with the schema name `tenuvault.notification/v1`. It carries names, object ids, counts, statuses, timestamps and the names of changed settings. It never carries policy content, setting values, credentials or audit request bodies. The fields of change events are listed under [Webhook fields for changes](#webhook-fields-for-changes).

Two optional protections:

* A static secret header, sent with every request.
* Request signing: every request gets an `X-TenuVault-Timestamp` header (unix seconds) and an `X-TenuVault-Signature` header with the hex HMAC-SHA256 of `timestamp + "." + raw body`, keyed with your secret. Every request also carries `X-TenuVault-Event-Id`, the same `eventId` as in the body, so your receiver can drop duplicates.

Webhook addresses must be public https addresses. Localhost and private network addresses are refused. Only the address as written is checked; a public name that resolves to a private address is not detected.

### Teams channel (Workflows)

Teams notifications use a Workflows incoming webhook, the supported replacement for the retired Office 365 connectors:

1. In Teams, open the channel that should receive alerts, open its **Workflows** and choose the template that posts to the channel when a webhook request is received.
2. Name the workflow and copy its URL.
3. In TenuVault, add a **Teams** channel and paste the URL.

Messages arrive as an Adaptive Card posted by Workflows: a header tinted by severity (red for critical, amber for warning) with a **Critical**, **Warning** or **Info** label, then the event title, summary, details and changed items, with readable UTC times. Intune change digests end with an **Open the Intune admin center** button, a fixed Microsoft address like the one in email. Good to know: the workflow belongs to the person who created it and stops when that account is disabled, and tenant policies for the Workflows app can block it. If a test message fails, the channel shows the answer it got.

![An Intune change digest as a Workflows card in a Teams channel: an amber Warning header, twelve changes with who made them and when, and an Open the Intune admin center button](/images/notifications/notifications-teams.png)

![A Backup failed card in a Teams channel: a red Critical header, then the backup name, result, policies saved, item failures, failed types and trigger](/images/notifications/notifications-teams-backup.png)

### Teams card layout

**Teams card** on the **Channels** tab changes how alerts look in every Teams channel of the tenant. **Customize card** opens an editor with three columns: the parts of the card, the settings of the selected part, and a live preview drawn from the exact card Teams receives, with sample data (never your tenant's policies) in light and dark.

* **Parts:** the header (severity and title) is always first and the button always last. Summary, details, the changes list, a note and the footer can be dragged into any order, or moved with the arrow buttons or the keyboard (space, arrow keys, space), and each can be hidden with its eye.
* **Whole card:** header color (by severity, accent, neutral or green), comfortable or compact spacing, and readable or ISO times.
* **Header:** show severity as color and label, color only or label only, and an optional title prefix such as `[Production]`.
* **Title prefix, summary, note and button label** take your own text with placeholders: `{tenant}`, `{title}`, `{severity}`, `{eventType}`, `{count}` and `{occurredAt}`. An unknown placeholder blocks **Save card** and **Send test** until it is fixed. Line breaks and repeated spaces become one space, in the preview as in Teams. The note can show for every event, warnings and up, or critical only.
* **Details:** pick the rows to show. **Changes list:** 3, 5, 10 or 20 lines (the rest becomes "And N more"), one line each or the name with details below, and whether to show the type, who made the change and the time.
* **Button:** the matching admin center (Intune or Conditional Access changes), or always the Intune admin center or Conditional Access in Entra, with an optional label.
* **Per event type:** the tabs Backups, Restores, Drift, Changes and Alerts can each get their own layout; until then they use the default one.
* **Send test** sends a test card with the layout of the open tab as edited, before saving. **Reset to standard** goes back to the built-in card.
* Designing a layout is part of Pro. On the Community plan the editor opens read only, to view the saved layout, and **Reset to standard** stays available.

Teams refuses messages over 28 KB. A card that would be larger, for example a digest of twenty changes with very long policy names, is shortened instead of refused: change lines first (they become "And N more"), then detail rows from the end, then the summary. The size is judged both as UTF-8 and as UTF-16, because Microsoft does not say how it counts. The editor shows the size of the preview card and says when it was shortened, and the Azure watcher shortens the same way.

What a layout can never do: tenant text (policy names, tenant name, actor) is always plain text, so it cannot become a link or formatting; buttons only open the fixed Microsoft addresses above; and the card stays at Adaptive Card 1.4. A damaged or unknown setting falls back to the standard value instead of stopping a delivery.

For the Azure watcher, **Copy for Azure watcher** copies the layout as JSON. Save it as a file and pass it to the watcher setup with `-TeamsCardLayoutPath`; the watcher builds the identical card from it.

### Email

Email is sent through Microsoft Graph as the signed-in admin. It needs the optional delegated `Mail.Send` permission, and Entra group recipients also need `GroupMember.Read.All` and `User.Read.All`. A new app registration gets all three with `-IncludeNotifications` on the setup script. For an existing app registration, add the three delegated permissions to it in the Entra admin center and grant admin consent, then sign in to TenuVault again: running the script again would create a second app registration. See [Permissions](/security/permissions/). Without `Mail.Send`, email deliveries fail with a Graph permission error while other channels keep working.

Recipients can be:

* Email addresses, including distribution lists and Microsoft 365 group addresses. Exchange expands them. Note that a Microsoft 365 group only delivers to members who subscribed to group mail.
* An Entra group you pick or paste by object ID. Its members are resolved when the mail is sent, guests excluded, up to 200 people. Larger groups should use a distribution list address instead.

Mail arrives as HTML with a severity badge, one row per change with a colored verb marker (created, updated, deleted, assigned, unassigned), readable UTC times, and, for Intune change digests, a button into the Intune admin center. The same design is used by the desktop app and the Azure watcher. Links in mail are fixed Microsoft addresses chosen by TenuVault; links from tenant data are never rendered.

![An Intune change digest as HTML email with severity badge, verb markers and an admin center button](/images/notifications/notifications-email.png)

## Alerts

An alert has event types, a minimum severity and one or more channels. **Add alert** starts from a template, which fills in the dialog; everything stays editable:

* **Backup problems**: failed, partial and missed backups, and failed or partial restores.
* **Every Intune change, one by one**, **Compliance policy changes** and **Conditional Access changes**: change alerts that send each change on its own.
* **Deletions and removed assignments**: deleted policies and removed assignments in Intune and Conditional Access.
* **Everything critical**: every event type, at critical only.

You can add a channel from the dialog with **Add a channel**; it is saved right away and picked for the alert, so a first alert needs no trip to the **Channels** tab. Success events are best left out unless you really want them. Most tenants find them noise within a week.

An alert that cannot send changes says so on its row with **Not sending changes** and the reason: change watching is off for a service it listens to, the sign-in lacks `AuditLog.Read.All` for Conditional Access, the last check failed, or this computer is signed out of the tenant. A button fixes what can be fixed there, such as **Turn on Intune watching**. Saving a change alert while its watching is off offers to turn watching on with it.

**Alert me about changes to this policy** in [Drift detection](/drift/), and the bell next to a changed item in a backup's changes, open a new alert for that one policy, sending each of its changes on its own.

**Copy to other tenants** (MSP) copies alerts to other connected tenants. Each copy sends to that tenant's channels of the same kind: Teams to its Teams channels, email to its email channels. A tenant that already has an alert with the same name keeps its own, and a copy is turned off when the tenant has no matching channel yet.

**Check the last 7 days** in the alert dialog reads the Intune and Conditional Access audit logs and lists what the alert, as it is in the dialog, would have sent for the changes of the last week, planned per check interval as change watching would. Nothing is sent and the change watching positions do not move. It uses the change watching filters (audit categories and changes made by TenuVault itself) and needs a sign-in to the tenant.

**Send test** on an alert's row sends a made up change that passes the alert's filters to its channels, marked as a test, so you can see what the alert will look like. It is not queued and does not count as a real event.

Delivery is at least once. An undelivered notification stays queued, retries with backoff, and survives restarting the app. In the rare case a destination accepted a message but the confirmation was lost, the same event can arrive twice; the `eventId` is identical so receivers can dedupe. Recent deliveries, including failures and retries, are listed on the **Deliveries** tab, with a filter for failed, waiting and sent ones. **View** shows a delivery as it was sent: the email, the Teams card and the webhook JSON, built from the stored event. **Retry** sends a failed delivery again. A scheduled backup slot that fails on every retry sends one alert, not one per attempt, and backup alerts list the policies saved and the types that could not be read.

Channels and alerts can be edited with **Edit** on their row. A channel's URL and secret are never shown again: leave those fields empty to keep what is stored, or paste a new URL, for example after a Teams workflow was recreated. Alerts keep sending to the edited channel, and deliveries still queued go to the new address. Removing a channel that alerts use asks first and takes it out of those alerts; an alert left without any channel is turned off, not deleted.

### Which changes an alert sends

An alert that includes **Intune change** or **Conditional Access change** gets a **Which changes** section. Leave it empty and the alert sends every change, as before. **Policy names** and **Changed settings contain** each have a search box: the first lists the policies of the newest backup, the second the changed settings seen in recent alerts. Picking one adds it to the list. Each filter you fill in narrows the alert further, and a change has to pass all of them:

| Filter | A change passes when |
| --- | --- |
| Change types | It is one of the types you pick: created, updated, deleted, assigned, unassigned, or other changes |
| Intune categories | Its Intune audit category is one you pick, for example Compliance or Device configuration. Conditional Access changes have no category and always pass |
| Policy names | With **Contains** (the default), its policy or object name contains one of the entries, ignoring case, so a full name also picks any other policy whose name contains it. With **Exact name**, its name is one of the entries, ignoring case and spaces at either end, so only that policy passes. Renaming a policy stops exact alerts for it until you change the name in the alert. **Alert me about changes to this policy** in Drift detection and the backup changes view sets up an exact alert |
| Changed settings contain | One of the settings it changed contains one of the entries, ignoring case. Only updates name changed settings, so creates, deletes and assignments never pass |
| Never alert for changes by | It was not made by one of these user principal names or app names (exact, ignoring case), for example an automation account |

The filters apply to change events only. Other event types in the same alert, such as backup failed, are sent as usual.

Filters work on what change watching reads. The **Audit categories** in the change watching card decide what is read at all, so an alert cannot send a category that watching leaves out.

### One summary or one alert per change

**How to send** decides the shape of change alerts:

* **One summary per check** (the default): all matching changes of one poll in one message, with one line per change.
* **One alert per change**: each matching change in its own message, titled for example "Intune change: Windows compliance updated", with its type and category as details and the names of the settings that changed. Up to 20 per check; any more arrive together in one summary, so a bulk edit does not flood a channel.

Two alerts that pick the same changes send the same event, so a channel both use gets it once.

### Changed settings

For updates, alerts name the settings that changed, for example "Changed: PasswordRequired, BitLockerEnabled, OsMinimumVersion" for a compliance policy, or "Changed: conditions.users.excludeGroups, state" for a Conditional Access policy.

The audit log records each changed property of an update with its old and new value. TenuVault compares the two in memory and keeps only the names of the settings whose value differs. The values themselves are never stored, shown or sent, in the desktop app and in the Azure watcher alike. Bookkeeping fields such as the modified time and the version are left out.

What to expect:

* Creates, deletes and assignments list no settings: the audit log records every property for them, which says nothing about what changed.
* Settings catalog policies do not record their old values in the audit log, so their updates name no settings. The change itself is still sent.
* Conditional Access policies and named locations are named down to three levels, for example `conditions.users.excludeGroups`. A changed list counts as one setting.
* A message shows up to 15 setting names and counts the rest. **Changed settings contain** still matches every changed setting, not only the ones shown.

### Webhook fields for changes

Every line of a change event carries the same change as fields, in `items[].change`, so a receiver does not have to read the text:

```json
{
  "schema": "tenuvault.notification/v1",
  "type": "intune.change",
  "title": "Intune change: Windows compliance updated",
  "items": [
    {
      "title": "Updated: Windows compliance",
      "detail": "Windows10CompliancePolicy",
      "at": "2026-11-06T09:32:33.125Z",
      "change": {
        "auditId": "8c1f2d3e-0000-4000-8000-000000000001",
        "changeType": "updated",
        "category": "Compliance",
        "resourceId": "5b7e9a10-0000-4000-8000-000000000002",
        "resourceName": "Windows compliance",
        "resourceType": "Windows10CompliancePolicy",
        "settings": ["PasswordRequired", "BitLockerEnabled", "OsMinimumVersion"]
      }
    }
  ]
}
```

`resourceId` is the object id of the policy when the audit event carries one (authentication strength events do not name their strength, so they have none), `count` appears when repeated edits were collapsed into one line, and `settingsMore` counts changed settings beyond the names listed. A single change alert uses `change:<auditId>` as its natural key, so its `eventId` is the same whichever alert or watcher sends it.

## Change watching

Change watching reads audit logs through Microsoft Graph and hands new changes to your [alerts](#alerts), which send them as one summary per service and poll or one message per change. Pick the services on the **Change watching** tab: **Intune** (`intune.change` events) and **Conditional Access** (`entra.change` events). Both share the interval and the options below; each keeps its own position in its log.

For Intune, a digest lists what was created, updated, deleted, assigned or unassigned, the policy name when the audit event carries it, and who did it. Read-only audit events (views and searches) are not changes and never appear in a digest. A digest that contains a deletion or a removed assignment is sent with warning severity.

* On the desktop, watching runs while TenuVault is running and you are signed in. Default polling is every 15 minutes. After the app was closed with watching on, it catches up from where it left off; after a long gap the digest says older changes may be missing. Turning watching off and on again starts from that moment, so changes made while it was off are not sent as news.
* **Audit categories** limit what is watched at all to the categories you pick, from the list Intune itself reports (for example Device configuration, Compliance, Application, Role). Picking none watches every category. A category saved by an earlier version that Intune does not report is shown in amber so you can remove it: it would match no change.
* **Poll now** reads the audit log at once with the saved settings. It is unavailable while watching is off or while an Azure watcher owns change alerts for the tenant.
* Categories apply to Intune only.
* Changes made through TenuVault itself are ignored by default, so your own restores do not alert you.
* Repeated edits of the same policy by the same admin collapse into one line with a count, and a digest shows at most 20 lines plus a remainder count, so a bulk edit does not flood a channel.
* The watcher reads a fixed list of audit fields (ids, times, category, operation type, actor, resource names and ids, and for updates the changed properties). Changed property values are only compared to [name the settings that changed](#changed-settings) and are never kept or sent. Audit request bodies are never read.
* The actor name is personal data and is off by default. Turn it on only for destinations your policies allow it to reach. It applies to digests built after you save.
* When the [Azure watcher](#alerts-while-this-computer-is-off-the-azure-watcher) sends change alerts for a tenant, turn on **An Azure watcher owns change alerts for this tenant**. Desktop polling then stands down for that tenant, for Intune and Conditional Access alike, so each change is reported once instead of by both. If you watch Conditional Access on the desktop, set the watcher up with `-IncludeConditionalAccess` first; otherwise handing over stops Conditional Access alerts while the watcher's heartbeat still looks healthy. While it is on, TenuVault reads the watcher's `heartbeat.json` from the backup storage account every 30 minutes (with your sign-in) and sends a **Watcher stale** alert when the last run is more than 3 hours old or no heartbeat exists. The card shows when the watcher last ran, with **Check now**. A watcher whose runs fail still writes a heartbeat; those failures reach you through the Azure Monitor alert described below.

### Conditional Access changes

Conditional Access watching reads the Entra audit log (`auditLogs/directoryAudits`) for changes to Conditional Access policies and named locations, and to authentication strengths. Each line names the policy or location and what happened: created, updated or deleted. Authentication strength events in the Entra audit log do not name the strength, so those lines say "Authentication strength". A digest with a deletion is sent as a warning, and it ends with an **Open Conditional Access in Entra** button.

* It needs the delegated `AuditLog.Read.All` permission on the app registration: `-IncludeAuditLog` on a new one, or add it in Entra and grant admin consent. The signed-in admin also needs a role that can read audit logs, such as Security Reader, Global Reader or Reports Reader. Without them, the card shows the permission error and Intune watching keeps working. See [Permissions](/security/permissions/).
* Microsoft Graph includes the full policy before and after each change, and the admin's IP address, in every audit event. The IP address is never read. For updates, the two versions of the policy are compared in memory to [name the settings that changed](#changed-settings); the policy and its values are never kept or sent. Otherwise only ids, times, the activity, target names and, when you opt in, the actor are used.
* Failed attempts are not changes and are left out.

## Alerts while this computer is off: the Azure watcher

Desktop notifications stop when the computer is off, asleep or signed out. The Azure watcher closes that gap. It is a PowerShell runbook in an Azure Automation account in the customer tenant, running on a schedule with a managed identity and no stored secret. It watches the same Intune audit events (and, if you choose, Conditional Access changes) and checks the age of the newest backup folder in the backup storage account, then delivers to the same kinds of channels: webhook, Teams Workflows and email. The event content and the mail design are identical to the desktop app.

What it can and cannot see, plainly:

* It reads Intune audit events with the application permission `DeviceManagementApps.Read.All`.
* With `-IncludeConditionalAccess` it also reads Conditional Access changes from the Entra audit log with the application permission `AuditLog.Read.All` (granted by `-GrantGraphRoles`), keeping its own position in that log. IP addresses in those events are never read, and policy content is only compared to name the settings that changed, as on the desktop.
* It sends your [alerts](#alerts) when you copy them to it (see [Alerts in the watcher](#alerts-in-the-watcher)); without them every event goes to every destination it has.
* It alerts on the results of [cloud backups](/backups/cloud/): **Backup failed**, **Backup completed with warnings** and **Backup succeeded**, the same alerts the desktop app sends. Backups and their status are encrypted with your recovery key, which the watcher never has, so each cloud backup run leaves a small unencrypted result note in the `tenuvault-backup-results` container: status, backup folder name, policy and failure counts, the names of failed types, the run id and the time. Never policy content, policy names or error messages. The watcher turns the note into the alert and deletes it once the alert is queued. These alerts are not a complete run history: writing the note is best effort, so a run that cannot write it (for example after its storage role was removed) sends no result alert, and notes older than 7 days are deleted without an alert. A run that never finishes is still caught by **No recent backup**, and the runbook job history in the Automation account lists every run.
* It reads backup folder names to detect a missed backup, and leaves out folders a cloud backup reported as failed, so a cloud backup that fails every day still raises **No recent backup**. A failed backup made by the desktop app cannot be told apart by folder name; the desktop app alerts on those itself while it runs.
* It writes only to its own state container (`tenuvault-notification-state`), where it claims a lease on its state before sending so overlapping runs cannot send twice, and deletes the cloud backup result notes it has handled in `tenuvault-backup-results`. Its storage roles are **Storage Blob Data Reader** on `intune-backups` and **Storage Blob Data Contributor** on those two containers, each scoped to one container.
* Email from the watcher sends app-only from a mailbox you choose. Setup asks you to restrict that permission in Exchange to the one mailbox before the email channel is used.

The easiest setup is **Also from Azure, set up from TenuVault** in the third step of **Set up alerts** on the **Alerts** tab (it needs backups in your Azure storage account). Confirm the subscription, resource group, Automation account, region and failure-alert address, then choose **Check Azure**. The check is read-only: it confirms the subscription belongs to this tenant, finds the backup storage account and any watcher already pointing at it, and says what this sign-in may do. **Turn on alerts** then does the rest from the app. It finds the existing watcher or creates a new one with the template in the repository under `resources/notifications/azuredeploy.json`, writes your alerts to it, starts one run, and hands change alerts over only when a fresh heartbeat from that job and the selected watcher identity proves it read Graph and storage with exactly those alerts and no error. If a new Graph role assignment has not reached the identity yet, the setup leaves this computer in charge and checks later scheduled runs again while TenuVault runs. An existing watcher on a runbook older than 1.3.0 needs one rerun of the current setup script before this in-app hand-over, because older heartbeats do not say which identity and job produced them. Until hand-over this computer keeps watching, so one change can arrive twice during the short overlap. A Teams or webhook destination picked in the wizard can be copied into a newly created watcher as an encrypted Automation variable, with your tick. An existing watcher is never redeployed from the app, and its destination is never overwritten. If the Graph roles are missing and this sign-in cannot assign them, the setup stops with one short command block for a Global Administrator and a confirm button. You can close the dialog at any point: the card on the Alerts tab continues the same setup. Creating from the app needs the watcher in the storage account's resource group, and watcher email still starts with the script. Both stay under **Advanced: portal or script** in the same step, together with the **Deploy to Azure** portal button for a disconnected setup or another Azure owner. The template is for the first deployment only, whichever way it is submitted: redeploying it fails on the schedule link ids, which Azure refuses to reuse even unchanged, so make later changes with the setup script (it reconciles schedules and links), or delete the watcher schedules and their links in the Automation account before deploying again. The script path fills in everything it already knows: tenant, storage account, resource group, region and subscription, the failure-alert address you give it, `-GrantGraphRoles`, and `-IncludeConditionalAccess` when your alerts watch Conditional Access. It copies that command and both scripts for whoever can create Azure resources; no secret is ever on the command, so the watcher's own destination (its Teams Workflows URL, webhook URL, or mail sender and recipients) is a quoted placeholder: replace the text between the quotes before running it, because a watcher without a destination runs but delivers nothing. This-computer alerts have no watcher equivalent and never hand over. The setup prints a block marked "paste into TenuVault" at the end. Paste it under Advanced and choose **Use these details and verify from TenuVault**: the block only names the watcher, and a paste on its own never hands alerts over. The in-app setup then checks it, sends the alerts, runs it once and hands over only after the clean run, keeping it updated whenever an alert or channel changes. If a run did not grant the Graph roles (`graphRolesGranted=false`), the setup stops at that step with the commands for a Global Administrator. The watcher's own destinations (its Teams URL, webhook or mail sender) are still set with the setup parameters below or as Automation variables, and watcher email still needs the Exchange restriction and one-time verification described further down. Those two, creating the Teams Workflows URL in Teams, and granting the Graph roles are the parts no setup can click away.

Setup is two copy and paste scripts in the TenuVault repository under `resources/`: `New-TenuVaultNotificationWatcher.ps1` creates the Automation account, imports `runbooks/Invoke-TenuVaultNotificationCheck.ps1`, sets the schedule and storage roles, and with `-GrantGraphRoles` (Global Administrator) assigns the Graph application roles and prints a consent receipt, plus the block to paste back into TenuVault. Re-running the script upgrades the runbook in place. `-Remove` tears the schedule, runbook and variables down again and lists the app roles to revoke.

Costs are the Automation job minutes of short read-only runs in the customer subscription. The setup script prints the cadence it configured; start hourly and tighten only if the latency matters.

The watcher runs hourly by default; `-ScheduleIntervalHours` runs it less often. For changes that should arrive sooner, `-ScheduleIntervalMinutes 15`, `20` or `30` runs it every 15, 20 or 30 minutes. Azure Automation schedules run at most once an hour, so the script creates one hourly schedule per run in the hour, spread evenly: `TenuVaultNotificationCheck` plus `TenuVaultNotificationCheck-2` up to `-4`, all linked to the runbook. A rerun without `-ScheduleIntervalMinutes` goes back to one schedule and removes the extra ones, and `-Remove` deletes them all. Every 15 minutes means about 2,900 jobs a month, so compare the job minutes in the Automation account with the free monthly allowance of Azure Automation before you choose it. A run that starts while the previous one still holds the state lease exits without sending, so runs never overlap.

One full setup run looks like this. The storage account is the one from the backup setup, the resource group is created when it is missing (that is what `-Location` is for), and the script is safe to run again for upgrades:

```powershell
./New-TenuVaultNotificationWatcher.ps1 `
  -TenantId <tenant-guid> -StorageAccountName <backup-storage-account> `
  -ResourceGroupName rg-tenuvault-watchers -Location northeurope `
  -TeamsWebhookUrl <workflows-url> -AlertEmail you@example.com `
  -TeamsCardLayoutPath ./teams-card.json `
  -GrantGraphRoles -IncludeMailSend `
  -MailSender notifications@contoso.com `
  -MailRecipients team@contoso.com
```

### Alerts in the watcher

The watcher has its own destinations: one webhook, one Teams Workflows URL and one list of mail recipients, set with the setup parameters. Without alerts it sends every event to each of them. To make it send what your alerts send:

* While an Azure watcher owns the tenant, click **Update watcher** on the **Azure watcher** card of the **Alerts** tab. TenuVault writes your alerts to `alerts.json` in the `tenuvault-notification-state` container of the backup storage account, with your sign-in (your account needs Storage Blob Data Contributor there, which `New-TenuVaultStorage.ps1` grants to the admin group). The watcher reads the file at the start of every run, so the setup script does not run again. Turn on **Update the watcher whenever an alert or channel changes** and TenuVault writes the file again after each change that affects the watcher, also in tenants you copy alerts to. While you are signed out of a tenant it skips the write instead of asking you to sign in; the next change or **Update watcher** catches up.
* Or click **Copy for Azure watcher**, save the copied text as a file, and run the watcher setup with `-AlertRulesPath ./alerts.json`. The script checks the file before it changes anything in Azure and writes it to the same `alerts.json`.

Watchers set up with runbook 1.1.0 or older read their alerts only from the Automation variable `TenuVaultAlertRules`. Run the setup script of the current release once to upgrade the runbook; the card says so while an older runbook is reporting. After the upgrade the watcher prefers `alerts.json` and uses the variable only while no file exists. Setup with `-AlertRulesPath` empties the variable, so only one copy of the alerts remains.

The file holds the enabled alerts with their event types, minimum severity, filters and how to send. Channels become kinds of destinations: an alert that sends to a Teams channel sends to the watcher's Teams URL, an email channel to its mail recipients, a webhook to its webhook. Alerts that only send to **This computer** are left out, and the app says which. The file contains no URLs, addresses or secrets.

The watcher then plans alerts exactly like the desktop app: same filters, same summaries and single change alerts, same event ids. Backup results and **No recent backup** go to the destinations of the alerts that take their event type and severity; an event no alert takes is not sent. **Copy for Azure watcher** and the setup script both name the watcher events that no alert takes, so an alert set that only covers changes does not silently stop backup alerts. The **Azure watcher** card says whether the watcher runs the alerts on the page, from the alerts its last heartbeat reported: **Up to date**, **Waiting for its next run** after an update, **Not using the update** when the watcher ran after it but still reports other alerts (check its job output), **Needs an update**, or **Needs a setup rerun** for an older runbook, and **Not running** first whenever the heartbeat is stale. **Check now** reads the heartbeat again, for example after the watcher's next run. **Update watcher** refuses when no alert sends to a webhook, Teams or email channel, because the watcher would then send every event everywhere; that stays a choice you make in the setup. A rerun without `-AlertRulesPath` keeps the saved alerts, and `-AlertRulesPath ''` deletes `alerts.json`, so every event goes everywhere again. A file or value the runbook cannot read (also an empty file, or a storage error while reading it), or one without any alert it can use, does the same and says so in the job output, so a damaged file never silences the watcher and never brings back older alerts.

### If the watcher itself breaks

A watcher that fails silently would defeat its purpose, so setup refuses to guess about failure reporting. Pass `-AlertEmail` and the script creates an Azure Monitor action group and a metric alert on failed Automation jobs in the watcher resource group, so a broken watcher emails you through Azure Monitor, independent of the runbook itself. Passing `-NoFailureAlert` is the explicit opt-out. Successful runs also write `heartbeat.json` (last run time, watermark, last error, and which alerts it runs) into the state container. A fresh heartbeat is the quickest health check. A stale one only means there is no recent health evidence: a watcher that lost storage access keeps failing without updating it, so check the Automation account's job history to see whether runs happen and how they fail.

Two setup errors worth knowing before you meet them:

* `Conflict` while creating the Automation account usually means the regional Automation account quota (as low as 2 accounts per region on many subscription types) or the account name being taken in that region. Run again with another `-Location` or `-AutomationAccountName`.
* A run that reports a missed backup check failure after listing the storage account is a real storage or role problem. The message includes the storage answer; check that the identity still has its three container-scoped roles (reader on `intune-backups`, contributor on `tenuvault-notification-state` and `tenuvault-backup-results`) and that they are permanently active, not PIM-eligible.
* A run that fails with "Cloud backup results could not be read" means the watcher cannot reach `tenuvault-backup-results`, usually because it was set up before cloud backup alerts existed. Run the watcher setup again; it creates the container and grants the role.

### Watcher email and the one-time verification

The watcher sends mail app-only with the `Mail.Send` application permission. On its own that permission could send as any mailbox, so the watcher refuses to use it until you prove from the receiving side that Exchange restricts it. Setup can grant the role (`-IncludeMailSend -GrantGraphRoles`), but the restriction and the proof are yours to run once:

1. Create a mail-enabled security group containing only the sender mailbox, then restrict the watcher identity to it in Exchange Online PowerShell: `New-ApplicationAccessPolicy -AppId <watcher identity application id> -PolicyScopeGroupId <group> -AccessRight RestrictAccess`. Setup prints the identity's principal (object) id, which is not the application id Exchange wants. Get the application id from that principal id in Microsoft Graph PowerShell with `(Get-MgServicePrincipal -ServicePrincipalId <principal id>).AppId`, or in the Entra admin center under Enterprise applications on the identity's page.
2. Set `-MailSender` to that mailbox and `-MailProbeMailbox` to a second mailbox that is outside the group.
3. Start the runbook once with the `VerifyMailOnly` parameter set. It sends a short verification mail as the sender (must succeed), then attempts to send as the probe mailbox (must be rejected with HTTP 403). Only then does it record `mailVerified` in `state.json`, and normal runs start delivering mail. The verification expires after 90 days, and changing the sender requires a new one; normal runs say so in their output and skip mail until it passes again.

Plan for Exchange propagation: a brand-new access policy and scope group can take hours before app-only sending is actually allowed for the in-scope mailbox. During that window verification fails with `ErrorAccessDenied ... [RAOP] Blocked by tenant configured AppOnly AccessPolicy settings`. First rule out the configuration causes with the same error text: the sender mailbox is really a member of the scope group, the policy uses the identity's application id (not its principal id), and `Test-ApplicationAccessPolicy` says Granted for the sender and Denied for an outside mailbox. If all of that reads correctly, what remains is propagation. Do not rebuild the policy then; rebuilding restarts the wait. Re-run the verification later the same day or the next morning.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Test message fails with a Graph permission error on email | The app registration lacks `Mail.Send`. Add the delegated `Mail.Send` permission (and `GroupMember.Read.All` and `User.Read.All` for group recipients) to the existing app registration, grant admin consent and sign in again. |
| Teams test returns an error from the workflow | The workflow was deleted, its owner left, or a tenant policy blocks Workflows webhooks. Recreate the workflow, then **Edit** the channel and paste the new URL. |
| No Intune change digests | Watching is off, you are signed out, an Azure watcher owns change alerts for the tenant, the picked audit categories do not include the change, or the change was made through TenuVault and is ignored. The watch card shows the last poll and its error. |
| An alert sends no changes | Its filters exclude them. Check the alert's **Which changes** section: with **Changed settings contain** filled in, only updates pass, and settings catalog updates name no settings. Use **Send test** to see the alert's shape. |
| A change alert lists no changed settings | The change is a create, delete or assignment, or a settings catalog policy, whose audit events do not record old values. |
| The Azure watcher ignores my alerts | Click **Update watcher** on the **Azure watcher** card, then **Check now** after its next run. If the card says **Needs a setup rerun**, run the current watcher setup once to upgrade the runbook. The job output says how many alerts it read and from where, or that they could not be read. |
| **Update watcher** says the account cannot write | Your account needs Storage Blob Data Contributor on the backup storage account, which `New-TenuVaultStorage.ps1` grants to the admin group. Or copy the alerts and rerun the setup with `-AlertRulesPath`. |
| Every change arrives twice | Both the desktop and the Azure watcher report changes. Turn on **An Azure watcher owns change alerts for this tenant** on the desktop. |
| The same alert arrived twice | A delivery succeeded but its confirmation was lost and the queue retried. The `eventId` is the same; this is expected at-least-once behaviour. |
| Webhook URL refused | Only public https addresses are allowed, without credentials in the URL. |
| Watcher mail verification fails with `ErrorAccessDenied ... [RAOP]` | The Exchange application access policy or its scope group has not propagated yet, or the sender mailbox is not in the scope group. Wait and re-run verification; see the watcher email section above. |
| Conditional Access watching fails with a 403 | The app registration lacks the delegated `AuditLog.Read.All` permission, or your account has no role that can read audit logs. Add the permission in Entra, grant admin consent, use a role such as Security Reader and sign in again. |
| A **Watcher stale** alert arrived | The Azure watcher has not written a heartbeat for 3 hours: its schedule stopped, the Automation account was removed, or it lost access to storage. Open the Automation account's job history. |
| Watcher output says mail delivery is skipped | Mail was never verified for this sender, the sender changed, or the verification is older than 90 days. Run the runbook once with `VerifyMailOnly`. |
| Automation account creation fails with `Conflict` | Regional Automation account quota or name taken. Retry setup with another `-Location` or `-AutomationAccountName`. |
| Azure Monitor reports failed watcher jobs | Open the newest job in the Automation account. The exception names the step; `heartbeat.json` in the state container shows the last error and watermark. |
