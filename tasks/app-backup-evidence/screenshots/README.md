# App Backup screenshots

Captured from the production Electron build of commit `53d50e3851f8ed970954302d52fb512905d72083` on Linux in a disposable synthetic tenant profile with no Microsoft token or license key.

The review process temporarily supplied synthetic account metadata, app descriptors and details so no real tenant names or object IDs are published. No interactive Microsoft sign-in or consent is established by these screenshots. The real inventory/detail endpoints were checked separately, read-only through Lokka Microsoft beta; see [verification](../app-table-beta-verification.json). That app-only connection does not establish delegated authentication or populated active-install-script coverage. Logos use initial fallbacks in these examples.

Native picker results pointed at disposable folders and an independently authored `.intunewin` fixture. The actual trusted IPC, encrypted source store, catalog, exporter and script-download writer ran normally. The original installer and export hashes match in [validation](validation.json). Download saved the synthetic script text with a UTF-8 BOM, and the text was checked without execution. No product fixture API was added. Temporary data/profile were removed after capture. No tenant writes, assignment changes, installations or content captures occurred.

- [Signed-out entry](00-signed-out-light.png): calm reconnect state and direct offline saving path.
- [Intune apps table](01-intune-apps-light.png): version/date, Details and right-side Backup, with no extra sign-in action after loading.
- [Inline backup guide, dark appearance](02-prepare-backup-dark.png): working original-file save first; future capture guidance collapsed.
- [Original export completed](03-export-complete-light.png): real byte-identical export with feedback beside the saved file.
- [Saved installers at 1024px](04-stored-minimum-width.png): no horizontal page overflow.
- [Empty saved catalog](05-empty-saved-light.png): file-saving form exposed by default.
- [App details](06-app-details-light.png): overview metadata, native Print and Backup. Save PDF is absent.
- [Installation](07-installation-details-light.png): read-only command lines and execution context.
- [Scripts and Download](08-script-details-light.png): local download success; scripts remain unexecuted.

Native Print is tested for success, cancellation and failure using a controlled printer surface; no physical printer job was submitted. Production installer capture, elevated helper/transport, source coverage, upload and restore remain unavailable. App Backup remains completely free for every configured tenant.
