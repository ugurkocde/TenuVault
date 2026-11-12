# App Backup recovery lab validation, 2026-11-12

Follow-up: [the complete lab matrix](app-backup-lab-matrix-2026-11-12.md) adds normal IME refresh, independent-source comparison, rebuild/install/detection/uninstall, negative tests and broader recovery coverage. This document preserves the earlier run's historical results and tenant state.

## Scope and conclusion

Ugur authorized a full lab test over SSH on the enrolled Windows mini PC and allowed any app as the fixture. This continuation used the existing AnyDesk Win32 LOB app. Microsoft Graph calls used Lokka Microsoft with `graphApiVersion: "beta"`; the capture ran on the mini PC using its existing lab probe script.

Current-content recovery and a content upload/recovery round trip passed for this fixture. This is protocol evidence, not an end-to-end test of TenuVault's proposed App Backup UI. That UI/helper is not implemented in the checked-out source. The installed desktop executable reports 0.2.2.0 and was not used to perform recovery.

## Verified results

- Version 1 recovery: HTTP 200, 17,934,928 encrypted bytes, 17,934,874 plaintext ZIP bytes, 219 files, 8.6 seconds. CMS unwrap, HMAC and plaintext SHA-256 verification passed.
- All 219 files matched the previous day's saved capture; the plaintext ZIP hash also matched. No separately retained original vendor package was found in the inspected Downloads, Desktop or Documents locations. This comparison establishes repeatability, not independent provenance of version 1.
- A fresh encryption of the saved source ZIP was uploaded using Graph and Azure block upload. Local decryption and HMAC checks passed before submission. Version 3 reached `commitFileSuccess`, `isCommitted: true`; the application then reported `committedContentVersion: "3"`, `publishingState: "published"`.
- Recovery requesting version 3 returned HTTP 200 and response payload `ApplicationVersion: "3"`. Its encrypted SHA-256 exactly matched the freshly uploaded file, establishing that this was the uploaded content rather than the old ciphertext. Plaintext SHA-256 and all source bytes matched the saved upload input. Recovery took 3.85 seconds.
- While version 3 was current, requesting version 1 returned HTTP 404. Requesting the inactive version 2 also returned 404. Do not present this protocol as historical-version recovery.
- The registry still held `_1` policy keys after publishing version 3. No policy sync, assignment change or installation was explicitly triggered. The test establishes matching of Graph's current version to an explicit content request for this fixture; it does not prove how a naturally refreshed IME policy version maps across updates.
- A scheduled task with a limited token reported `Elevated: false`, `HasPrivateKey: true`, `CanUsePrivateKey: false`, with a CryptographicException (`Invalid provider type specified`, HResult -2146893804). The task and wrapper were removed. Elevated capture succeeded. This supports an elevation requirement on this device, not a universal claim about all enrollment configurations.
- Two valid Intune certificates have private keys, but only the certificate issued by Microsoft Intune MDM Device CA has enrollment OID `1.2.840.113556.5.6`. The existing probe selects exactly one current certificate using that OID. Tenant matching alone is insufficient; the earlier broad claim that the two certificates cannot be disambiguated is corrected by this check.
- Defender antivirus and real-time protection were enabled. The checked Defender Operational log window contained no detection/action events (IDs 1116/1117). This is a local observation, not general EDR compatibility clearance.

Plaintext ZIP SHA-256: `AB86AE37C12073A13321403E902A9770B1342B65229887CD687D7AD6A8826AFC`.

Version 1 encrypted SHA-256: `6DB57DD4FF0F9CDFBC2A53F1F068A7FDF17B3C0C643BE7A78F2209FF7F201BC3`.

Version 3 uploaded/recovered encrypted SHA-256: `A63C19995BD3DA7A0C63602CF8B3471FD05A2FDF1603A9A943D1A0213731FDF8`.

## Upload errors and final tenant state

1. Creating a content file while supplying the original file's manifest returned HTTP 400: `Invalid manifest: must not be set in content file for the current app type`. Omitting it succeeded; the service populated the manifest itself.
2. The first direct Put Blob upload returned Azure HTTP 201, but Intune processing reached `commitFileFailed`. A subsequent block upload of the same encrypted bytes passed. The experiment does not isolate the cause of the first failure beyond the observed difference in upload method.
3. Version 2 accumulated both that failed file and a committed retry. Activating it returned HTTP 400: `All AppFiles must be committed before committing an application`. A clean version 3 containing one committed file activated successfully.
4. Cleanup of version 2's failed file returned HTTP 400 (`No method match route template`). Deleting version 2 returned HTTP 501 (`NotSupported`). Version 2 remains an inactive test draft.
5. A PATCH requesting `committedContentVersion: "1"` returned without a Graph error, but repeated GETs still reported version 3 and the version 1 content request still returned 404. Rollback was therefore not successful. **Final active content version is 3**, with source ZIP bytes identical to the original version 1 capture. Versions 1, 2 and 3 remain listed. Do not claim the tenant was restored to its original metadata state.
6. Listing content versions with `$top=1` returned just version 1 without a next link; omitting `$top` returned all three versions. This fixture cannot establish general paging behavior. Do not treat a limited result without a next link as proof that only one version exists.

Temporary upload encryption metadata was removed from the mini PC. Device private keys were not exported. The original probe scripts, source captures and encrypted upload fixture remain on the mini PC for inspection. No credentials, SAS URLs, certificate identities or private keys are included in the repository evidence.

## Evidence and remaining gates

Redacted probe summaries are in [app-backup-evidence](app-backup-evidence/): `capture-v1.json`, `capture-v3.json`, `stale-v1.json`, and `rollback-v1.json`. The latter records the probe after the unsuccessful rollback request.

The earlier inventory reach figures were not re-measured during this continuation and should retain their original collection date and caveats.

Still unvalidated: independent original source provenance for version 1; naturally refreshed IME policy version mapping; rebuilt `.intunewin` packaging and installation; the production helper's authorization and replay protections; the proposed desktop UI; broader app/device/EDR coverage; terms/licensing and product go/no-go decisions. The successful lab round trip does not close these gates.

Upload sequencing was checked against Microsoft's [Win32 application update sample](https://github.com/microsoft/mggraph-intune-samples/blob/main/LOB_Application/Win32_Application_Update.ps1); all reported Graph behavior above comes from live Lokka calls.
