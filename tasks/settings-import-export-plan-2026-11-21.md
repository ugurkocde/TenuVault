# Shared settings, setup file and settings file (TenuVault desktop)

Plan dated 2026-11-21, read against origin/main 5c919979. Branch: `feat/settings-import-export`.

## Context

A trial customer tests TenuVault with 2 or 3 admins on one dev tenant. They asked for two things:

1. A way to set the app up the same way for the other admins.
2. A backup of their configuration.

They said Settings > Services and permissions was the most useful part.

A one-time file copy does not cover the multi-admin case on its own:

- Copied settings drift as soon as anyone changes one.
- The hardest step is connecting the tenant, and a copy does not do it.
- Each computer applies its own **Keep backups for** to every backup of the tenant in the shared storage account, so the shortest setting deletes backups that the other admins expect to keep. This is in `docs-site/.../getting-started/multiple-admins.md`, and `src/main/backup/engine.ts` `applyRetention` is the only place that deletes old backups. The cloud runbook and the Backup Reader never delete.

### Owner decisions (2026-11-21)

- Offer both ways: shared settings in the tenant's Azure storage account, and a file (a setup file for a new admin, and a settings file for backup).
- Nothing is ever overwritten automatically, even when admins share a storage account. Settings shows what changed, and the admin applies each item or leaves it.
- Sharing is an explicit **Share with other admins** action. Local changes are never uploaded on their own.
- Retention rule: a computer never deletes a backup that is younger than the retention shared for that tenant. The rule only keeps more backups and changes no setting.
- No secrets in any file or shared blob.
- Every plan gets the file features, Community included. Shared settings exist only where the tenant uses Azure storage, which already needs Pro. No new entry in `plans.ts` or `plan-gates.ts`.
- Alerts (channels, rules, change report settings, audit watch) are a follow-up PR.
- Per-tenant values apply only to the tenant with the same GUID connected on this computer. Import never writes the tenant list, except the storage target of a matched tenant when that item is selected, and through onboarding.

## One format, three uses

There is one versioned JSON format: `kind: "tenuvault-settings"`, `schemaVersion: 1`. The same parser, preview and apply code serve:

| Use | Where it lives | Content | Plans |
|---|---|---|---|
| Settings file (backup, move to a new computer) | a `.json` file the admin saves | the "This computer" settings and any connected tenants they choose | all |
| Setup file (next admin) | the same file with **Include connection details** ticked | adds per tenant: client ID and storage target, which are public identifiers | all |
| Shared settings | blob `tenuvault-settings/<tenantId>.json` in the `intune-backups` container of the tenant's storage account | one tenant's shared items, plus `sharedBy` (display name) and `sharedAt` | tenants on Azure storage |

### What each item does

The "Default in preview" column means:

- **On:** the item is ticked in the preview when it would change something.
- **Off:** the item is exported and listed, but starts unticked and shows a one-line warning.

| Item | Source today | File | Shared | Default in preview | Notes |
|---|---|---|---|---|---|
| Services (module on/off) | `services.modules` | yes | yes | on | Applied through `ModuleSettings.set`. Module IDs this build does not know (for example 0.6 Entra ID or Defender) are listed as skipped. |
| Permissions | read live from the token, not stored | info | info | n/a | The permissions live in the app registration. After applying, `services:status` runs and shows what this admin's sign-in lacks, with the existing fix callout, and flags a different client ID. |
| Backup scope | `backup.scopes` | yes | yes | on | Applied through `BackupScopes.set` / `normalizeScope`. |
| Keep backups for | `app.preferences.retentionDays` (machine-wide) | yes | yes | on | Shared value is the tenant's retention, and the retention rule below reads it. Applying it sets this computer's value, and the preview says so: "applies to all tenants on this computer". Community still applies at most 30 days. |
| Schedule | `backup.schedules`, config fields only | yes | as info: "run by <name>" or "cloud backups" | off | Warning about duplicate backups. Applied through `prepareScheduleInput`, so the plan rules for daily schedules are unchanged. Runtime fields are never exported. |
| Cloud backup setup | `renderer.tenuvault_cloud_backup_<tid>` | yes | yes | on | Re-parsed with `parseCloudSetup`. The tenant must match. |
| Storage target | `Tenant.resources` | setup file only | implicit | off | Applied in the renderer through `changeTenantStorage` after the existing Check access step. |
| PDF branding (with logo) | `pdf.branding` | yes | yes | on | Applied through `PdfBrandingPolicy.set`, which keeps the plan gate and re-encodes the logo. Without a plan that includes it, the preview shows a plan badge and the item is not applied. |
| Keep running in tray, Automatic updates | `app.preferences` | yes | no | on | `autoUpdate` is not applied when it is managed by policy. |
| Start at login, Nightly updates | `app.preferences` | yes | no | off | |
| Appearance | `localStorage tenuvault-appearance` | yes | no | on | |
| Tenant name and domain | tenant list | info | info | n/a | Labels only. Never written. |

