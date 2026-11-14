# Cross-tenant installer restore verification

Scope: restore a previously captured Win32 source ZIP into a new, unassigned app in a different configured tenant. No automatic assignment, installation, overwrite or continuous synchronization.

## Completed

- Local unit suite: 5,626 passed, two existing skips before the final settings-enrichment and retained-settings regressions. Those additional tests pass in the focused restore suite.
- Restore engine: fresh ProfileVersion1 encryption, source authentication before destination writes, exact decrypt round trip, file-commit verification, same-app retry after a lost create response, interrupted upload continuation, assignment refusal, ambiguous-create refusal and destination isolation.
- Store: encrypted configuration snapshots, key rotation, cross-tenant and tamper rejection; explicit current-settings enrichment only for a matching content version.
- Renderer: explicit destination and acknowledgment, existing-session reuse, missing-session sign-in, source-tenant cancellation and unavailable settings.
- Windows mini PC: the packaged preview runs unelevated with the existing isolated test profile. Nineteen initial focused tests passed on Windows. All three retained installer captures remain present. The real app opened the earlier PowerShell capture and loaded matching current configuration from its source tenant.
- Microsoft Graph beta, live Lokka source reads: app metadata, relationship collection, content-file metadata, assignments, paging and invalid-select error behavior verified. The destination's existing TenuVault Desktop registration was found read-only.

## Still required

- Complete destination Microsoft sign-in in the isolated Windows test profile.
- Restore the authorized, clearly named PowerShell test app, with no assignments.
- Independently verify destination app settings, committed content, publication, assignments, retry and restart behavior.
- Production Lokka app-list read currently returns HTTP 403 because its cached application token lacks DeviceManagementApps.Read.All. The permission panel was opened for user consent; verification must be repeated once that connection refreshes.
- Run all CI workflows on the final PR head before marking it ready.

No live destination app has been created as of this record. Mocked uploads and renderer fixtures are not evidence of a successful cross-tenant restore.

## Protocol references

- [Microsoft's Win32 upload sample](https://github.com/microsoft/mggraph-intune-samples/blob/main/LOB_Application/Win32_Application_Add.ps1): create app, content version, file, block upload, file commit and committed-version update.
- [Create a Win32 app](https://learn.microsoft.com/en-us/graph/api/intune-apps-win32lobapp-create?view=graph-rest-beta).
- [Commit a content file](https://learn.microsoft.com/en-us/graph/api/intune-apps-mobileappcontentfile-commit?view=graph-rest-beta).

Restore journals and their upload keys remain encrypted beside the source. Failed or cancelled operations may leave an unassigned destination draft; retry reconciles that same object. No automatic cleanup deletes destination apps.

## UI evidence

The built-renderer App Backup smoke run passed, including destination selection, explicit acknowledgment, exact tenant binding and the completion action. Screenshots in this folder use synthetic tenants and a mocked restore response. They demonstrate the review layout and narrow-window scrolling, not a live Microsoft upload.
