# Releasing TenuVault Desktop

Every change reaches `main` through a pull request that passes CI (admins may push directly).

## Channels

| Channel | When | Version | Updates from |
|---|---|---|---|
| Nightly | Every push to `main` whose CI passed | `0.1.0-nightly.20260926181500`: the next stable version and the build time (UTC) | `nightly.yml` on prereleases |
| Stable | A version tag, or the Release workflow with channel `stable` | `0.1.0` | `latest.yml` on stable releases |

Nightlies preview the next stable version: `package.json`'s version until it ships, then the
patch after the newest stable tag. The newest 20 nightlies stay on the release page.

Release notes list the pull requests merged and the issues closed since the previous release of
the same channel. Label pull requests `feature`, `bug`, `security` or `skip-changelog` to group them.

## Licensing invariants

License activation must survive every release. These are contracts with the installed base and
with the licensing service in the TenuVault-Website repository; changing one needs the
compatibility order noted here, not just a green test suite. The full hardening plan and its
rationale live in
[`tasks/license-activation-reliability-2026-11-06.md`](tasks/license-activation-reliability-2026-11-06.md).

- **Entitlement token versions.** The app accepts token versions 1 and 2. Client support for a
  new token version ships in a stable release before the service starts issuing it.
- **Refusal reasons.** The service's `403` reason strings are add-only, and a new reason ships in
  the app's `REASONS` map (`src/main/license/service.ts`) before the service can send it. An
  unknown reason is treated as "service unreachable" and must stay that way: only a confirmed
  refusal with a known reason may drop a cached entitlement.
- **Response shapes.** `activate`, `refresh`, and `tenant` answer `{token, activationId}`;
  `deactivate` answers `{success: true}`. Fields are add-only on both sides.
- **Stored state.** The secure-store keys `license.state`, `license.installId`,
  `license.removedTenants`, and `license.communityTenant`, the `userData` location, and the app identity that protects them
  (signing identity, product name) never change without a migration that older state survives.
  Losing `license.installId` silently consumes another of a tenant's five installations.
- **Licensing host.** Requests go to `https://www.tenuvault.com`, never the apex (it redirects,
  and license requests refuse redirects so the key and Microsoft ID token in the body cannot be
  replayed to another origin). Keep `redirect: "error"` on every request that carries a key, a
  token, or an entitlement.
- **Signing keys.** The app verifies tokens with the Ed25519 public key baked in at build time,
  plus the keys in `ROTATION_LICENSE_PUBLIC_KEYS` (empty outside a rotation). The current key's
  fingerprint is pinned in `scripts/license-public-key.ts`; release builds
  (`TENUVAULT_RELEASE_BUILD=1`, set by the release and manual installer workflows) fail when the
  configured key is the placeholder or any other key. The website mirrors the fingerprint and
  its health check fails when the production signer has another. Never switch the service
  signing key before an app that trusts the new key has shipped; follow "Rotating the license
  signing key" in `docs/release-setup.md`.
- **Released state fixtures.** `test/fixtures/license/` holds the license state bytes released
  versions wrote, and `test/license-upgrade.test.ts` loads them with today's code. Never edit or
  delete a fixture; add one for each stable release whose state format changes.
- **Buyer identity.** The Polar checkout email owns billing only. Activation binds the key to a
  tenant and an installation, never to an email address or a signed-in user. Do not add an
  email, UPN, or OID comparison to any licensing route.

Before promoting a nightly to stable, confirm on a machine running that nightly with a real paid
key that the License page still shows the plan active and a manual refresh succeeds.

A stable release, by tag or by promotion, fails when a commit since the previous stable release
changed a licensing file (`src/main/license/`, `src/main/storage/secure-store.ts`,
`scripts/license-public-key.ts`, `electron.vite.config.ts`) and has not been in a nightly for 24
hours (`.github/scripts/license-soak.mjs`). In an emergency, run the stable promotion by hand
with `allow_unsoaked_license_change`; a pushed tag has no override.

## Plan boundary changes

A change to what a plan includes (`src/shared/plans.ts`, `src/main/api/plan-gates.ts`) takes
effect with the next release that contains it. Call it out in that release's notes, and keep the
docs-site plan tables saying "from the next release" until the stable release ships. Merged
changes reach nightly users first.

