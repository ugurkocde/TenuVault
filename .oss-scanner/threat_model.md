# Threat model

## What this project does and where untrusted input enters

TenuVault is an Electron desktop app (Windows and macOS) that backs up, compares and restores Microsoft Intune configuration. An Intune administrator signs in with delegated Microsoft Graph permissions (MSAL public client, loopback redirect). The app holds that admin's tokens and can write policies to one or more tenants, so the main assets are the token cache, the backup encryption keys and the integrity of what gets written to a tenant.

Untrusted or semi-trusted input:

- Backup ZIP archives imported by the user (`src/main/backup/archive.ts`, handler `backups:importArchive` in `src/main/index.ts`). Treat their content as fully attacker controlled; the archive is unsigned by design.
- Backup blobs read back from the customer's Azure Storage account (`src/portal/app/api/restore-backup/route.ts`, sealed with `src/main/storage/azure-seal.ts`) and local encrypted backups (`src/main/storage/local-blob-store.ts`). Assume someone with write access to the storage account or the backup folder, but without the keys.
- Microsoft Graph and Azure Resource Manager JSON responses (`src/shared/intune/read.ts`, `src/portal/lib/policies/graph-restore.ts`). Policy content is authored by any tenant admin and can contain hostile strings.
- XML inside policies, parsed with `@xmldom/xmldom` (`src/shared/compliance/applocker.ts`), and Azure Blob list XML.
- OpenIntuneBaseline content fetched from GitHub (`src/main/oib/source.ts`) and its on-disk cache.
- License service responses and license keys (`src/main/license/service.ts`), and the auto-update feed (`src/main/updates.ts`).
- Everything the renderer sends over IPC. Treat the renderer as untrusted: it renders tenant data, and a renderer compromise must not become main-process code execution or token access.

## Components that matter most / least

Most important:

- The main process IPC surface: `handleTrusted` and the handlers in `src/main/index.ts`, the preload bridge `src/preload/index.ts`, channel types in `src/shared/ipc.ts`, and the in-process API host `src/main/api/host.ts` with `src/main/api/fetch-bridge.ts`. Several handlers cast arguments without validating them.
- Restore and every other code path that writes to a tenant: `src/portal/app/api/restore-backup/`, `src/portal/lib/policies/`, `src/shared/intune/restore-plan.ts`, `src/main/oib/service.ts`, `src/main/features/*`. Includes cross-tenant copy, assignment replacement, `planGuard` and `disclaimerGuard`.
- Archive import validation and anything that turns archive content into file paths, Graph URLs or request bodies. Path and ID helpers live in `src/shared/security.ts`.
- Cryptography and secret storage: `src/main/storage/secure-store.ts`, `azure-seal.ts`, `local-blob-store.ts`, `src/main/backup/keys.ts` (recovery key export and import), `src/main/auth/`.
- Electron hardening: window options, CSP (injected at build time by `electron.vite.config.ts`), navigation and window-open handlers, the hidden PDF window in `reports:savePdf`, fuses in `electron-builder.config.cjs`.

Less important but in scope: report and export generation (PDF, HTML, CSV in `src/shared/`, `src/main/save-file.ts`), the renderer UI in `src/renderer` and `src/portal`, license verification.

Out of scope: `docs-site/` (static documentation site), `marketing/`, `build/`, `resources/`, `scripts/` (build and release tooling), `.github/`, and test code under `test/`.

## How to exercise it

- `npm test` runs the vitest unit tests offline (about 935 tests, a few seconds). Security relevant suites include `test/security-boundaries.test.ts`, `test/api-host.test.ts`, `test/backup-archive.test.ts`, `test/azure-seal.test.ts`, `test/secure-store.test.ts`, `test/storage-url-hardening.test.ts`, `test/backup-tenant-binding.test.ts`, `test/restore*.test.ts`, `test/assignment-replacement.test.ts` and `test/oib-*.test.ts`. Fakes for Graph and storage live next to them (`*-fakes.ts`, `test/helpers.ts`).
- Malicious archives are easiest to build in memory with JSZip, as `test/backup-archive.test.ts` does.
- `xvfb-run -a npm run smoke -- out/smoke` launches the built app (`out/`) headless with a throwaway profile and drives it over the Chrome DevTools Protocol. It needs no tenant and no network.
- `*.e2e.test.ts` files need a live lab tenant and cannot run here.

## How we rate severity

- Critical: code execution in the main process, or from the renderer, triggered by data (an archive, a backup blob, Graph content, OIB content, an update or license response); reading or exfiltrating the MSAL token cache, access tokens or backup master keys; causing writes to a tenant the admin did not select, or writes the admin did not confirm (for example assignments in a cross-tenant copy).
- High: escaping the IPC sender checks or calling handlers from an untrusted frame; arbitrary file write or read outside the app's directories; forging or tampering with a sealed or encrypted backup so that it restores without detection; bypassing the archive limits in a way that changes what gets restored; secrets written in plaintext to disk or logs in a packaged build.
- Medium: script or HTML injection in the renderer or in generated reports without a path to the above; CSV or formula injection in exports; crashes or hangs from crafted input (memory exhaustion, zip bombs past the size checks).
- Low: bypassing the license or plan gates (this harms the vendor, not users); information leaks with no secret or tenant data.

## Anything to leave alone

Known and documented, please do not report:

- Development builds (unpackaged) fall back to plaintext storage when OS encryption is unavailable; packaged builds refuse to start instead.
- ZIP exports are plaintext and may contain secret OMA-URI values; imported archives are unsigned and their `sourceTenantId` is self-declared. The import dialog says so.
- Legacy unsealed Azure backups are accepted for copy restores and flagged as unauthenticated.
- `DELEGATED_CLIENT_SECRET` in `src/shared/constants.ts` is a placeholder, not a credential. The checked-in license public key is an inert placeholder.
- Attacks that require code execution on the user's machine, control of the user's OS account, or Intune administrator rights in the target tenant already.
- Issues in Microsoft Graph, Entra ID, Azure Storage or Electron itself, unless TenuVault uses them in an unsafe way.

Reports are most useful with a reproducer as a vitest test in the style of the existing suites, and a minimal patch that keeps `npm test` and `npm run typecheck` passing.
