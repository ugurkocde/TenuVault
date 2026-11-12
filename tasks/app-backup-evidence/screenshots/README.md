# App Backup screenshots

Captured from the production Electron build of commit `86fc372677c95281e00e2991b79c5e5de8fdaacd` on Linux, using a disposable synthetic tenant with no Microsoft account and no license key.

The disposable review process supplied two synthetic app descriptors for the inventory screenshots, so no real tenant app names or IDs are published. The production inventory loader itself was verified separately, read-only through Lokka Microsoft beta, including response fields, exact Win32 type discrimination, continuation paging and malformed-select errors. These screenshots do not establish delegated permission coverage or content access.

Native file-picker results were supplied for temporary review folders and an independently authored `.intunewin` lab fixture. The real trusted IPC, encrypted source store, catalog and exporter ran normally. No product fixture API or bypass was added. The exported file is byte-identical to its input; [validation](validation.json) records matching SHA-256 values. Temporary data and the disposable profile were removed after capture. No tenant writes, assignment changes, installations or Intune content captures occurred.

- [Intune apps, light appearance](01-intune-apps-light.png): searchable app list and clear capture availability.
- [Selected app preparation, dark appearance](02-prepare-backup-dark.png): enrolled PC check, targeting guidance and an unavailable capture step, with manual attachment as a fallback.
- [Original export completed, light appearance](03-export-complete-light.png): the independent offline Saved installers catalog after a real exact export.
- [Saved installers at 1024px](04-stored-minimum-width.png): populated catalog at the supported minimum desktop width, without horizontal overflow.

Implemented: live Win32 inventory, preparation guidance, free offline attach/list/reconnect/exact export, a read-only Windows device check and a pure future request validator. Production content capture, elevated helper/transport, source coverage, upload and restore remain unavailable.