The audit log (viewing, searching, exporting and removing old entries) is Pro and MSP. Every
plan records events; Community sees a locked preview on the Audit Log page.

## Compatibility notes for the next release

* Setup now keeps a service choice per tenant. Intune keeps its previous default permissions, including read access to Conditional Access while its backups stay off. Entra ID and Defender can be chosen to prepare backup permissions; their backup types arrive in later updates. Intune-only workflows direct tenants without Intune to Services and permissions.

Put these in the next stable release's notes, then remove them here.

- **Services and permissions.** Settings now checks Graph sign-in, the Backup Reader and storage
  independently, shows exact missing-permission routes and dated backup verification, and requires
  confirmation before Intune is turned off. Intune off is visible in backup history and schedules.
  Conditional Access keeps its independent choice inside the Entra ID card. Entra ID and Defender
  remain off for existing tenants; their cards say when this build has no backup types yet.
  The Azure CLI permission route skips scopes already declared on the registration. If a consent
  write fails, check consent in Entra before retrying because the request may have been applied.

- **Connection health history.** Health records now keep the active Backup Reader certificate's
  public SHA-256 thumbprint. Earlier health evidence is discarded when its account, registration,
  storage connection or active reader credential changes, including after restarting the app.
  Older health evidence with no persisted ownership is discarded conservatively at the next read.
  Acknowledgements use the displayed report's receipt, so later notices remain visible.

- **Connection checks.** TenuVault asks Microsoft for a new token of the signed-in admin when it
  starts (for the tenant that is open only), after a sign-in, and when a backup of a tenant starts
  and ends, and for a new Backup Reader token before a scheduled backup that runs with the reader.
  Admins who watch the Entra sign-in logs see more non-interactive sign-ins of the TenuVault app
  registration than before. No new destination and no new permission: the firewall allow list
  does not change.

- **Setup diagnostics.** New installs ask once on the welcome screen whether to share setup
  diagnostics with `POST https://www.tenuvault.com/api/desktop-events` (schema 1); turning it off
  or the policy sends `POST /api/desktop-events/erase`. The website's ingest and erase endpoints
  and the privacy page's setup diagnostics section must be deployed before a
  build with this feature ships, nightlies included; until then a sharing install retries with
  backoff and drops its queue after 7 days. The event names and props are a contract with that
  endpoint: they are add-only, and a new event or prop ships on the server before any app sends
  it. Existing installs are never asked. Admins can turn it off with the `DisableSetupDiagnostics`
  policy (Windows DWORD under `SOFTWARE\Policies\TenuVault`, macOS managed preference for
  `com.tenuvault.desktop`).
- **Services per tenant.** Intune can be turned off for a tenant under Settings > Services and
  permissions; it stays on for every existing tenant until an admin turns it off. The setting is
  stored in the same place and shape as before (`services.modules` in the app state), with more
  fields per service. Versions before 0.6 ignore those fields and always back up Intune, so a
  downgrade backs up Intune again for a tenant that had it off. Restore history now needs access
  to a service the tenant backs up (Intune while it is on), and its refusal message no longer
  names Intune.
- **Backup Reader per service.** A Backup Reader now follows the services its tenant backs up. The
  five Intune permissions are required only while Intune is on, and the reader may hold the read
  permission of any service (`New-TenuVaultBackupReader.ps1 -Services`, `-Areas`). Versions
  before 0.6 know only the Intune permissions and `Policy.Read.All`: they refuse a reader that
  holds any other permission ("permissions beyond read-only backup"), and its scheduled backups
  stop on that computer. A reader shared by several computers must not get Entra ID or Defender
  permissions before every one of them runs 0.6. A reader verified before the update keeps
  working unchanged. A change of its permissions no longer stops scheduled backups: they keep
  running with the verified permissions the reader still has, leave out what a removed permission
  read, and the Backup Reader card asks for a new verification.
- **Setup script parameters.** `New-TenuVaultDesktopApp.ps1` takes `-Services`, `-RestoreAccess`
  and `-Areas`. Without them it requests exactly the permissions it requested before, and every
  existing switch works as before. Quick setup still reuses an app registration that has
  tenant-wide admin consent for one of the Intune permissions of the default set, and now also one
  whose consent covers more than half of the permissions that backing up Entra ID or Defender asks
  for, or everything a setup for Conditional Access alone asks for (`User.Read`,
  `Organization.Read.All` and `Policy.Read.All`). When sign-in to the enterprise application of
  such a registration is turned off, setup stops instead of creating another one.

