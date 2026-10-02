---
title: "Disaster recovery"
description: Prepare for and recover from lost Intune configuration, a lost admin device, or a rebuild in another tenant.
---

A backup is only useful if you can restore from it when things go wrong. This page shows how to prepare, and which TenuVault workflow to use for each recovery scenario.

## Prepare before you need it

Work through this checklist for every tenant you protect:

1. **Schedule backups.** Set a daily (Pro and MSP) or weekly schedule so a recent backup always exists. See [Schedule backups](/backups/schedules/).
2. **Save the recovery key.** Go to **Settings** > **Storage and recovery** and click **Save recovery key**. Store the file in your password manager. Without it, your backups can only be read on the device that made them. See [Encryption and recovery key](/security/encryption/).
3. **Keep backups off the admin device.** Use an Azure storage account (Pro and MSP), or point the local backup folder at a network share. The files are encrypted either way. See [Backup storage and retention](/backups/storage/).
4. **Keep an independent copy.** A storage administrator can delete or lock a storage account. Keep a second copy of important backups under your own recovery policy.
5. **Check recovery readiness.** Open a backup in the restore wizard and expand **Recovery readiness** to see which items restore automatically and which need manual work. See [Check recovery readiness](#check-recovery-readiness).
6. **Know who owns external artifacts.** Record where the original app installers and Apple tokens come from, and who can renew them.
7. **Practice a restore.** Restore a few items with **Create copies**. Copies are unassigned by default and never change existing items, so a test is safe.

## Choose the right workflow

| Situation | What to use |
| --- | --- |
| One policy was changed and you want the old settings back | [Drift detection](/drift/) to review and revert it, or **Replace in place** in the restore wizard |
| Items were deleted | **Replace in place**. Deleted items are recreated under their original names. |
| Many items were changed or deleted | **Replace in place** with several items selected (Pro and MSP). Add **Restore assignments** if assignments must come back too. |
| You want to inspect an old version without touching the current one | **Create copies**, unassigned |
| The admin device was lost or reinstalled | [Recover on a new device](#recover-on-a-new-device) |
| Configuration must be rebuilt in another tenant | [Restore to another tenant](/restore/cross-tenant/) (MSP) |

## Recover lost or changed configuration

1. **Take a backup of the current state first.** A restore overwrites current versions. If you might need them, run a backup before you continue. The restore confirmation reminds you of this.
2. Go to **Backup & Restore** > **Backup History** and pick the last backup from before the problem. Use **View Changes** in **Backup Details** to see what changed between backups.
3. Click **Restore from this backup**.
4. Select the affected items. On **How to restore**, choose **Replace in place**.
5. Decide on **Restore assignments**. With it on, each item's assignments are replaced with the ones in the backup. Restore Windows Autopilot profiles, Apple user enrollment profiles, terms and conditions and Intune roles in a separate selection with assignments off. See [Restore modes and assignments](/restore/modes/).
6. On **Review**, check the labels. Items that already match are skipped, deleted items show **Recreate: deleted from the tenant**, and changed items show **Overwrite the current version**.
7. Tick the confirmation, click **Restore N items**, and check each result.
8. Resolve any **Incomplete object** or unknown outcomes as described in [What cannot be restored and restore write history](/restore/limitations/).
9. Complete the items that cannot be restored automatically. See [Handle external artifacts](#handle-external-artifacts).

TenuVault restores dependencies such as scope tags, assignment filters and categories before the items that use them, and policy sets last. Recreated items get new IDs, and later items in the same restore are pointed to them. Restore dependencies and the items that use them in the same selection.

## Recover on a new device

Backups are encrypted with a key that is protected by your Windows or macOS account. A new or reinstalled device has a different key, so it needs your recovery key to read existing backups.

1. Install TenuVault and sign in to the tenant with the same app registration. See [Install and update TenuVault](/getting-started/install/) and [Sign in to your tenant](/getting-started/connect-tenant/).
2. Activate your license. If the old device is gone and your license has reached its installation limit, deactivate the old installation in the customer portal. See [Activate and manage your license](/licensing/manage/).
3. Go to **Settings** > **Storage and recovery**, click **Import a recovery key**, paste the key (it starts with `TVK2.`, or `TVK1` for older keys) and click **Import**. The imported key encrypts new backups, and backups made with earlier keys stay readable.
4. Point the tenant at the existing backups:
   * **Azure storage:** choose the same storage account for the tenant in **Settings** > **Sign-in** > **Change storage**.
   * **This device:** click **Change folder** under **Backups on this device** and choose the folder that holds the backups, for example the network share or a restored copy.
5. Open **Backup & Restore**. The backups appear in **Backup History** and can be restored.

:::note
After you import a key, click **Save recovery key** again. The saved bundle includes all keys on the device, so one file opens every backup.
:::

### Restore from a ZIP export

If you only have a ZIP export of a backup (from **Download** in **Backup Details**), you can import it on any device:

1. Go to **Settings** > **Storage and recovery** > **Backups on this device** and click **Import backup ZIP**.
2. Choose the ZIP file. It must be smaller than 32 MiB, contain a complete backup and include its `tenuvault-manifest.json`.
3. Review the dialog. It shows the source tenant, the backup ID and a SHA-256 digest of the archive, then asks "Import *N* policy snapshots?" Click **Import locally**.
4. Choose **This device** as backup storage for the source tenant. The import message tells you which tenant: "Select this device as storage for tenant *ID* to preview and restore it."
5. Restore from the imported backup as usual.

Importing never changes Intune. The source tenant must be licensed on the device. The archive declares its source but is not signed, so only import files from a source you trust.

:::caution
ZIP exports are not encrypted and can contain secrets such as OMA-URI values. Protect them like the configuration they hold.
:::

## Rebuild in another tenant

With MSP you can copy items from a backup of one connected tenant into another connected tenant. Copies keep their original names, get the Default scope tag and are never assigned. See [Restore to another tenant](/restore/cross-tenant/) for the full procedure, including dependency mappings for apps and app categories.

After the copy:

* Recreate groups, exclusions and filters in the target tenant, then assign the copies and validate targeting.
* Review Intune roles and their memberships carefully, so the recovery does not reinstate access you revoked.

## Check recovery readiness

On **Choose what to restore**, expand **Recovery readiness for N objects**. For every object in the backup it reports:

| Field | Meaning |
| --- | --- |
| **Automatic configuration restore available** | TenuVault can recreate the configuration without manual work. |
| **Review required** | At least one of the fields below needs attention. |
| **External artifacts** | Something only its owner can supply, such as an installer, signing material or a service token. |
| **Missing mappings** | References to other tenant objects that need a target in another tenant. |
| **Manual actions** | Steps you complete yourself, for example recreating group targeting for a cross-tenant copy, or reviewing role memberships. |

"Readiness unavailable. Retry loading the backup." means TenuVault could not assess the object. A missing assessment is not a pass. The report assumes the harder cross-tenant case, so some items flagged for review restore without extra work in their own tenant. No tenant changes happen while you review it.

## Handle external artifacts

Backup metadata cannot recreate private keys, installer payloads or Apple credentials that the Microsoft Graph API does not export.

* **Apps with installers:** get the original installer from a trusted source, verify its publisher, and upload it through Intune's app workflow. For a copy into another tenant, then map the new app with a reviewed dependency mapping.
* **Apple automated device enrollment:** renew or upload the enrollment token through Apple Business Manager or Apple School Manager and Intune. Use the backed-up enrollment profiles as a reference.
* **Masked secrets:** a profile whose backup holds a masked OMA-URI value (`****`) needs a new backup before it can be restored.

The full list is in [What cannot be restored](/restore/limitations/).

## Related pages

* [Restore items](/restore/)
* [Restore modes and assignments](/restore/modes/)
* [Encryption and recovery key](/security/encryption/)
* [Troubleshooting](/troubleshooting/)
