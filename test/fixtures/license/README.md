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
(`trial`), and the free Community tenant (`community`).