### Never exported or shared

A canary test plants a value in each of these stores and asserts that none of the values appears in a file or in a shared blob:

- License: `license.*`, which holds keys, activations, trial tokens and the install ID.
- Sign-ins and tokens: `msal.*`, `auth.account.*`.
- Backup keys: `backup.keyring`, `backup.recovery-exported`.
- Backup Reader: `backupReader.*`, which holds private keys.
- Proxy credentials: `network.proxy-credentials`, which holds passwords.
- Tenant credentials: `credentials.clientSecret`.
- `appSources.restoreOwner`.
- `setupDiagnostics.state`.
- Disclaimer acknowledgements.
- Restore and audit journals: `restore.write-journal`, `restore.approvals`, `audit.pending-events`.
- Backup failure records: `backup.refusals`, `backup.failedAttempts`.
- Notification outbox and watcher deploy records.
- Drift and framework results, OIB history and the What's new state.
- Onboarding draft, selected tenant, sidebar state, dismissals, `trialOfferHiddenTenantIds`, `firstBackupNoteSeen`.

These are not in this PR:

- Machine paths: the local backup folder and the App Backup source folder.
- Alerts (follow-up PR).
- Content that has its own export or depends on policy IDs: custom baselines, standards, customizations, CIS exceptions and sync links.

### Validation (pure, hand-written, `src/shared/settings-transfer/`)

The whole file or blob is rejected, and nothing is applied, when:

- it is not JSON;
- `kind` is wrong;
- `schemaVersion` is not a positive integer;
- `schemaVersion` is newer than this build supports. Message: "made by a newer TenuVault, update to import it";
- it is larger than 5 MB;
- `tenants` is not an array;
- a tenant ID is not a GUID, or the same tenant ID appears twice;
- it is a shared blob whose tenant ID does not match the blob name.

Each item is checked on its own with the existing validators. An invalid item is shown as "cannot be applied: <reason>" and cannot be selected, and the other items stay available. Unknown fields and sections are listed as skipped from a newer version and never cause an error. `schemaVersion` changes only for breaking changes, and older versions go through a migration chain.

## Shared settings

### Share

Settings > **Share and transfer** > **Shared with other admins** lists each tenant whose storage is Azure. For each tenant:

1. The admin selects **Share with other admins** and ticks the items.
2. Main builds the blob from the current values. The text "Shared by" is the signed-in display name, falling back to the username.
3. Main writes the blob with optimistic concurrency:
   - The first share uses `If-None-Match: *`.
   - Later shares use `If-Match: <etag>` of the version the admin last read.
4. On a 412, the admin sees "Another admin shared settings since you opened this. Review their changes first." Nothing is overwritten.
5. Write access is whatever the admin's storage roles allow. The docs already treat everyone with write access to the container as trusted like an Intune admin.

### Incoming changes

- **When main reads the blob:** at app start, when Settings opens, and after each backup that the admin's sign-in makes. Each read compares the blob with the local values.
- **What the admin sees:** a dot on Settings in the sidebar, plus a notice in the section: "Anna shared settings on Nov 21: 3 differences". The notice has the same preview and per-item **Apply** as the file import, and **Dismiss until it changes**.
- **How dismissal is stored:** on this computer, keyed by tenant and blob ETag.
- **What is never done:** nothing is applied without the admin selecting **Apply**.

### Retention rule

This is the one automatic effect, and it only ever keeps more backups.

