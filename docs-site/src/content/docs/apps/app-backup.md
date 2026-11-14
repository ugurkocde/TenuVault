---
title: "App Backup: Intune installers"
description: Back up Win32 installer content from Intune on an enrolled Windows PC, keep it encrypted, export it offline and restore it to another tenant. App Backup is free.
faq:
  - question: "Is TenuVault App Backup free?"
    answer: "Yes. App Backup is completely free for every configured tenant. It does not require a paid product license or Community tenant selection. Microsoft authentication and Intune permissions still apply to tenant reads."
  - question: "Do I need to choose an installer from my computer?"
    answer: "No. App Backup is intended to retrieve installer content from Intune. Selecting an existing local file is not an Intune backup. The manual attachment action has been removed."
  - question: "Can this build retrieve Windows or macOS installers from Intune?"
    answer: "The Windows preview retrieves system-context Win32 installer content on a PC enrolled in the selected tenant. It requires Windows approval and an active Intune Administrator or Global Administrator session. macOS installer capture is not available yet."
  - question: "Can I still export a file saved by an earlier version?"
    answer: "Yes. Earlier administrator-selected files remain available as legacy local archives. You can export them offline with the matching recovery key, but they are not captured Intune backups and cannot be used for restore."
  - question: "Can App Backup restore apps?"
    answer: "Yes. Restore to tenant creates a new, unassigned Win32 app in a connected tenant using an earlier captured installer and reviewed app settings. Arbitrary local packages and metadata-only backups do not qualify. Apps with dependencies, supersedence or Intune-hosted install scripts are not supported yet."
---

**App Backup is completely free** for every configured tenant. Open it below **Backup & Restore** in the desktop sidebar.

App Backup's purpose is to retrieve installer content from Intune and retain an encrypted backup. The **Windows capture preview** retrieves system-context Win32 installers on an enrolled Windows PC. Restore can upload a captured Win32 installer to the same or another connected tenant. macOS installer capture is not available yet.

The earlier manual-file workflow has been removed. Files already saved by an earlier build remain available as **Legacy local archive**, with an export action. They are not counted as Intune captures.

## What works now

| Action | Availability |
| --- | --- |
| List and search the tenant's Windows Win32 apps | Available using your existing Microsoft session |
| View version, logo, description, installation settings, rules and assignments | Available when Intune returns the information |
| Print app details or download available script content | Available; scripts are never executed |
| Read public Windows enrollment metadata | Available on Windows; does not establish installer access |
| Check this PC's app assignments before capture | Automatic on Windows; group membership needs optional directory-read permissions |
| Browse, reconnect and export legacy archives | Available offline with the matching recovery key |
| Retrieve Windows installer content from Intune | Windows preview, system context, up to 2 GiB |
| Retrieve macOS PKG or DMG installer content from Intune | Not available in this build |
| Restore an app using a captured installer | Create a new, unassigned Win32 app in a connected tenant; restrictions below |

macOS support means retrieving the installer from Intune, not downloading a substitute from a vendor or copying an installed `.app` directory. It needs its own tested device adapter. Windows app metadata can be viewed on a Mac; a Mac cannot perform the Windows enrollment check.

## Browse your tenant's apps

1. Select a configured tenant and open **App Backup → Intune apps**.
2. The app table uses the Microsoft session already connected to that tenant. Use **Reconnect Microsoft** only if it is missing or expired.
3. Search by name, publisher or version, then open **Details**.
4. Review the app's overview, installation settings, scripts, detection and requirement rules, and assignments. Values that Intune does not return stay unspecified.

**Download** appears only when a script's actual content can be retrieved and decoded. A command line referring to a script inside the installer does not make that file available for download. Downloading a script does not execute it or back up the installer payload. Print uses the operating system's printer dialog.

## Back up a Windows installer

1. Open TenuVault on a Windows PC enrolled in the same Intune tenant. Use your existing Microsoft session with an active **Intune Administrator** or **Global Administrator** role. Custom Intune roles are not supported by this preview.
2. Find the app and choose **Backup**. The preview supports **system-context** Win32 apps with one committed installer payload, up to **2 GiB**.
3. Review **Assignment check for this PC**, which runs automatically. It identifies device targeting, exclusions, user-only assignments and filters, with next steps. Use **Recheck assignments** after an intended change in Intune.
4. Choose **Start backup** and approve the Windows prompt. The desktop app stays non-elevated; a temporary helper uses the enrollment key for this request. A check older than a minute refreshes first so you can review its updated guidance before starting.
5. Wait while TenuVault downloads, verifies and encrypts the installer. Completion appears only after the encrypted backup is published.
6. Choose **View this backup** in the completion message to open the exact captured version, with its file details and **Export installer** action. Choose **Open local folder** to open its encrypted backup folder in your file manager. Keep the [recovery key](/security/encryption/) from Settings safe.

