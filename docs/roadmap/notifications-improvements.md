# Notifications: fixes, missing events and a Teams card layout editor

Review of Settings > Notifications on main (3af2122), 2026-11-05. Covers the desktop app (`src/main/features/notifications`, `src/shared/notifications`, `src/renderer/features/notifications`), the Azure watcher (`resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1`, `resources/New-TenuVaultNotificationWatcher.ps1`) and the docs page (`docs-site/src/content/docs/notifications.md`). The 66 notification tests pass today; none of them covers the bugs below.

Work is split into four phases. Each phase is one pull request, in order, because later phases build on the render code fixed in phase 1.

| Phase | Scope | Size |
| --- | --- | --- |
| 1 | Bugs and docs (B1 to B6, D1 to D6) | Small |
| 2 | Editing channels and rules, Teams card polish (U1 to U4) | Medium |
| 3 | Missing events and services (E1 to E4) | Large, adds an opt-in permission |
| 4 | Teams card layout editor (L1 to L12) | Large |

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

Fix: return `skipped: "off" | "external"` and show "Change watching is off. Save it on first." or "The Azure watcher owns change alerts for this tenant." Disable the button in both states, with the reason as its description.

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

- The layout is stored as settings, never as card JSON. Both runtimes build the card from the layout, so the Azure watcher sends exactly what the preview shows.
- Tenant text is always plain text: escaped, length capped, never part of a link, image or formatting.
- Every option has a good default; "Reset to default" returns today's card (after B1 and U4).
- Pro feature, like the rest of Notifications. Community sees the editor read-only with the plan badge.

### L2. Where it lives

Settings > Notifications gets a "Teams card" tile between Channels and Rules: a small live thumbnail of the current card, the text "Applies to every Teams channel of this tenant", and a "Customize card" button. Teams channel rows show a "Custom layout" chip when the layout is not the default.

### L3. Editor layout

A full-height dialog (max width 1200px) with three areas:

```
+-----------------------------------------------------------------------------------+
| Teams card                         [Default][Backups][Restores][Drift][Changes]   |
+---------------------------+-------------------------------------------------------+
| Blocks                    |  Preview   [Sample: Intune changes v] [Light | Dark]  |
|  :: Header         [on]   |  +-------------------------------------------------+  |
|  :: Summary        [on]   |  |  W  Workflows  10:04                            |  |
|  :: Details        [on]   |  |  +-------------------------------------------+  |  |
|  :: Changes list   [on]   |  |  | Intune changes: Contoso       [Warning]   |  |  |
|  :: Note           [off]  |  |  | 3 changes in Intune (1 assigned, ...)     |  |  |
|  :: Button         [on]   |  |  | Changes   3                               |  |  |
|  :: Footer         [on]   |  |  | • Assigned: WiFi Corp · Device...         |  |  |
|                           |  |  | [Open the Intune admin center]            |  |  |
| Block settings            |  |  +-------------------------------------------+  |  |
|  (options of the          |  +-------------------------------------------------+  |
|   selected block)         |  Card 1.4 · 3.1 KB of 28 KB · Works in Azure watcher  |
+---------------------------+-------------------------------------------------------+
| Reset to default      Copy for Azure watcher     [Send test to v]  Cancel  [Save] |
+-----------------------------------------------------------------------------------+
```

- Left column (320px): the block list on top, the settings of the selected block below it.
- Right: the preview in a Teams-like frame (Workflows avatar, sender name, time) on a neutral canvas, centered, at Teams' real card width (about 450px), with a light and dark switch that follows the app theme by default.
- Footer bar: actions on the left, primary actions on the right. Save is disabled until something changed; closing with unsaved changes asks first.
- On narrow windows the preview moves below the block list, and the tabs become a select.

### L4. Blocks

