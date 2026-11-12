---
title: "Store Win32 installers"
description: Keep encrypted copies of original .intunewin packages and export their exact original bytes.
---

**App Backup is completely free** for every configured tenant. No active license or Community tenant selection is required.

**App Backup** keeps original Win32 installer packages separately from policy backups. Open it immediately below **Backup & Restore** in the desktop sidebar.

This first version lists your Intune Win32 apps, guides preparation, and supports local source folders, attaching existing `.intunewin` packages, listing stored versions and exporting the original file. It does not download installers from Intune, upload apps, restore their content or associate a selected installer with a particular Intune content version.

## Start with an Intune app

Open **Intune apps**, sign in to Microsoft and choose a Win32 app. **Prepare backup** walks through three steps:

1. Check that this Windows PC is enrolled in the selected tenant.
2. Review the app’s targeting in Intune. Required assignments can install the app automatically. Use a dedicated test-device group, check filters and exclusions, and do not replace an existing Available assignment unnecessarily. This version does not verify group membership or effective assignment eligibility.
3. Capture the original package, verify it and store an encrypted copy. **This capture step is unavailable in the current build.** The preparation screen does not start an installation, change assignments or extract installed program files.

The live list follows all Microsoft Graph beta pages and includes exact Win32 app types. A failed refresh does not show a partial inventory or infer that installers are missing. The app list is independent of saved files, so a sign-in or inventory failure does not block offline export.

Already have the original `.intunewin` file? Choose **Save an installer I already have** in preparation, or open **Saved installers → Add an installer file manually**. Select a package up to 2 GiB. Its encrypted snapshot’s container and metadata are checked before publication. The app name is only an administrator-provided label; matching an Intune content version and installation behavior are not verified.

The default encrypted store is **TenuVault App Sources** in Documents. Reconnect is available from Saved installers. Changing backup storage does not change this store. Sources have no automatic retention or delete action in this version.

## Export the original bytes

Open **Saved installers**, find the package, then choose **Export original**. Choose a new file name. An existing destination is preserved, even if the operating system's file dialog offered to replace it.

Export requires a destination filesystem supporting hard links. On macOS and Linux, exported files initially have owner-only permissions. Export checks the encrypted chunks and complete file hash before publishing the destination. It does not rebuild the package or alter its contents. Stored versions remain browseable and exportable while signed out or without an active entitlement, provided the tenant is still configured and this device has the matching encryption key.

## Reconnect after moving to another computer

Keep both the source folder and the [recovery key](/security/encryption/). The source folder contains the encrypted catalog as well as the encrypted artifacts; the recovery key alone does not contain the installers.

On another installation, configure the same tenant, import the matching recovery key in **Settings → Storage and recovery**, then use **Reconnect source store** in App Backup to select the root of the retained source folder, which contains the tenant GUID folders. Selecting a tenant folder or an individual package folder is refused. If the selected root has no source store for this tenant, TenuVault asks before using it as a new empty store. Listing and export can read a retained store without creating folders in it. Each source is rebuilt from its encrypted manifest. Reconnecting changes the folder used for this tenant; it does not move or delete previous source folders.

Unreadable or incomplete sources are not silently counted. Interrupted imports stay out of the catalog. Owned staging left by a terminated process is reconciled when the folder is next read; uncertain staging is left unlisted with a notice. Encrypted export journals in local app data track temporary plaintext so a later run on the original computer can remove interrupted exports. Keep the source folder accessible until interrupted work has been reconciled.

## Coverage and device checks

The Intune app list is live metadata, not evidence of installer availability. Saved packages are not automatically matched to Intune versions. A stored package does not establish restore readiness.

**Check this PC** is read-only. On Windows it can compare public enrollment/certificate metadata with the selected tenant's Intune account. It requires Microsoft sign-in and the appropriate Intune permissions for the selected tenant, but no product license or Community tenant selection. Use **Sign in to Microsoft** on the app list or **Sign in again** in preparation to authenticate without a product-license check. Local source operations remain available while signed out. It never uses a private key, requests installer content, elevates a process or enables recovery. A matched enrollment is not a statement that recovery is ready. Non-Windows and unconfirmed checks explain why their state is unavailable or unknown.
