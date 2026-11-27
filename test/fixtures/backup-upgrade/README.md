# Backup upgrade fixture

`app-state.bin` and the local blobs were written by `SecureStore`, `BackupKeys` and
`LocalBlobStore` from origin/main at `86e83d31`. The fixture uses a pass-through
cipher at the OS boundary so it can be opened on any OS without a real account's
credential store. All keys, tenant IDs and policy contents are synthetic.

The November 1 snapshot uses TVB1 and the older key. The November 2 snapshot
uses the 0.5.x default TVB2 and the current key. Both contain a manifest, an
ownership marker and two policies. `legacy-azure.bin` was written by the last
sealed Azure writer (`sealAzure` at `2faa1e62`) using the older key, the same
tenant, and the November 1 compliance policy's Azure blob URL in the test.
Azure writes on origin/main already used plain JSON.
