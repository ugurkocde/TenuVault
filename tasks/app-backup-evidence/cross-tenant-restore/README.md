# Cross-tenant installer restore verification

Scope: restore a previously captured Win32 source ZIP into a new, unassigned app in a different configured tenant. No automatic assignment, installation, overwrite or continuous synchronization.

## Live Windows result

The packaged Windows preview restored a PowerShell backup to the authorized destination tenant through the actual desktop review dialog and main-process upload handlers. Destination authentication used the new Microsoft device-code option, with sign-in completed on another device. The app ran unelevated in an isolated test profile; the installed app profile was unchanged.

Independent Microsoft Graph beta reads through Lokka Microsoft MCP verified:

- Exactly one matching destination test app, published with content version 1.
- One committed content file: 123,779,448 original bytes and 123,779,504 encrypted bytes, with `commitFileSuccess`.
- Zero assignments and `isAssigned: false`.
- All 14 available settings fields checked against the source match, including install/uninstall commands, detection rules, installation behavior and return codes. The destination uses its default scope tag.
- Collection paging, a continuation request and rejection of an invalid selected field.

The UI reported completion and exposed **Open restored app**. After restarting the packaged app, both Microsoft sessions persisted, all three retained source captures remained present, and retrying returned the same published app. A second independent Lokka check confirmed the same app ID and exactly one matching app. No assignment or installation was performed.

See [the redacted live verification record](./live-verification.json).

## Failures found and corrected

The first live upload exposed two differences from the original mocks: Intune can acknowledge a void action with an empty HTTP 200, and a newly created content file can briefly report `success` before its storage URI is ready. The transport now accepts empty acknowledgments only for void actions; the engine waits for allocation before uploading or renewing an expired URI.

The earlier premature renewal left an unassigned, unpublished test draft in a terminal storage-failure state. Live Lokka verification confirmed that Intune refused further renewal and did not expose a working Win32 content-file deletion route. The user explicitly authorized deleting that incomplete test app. Its encrypted local journal was retained separately for diagnostics, then the corrected desktop flow created the successful replacement. This was test cleanup, not an automatic product recovery feature.

The product retains terminally failed drafts and explains the failure. It neither deletes destination apps nor silently creates replacements. Regression tests prove that retrying such a failure performs no additional writes. Interrupted uploads with usable storage and lost creation responses remain resumable against their original destination app.

## Automated checks

- Full local suite: 5,651 passed, two existing skips.
- Focused restore, authentication and renderer suite: 52 passed on Linux and the Windows mini PC.
- Typecheck and lint passed; four existing lint warnings remain outside this change.
- Desktop build and App Backup smoke checks passed, including destination review and completion. The earlier full desktop smoke run also passed.
- Documentation build passed for all 49 pages.
- Encryption tests cover fresh ProfileVersion1 keys, exact decrypt round trip, source authentication before destination writes, second-pass tamper rejection and commit-size verification.
- Retry tests cover lost create responses, interrupted uploads, assignment refusal, ambiguous creation and destination isolation.
- Device-code tests cover tenant binding, safe challenge fields, switching from a pending browser request, cancellation, late completion, malformed responses and registration errors.

CI must pass on the final PR head before the PR is called ready. Local and Windows checks do not replace those workflows.

## Limits of this evidence

This live test covers one PowerShell installer and one destination tenant. It does not demonstrate deployment to a device, macOS capture, dependency mapping or continuous synchronization. Inline script preservation is covered by automated tests; the live app used an MSI detection rule. The test executable was a packaged development preview, not a signed release installer.

The destination's public-client configuration and the independent Lokka application's read permission required separate administrator consent. Existing configured sessions are reused; no registration permission changes are made by the restore feature.

## Protocol references

- [Microsoft's Win32 upload sample](https://github.com/microsoft/mggraph-intune-samples/blob/main/LOB_Application/Win32_Application_Add.ps1): create app, content version, file, block upload, file commit and committed-version update.
- [Create a Win32 app](https://learn.microsoft.com/en-us/graph/api/intune-apps-win32lobapp-create?view=graph-rest-beta).
- [Commit a content file](https://learn.microsoft.com/en-us/graph/api/intune-apps-mobileappcontentfile-commit?view=graph-rest-beta).

Restore journals and their upload keys remain encrypted beside the source. Failed or cancelled operations may leave an unassigned destination draft; retry reconciles that same object when Intune can resume it. No automatic cleanup deletes destination apps.

## UI evidence

The committed screenshots use synthetic tenants and a mocked restore response. They demonstrate the review layout and narrow-window scrolling, not a live Microsoft upload. The live Windows completion screenshot remains private because it identifies the destination tenant. The redacted live verification record contains no tenant IDs, app IDs, tokens, storage URLs or script contents.
