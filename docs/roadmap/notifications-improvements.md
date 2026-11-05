# Notifications: fixes, missing events and a Teams card layout editor

Review of Settings > Notifications on main (3af2122), 2026-11-05. Covers the desktop app (`src/main/features/notifications`, `src/shared/notifications`, `src/renderer/features/notifications`), the Azure watcher (`resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1`, `resources/New-TenuVaultNotificationWatcher.ps1`) and the docs page (`docs-site/src/content/docs/notifications.md`). The 66 notification tests pass today; none of them covers the bugs below.

Work is split into four phases. Each phase is one pull request, in order, because later phases build on the render code fixed in phase 1.

| Phase | Scope | Size | Status |
| --- | --- | --- | --- |
| 1 | Bugs and docs (B1 to B6, D1 to D6) | Small | Merged in #266 |
| 2 | Editing channels and rules, Teams card polish (U1 to U4) | Medium | #267 |
| 3 | Missing events and services (E1 to E4) | Large, adds an opt-in permission | Follows #267 |
| 4 | Teams card layout editor (L1 to L12) | Large | Follows phase 3 |

---

## Phase 1: bugs

### B1. Teams cards never show severity color

`teamsWorkflowsPayload` sets `style: "warning" | "attention"` on the title TextBlock (`src/shared/notifications/render.ts:33`). TextBlock `style` only accepts `default` and `heading`, so Teams ignores the value and every card looks like info. The docs screenshot shows it: a digest with an unassigned change (warning) has a plain title. The runbook copies the mistake in `New-TvTeamsPayload`.

Fix: put the title in a Container with `style: "attention" | "warning" | "default"` (or `emphasis` for info) and give the title `color: "Attention" | "Warning" | "Default"`. Same change in both runtimes.

Acceptance: shared fixtures assert the new shape for all three severities in TypeScript and PowerShell; a real Teams capture shows a red critical and an amber warning card.

### B2. Turning change watching back on replays old history

`update-audit-watch` sets a fresh watermark only when none exists (`src/main/features/notifications/index.ts`). After watching was off for months, turning it on reads every change since the old watermark, 500 per poll, and sends them as digests. The gap notice then says older changes "may be missing", the opposite of what happens.

Fix: on an off to on transition, reset `watermark` to now, clear `continuation` and `recent`. Catching up after the app was closed (watching stayed on) keeps today's behavior.

Acceptance: test that off, wait, on, poll reads only events after the switch; test that a closed app with watching on still catches up.

### B3. Audit category example is not a real category

The categories input suggests "Policy, Compliance". `Policy` is not an Intune audit category (checked with `GET deviceManagement/auditEvents/getAuditCategories`: Other, Enrollment, Compliance, DeviceConfiguration, Device, Application, EBookManagement, ConditionalAccess, OnPremiseAccess, Role, SoftwareUpdates, DeviceSetupConfiguration, DeviceIntent, DeviceIntentSetting, DeviceSecurity, GroupPolicyAnalytics, AssignmentFilter, RemoteHelp, EndpointPrivilegeMgmt, DeviceInventory, AdminTask, Deployment, Autopilot). Copying the example silently drops everything except Compliance.

Fix: replace the free text input with a multi-select filled from `getAuditCategories` (new route `list-audit-categories`, cached per session, falls back to the list above when Graph fails). Saved values that are not in the list stay visible with an "Unknown category" chip so they can be removed.

### B4. "Poll now" reports "No new changes found" when nothing was polled

`pollAuditWatchOnce` returns zeros when watching is off or `externalWatcher` is on, and the toast reads like a successful poll.

Fix: return `skipped: "off" | "external" | "busy"` and show "Change watching is off. Turn it on and save before polling." or "An Azure watcher owns change alerts for this tenant, so this computer does not poll." Disable the button in both states, with the reason underneath.

### B5. One failed scheduled slot can alert three times

A failed backup without a folder uses `job:<id>` as its natural key (`notifyBackupOutcome` in `src/main/index.ts`). A slot that fails all three attempts for a counted cause (for example an expired sign-in) sends three "Backup failed" messages.

