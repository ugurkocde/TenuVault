# Windows App Backup validation, 2026-11-13

**Product acceptance: blocked.** The current app cannot start an Intune installer capture. The Windows tests below validate the packaged UI, enrollment checks and capture-ingestion components; they do not establish a working user-facing backup or restore.

Tested commit: `72f0ad5143a49f443b540923f64d9552aff13c49`, PR #352. The tests ran on the enrolled Windows mini PC over the existing authorized SSH connection. Windows build 26200, Node 26.7.0, and the Intune Management Extension were present. The installed app was older, so testing used an isolated checkout and the exact x64 package from [CI run 43392091957](https://github.com/ugurkocde/TenuVault/actions/runs/43392091957), without replacing the installed app or its profile.

## Results

| Test | Result | Scope |
| --- | --- | --- |
| Focused App Backup suites on Windows | 200 passed, zero failures or skips across 13 files | Ingestion, corruption, truncation, tenant/content isolation, cancellation, real child-process death, reconciliation, key recovery, free access, inventory/details/scripts and renderer behavior |
| Packaged Electron desktop smoke | 58 checks passed, exit 0 | Ran in the interactive desktop with a limited token and a disposable profile. Includes offline catalog access, no manual installer picker, free access and minimum-window layout. Inventory/UI fixtures are synthetic, not evidence of delegated Microsoft authentication. |
| Public enrollment check, limited user | Enrollment and certificate matched; capture unavailable | Actual registry/certificate metadata, using the Intune account ID verified through Lokka |
| Private-key capability, limited user | Refused | One eligible certificate; signing failed with a cryptographic exception. No private key was exported. The normal app needs a separate privileged component. |
| Live PowerShell content | Passed | 123,779,448-byte authenticated source ZIP, encrypted storage, exact export |
| Live Git content | Passed | 75,817,299-byte authenticated source ZIP, encrypted storage, exact export |
| Wrong tenant / Intune account | Refused locally | Laboratory adapter checks, not production requester authorization |
| Nonexistent content version | HTTP 404 | Live content-service response |
| Device request for Brave | HTTP 403 | Live refusal for the earlier user-only lab assignment; no assignment changed |
| User-facing capture and restore | Blocked | Production helper, authenticated transport, capture IPC/UI orchestration and restore are absent |

The first combined unit run reported an `app-sources` worker-shutdown timeout after all assertions passed. An isolated rerun of that file passed all 57 tests in 7.14 seconds, exited normally and reported no shutdown warning. This was not a failing product assertion.

## Live retrieval methodology and limits

A temporary, manual lab adapter reused the previously proven device-certificate content request. It checked the selected tenant's enrollment and Intune account, unwrapped the content metadata in an elevated process, and passed sensitive metadata to the test parent through its child stdout pipe. It was not wired into or packaged with the app. Keys and signed URLs were not logged or saved to evidence files.

The unchanged production `downloadCapturedContent` and `AppSourceStore.capture` modules then fetched, authenticated, decrypted and encrypted the payload into an isolated store. The tests also used the production export and reconnect paths. Both payload hashes matched independent retained captures from the earlier lab run:

- PowerShell: `aab979dcb289d34da2b50328b67613a896ffac542154946b158e71a6f14df3da`
- Git: `c2701077a61e993038017443d59ebdb0b5a343485553d2ed923387af7183ab36`

For each payload, exact-byte export, retained-key reads after rotation, wrong-key rejection, cross-tenant export rejection, existing-destination preservation, cancellation after a live download started, absence of a cancelled manifest, and staging cleanup passed. The store contained only encrypted artifact, manifest and ownership files. Test stores and exported plaintext were removed afterward. Applications were not installed, assignments were not changed, and no restore was attempted.

**File-identity binding remains unproven.** The live service returned the requested app and version, but `ContentInfo.DoFileId` did not equal the Graph content-file ID for either app. The harness supplied the independently queried Graph ID as laboratory input. That exercises the ingestion contract; it does not prove an authenticated production adapter can establish that binding. Do not copy that fixture assumption into a helper or treat these receipts as production backup evidence.

Read-only Lokka Microsoft `/beta` calls confirmed both app records and their committed file IDs/sizes. A paged Win32 listing and its continuation succeeded. An unqualified subtype property in `$select` returned 400; the qualified property succeeded. These checks used Lokka's app-only connection. No existing Microsoft session was established in the isolated app profile, so delegated product authentication was not validated.

## Remaining acceptance blockers

1. Implement the production Windows helper and authenticated main/helper channel, including requester authorization and trustworthy app/version/file binding.
2. Add capture jobs, cancellation and crash recovery across the real helper boundary, and connect the Backup action to those jobs.
3. Validate signing/elevation and release controls on the enrolled PC. A successful public device check must continue to report capture unavailable until this path exists.
4. Repeat the live cases from the app using its Microsoft session, including denied requester/targeting, interrupted helper/download and restart. A completed backup must become a durable, exportable catalog item.
5. Validate restore packaging and metadata from captured artifacts before enabling restore. A source ZIP is not the original outer `.intunewin` file.

The mini PC is accessible. Missing device access is no longer a Windows blocker. macOS validation remains blocked by the absence of an enrolled test Mac.

Machine-readable results: [windows-capture-2026-11-13.json](app-backup-evidence/windows-capture-2026-11-13.json).

## Packaged Windows screenshots

These screenshots show the actual packaged app in the limited desktop session, using the smoke suite’s synthetic Contoso tenant. They confirm the current unavailable state, not a completed capture.

![Packaged Windows backup catalog](app-backup-evidence/windows-capture-2026-11-13/packaged-backups.png)

![Packaged Windows backup catalog at minimum width](app-backup-evidence/windows-capture-2026-11-13/packaged-backups-narrow.png)
