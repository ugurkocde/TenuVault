# Intune feature gaps before 0.5.4 (plan, 2026-11-23)

The owner holds the 0.5.4 stable release until the 16 Intune gaps below are merged into `main`.
Entra and Defender gaps stay in 0.6. No release is cut, tagged or deployed as part of this work.

Each PR has its own branch and worktree from `origin/main`. A delegate (codex `gpt-6.2-sol`) writes
the code, a second delegate (muse `muse-wonder-full-1.0`) reviews it, findings get fixed, and CI must
be green. PRs are opened and reported as ready. The owner merges them.

## What exists today (starting point)

- Restore writes assignments as they were backed up. Nothing checks that the groups still exist.
  Cross-tenant restore never writes assignments (`src/portal/lib/policies/graph-restore.ts`).
- Dev to Prod maps groups, filters, scope tags and reusable settings, using only mappings the admin
  confirmed (`src/main/features/promotion/mapping.ts`). Copy to Tenants hard-codes
  `includeAssignments: false` (`src/renderer/features/sync/api.ts`).
- Promotion and Copy to Tenants support 4 folders: `ConfigurationPolicies`, `CompliancePolicies`,
  `DeviceConfigurations`, `EndpointSecurityIntents` (`src/main/features/promotion/engine.ts`).
- The app scheduler offers daily or weekly. The cloud setup script offers `Daily|Weekly`.
- Storage setup has soft delete and, with the Backup Reader, versioning and a no-delete writer role.
  It has no immutability (WORM) option.
- Retention deletes folders older than N days (`applyRetention` in `src/main/backup/engine.ts`).
- Background launch covers Windows (Task Scheduler) and macOS (LaunchAgent). Linux throws.
- The Backup Reader is app-only, read-only and used only by scheduled backups. The interactive
  sign-in still asks for write scopes.
- Alerts have rules by event type and conditions, with webhook (HMAC signed), Teams and email output.
- A restore dry run exists (`src/portal/lib/policies/restore-validation.ts`).

## PRs, in order

| # | PR | Gaps | Plan gate | Depends on |
|---|---|---|---|---|
| A | Map groups, filters and scope tags when restoring and in Copy to Tenants | 1 | Pro (`restoreAssignments`, `sync`); cross-tenant keeps the Copy to Tenants and MSP rules | none |
| B | Backups every 4, 6 or 12 hours (app scheduler and cloud runbook) | 7 | Pro (`dailySchedule`) | none |
| C | Immutable storage mode and no partly deleted backups | 8 | Pro (`azureStorage`) | none |
| D | Mass change alert | 14 | Pro (`notifications`) | none |
| E | Retention tiers (daily, monthly, yearly) | 10 | Pro (`customRetention`) | C (same retention code) |
| F | Copy to Tenants and Dev to Prod for more policy types | 2 | Pro / MSP as today | A |
| G | Properties catalog and uploaded ADMX/ADML files; Linux scripts check | 4, 5, 6 | same as other backup types | Graph check |
| H | Windows Autopatch groups and releases | 3 | same as other backup types | Graph check |
| I | Linux relauncher for scheduled backups | 12 | same as background launch today | none |
| J | Archive the Intune audit log with each backup | 11 | existing `auditLog` gate (question below) | none |
| K | Second copy in another storage account or subscription (runbook) | 9 | existing cloud backup gate (question below) | C |
| L | Read-only app registration | 13 | none: a setup option, not a feature | none |
| M | Sentinel / SIEM recipe through the webhook | 15 | docs only | D (optional) |
| N | Restore test report | 16 | open question | C, E |

Wave 1 runs A, B, C and D in parallel, since they touch different code. E, F and K start when their
base merges, or stack on the open PR. G and H start after the Graph endpoints are checked with Lokka
and the msgraph skill.

## Rules for every PR

- Simple changes that follow existing patterns and `RELEASING.md`. No licensing files touched.
- Nothing taken away from Community. New options sit behind the existing gate named above.
- Docs in `docs-site/` go in the same PR. Website copy goes in a paired TenuVault-Website PR.
- Real screenshots for UI changes, with no tenant or customer data.
- Every new Graph endpoint is checked with Lokka before it is used. If Graph refuses or the
  endpoint is beta only, the gap stops and goes to the owner as a question.

