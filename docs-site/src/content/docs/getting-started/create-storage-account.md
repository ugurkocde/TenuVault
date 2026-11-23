---
title: "Create a storage account for TenuVault"
description: Create the Azure storage account TenuVault stores Intune backups in, with a script or in the Azure portal, and grant your Intune admins access.
---

TenuVault stores Azure backups in a storage account in your own subscription and never creates Azure resources itself. This page is for the Azure administrator who creates that account, for example when an Intune administrator asks for one. If a suitable storage account already exists, only the role assignments below are needed.

## The fastest way: run the setup script

[Download `New-TenuVaultStorage.ps1`](/downloads/New-TenuVaultStorage.ps1) and run it in PowerShell 7 or Windows PowerShell 5.1. If someone else creates the storage account for you, send them this link or the file.

You need:

* An account that can create storage accounts and assign roles, for example **Owner**, or **Contributor** plus **User Access Administrator**, on the resource group. To provision into an existing resource group, pass its name with `-ResourceGroupName`. Creating a new resource group (the default creates `rg-tenuvault-backups` when it is missing) additionally needs permission to create resource groups in the subscription, which **Contributor** at subscription scope includes.
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

The script creates `audit-logs` and also creates `intune-backups` when you pass `-Immutable` or `-BackupReaderAppId`. Otherwise, TenuVault creates the backup container on first use. [What is stored in the storage account](/backups/storage/#what-is-stored-in-the-storage-account)

## Immutable storage

Azure backups on Pro and MSP can use a time-based Azure policy to protect backup versions from deletion, including after a compromised account or an accidental cleanup. Enable it before the first backup. Use Az.Storage 3.12.0 or later and a StorageV2 account with hierarchical namespace, NFS and SFTP disabled.

```powershell
./New-TenuVaultStorage.ps1 -AdminGroupId 00000000-0000-0000-0000-000000000000 -Location westeurope -Immutable -ImmutableDays 90
```

The script turns on blob versioning and configures a default version-level policy on `intune-backups`. `-ImmutableDays` defaults to 30 and accepts 1 to 146,000 days. Set it to at least your planned TenuVault retention period, or choose a finite protection window if TenuVault is set to **Forever**. The policy applies to new versions. For a container that already exists without version-level immutability, use a new storage account or wait for the container's Azure migration to complete before running the script. Rerunning the script preserves any existing policy that meets the requested period. [Microsoft's guidance on version-level policies and migration](https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-policy-configure-version-scope)