Fix: pass the scheduled slot to the producer and key failures as `slot:<tenant>:<slot>`; manual and tray runs keep the job key. A later success in the same slot still sends its own event.

### B6. Backup alerts never show "Policies saved" or "Failed types"

The engine computes `failedTypes` but `BackupJob` does not carry it, and `notifyBackupOutcome` passes neither field, so these detail rows (already supported by `backupEvent`) never appear.

Fix: add `totalPolicies` and `failedTypes` to `BackupJob` when the run ends and pass them through.

## Phase 1: documentation

### D1. Wrong instruction for adding email permissions

`notifications.md` says to "re-run the app registration script with `-IncludeNotifications`" in the Email section and in Troubleshooting. Re-running the script creates a new app registration. Use the wording from `security/permissions.md`: on an existing registration add delegated `Mail.Send`, `GroupMember.Read.All` and `User.Read.All` and grant admin consent. The troubleshooting row also needs the two group permissions.

### D2. The "An Azure watcher owns change alerts" toggle is not documented

Without it, running both the desktop and the Azure watcher reports every change twice. Add it to "Intune change watching" and to the watcher setup steps.

### D3. Valid audit categories, "Poll now" and the actor setting

Document the category picker (B3), what "Poll now" does (B4) and that the actor option applies to new digests only.

### D4. Editing limits

Until phase 2 ships, state that channels and rules cannot be edited, and what replacing a Teams Workflows URL means for existing rules.

### D5. Outdated Teams screenshot

`docs-site/public/images/notifications/notifications-teams.png` shows `-` bullets and `|` separators, while the code renders `•` and `·`, and it is not a real Teams capture. Replace it with a real Teams capture from a test tenant after B1.

### D6. What change watching does not cover

Say plainly that change watching reads the Intune audit log only, so Entra Conditional Access edits do not appear until E1 ships. Drift scans already compare backed up Conditional Access policies.

---

## Phase 2: editing and Teams polish

### U1. Edit a channel

An "Edit" button on every channel row opens the add dialog prefilled: name, recipients, header name, signing. URL and secret fields are write-only and empty ("Leave empty to keep the current URL"). New API: `update-channel` accepts `url` for webhook and Teams channels, validated with `validateWebhookUrl`. Pending outbox entries keep their channel id, so they go to the new URL.

### U2. Edit a rule

An "Edit" button on every rule row opens the rule dialog prefilled. The API (`update-rule`) already supports it. Rules that point at a removed channel show a warning chip, "1 removed channel", and the edit dialog drops it on save.

### U3. Replacing a channel keeps rules

Removing a channel that rules use asks: "2 rules send to this channel. Remove it from those rules too?" With U1 most people never need to remove and re-add.

### U4. Teams card parity with email

- Friendly UTC times (`friendlyTime`) on item lines and in the footer, as in email.
- An "Open the Intune admin center" `Action.OpenUrl` on `intune.change`, using the same fixed link list as email (`actionLink`).
- Shared fixtures updated in both runtimes.

---

## Phase 3: missing events and services

### E1. Conditional Access change watching

Since #257 TenuVault backs up, restores and compares Entra Conditional Access, but change watching reads `deviceManagement/auditEvents` only. Conditional Access edits are in the Entra audit log.

- Source: `GET auditLogs/directoryAudits?$filter=loggedByService eq 'Conditional Access' and activityDateTime gt <since>` with a `$select` allowlist (id, activityDateTime, activityDisplayName, operationType, result, initiatedBy, targetResources id/displayName/type). `modifiedProperties` is never read, matching the Intune rule.
- Permission: delegated `AuditLog.Read.All`, opt-in through a new setup switch `-IncludeAuditLog` and the Services and permissions check. The signed-in admin also needs a role that can read audit logs (Security Reader, Global Reader or Reports Reader). Watcher: application role `AuditLog.Read.All` with `-IncludeConditionalAccess` on the watcher setup.
- Event: new type `entra.change` (keeps `intune.change` stable for existing rules and receivers), same digest shape, collapse rules and severity (deleted policy or named location is warning). The email button links to the Entra admin center Conditional Access page.
- UI: the change watching tile becomes "Change watching" with one toggle per service (Intune, Conditional Access) that is off until the module is enabled in Services and permissions.
- Own changes: restores by TenuVault are ignored the same way, by app id in `initiatedBy.app`.