## Open questions for the owner

1. Gap 9 (second copy), 11 (audit log archive) and 16 (restore test report) have no tier in the
   brief. The plan uses the gate of the feature each one extends (cloud backup, `auditLog`). For
   16 there is no obvious existing gate. Is it Pro?
2. Gap 13: the Backup Reader already gives scheduled backups a read-only identity. Gap 13 adds a
   read-only delegated registration, so that a user who only runs backups holds no write scopes.
   The app then hides restore and every write action for that user.

3. Gap 5: Graph does not return uploaded ADMX/ADML content. Options: (a) back up the file list so
   a restore names the ADMX files to upload first and blocks cleanly until they exist, (b) also let
   the admin attach the original files to the backup. Which one, if any?
4. Gap 4: the properties catalog endpoint is undocumented beta and refused app-only reads in the lab
   tenant. Build it as an optional type that is skipped when Graph refuses, or wait for a
   documented API?
5. Gap 3: Autopatch groups have no documented Graph API. Options: (a) label the update rings and
   profiles Autopatch creates (already backed up) and document that the groups themselves are not,
   (b) use the undocumented Autopatch service API, which may break without notice. Which one?

## Graph checks (Lokka, lab tenant, 2026-11-23)

- Gap 6, Linux scripts: covered. Linux custom configuration scripts are settings catalog policies
  (template family `deviceConfigurationScripts`, technology `linuxMdm`). The `ConfigurationPolicies`
  entry in `src/shared/intune/registry.ts` reads `deviceManagement/configurationPolicies` with no
  platform filter and expands settings, so they are backed up and restored like any settings
  catalog policy. Only the coverage page needs a line.
- Gap 5, uploaded ADMX/ADML: `deviceManagement/groupPolicyUploadedDefinitionFiles` lists the
  files (file name, namespace, prefix, revision, language codes), but `content` comes back null on
  both the list and a single read, and `groupPolicyUploadedLanguageFiles` is empty. Graph does not
  hand back the uploaded files, so they cannot be rebuilt from Graph alone. Blocked: question 3.
- Gap 4, properties catalog: `deviceManagement/inventoryPolicies` (beta, not in the Graph
  reference) answers 403 to an app with `DeviceManagementConfiguration.ReadWrite.All`. Blocked
  until it is confirmed with a delegated admin sign-in: question 4.
- Gap 3, Autopatch groups and releases: there is no documented Graph resource for Autopatch groups.
  They live in the Autopatch service, which writes ordinary Intune update rings and update
  profiles that TenuVault already backs up. `admin/windows/updates` (deployment service, beta)
  answers 403 here. Blocked: question 5.

## Status (2026-11-23, end of day)

All open PRs below are green and reviewed, waiting for the owner to merge.

| Gap | PR | Notes |
|---|---|---|
| 1 | #390 | Aligned with #392 (group read required). Merge before #394. |
| 2 | #394 | Stacked on #390: retarget to main after #390 merges. |
| 7 | #385 | |
| 8 | #386 | Merge before #393 and #396. |
| 9 | #396 | Stacked on #386. Tier: azureStorage, owner to confirm. |
| 10 | #393 | Stacked on #386. |
| 11 | #395 | Tier: auditLog, owner to confirm. ZIP keeps archived audit data on every plan. |
| 12 | #387 | Works only for self-built Linux packages; no Linux release exists. |
| 13 | #389 | |
| 14 | #388 | |
| 15, 6 | #384 | Docs only. Native Log Analytics output: follow-up, about 3 to 5 days. |
| 3, 4, 5 | none | Blocked on Graph: questions 3 to 5. |
| 16 | none | Waiting for the tier decision (question 1). |

CI note: the macOS "Sign-in end to end in the packaged app" step fails intermittently (browser traffic
never reaches the local stand-in). Reruns pass. A separate fix: have each browser probe the stand-in
before sign-in starts.
