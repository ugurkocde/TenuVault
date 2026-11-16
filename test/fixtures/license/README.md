# License state fixtures

Bytes of the license state that released TenuVault versions wrote, so every later version is
tested against what is really on customers' disks (`test/license-upgrade.test.ts`). Never edit
or delete a fixture: add a folder for each stable release whose state format changed.

Each folder holds:

- `*.app-state.bin`: the app-state store file as that version's `SecureStore` wrote it, captured
  with an identity cipher. In the app the same bytes are wrapped in the operating system's
  encryption, which this repository cannot reproduce; the format inside is what these cover.
- `capture.json`: the version, capture time (Unix seconds) and the installation and tenant ids.
- `signer-public-key.txt`: the public half (PEM, kept as .txt because .pem files are ignored) of a throwaway Ed25519 key pair made only to sign the
  fixture tokens. Its private half was discarded; it is unrelated to the production key.

The fixtures were captured by running that version's own `LicenseService` and `SecureStore`
from a checkout of its release tag against a scripted licensing service: a paid key on several
tenants with an organization license and a removed tenant (`paid`), a no-card trial key
(`trial`), and the free Community tenant (`community`). From v0.5.0, captures also include
automatic tenant trial activation, one extension and a local usage tally (`tenant-trial`).

The v0.5.3 capture used a temporary detached worktree of tag `v0.5.3` and a scratch script
outside the repository, bundled for Node to run that tag's `LicenseService` and `SecureStore`.
The script supplied an identity cipher and a fake licensing fetch handler, with tokens signed
by a fresh Ed25519 key held only in process memory. It seeded the installation ID through
`SecureStore`, then used the service's public methods to activate paid and trial keys, check
organization coverage, attempt an offline tenant removal, claim Community, and start and extend
an automatic tenant trial with five recorded feature uses. The trial started ten days before
the capture and was extended at capture time, matching the earlier fixture scenarios.

From v0.5.3, `tenant-trial-install-limit.app-state.bin` separately captures a trial request
refused with `install_limit`. After a successful trial health check, the fake service refused
`startTenantTrial`, so the released service wrote `license.tenantTrialInstallLimit` with the
installation ID and saved the tenant's refusal record. The capture script and temporary
worktree were removed afterwards. Only the public signing key is retained.
