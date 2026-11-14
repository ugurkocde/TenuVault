---
title: "Choose where backups are stored"
description: Keep Intune backups encrypted on this device or in your own Azure storage account, and know when you need the recovery key.
---

On the **Storage** step, **Choose where backups are stored**, you choose where this tenant's backups go. On this device, TenuVault encrypts every backup with AES-256-GCM. In your Azure storage account, Azure encrypts the backups at rest and your Azure role assignments decide who can read them. Neither option sends anything to TenuVault.

You can change the location later in **Settings** > **Sign-in** > **Change storage**.

## The tenant's plan

Above the storage options, the step shows **Signed in as &lt;your account&gt;** and the plan the tenant got at sign-in:

* **This tenant uses Community, the free plan**: manual and weekly backups on this device, kept for 30 days. Next to it are **I have a license key** and, while the tenant can still start its trial, **Try Pro free** (no card, no email). When tenant trials are unavailable, the trial link is **Try Pro free for 30 days, no card** instead and opens the email trial form, filled in with your sign-in name when it is an email address. See [Start TenuVault for the first time](/getting-started/first-launch/#start-a-trial).
* **This tenant uses Pro** or **MSP**, from your license key, **This tenant uses your Pro trial**, or **This tenant uses Pro, through the license your organization shares with it.**

You can change the plan later on the **License** page.

## Compare the options

| | **This device, encrypted** | **Your Azure storage account** |
| --- | --- | --- |
| Plan | All plans | Pro and MSP |
| Where backups live | A folder on this computer or a network share, by default `Documents/TenuVault Backups` | The `intune-backups` container in a storage account in your Azure subscription |
| Azure resources needed | None | An existing storage account |
| Extra roles | None | **Storage Blob Data Contributor** on the storage account, plus read access to the storage account (for example **Reader**) so it appears in the list |
| Protection | AES-256-GCM by TenuVault, with a key protected by your Windows account or macOS Keychain | Azure Storage encryption at rest, and your Azure role assignments |
| Other computers can read the backups | With the recovery key and a copy of the folder | Every admin with access to the storage account, no key needed |
| Before the first backup | Saving the recovery key is strongly recommended | Nothing else |

<figure class="docs-screenshot">
  <a href="/images/screenshots/setup-storage.webp" aria-label="Open full-size screenshot: setup storage">
    <img src="/images/screenshots/setup-storage.webp" alt="The Storage step lets you choose this device or your Azure storage account" width="2880" height="2000" loading="lazy" decoding="async" />
  </a>
  <figcaption>The Storage step lets you choose this device or your Azure storage account. This example uses local storage. Select the image to view it full size.</figcaption>
</figure>

## Option 1: This device, encrypted

1. Select **This device, encrypted**. It is selected by default.
2. TenuVault shows the backup folder under the option.
3. Select **Continue**.

TenuVault also reads this tenant's backup inventory in the folder, exactly as a backup would. If the folder already holds this tenant's backups from another installation, or damaged backup files, TenuVault shows **This folder has backups this device cannot read**. You can still select **Continue**, but the first backup fails until you fix it. Select **Import recovery key** and paste the recovery key of that installation, or select **Choose another folder** to start with an empty folder. See [A folder with backups this device cannot read](/backups/storage/#a-folder-with-backups-this-device-cannot-read).

Backups are encrypted with a key protected by your Windows account or macOS Keychain. Nothing leaves this computer. Each backup file is encrypted on its own, and file names reveal nothing about your policies.

To use a different folder, such as a network share, change it in **Settings** > **Storage and recovery** > **Change folder**. See [Backup storage and retention](/backups/storage/).

## Option 2: Your Azure storage account

:::note
On Community, this option is locked and marked **Pro**, with the note **Backups in your own Azure storage account: included in TenuVault Pro and MSP. Upgrade on the License page.** Select **See plans** to compare plans.
:::

You need an existing storage account in a subscription of the tenant you signed in to. TenuVault does not create Azure resources. If none exists yet, ask your Azure administrator to create one with [Create a storage account for TenuVault](/getting-started/create-storage-account/): the page has a script that creates the account and grants your admin group access in one run.

1. Select **Your Azure storage account**. TenuVault shows **Loading your storage accounts...** while it lists the storage accounts your account can see across your subscriptions.
2. In **Storage account**, choose the account. Each entry shows its name, resource group and region. If the account was created while this step is open, select **Refresh** to list the accounts again.
3. Select **Check access**. TenuVault creates the `intune-backups` container if it does not exist, then writes and deletes a small test file to confirm you can store backups there.
4. When the button shows **Access confirmed**, select **Continue**.

Azure encrypts the backups at rest, and access follows your Azure role assignments: every admin with access to the account sees the same backups. Anyone who can write to the `intune-backups` container is trusted like an Intune admin, so grant the blob data roles only to your admin group. See [Backups in Azure](/security/encryption/#backups-in-azure) and [Work with other admins in one tenant](/getting-started/multiple-admins/).

If the storage account already holds backups from TenuVault on another computer, you see them as soon as the tenant is set up. Backups that an earlier TenuVault version encrypted need the recovery key of the device that made them; **Backup & Restore** offers **Import recovery key** for them, and **Continue** is never held back by them. See [Older encrypted Azure backups](/security/encryption/#older-encrypted-azure-backups).

While **Continue** is unavailable, a hint next to it says what is missing, in the order you fix it:

| Hint | What to do |
| --- | --- |
| **Azure storage needs Pro or MSP. Choose This device to continue on Community.** | Start the trial or enter a key, or choose **This device, encrypted**. |
| **To continue, ask an Azure administrator for a storage account, or choose This device.** | No storage account is listed. See below. |
| **To continue, choose a storage account.** | Choose one in **Storage account**. |
| **To continue, select Check access.** | Select **Check access**. |

If no storage account is listed, **No storage account yet?** offers **Copy setup instructions for your Azure administrator** (the guide link plus the script from [Create a storage account for TenuVault](/getting-started/create-storage-account/)) and **Storage setup guide**. After the account exists, select **Refresh**.

### Storage errors

| Message | What it means |
| --- | --- |
| **No storage accounts found that your account can see. Ask an Azure administrator to create one and grant you access.** | Your account cannot read any storage account in Azure. Send your Azure administrator [Create a storage account for TenuVault](/getting-started/create-storage-account/): its script creates the account and grants your admin group **Reader** and **Storage Blob Data Contributor**. |
| **You do not have write access to storage account &lt;name&gt;. Ask an Azure administrator for the "Storage Blob Data Contributor" role on it. New role assignments can take a few minutes to apply.** | Assign **Storage Blob Data Contributor** on the storage account to your account, wait a few minutes, then select **Check access** again. |
| **Storage account &lt;name&gt; rejected the request from this network. Allow this computer's public IP address in the storage account's networking settings, or connect through a network it allows.** | The storage account firewall blocks this computer. This is a network rule, not a missing role. |
| **Storage account &lt;name&gt; could not be reached.** | Check your network, proxy and access to `<name>.blob.core.windows.net`. |

## Save your recovery key

TenuVault keeps one backup encryption key per computer, protected by your Windows account or macOS Keychain. The recovery key is an exported copy of it. You need it to read backups on this device from another computer, after reinstalling, or after a new Windows or macOS profile. Azure backups do not need it, except older Azure backups that an earlier TenuVault version encrypted.

After the first backup to this device, setup offers **Save recovery key** among the next steps. At any time, or after importing a key, use **Settings**:

1. Open **Settings** > **Storage and recovery**.
2. Under **Encryption key**, select **Save recovery key**.
3. Choose where to save the file. By default it is `Documents/TenuVault recovery key <fingerprint>.txt`.
4. Move the key into your password manager or another safe place, then delete the file.

Anyone with the recovery key and your backup files on this device can read your Intune configuration. Store it like a password. For how the key works, see [Encryption and recovery key](/security/encryption/).

## Continue

When you select **Continue**, the button shows **Checking the license...** while TenuVault checks the license for the tenant once more. It then saves the tenant and setup moves to **First backup**.

If the license no longer covers the tenant, the tenant is not saved and TenuVault signs you out of it. Setup returns to **Sign in** with the tenant ID and client ID kept, explains why, and offers **Try Pro free for 30 days, no card** and **I have a license key**. Sign in again once the license covers the tenant. See [License check at sign-in](/getting-started/connect-tenant/#license-check-at-sign-in).

## Next step

[Run your first backup](/getting-started/first-backup/).
