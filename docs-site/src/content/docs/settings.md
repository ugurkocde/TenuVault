---
title: "Settings reference"
description: Every control on the Settings page, what it does and when to use it.
---

**Settings** holds sign-in, backup storage, encryption, background backups and updates for this computer. Open it from the bottom of the sidebar.

The buttons at the top of the page jump to each section: **Sign-in**, **Storage and recovery**, **Background and retention**, **Updates** and **About**.

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

:::caution
Without the recovery key, backups can only be read on this computer by this user account. Save it in your password manager and delete the file. See [Encryption and recovery key](/security/encryption/).
:::

### Restore write history

When a restore write to Intune ends without a clear answer (for example a timeout or a dropped connection), TenuVault records it and blocks an identical write until you confirm what happened. This history is where you do that.

| Control | What it does |
| --- | --- |
| **Restore history tenant** | Chooses the tenant whose history is shown. Viewing it needs a current sign-in to that tenant, a license that covers it and Intune management access. |
| **Refresh history** | Reloads the list. |

Each entry shows the object name, time, state, tenant and the request (method and path). Request payloads and tokens are not stored. Interrupted writes stay blocked across restarts.

| State | Buttons | Use them when |
| --- | --- | --- |
| `uncertain` | **Confirm applied** | You checked the target tenant in Intune and the change was made. Enter the object ID; a retry reuses it instead of repeating the write. |
| `uncertain` | **Confirm not applied** | You checked in Intune and the change was not made. The next attempt sends the write again. |
| `reconciled` | **Correct applied ID** | You entered the wrong object ID earlier. The next retry reads and verifies the object before any follow-up writes. |
| `reconciled` | **Allow a new operation** | You deliberately want to send the same request again, which may create another object. Do not use it while resuming a repair. |

Always check the target tenant in Intune before you resolve an entry. See [What cannot be restored and restore write history](/restore/limitations/).

## Background and retention

Automatic backups run while TenuVault is running, in the window or in the system tray (the menu bar on macOS).

### Restart TenuVault for scheduled backups

| Control | What it does |
| --- | --- |
| **Install background launch** | Registers an operating system task that reopens TenuVault in the tray within five minutes while you are signed in to the computer. On Windows this is a Task Scheduler task for your user account; on macOS a LaunchAgent. |
| **Remove background launch** | Removes that task. Your backup schedules stay unchanged. |

Background launch only helps while you are signed in to the computer. It does not run while you are signed out, or while the computer is asleep or off, and it does not wake the computer. Backups still need a valid Microsoft sign-in, plan access and available storage. The button is disabled with **Available in installed Windows and macOS builds.** when TenuVault is not an installed build.

To stop automatic restarts completely, remove background launch and turn off start at login before you quit TenuVault. If you move the app, install background launch again.

### Tray options

| Option | Default | Effect |
| --- | --- | --- |
| **Start TenuVault in the tray when I sign in to this computer** | Off | Starts TenuVault hidden in the tray when you sign in to Windows or macOS. |
| **Keep running in the tray when I close the window** | On | Closing the window hides TenuVault instead of quitting, so schedules keep running. The first time, a notification says **TenuVault is still running**. When off, closing the window quits TenuVault on Windows; on macOS, TenuVault keeps running until you quit it. |

The tray icon menu has **Open TenuVault**, **Back up all tenants now**, the next scheduled backup (or **No scheduled backups**) and **Quit TenuVault**.

### Keep backups for

Sets how long backups are kept: **7 days**, **14 days**, **30 days**, **60 days**, **90 days**, **180 days**, **365 days** or **Forever**. Default: **30 days**. The setting applies to every tenant on this computer.

* Older backups are deleted after each successful backup. The newest backup is always kept.
* If a backup is incomplete, no older backups are deleted.
* A backup that is the newest copy of a type that later backups left out is kept.
* Community tenants keep 30 days at most, even if you choose a longer period or **Forever**. Pro and MSP tenants keep what you choose.

See [Backup storage and retention](/backups/storage/) and [Schedule backups](/backups/schedules/).

## Updates

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
