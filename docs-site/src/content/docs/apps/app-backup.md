---
title: "App Backup: Intune installers"
description: Browse Intune app details and understand installer capture availability, encrypted backups and access to legacy local archives. App Backup is free.
faq:
  - question: "Is TenuVault App Backup free?"
    answer: "Yes. App Backup is completely free for every configured tenant. It does not require a paid product license or Community tenant selection. Microsoft authentication and Intune permissions still apply to tenant reads."
  - question: "Do I need to choose an installer from my computer?"
    answer: "No. App Backup is intended to retrieve installer content from Intune. Selecting an existing local file is not an Intune backup. The manual attachment action has been removed."
  - question: "Can this build retrieve Windows or macOS installers from Intune?"
    answer: "No. The production device adapters are not available yet. Browsing app metadata or matching Windows enrollment does not enable capture. Assigning or installing an app will not enable it in this build."
  - question: "Can I still export a file saved by an earlier version?"
    answer: "Yes. Earlier administrator-selected files remain available as legacy local archives. You can export them offline with the matching recovery key, but they are not captured Intune backups and cannot be used for restore."
  - question: "Can App Backup restore apps?"
    answer: "Restore is not available in this build. Its required input will be an installer captured by an earlier successful Intune backup, with its app and content identity. Arbitrary local packages and metadata-only backups do not qualify."
---

**App Backup is completely free** for every configured tenant. Open it below **Backup & Restore** in the desktop sidebar.

App Backup's purpose is to retrieve installer content from Intune and retain an encrypted backup. **Production installer capture and restore are not available in this build.** No assignment change, installation or enrollment check can enable them yet.

The earlier manual-file workflow has been removed. Files already saved by an earlier build remain available as **Legacy local archive**, with an export action. They are not counted as Intune captures.

## What works now

| Action | Availability |
| --- | --- |
| List and search the tenant's Windows Win32 apps | Available using your existing Microsoft session |
| View version, logo, description, installation settings, rules and assignments | Available when Intune returns the information |
| Print app details or download available script content | Available; scripts are never executed |
| Read public Windows enrollment metadata | Available on Windows; does not establish installer access |
| Browse, reconnect and export legacy archives | Available offline with the matching recovery key |
| Retrieve Windows installer content from Intune | Not available in this build |
| Retrieve macOS PKG or DMG installer content from Intune | Not available in this build |
| Restore an app using a captured installer | Not available in this build |

macOS support means retrieving the installer from Intune, not downloading a substitute from a vendor or copying an installed `.app` directory. It needs its own tested device adapter. Windows app metadata can be viewed on a Mac; a Mac cannot perform the Windows enrollment check.

## Browse your tenant's apps

1. Select a configured tenant and open **App Backup → Intune apps**.
2. The app table uses the Microsoft session already connected to that tenant. Use **Reconnect Microsoft** only if it is missing or expired.
3. Search by name, publisher or version, then open **Details**.
4. Review the app's overview, installation settings, scripts, detection and requirement rules, and assignments. Values that Intune does not return stay unspecified.

**Download** appears only when a script's actual content can be retrieved and decoded. A command line referring to a script inside the installer does not make that file available for download. Downloading a script does not execute it or back up the installer payload. Print uses the operating system's printer dialog.

The per-app **Backup** panel currently explains capture unavailability. It does not ask you to select a local package. Its optional Windows enrollment check is read-only and cannot turn on capture.

## Backups and legacy archives

Open **Backups** to view the encrypted folder for the selected tenant. Intune captures and earlier local archives have distinct provenance labels. A legacy archive cannot gain capture provenance by changing its name or matching an app's display name.

An installer capture must pass its content identity, HMAC, size and plaintext SHA-256 checks before it can be published. Interrupted or failed staging is not listed as a backup. The Windows payload is a source ZIP, not a byte-identical copy of the outer `.intunewin` originally uploaded to Intune. Restore additionally needs a compatible packaging implementation and Microsoft authorization; a stored payload alone does not mean restore is ready.

## Export a legacy archive

1. Open **Backups** and find the entry labelled **Legacy local archive**.
2. Choose **Export archive**, then select a new destination filename.
3. Wait for **Installer exported**.

Export preserves existing destination files and checks the encrypted chunks and full file hash before publishing. The destination filesystem must support hard links. On macOS and Linux, exported files initially have owner-only permissions.

Export remains available while signed out, provided the tenant is configured and the matching recovery key is available. Switching between App Backup's tabs keeps the export running. Leaving App Backup or switching tenants cancels an unfinished export.

## Reconnect a retained folder

Keep both the encrypted folder and its [recovery key](/security/encryption/). The key alone does not contain the installers.

On another installation, configure the same tenant, import the matching key in **Settings → Storage and recovery**, then use **Choose installer folder** to select the retained folder's root, which contains the tenant folders. Reconnecting does not move or delete any existing files. Earlier archive manifests remain readable.

If a folder cannot be read, check its location and import the matching key. After an interrupted export, resolve any destination file locks and refresh to retry cleanup. A published export remains successful even if temporary-file cleanup needs another attempt.

## Related pages

- [Connect your tenant](/getting-started/connect-tenant/)
- [What gets backed up](/backups/coverage/): app settings and installer content are separate.
- [Encryption and recovery key](/security/encryption/)