- **Backup coverage and outcomes.** A backup's `metadata.json` gains two fields: `Coverage`
  (`Complete` or `Incomplete`) and `Outcomes` (one entry per selected type: saved, not configured,
  skipped with a cause, or failed). `Status`, `Failures`, `SkippedTypes`, `FailedTypes` and every
  other field keep their meaning and their values, so the result of a backup, scheduled retries,
  notifications and retention do not change for a tenant that backs up what it did before. What
  is new to see: a backup with a type that was left out (for example one the app registration is
  denied, or one the Backup Reader does not read) shows "Coverage incomplete" in the backup result
  and in Backup Details. Versions before 0.6 ignore both fields and import such a backup as
  before. A backup that holds a type those versions do not know is refused there as a whole
  ("Unsupported backup item"). Backups made before 0.6 import into 0.6 and show no coverage.
- **A backup that read nothing fails.** A backup in which every selected type was left out (for a
  missing permission, role or license, or because only a signed-in admin can read it) used to end
  as successful although it held nothing. It now ends as failed with "Backup failed: nothing
  could be read" and the cause most of its types share. The scheduler retries it, the
  notification is a failure and every older backup is kept. This shows for a tenant that backs
  up only Conditional Access, Entra ID or Defender. For Intune it shows only when the backup
  choice leaves out device configuration profiles, compliance policies, settings catalog and
  endpoint security policies and administrative templates, and every remaining type is denied;
  a refused read of those four always failed the backup. A backup that read some types and left
  others out ends as before, and so does one whose types are all empty or not set up.
- **Refusals and pauses are counted per service.** For a tenant that backs up Intune and
  Conditional Access, refused reads and throttling are now counted for each service on its own.
  Five consecutive refused Intune reads end the backup even when Conditional Access reads succeed
  in between, and a pause of more than five minutes that Microsoft Graph asks of Intune no longer
  stops the Conditional Access reads. Requests that get no answer still count for both together.
- **Restore capability.** Every type has a restore capability, and a type without one is never
  written to a tenant by restore, revert, change sets, Sync, baselines or the copy to another
  tenant. Every type of earlier versions keeps what it could do.

## Cutting a stable release

Either promote the newest nightly (recommended, it ships exactly what nightly users ran):

```bash
gh workflow run Release -f channel=stable            # version defaults to what the nightly previewed
gh workflow run Release -f channel=stable -f version=0.1.0
```

or tag a commit on `main`:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

For a minor or major release, raise the version in `package.json` first; nightlies then preview it.

## Microsoft Store

TenuVault is listed in the Microsoft Store as an EXE app (Partner Center, Ugurlabs account).
Partner Center rejects GitHub release asset URLs because they redirect, so after every stable
release the `store` job of the Release workflow copies both Windows installers to the website's
public Vercel Blob store (`intunesnap-website-blob`). The package URLs follow this pattern:

```
https://aip4uoqwpdmqzreb.public.blob.vercel-storage.com/desktop/v<version>/TenuVault-<version>-win-x64.exe
https://aip4uoqwpdmqzreb.public.blob.vercel-storage.com/desktop/v<version>/TenuVault-<version>-win-arm64.exe
```

- The job uploads exactly the files on the GitHub release, checked against their SHA-256 digests,
  then fetches each URL without following redirects and checks HTTP 200 and the digest. The URLs
  are in the job summary, not in the release notes.
- Microsoft requires that the file behind a submitted URL never changes, so objects are never
  overwritten. Re-running the job passes when the stored files are identical and fails when they
  differ. A fixed build ships as a new version with new URLs.
- Nightlies are never uploaded.
- Secret `VERCEL_BLOB_READ_WRITE_TOKEN`: the `BLOB_READ_WRITE_TOKEN` of the TenuVault-Website
  Vercel project (production). Without it, stable releases still publish on GitHub, but the
  `store` job fails.

## WinGet and Homebrew

Every stable release also goes to WinGet and Homebrew, through the `package-managers` job of the
Release workflow (`.github/workflows/package-managers.yml`). Nightlies never do.

