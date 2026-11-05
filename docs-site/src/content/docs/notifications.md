---
title: "Notifications"
description: Get backup, restore, drift, Intune and Conditional Access change alerts in Teams, by email or webhook, on this computer or from Azure while it is off.
---

Notifications tell you when a backup fails or misses its time, when a restore only partly succeeds, when drift is found between backups, when something changed in Intune or Conditional Access, and when the Backup Reader certificate or the Azure watcher needs attention. You set them up per tenant under **Settings**, in the **Notifications** section. Notifications are a Pro feature. Turning a channel off or removing it always works, on every plan.

Nothing is sent until you add a channel and a rule. A **channel** is a destination. A **rule** picks which events go to which channels.

## Events

| Event | When it fires | Default severity |
| --- | --- | --- |
| Backup failed | A backup saved nothing, or could not be read | Critical |
| Backup completed with warnings | A backup saved policies but some items could not be read | Warning |
| Backup succeeded | A backup finished cleanly (opt in per rule) | Info |
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

Messages arrive as an Adaptive Card posted by Workflows: a header tinted by severity (red for critical, amber for warning) with a **Critical**, **Warning** or **Info** label, then the event title, summary, details and changed items, with readable UTC times. Intune change digests end with an **Open the Intune admin center** button, a fixed Microsoft address like the one in email. Good to know: the workflow belongs to the person who created it and stops when that account is disabled, and tenant policies for the Workflows app can block it. If a test message fails, the channel shows the answer it got.

![An Intune change digest as a Workflows card in a Teams channel, with three changes and their policy names](/images/notifications/notifications-teams.png)

### Teams card layout