- **Where:** in `applyRetention`, before any delete, main reads the tenant's shared blob from the same storage with the same `BlobWriter`. Main's existing control flow is otherwise unchanged.
- **Days used:** `keep = max(local effective days, shared days)`, where 0 means keep everything. So shared 0 means nothing is pruned, and local 0 means nothing is pruned.
- **Blob missing:** the local value applies.
- **Blob unreadable (HTTP error, network, invalid JSON, invalid retention value):** nothing is pruned in that run. The backup log gets one warning, "Older backups were kept: the shared settings of this tenant could not be read." This uses the same "keep when in doubt" pattern as the existing retention warnings.
- **Out of scope:** local storage is single-computer and has no shared blob. The Backup Reader and cloud runbook paths do not delete and stay unchanged.
- **The blob is never a backup:** it is outside the `backup-` prefix, so the retention listing, backup lists, drift and download never see it. A test proves this.

## Setup file for the next admin

- **Export:** the export dialog has **Include connection details** for each tenant: the client ID and the storage target.
- **Import entry point:** onboarding's Connect step gets **Set up from a file**. It is also reachable from Settings import when a file tenant is not connected.
- **What gets prefilled:**
  - The Connect fields: tenant ID, client ID and display name, through the existing `OnboardingDraft`.
  - The Storage step, through the existing `StorageChooser initial` prop.
- **What the admin still does:** sign in with their own account and select **Check access**. Nothing signs in on its own.
- **Trust notice:** the Connect step shows "Use a setup file only from an admin you trust", with the client ID and storage account in full. A setup file from someone else could point at another app registration or storage account.
- **After connecting:** the file's other items for that tenant open in the same preview. Main keeps the parsed file for the app session. For Azure tenants, shared settings show up too.

## Settings file (backup)

- **Export:** **Export settings** opens a dialog with checkboxes for "This computer" and for each connected tenant. A fixed line says what is never included. Main builds the file and saves it through `prepareGeneratedFile` and the save dialog, as `tenuvault-settings-YYYY-MM-DD.json`.
- **Import:** **Import settings** opens a main-side file dialog that accepts `.json`, with a re-entry guard modelled on `backups:importArchive`.
  1. Main parses the file and builds a preview against the current values.
  2. The preview keeps the parsed file under a single-use `importId` that expires after 15 minutes.
  3. Each row shows the current and new values and a status:
     - will change;
     - already the same (hidden behind **Show unchanged**);
     - not applied, with the reason: tenant not connected, plan, managed by policy, or invalid.
  4. **Save current settings first** runs the export.
- **Apply:** the renderer sends only `importId` and the ticked item IDs, so it can never supply values. Main applies each item through its existing setter. Appearance and the storage target come back to the renderer and go through their existing paths.
- **Result:** each item is marked Applied, Skipped or Failed with a reason, and items already applied are not rolled back. This follows the `copyRulesToTenants` result shape.

## Deliverables

- `src/shared/settings-transfer/` (pure functions): types, constants, `parseSettingsFile`, `buildPreview`, `diffShared`.
- `src/main/settings-transfer/`:
  - collector over `Preferences`, `PdfBrandingPolicy`, `ModuleSettings`, `BackupScopes`, scheduler config and the `renderer.*` keys;
  - export, import session and apply;
  - shared blob client (read with ETag, conditional put);
  - change check.
- `src/main/backup/engine.ts`: the retention rule, kept inside `applyRetention` and limited to computing `keep`.
- IPC through `handleTrusted`, types on `TenuVaultBridge` (`src/shared/ipc.ts`) and the preload. Channels:
  - `settings:export`, `settings:import`, `settings:apply`
  - `settings:sharedStatus`, `settings:share`, `settings:dismissShared`
  - `settings:openSetupFile`
- Renderer:
  - Settings section `sharing` ("Share and transfer"), registered in `settings-section.ts`, `SECTIONS` and `panel(...)`;
  - export dialog, preview/apply dialog, share dialog, incoming-changes notice, Settings nav dot;
  - onboarding **Set up from a file** with the trust notice.
  - Reuse `ConfirmWriteDialog`, `DiffList`, `Checkbox`, `PlanBadge`, `toast` and `StorageChooser initial`.