- **WinGet**: Komac (pinned version and checksum) opens a pull request for `UgurLabs.TenuVault`
  in `microsoft/winget-pkgs` with the x64 and arm64 EXE installers and the x64 MSI. It takes the
  package metadata from the newest version already there and the installer details from the
  files. The new version is installable once Microsoft's validation passes and the pull request
  merges, usually within a day. `winget install TenuVault` installs TenuVault Desktop.
- **Homebrew**: the job writes `Casks/tenuvault.rb` in
  [`ugurkocde/homebrew-UgurLabs`](https://github.com/ugurkocde/homebrew-UgurLabs) with the
  release's disk images and the SHA-256 digests GitHub recorded for them
  (`.github/scripts/homebrew-cask.mjs`). Users install with
  `brew install ugurkocde/UgurLabs/tenuvault`. The app updates itself, so the cask sets
  `auto_updates true`.
- Both steps skip a version that is already published, so re-running is safe. To publish a stable
  release again, run `gh workflow run "Package managers" -f tag=v0.1.0`.
- Secret `PACKAGE_MANAGERS_TOKEN`: a classic personal access token of the account that owns the
  `winget-pkgs` fork (ugurkocde) with the `public_repo` scope. Komac pushes the manifest branch
  to that fork and opens the pull request from it; the same token writes the cask. Without it,
  stable releases still publish on GitHub, but the `package-managers` job fails.

The earlier terminal app (TenuVault TUI, archived) used the same WinGet ID and cask name before
0.5.1. Its WinGet versions 1.2.1 to 1.7.2 were submitted for removal on 2026-11-12, so that the
desktop app is WinGet's newest version; until those removals merge, `winget install TenuVault`
still picks 1.7.2.

## Signing secrets

Every release is signed. Set these repository secrets once (Settings > Secrets and variables >
Actions, or `gh secret set NAME`); the workflow stops with the missing name when one is absent.

Windows, Azure Trusted Signing:

| Secret | Value |
|---|---|
| `AZURE_SIGNING_TENANT_ID` | Tenant of the app registration allowed to sign |
| `AZURE_SIGNING_CLIENT_ID` | Its client ID (role: Trusted Signing Certificate Profile Signer) |
| `AZURE_SIGNING_CLIENT_SECRET` | Its client secret |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | For example `https://weu.codesigning.azure.net` |
| `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` | Trusted Signing account name |
| `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` | Certificate profile name |
| `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` | Subject name on the certificate, for example `Ugur Koc` |

macOS, Developer ID and notarization:

| Secret | Value |
|---|---|
| `MAC_CSC_LINK` | Developer ID Application certificate as a base64 encoded `.p12` (`base64 -i cert.p12`) |
| `MAC_CSC_KEY_PASSWORD` | Its password |
| `APPLE_API_KEY` | Contents of the App Store Connect API key (`AuthKey_XXXX.p8`) |
| `APPLE_API_KEY_ID` | The key ID |
| `APPLE_API_ISSUER` | The issuer ID |

Licensing (already set): secret `TENUVAULT_LICENSE_PUBLIC_KEY`, variable `TENUVAULT_LICENSE_PORTAL_URL`.

Microsoft Store (already set): secret `VERCEL_BLOB_READ_WRITE_TOKEN`, see [Microsoft Store](#microsoft-store).

## Release trust boundary

Both maintainers have the same rights and follow the same rules; nobody can bypass them.

- Merging to `main` needs a pull request and green CI (typecheck, tests, smoke test, Windows and
  macOS packaging), no approval. Every merge becomes a nightly.
- A stable release promotes the newest nightly's commit, so stable only ships a build nightly
  users already ran. Any maintainer may start one.
- Releases only build commits reachable from `main`, and manual runs must be started from `main`.
- Pull request installers are unsigned and receive no signing credentials. Manual CI builds
  are also unsigned unless `signed_windows` is explicitly selected. That option uses the
  release signing credentials and production helper signature guard, verifies both app and
  helper publishers, and uploads a portable x64 verification ZIP alongside the installers.
  It does not publish a release. Run it before accepting the signed helper on a test PC:
  `gh workflow run ci.yml --ref <reviewed-branch> -f signed_windows=true`.
