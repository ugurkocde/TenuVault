# App Backup: capture-only implementation requirements

Status: the Windows native helper, capture jobs and Backup action are implemented. A real app-driven PowerShell capture and native export passed on the enrolled mini PC. This is a Windows preview implementation record, not a general-release or macOS acceptance claim. See the current validation report for tested cases and outstanding release checks.

## Product contract

- Backup retrieves installer payloads from Intune. No administrator-selected local file is accepted as a backup.
- Include Windows Win32 apps and investigate macOS uploaded PKG/DMG apps. Store-managed apps need an explicit supported/unsupported verdict; no promise of exporting an App Store installer is made.
- Restore selects only artifacts published by an earlier successful capture for the selected tenant. Metadata alone, an incomplete job, an installed app or an arbitrary file does not grant restore eligibility.
- Keep App Backup completely free. Microsoft authorization and tenant/device isolation still apply.
- Browsing Windows metadata on macOS is valid. A Windows device check must not be presented as an action the Mac can perform. Capture needs a compatible, enrolled capture device and a functioning adapter. Remote workers must not be offered until implemented.

## Verified starting point

The Windows lab demonstrates recovery of an authenticated source payload through an enrolled device. It is not a production helper and does not reproduce the original outer `.intunewin` byte stream. Define the captured artifact as the authenticated installer payload plus the metadata required for restore; do not claim the source ZIP is an original `.intunewin`.

Read-only Lokka Microsoft beta calls on 2026-11-12 confirmed macOS DMG and PKG inventory, DMG bundle/version/filename/size details, content versions and committed content files. For the inspected committed DMG file, `azureStorageUri` was empty and no decryption-information field was returned. This observation is specific to that file, not proof that every retrieval route is unavailable. No content was downloaded, no assignment was changed and no app was installed.

Microsoft documents `mobileAppContentFile.azureStorageUri` as an upload URI, not as a general installer-backup API:
https://learn.microsoft.com/en-us/graph/api/resources/intune-apps-mobileappcontentfile?view=graph-rest-beta

Microsoft describes distinct native-MDM and Intune-agent macOS app distribution channels:
https://techcommunity.microsoft.com/blog/intunecustomersuccess/understanding-application-types-in-microsoft-intune-for-macos/4373987

## Implementation sequence

1. Prove macOS retrieval on an enrolled test Mac. Establish the available authenticated content route, payload format, integrity information and behavior when content is absent or no longer available. Begin with read-only inspection. Installing/reassigning an app requires separate explicit authorization.
2. Turn the Windows lab recovery into a production capture service: authenticated main/helper channel, explicit requester authorization, tenant/device/app/content binding, signed execution prerequisites and cancellation/process-death cleanup. Keep privileged operations outside the renderer and do not run the lab script directly from the UI.
3. Extend the encrypted source store for captured artifacts and capture receipts. Publish only after authenticated completion. Keep provenance separate from file names; preserve payload identity and the app metadata necessary for restore. Do not relabel existing administrator-selected archives as captures.
4. Replace the manual-archive Backup journey with a real job: app selection, capability/preflight, necessary targeting guidance, capture, integrity verification, encrypted storage and completed receipt. Unsupported states explain the exact reason and offer no file-picker substitute.
5. Gate restore on a published capture and validate the app/content relationship again before any tenant write. No restore from an arbitrary filesystem package.

## Acceptance evidence

- Real Windows capture and real macOS PKG/DMG capture, each with original fixture payload hashes checked independently. Do not count a vendor download or installed application directory as success.
- Negative tests for wrong tenant/device/requester/content version, absent targeting/content, expired authorization, tampering, interruption and restart.
- Failed or cancelled captures never appear restorable. Existing local archives remain distinctly identified and do not gain capture provenance.
- UI tests on Mac and Windows show only valid capture actions. Tests exercise the actual helper/adapter, not only mocked metadata.
- Restore is unavailable until captured-artifact compatibility is demonstrated. No tenant writes are authorized by this requirements document.

## Device availability

The enrolled Windows mini PC is accessible through the previously authorized SSH connection. The T3 device-link tools remain unavailable, but they are not required for this Windows connection. Windows component and packaged-app tests are documented in [the mini PC validation report](app-backup-windows-validation-2026-11-13.md). The Windows helper and app orchestration now run on that PC with the existing delegated Microsoft session and explicit Windows consent. No enrolled Mac is available for macOS retrieval validation.

## Initial ingestion milestone, before the Windows helper