If the app record has no committed installer content, Backup explains this before asking for Windows approval. Choose an app whose installer has been uploaded to Intune.

New captures also require an online check of TenuVault's signed capture control. Capture can
be paused if the preview's Intune integration needs a fix, or an app update may be required.
This check is free and sends no Microsoft token, tenant ID or license key. An unavailable
control service prevents a new capture; existing backups remain available to export offline.

No local installer file is required. Backup does not change assignments or start an installation. Intune must allow this device to retrieve the content. If it refuses access, review the app's Required targeting, including group membership, exclusions and filters. Required assignments can install software automatically; use a dedicated test-device group. A successful enrollment check alone does not prove content access.

The helper reads the Intune agent's recently discovered service address. If it cannot find that address, sync the PC with Intune and retry. This preview requires your Windows account to be a local administrator. Approval with a different Windows account is not supported. Cancelling approval or the capture leaves no completed backup. If a Windows approval prompt remains after cancellation, dismiss it; its expired request cannot continue.

Microsoft permissions remain separate from product licensing. The configured registration needs delegated `DeviceManagementApps.ReadWrite.All`, `DeviceManagementServiceConfig.Read.All` (or its read/write equivalent), and `User.Read`. TenuVault's standard setup includes these capabilities. No paid TenuVault license is required.

### Understand the assignment check

The check reads app assignments and matches this PC's local Entra identity and Intune enrollment to the selected tenant. It uses the device's reported transitive group memberships, including nested groups. Device identifiers stay in the main process; the app does not use the administrator's user membership as a substitute for the capture PC.

| Result | What to do |
| --- | --- |
| A device assignment includes this PC | No device-targeting change is indicated. Start backup; Intune still decides whether content access is allowed. |
| No assignments, or no device assignment found for this PC | Review the named targets. Add the PC to the intended device group or create a Required assignment to a dedicated device group containing it. |
| This PC matches an app exclusion | Review the named exclusion and its intent. Another include assignment of that intent does not override a matching exclusion. Change scope only if the PC should receive the app. |
| Only user targeting found | User-based access is not evaluated. To target the capture PC explicitly, use a dedicated device-group assignment; existing user assignments can remain. |
| Filter needs review | Check the displayed filter name, mode and rule in Intune. For an include filter the PC must match; for an exclude filter it must not match. TenuVault does not reproduce Intune's filter evaluation. |
| Install and uninstall targeting | Review the competing intents in Intune before changing targeting. The check does not predict a final install outcome. |
| Check unavailable or membership unknown | Resolve the displayed enrollment, connectivity or permission issue and recheck. Incomplete results are never treated as an empty assignment list. |

No assignment or group membership is changed automatically. Required assignments can cause Intune to install software; keep intended changes limited to a dedicated test-device group. After changing targeting, sync the PC and allow membership changes to propagate before rechecking. An assignment check is guidance, not proof of installer authorization, so an uncertain check still allows a deliberate Backup attempt.

Device-group checks need optional delegated **`Device.Read.All`**. Reading names and visibility of referenced groups needs **`GroupMember.Read.All`** or an existing broader group-read permission. Filter details use **`DeviceManagementConfiguration.Read.All`** or its read/write equivalent, already included in the standard setup. For an existing registration, add only the needed read permissions in Entra, grant admin consent, reconnect Microsoft in TenuVault, then recheck. The default setup permissions are unchanged. All-devices and user-only targeting can be described without device-group reads.

## Backups and legacy archives

Open **Backups** to view the encrypted folder for the selected tenant. Intune captures and earlier local archives have distinct provenance labels. A legacy archive cannot gain capture provenance by changing its name or matching an app's display name.

Each stored item also offers **Open local folder**. This folder contains encrypted backup files; use **Export installer** in TenuVault to produce a usable installer payload. When viewing one completed backup, **View all backups** returns to the full catalog.

An installer capture must match the requested tenant, live app and committed version, then pass HMAC, size and plaintext SHA-256 checks before publication. Its receipt retains a hash of the opaque device content service identifier; that fingerprint is not a Microsoft Graph file ID. Interrupted or failed staging is not listed as a backup. The Windows payload is a source ZIP, not a byte-identical copy of the outer `.intunewin` originally uploaded to Intune. New captures also retain encrypted app settings. Restore verifies the captured ZIP, encrypts it with fresh upload keys, uploads it through Microsoft Graph beta and checks Intune’s content commit and app publication before reporting success.

## Export a backup or legacy archive

1. Open **Backups** and find the captured installer.
2. Choose **Export installer**, then select a new destination filename. For an older **Legacy local archive**, use **Export archive**.
3. Wait for **Installer exported**.

Export preserves existing destination files and checks the encrypted chunks and full file hash before publishing. The destination filesystem must support hard links. On macOS and Linux, exported files initially have owner-only permissions.

