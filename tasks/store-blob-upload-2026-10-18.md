# Microsoft Store installer upload

Stable releases copy both Windows installers to the public Vercel Blob store, so Partner Center gets
URLs that do not redirect.

## Acceptance criteria

- [x] Only stable releases (version tag, or workflow_dispatch with channel stable) upload; nightlies never do.
- [x] Uploads `TenuVault-<version>-win-{x64,arm64}.exe` to `desktop/v<version>/<file name>`: no random suffix, public, `application/octet-stream`, one year max-age.
- [x] Uploads the bytes on the GitHub release, checked against the release asset SHA-256 digests first.
- [x] Never overwrites: identical existing objects pass, different ones fail.
- [x] Fetches each public URL without following redirects: HTTP 200, no redirect, matching SHA-256, or the job fails.
- [x] Both URLs in the job summary; release notes unchanged.
- [x] Token from the `VERCEL_BLOB_READ_WRITE_TOKEN` secret, scoped to the upload step; pinned actions, least-privilege permissions, `set -euo pipefail`.
- [x] Secret created from the TenuVault-Website production env without printing it.
- [x] node:test coverage in `.github/scripts/store-blob.test.mjs`, run by CI.
- [x] RELEASING.md documents the job and the URL pattern.

## Review

- Unit tests: 13 passing (`node --test .github/scripts/*.test.mjs`).
- Real store, 2026-10-18: the v0.3.0 re-run path ran with uploads disabled and verified both existing
  objects (HTTP 200, no redirect, SHA-256 equal to the release). A scratch object under `ci-selftest/`
  confirmed the put options (clean name, `application/octet-stream`, `max-age=31536000`), that a
  second put is rejected and the bytes stay unchanged; it was deleted afterwards.