- `content-stream.ts` validates ProfileVersion1 framing, HMAC-SHA256, AES-256-CBC padding, exact sizes and plaintext SHA-256. Transient plaintext goes only to the unpublished encrypting writer; no plaintext staging file is created.
- `capture-download.ts` accepts content details only from an internal adapter, performs a bounded HTTPS download without Graph credentials or device certificates, rejects redirects and unsupported destinations, and streams into the encrypted store. It has no renderer IPC entry point and does not implement device authorization or CMS unwrap.
- The store accepts a separate captured-artifact contract and binds tenant, app, content version and file identity. Manifest publication follows complete verification and source-ZIP inspection. The artifact is `win32-source-zip`, not an original outer `.intunewin`.
- `capturedSource` rejects all legacy administrator-selected archives. It is only the content/provenance prerequisite for future restore, not an implemented restore operation or a claim of packaging compatibility.
- Removed local-file attachment from the renderer, preload and trusted IPC registration. Existing archives remain readable/exportable with a distinct label and are not counted as captures. The UI and docs state that capture is unavailable until the adapters exist.
- Automated tests cover exact payload export, key rotation/reconnect, malformed framing, tamper, HMAC/digest/size mismatch, content-identity mismatch, cancellation, interrupted downloads, real child-process death, repeated reconciliation and legacy archive refusal.

Read-only Lokka beta verification was repeated on 2026-11-13: macOS DMG/PKG filtered inventory returned a continuation, following it returned another page, and a deliberately invalid selected field returned HTTP 400. The inspected DMG content file was committed, with a manifest but no download URI or returned encryption information. This does not establish that an enrolled Mac cannot retrieve it. The inspected manifest contains app/bundle detection arguments, with no encryption key or download URL. A Windows Win32 read also confirmed the committed-content-version field and committed file identity used by the new capture contract. No tenant changes or installer retrieval were performed.

At that initial milestone the helper, capture orchestration, release controls, restore and macOS adapter remained outstanding. The following Windows implementation supersedes the helper and orchestration blockers; synthetic fixtures alone are still not live-device evidence.

Local validation: 5,244 tests passed, with two existing skips across 365 test files. Typecheck passed; lint reports the same four pre-existing warnings. The production app and docs builds passed, including all internal documentation links. The final renderer cleanup was also checked separately (13 tests passed). No live device capture, macOS installer retrieval or restore was performed by this implementation.

The built Electron desktop smoke suite passed under Xvfb, including free access during a license-status failure, no attachment method in the preload bridge, offline catalog access and minimum-window layout. This is Linux UI evidence, not Windows/macOS device capture evidence.

## Earlier Windows component validation, 2026-11-13

All 200 focused App Backup tests and the packaged desktop smoke suite passed on Windows. Public enrollment metadata matched under a limited user; private-key use was refused under that token. PowerShell and Git payloads were retrieved through the temporary lab adapter, then passed through the unchanged production ingestion/store/export modules with independent hash equality and live cancellation checks. These are component tests, not successful app-driven captures: the helper and capture action are absent, and the lab-supplied Graph file identity is not yet established by a production adapter. See the [complete results and acceptance blockers](app-backup-windows-validation-2026-11-13.md).

## Windows helper and app capture

The app now starts a compiled, single-request helper through trusted IPC. The ordinary desktop process stays non-elevated. The helper checks the actual parent and local named-pipe peer, obtains explicit Windows consent, authenticates the fresh delegated session through Graph beta, and requires an active Intune Administrator or Global Administrator role. Certificate selection binds the enrollment to the selected tenant and Intune account. The helper does not write or download installer bytes.

The normal main process downloads and authenticates the returned content, encrypts it while streaming and publishes only after complete verification. The device response must match the live app/version and committed payload size. Its opaque content identifier is retained only as a SHA-256 fingerprint; it is not claimed to equal the Graph file GUID. Cancellation and parent death stop abandoned helper work; encrypted staging and export journals reconcile on restart.

The renderer exposes Start backup on Windows for system-context Win32 apps, with inline progress and cancellation. Existing Microsoft sign-in is reused and no license gate is called. There is no file-picker fallback for Backup. Other platforms explain the enrolled-Windows requirement.

Release builds enforce matching valid app/helper Authenticode publishers. Development/PR packages are unsigned. A signed release-pair test, broader EDR coverage and the remaining rollout controls are separate acceptance items. Restore, custom Intune RBAC roles, user-context capture and macOS retrieval remain unavailable.

Current evidence is in [Windows validation](app-backup-windows-validation-2026-11-13.md). Earlier lab-adapter results above remain historical component evidence and are not relabelled as app captures.
