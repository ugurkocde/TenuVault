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
  `license.removedTenants`, `license.communityTenant`, `license.tenantTrials`, and
  `license.tenantTrialInstallLimit`, the `userData` location, and the app identity that protects them
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

Paid key activation and a real Microsoft sign-in are verified for every nightly by the
[nightly verification](#nightly-verification), not by hand.

A stable release, by tag or by promotion, fails when a commit since the previous stable release
changed a licensing file (`src/main/license/`, `src/main/storage/secure-store.ts`,
`scripts/license-public-key.ts`, `electron.vite.config.ts`) and has not been in a nightly for 24
hours (`.github/scripts/license-soak.mjs`). In an emergency, run the stable promotion by hand
with `allow_unsoaked_license_change`; a pushed tag has no override.

## Sign-in test

A complete first browser sign-in runs in the packaged app before anything ships, so no manual
sign-in check is needed per release. `scripts/sign-in-e2e/` starts the app with a fresh profile,
enters a tenant and client ID, starts the sign-in, takes the Microsoft sign-in address through
Copy sign-in link and follows it in Playwright Chromium, Firefox and WebKit, and in Microsoft Edge
on Windows, one sign-in per engine. A local stand-in for `login.microsoftonline.com` answers the
authorize and token requests with a signed ID token; the app redeems the code through MSAL and
must show the storage step with the signed-in account. The licensing requests that follow are
answered by the stand-in too (`www.tenuvault.com`: the health policy and 401 `invalid_token`, as
production answers an ID token it cannot verify), so the test sends nothing to production;
production licensing stays with the license canary. It also checks that the listener closes after
the answer, that an answer with another state is refused, and that a refusal shows the app's error.

| Event | Linux | Windows | macOS |
|---|---|---|---|
| Pull request (CI) | packaged (`--linux dir`) | packaged, when installers are built | packaged, when installers are built |
| Push to `main` (CI) | packaged (`--linux dir`) | no (CI builds no installers on push) | no |
| Nightly, or stable by promotion (Release workflow on `main`) | no (no Linux release) | packaged, signed | packaged, signed |
| Stable release from a pushed tag | no | packaged, signed, only when the tagged commit has the test | same as Windows |

So every nightly's Windows and macOS packages pass it before they are published, and Linux is
checked on every pull request and push. A nightly or a promotion (the Release workflow run on
`main`) takes the test from the workflow's own commit, not from the release target, so promoting a
nightly that predates the test still runs it against that nightly's packaged app. A pushed tag runs
the Release workflow from the tagged commit itself: a tag on a commit from before the test runs no
sign-in test, so prefer the promotion for such a release.

The app has no test switch: the test changes only the runner, with hosts file entries for both
hosts and a throwaway root certificate in the operating system's trust store (`runner.mjs`). Each
change is recorded before it is made; a workflow step that always runs, also after a cancel or a
timeout, undoes them, reads the machine back and fails the job when an entry or the certificate is
left, when the macOS keychain default or search list is not restored, or when a store could not be
inspected (a failed or empty listing never counts as "removed", and the state is kept for another
cleanup). On Linux a pending regeneration of the CA bundle is retried until the generated bundle
no longer holds the root's fingerprint. The root's private key is deleted as soon as the stand-in's certificate is issued. The test
refuses to run outside CI. Every Playwright browser context skips its own certificate check
(Firefox and WebKit keep trust stores of their own); the app's certificate checks are real.

Credential stores: on Linux the job runs the app in a session bus with an unlocked gnome-keyring
(`XDG_CURRENT_DESKTOP=GNOME`), because packaged builds refuse to start without OS encryption; on
macOS the test makes a disposable unlocked keychain the default for its duration, because the
runner's login keychain can be locked by then.

Screenshots, app logs, `results.txt` and `stand-in.log` are written after every engine and
uploaded as `sign-in-e2e-<OS>` in CI and `release-sign-in-e2e-<OS>` in releases.

## Nightly verification

Every published nightly is installed and used as users get it, by
`.github/workflows/nightly-verification.yml`. It starts when a Release run completes and
verifies exactly the tag and commit that run published (the `published-nightly` artifact the
publish job uploads right after creating the release, also when a later step fails or the run is
cancelled). Runs that published nothing (stable releases, skipped nightlies) verify nothing. It
checks:

- **Installers and signatures.** Every installer is checked before anything runs it. On
  `windows-latest` every published Windows installer (x64 EXE and MSI, arm64 EXE, combined EXE)
  must carry a valid Authenticode signature with the publisher in
  `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`, all with the same certificate subject. The x64 MSI
  installs silently for all users, is checked and removed, then the x64 NSIS installer installs
  silently for the current user; on both installations `TenuVault.exe` and
  `resources/app-backup/TenuVault.Capture.exe` must be signed by that publisher, and the
  installed app by the installers' subject. On `macos-latest` the app in every published disk
  image and update zip (both architectures) must pass `codesign --verify --deep --strict` with
  a Developer ID Application authority of Team ID `D259ULY2B4`, carry a stapled notarization
  ticket, and be accepted by Gatekeeper as notarized. The runner's own architecture's disk image
  is mounted (license accepted) and its app copied to `/Applications`, and checked again there.
- **Paid key** (`scripts/nightly-verification/license.mjs`). The installed app starts with a
  fresh profile and is driven over the DevTools protocol like the smoke test. It saves the
  licensing canary's Pro key (`LICENSING_CANARY_KEY`) on the welcome screen, activates it against
  production for the verification tenant (the check a first sign-in runs), and checks the
  License page shows the tenant as Active, Pro. The key must not be readable in plain text in
  the profile, a refresh must reach the service and keep Pro, and the key must come back after a
  restart (the operating system credential store round trip; on macOS the login keychain, which
  must be unlocked). The activation is released at the end. On start the app itself releases
  activations of tenants that are not connected, so the activation may already be gone after the
  restart; that is expected.
- **Microsoft sign-in** (`scripts/nightly-verification/sign-in.mjs`). With a fresh profile per
  browser, the installed app goes through Connect your tenant, I already have an app
  registration, the test tenant and client IDs, and Sign in with Microsoft. The harness copies
  the sign-in link the app offers for another browser, completes Microsoft's login page in
  Playwright Chromium, Firefox and WebKit (and Microsoft Edge on Windows), answers "Stay signed
  in?" with No, and checks the app shows "Signed in as" the test user and holds an account whose
  tenant, user and app registration all match. No license key is used.

Both harnesses run with the `DisableAutoUpdate` policy set (as managed deployments use it) and
check after every start that the running app is the nightly under test, so a newer release the
app would otherwise update to is never what gets verified.

### The canary key and its activations

The paid key check uses the canary's key but its own tenant
(`c0a1b2c3-d4e5-4f60-8a71-9b0c1d2e3f50`), never the canary tenant of
`scripts/license-canary.ts`. The Pro key covers two tenants: the canary's and this one. Each
tenant allows five installations, and each verification is a new installation (the app picks a
random installation ID per profile and keeps it in its encrypted store).

- Paid key checks never overlap: every run's paid key jobs wait in one queue
  (`nightly-verification-paid-key`, `queue: max`, up to 100 waiting in arrival order), and the
  two platforms run one after the other. A run with nothing to verify ends before any queue, so
  it never takes the place of a waiting nightly.
- An activation is released by the check itself; if that step fails, times out or is
  cancelled, by the step "Release a leftover activation", which runs regardless and starts the
  app again with the kept profile (the app also releases the never connected tenant by itself
  on that start). When that release does not succeed either, the step keeps the profile and
  fails, so the leftover shows in the run.
- What none of these can release (a runner lost mid run, a profile the app can no longer read)
  stays on the verification tenant, never on the canary tenant. At most five such activations
  can exist; with five recent ones the next verification is refused with `install_limit`, fails
  and alerts, and the licensing service frees the oldest once it has not been used for 30 days.
  The canary is not affected either way.

### Result and gate

The result is the commit status `Nightly verification` on the nightly's commit, linking to its
run, and the run's `nightly-verification-result` artifact (`{ sha, tag, state, runId }`)
(`.github/scripts/nightly-verification-outcome.mjs` has the rules):

- Only runs from `main` record them: the run a Release run starts, or a manual run from `main`.
  Runs from other branches, pushes and pull requests record nothing and never alert.
- `success` needs all four checks (paid key and sign-in, Windows and macOS) to pass.
- A failed or timed out check records `failure`, fails the run (GitHub emails the maintainer) and
  is emailed with the subject "TenuVault release: nightly verification failed", naming each check
  and how it ended. The release-triggered run always emails; a manual run only with `alert`.
- A cancelled, skipped or missing check records `error` (or `failure` when another check
  failed): the nightly counts as unverified, the stable gate refuses it, and a run with a
  cancelled check never emails.
- A run never writes over the result of a newer verification run from `main` of the same commit
  (one started later). Results are written one at a time (`nightly-verification-result`,
  `queue: max`).

The email goes to `https://www.tenuvault.com/api/desktop-license/nightly-verification-alert`
(TenuVault-Website), authorized with `LICENSING_CANARY_ALERT_SECRET`, with the body
`{ failures: string[], runUrl }`; the route refuses any other field and control, format or line
separator characters, which the alert removes. Where the route is not deployed the request
answers 404, no email is sent, and GitHub's failed run email is the only alert.

The repository is public, so screenshots are kept only for failed checks, for 3 days, with the
license key, the test account and the tenant and app IDs replaced before the capture.

Rerun it for a nightly, for example after fixing a secret or a flaky Microsoft page:

```bash
gh workflow run nightly-verification.yml -f tag=v0.5.3-nightly.20261114180404
gh workflow run nightly-verification.yml -f tag=v0.5.3-nightly.20261114180404 -f alert=true
```

Secrets (Settings > Secrets and variables > Actions):

| Secret | Value |
|---|---|
| `LICENSING_CANARY_KEY` | The canary Pro key, shared with the licensing canary |
| `LICENSING_CANARY_ALERT_SECRET` | The canary's alert secret, also authorizing the nightly verification alert route |
| `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` | The expected Authenticode publisher, shared with signing |
| `TENUVAULT_E2E_TENANT_ID` | The test tenant's ID |
| `TENUVAULT_E2E_CLIENT_ID` | Its TenuVault app registration: public client, redirect `http://localhost`, tenant-wide admin consent |
| `TENUVAULT_E2E_USERNAME` | A dedicated test user without an admin role, without MFA and outside Conditional Access |
| `TENUVAULT_E2E_PASSWORD` | Its password |

Without the sign-in secrets the sign-in jobs fail and say which are missing; they never pass.

A stable release, by promotion or by tag, fails unless its commit passed
(`.github/scripts/nightly-verified.mjs`). The gate trusts no status by itself: it fetches the
run each `Nightly verification` status links to and counts only runs of
`.github/workflows/nightly-verification.yml` in this repository, on `main`, started by a Release
run or by hand. The newest such run decides: it must have finished with success, and its result
artifact must name exactly this commit with `success`. Anything else, including any error
reading GitHub, refuses the release. Rerun the verification for the commit's nightly, or in an
emergency run the stable promotion by hand with `allow_unverified_nightly`; a pushed tag has no
override.

Nightlies published before this gate existed have no recorded verification. For the first stable
promotion after it lands, run the verification for the nightly being promoted from `main`
(`gh workflow run nightly-verification.yml -f tag=<nightly tag>`) and wait for it to succeed, or
in an emergency promote with `allow_unverified_nightly`.

## Plan boundary changes

A change to what a plan includes (`src/shared/plans.ts`, `src/main/api/plan-gates.ts`) takes
effect with the next release that contains it. Call it out in that release's notes, and keep the
docs-site plan tables saying "from the next release" until the stable release ships. Merged
changes reach nightly users first.

The audit log (viewing, searching, exporting and removing old entries) is Pro and MSP. Every
plan records events; Community sees a locked preview on the Audit Log page.

## Compatibility notes for the next release

- Enable individually confirmed cross-tenant parent display-name updates, unpublished and externally hidden user-managed catalog create/update without resources, and the access-review ownership flag (beta). All remaining External identities, Governance, Roles and PIM and Defender operations stay blocked with their specific evidence gaps. Custom attribute creation was refused, detection action read-back did not match, lifecycle settings could not be read, and workflow writes were not approved. Provider and connector secrets must be entered again.

- Enable individually reviewed Tenant settings and Authentication configuration restores only for the verified matrix subsets. These policies require their own confirmation and remain outside restore all, Sync and cross-tenant copy. Company branding restores only the default username hint from a full backup. Together with the three metadata types above, seven configuration types now have enabled subsets. All other new types stay blocked.
- Never request Organization.ReadWrite.All, Directory.ReadWrite.All or Directory.Read.All. New least-privilege registrations cannot cover group lifecycle policies or consent grants; existing delegated access remains recognized. The Backup Reader excludes those types without broad read access. An existing reader holding Directory.Read.All fails its permission allowlist until its owner removes that role and verifies the reader again; no grant is automatically revoked. Organization notification emails, phones and privacy profile are backup-only in 0.6. Branding uses OrganizationalBranding.ReadWrite.All. Restore access adds only the least-privileged write permissions of enabled operations and Application.Read.All for token lifetime policy binding reads; blocked areas and Defender request no write permissions. Existing registrations are not automatically stripped of previously consented permissions. The setup script's default permission request stays unchanged.


- Settings, Storage and recovery now saves designated recovery account IDs per tenant and shows guarded restore results, saved reference reports and read-back reconciliation. Guarded history has no manual outcome reset. Protected identity resolution includes group members, group owners and PIM eligibility; incomplete safety reads block a future identity write.
- The guarded Entra ID restore writer requires a signed-in admin, touched-object journal, protected identity checks, adds-only defaults and reconciliation of unanswered writes. Unverified types and all Defender types remain backup-only. Restore continuation pages now use the same collection and filter validation as backups.

- Cloud change reports now warn when either backup declares directory inventory that Azure Automation did not compare, including a missing or unreadable large companion. Ordinary report exports retain their previous JSON, Markdown and HTML layout. Azure Automation does not capture directory inventory.

- Entra ID adds seven opt-in directory inventories: users, groups, app registrations, enterprise apps, consent grants, devices and organization contacts. The registry now contains 135 types, including 74 Entra types. Directory areas stay off for new and existing tenants. Files use object IDs and closed property allowlists; users include identity and organization profiles but never authentication methods, passwords or sign-in activity. Application credentials retain metadata only. Group membership and ownership use beta to avoid v1.0 omissions. Refused relationships retain their parent with an incomplete marker and continue; a paging or budget failure ends only that type. Directory inventory is excluded from policy counts, hygiene, live change watching and audit alert suggestions. Compare and drift use paged indexes. Restore remains unavailable and Azure Automation is unchanged.

- Large backups use `intune-backups-large`, with claims and manifests under `backup-large-<UTC start time>/` and snapshots and shards under `payload/backup-large-<UTC start time>/`. Ordinary and older backups keep their existing paths in `intune-backups`. Before a Backup Reader captures large types, rerun `New-TenuVaultStorage.ps1 -BackupReaderAppId <application ID>` with the usual storage arguments to provision both containers and the writer role on each. History adds one bounded discovery listing and, locally, one container-properties read; it never enumerates large payloads. No large backups using the earlier unreleased layout are migrated.
- Ordinary types always stay in `intune-backups`. Mixed runs publish ordinary snapshots first, then write a separate large companion folder with the same run ID and start time. History resolves reciprocal manifests with matching folder, tenant and nonempty run IDs into one run with combined status and coverage. Missing, unreadable, running, cancelled, interrupted or mismatched companions make the run incomplete with per-large-type causes, including recorded capture failures. Ordinary restore and comparison remain independent. Retention evaluates verified complete pairs together and protects runs inside retention. Owned incomplete, cancelled, crashed, orphaned and partly deleted halves expire after the tenant's retention period plus a 7-day recovery grace, on both storages. Cleanup requires a consistent app ownership claim for the tenant; unverified, forged and foreign claims are kept and reported. Forever deletes nothing. Claims are deleted last so the next eligible pass finishes interrupted cleanup. Logs report deleted and retained counts and bytes; history shows recovery guidance and known costs, explicitly marking unfinished large payload costs as unavailable when no size manifest exists. Ordinary backups without companions retain their existing behavior. Dashboard counts resolved history rows without regrouping copied run IDs and scopes attempt reconciliation by tenant. Complete large discovery proves an undiscovered companion is missing with zero extra GETs; failed or partial discovery permits at most 8 direct companion lookups per request and marks the rest unresolved with a cause. Complete mixed runs export and import as a single version 3 tar preserving both reciprocal manifests. An explicitly labeled ordinary-only ZIP removes companion dependencies and imports independently. Ordinary-only ZIP export and import remain unchanged. Each manifest links its companion; the ordinary manifest records large outcomes separately in `LargeBackupOutcomes`. A missing, refused or unwritable large container affects only large types, reported as not read with cause `storage` and the message "Storage not provisioned for large backups" plus the provisioning step. Large discovery failures omit large history with a warning and preserve all ordinary history. A large-only import needs no ordinary container. Existing ordinary and 0.5.x paths and request counts remain unchanged, apart from the already introduced bounded large discovery request. A Backup Reader with only its 0.5.x container assignment needs no storage changes for ordinary types; rerun the provisioning script above only to enable large storage, rather than granting a broader Contributor role.


- Large inventory infrastructure is opt-in through a type's volume declaration. Existing ordinary type snapshots and inline Items manifests remain unchanged. Large backups add bounded LargeItems indexes and sorted relationship shards, require this release to browse, and export as uncompressed POSIX tar. Backups without large types retain ZIP and remain readable by the current release. The archive importer accepts both formats, enforces proportional finite limits and commits metadata last. Large runs yield to queued tenants at page boundaries and leave other tenants' schedules eligible while running.

- Defender is opt-in and now backs up 17 Microsoft Graph configuration types. It does not cover Office 365 threat policies or Defender for Endpoint settings. Restore remains unavailable. Workbooks add Workbooks.Read.All to Detection and response. Existing Intune selections stay unchanged.

- Entra configuration references now store people by ID without subject descriptions, actor names or principal profiles. Configured notification recipient email addresses remain stored as policy settings. On-behalf requestors use stable subject identity. Workflow execution times and other runtime status are excluded from storage and drift; existing backups are not rewritten and a comparison with an older backup can show the excluded fields being removed once.
- Governance adds entitlement management, review definitions, current lifecycle workflows/tasks and terms metadata. Lifecycle license refusals leave coverage incomplete. Review decisions, workflow versions and PDF content are excluded. Each Governance type has a 120-second, 500-GET budget that leaves other types running.
- Entra ID now backs up 67 configuration types in Tenant settings, Authentication, External identities, Roles and PIM, Governance, and two opt-in Groups settings. Existing tenants keep Entra ID off. Only individually verified configuration subsets support restore; Azure Automation remains Intune and Conditional Access only. Four types need a signed-in admin. Branding stores JSON up to 1 MiB, without image or CSS streams. Directory settings include custom banned password words. Refused domain federation sub-reads keep the domain and report incomplete coverage.
- PIM group schedule reads share candidate discovery and stop each type after 120 seconds or 500 schedule GETs, including retries and pages. A bounded type reports incomplete coverage while other services are saved. API connectors now report their Backup Reader restriction separately from missing permissions.
- PIM group discovery now needs GroupMember.Read.All alongside the existing schedule read permissions. API connectors are app-only until delegated read access is verified. New Entra types remain backup-only; role assignments and schedules store principal IDs without profiles.

- Adding permissions checks the connected access token's delegated claims for existing consent and refreshed access. This avoids false refusals when the sign-in response lists fully qualified scopes or `.default`. Unreadable and app-only tokens require a delegated sign-in. Scope names and known registration GUIDs are compared without regard to case, while existing consented scopes keep their spelling when updated.

- Settings can add delegated service, area and supported restore permissions to the exact connected registration after an administrator sign-in and preview. This separate action requires existing tenant-wide consent and a credential-free, single-tenant public client with root-path HTTP localhost or 127.0.0.1 redirects, with or without a port. Individual consent requires separate administrator review. Existing grants are updated in place; partial or unanswered writes require a fresh preview before retrying. The app rereads each exact write target immediately before updating it and reports observed concurrent changes as partial. Graph offers no documented conditional update for these whole-value replacements; a simultaneous edit can still be lost. Quick setup reuse and the Backup Reader are unchanged.

* Setup now keeps a service choice per tenant. Intune keeps its previous default permissions, including read access to Conditional Access while its backups stay off. Entra ID can back up its supported configuration areas; other Entra ID areas and Defender still prepare permissions only. Intune-only workflows direct tenants without Intune to Services and permissions. Links for tenants that are not connected show a notice and a link to Tenants before opening any workflow. After sign-in, setup waits up to 20 seconds for the permission result before offering storage; a failed or stalled check shows an advisory notice and allows setup to continue.

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

The Developer ID Application certificate belongs to Apple Team ID `D259ULY2B4`. The nightly
verification refuses an app signed by any other team (`EXPECTED_TEAM_ID` in
`scripts/nightly-verification/install-macos.sh`); change both together if the team ever changes.

Licensing (already set): secret `TENUVAULT_LICENSE_PUBLIC_KEY`, variable `TENUVAULT_LICENSE_PORTAL_URL`.

Microsoft Store (already set): secret `VERCEL_BLOB_READ_WRITE_TOKEN`, see [Microsoft Store](#microsoft-store).

## Release trust boundary

Both maintainers have the same rights and follow the same rules; nobody can bypass them.

- Merging to `main` needs a pull request and green CI (typecheck, tests, smoke test, Windows and
  macOS packaging), no approval. Every merge becomes a nightly.
- A stable release promotes the newest nightly's commit, so stable only ships a build nightly
  users already ran. That commit's nightly must also have passed the nightly verification. Any maintainer may start one.
- Releases only build commits reachable from `main`, and manual runs must be started from `main`.
- Pull request installers are unsigned and receive no signing credentials. Manual CI builds
  are also unsigned unless `signed_windows` is explicitly selected. That option uses the
  release signing credentials and production helper signature guard, verifies both app and
  helper publishers, and uploads a portable x64 verification ZIP alongside the installers.
  It does not publish a release. Run it before accepting the signed helper on a test PC:
  `gh workflow run ci.yml --ref <reviewed-branch> -f signed_windows=true`.