**Teams card** in the Notifications section changes how alerts look in every Teams channel of the tenant. **Customize card** opens an editor with three columns: the parts of the card, the settings of the selected part, and a live preview drawn from the exact card Teams receives, with sample data (never your tenant's policies) in light and dark.

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

## Rules

A rule has event types, a minimum severity and one or more channels. A useful starting point:

* One rule for backup failed, backup warnings, restore failures and drift, at info and above, to your Teams channel and email.
* Success events only if you really want them. Most tenants find them noise within a week.

Delivery is at least once. An undelivered notification stays queued, retries with backoff, and survives restarting the app. In the rare case a destination accepted a message but the confirmation was lost, the same event can arrive twice; the `eventId` is identical so receivers can dedupe. Recent deliveries, including failures and retries, are listed under the channels. A scheduled backup slot that fails on every retry sends one alert, not one per attempt, and backup alerts list the policies saved and the types that could not be read.

Channels and rules can be edited with **Edit** on their row. A channel's URL and secret are never shown again: leave those fields empty to keep what is stored, or paste a new URL, for example after a Teams workflow was recreated. Rules keep sending to the edited channel, and deliveries still queued go to the new address. Removing a channel that rules use asks first and takes it out of those rules; a rule left without any channel is turned off, not deleted.

## Change watching

Change watching reads audit logs through Microsoft Graph and digests new events into one message per service and poll. Pick the services in the **Change watching** card: **Intune** (`intune.change` events) and **Conditional Access** (`entra.change` events). Both share the interval and the options below; each keeps its own position in its log.

For Intune, a digest lists what was created, updated, deleted, assigned or unassigned, the policy name when the audit event carries it, and who did it. Read-only audit events (views and searches) are not changes and never appear in a digest. A digest that contains a deletion or a removed assignment is sent with warning severity.

* On the desktop, watching runs while TenuVault is running and you are signed in. Default polling is every 15 minutes. After the app was closed with watching on, it catches up from where it left off; after a long gap the digest says older changes may be missing. Turning watching off and on again starts from that moment, so changes made while it was off are not sent as news.
* **Audit categories** limit the digest to the categories you pick, from the list Intune itself reports (for example Device configuration, Compliance, Application, Role). Picking none watches every category. A category saved by an earlier version that Intune does not report is shown in amber so you can remove it: it would match no change.
* **Poll now** reads the audit log at once with the saved settings. It is unavailable while watching is off or while an Azure watcher owns change alerts for the tenant.
* Categories apply to Intune only.
* Changes made through TenuVault itself are ignored by default, so your own restores do not alert you.
* Repeated edits of the same policy by the same admin collapse into one line with a count, and a digest shows at most 20 lines plus a remainder count, so a bulk edit does not flood a channel.
* The watcher reads a fixed list of audit fields (ids, times, category, operation type, actor, resource names). Audit request bodies and changed setting values are never read or sent.
* The actor name is personal data and is off by default. Turn it on only for destinations your policies allow it to reach. It applies to digests built after you save.
* When the [Azure watcher](#alerts-while-this-computer-is-off-the-azure-watcher) sends change alerts for a tenant, turn on **An Azure watcher owns change alerts for this tenant**. Desktop polling then stands down for that tenant, for Intune and Conditional Access alike, so each change is reported once instead of by both. If you watch Conditional Access on the desktop, set the watcher up with `-IncludeConditionalAccess` first; otherwise handing over stops Conditional Access alerts while the watcher's heartbeat still looks healthy. While it is on, TenuVault reads the watcher's `heartbeat.json` from the backup storage account every 30 minutes (with your sign-in) and sends a **Watcher stale** alert when the last run is more than 3 hours old or no heartbeat exists. The card shows when the watcher last ran, with **Check now**. A watcher whose runs fail still writes a heartbeat; those failures reach you through the Azure Monitor alert described below.

### Conditional Access changes

Conditional Access watching reads the Entra audit log (`auditLogs/directoryAudits`) for changes to Conditional Access policies and named locations, and to authentication strengths. Each line names the policy or location and what happened: created, updated or deleted. Authentication strength events in the Entra audit log do not name the strength, so those lines say "Authentication strength". A digest with a deletion is sent as a warning, and it ends with an **Open Conditional Access in Entra** button.

* It needs the delegated `AuditLog.Read.All` permission on the app registration: `-IncludeAuditLog` on a new one, or add it in Entra and grant admin consent. The signed-in admin also needs a role that can read audit logs, such as Security Reader, Global Reader or Reports Reader. Without them, the card shows the permission error and Intune watching keeps working. See [Permissions](/security/permissions/).
* Microsoft Graph includes the full policy before and after each change, and the admin's IP address, in every audit event. TenuVault never reads or sends them: only ids, times, the activity, target names and, when you opt in, the actor.
* Failed attempts are not changes and are left out.

## Alerts while this computer is off: the Azure watcher

Desktop notifications stop when the computer is off, asleep or signed out. The Azure watcher closes that gap. It is a PowerShell runbook in an Azure Automation account in the customer tenant, running on a schedule with a managed identity and no stored secret. It watches the same Intune audit events and checks the age of the newest backup folder in the backup storage account, then delivers to the same kinds of channels: webhook, Teams Workflows and email. The event content and the mail design are identical to the desktop app.

What it can and cannot see, plainly:

* It reads Intune audit events with the application permission `DeviceManagementApps.Read.All`.
* With `-IncludeConditionalAccess` it also reads Conditional Access changes from the Entra audit log with the application permission `AuditLog.Read.All` (granted by `-GrantGraphRoles`), keeping its own position in that log. Policy content and IP addresses in those events are never read.
* It alerts on the result of every [cloud backup](/backups/cloud/): **Backup failed**, **Backup completed with warnings** and **Backup succeeded**, the same alerts the desktop app sends. Backups and their status are encrypted with your recovery key, which the watcher never has, so each cloud backup run leaves a small unencrypted result note in the watcher's state container: status, backup folder name, policy and failure counts, the names of failed types, the run id and the time. Never policy content, policy names or error messages. The watcher turns the note into the alert and deletes it once the alert is queued.
* It reads backup folder names to detect a missed backup, and leaves out folders a cloud backup reported as failed, so a cloud backup that fails every day still raises **No recent backup**. A failed backup made by the desktop app cannot be told apart by folder name; the desktop app alerts on those itself while it runs.
* It writes only to its own state container (`tenuvault-notification-state`) and claims a lease on its state before sending, so overlapping runs cannot send twice.
* Email from the watcher sends app-only from a mailbox you choose. Setup asks you to restrict that permission in Exchange to the one mailbox before the email channel is used.

Setup is two copy and paste scripts in the TenuVault repository under `resources/`: `New-TenuVaultNotificationWatcher.ps1` creates the Automation account, imports `runbooks/Invoke-TenuVaultNotificationCheck.ps1`, sets the schedule and storage roles, and with `-GrantGraphRoles` (Global Administrator) assigns the Graph application roles and prints a consent receipt. Re-running the script upgrades the runbook in place. `-Remove` tears the schedule, runbook and variables down again and lists the app roles to revoke.

Costs are the Automation job minutes of short read-only runs in the customer subscription. The setup script prints the cadence it configured; start hourly and tighten only if the latency matters.

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

### If the watcher itself breaks

A watcher that fails silently would defeat its purpose, so setup refuses to guess about failure reporting. Pass `-AlertEmail` and the script creates an Azure Monitor action group and a metric alert on failed Automation jobs in the watcher resource group, so a broken watcher emails you through Azure Monitor, independent of the runbook itself. Passing `-NoFailureAlert` is the explicit opt-out. Successful runs also write `heartbeat.json` (last run time, watermark, last error) into the state container. A fresh heartbeat is the quickest health check. A stale one only means there is no recent health evidence: a watcher that lost storage access keeps failing without updating it, so check the Automation account's job history to see whether runs happen and how they fail.

Two setup errors worth knowing before you meet them:

* `Conflict` while creating the Automation account usually means the regional Automation account quota (as low as 2 accounts per region on many subscription types) or the account name being taken in that region. Run again with another `-Location` or `-AutomationAccountName`.
* A run that reports a missed backup check failure after listing the storage account is a real storage or role problem. The message includes the storage answer; check that the identity still has its two container-scoped roles and that they are permanently active, not PIM-eligible.

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
| Every change arrives twice | Both the desktop and the Azure watcher report changes. Turn on **An Azure watcher owns change alerts for this tenant** on the desktop. |
| The same alert arrived twice | A delivery succeeded but its confirmation was lost and the queue retried. The `eventId` is the same; this is expected at-least-once behaviour. |
| Webhook URL refused | Only public https addresses are allowed, without credentials in the URL. |
| Watcher mail verification fails with `ErrorAccessDenied ... [RAOP]` | The Exchange application access policy or its scope group has not propagated yet, or the sender mailbox is not in the scope group. Wait and re-run verification; see the watcher email section above. |
| Conditional Access watching fails with a 403 | The app registration lacks the delegated `AuditLog.Read.All` permission, or your account has no role that can read audit logs. Add the permission in Entra, grant admin consent, use a role such as Security Reader and sign in again. |
| A **Watcher stale** alert arrived | The Azure watcher has not written a heartbeat for 3 hours: its schedule stopped, the Automation account was removed, or it lost access to storage. Open the Automation account's job history. |
| Watcher output says mail delivery is skipped | Mail was never verified for this sender, the sender changed, or the verification is older than 90 days. Run the runbook once with `VerifyMailOnly`. |
| Automation account creation fails with `Conflict` | Regional Automation account quota or name taken. Retry setup with another `-Location` or `-AutomationAccountName`. |
| Azure Monitor reports failed watcher jobs | Open the newest job in the Automation account. The exception names the step; `heartbeat.json` in the state container shows the last error and watermark. |
