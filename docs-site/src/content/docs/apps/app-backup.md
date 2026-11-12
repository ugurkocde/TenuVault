---
title: "Store Win32 installers"
description: Keep encrypted copies of original .intunewin packages and export their exact original bytes.
---

**App Backup** keeps original Win32 installer packages separately from policy backups. Open it immediately below **Backup & Restore** in the desktop sidebar.

This first version supports local source folders, attaching existing `.intunewin` packages, listing stored versions and exporting the original file. It does not download installers from Intune, upload apps, restore their content or associate a selected installer with a particular Intune content version.

## Attach a package

1. Select a configured tenant.
2. Open **App Backup** and optionally enter an app-name label.
3. Choose **Attach source** and select an existing `.intunewin` file, up to 2 GiB. ZIP64 packages are not supported in this version.
4. Wait until the operation completes. **Cancel operation** stops an active import.

Adding a package requires access to the selected tenant. The file's container and bounded metadata XML are checked, but installation behavior and equivalence to Intune content are not tested. Sources are labelled **Administrator selected**. File names and app-name labels are not proof of an app's identity or content version.

The original file is copied into a separate encrypted source store. Changing backup storage does not change this source store. The default source folder is **TenuVault App Sources** in Documents. Sources have no automatic retention or delete action in this version.

## Export the original bytes

Open **Stored versions**, find the package, then choose **Export original**. Choose a new file name. An existing destination is preserved, even if the operating system's file dialog offered to replace it.

Export requires a destination filesystem supporting hard links. On macOS and Linux, exported files initially have owner-only permissions. Export checks the encrypted chunks and complete file hash before publishing the destination. It does not rebuild the package or alter its contents. Stored versions remain browseable and exportable while signed out or without an active entitlement, provided the tenant is still configured and this device has the matching encryption key.

## Reconnect after moving to another computer

Keep both the source folder and the [recovery key](/security/encryption/). The source folder contains the encrypted catalog as well as the encrypted artifacts; the recovery key alone does not contain the installers.

On another installation, configure the same tenant, import the matching recovery key in **Settings → Storage and recovery**, then use **Reconnect source store** in App Backup to select the root of the retained source folder, which contains the tenant GUID folders. Selecting a tenant folder or an individual package folder is refused. If the selected root has no source store for this tenant, TenuVault asks before using it as a new empty store. Listing and export can read a retained store without creating folders in it. Each source is rebuilt from its encrypted manifest. Reconnecting changes the folder used for this tenant; it does not move or delete previous source folders.

Unreadable or incomplete sources are not silently counted. Interrupted imports stay out of the catalog. Owned staging left by a terminated process is reconciled when the folder is next read; uncertain staging is left unlisted with a notice. Encrypted export journals in local app data track temporary plaintext so a later run on the original computer can remove interrupted exports. Keep the source folder accessible until interrupted work has been reconciled.

## Coverage and device checks

**Source coverage unavailable** is expected in this version: this view does not yet compare stored sources with a live inventory or policy backup. A stored package does not establish restore readiness.

**Recovery device check** is read-only. On Windows it can compare public enrollment/certificate metadata with the selected tenant's Intune account. It requires a signed-in, authorized tenant for the account read. It never uses a private key, requests installer content, elevates a process or enables recovery. A matched enrollment is not a statement that recovery is ready. Non-Windows and unconfirmed checks explain why their state is unavailable or unknown.
