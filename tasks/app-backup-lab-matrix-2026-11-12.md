# App Backup lab test matrix, 2026-11-12

Continuation of [the first lab run](app-backup-r0-lab-2026-11-12.md). Ugur authorized tests 1–7, including a separate install fixture, then confirmed that the missing production helper and UI should be documented as implementation blockers. That lab phase included no product feature implementation. The later authorized first implementation slice is tracked in [App Backup PR1](app-backup-pr1.md).

All tenant operations used live Lokka Microsoft and Graph `/beta`. Capture, packaging and device tests ran over SSH on the enrolled Windows mini PC. Source preparation used Microsoft's Content Prep Tool, downloaded from its official repository; Authenticode status was `Valid`, SHA-256 `C1BA45B5CB939E84AF064BB7FF4B38FB3DFE33C8DC1078FD9B157672EAE671F6`.

## Outcomes

| Test | Result | Evidence and limit |
| --- | --- | --- |
| 1. Normal IME refresh | Passed for this fixture | Before any explicit service restart in this continuation, the registry contained AnyDesk policy version `_3`; Graph still reported current content version 3. Old `_1` keys also remained. This supports the mapping for one real update and warns against treating every retained registry key as current. |
| 2. Independent source comparison | Six-file comparison passed; Unicode literal limitation | Six independently authored files were packaged, uploaded, recovered and compared against a manifest created before upload. All created names, sizes and hashes matched, including a 64 KiB random binary file. The intended Unicode literal was decoded incorrectly by Windows PowerShell 5.1; see the correction below. |
| 3. Repackage and install | Passed for this fixture | Recovered source repackaged successfully with the official tool and uploaded as a separate lab app. IME installed it, detected version 1 and reported execution success with no execution errors. The installed payload hash matched the original. Managed uninstall then removed both the files and the registry marker. |
| 4. Failure handling | Tested, findings remain | Seven injected download/content failures were rejected; unavailable version returned 404; synthetic certificate and archive guards were exercised. Cleanup and exit-code findings below prevent calling the spike production-ready. |
| 5. Helper authorization | Blocked by implementation | No production helper, authenticated RPC, tenant-bound job ticket, replay store or actor authorization layer exists to exercise. The certificate-only spike cannot substitute for these tests. |
| 6. Broader coverage | Partial | AnyDesk, PowerShell, Git, 7-Zip and the independent fixture cover multiple sizes and a user-install-context app. A user-only Brave assignment returned 403 in device context. Only one online enrolled PC and Windows Defender were available. Successful user-context recovery and another device/EDR combination remain unvalidated. |
| 7. TenuVault workflow | Blocked by implementation | No App Backup page, recovery routes/IPC, source-store workflow or durable recovery jobs exist in the checked-out source. Recovery/export/cancellation/restart tests through the proposed UI cannot run. |

## Independent fixture and deployment scope

The fixture installs only text files under its dedicated ProgramData lab directory and writes one version marker in a dedicated lab registry key. Its six source files include install/uninstall scripts, payload/version text, a Unicode filename and random data. It does not install a vendor product.

A dedicated group could not be created: Graph returned HTTP 403 `Authorization_RequestDenied` (`Insufficient privileges to complete the operation`). An existing Intune include filter restricted to the mini PC was verified and used instead, without modifying that filter. Assignments always retained that include filter; there was no unfiltered all-device deployment. No new group permission was needed to continue.

The first content requests returned 403 before the assignment/policy became available. Recovery later returned 200 after IME received the policy. A later request also supplied the verified assignment filter ID. Because assignment targeting, propagation, file-name metadata and the request filter list changed during setup, this run does not isolate which change resolved the early 403.

The original fixture executed successfully under IME's 32-bit PowerShell host, but its initial detection rule checked the 64-bit registry view. IME consequently reported detection failure (`-2016345060`) despite the marker files and 32-bit registry value existing. This was a test-fixture configuration issue. The original assignment was removed, its marker cleaned up with the recovered uninstall script, and the rebuilt app uses an explicit 32-bit registry detection rule.

## Failure tests and findings

Each corruption case used a test copy of the existing probe, a real live content response/download and a deliberate injection at the stated boundary. They are fault-injection tests, not evidence that the service delivered corrupt data. Each exited 1 and wrote no verified evidence receipt:

| Injection | Observed failure |
| --- | --- |
| Truncate downloaded header to 20 bytes | `Truncated content header` |
| Change IV byte | `IV mismatch` |
| Change header MAC byte | `Header MAC mismatch` |
| Change ciphertext byte | `HMAC verification failed` |
| Substitute expected plaintext digest | `Plaintext SHA256 verification failed` |
| Cancel the download token after 1 ms | `TaskCanceledException`, `A task was canceled.` |
| Cancel after downloading at least 1 MiB | `TaskCanceledException`; 1,064,369 encrypted bytes remained, without plaintext or a verified receipt |

The size guard also rejected injected original-size metadata above 256 MiB before downloading. A real unavailable content-version request returned 404.

