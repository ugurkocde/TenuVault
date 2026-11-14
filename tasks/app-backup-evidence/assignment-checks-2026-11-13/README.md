# Automatic assignment checks: Windows validation

Validated on 2026-11-13 in a newly packaged x64 Windows app, launched with a limited desktop token and the existing isolated Microsoft session. The installed app profile was not changed.

Selecting **Backup** ran the real trusted IPC, local enrollment and device-identity checks, and delegated Graph beta reads automatically. **Start backup** stayed disabled while the check ran and became available after the result. No helper consent or capture was triggered.

| Existing app | Observed result |
| --- | --- |
| PowerShell | Required All devices; the panel reported that a device assignment includes this PC. |
| Brave | Required All users; the panel explained that user targeting does not establish device access and described an explicit device-group assignment. |
| 7-Zip | Required All devices with an include filter; the panel displayed the filter name, mode and rule for review without claiming the filter had matched. |

The catalog's source IDs and hashes were identical before and after these checks. The store retained two complete captures, with zero staging directories, unexpected files, helper processes or consent prompts. No assignment, group membership or installed application was changed.

A repeated run exposed local Windows probes exceeding their original 15-second deadline. The panel reported an unconfirmed identity and advised against changing targeting from that incomplete result. Both probes subsequently matched under the same limited user. Assignment checks now allow up to 30 seconds per local probe; failure remains an explicit unknown result.

## Additional verification

- Read-only Lokka Microsoft beta requests verified assignment fields, device identity, paginated transitive group membership, group name and visibility, filter fields, continuation behavior and a malformed-select HTTP 400. This connection uses app-only authentication; the three packaged app cases above used the real delegated session.
- The live cases did not require device-group membership reads. Optional delegated device/group permissions, matching and hidden exclusions, missing membership, conflicting intents and partial-page failures are covered by tests; they are not claimed as live delegated group-targeting evidence.
- 5,297 automated tests passed across 369 files, with two existing skips. The focused assignment, device and flow selection passed 72 tests locally; 59 focused tests passed on Windows. The full built-desktop smoke suite passed under Xvfb.
- Typecheck, application build, documentation build and internal documentation links passed. Lint retained four existing warnings.
- The new Windows package passed all six security-fuse checks. Its bundled helper matched the build output. No native helper source changed for this addition.

Assignment results are advisory. Filters are not evaluated locally, user membership is not inferred from the administrator, and unknown results do not become an empty assignment list or a guarantee of content access. The check performs GET requests only. Capture authorization still occurs independently when the user starts Backup.

The screenshots show the actual packaged app results. The filter and device names are redacted in the filter screenshot. Machine-readable UI assertions are in [assignment-ui-proof.json](assignment-ui-proof.json).
