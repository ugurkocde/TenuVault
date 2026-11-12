# App Backup council: user flow, UI, design and UX

Reviewed head: `00a325195479772e75bf709afcda8814496a9bbb` of PR #342, 2026-11-12. Three independent read-only reviews inspected source, tests and all four earlier screenshots. Scores describe that reviewed head, not the corrected implementation. The reviewers did not edit files or tenant state. Sol ran 25 focused tests and read-only Lokka beta shape/paging/error checks using an app-only connection; this does not establish delegated authentication coverage.

| Reviewer | Score | Verdict at reviewed head |
| --- | --- | --- |
| Opus | 6/10 overall | Reorder the capture-oriented journey before merge; it can prompt assignment work that cannot produce a captured installer. |
| Sol | 7.5/10 overall | Fix cross-tab cancellation and a stale catalog response erasing operation errors before merge. |
| Muse | 6.5/10 overall | No design merge blocker; strongly recommends correcting the hierarchy. Flow5, UI7.5, consistency8, UX/accessibility6. |

## Finding disposition

| Finding | Correction | Verification |
| --- | --- | --- |
| Unavailable capture outranks the working action | Signed-out entry offers Save an existing installer. The per-app Backup panel opens the original-file picker first; future guidance is collapsed and says assignment changes do not enable capture. | Flow tests and running-app signed-out/selected-app captures. |
| Switching tabs silently cancels saves/exports | The desktop boundary uses one stable key across App Backup tabs. The workspace and active operation stay mounted. Leaving App Backup/changing tenant still cancels, stated in progress copy; browser close/reload gets a before-unload warning. | Real-router tests for active save and export across both tab routes. |
| Late catalog response erases a newer action error | Separate catalog errors from operation errors. | Out-of-order refresh-after-failed-save regression. |
| Feedback and Cancel are far from save/export | Place save feedback inside the selected row panel and export feedback beside its saved-file row. Cancelling remains disabled until a terminal result. | Renderer tests and actual save/export capture. |
| Signed-out entry appears broken and repeats requests | Read existing account metadata before inventory; no-account is a neutral state with an offline action. Keep the apps view cached across tabs. App Backup token failures do not enqueue global sign-in prompts. | Signed-out test, cached-route test and dedicated free-path guard. |
| Empty catalog hides its only working action | Open the file form by default when the catalog is empty. Link the intro directly to Saved installers. | Empty-catalog regression and new empty-state screenshot. |
| Cancellation/errors misdirect users to key recovery | Show cancellation as a neutral notice; show key/folder advice only for catalog/unreadable-source problems. | Cancellation and out-of-order error tests. |
| Vocabulary and reassurance drift | Save installer, installer folder, and one shared save-success/recovery-key reminder. Capture wording is consistent in metadata-check results. | UI/docs inspection and tests. |
| Selection jumps below the whole app list, with an oversized focus outline | Render the panel inside the selected row; focus its heading and restore the trigger on close. Page the table at 25 rows. | Flow regression and dark capture. |
| Duplicate names lack a discriminator | Show full app IDs when display names repeat; keep the constant installer-access caveat at collection level. | Duplicate-name regression. |
| Heading/platform context is confusing | Preserve heading hierarchy, flatten the embedded metadata check and disable it on non-Windows before any sign-in. | Non-Windows regression; source inspection. |
| Success lingers after Refresh | Refresh clears success; notices can be dismissed. | Renderer behavior and updated export capture. |

## Scope retained

Live inventory and local original-file storage/export are implemented and free for every configured tenant. The encrypted snapshot, native picker boundary and tenant isolation remain intact. Capture from Intune, signed/elevated helper transport, effective assignment eligibility, content-version equivalence, upload and app-content restore are unavailable. No assignment or installation was performed for this review or the corrections.

Remaining limitations are explicit: source deletion/retention is deferred; the renderer receives a folder basename rather than full filesystem paths; leaving App Backup cancels its local job; full durable job history is deferred; export requires hard-link support. These corrections do not imply that the reviewers independently re-scored the new head.

## Existing-session table follow-up

Ugur subsequently requested a polished app table and details instead of extra sign-in prompts. Revision 12 reuses the current tenant session, adds version/logo/date columns, details for commands/scripts/rules/assignments, native Print and a right-side Backup guide. Save PDF was removed. The working file-saving action stays primary and capture remains unavailable. Scripts can be downloaded through a native dialog, with no execution.

The final read-only review scored this revised flow 8/10 and independently passed 20 focused tests. Its Medium finding, a script index selecting different content after a refresh, is fixed with content-bound script identities and a changed/reordered-script regression. Its low documentation control-name finding is fixed. This follow-up does not retroactively change the original three reviewers' scores.

The reviewer rechecked both fixes and independently passed 69 relevant tests. No remaining blocker was found. The final Electron capture exercises the native script-download handler with synthetic text, verifies the UTF-8/BOM output and confirms Save PDF is absent.
