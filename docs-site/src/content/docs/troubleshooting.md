---
title: "Troubleshooting"
description: Messages TenuVault shows, what causes them, and how to fix them.
---

This page lists the messages TenuVault shows, grouped by area, with the cause and the fix for each. Text in *italics* is replaced with your own values, such as a tenant or storage account name.

* [Starting the app](#starting-the-app)
* [Sign in](#sign-in)
* [License](#license)
* [Backup](#backup)
* [Azure storage](#azure-storage)
* [Restore](#restore)
* [Updates](#updates)
* [Background backups](#background-backups)
* [Baselines and frameworks](#baselines-and-frameworks)

## Starting the app

| Message | Cause | Fix |
| --- | --- | --- |
| OS encryption is not available. Enable the operating system credential store before opening TenuVault. | TenuVault encrypts its saved data with the operating system's credential protection (Windows data protection or the macOS Keychain) and cannot find it. | Make sure you are signed in to a normal user session with the credential store available, then start TenuVault again. |
| TenuVault cannot unlock its saved data. | On macOS, access to TenuVault's Keychain item was denied. On Windows, the data was probably created by another Windows user. | On macOS, allow access to the Keychain item and start the app again. On Windows, start TenuVault as the user who set it up. If that is not possible, choose **Start over**: your saved data is kept as a backup, and you sign in to your tenants and activate your license again. **Quit** changes nothing. |

## Sign in

| Message | Cause | Fix |
| --- | --- | --- |
| Enter a tenant id or a domain such as contoso.onmicrosoft.com. | The **Tenant id or domain** field is not a GUID or a domain. | Enter the tenant ID or a verified domain of the tenant. |
| The client id is a GUID, printed by the setup script. | The **Application (client) id** is not a GUID. | Copy the client ID from the setup script output or from the app registration in Entra. See [Create the app registration](/getting-started/app-registration/). |
| You signed in to a different tenant. Sign in with an account from this tenant. | The account you used belongs to another tenant, for example a guest account or the wrong browser profile. | Sign in again with an account that is a member of the tenant you are connecting. |
| Microsoft did not return an account for this sign-in. | The sign-in window closed or completed without returning an account. | Try again, and finish the sign-in in your browser. |
| You are not signed in to this tenant. Sign in to continue. | No sign-in is stored for this tenant on this device, or it was made with a different client ID. | Click **Sign in** on the banner, or **Sign in** next to the tenant in **Settings** > **Sign-in**. |
| Your session for *user* has ended. Sign in again to continue. | The cached account is no longer available, for example after the refresh token expired. | Sign in again. |
| Microsoft needs you to sign in again as *user* for *resource* (*codes*). | Microsoft requires interaction for that resource (Microsoft Graph, Azure Storage or Azure Service Management), for example because of Conditional Access, MFA, a password change or missing consent. The codes are the Microsoft error codes, such as `invalid_grant, AADSTS65001`. | Click **Sign in** on the banner and complete the prompt. TenuVault signs you in for the resource named in the message. |
| The app registration has no admin consent for *resource* (AADSTS650057 or AADSTS65001). Add the *permission* to the app registration, grant admin consent, and sign in again. | The app registration does not list the permission, or the permission has no admin consent. Signing in again cannot fix this. It happens with Azure storage when the Azure permissions were left out of the app registration. | Add the permission named in the message (`user_impersonation` for Azure Storage and Azure Service Management, the listed delegated permissions for Microsoft Graph) as described in [Create the app registration](/getting-started/app-registration/), select **Grant admin consent for &lt;your tenant&gt;**, and click **Sign in** again. Backups on this device do not need the Azure permissions. |
| Sign in to access Intune and verify this tenant's license. | Notice on **Backup & Restore**, **Drift Detection** and **Audit Log**: the selected tenant is not signed in. | Click **Open sign-in settings** and sign in. |
| The tenant was not added. *reason* | Adding the tenant failed. The reason follows. | Fix the reason shown, often a license or sign-in issue, and add the tenant again. |

If Microsoft shows an error in the sign-in window itself (an `AADSTS` code), check that the app registration exists in this tenant, that admin consent was granted, and, if the setup script was run with `-AllowedGroupId`, that your account is a member of that group. See [App registration and delegated permissions](/security/permissions/).

If the browser shows `AADSTS50011` (redirect URI mismatch), the app registration is missing the `http://localhost` redirect URI. Add it under **Authentication** > **Mobile and desktop applications**, as described in [Create the app registration](/getting-started/app-registration/), and sign in again.

## License

| Message | Cause | Fix |
| --- | --- | --- |
| A TenuVault license is required for this tenant. Add your license key on the License page, or start a 30 day free trial. | The tenant has no license and is not the free Community tenant on this device. | Add a license key on the **License** page, or start a trial at [tenuvault.com](https://tenuvault.com/desktop#pricing). |
| TenuVault Community covers one tenant, and it is used for tenant *ID*. Add a Pro or MSP license on the License page to use more tenants. | Community is free for one tenant, and another tenant already uses it. | Add a Pro or MSP license key. See [Plans and features](/licensing/). |
| An active license is required for backup and restore operations. | Notice on the backup, drift and audit pages: the tenant is signed in but not licensed. | Click **Open license** and activate a license for the tenant. |
| *Feature*: included in TenuVault Pro and MSP. Upgrade on the License page. | The action needs a higher plan, for example daily schedules, Azure storage, restoring several items or replacing in place. | Upgrade on the **License** page, or use an option your plan includes. |
| This license key is not valid for TenuVault. | The key is not a TenuVault key. | Paste the key from your purchase email. Keys start with `TENU`. |
| This license key is not valid, or it has been revoked or has expired. Check your subscription in the customer portal. | The license server does not know the key, or it is no longer active. | Click **Manage subscription** on the **License** page and check the subscription. |
| This license has been revoked. Check your subscription. / This license key has been disabled. / This license key has expired. | The subscription behind the key is no longer active. | Renew or check the subscription in the customer portal. |
| This license already covers its maximum number of tenants. Upgrade, or remove a tenant from TenuVault on the machine that uses it. | Pro covers two tenants and MSP covers its subscription quantity, and all are in use. | Remove a tenant you no longer protect, or increase the subscription. |
| This tenant already has 5 active installations. Deactivate one in the app or the customer portal. | Five installations already use the license for this tenant. | Click **Deactivate this machine** on an installation you no longer use, or deactivate it in the customer portal. |
| This license has no activations left. Deactivate an installation in the customer portal. | All activations of the key are in use. | Deactivate an unused installation in the customer portal. |
| This installation is no longer activated. It activates again the next time the tenant is used. | The installation was deactivated elsewhere. | Use the tenant again; TenuVault activates it automatically. |
| Your organization has no license for this tenant. | You rely on an organization license, but no admin shared one with this tenant. | Ask the admin who holds the key to tick **Let other admins in this tenant use this license**, or add your own key. |
| The licensing service could not be reached. / The licensing service is unavailable. Please try again later. | TenuVault could not reach tenuvault.com, or the service had an error. | Check that the device can reach `tenuvault.com` over HTTPS. A verified license keeps working offline until the **Verified until** date on the **License** page. |
| Your Microsoft sign-in could not be verified by the licensing service. Sign in again and retry. | The license check could not verify your Microsoft sign-in. | Sign in to the tenant again, then click **Retry** on the **License** page. |
| Sign in to this tenant again to check your organization's license. | The organization license check needs a recent sign-in. | Sign in to the tenant again. |
| Deactivate this machine before entering a different license key. | A key is already active on this device. | Click **Deactivate this machine**, then enter the new key. |
| Only the machine that holds the license key can change sharing. | License sharing can only be changed where the key was entered. | Change **Let other admins in this tenant use this license** on the machine that holds the key. |
| Sign in to this tenant again to share the license with it. | Sharing needs a recent sign-in to the tenant. | Sign in to the tenant again, then change the setting. |
| Enter a valid license key. | The key has the wrong format. | Paste the whole key from your email, without extra characters. |

More on licenses: [Activate and manage your license](/licensing/manage/).

## Backup

| Message | Cause | Fix |
| --- | --- | --- |
| Choose where backups for this tenant are stored in Settings first. | The tenant has no backup storage. | Choose storage in **Settings** > **Sign-in** > **Change storage**. See [Choose where backups are stored](/getting-started/choose-storage/). |
| Choose at least one type to back up. | A custom scope excludes every type. | Select at least one type in the backup scope. |
| The backup could not start. | The backup request was rejected. A more specific reason is usually shown with it. | Check the tenant's sign-in, license and storage. |
| Access denied by Microsoft Graph: *message*. Check that your account has an Intune role and the app registration has the Intune permissions. | Graph returned 403 while reading Intune. | Make sure your account has an Intune role such as Intune Administrator, and that admin consent was granted for the app registration. |
| Skipped *type*: access was denied. The app registration may lack the permission or admin consent, or your Intune role may not allow it. | Microsoft Graph returned access denied for this type. Usually the app registration is missing a permission added in a newer version, or the permissions were added but never got admin consent. Your Intune role can also be the cause. **Backup Details** lists these types under "Left out because access was denied". | Open the app registration in Microsoft Entra, go to **API permissions** and select **Grant admin consent for &lt;your tenant&gt;**, or run the setup script again. Then sign out of the tenant in TenuVault and sign in again. If every permission already shows **Granted**, check that your Intune role covers these items. |
| Could not read *type*: *message* | Reading one type failed. The backup continues and completes with warnings. | Check the message. Retry the backup later if it was a temporary Graph error. |
| Could not back up "*name*": *message* | Saving one item failed. | Check the message and the storage. Retry the backup. |
| Backup failed: no policies could be saved | Nothing could be written. | Check storage access and sign-in, then retry. |
| Older backups were kept because this backup is incomplete. | Retention cleanup only runs after a complete backup. | No action needed. Fix the cause of the incomplete backup. |
| This backup stopped before it finished, for example because TenuVault was closed. It holds only part of the tenant. | The app closed or the machine slept during the backup. | Run a new backup. The partial backup can still be used for restore. |
| Backups are unavailable. Check this tenant's sign-in, license, and storage access. | **Backup History** could not load. | Sign in again, check the license, and check storage access. |
| This backup was encrypted with a key this device does not have. Import its recovery key. | The backup was made on another device or before a reinstall. | Import the recovery key in **Settings** > **Storage and recovery** > **Import a recovery key**. See [Encryption and recovery key](/security/encryption/). |
| This is not a TenuVault recovery key. Use a TVK2 bundle or a legacy TVK1 key. | The pasted text is not a recovery key. | Paste the full key from the recovery key file, starting with `TVK2.` |
| Backup inventory is incomplete: *N* file(s) listed in the manifest are missing. Recover the missing files before downloading or restoring. | Files were removed from the local backup folder. | Restore the missing files into the folder, for example from a copy of the network share. |
| Download failed: *N* backup files could not be read. Retry to download a complete archive. | Some files could not be read while building the ZIP. | Retry the download. Check storage access if it keeps failing. |

### Importing a backup ZIP

| Message | Fix |
| --- | --- |
| Choose an archive smaller than 32 MiB | Only archives up to 32 MiB can be imported. |
| A TenuVault export manifest with source tenant identity is required | The ZIP is not a TenuVault export or its manifest was removed. Use the original **Download** from **Backup Details**. |
| Only complete backups with item metadata can be imported | Export a backup whose status is **Complete**. |
| Backup contents do not match the export inventory / Backup archive is incomplete or contains extra files / Archive contains an unsupported file | The ZIP was changed after export. Use an unmodified export. |
| This backup already exists on this device | The backup was already imported. Choose **This device** as storage for the tenant to see it. |

## Azure storage

| Message | Cause | Fix |
| --- | --- | --- |
| Could not list your Azure storage accounts. / Failed to access Azure subscriptions | TenuVault could not list your subscriptions or storage accounts. | Check that your account can see the subscription in the Azure portal and that the app registration has the Azure Service Management permission with admin consent. |
| No storage accounts found that your account can see. Ask an Azure administrator to create one and grant you access. | Your account has no access to any storage account. | Ask an Azure administrator to create a storage account and grant you access. |
| You do not have write access to storage account *name*. Ask an Azure administrator for the "Storage Blob Data Contributor" role on it. New role assignments can take a few minutes to apply. | Your account lacks a data role on the storage account. Owner or Contributor alone does not grant access to blob data. | Assign **Storage Blob Data Contributor** on the storage account, wait a few minutes, and click **Check access** again. |
| Your account cannot read backups in storage account *name*. Ask an Azure administrator for the "Storage Blob Data Contributor" role on it. | Same cause, when listing backups. | Same fix. |
| Storage account *name* rejected the request from this network. Allow this computer's public IP address in the storage account's networking settings, or connect through a network it allows. | The storage account firewall blocks your network. | Add your public IP address in the storage account's **Networking** settings, or connect through an allowed network. |
| Storage account *name* could not be reached. | Network or DNS problem, or a proxy blocks `*.blob.core.windows.net`. | Check that the device can reach `<account>.blob.core.windows.net` over HTTPS 443. |
| Storage account *name* returned *status* (*code*): *message* | Azure Storage returned another error. | Act on the code and message shown. |
| Save your current backup recovery key in Settings before the first encrypted Azure backup. | Azure uploads stay blocked until the current recovery key has been exported. | Click **Save recovery key** in **Settings** > **Storage and recovery**, then run the backup again. |
| Backup authentication failed. Import the correct recovery key or recover an undamaged snapshot. | The snapshot was encrypted with a key this device does not have, or it was changed or damaged. | Import the recovery key used for the backup. If the key is correct, the file is damaged; use another backup. |
| Backup tenant context is unavailable. Sign in again. | The storage request lost its tenant context. | Sign in to the tenant again and retry. |

## Restore

| Message | Cause | Fix |
| --- | --- | --- |
| No backups to restore from | The tenant has no backup with items, or its only backup is still running. | Run a backup first. |
| This backup did not complete fully, so some items may be missing from it. | The chosen backup stopped early or had failures. | Items that were saved restore normally. Pick another backup if the item you need is missing. |
| Intune does not let apps download installer files. Upload the installer again to restore this app. | The app type needs an installer, which Intune does not export. | Upload the installer through Intune. See [What cannot be restored](/restore/limitations/). |
| This backup holds a masked OMA-URI value (****). Create a new backup to restore it; restoring would send **** to devices. | The backup captured a secret as `****`. | Run a new backup, then restore from it. |
| This is the tenant default. Restore updates it in place. / This is the default branding. Restore updates it in place. | Defaults cannot be copied. | Use **Replace in place**. |
| Replace only: this object cannot be copied. | Shown in **Replace in place** mode for items that cannot be restored as copies. | Keep **Replace in place** for this item. |
| This snapshot is not authenticated. Review its content and restore a copy; replacement is blocked. | The snapshot is an `[Unverified legacy]` backup written before client-side encryption. | Review the snapshot and restore a copy. |
| Unverified legacy backups cannot replace live policies. Review the content and restore a copy instead. | Same cause, at restore time. | Same fix. |
| Assignment replacement is not supported for *type*. Turn off Restore assignments and reconcile assignments in Intune. | Windows Autopilot profiles, Apple user enrollment profiles, terms and conditions and Intune roles cannot have assignments replaced in place. | Restore these items in their own selection with **Restore assignments** off. See [Restore modes and assignments](/restore/modes/). |
| Assignments were not restored: this backup was made by an earlier TenuVault version that could not read them. Assign the policy in Intune. | Earlier versions saved Settings Catalog policies (including endpoint security and Settings Catalog compliance policies) without their assignments. Restoring such a backup with **Restore assignments** leaves the item's current assignments as they are instead of removing them. | Check the item's assignments in Intune. Backups made with this version include the assignments. |
| *property* changed since the backup and Intune cannot change it on an existing app. Delete the app and restore it to recreate it. | Some app properties can only be set on create. | Delete the app in Intune, then restore it with **Replace in place** to recreate it. |
| Restore: the current version could not be checked | Reading the live item for the review failed. The read error is shown under the item. | Check the error. The item is still restored if you continue. |
| The backup file could not be read. / This snapshot could not be assessed. | TenuVault could not read or decrypt the snapshot. | Check storage access and the recovery key. See [Backup](#backup) and [Azure storage](#azure-storage). |
| Assignments could not be restored: *message* / Settings could not be restored: *message* | The object was created or updated, but a follow-up step failed. The result shows "Incomplete object: *ID*". | Click **Retry failed items** within one hour to repair it without creating another object, or complete it in Intune. |
| Repair is unavailable or expired. Check the existing object in Intune; do not create another copy. | The one hour repair window passed or the app was restarted. | Complete the incomplete object in Intune. |
| The live object changed after the failed restore. Review it and start a fresh replacement. | Someone changed the object between the failure and the repair. | Review the object and restore it again. |
| Outcome unknown. Check Intune before attempting another restore. / Check this item in Intune before retrying; a write may already have completed. | The response of a write was lost, for example because the connection dropped. | Check the item in Intune, then resolve the write in **Restore write history**. See [Restore write history](/restore/limitations/#restore-write-history). |
| A previous write has an uncertain outcome. Reconcile it in Settings before retrying. | An identical earlier write has an unknown outcome. | Open **Settings** > **Storage and recovery** > **Restore write history** and choose **Confirm applied** or **Confirm not applied**. |
| Restore journal is full. Review write history in Settings before continuing; recent reconciliations stay protected for one hour. | The write history holds 1,000 records that cannot be removed yet. | Resolve uncertain records in **Restore write history**, or wait an hour. |
| Microsoft Graph did not return an ID. Check Intune before retrying. | Graph accepted a create but returned no ID. | Look for the object in Intune before retrying, so you do not create a duplicate. |
| Microsoft Graph retry limit reached | Graph kept throttling the request. TenuVault tries each request up to four times and honours retry delays up to 30 seconds. | Wait a few minutes and use **Retry failed items**. |
| Unresolved target dependencies (*paths*). Copy the dependencies first or reconcile this object in the target tenant. | A cross-tenant copy refers to objects that do not exist in the target tenant. | Include the dependencies in the same restore, or map apps and app categories. See [Restore to another tenant](/restore/cross-tenant/). |
| A mapped dependency is missing or unreadable in the target tenant | A mapped target ID does not exist or cannot be read. | Check the target IDs in the target tenant. Nothing was written. |
| The original target tenant is no longer connected. | A retry targets a tenant that was removed from TenuVault. | Connect the tenant again, or start a new restore. |
| Sign in with licensed Intune access to this tenant before viewing or changing restore history. | Restore write history requires sign-in, a license and live Intune access for the tenant. | Sign in to the tenant again and check its license and your Intune role. |

## Updates

| Message | Cause | Fix |
| --- | --- | --- |
| Could not check for updates: *message* | TenuVault could not reach GitHub releases. | Allow `github.com`, `release-assets.githubusercontent.com` and `objects.githubusercontent.com` over HTTPS. Backup and restore keep working without updates. See [Network connections and data flows](/security/data-flows/). |
| Your organization manages updates for TenuVault. | Automatic updates are turned off by policy (`DisableAutoUpdate`). **Check now** is unavailable. | Your IT department deploys updates. See [Deploy TenuVault in your organization](/deploy/). |
| Automatic updates are off. | **Download and install updates automatically** is off in **Settings** > **Updates**. | Tick the setting to turn updates back on. |
| TenuVault *version* is ready. It installs the next time TenuVault restarts. | An update was downloaded. | Click **Restart now**, or **Restart and update** in **Settings** > **Updates**. |

A stable install follows stable releases by default. Enable **Settings** > **Updates** > **Get nightly builds** to receive previews. Turn it off to return to the current stable release, even if that version is older than the installed nightly. See [Install and update TenuVault](/getting-started/install/).

## Background backups

| Message | Cause | Fix |
| --- | --- | --- |
| Scheduled backup of *tenant* failed | Desktop notification after a scheduled or tray backup fails. The body holds the reason. | Open TenuVault and check the backup log in **Backup & Restore**. The next scheduled slot retries. |
| Not backed up: *reason* | A scheduled or tray backup was refused because the license or plan does not cover it. The schedule panel lists these under "Not backed up because of the license". | Fix the license, or change the schedule to one your plan includes. Daily schedules and Azure storage need Pro or MSP. |
| This tenant is no longer connected. | A schedule exists for a tenant that was removed. | Add the tenant again, or remove its schedule. |
| Choose a time such as 02:00. / Choose a day of the week. | The schedule time or day is invalid. | Enter a 24 hour time and, for weekly schedules, a weekday. |
| Background launch requires an installed Windows or macOS build. / Available in installed Windows and macOS builds. | Background launch only works in the installed app. | Install TenuVault with the installer and try again. |
| An older direct-launch agent is loaded. Remove background launch first, then log out and back in before reinstalling; active backups are left running. | macOS still has an agent from a pre-release build. | Click **Remove background launch**, log out and back in, then install it again. |
| TenuVault is still running | Shown when you close the window. TenuVault keeps running in the tray so schedules can run. | Quit TenuVault from its tray icon if you want it to stop. |

Scheduled backups also stop when:

* **The machine is asleep, off, or you are signed out.** Background launch only runs in your own signed-in session and does not wake the machine. A missed slot runs once at the next start.
* **The sign-in needs interaction.** A background backup cannot complete MFA or Conditional Access prompts. Sign in again when TenuVault shows the banner.
* **The backup storage is unavailable.** Check the storage messages above.

See [Schedule backups](/backups/schedules/).

## Baselines and frameworks

Messages from the OpenIntuneBaseline section and framework comparisons are covered on their own pages:

* [OpenIntuneBaseline](/baselines/quick-start/#troubleshooting)
* [Framework coverage](/baselines/frameworks/#troubleshooting-comparisons)

## Still stuck?

Check **Settings** > **About** for your TenuVault version and sign-in method, then contact support through **Website and support** on the same page.
