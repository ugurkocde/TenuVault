---
title: "Settings reference"
description: Every control on the Settings page, what it does and when to use it.
---

**Settings** holds sign-in, backup storage, encryption, background backups, PDF branding and updates for this computer. Open it from the bottom of the sidebar.

The buttons at the top of the page jump to each section: **Sign-in**, **Storage and recovery**, **Background runner**, **PDF branding**, **Updates** and **About**.

Settings apply to this computer only. Other admins who use TenuVault have their own settings.

## Appearance

The **Appearance** list at the top right sets the color theme.

| Option | Effect |
| --- | --- |
| **Use system setting** | Follows the light or dark mode of Windows or macOS, and switches when it changes. Default. |
| **Light** | Always light. |
| **Dark** | Always dark. |

## Sign-in

The **Tenants** card shows, for each connected tenant, who you are signed in as and where its backups are stored, for example **Signed in as admin@contoso.com · Backups: This device (encrypted)** or the name of the Azure storage account. **Not signed in** means TenuVault has no valid sign-in for the tenant.

If no tenant is connected, the card shows **No tenants yet.** with a link to **Set up your first tenant**.

| Control | What it does |
| --- | --- |
| **Sign in** / **Sign in again** | Opens a Microsoft sign-in for the tenant, pre-filled with the account last used. You must sign in to the same tenant; otherwise TenuVault shows **You signed in to a different tenant. Sign in with an account from this tenant.** Signing in again also rechecks the tenant's license. |
| **Change storage** | Opens **Backup storage for &lt;tenant&gt;**, where you choose between **This device, encrypted** and **Your Azure storage account, encrypted**. |

### Change storage

1. Select **Change storage** for the tenant.
2. Choose the new location. For Azure, choose the **Storage account** and select **Check access** until it shows **Access confirmed**.
3. Select **Save**. TenuVault confirms with **Backups for &lt;tenant&gt; now go to &lt;location&gt;.**

New backups go to the location you choose. Existing backups stay where they are and are only listed while that location is selected. Azure storage needs the Pro or MSP plan. For the options and errors, see [Choose where backups are stored](/getting-started/choose-storage/).

To add or remove tenants, use **Tenants**. See [Manage tenants](/tenants/).

## Storage and recovery

### Backups on this device

This card applies to tenants that keep backups on this device. Every backup file is encrypted with AES-256-GCM; file names reveal nothing about your policies.

| Control | What it does |
| --- | --- |
| **Import backup ZIP** | Imports a backup exported as a ZIP file. TenuVault shows the source tenant, backup ID and SHA-256 hash, and asks you to confirm with **Import locally**. The snapshots are encrypted on this device. Import never changes Intune. See [Backup storage and retention](/backups/storage/). |
| **Folder** | Shows the current backup folder. Default: `Documents/TenuVault Backups`. |
| **Change folder** | Chooses another folder, including a network share. Changing the folder does not move existing backups; move the folder's contents yourself to keep them visible. |
| **Open folder** | Opens the backup folder in Explorer or Finder, creating it if needed. |

After an import, TenuVault shows **Imported &lt;backup&gt;. Select this device as storage for tenant &lt;tenant id&gt; to preview and restore it.** The archive must be smaller than 32 MiB, and your license must cover the source tenant.

### Encryption key

The backup encryption key is protected by your Windows account or macOS Keychain. The same key encrypts backups on this device and backups uploaded to Azure storage.

| Control | What it does |
| --- | --- |
| **Key fingerprint** | Identifies the current key. The recovery key file name includes it. |
| **Save recovery key** | Saves the recovery key to a text file, by default `Documents/TenuVault recovery key <fingerprint>.txt`. The saved bundle includes all previous keys on this device. Required before the first Azure backup. |
| **Import a recovery key** | Opens a field where you paste a recovery key (`TVK2.` bundle, or a legacy `TVK1.` key) and select **Import**. |

