# App Backup implementation screenshots

Captured from the running Electron build of commit `5a987cb97c382dbea006fd8a88cd6e236579d3b1` on Linux on 2026-11-12. These are application captures, not mockups.

The disposable profile contains one synthetic tenant, no Microsoft account and no license key. The fixture is an independently authored lab package produced by Microsoft's Content Prep Tool. The disposable process debugger supplied native picker results for its temporary source and destination folders; the real trusted IPC handlers, encrypted store, catalog and exporter executed normally. No product bypass or fixture API was added.

The app attached and listed one package, then exported byte-identical original content. [Validation](validation.json) records matching SHA-256 values. No tenant writes or Intune content capture were performed. Temporary source/export data and the app profile were removed after capture.

- [Empty store, light appearance](01-free-empty-light.png): the feature is free, with unknown inventory coverage and unavailable content recovery.
- [Stored original, dark appearance](02-stored-original-dark.png): completed attachment, administrator-selected provenance and original-file details.
- [Export completed, light appearance](03-export-complete-light.png): successful export and the actual Linux device-check limitation.
- [Stored versions at the 1024px minimum width](04-stored-minimum-width.png): responsive desktop layout with a populated catalog.

Local attachment, listing, reconnect and exact export are implemented. A read-only Windows device check and future request validator are implemented. Production Intune content recovery, the elevated helper/transport, live inventory, upload and restore are not available in this slice.
