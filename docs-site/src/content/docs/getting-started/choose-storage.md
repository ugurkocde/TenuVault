---
title: "Choose where backups are stored"
description: Keep backups encrypted on this device or in your own Azure storage account, and save your recovery key.
---

On the **Storage** step you choose where this tenant's backups go. Both options encrypt every backup with AES-256-GCM before it is written, and neither sends anything to TenuVault.

You can change the location later in **Settings** > **Sign-in** > **Change storage**.

## Compare the options

| | **This device, encrypted** | **Your Azure storage account, encrypted** |
| --- | --- | --- |
| Plan | All plans | Pro and MSP |
| Where backups live | A folder on this computer or a network share, by default `Documents/TenuVault Backups` | The `intune-backups` container in a storage account in your Azure subscription |
| Azure resources needed | None | An existing storage account |
| Extra roles | None | **Storage Blob Data Contributor** on the storage account, plus read access to the storage account (for example **Reader**) so it appears in the list |
| Other computers can read the backups | With the recovery key and a copy of the folder | With the recovery key and access to the storage account |
| Before the first backup | Saving the recovery key is strongly recommended | Saving the recovery key is required |

## Option 1: This device, encrypted

1. Select **This device, encrypted**. It is selected by default.
2. TenuVault shows the backup folder under the option.
3. Select **Continue**.

Backups are encrypted with a key protected by your Windows account or macOS Keychain. Nothing leaves this computer. Each backup file is encrypted on its own, and file names reveal nothing about your policies.

To use a different folder, such as a network share, change it in **Settings** > **Storage and recovery** > **Change folder**. See [Backup storage and retention](/backups/storage/).

## Option 2: Your Azure storage account, encrypted

:::note
On Community, this option is locked and marked **Pro**, with the note **Backups in your own Azure storage account: included in TenuVault Pro and MSP. Upgrade on the License page.** Select **See plans** to compare plans.
:::

You need an existing storage account in a subscription of the tenant you signed in to. TenuVault does not create Azure resources.

1. Select **Your Azure storage account, encrypted**. TenuVault shows **Loading your storage accounts...** while it lists the storage accounts your account can see across your subscriptions.
2. In **Storage account**, choose the account. Each entry shows its name, resource group and region.
3. Select **Check access**. TenuVault creates the `intune-backups` container if it does not exist, then writes and deletes a small test file to confirm you can store backups there.
4. When the button shows **Access confirmed**, select **Continue**.

### Storage errors

| Message | What it means |
| --- | --- |
| **No storage accounts found that your account can see. Ask an Azure administrator to create one and grant you access.** | Your account cannot read any storage account in Azure. Ask for a storage account and a role that can read it, such as **Reader**. |
| **You do not have write access to storage account &lt;name&gt;. Ask an Azure administrator for the "Storage Blob Data Contributor" role on it. New role assignments can take a few minutes to apply.** | Assign **Storage Blob Data Contributor** on the storage account to your account, wait a few minutes, then select **Check access** again. |
| **Storage account &lt;name&gt; rejected the request from this network. Allow this computer's public IP address in the storage account's networking settings, or connect through a network it allows.** | The storage account firewall blocks this computer. This is a network rule, not a missing role. |
| **Storage account &lt;name&gt; could not be reached.** | Check your network, proxy and access to `<name>.blob.core.windows.net`. |

## Save your recovery key

TenuVault keeps one backup encryption key per computer, protected by your Windows account or macOS Keychain. The recovery key is an exported copy of it. You need it to read your backups on another computer, after reinstalling, or after a new Windows or macOS profile.

:::caution
For Azure storage, TenuVault blocks uploads until you have saved the current recovery key. If you skip this, the first backup fails with **Save your current backup recovery key in Settings before the first encrypted Azure backup.**
:::

1. Open **Settings** > **Storage and recovery**. You can do this during setup; TenuVault remembers your setup step.
2. Under **Encryption key**, select **Save recovery key**.
3. Choose where to save the file. By default it is `Documents/TenuVault recovery key <fingerprint>.txt`.
4. Move the key into your password manager or another safe place, then delete the file.

Anyone with the recovery key and your backup files can read your Intune configuration. Store it like a password. For how the key works, see [Encryption and recovery key](/security/encryption/).

## Continue

When you select **Continue**, TenuVault checks the license for the tenant once more and saves it. Setup moves to **First backup**.

## Next step

[Run your first backup](/getting-started/first-backup/).
