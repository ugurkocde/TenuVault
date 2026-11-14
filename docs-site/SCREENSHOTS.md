# Documentation screenshots

Reviewed all 48 published documentation pages on 2026-11-14 against app version 0.3.0, source commit `f7b3c9e`. Added 48 placements on 30 pages, using 40 distinct captures. Existing update and notification images remain in place.

## Capture provenance and accuracy

- The new captures show the built Electron renderer, not generated artwork or recreated HTML. Tenant names, identities, histories and policy data are fictional fixtures. Captions distinguish initial workspaces, example results and simulated approval states.
- Empty Governance, Changes, Operations, My baselines and Reports screens deliberately show no assessments or completed work. Zero findings without a scan and Not scored must never be described as successful assessment results.
- OIB uses the real public catalog loaded by the app. Validation and tenant history are simulated. No deployment or remediation was performed.
- App Backup shows a fictional inventory and captured-installer catalog. No enrolled device, live installer capture, upload or tenant restore is claimed.
- The welcome image comes from the current built-app smoke capture. The remaining new images come from the documentation, marketing and approval capture sequences below.
- Dialog captures keep a small margin. Other captures retain navigation context. WebP encoding is lossless; images have intrinsic dimensions, lazy loading, alt text and a native full-size link.
- No Microsoft tenant write, Azure deployment, email or webhook was performed for these captures. These are interface illustrations, not live API verification evidence.

## Regenerate

From the repository root, with dependencies installed and a desktop display available:

```sh
npm run build
DOCS_SHOTS=1 MARKETING_SCALE=2 node scripts/marketing-shots.mjs out/docs-shots
MARKETING_SCALE=2 node scripts/marketing-shots.mjs out/docs-baselines
MAA_SHOTS=1 MARKETING_SCALE=2 node scripts/marketing-shots.mjs out/docs-approval
# The welcome capture is out/smoke/00-welcome.png from the built-app smoke suite.
node scripts/smoke.mjs out/smoke
node scripts/docs-shots-publish.mjs
npm --prefix docs-site run build
```

The capture harness uses a disposable profile. Only the OIB catalog reads contact GitHub; demo responses replace tenant operations. Inspect every image before publishing. Recheck captions whenever a feature changes. Screenshot publishing converts only referenced captures and updates their width and height. It does not replace existing update or notification images.

## Full page inventory

| Page | Screenshot decision |
| --- | --- |
| `apps/app-backup.md` | Added: `app-backup-apps`, `app-backup-installers`, `app-backup-restore`. |
| `audit-log.md` | Added: `audit-log`. |
| `backups/backup-reader.md` | Added: `settings-background`. |
| `backups/cloud.md` | Added: `backup-cloud`. |
| `backups/compare.md` | Added: `backup-history`. |
| `backups/conditional-access.md` | Reference and permission tables; the shared backup picker is illustrated in Run a backup. |
| `backups/coverage.md` | Kept the reference tables; corrected the picker count wording and retained the current App Backup availability guidance from main. |
| `backups/index.md` | Added: `backup-scope`, `backup-history`. |
| `backups/schedules.mdx` | Added: `backup-schedule`. |
| `backups/storage.md` | Added: `settings-storage`. |
| `baselines/cis-benchmarks.md` | A dedicated CIS result capture needs an authorized benchmark pack and verified assessment; do not substitute an OIB result. |
| `baselines/custom-baselines.md` | Added: `custom-baselines`. |
| `baselines/frameworks.md` | Added: `frameworks-light`. |
| `baselines/quick-start.md` | Added: `oib-home-light`, `oib-new-platforms`, `oib-new-select`, `oib-validate`. |
| `changes.md` | Added: `changes`, `baseline-upgrades`. |
| `deploy.mdx` | Deployment scripts and OS-specific tabs; installer/update screenshots already live in Install. |
| `drift.md` | Added: `drift-results`. |
| `getting-started/app-registration.md` | Added: `setup-connect`. |
| `getting-started/choose-storage.md` | Added: `setup-storage`. |
| `getting-started/connect-tenant.mdx` | Added: `setup-connect`, `setup-signin`. |
| `getting-started/create-storage-account.md` | Azure provisioning instructions; no authenticated Azure portal capture was available. The in-app choice is illustrated in Choose storage. |
| `getting-started/first-backup.md` | Added: `backup-scope`. |
| `getting-started/first-launch.md` | Added: `welcome`. |
| `getting-started/index.md` | Added: `dashboard`. |
| `getting-started/install.mdx` | Keep the existing real Windows and macOS nightly-update screenshots, with their explicit version labels. |
| `getting-started/multiple-admins.md` | Shared-storage and trust model reference; setup controls are illustrated in Choose storage. |
| `getting-started/requirements.md` | Prerequisites and network tables; no distinct app screen. |
| `governance.md` | Added: `governance`, `hygiene`, `customizations`. |
| `licensing/index.md` | Plan comparison tables; avoid presenting one sample entitlement as the reader’s plan. |
| `licensing/manage.md` | Key and per-tenant license states vary. Do not use a capture showing a misleading trial/coverage warning; welcome key-entry location is illustrated in First launch. |
| `notifications.md` | Keep the existing three Teams and email delivery screenshots. They show the actual recipient experience. |
| `operations.md` | Added: `operations`. |
| `reports.md` | Added: `reports`. |
| `restore/cross-tenant.md` | Needs a dedicated multi-target wizard capture and dependency-mapping example; same-tenant Review must not stand in for it. |
| `restore/disaster-recovery.md` | Added: `restore-selection`. |
| `restore/index.md` | Added: `restore-backup`, `restore-selection`, `restore-review`. |
| `restore/limitations.md` | Restorability and reconciliation reference; recovery readiness is illustrated in Restore. |
| `restore/modes.md` | Added: `restore-method`. |
| `restore/multi-admin-approval.md` | Added: `maa-confirm`, `maa-submitted`. |
| `security/conditional-access.md` | Policy behavior and troubleshooting reference; no authenticated Entra portal capture. |
| `security/data-flows.md` | Network and privacy reference; avoid screenshots of potentially sensitive operational values. |
| `security/encryption.md` | Added: `settings-storage`. |
| `security/index.md` | Security architecture and trust reference; related recovery controls are illustrated in Encryption. |
| `security/permissions.md` | Permission reference; never show a successful permission check without verified evidence. |
| `settings.md` | Added: `settings-signin`, `settings-storage`, `settings-background`, `settings-branding`. |
| `sync.md` | Added: `sync`. |
| `tenants.md` | Added: `dashboard`, `tenants-overview`, `tenant-management`. |
| `troubleshooting.md` | Error-message lookup reference; successful workflows are illustrated in their own guides. Dedicated failure captures can be added when reproduced. |

## Further captures that need their own evidence

Useful follow-ups are a licensed CIS assessment, cross-tenant dependency mapping, an expanded backup change, a populated change report, and authenticated Entra/Azure setup steps. Capture and inspect those exact screens before illustrating them; do not relabel another workflow or present simulated results as live evidence.
