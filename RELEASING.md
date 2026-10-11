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

## Plan boundary changes

A change to what a plan includes (`src/shared/plans.ts`, `src/main/api/plan-gates.ts`) takes
effect with the next release that contains it. Call it out in that release's notes, and keep the
docs-site plan tables saying "from the next release" until the stable release ships. Merged
changes reach nightly users first.

The audit log (viewing, searching, exporting and removing old entries) is Pro and MSP. Every
plan records events; Community sees a locked preview on the Audit Log page.

## Compatibility notes for the next release

Put these in the next stable release's notes, then remove them here.

- An inaccessible or offline local backup folder no longer prevents Settings or the recovery key export notice from loading. Save the recovery key even while the backup drive is unavailable.

- Malformed stored backup keyrings now stop key creation and recovery key import instead of silently replacing keys. Recover the original `app-state.bin` before continuing.

- Scheduled backups now save `lastAttemptAt`, `attemptSlot` and `attempts` alongside the last successful
  `lastRunAt`. The slot recorded when an attempt starts keeps its budget even if the run finishes
  after the next scheduled time. Existing schedules load automatically. Records without `attemptSlot`
  infer it from the last attempt's timestamp. A failure recorded by an older version
  becomes a failed attempt rather than a successful run and can be retried after 15 minutes,
  within the three-attempt limit for that slot. Downgrading loses this retry behavior because
  older versions do not use the new fields.

- Settings Catalog assignments. Released versions backed up Settings Catalog policies (including
  endpoint security) with `assignments: []`, because Graph answers `$expand=assignments` on a single
  policy with an empty list. They are now read from `{id}/assignments`; Settings Catalog compliance
  policies too. Against a backup from a released version, backup changes and drift detection leave
  these assignments out of the comparison, and replace in place with **Restore assignments** keeps
  the live assignments (with a warning) instead of clearing them. See
  `docs/roadmap/lokka-verification-features.md`.

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

## Release trust boundary

Both maintainers have the same rights and follow the same rules; nobody can bypass them.

- Merging to `main` needs a pull request and green CI (typecheck, tests, smoke test, Windows and
  macOS packaging), no approval. Every merge becomes a nightly.
- A stable release promotes the newest nightly's commit, so stable only ships a build nightly
  users already ran. Any maintainer may start one.
- Releases only build commits reachable from `main`, and manual runs must be started from `main`.
- Pull request and manual CI installers are unsigned and receive no signing credentials.
