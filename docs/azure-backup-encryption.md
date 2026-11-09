# Azure backup encryption and recovery (superseded)

> **Superseded on 2026-11-09.** TenuVault no longer encrypts backups in the customer's Azure
> storage account. New Azure backups are plain JSON, protected by Azure encryption at rest and the
> customer's Azure role assignments, so every admin with access to the storage account sees,
> compares and restores the same backups without a key handover. Anyone who can write to the
> `intune-backups` container is trusted like an Intune admin, and plain Azure backups support every
> restore mode. Backups on the device stay AES-256-GCM encrypted with the device key; the recovery
> key only matters for those and for Azure backups made before this change, which stay readable
> with the key of the device that made them. Current documentation:
> [Encryption and recovery key](https://docs.tenuvault.com/security/encryption/) and
> [Work with other admins in one tenant](https://docs.tenuvault.com/getting-started/multiple-admins/).
>
> The text below describes the earlier design and is kept for reference only.

New desktop Azure backup uploads use AES-256-GCM before leaving the app. The key
comes from the same recovery keyring as local backups. Authentication binds each
blob to its source tenant, Azure account and full blob path; copying ciphertext
to a different identity or modifying its contents fails authentication.

Save the current recovery key in Settings before the first Azure backup. The app
blocks uploads until that key has been exported. Keep it in a password manager.
Other machines must import the key before reading the encrypted Azure backup.
After importing a new current key, export the combined keyring again. Azure
server-side encryption alone cannot replace this recovery key.

Existing plaintext JSON remains readable and is labeled **Unverified legacy** in
the restore wizard. Such snapshots cannot replace or revert live objects. Review
the snapshot content and provenance before creating a copy. Downloaded ZIPs are
plaintext exports and must be protected separately. A new encrypted backup does
not retroactively encrypt old blobs; retain or remove them under your recovery
policy. Administrators with access to legacy blobs can read their OMA-URI secrets
or alter their contents.

Restore review exposes snapshot JSON, including potentially sensitive settings.
Encrypted snapshots with unknown keys or damaged authentication tags fail before
Graph writes. Storage can still be deleted or denied by a storage administrator;
keep independent recovery copies. Integrity does not protect against a malicious
administrator who also possesses the recovery key.

Validation uses a stubbed BackupEngine and Restorer to exercise ciphertext uploads,
tampering, tenant/account/path binding and legacy replacement rejection. Read-only
Lokka beta verification confirmed the device-configuration list fields, paging
and wrapped Intune invalid-ID error. No live tenant writes were performed.