- Docs-site, in the same PR and named in the PR body:
  - `settings.md`: a new section;
  - `getting-started/multiple-admins.md`: rewrite "Set up a second admin" around the setup file and shared settings. Change the retention row to the new rule, and the Settings row to say what can be shared;
  - `backups/storage.md`: the retention rule;
  - `licensing/index.md`: a row saying all plans get the file features, and that shared settings need Azure storage.

## Acceptance criteria

1. **Section on every plan.** Settings > Share and transfer exists on every plan. On Community, or on a tenant with local storage, the file features work, and the shared card explains that it needs Azure storage. It is not a plan prompt. `plans.ts` and `plan-gates.ts` are unchanged.
2. **No secrets.** A canary value planted in each never-exported store appears in no exported file, setup file or shared blob body. Tested.
3. **File round trip.** Export from store A, then import every item into store B with the same tenant connected. Services, scope, retention, schedule config, cloud setup, branding, preferences and appearance read back equal. Schedule runtime fields in B are untouched.
4. **Shared round trip.** Admin A shares, and admin B (a separate store, same emulated storage account) sees exactly the differing items. Nothing in B changes until B applies. After B applies the selected items, they read back equal, and the items B left unselected stay as they were.
5. **No overwrite on share.** A second share that is based on a stale ETag is refused with a 412 message and leaves the blob unchanged. Tested against the blob emulator.
6. **Dismissal.** Dismissed changes stay hidden until the blob's ETag changes, and then show again.
7. **Retention rule.** Tested in the backup engine with the blob emulator:
   - local 30 and shared 90: backups between 31 and 89 days old are kept;
   - shared 0: nothing is pruned;
   - shared 10 and local 30: the local 30 applies;
   - blob missing: the local value applies;
   - blob unreadable or invalid: nothing is pruned, with one warning;
   - local storage and the Backup Reader path behave exactly as on main.
8. **Blob invisibility.** The shared blob never appears as a backup in the backup list, drift, download or the retention listing.
9. **Rejected files and blobs.** Each of these is rejected with a specific message and nothing changes:
   - not JSON;
   - wrong `kind`;
   - newer `schemaVersion`;
   - larger than 5 MB;
   - duplicate tenant;
   - tenant ID that is not a GUID;
   - `tenants` that is not an array;
   - a blob whose tenant does not match its name.
10. **Item-level invalid values** mark only that item invalid: a bad time, a bad weekday, a bad colour, a broken logo, retention out of range, a wrong type, or an unknown module. Unknown fields and sections are listed as skipped and never cause an error.
11. **Tenant matching.**
    - Settings for tenants that are not connected are skipped, and nothing is written for that GUID.
    - Local tenants that are not in the file are untouched.
    - Import never writes `tenuvault_tenants`, except a selected storage target and through onboarding.
12. **Plan gates** are tested with 2 and 3 tenants on mixed plans (Community, Pro trial, Pro key, expired) through the real `LicenseService` fixtures:
    - branding needs a tenant with `pdfBranding`;
    - a daily schedule is refused for Community;
    - Azure storage needs `azureStorage`;
    - Community applies at most 30 days of retention.

    A policy-managed `autoUpdate` is not written.
13. **Apply integrity.** Apply refuses an unknown, reused or expired `importId`, and any item ID that was not in its preview.
14. **Setup file.**
    - Onboarding opens prefilled with the tenant ID, client ID, display name and storage choice. The trust notice is shown.
    - No sign-in or storage change happens without the admin acting.
    - After the tenant connects, the file's remaining items open in the preview.
15. **Prompt items.** Start at login, nightly updates, schedule and storage target start unticked. Partial apply writes only the ticked items.
16. **Permission check.** After apply, the check runs for each matched tenant and shows missing permissions and a client ID mismatch. It makes no Graph write.
17. **Checks and screenshots.**
    - `npm run typecheck`, `npm run lint` and `npm test` are green, and the coverage floors hold.
    - jsdom tests cover the preview selection and the incoming notice.
    - The dev app is driven over CDP/Playwright with two profiles on one storage account. Screenshots are taken in light and dark mode at 1024 px.
18. **Docs and copy.** Docs are updated in the same PR and named in the PR body. UI copy contains no em or en dashes and no plan-marketing wording.

