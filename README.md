<div align="center">

<img src="build/icon.png" alt="" width="88" height="88">

# TenuVault

**Intune backup, restore, drift detection and OpenIntuneBaseline, on your machine.**

A desktop app for Windows and macOS, built for organisations whose admins are not allowed to sign in
to third-party web apps, or whose Conditional Access policies block them.

[Website](https://tenuvault.com) · [Documentation](https://docs.tenuvault.com/getting-started/) · [Pricing](https://tenuvault.com/pricing) · [Trust Center](https://tenuvault.com/trust)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/dashboard-dark.webp">
  <img src="docs/screenshots/dashboard-light.webp" alt="TenuVault Desktop dashboard with the last backup, success rate, next scheduled backup, protected policies and drift status of a tenant">
</picture>

<p align="center">
  <a href="https://www.tenuvault.com/download/windows"><img src="docs/assets/download-windows.svg" alt="Download the latest stable TenuVault release for Windows" width="240" height="64"></a>
  &nbsp;
  <a href="https://www.tenuvault.com/download/mac-arm64"><img src="docs/assets/download-macos.svg" alt="Download the latest stable TenuVault release for macOS" width="240" height="64"></a>
</p>

The buttons download the latest stable Windows `.exe` setup or macOS `.dmg` for Apple silicon directly.
For Intel Macs, use the [Intel download](https://www.tenuvault.com/download/mac-x64).
A Windows x64 `.msi` is also available on the [release page](https://github.com/ugurkocde/TenuVault/releases/latest) for managed deployment.
See the [installation guide](https://docs.tenuvault.com/getting-started/install/) for help choosing.

## What it does

- **Backup.** Settings Catalog, device configurations, compliance, scripts, Administrative Templates
  and more, with their assignments. On demand or on a daily or weekly schedule, encrypted on this
  device or in your own Azure storage account.
- **Restore.** Bring back single items or whole sets from any backup. Copies are created as separate
  policies; cross-tenant copies arrive unassigned and need reviewed target dependencies.
- **Drift detection.** See what changed between backups, down to the setting, and export the result
  as JSON or CSV.
- **OpenIntuneBaseline.** Deploy, compare and validate OpenIntuneBaseline policies from the latest
  upstream version, with a backup first and undo per run. New policies are created unassigned.
- **Frameworks.** Compare your Intune configuration with framework controls such as NIST, ISO 27001
  and UK NCSC Device Security Guidance.

## How it keeps your data yours

- **Runs on your machine.** The app talks to Microsoft (sign-in, Microsoft Graph, Azure) and, for
  license checks only, to tenuvault.com. It also downloads public updates and optional framework
  content from GitHub (see [Outbound network access](#outbound-network-access)). No tenant data or Microsoft access token ever reaches a
  TenuVault server. License checks can send a Microsoft ID token as proof of the tenant; it is
  verified and never stored.
- **Signs in as you.** Delegated sign-in with your own admin account through an app registration in
  your own tenant: a public client with no secret. MFA and Conditional Access apply as they do in
  the Intune portal, and every change is attributed to you in the Entra and Intune audit logs.
- **Backups stay where you want them.** Encrypted on this device by default (AES-256-GCM, key
  protected by Windows DPAPI or the macOS Keychain), or in your own Azure storage account.

## Restore, recovery and assessment scope

Desktop backups include **Administrative Templates** by default, under Device configuration in
the backup scope picker. Each `GroupPolicyConfigurations` snapshot includes the policy,
assignments, configured definition values and their presentation values. Settings Catalog
policies are backed up separately under `ConfigurationPolicies`.

An Administrative Templates access failure marks the backup incomplete and preserves older
backups. Check the backup log and your Intune permissions if this category is missing; a custom
backup scope can also exclude it. See [Administrative Templates verification](docs/administrative-templates.md)
for the verified API coverage and its limits.

Copy creates separate policies; replacement updates supported existing policies or recreates missing ones. Assignments are explicit and have type-specific limits. Cross-tenant copies remain unassigned and require reviewed target dependencies. Partial operations retain created IDs for repair, and ambiguous writes require reconciliation.

The OpenIntuneBaseline section deploys, compares and validates OIB policies (the OIBDeployer workflows); Frameworks compares Settings Catalog configuration with separate assignment evidence. Neither claims device enforcement or framework certification. See the [framework guide](docs/frameworks.md), [coverage metadata](docs/framework-coverage.md) and [reliability scope](docs/reliability-review.md).

For recovery, see [readiness and manual artifacts](docs/disaster-recovery.md), [Azure encryption and recovery keys](docs/azure-backup-encryption.md), and [background scheduling limits](docs/background-backups.md). ZIP import reviews complete exports before saving locally; it does not modify Intune.

## Customer setup

1. Run [`resources/New-TenuVaultDesktopApp.ps1`](resources/New-TenuVaultDesktopApp.ps1), also
   available in the app. It creates a single-tenant public client app registration with these
   delegated permissions and grants admin consent:
   - Microsoft Graph: `User.Read`, `Organization.Read.All`, `Policy.Read.All`,
     `DeviceManagementConfiguration.ReadWrite.All`, `DeviceManagementApps.ReadWrite.All`,
     `DeviceManagementServiceConfig.ReadWrite.All`, `DeviceManagementScripts.ReadWrite.All`,
     `DeviceManagementRBAC.ReadWrite.All`, `DeviceManagementManagedDevices.Read.All`
   - Azure Service Management and Azure Storage: `user_impersonation` (only used when backups go to
     an Azure storage account)

   Redirect URI: `http://localhost`.
   `-AllowedGroupId` restricts sign-in to one group.
2. Admins need an Intune role, for example Intune Administrator. To store backups in Azure they
   also need `Storage Blob Data Contributor` on the storage account.

## Outbound network access

In addition to Microsoft sign-in, tenant APIs, Azure storage, and the licensing service,
these optional features need outbound HTTPS (TCP 443) to GitHub:

| Destination | Purpose and timing | If blocked |
|---|---|---|
| `github.com` | The updater reads the public `ugurkocde/TenuVault` release feed and channel metadata, then requests installer assets. Packaged apps with updates enabled check after 15 seconds and every 6 hours; Settings offers a manual check when updates are enabled and platform policy permits them. | Update checks or downloads fail; the installed version remains available. |
| `release-assets.githubusercontent.com`, `objects.githubusercontent.com` | GitHub release-asset redirects used to download installers and update files. Permit the redirect destinations as well as `github.com`. | Release metadata may load but downloads fail. |
| `api.github.com` | The OpenIntuneBaseline section resolves the latest commit of the OpenIntuneBaseline `main` branch and reads its repository tree when a pack is loaded. | The OpenIntuneBaseline workflows cannot start; uncached packs cannot load. |
| `raw.githubusercontent.com` | Downloads public OpenIntuneBaseline policy JSON and `PolicyManifest.json` from the resolved commit when a pack is loaded. | Uncached OpenIntuneBaseline packs cannot load. |

GitHub receives requests for public repository paths and normal connection metadata, such
as the source IP. These download paths do not upload tenant snapshots, policy contents,
Microsoft tokens, or licensing tokens. GitHub does not execute tenant changes; downloading
a pack and applying it are separate actions.

The OpenIntuneBaseline section caches the resolved `main` commit for 10 minutes and up to four loaded packs in memory.
A loaded pack may remain usable during a network outage in the current app session; this
is not a persistent offline pack library. GitHub rate limits can also interrupt downloads.
Blocking GitHub does not itself disable backup, restore, or local file access, which still
have their own authentication, licensing, and storage requirements.

Admins can disable automatic updates in Settings or with the `DisableAutoUpdate` policy
(Windows: HKLM/HKCU `SOFTWARE\Policies\TenuVault`, DWORD `1`; macOS: managed preference
`com.tenuvault.desktop`, boolean `true`). Development builds do not auto-update.
GitHub may change asset redirect hosts; validate the redirect chain for the release being
deployed when maintaining a strict proxy allowlist. See GitHub's
[release asset download documentation](https://docs.github.com/en/rest/releases/assets).

Source: `src/main/updates.ts`, `src/main/oib/source.ts`,
`src/main/frameworks/service.ts`, and the installed `electron-updater` GitHub provider.

## Architecture

Electron with a React renderer (Vite) and a Node main process.

| Folder | Contents |
|---|---|
| `src/main` | Main process: sign-in (`auth`), licensing (`license`), backup engine (`backup`), encrypted storage (`storage`), API host (`api`) |
| `src/preload` | The `window.tenuvault` bridge exposed to the renderer (context isolation, sandboxed) |
| `src/renderer` | App shell, desktop pages (onboarding, settings, license) and Next.js API shims |
| `src/portal` | Portal UI pages and their API routes (`app/api/**/route.ts`), imported with the `~/` alias |
| `src/shared` | Types and constants used by both processes |

- **API routes** run in the main process behind an IPC bridge. The renderer's `fetch("/api/...")`
  is forwarded over IPC (`src/renderer/lib/fetch-bridge.ts`); `next/server`, `next/navigation` and
  `next/headers` are small shims.
- **Tokens.** Tenant profiles carry the placeholder `DELEGATED_CLIENT_SECRET` instead of a secret.
  When route code asks for a client credentials token with it, `src/main/api/fetch-bridge.ts`
  answers with a delegated MSAL token for the signed-in admin. Background requests never open a
  sign-in window; the app shows a banner when the admin must sign in again.
- **Sign-in** (`src/main/auth/msal.ts`, `@azure/msal-node`): the system browser on Windows and
  macOS, so admins can use a separate admin account rather than the one signed in to the OS.
- **Backups** (`src/main/backup`) export every Intune object type listed in
  `src/shared/intune/registry.ts` (configuration, compliance, endpoint security, scripts,
  updates, apps, app protection, enrollment and tenant administration), including assignments, as
  `backup-<timestamp>/<type>/<name>.json` plus `metadata.json`. Restore uses the same registry to
  create copies or replace objects in place. App installer files, Apple tokens and certificates
  cannot be exported by Microsoft Graph; those items are kept for reference.
- **Schedules** (`src/main/backup/scheduler.ts`): daily or weekly per tenant, run by the app while
  it is open or in the system tray; slots missed while the computer was off run once at the next
  start. Optional start at login. After each backup, backups older than the retention period
  (default 30 days) are deleted, always keeping the newest.
- **Local storage** (`src/main/storage`): one AES-256-GCM file per blob, named by an HMAC of the
  blob name, in a folder the admin chooses. The master key is random; admins save a recovery key
  (`TVK2.` bundle containing all key generations) from Settings to read backups on another device.
  Legacy `TVK1.` keys remain importable; save a fresh bundle after importing keys. `blob-emulator.ts` serves the Azure
  Blob REST subset the routes use for local (`tvlocal-<tenant id>`) accounts, so the same code
  reads local and Azure backups.

## Development

Releases (nightly on every green push to `main`, stable from a version tag) and the signing
secrets they need are described in [RELEASING.md](RELEASING.md).

```bash
npm ci
npm run dev          # Electron with hot reload
npm run typecheck
npm test             # unit tests
npm run build && npm run smoke -- out/smoke [license-key-file]   # drive the built app, save screenshots
npm run build && node scripts/marketing-shots.mjs out/marketing   # product screenshots with demo data
```

`scripts/marketing-shots.mjs` captures the real app UI with fictional demo data injected at the IPC
boundary (no Microsoft or licensing calls, no source changes). The README screenshots in
`docs/screenshots/` come from it.

`npm run test:e2e` runs read-only calls and a full backup into a temporary encrypted store against
a real tenant. It needs `TENUVAULT_E2E_TENANT_ID`, `TENUVAULT_E2E_CLIENT_ID` and
`TENUVAULT_E2E_CLIENT_SECRET` (an app registration with read access to Intune), and optionally
`TENUVAULT_E2E_STORAGE_ACCOUNT` to check Azure storage access.

## Licensing

Community is free for one tenant and needs no license key. Pro covers two tenants and MSP the
subscribed quantity (starting at three tenants); the features each plan includes are defined in
`src/shared/plans.ts`. Pro and MSP are bought on [tenuvault.com/pricing](https://tenuvault.com/pricing)
(Polar checkout, 30 day free trial). The key holder receives a `TENU` license key by email and pastes
it on the License page; other admins can use a shared organization license without receiving the key.

- **Online activation, offline verification** (`src/main/license/service.ts`). The app never talks to
  Polar. It calls `tenuvault.com/api/desktop-license/{activate,refresh,deactivate,tenant}`, which
  checks the key with Polar and answers with an Ed25519 signed entitlement token bound to one tenant
  and this installation. The app verifies the token with the public key built into it, refreshes it
  every 6 hours and keeps working offline until it expires (14 days). A confirmed refusal (HTTP 403)
  drops the paid token; an outage preserves it only until expiry. A paid activation with an unavailable service is not silently downgraded. Community can work offline without a licensing token, but Microsoft sign-in and live tenant operations still require connectivity.
- **Paid activation per tenant.** Each paid tenant gets its own Polar activation, one per installation and tenant, created
  the first time the tenant is signed in or used. The service ranks a key's tenants by their oldest
  activation: a Pro key covers 2 tenants, an MSP key as many as the subscription quantity, and each
  tenant allows 5 installations. Feature and storage access checks use the tenant's effective
  Community or paid plan (`authorizeTenant` in `src/main/api/fetch-bridge.ts`). Removing a tenant releases
  its activation and frees its place on the key. Scheduled and tray backups check the tenant's
  plan first; a tenant that fits neither a paid license nor the one-tenant Community allowance is not backed up, and the failure shows as a
  notification and on the tenant's schedule. The tenant's audit log lives in its own storage, which
  is closed without a license, so each refusal is also kept in a log on this device (the most recent
  200, in the encrypted app store) and listed on the tenant's Schedule tab.
- **Adding a tenant.** The license is checked when the admin signs in to a new tenant and again
  before the tenant is saved. When the license does not cover it, the tenant is not added, the new
  sign-in is removed and the reason is shown. Connected tenants without a check (for example from
  an older version) are checked at start when they are signed in, otherwise at their next sign-in;
  until then the overview shows "License checked at first use".
- **First run.** Without a key and without a connected tenant the app opens on a welcome screen
  that offers Community sign-in, a key, or a paid trial. Admins licensed through their organization continue to
  the tenant sign-in without a key. The tenant switcher and the all tenants overview mark tenants the
  license does not cover.
- **Organization licenses.** The key holder can share the license with a tenant's other admins. They
  sign in with the same app registration and are licensed through the `tenant` route, checked with a
  fresh Microsoft ID token; the key never reaches their machine. Pro keys share by default, MSP keys
  do not. Shared admins count toward the same per-tenant installation limit.
- **Storage.** Key, activations and tokens live in the app's encrypted store (`safeStorage`: DPAPI or
  Keychain). Without OS encryption they are kept in memory only.
- **Build configuration** (`electron.vite.config.ts`): `TENUVAULT_LICENSE_API_BASE` (default
  `https://tenuvault.com`), `TENUVAULT_LICENSE_PUBLIC_KEY` (default: an inert placeholder, so an
  unconfigured build cannot verify paid entitlements), `TENUVAULT_LICENSE_BUY_URL` and
  `TENUVAULT_LICENSE_PORTAL_URL`. `npm run license:keypair` prints a new key pair: the private key goes
  into the website's `DESKTOP_LICENSE_SIGNING_KEY`, the public key into
  `TENUVAULT_LICENSE_PUBLIC_KEY`.
- **Release builds** take the production public key from the `TENUVAULT_LICENSE_PUBLIC_KEY` repository
  secret and the portal URL from the `TENUVAULT_LICENSE_PORTAL_URL` repository variable
  (`https://polar.sh/ugurlabs/portal`). Vercel preview deployments of the website sign with a separate
  sandbox key pair, so their tokens never verify in a release build.

## Releases and code signing

Everything to set up before the first release (Polar, Vercel, GitHub variables and secrets, Apple
and Azure signing) is in [docs/release-setup.md](docs/release-setup.md).

`.github/workflows/ci.yml` typechecks, tests and smoke tests on Linux, then builds and smoke tests
installers on Windows (NSIS for x64 and arm64, MSI for Intune deployment) and macOS (DMG and ZIP
for arm64 and x64). Pushing a `v*` tag (matching `version` in package.json) publishes the installers and
the auto-update feed to this repository's GitHub releases.

The app checks for updates every 6 hours and installs them on restart. Admins can turn this off in
Settings, or for managed devices by policy: the DWORD `DisableAutoUpdate` = 1 under
`HKLM\SOFTWARE\Policies\TenuVault` (or HKCU) on Windows, or the managed preference
`DisableAutoUpdate` = true for `com.tenuvault.desktop` on macOS. macOS updates require signed builds.

Signing turns on when these repository secrets exist, and release tags fail without them:

- Windows, Azure Trusted Signing: `AZURE_SIGNING_TENANT_ID`, `AZURE_SIGNING_CLIENT_ID`,
  `AZURE_SIGNING_CLIENT_SECRET` (an app registration with the *Trusted Signing Certificate Profile
  Signer* role), `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- macOS: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` (Developer ID Application certificate) and
  `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` for notarization.

## Maintainers

- [Ugur Koc (@ugurkocde)](https://github.com/ugurkocde)
- [James Robinson (@SkipToTheEndpoint)](https://github.com/SkipToTheEndpoint)

## License

TenuVault Desktop is licensed under the [Business Source License 1.1](LICENSE). It is source
available, not open source:

- You may read, build, modify and use it at no charge to back up, restore, assess and manage
  Microsoft tenants owned by your organization and its affiliates.
- Managing any customer or third party tenant (for example as an MSP, even with delegated
  access), or offering it, a derivative or its functionality to others, whether paid or free,
  requires a commercial license from Ugurlabs UG.
- Official builds (the signed installers and updates we publish) are licensed under the
  [TenuVault Desktop EULA](EULA.txt), which follows the TenuVault plans (Community, Pro, MSP)
  described in [Licensing](#licensing). The installers show it before installation.
- Four years after each version is published, that version becomes available under the Apache
  License 2.0.

Contributions require signing the [Contributor License Agreement](CLA.md). A bot asks for the
signature on your first pull request.