After you import a key, the imported key encrypts new backups, and backups made with the previous key stay readable. Save a new bundle after importing keys, so your saved recovery key covers every key on this device.

TenuVault reads the backup inventory of each tenant connected on this device that keeps its backups in the folder, exactly as a backup would. When that inventory holds backups this device cannot read, because another installation made them with a different key or the files are damaged, the card and **All tenants** show **This folder has backups this device cannot read**, with **Import recovery key** and **Choose another folder**. Backups to an affected tenant fail until one of the two is done. See [A folder with backups this device cannot read](/backups/storage/#a-folder-with-backups-this-device-cannot-read).

When local backup files exist or a tenant uses local storage, **Settings** and **Overview** show a recovery key notice if no export is recorded for the current key. Select **Go to Save recovery key** to reach the export action. The notice disappears after you save the key. It does not block local backups. Starting over deletes the backup encryption key from the active app state. Existing local and Azure backups become unreadable unless you exported their recovery key.

:::caution
Without the recovery key, backups can only be read on this computer by this user account. Save it in your password manager and delete the file. See [Encryption and recovery key](/security/encryption/).
:::

### Restore write history

When a restore write to Intune ends without a clear answer (for example a timeout or a dropped connection), TenuVault records it and blocks an identical write until you confirm what happened. This history is where you do that.

| Control | What it does |
| --- | --- |
| **Restore history tenant** | Chooses the tenant whose history is shown. Viewing it needs a current sign-in to that tenant, a license that covers it and Intune management access. |
| **Refresh history** | Reloads the list. If it fails, the previous records stay visible with an error. |

Each entry shows the object name, time, state, tenant and the request (method and path). Request payloads and tokens are not stored. Interrupted writes stay blocked across restarts.

| State | Buttons | Use them when |
| --- | --- | --- |
| `uncertain` | **Confirm applied** | You checked the target tenant in Intune and the change was made. Enter the object ID in the inline form and choose **Save applied ID**; a retry reuses it instead of repeating the write. |
| `uncertain` | **Confirm not applied** | You checked in Intune and the change was not made. The next attempt sends the write again. |
| `reconciled` | **Correct applied ID** | You entered the wrong object ID earlier. Edit the recorded ID in the inline form and choose **Save applied ID**. The next retry reads and verifies the object before any follow-up writes. |
| `reconciled` | **Allow a new operation** | You deliberately want to send the same request again, which may create another object. Do not use it while resuming a repair. |

The object ID must be a GUID. Invalid IDs and failed requests show an error in the form. After a failed save, focus returns to the input. **Cancel** or **Escape** closes the form without saving while no save is in progress. Closing the form returns focus to the record's recovery button or, if the entry is gone, to **Refresh history**, including after a successful save.

Always check the target tenant in Intune before you resolve an entry. See [What cannot be restored and restore write history](/restore/limitations/).

## Background runner

Automatic backups run while TenuVault is running, in the window or in the menu bar on macOS and the tray on Windows.

### Restart TenuVault for scheduled backups

| Control | What it does |
| --- | --- |
| **Install background launch** | Adds a LaunchAgent for your user account on macOS or a scheduled task for your user account on Windows. The background runner can reopen TenuVault in the menu bar or tray within five minutes while you are signed in to the computer. It never brings an open TenuVault window to the front. |
| **Remove background launch** | Removes the background runner. Your backup schedules stay unchanged. |
| **Retry check** | Requests the runner status again after a failed check. Installation stays disabled until a check succeeds. |

The state appears beside the install or remove button:

| State | Meaning |
| --- | --- |
| **Checking...** | TenuVault is checking the background runner status. The install or remove button is disabled. |
| **Installed** | The status check reports that the background runner is installed. This does not confirm that a backup can run. |
| **Not installed** | The status check reports that the background runner is not installed. |
| **Unable to check** | The status request failed. **Could not check background startup. Try again.** stays visible with **Retry check** until a check succeeds. |

While a change is running, the button shows **Installing...** or **Removing...** and is disabled.

The background runner only helps while you are signed in to the computer. It does not run while you are signed out, or while the computer is asleep or off, and it does not wake the computer. Backups still need a valid Microsoft sign-in, plan access and available storage. The button is disabled with **Available in installed Windows and macOS builds.** when TenuVault is not an installed build.

Backups need an awake computer and a signed in session. Locking the screen does not sign you out; closing a laptop lid may put it to sleep.

To stop automatic restarts completely, select **Remove background launch** and turn off start at login before you quit TenuVault. If you move the app, install the background runner again.

### Menu bar and tray options

On macOS, these Settings labels say **menu bar**. On Windows, they say **tray**.

| Option | Default | Effect |
| --- | --- | --- |
| **Start TenuVault in the menu bar/tray when I sign in to this computer** | Off | Starts TenuVault hidden in the menu bar or tray when you sign in. |
| **Keep running in the menu bar/tray when I close the window** | On | Closing the window hides TenuVault instead of quitting, so schedules keep running. The first time, a notification says **TenuVault is still running**. When off, closing the window quits TenuVault on Windows; on macOS, TenuVault keeps running until you quit it. |

The menu bar or tray icon menu has **Open TenuVault**, **Back up all tenants now**, the next scheduled backup (or **No scheduled backups**) and **Quit TenuVault**. When the background runner is installed, a disabled row directly above Quit says **Background restart may reopen TenuVault within five minutes**. Quit stops the current process, but the runner may reopen it.

### Keep backups for

Sets how long backups are kept: **7 days**, **14 days**, **30 days**, **60 days**, **90 days**, **180 days**, **365 days** or **Forever**. Default: **30 days**. The setting applies to every tenant on this computer.

* Older backups are deleted after each successful backup. The newest backup is always kept.
* If a backup is incomplete, no older backups are deleted.
* A backup that is the newest copy of a type that later backups left out is kept.
* Community tenants keep 30 days at most, even if you choose a longer period or **Forever**. Pro and MSP tenants keep what you choose.
* When every connected tenant is on Community, periods longer than 30 days and **Forever** are marked Pro and cannot be chosen. If a longer period was saved earlier, Settings shows the saved choice and the 30 days that take effect on Community.

See [Backup storage and retention](/backups/storage/) and [Schedule backups](/backups/schedules/).

## PDF branding

**PDF branding** puts your company name, logo and colors on every PDF report TenuVault exports: framework comparisons, policy pack assessments, CIS readiness reports and the OpenIntuneBaseline Existing Deployment comparison and Policy Validation reports. A preview of the report cover beside the fields shows the result as you edit.

| Control | What it does |
| --- | --- |
| **Company name** | Required. Replaces TenuVault on the cover and in the running footer, and in the document properties of framework, policy pack and CIS reports. Up to 120 characters. |
| **Upload logo** / **Replace logo** | Adds a PNG or JPEG of up to 1 MB and at most 2048 by 2048 pixels, shown top left on the cover instead of the TenuVault mark. TenuVault checks the file, removes embedded color profiles, text, EXIF and similar data (keeping only basic color and resolution hints), and stores the logo as a PNG scaled to at most 1200 pixels on its longest side. A wide logo on a transparent background works best. Without a logo the cover shows the company name. |
| **Remove logo** | Removes the logo; the cover shows the company name. |
| **Primary color** | The cover band and headings, as `#RRGGBB`. Choose it with the color picker or type it. Headings use a darker shade when the color is too light to read on white. |
| **Accent color** | The accent bar, eyebrows and chart highlights, as `#RRGGBB`. |
| **Prepared by** | Added to **Document control** on the cover. Optional. |
| **Classification** | Added to **Document control** on the cover, for example **Confidential**. Optional. |
| **Footer text** | Replaces the footer on every page. Defaults to the company name. Optional. |
| **Save branding** | Saves the branding on this computer, encrypted with the rest of the app state. New PDF exports use it. |
| **Reset to TenuVault design** | Deletes the saved branding. Reports use the TenuVault design again. Always available, also after a plan ends. |

The OpenIntuneBaseline reports print through the app's built-in Chromium engine, so tenant and policy names in any script, such as Japanese or Cyrillic, print as recorded. Framework, policy pack and CIS reports use a built-in PDF font that prints Western European characters only.

PDF branding needs the Pro or MSP plan. It applies to the reports of tenants on Pro or MSP: TenuVault checks the plan of the report's tenant every time it generates a PDF, so a report of a Community tenant keeps the TenuVault design even when branding is saved. When no tenant on this computer is on Pro or MSP, the section shows a **Pro** badge and the fields are disabled; branding saved under an earlier plan is kept but not applied until a tenant is on Pro or MSP again.

Branded reports are fully white label: they carry no TenuVault name or logo. What stays as published is license and attribution text, such as the Elastic License 2.0 notice of the framework mappings, publisher terms (CC BY 4.0, Open Government Licence, NIST) and the OpenIntuneBaseline GPL-3.0 attribution. Tenant data is always printed exactly as recorded: a policy, group or setting value that contains the word TenuVault keeps it. Report notices that name the tool, such as **Independent TenuVault configuration comparison**, name your company instead, and the OpenIntuneBaseline reports leave out the **Generated by** row.

## Updates

For screenshots and a walkthrough of switching from stable to nightly, see [Try nightly builds from stable](/getting-started/install/#try-nightly-builds-from-stable).

| Control | What it does |
| --- | --- |
| **Download and install updates automatically** | On by default. TenuVault checks 15 seconds after start and every 6 hours, downloads updates in the background and installs them when it restarts. Turning it off prevents installation of a pending update. |
| **Get nightly builds** | Opt into previews between stable releases. Turn it off to return to the current stable release, even if it is older than the installed nightly. |
| **Check now** | Checks immediately. Disabled while automatic updates are off. |
| **Restart and update** | Appears when an update has downloaded. Restarts TenuVault and installs it. |

The status line shows the current state:

| Status | Meaning |
| --- | --- |
| **Checking for updates...** | A check is running. |
| **TenuVault is up to date.** | No newer version on your channel. |
| **Downloading version &lt;version&gt; (&lt;n&gt;%)...** | An update is downloading. |
| **Version &lt;version&gt; is ready to install.** | Select **Restart and update**, or it installs when you next quit. |
| **Could not check for updates: &lt;reason&gt;** | The check failed, for example because GitHub is blocked. TenuVault keeps working. |
| **Automatic updates are off.** | You turned automatic updates off. |
| **Your organization manages updates for TenuVault.** | An administrator turned updates off by policy. The checkbox is locked. See [Deploy TenuVault in your organization](/deploy/#control-automatic-updates). |

Stable installs follow stable by default. Enable **Get nightly builds** to receive previews between stable releases. Turn it off to download the current stable release, even if it is older than your installed nightly. Changing channels replaces a pending update and checks the selected channel immediately. See [Install and update TenuVault](/getting-started/install/#updates).

## About

| Item | Shows |
| --- | --- |
| Version | **TenuVault Desktop &lt;version&gt;** |
| Network summary | Which services TenuVault talks to: Microsoft for sign-in, Graph and Azure; GitHub for the Open Intune Baseline catalog and updates; tenuvault.com for license checks. No tenant configuration or backup is ever sent to TenuVault. |
| **License** | Opens the License page. See [Activate and manage your license](/licensing/manage/). |
| **Website and support** | Opens [tenuvault.com/desktop](https://tenuvault.com/desktop) in your browser. |

## Review scan persistence

Hygiene scan findings and health review finding reconciliation are saved together before returning, reducing repeated encryption and disk writes. A failed batch leaves the previous records intact.
