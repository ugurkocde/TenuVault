# Windows installer capture helper

`Program.cs` builds against the Windows .NET Framework compiler. It has two modes:

- The non-elevated broker accepts one length-prefixed request on stdin from its actual parent process. Tokens never appear in arguments or files.
- The elevated worker connects to the broker's local, first-instance named pipe. Both sides check the peer PID and executable path; the pipe ACL permits the current user and SYSTEM and denies network access. A fresh challenge and a short lifetime bind one request. The worker exits after its response.

Consent elevation must use the same Windows user, who must be a local administrator. A different administrator account is not allowed through the user-bound pipe.

The worker validates the fresh delegated Graph session through a live beta `/me` request, selected tenant, requester ID, app-write scope and Intune/Global Administrator role. It reads the tenant's Intune account, the app's committed content version and the single committed non-dependency payload. It selects exactly one current enrollment certificate bound to the same tenant/account, requests content metadata and unwraps its CMS envelope. No private key is exported. No installer bytes are downloaded or written by the helper.

The main process downloads from the returned Microsoft content address without Graph credentials, authenticates the encrypted payload and writes only encrypted staging. Publication is the verified manifest commit. Capture receipts retain a SHA-256 fingerprint of the service's opaque `DoFileId`, not a fabricated Graph file-ID match.

Cancellation closes the request input. While Windows consent is pending, the job remains occupied until the prompt is answered, preventing a queue of stale prompts. A request cancelled before consent completes never sends its token to the worker. After consent, cancellation terminates the broker; the worker watches that exact process. Parent death and bounded deadlines (six minutes for approval, two minutes for the worker) terminate abandoned work. A consent dialog already owned by Windows may need to be dismissed after cancellation or app exit.

`REQUIRE_SIGNATURE` is defined for release builds. WinVerifyTrust checks the app and helper, including their Authenticode content hashes and matching publisher. Electron Builder signs the extra-resource executable with the existing Windows signing configuration. PR/development artifacts are unsigned and must not be represented as release signing evidence.

Run `node scripts/test-app-backup-helper.mjs` on Windows for native refusal, framing and first-instance pipe tests. `npm test` includes those tests on Windows. Real tenant capture is exercised separately through the desktop app; native tests never call Graph or use enrollment keys.