Export remains available while signed out, provided the tenant is configured and the matching recovery key is available. Switching between App Backup's tabs keeps the operation running. Leaving App Backup or switching tenants cancels an unfinished capture or export.

## Restore to the same or another tenant

1. Connect the destination tenant in TenuVault. App Backup and this restore flow remain free for every configured tenant.
2. In the source tenant, open **App Backup → Backups**, then **Restore to tenant…** on a captured installer.
3. Review the app settings. For a backup created before settings snapshots were available, choose **Load current app settings**. This reads the source tenant and accepts settings only when the committed content version still matches the captured installer. These are labeled as current settings, not settings from the original backup date. If the source session has expired, use **Reconnect source and load settings**; destination sign-in stays separate. If the source app changed version or is unavailable, make a new backup instead.
4. Choose the destination tenant and enter the new app name. TenuVault reuses its existing Microsoft session. Sign in only if that destination has no active session. The account needs Intune permission to create apps, and the configured registration needs delegated `DeviceManagementApps.ReadWrite.All`.
5. Confirm the destination and choose **Restore unassigned app**. Before the first change to that tenant, review and accept the tenant disclaimer. Cancelling it makes no changes. The installer is verified, encrypted with fresh keys and uploaded without plaintext staging files.
6. Wait for Intune to confirm the content and publish the app. Choose **Open restored app** to inspect it in the destination tenant before assigning it.

If you are operating TenuVault remotely, choose **Use a device code** in the destination sign-in section. Open the displayed Microsoft address on another device, enter the short code and sign in to the destination tenant. TenuVault keeps the resulting session on the computer running the restore. Closing the dialog or choosing **Cancel device sign-in** stops the pending request. Microsoft MFA and Conditional Access still apply; use browser sign-in on the TenuVault computer if your organization does not allow device-code authentication.

Device-code authentication requires **Allow public client flows** to be enabled under the destination app registration's **Authentication** settings in Entra. TenuVault does not change that setting automatically. If Microsoft accepts the user sign-in but TenuVault reports `invalid_client`, check that setting or use browser sign-in. See [Microsoft's public-client configuration guidance](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration).

Restore creates a new app; it does not overwrite an existing destination app or install anything. It copies supported app metadata, the logo, install/uninstall commands, detection and requirement rules (including inline scripts), installation settings, return codes and MSI information. Review tenant-specific URLs, commands and script contents before deployment.

Assignments, group IDs, assignment filters, categories and custom scope tags are not copied. The new app uses the destination's default scope tag. Apps with dependencies, supersedence or Intune-hosted install/uninstall script references require additional mapping or script-upload support and are blocked before creation. This is a deliberate restore operation, not continuous synchronization.

Capture requires an enrolled Windows PC. Restoring an existing supported Win32 backup uses Microsoft Graph and does not require enrollment in the destination or Windows elevation. The source tenant can be offline when the backup already contains its settings; destination access is always required.

### Interrupted restores

Leaving App Backup or switching the source tenant stops an unfinished restore. An unassigned draft app may remain in Intune; TenuVault does not delete it automatically. Retry with the **same backup, destination and app name** to continue that app. The encrypted backup folder keeps its restore journal, including the destination binding and upload encryption material, so keep the matching recovery key safe.

Only one process or computer can restore a particular backup to a particular destination at a time. The backup folder keeps an encrypted ownership record throughout the operation. After a crash, the same TenuVault installation can recover its stopped process’s lock. A lock from another computer or an unknown owner remains blocked; return to the owning installation to recover it, or review the interrupted operation before manually removing its lock. Do not remove a lock while another restore could still be running.

If Intune reports a permanent upload-storage failure, the draft is retained for review. Intune may refuse renewal in this state; TenuVault does not delete the draft or create a replacement automatically.

If a creation response was lost, TenuVault searches for its unique restore marker and refuses to create a second app when the outcome cannot be confirmed. If someone assigns or changes an unfinished destination app, restore stops for review. A successful repeat returns the existing restored app. Creating another copy from the same backup in the same destination is not currently supported.

Legacy local archives are export-only and cannot be selected for restore.

## Reconnect a retained folder

Keep both the encrypted folder and its [recovery key](/security/encryption/). The key alone does not contain the installers.

On another installation, configure the same tenant, import the matching key in **Settings → Storage and recovery**, then use **Choose installer folder** to select the retained folder's root, which contains the tenant folders. Reconnecting does not move or delete any existing files. Earlier archive manifests remain readable.

If a folder cannot be read, check its location and import the matching key. After an interrupted export, resolve any destination file locks and refresh to retry cleanup. A published export remains successful even if temporary-file cleanup needs another attempt.

## Related pages

- [Connect your tenant](/getting-started/connect-tenant/)
- [What gets backed up](/backups/coverage/): app settings and installer content are separate.
- [Encryption and recovery key](/security/encryption/)