Synthetic checks exercised the existing selection/path predicates without altering the device certificate store: expired candidate metadata matched zero certificates, two valid candidates triggered the count guard, and traversal, rooted and NTFS-stream archive names were rejected. These are supplemental guard checks; a real expired enrollment certificate, renewed enrollment and actual multiple eligible private keys still need device fixtures.

Findings to carry into implementation (the first two are fixed in the lab probe by this PR, with [twelve regression cases](app-backup-evidence/recovery-fixes.json); production process-death handling is implemented separately in the source store):

- **Failure cleanup:** the wrong-digest case left a plaintext ZIP on disk. It was not extracted or given a verified receipt, but production jobs must remove/quarantine plaintext on validation failure. Other failed cases left encrypted download/job artifacts.
- **HTTP errors exit successfully:** the spike reports non-2xx statuses in JSON but exits 0 on HTTP 403/404. Callers must inspect status and verified-result fields. A production helper must return an explicit failed job result and must not infer success from process exit alone.
- **Certificate-only recovery is not admin authorization:** the lab spike has no per-app actor permission or replay check. Passing the cryptographic tests does not satisfy test 5.
- **Retained policy keys are stale evidence:** both old and new registry versions coexist after refresh. Recovery must validate the current app/content reference rather than select an arbitrary retained key.

## Coverage limits

PowerShell recovery passed with 123,779,504 encrypted bytes; Git recovery passed with 75,817,360 encrypted bytes; filtered device-targeted 7-Zip passed with 11,959,072 encrypted bytes. Each recovered 219 files and passed HMAC and plaintext SHA-256 verification. The PowerShell source includes an MSI payload, while Git and AnyDesk include EXE payloads; this extends source-format recovery coverage but does not prove standalone MSI deployment behavior. Git's app metadata specifies user install context, but the recovery request used the existing device-certificate probe; this does not validate user-only assignment authorization or a non-elevated user recovery flow.

Graph confirmed Brave was assigned only to all licensed users. Its recovery request through the existing device-context probe returned 403. This is evidence of a rejected user-only scenario, not proof that every possible user-authenticated recovery mechanism is unavailable. No assignments were changed for these existing vendor apps.

The early 7-Zip probe label says `user-targeted`, based on its retained user-policy registry key. Subsequent live Graph assignment inspection showed a filtered device assignment. That operator-supplied label is not authoritative; this report classifies the app using the live assignment. Cached user-policy presence alone cannot establish current user-only targeting.

Only the mini PC was online among Windows peers in the available network inventory. The other Windows managed-device records had old last-sync timestamps. Windows Security Center listed Windows Defender only. No result is claimed for a second machine, another endpoint protection product, MSI-specific package behavior, non-Win32 app types, packages above the spike limit or every assignment scenario.

Redacted evidence is under [app-backup-evidence/full-matrix](app-backup-evidence/full-matrix/). Source/vendor binaries, SAS URLs, package encryption keys, certificate identities and private keys are excluded.

## Final cleanup

The original and rebuilt test apps were unassigned and deleted; live Lokka GETs verified HTTP 404 for both. IME performed the rebuilt app's uninstall before its cloud record was deleted. The lab files and both registry views were absent at cleanup. Seven fault-injection directories and four temporary encryption metadata files were removed. Harmless original/rebuilt fixture packages and independently authored source remain on the mini PC for inspection; existing vendor source captures were retained. No test group was created and the existing assignment filter's rule and modification timestamp remained unchanged.

IME remained running, Defender real-time protection remained enabled and Defender Operational event IDs 1116/1117 recorded no detections/actions during this run. These observations do not substitute for another EDR/device test.

The earlier AnyDesk version 3 and its inactive draft version 2 remain as documented in the first run; no additional AnyDesk content changes were made in this continuation. Its final live read still reported version 3, published. The unsuccessful earlier rollback is not reclassified as successful.

This run demonstrates a lab rebuild using Microsoft's external packaging utility. It does not establish a production packaging codec, restore workflow, signed helper or release approval for TenuVault. Tests 5 and 7 remain explicitly blocked as requested.

Official packaging procedure: [Microsoft Win32 Content Prep Tool](https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool).

## Unicode fixture encoding correction

The original BOM-less `prepare-fixture.ps1` was read as ANSI by Windows PowerShell 5.1. Its `Grüße.txt` literal became mojibake before packaging. The original manifest, captured hashes and comparison remain unchanged as historical evidence; the original `UnicodeFilenameRecovered` flag proves round-trip preservation of the created name, not the intended literal.

The fixture script now has a UTF-8 BOM and requires an explicit new output directory. A newly generated fixture on Windows PowerShell 5.1 created the intended `nested\Grüße.txt` name (code points U+0047/U+0072/U+00FC/U+00DF/U+0065). Its pre-packaging [manifest](app-backup-evidence/unicode-corrected/original-manifest.json) and [validation](app-backup-evidence/unicode-corrected/validation.json) show zero changed/missing files after local package HMAC/digest verification and extraction, plus exact original source-store export and catalog rebuild. This correction involved no tenant writes and no new Intune content-capture test. The temporary new fixture directory was removed after validation.