| Block | Options |
| --- | --- |
| Header | Show severity as: colored band, colored title or badge. Show tenant name: in title, as a chip, hidden. Optional title prefix (plain text, 40 chars). |
| Summary | On or off. Optional custom text with placeholders (L6) that replaces the generated summary. |
| Details | Which rows to show (per event type: Backup, Result, Policies saved, Item failures, Failed types, Trigger, Added, Modified, Deleted, Changes). Layout: fact list or compact one-line. |
| Changes list | Style: one line per change, or verb chip plus name with a second line. Items shown: 3, 5, 10 or 20 (the rest becomes "And N more"). Show resource type, actor (only when the tenant's actor setting is on), time. |
| Note | Free text (300 chars) with placeholders, for example "Call the on-call admin at extension 4411 for critical alerts." Can show for all severities or only warning and critical. |
| Button | Destination from a fixed list only: Intune admin center, Entra admin center Conditional Access, Azure portal storage account overview, TenuVault docs troubleshooting. Custom label (40 chars). |
| Footer | Toggles for source, time and event id. |

Blocks are reordered by drag and drop; Header always stays first. Hidden blocks stay in the list, dimmed.

### L5. Card-wide options

- Density: comfortable or compact (Adaptive Card spacing values).
- Time format: friendly UTC ("2026-10-17 10:02 UTC") or ISO.
- Accent: severity colors (default) or one fixed container style (accent, emphasis, good). Adaptive Cards only offer named styles and colors, not hex values, so the options are those names with swatches showing how Teams renders them in light and dark.

### L6. Placeholders

`{tenant}`, `{title}`, `{severity}`, `{eventType}`, `{count}`, `{occurredAt}`. Typing `{` opens a suggestion list. Unknown placeholders are underlined red and block Save. Values are escaped with `escapeMarkdown` after substitution and capped at their envelope limits.

### L7. Per event type layouts

The tabs at the top: Default, Backups (`backup.*`), Restores (`restore.*`), Drift, Changes (`intune.change`, later `entra.change`), Credentials and watcher (E2, E3). A tab starts as "Uses default" with a "Customize for backups" button; a customized tab shows a dot and a "Use default again" link.

### L8. Preview

- Rendered with the maintained `adaptivecards` package (3.x) and a Teams-like host config for light and dark, from the same `teamsWorkflowsPayload(envelope, layout)` that sends the card. No separate preview renderer.
- Sample data only (Contoso, WiFi Corp, Baseline), never the tenant's real policies, so screenshots and screen sharing are safe.
- The sample picker covers every event type and severity, including a long digest with "And 12 more" and long names, to check wrapping.
- Status line under the preview: card version, size against the 28 KB Teams message limit, and "Works in Azure watcher" (always true by construction; shows the watcher version needed when the layout uses a newer option).

### L9. Interaction and accessibility

- Drag and drop with `@dnd-kit/core` and `@dnd-kit/sortable` (keyboard sensor included): grab with Space, move with the arrow keys, drop with Space, with live region announcements ("Changes list moved to position 3 of 7"). Every row also has Move up and Move down in its menu.
- Every control has a visible label; toggles are real switches with `role="switch"`.
- Focus moves to the block settings when a block is selected and back to the row on Escape.
- Preview updates within 100 ms of a change, without layout shift; reduced motion turns off the reorder animation.
- Colors, spacing and type use the existing tokens (`Tile`, `Chip`, `Button`, coral accent), correct in light and dark.

### L10. Data model and runtimes

- `CardLayout` in `src/shared/notifications/layout.ts`: `{ version: 1, blocks: Array<{ kind, visible, options }>, density, timeFormat, accent, overrides: Partial<Record<EventGroup, Omit<CardLayout, "overrides">>> }`.
- `parseCardLayout(value)` validates and clamps every field (pure, shared); unknown fields are dropped, invalid layouts fall back to the default with a reason.
- Stored per tenant in a new domain `notification-card-layouts`, with history like the other notification records. Routes: `get-card-layout`, `save-card-layout`, `reset-card-layout`, `preview-card` (returns card JSON for a sample).
- `teamsWorkflowsPayload(envelope, layout = DEFAULT_LAYOUT)`; the outbox stores the envelope only, so a layout change also applies to queued retries.
- Watcher: "Copy for Azure watcher" copies the layout as compact JSON. The setup script gets `-TeamsCardLayoutPath`, stored as the Automation variable `TenuVaultTeamsCardLayout`; `New-TvTeamsPayload -Layout` mirrors the TypeScript builder. A missing or invalid layout falls back to the default and writes a warning to the job output and `heartbeat.json`.
- Shared fixtures: a matrix of layouts (default, every block hidden, every option at its extreme, per type overrides) times event types, asserting identical canonical JSON from both runtimes.

### L11. Safety rules, enforced in the builder and tested

- No tenant value in any URL, image, `Action.*` or `selectAction`.
- Button URLs come from the fixed destination list only.
- No `Action.Submit` or `Action.Execute` (they do nothing in Workflows).
- Card version stays at 1.4 or 1.5; the builder refuses options that need more.
- Size is checked before sending; when a digest would exceed the limit, items are dropped from the end into "And N more" instead of failing.

### L12. Out of scope for the first version

- Email layout (email keeps its fixed design; can reuse the model later).
- Pasting raw card JSON.
- Per channel layouts (per tenant and per event type covers the requests so far).
- Images and logos (Workflows cards cannot load data URIs reliably, and remote images would come from a URL we do not control).

### Layout editor acceptance

1. Reordering, hiding and every option update the preview immediately; Save persists them; reopening shows the saved state.
2. Keyboard only: open the editor, move the Changes list above Details, hide Footer, save. Screen reader announces each move.
3. "Send test" to a real Teams channel in a test tenant matches the preview in light and dark Teams themes.
4. The Azure watcher with the copied layout sends the same card (fixture test plus one real run).
5. A policy named `[click](https://evil.example)` renders as literal text in every block and option.
6. Reset to default produces the same card as a tenant that never opened the editor.
7. Community plan: editor opens read-only with the plan badge; existing layouts still apply until the channel is removed.

---

## Manual verification (all phases)

Use a test tenant only; screenshots must not show real tenant, user or policy names.

1. Teams channel, rule for all types at info. Send test: info card. Trigger a failed backup (revoke storage access): red critical card with Policies saved and Failed types (B1, B6).
2. Let a scheduled slot fail three times: one Teams message (B5).
3. Turn change watching off, make an Intune change, wait, turn it on, Poll now: the earlier change is not reported; a new change is (B2).
4. Category picker lists the Graph categories; picking DeviceConfiguration and changing a compliance policy sends nothing (B3).
5. Poll now with watching off and with the Azure watcher toggle on: the button is disabled with its reason (B4).
6. Edit a Teams channel URL and a rule's channels; existing rules keep working (U1 to U3).
7. Change a Conditional Access policy with `-IncludeAuditLog` granted: an `entra.change` digest arrives; without the permission the tile explains what to add (E1).
8. Set the device clock 25 days before the Backup Reader certificate expiry and run a scheduled backup: one `credential.expiring` warning (E2).
9. Stop the watcher schedule for three cadences: one `watcher.stale` alert (E3).
10. Quit TenuVault over a scheduled slot and start it again: one `backup.missed` and then the catch-up backup result (E4).
11. Layout editor acceptance list above (phase 4).
