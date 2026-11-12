# App Backup PR1: local source foundation and recovery device checks

User authorization: fix the two lab findings with council review, then start the helper/UI implementation in a PR. This is the first vertical slice, not completion of the entire App Backup plan. Revision 8 in `app-backup-plan.md` records the pre-R0 scope exception.

## Implemented

- Separate App Backup navigation with Win32 apps and Stored versions. Missing Intune inventory is explicitly unknown; administrator-provided app labels create no content-version association. No paid badge on the whole feature and no backup-history setup/sign-in gate on stored access.
- Trusted native picker/IPC operations for attach, list, folder reconnect, exact original export and tenant-bound cancellation. The renderer receives descriptors only, never installer bytes or unrestricted filesystem paths. Attach requires existing tenant entitlement; stored read/export do not call Graph or require entitlement.
- A standalone streaming source store: HKDF-separated per-source keys, AES-256-GCM chunks binding format, tenant, source ID, record type and order; authenticated complete-file footer; bounded encrypted manifests with source key IDs. No whole-installer buffering or extraction. Container/directory and bounded metadata XML checks reject unsafe names and DTD/entities; this does not test installation behavior or the package's embedded payload cryptography.
- Catalog manifests beside encrypted artifacts, recovered by reconnect plus the matching TVK2 keyring, including retained rotation keys. The complete source directory rename is the commit point. Abandoned owned staging is reconciled; uncertain staging stays quarantined/unlisted. Source deletion/retention and pins are not implemented in this slice.
- Exact export writes into an exclusively created temporary file, authenticates each chunk before emitting its plaintext, verifies the complete file, then publishes with an atomic no-overwrite hard link. This requires a destination filesystem supporting hard links; otherwise export fails safely and preserves existing files. Temporary export journals are encrypted and allow cleanup after process death on the original host. Reconciliation is conservative when a process is still alive, its PID was reused, its host differs or ownership cannot be authenticated.
- Read-only Windows enrollment/certificate metadata checks, independently confirming the selected tenant's enrollment, matching certificate thumbprint and the Intune account ID from a fresh Graph `/beta/deviceManagement?$select=intuneAccountId` read. No private-key access, elevation, endpoint discovery or content request. Failure/offline/ambiguity stays unknown or unavailable; `captureAvailable` is always false.
- Pure signed request-contract validation for a future authenticated channel: tenant, requester tenant/object ID, job, app, device, content version/file ID, challenge, role-check freshness, expiry and one-shot consumption. It has no transport or execution entry point and is not a production authorization mechanism on its own.

## Lab fixes

The manual lab probe fails on non-2xx HTTP responses and malformed/payload-error 200 responses. A recovery succeeds only after a verified artifact receipt exists. Failure removes only the invocation-owned output; pre-existing directories remain intact. Structured results report stage, ownership and cleanup failures. Eleven Windows regression cases pass, including a locked plaintext file which correctly reports failed cleanup and remains nonzero. Abrupt termination/elevated reparse-point handling in a future privileged helper is not solved by that lab script.

The manual scripts require explicit app/version/gateway inputs and never run in CI. They are excluded from the Electron package. Tenant object IDs and regional gateway constants are absent from the shipped product and manual script defaults.

## Verification

- Source-store tests cover exact bytes, cross-tenant/source/key refusal, truncation, reordered chunks, modified ciphertext, key rotation, TVK2 reconnect, cancelled imports, destination preservation, and actual child-process death before/within/after publication and during plaintext export. Reconciliation is run twice.
- Device/request tests cover expiry, future validity, ambiguity, enrollment/account mismatch, wrong challenge/actor/job/content, replay, stale role checks and absence of the old expired-license rollback bypass.
- Renderer tests cover offline stored access, independent store/device errors, unavailable capture, and cancelling the old tenant's operation without leaking its completion into a newly selected tenant.
- Eleven live manual Windows probe regressions passed. On the mini PC, the real original fixture package passed the new source store's container check and an exact encrypt/decrypt/export/catalog-rebuild round trip. The device check returned matched enrollment/certificate metadata while capture remained unavailable. No tenant writes were needed for these checks.
- Full unit suite: 5,052 passed, two existing skips. After the bounded-metadata review fix, all 55 focused store/device/UI tests passed, including six oversized/symlink metadata cases. Typecheck, lint and production build passed; lint has four existing warnings outside the touched code. Built-app smoke verification includes the signed-out App Backup page and the supported 1024px minimum desktop window.

## Council disposition

Initial reviews: Sol 8/10 for the fixes (9/10 for bounded foundations), Opus 7/10, Muse 6/10 for the initially proposed breadth. All permitted a local source vertical slice with unavailable recovery, with objections to enabling the protocol before R0.

Applied: verified-completion guard and malformed-200 regressions; ownership/stage assertions and locked-cleanup regression; no key minting on reads; source-resident encrypted catalog; independent offline export; trusted tenant-scoped IPC; no recovery-start route or entitlement rollback bypass; no private-protocol code in product; explicit revision-8 scope boundary; real process-death tests; read-only tenant/account/certificate binding; unavailable-only recovery copy; conservative staging ownership; bounded regular-file metadata reads for manifests and reconciliation, including growth-after-stat protection. The source-store code re-check scored 8.5/10 and its bounded-read finding is fixed with oversized/symlink fixtures.

Deferred explicitly: R0 legal/terms/licensing/preview decisions, signed positive kill-switch channel, authenticated challenge transport and peer verification, signed/elevated helper, actor RBAC checks, streaming capture-to-encrypted-store, live inventory/coverage, upload, restore, source ZIP/folder export, Azure source stores, pins and full durable job history. The existing installer recreation block and restore limitations are unchanged.