### E2. Backup Reader certificate expiring

`remindBackupReaderRenewal` shows only a system notification, so the reminder is lost when nobody is at the computer. Add `credential.expiring` (warning at 30 days, critical at 7 days and after expiry), natural key `reader:<thumbprint>:<band>`, so each band sends once per certificate. The OS toast stays as the fallback when no local channel matches, like backups today.

### E3. Watcher stale

`watcher.stale` is in the schema and the rule picker but nothing produces it. When "An Azure watcher owns change alerts" is on, the desktop reads `heartbeat.json` from the `tenuvault-notification-state` container during its tick (it already has storage access) and emits `watcher.stale` when the heartbeat is older than three times the watcher cadence or reports `lastError`. Natural key: the heartbeat's last run time, so one stale period sends once. Then the type stops being greyed out in the rule dialog.

### E4. Missed backup from the desktop

The scheduler already knows when it catches up a slot it missed while the computer was off. Emit `backup.missed` once per missed slot (natural key `missed:<slot>`) when the catch-up starts, so the type works without the Azure watcher. The rule dialog note changes from "Azure watcher only" to "When TenuVault starts after a missed slot, or from the Azure watcher".

---

## Phase 4: Teams card layout editor

People can design how their Teams alerts look, without the risks of a free card designer. Microsoft's `adaptivecards-designer` is not embedded: its last release is from May 2024, it needs `adaptivecards` 2.x and `monaco-editor` 0.29, and it allows cards that leak tenant text into links or fail in Workflows.

### L1. Principles

- The layout is stored as settings (`src/shared/notifications/layout.ts`), never as card JSON. `teamsWorkflowsPayload(envelope, style)` in render.ts and `New-TvTeamsPayload $Envelope $Style` in the runbook build the card from it, and a parity test compares both for a matrix of layouts and event types.
- Tenant text is always escaped plain text, length capped, and never part of a link.
- The default style produces exactly the standard card; "Reset to standard" deletes the stored layout (a free action).
- Pro feature like the rest of Notifications. Without the plan the editor opens read only.

### L2. Where it lives

Settings > Notifications, a "Teams card" tile between Channels and Rules: a short description, a "Standard layout" or "Custom layout" chip, the groups with their own layout, "Customize card", "Reset to standard", and a live thumbnail of the card.

### L3. Editor layout

A large dialog: header with the title, the tabs (Default, Backups, Restores, Drift, Changes, Alerts) and a close button; three columns on wide windows (parts, settings of the selected part, preview), two on narrower ones (parts with settings below, preview); a footer with Reset to standard and Copy for Azure watcher on the left, Send test, Cancel and Save card on the right. Closing with unsaved changes asks first.

### L4. Parts and settings

| Part | Settings |
| --- | --- |
| Whole card | Header color (by severity, accent, neutral, green), density (comfortable, compact), times (readable UTC, ISO). |
| Header (always first) | Severity as color and label, color only or label only; title prefix (40 characters, placeholders). |
| Summary | Own text (300 characters, placeholders); empty keeps the generated summary. |
| Details | Rows to show, from the rows the tab's event types carry: Backup, Result, Policies saved, Item failures, Failed types, Trigger, Restored, Partial, Failed, Added, Modified, Deleted, Changes, Channel, Expires, Renewal waiting, Last run, Threshold (hours), Scheduled for. |
| Changes list | 3, 5, 10 or 20 lines (the rest becomes "And N more"); one line, or the name with details below; type or detail, actor, time on or off. |
| Note | Own text (300 characters, placeholders) in a shaded box, for every event, warning and up, or critical only. Hidden by default. |
| Footer | Sender, time and event id on or off. |
| Button (always last) | Matching admin center (Intune or Conditional Access changes only), or always Intune or Conditional Access in Entra; own label (40 characters). |

Summary, details, changes list, note and footer can be reordered by drag and drop, with the arrow buttons, or with the keyboard; every part but the header can be hidden with its eye.

### L5. Placeholders

