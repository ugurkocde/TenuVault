---
title: "Notifications"
description: Get backup, restore, drift and Intune change alerts in Teams, by email or webhook, on this computer or from Azure while it is off.
---

Notifications tell you when a backup fails, when a restore only partly succeeds, when drift is found between backups, and when something changed in your Intune tenant. You set them up per tenant under **Settings**, in the **Notifications** section. Notifications are a Pro feature. Turning a channel off or removing it always works, on every plan.

Nothing is sent until you add a channel and a rule. A **channel** is a destination. A **rule** picks which events go to which channels.

## Events

| Event | When it fires | Default severity |
| --- | --- | --- |
| Backup failed | A backup saved nothing, or could not be read | Critical |
| Backup completed with warnings | A backup saved policies but some items could not be read | Warning |
| Backup succeeded | A backup finished cleanly (opt in per rule) | Info |
| No recent backup | The Azure watcher finds no backup newer than your threshold | Critical |
| Restore completed, partial or failed | A restore finishes | Info, warning or critical |
| Drift detected | A drift scan finds changes between two backups | Warning when something was deleted, else info |
| Intune changes | The change watcher sees new Intune audit events | Warning when something was deleted, else info |

Health review findings keep their own endpoints on the Health review screen and are unchanged.

## Channels

### This computer

A system notification on this computer. It only appears while TenuVault runs, including in the tray.

### Webhook

TenuVault posts a signed JSON event to an https address you control, for example a ticketing system, Slack incoming webhook or your own automation. The body is one event object with the schema name `tenuvault.notification/v1`. It carries names, counts, statuses and timestamps only. It never carries policy content, credentials or audit details such as changed setting values.

Two optional protections:

* A static secret header, sent with every request.
* Request signing: every request gets an `X-TenuVault-Timestamp` header (unix seconds) and an `X-TenuVault-Signature` header with the hex HMAC-SHA256 of `timestamp + "." + raw body`, keyed with your secret. Every request also carries `X-TenuVault-Event-Id`, the same `eventId` as in the body, so your receiver can drop duplicates.

Webhook addresses must be public https addresses. Localhost and private network addresses are refused. Only the address as written is checked; a public name that resolves to a private address is not detected.

### Teams channel (Workflows)

Teams notifications use a Workflows incoming webhook, the supported replacement for the retired Office 365 connectors:

1. In Teams, open the channel that should receive alerts, open its **Workflows** and choose the template that posts to the channel when a webhook request is received.
2. Name the workflow and copy its URL.
3. In TenuVault, add a **Teams** channel and paste the URL.

Messages arrive as an Adaptive Card posted by Workflows, with the event title, summary, details and changed items. Good to know: the workflow belongs to the person who created it and stops when that account is disabled, and tenant policies for the Workflows app can block it. If a test message fails, the channel shows the answer it got.

### Email

Email is sent through Microsoft Graph as the signed-in admin. It needs the optional `Mail.Send` permission: re-run the app registration script with `-IncludeNotifications` to add it, see [Permissions](/security/permissions/). Without it, email deliveries fail with a Graph permission error while other channels keep working.

Recipients can be:

* Email addresses, including distribution lists and Microsoft 365 group addresses. Exchange expands them. Note that a Microsoft 365 group only delivers to members who subscribed to group mail.
* An Entra group you pick or paste by object ID. Its members are resolved when the mail is sent, guests excluded, up to 200 people. Larger groups should use a distribution list address instead.

## Rules

A rule has event types, a minimum severity and one or more channels. A useful starting point:

* One rule for backup failed, backup warnings, restore failures and drift, at info and above, to your Teams channel and email.
* Success events only if you really want them. Most tenants find them noise within a week.

Delivery is at least once. An undelivered notification stays queued, retries with backoff, and survives restarting the app. In the rare case a destination accepted a message but the confirmation was lost, the same event can arrive twice; the `eventId` is identical so receivers can dedupe. Recent deliveries, including failures and retries, are listed under the channels.

## Intune change watching

Change watching reads the Intune audit log through Microsoft Graph and digests new events into one `intune.change` message per poll: what was created, updated, deleted or assigned, the policy name when the audit event carries it, and who did it.

* On the desktop, watching runs while TenuVault is running and you are signed in. Default polling is every 15 minutes. After the app was closed it catches up from where it left off; after a long gap the digest says older changes may be missing.
* Changes made through TenuVault itself are ignored by default, so your own restores do not alert you.
* Repeated edits of the same policy by the same admin collapse into one line with a count, and a digest shows at most 20 lines plus a remainder count, so a bulk edit does not flood a channel.
* The watcher reads a fixed list of audit fields (ids, times, category, operation type, actor, resource names). Audit request bodies and changed setting values are never read or sent.
* The actor name is personal data and is off by default. Turn it on only for destinations your policies allow it to reach.

## Alerts while this computer is off: the Azure watcher

Desktop notifications stop when the computer is off, asleep or signed out. The Azure watcher closes that gap. It is a PowerShell runbook in an Azure Automation account in the customer tenant, running on a schedule with a managed identity and no stored secret. It watches the same Intune audit events and checks the age of the newest backup folder in the backup storage account, then delivers to the same kinds of channels: webhook, Teams Workflows and email. The event content is identical; watcher email is plain text instead of the desktop HTML layout.

What it can and cannot see, plainly:

* It reads Intune audit events with the application permission `DeviceManagementApps.Read.All`.
* It reads backup folder names to detect a missed backup. Backup content and backup status details are encrypted with your recovery key, which never leaves your computer, so the watcher reports missed backups by age, while success and failure detail comes from the desktop app.
* It writes only to its own state container (`tenuvault-notification-state`) and claims a lease on its state before sending, so overlapping runs cannot send twice.
* Email from the watcher sends app-only from a mailbox you choose. Setup asks you to restrict that permission in Exchange to the one mailbox before the email channel is used.

Setup is two copy and paste scripts in the TenuVault repository under `resources/`: `New-TenuVaultNotificationWatcher.ps1` creates the Automation account, imports `runbooks/Invoke-TenuVaultNotificationCheck.ps1`, sets the schedule and storage roles, and with `-GrantGraphRoles` (Global Administrator) assigns the Graph application roles and prints a consent receipt. Re-running the script upgrades the runbook in place. `-Remove` tears the schedule, runbook and variables down again and lists the app roles to revoke.

Costs are the Automation job minutes of short read-only runs in the customer subscription. The setup script prints the cadence it configured; start hourly and tighten only if the latency matters.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Test message fails with a Graph permission error on email | The app registration lacks `Mail.Send`. Re-run it with `-IncludeNotifications` and sign in again. |
| Teams test returns an error from the workflow | The workflow was deleted, its owner left, or a tenant policy blocks Workflows webhooks. Recreate the workflow and paste the new URL. |
| No Intune change digests | Watching is off, you are signed out, or changes were made through TenuVault and are being ignored. The watch card shows the last poll and its error. |
| The same alert arrived twice | A delivery succeeded but its confirmation was lost and the queue retried. The `eventId` is the same; this is expected at-least-once behaviour. |
| Webhook URL refused | Only public https addresses are allowed, without credentials in the URL. |