## Work items

- [ ] Shared format: parser, preview and diff, with unit tests (AC 9, 10)
- [ ] Main collector, export, import session and apply, with IPC and preload (AC 2, 3, 11, 12, 13, 15)
- [ ] Shared blob client, share with ETag, change check and dismissal (AC 4, 5, 6, 8)
- [ ] Retention rule in `applyRetention`, with engine tests (AC 7)
- [ ] Renderer section, dialogs, notice, nav dot and onboarding setup-file entry (AC 1, 14, 16, 17)
- [ ] Docs-site pages (AC 18)
- [ ] Dev app verification with two profiles and one storage account
- [ ] Open the PR as the UgurLabs agent app, with no AI attribution in commits or the PR body
- [ ] Separate evaluator subagent graded against these criteria; fix and re-evaluate until it passes
- [ ] Codex review gate: `delegate_task`, codex `gpt-6.2-sol`, role review, reasoning high, over the full diff against main, with a new `clientRequestId` per round. No merge while a review is pending or a blocking finding is open
- [ ] Review section in this file, and lessons recorded

## PR shape (to confirm)

The owner's rule is one PR. The retention rule and the shared blob are on the backup data path, and earlier data-path PRs grew through review rounds (see tasks/lessons.md 2026-10-12). My recommendation is two PRs in order:

1. Format, settings file and setup file. No data path.
2. Shared settings and the retention rule.

Each PR updates the docs and goes through its own review gate. If one PR is preferred, the work items above stay the same.

## Verification commands

- `npx vitest run --project node test/settings-transfer-*.test.ts test/backup-retention-shared.test.ts`, then the full `npm test`, `npm run typecheck` and `npm run lint`. Check each exit code on its own, never through a pipe.
- `npx vitest run --project renderer-hooks test/renderer-hooks/settings-transfer*.test.ts`
- `npm run build && npm run smoke`
- Dev app (unset `ELECTRON_RUN_AS_NODE`, with the license public key): two user-data profiles on one storage account. Share from A, review and apply on B, try a stale share, create a setup file and use it on a fresh profile.

## PR 1 status (format, settings file, setup file)

Approved 2026-11-21: two PRs. PR 1 holds the format, the settings file and the setup file, with no backup data path. PR 2 holds the shared settings and the retention rule.

- [x] Shared format: parser, preview and diff, with unit tests (AC 9, 10, without the blob case)
- [x] Main collector, export, import session and apply, with IPC and preload (AC 2, 3, 11, 12, 13, 15)
- [x] Renderer section, export and review dialogs, result with the permission check, onboarding setup-file entry (AC 1, 14, 16)
- [x] Docs-site: settings.md (Import and export), connect-tenant.mdx (Set up from a file), multiple-admins.md, licensing/index.md, four new screenshots and SCREENSHOTS.md (AC 18)
- [x] Built-app end-to-end run through the real IPC with stubbed file dialogs: export with connection details, no client secret in the file, import, apply, single-use session, tenant list unchanged; light and dark at 1024 px
- [x] PR #381 opened; separate evaluator passed (no blocker)
- [ ] Codex gate: rounds 1 to 4 fixed (see commits); CodeRabbit threads addressed

Deviations from the plan, for PR 1:
- The section is **Import and export** (`section=transfer`). PR 2 may rename it when the shared card arrives.
- The storage target of a tenant that is already connected is information only. The admin changes it through **Change storage**, which checks access first. A setup file applies the storage through onboarding.
- A file session stays open for at most one hour (the plan said 15 minutes), so a new admin can sign in and take the first backup before reviewing the rest of the file. At most five sessions are kept; opening a sixth closes the oldest, and the admin then opens the file again.
- Preview labels use the Settings wording (for example **Get nightly builds**).
- The dev app check used one profile with the real IPC and stubbed file dialogs; the two-profile storage-account run belongs to PR 2.

Follow-ups after PR 1 (not blocking, from the Codex round 6 review):
- Onboarding that is resumed after a restart, with a setup file in progress, does not keep the file's storage choice: the import session lives in memory only. Keep the validated connection details in the onboarding draft, and ask the admin to open the file again when its session is gone.