`{tenant}`, `{title}`, `{severity}`, `{eventType}`, `{count}`, `{occurredAt}`, inserted with chips under each text field. Unknown placeholders block Save and Send test and are named in the message. Values are escaped after substitution.

### L6. Per event type layouts

Each tab starts as "uses the default layout" with a "Customize ..." button, which copies the default as a starting point. A customized tab shows a dot and "Use default again".

### L7. Preview

The preview draws the exact card JSON the channel receives. Instead of the `adaptivecards` package (3.x needs `swiper` as a peer for carousels) it uses a small renderer for exactly the elements the builder produces (Container, TextBlock, FactSet, Action.OpenUrl) with a Teams-like palette for light and dark, and flags any other element. Sample events use fictional Contoso data built with the real envelope builders, never the tenant's policies. A status line shows the card version and its size against the Teams message limit.

### L8. The Azure watcher

"Copy for Azure watcher" copies the layout as JSON. The watcher setup takes it with `-TeamsCardLayoutPath`, checks that it is a version 1 layout and stores it as the Automation variable `TenuVaultTeamsCardLayout`. The runbook parses it with the same rules as the desktop: a damaged or unknown value falls back to the standard value for that setting, and unreadable JSON falls back to the standard card with a note in the job output. Every option the editor offers exists in both builders, so there is no version gate to show.

### L9. Accessibility

Drag and drop uses `@dnd-kit` with its keyboard sensor and announcements; arrow buttons appear on hover or focus; switches and segmented controls carry their roles and labels; reduced motion turns off transitions.

### L10. Storage and routes

One record per tenant in the domain `notification-card-layout`. Routes: `get-card-layout` (free read), `save-card-layout` (validated, refuses unknown placeholders), `revoke-card-layout` (free reset). `test-channel` takes an optional unsaved layout. Teams deliveries read the stored layout at send time, so queued retries follow the current layout.

### L11. Safety rules, enforced in both builders and tested

- No tenant value in any URL; buttons only open the fixed destinations.
- No Submit or Execute actions; the card stays at version 1.4.
- Control characters are stripped and texts are capped.

### L12. Not in the first version

Email layout, pasting raw card JSON, per channel layouts, images and logos.

### Layout editor acceptance

1. Reordering, hiding and every option update the preview immediately; Save persists them; reopening shows the saved state.
2. Keyboard only: open the editor, move the changes list above details, hide the footer, save. A screen reader announces each move.
3. "Send test" to a real Teams channel in a test tenant matches the preview in light and dark Teams themes.
4. The Azure watcher with the copied layout sends the same card (parity matrix test plus one real run).
5. A policy named `[click](https://evil.example)` renders as literal text in every part.
6. Reset to standard produces the same card as a tenant that never opened the editor.
7. Community plan: the editor opens read only. The layout belongs to the tenant, not to a channel: removing a Teams channel keeps it for the next one, and Reset to standard stays available.

---

## Manual verification (all phases)

Use a test tenant only; screenshots must not show real tenant, user or policy names.

1. Teams channel, rule for all types at info. Send test: info card. Revoke the storage access and run a backup: red critical card (B1). Restore access, remove the read permission for one policy type and run a backup: a partial backup alert with Policies saved and Failed types (B6).
2. Let a scheduled slot fail three times: one Teams message (B5).
3. Turn change watching off and make an Intune change. Turn watching on and save, make a second change, then Poll now: only the second change is reported (B2).
4. Category picker lists the Graph categories; picking DeviceConfiguration and changing a compliance policy sends nothing (B3).
5. Poll now with watching off and with the Azure watcher toggle on: the button is disabled with its reason (B4).
6. Edit a Teams channel URL and a rule's channels; existing rules keep working (U1 to U3).
7. Change a Conditional Access policy with `-IncludeAuditLog` granted: an `entra.change` digest arrives; without the permission the tile explains what to add (E1).
8. Set the device clock 25 days before the Backup Reader certificate expiry and run a scheduled backup: one `credential.expiring` warning (E2).
9. Stop the watcher schedule for three cadences: one `watcher.stale` alert (E3).
10. Quit TenuVault over a scheduled slot and start it again: one `backup.missed` and then the catch-up backup result (E4).
11. Layout editor acceptance list above (phase 4).
