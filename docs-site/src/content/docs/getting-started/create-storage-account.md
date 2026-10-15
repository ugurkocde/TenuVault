---
title: "Create a storage account for TenuVault"
description: Create the Azure storage account TenuVault stores encrypted backups in, with a script or in the Azure portal, and grant your Intune admins access.
---

TenuVault stores Azure backups in a storage account in your own subscription and never creates Azure resources itself. This page is for the Azure administrator who creates that account, for example when an Intune administrator asks for one. If a suitable storage account already exists, only the role assignments below are needed.

## The fastest way: run the setup script

[Download `New-TenuVaultStorage.ps1`](/downloads/New-TenuVaultStorage.ps1) and run it in PowerShell 7 or Windows PowerShell 5.1. If someone else creates the storage account for you, send them this link or the file.

You need:

* An account that can create storage accounts and assign roles, for example **Owner**, or **Contributor** plus **User Access Administrator**, on the resource group.
* The object ID of the security group whose members administer Intune with TenuVault.
* The Az modules `Az.Accounts`, `Az.Resources` and `Az.Storage`. If they are missing, the script installs them for the current user.

```powershell
./New-TenuVaultStorage.ps1 -AdminGroupId 00000000-0000-0000-0000-000000000000 -Location westeurope
```

To keep a second copy in a paired region and to restrict the storage firewall to your office address:

```powershell
./New-TenuVaultStorage.ps1 -AdminGroupId 00000000-0000-0000-0000-000000000000 -Location westeurope -Sku Standard_GRS -AllowIpAddresses 203.0.113.10
```

The script prints the storage account name when it finishes. Running it again with the same parameters changes nothing that already matches.

## What the script creates

| Setting | Value | Why |
| --- | --- | --- |
| Resource group | `rg-tenuvault-backups` (change with `-ResourceGroupName`), created when missing | Keeps backup storage separate from other Azure resources |
| Account kind and tier | StorageV2, Hot | The blob API and frequent small writes during backup and retention |
| Redundancy | Locally redundant (change with `-Sku`) | Geo-redundant storage when these backups are the only copy |
| Transport | HTTPS only, TLS 1.2 minimum | Protects the connection |
| Public blob access | Off | Backup blobs are never anonymous |
| Shared key authorization | Off | TenuVault signs in with Microsoft Entra tokens; account keys would bypass that |
| Soft delete | 7 days for blobs and containers | Undo window for accidental deletion, separate from TenuVault retention |
| Roles for the admin group | **Reader** and **Storage Blob Data Contributor** on the storage account | Reader makes the account appear in the TenuVault storage picker; Storage Blob Data Contributor reads and writes the backup files |

TenuVault itself creates the `intune-backups` and `audit-logs` containers on first use. For what they hold, see [What is stored in the storage account](/backups/storage/#what-is-stored-in-the-storage-account).

## Create the storage account manually

If you cannot run PowerShell, create the same account in the [Azure portal](https://portal.azure.com).

### 1. Create the account

1. Go to **Storage accounts** > **Create**.
2. Choose the subscription, a resource group (a dedicated one such as `rg-tenuvault-backups`) and the region your backup data must stay in.
3. Enter a storage account name. **Performance:** Standard. **Redundancy:** locally redundant storage, or geo-redundant storage when these backups are the only copy.
4. On **Advanced**: **Require secure transfer** on, **Minimum TLS version** 1.2, **Allow storage account key access** off, **Allow Blob anonymous access** off, **Default access tier** Hot. Leave hierarchical namespace off.
5. On **Data protection**: turn on soft delete for blobs and for containers, 7 days each. Leave version-level immutability support off; see [Settings that conflict with TenuVault](#settings-that-conflict-with-tenuvault).
6. Review and create the account.

### 2. Grant access to your Intune admins

Assign the roles to the security group of your Intune administrators, not to individual accounts, so new admins only need group membership:

1. Open the storage account and go to **Access Control (IAM)** > **Add role assignment**.
2. Assign **Storage Blob Data Contributor** to the group.
3. Assign **Reader** to the same group, so the account appears in the TenuVault storage picker.

:::caution
Assign the roles as permanently active. A PIM eligible assignment that nobody has activated makes scheduled backups fail outside office hours. New assignments can take a few minutes to apply.
:::

### 3. Check the network rules

If the account already restricts networks under **Networking**, the computers that run TenuVault must be allowed through. The script's `-AllowIpAddresses` does this for you; in the portal, add each computer's public IP address under **Firewall**, or run TenuVault from an allowed network. A blocked computer sees "rejected the request from this network" in TenuVault, which is a network rule and not a missing role.

## Cost and redundancy

Backups are Intune configuration as JSON files, so most tenants store a modest amount of data and pay mainly for the retained backup size and the write transactions of each run. Locally redundant Hot storage is the low cost default. Choose geo-redundant storage when the storage account holds the only copy of your backups. TenuVault retention deletes older backups automatically, and you choose the period in Settings; see [Retention](/backups/storage/#retention).

## Settings that conflict with TenuVault

* **Immutability policies and legal holds** on the `intune-backups` container block the deletes that retention performs. Older backups then stay in place and TenuVault reports that old backups could not be removed.
* **Lifecycle management rules** that move backup blobs to Cool, Cold or Archive, or that delete them, fight with TenuVault retention and can remove files a backup still lists. Let TenuVault decide what to delete.
* A **CannotDelete** resource lock is compatible and recommended: it blocks deleting the storage account itself, while blob writes and deletes continue normally.
* Blob names are not encrypted and include each object's display name, and audit log events are plain JSON. Everyone who can list the containers can see them, so keep the roles above limited to the admin group. Backup file contents are encrypted before upload.

## After the account exists

1. Tell the Intune administrators the storage account name.
2. Each administrator chooses **Your Azure storage account, encrypted** during tenant setup or in **Settings** > **Sign-in** > **Change storage**, picks the account and selects **Check access**. See [Choose where backups are stored](/getting-started/choose-storage/).
3. Each administrator saves their recovery key in **Settings** before the first Azure backup; TenuVault refuses the upload until they have. See [Save your recovery key](/getting-started/choose-storage/#save-your-recovery-key).