The policy starts unlocked so you can verify backups and restores. After testing, go to **Storage account** > **Containers** > **intune-backups** > **Access policy**. Under **Immutable blob versions**, open the policy menu, select **Lock policy**, and confirm. Locking is permanent. A locked policy can be extended, and nobody can delete a protected blob version before its expiry. Check the policy and expiry on any versions you must retain, especially those written before setup. [Microsoft's guidance on locking a policy](https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-policy-configure-version-scope#lock-a-time-based-retention-policy)

Azure bills for stored versions. TenuVault keeps an entire backup while any of its current blobs is protected. After expiry, normal TenuVault retention can remove the current blobs. The script adds a lifecycle rule for previous backup versions, which become eligible for cleanup once their age exceeds the immutable policy period. With the Backup Reader, the script also considers `-VersionRetentionDays` and reports when it raises that setting to match the policy. [Immutable storage and retention](/backups/storage/#immutable-storage)

## Optional: let the Backup Reader write backups

This section is only for tenants that use the optional [Backup Reader](/backups/backup-reader/) (Pro and MSP): a separate, read-only app registration that keeps scheduled backups running when Conditional Access sign-in frequency ends the admin's session. The Intune administrator will ask you for this after an Entra administrator has created the reader, and will give you its **application (client) ID**. Run the Backup Reader setup first; without the app registration there is nothing to assign the role to, and the script stops with that message.

You need **Owner**, or **Contributor** plus **User Access Administrator**, on the storage account's resource group, the same roles as for the rest of the script. User Access Administrator alone is not enough: it covers creating the custom role definition and assigning it, but creating the container, turning on versioning and setting the lifecycle rule are storage management operations that need Contributor (or Owner, which includes both). If you use PIM, activate the roles before you run the script.

```powershell
./New-TenuVaultStorage.ps1 -AdminGroupId 00000000-0000-0000-0000-000000000000 -SubscriptionId <subscription ID> -ResourceGroupName <resource group> -StorageAccountName <storage account> -BackupReaderAppId <application ID from the Intune administrator>
```

With `-BackupReaderAppId`, the script additionally:

* Creates the `intune-backups` container (the reader itself cannot create containers).
* Creates the custom role **TenuVault Backup Writer** (read and write blobs, no delete, no container management) and assigns it to the Backup Reader on that container only. The assignment is direct and permanent: the reader runs at night with nobody there to activate an eligible assignment.
* Turns on blob versioning, so a blob the reader overwrites keeps its previous version, and adds a lifecycle rule for previous backup versions. The default is 30 days (`-VersionRetentionDays`). With `-Immutable`, the rule uses the longer of that setting and the immutable policy period. This previous-version rule is the exception to [Settings that conflict with TenuVault](#settings-that-conflict-with-tenuvault). Keep Azure lifecycle rules off current backups.
* Warns, but does not remove, broader roles the reader may already have on the storage account. A broader role such as Storage Blob Data Contributor would let it delete backups, which defeats the design. Remove such assignments for the reader yourself.

Check afterwards in the portal: the container exists, its **Access Control (IAM)** shows only **TenuVault Backup Writer** for the Backup Reader, **Data protection** shows versioning on, and **Networking** allows the network the TenuVault computers use (the reader connects from the same computers). New role assignments can take a few minutes to apply.

Then tell the Intune administrator you are done. They select **Verify** in TenuVault, which checks the container and the reader's access. Because the reader cannot delete, TenuVault retention for Azure backups runs on the next backup an admin makes with their own sign-in; see [Retention](/backups/storage/#retention). To undo this later, remove the **TenuVault Backup Writer** assignment (and the custom role definition, if you want) and tell the Intune administrator, who removes the reader in TenuVault.

## Create the storage account manually

If you cannot run PowerShell, create the same account in the [Azure portal](https://portal.azure.com).

### 1. Create the account

1. Go to **Storage accounts** > **Create**.
2. Choose the subscription, a resource group (a dedicated one such as `rg-tenuvault-backups`) and the region your backup data must stay in.
3. Enter a storage account name. **Performance:** Standard. **Redundancy:** locally redundant storage, or geo-redundant storage when these backups are the only copy.
4. On **Advanced**: **Require secure transfer** on, **Minimum TLS version** 1.2, **Allow storage account key access** off, **Allow Blob anonymous access** off, **Default access tier** Hot. Leave hierarchical namespace off.
5. On **Data protection**, turn on soft delete for blobs and for containers, 7 days each. For immutable backups, turn on blob versioning, then enable version-level immutability when creating the backup container and configure its default policy. [Microsoft's setup steps](https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-policy-configure-version-scope)
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

* **Lifecycle management rules** that move backup blobs to Cool, Cold or Archive, or that delete them, fight with TenuVault retention and can remove files a backup still lists. Let TenuVault decide what to delete.
* A **CannotDelete** resource lock is compatible and recommended: it blocks deleting the storage account itself, while blob writes and deletes continue normally.
* Backups are stored as plain JSON policies, protected by Azure encryption at rest and these role assignments, and audit log events are plain JSON too. Everyone who can read the containers can read the backups, including the plain-text values of secret OMA-URI settings, and everyone who can write to `intune-backups` is trusted like an Intune admin, because a restore writes what it finds there. Keep the roles above limited to the admin group. See [Backups in Azure](/security/encryption/#backups-in-azure).

## After the account exists

1. Tell the Intune administrators the storage account name.
2. Each administrator chooses **Your Azure storage account** during tenant setup or in **Settings** > **Sign-in** > **Change storage**, picks the account and selects **Check access**. See [Choose where backups are stored](/getting-started/choose-storage/).
3. Every administrator in the group then sees, compares and restores the same backups. No recovery key is handed over. See [Work with other admins in one tenant](/getting-started/multiple-admins/).
