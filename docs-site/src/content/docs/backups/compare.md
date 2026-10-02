---
title: "Compare backups"
description: See what was added, changed and deleted in Intune between one backup and the one before it.
---

Every backup records a fingerprint of each item it saved. TenuVault compares these fingerprints with the previous backup, so you can see what was added, changed and deleted in the tenant between two backups, down to the individual setting.

TenuVault offers two views of changes:

| | Changes in a backup | Drift detection |
| --- | --- | --- |
| Where | **Backup & Restore**, **Backup History** tab | **Drift Detection** page |
| Compares | Any backup with the backup before it | The two newest complete backups |
| Shows | Added, changed and deleted items, with the changed settings | The same changes, with impact, severity, export and one-click actions |
| Use it to | Review the history of the tenant | Act on recent changes. See [Drift detection](/drift/). |

This page covers the first view.

## See the number of changes

Open **Backup & Restore** and stay on the **Backup History** tab. In the **Backup Timeline**, the **Changes** column of each backup shows:

| Value | Meaning |
| --- | --- |
| **+N** (green) | N items added since the previous backup |
| **~N** (amber) | N items changed |
| **-N** (red) | N items deleted |
| **None** | Nothing changed |
| **First backup** | There is no older backup to compare with |
| **Not compared** | The backup did not finish or was made by an older version, or no earlier backup can be compared with it for the same reason |

The same numbers appear in **Backup Details** as **Changes since the previous backup**.

## See what changed

1. In the **Backup Timeline**, click the backup you want to look at.
2. In **Backup Details**, click **View Changes**.

The **Changes in this backup** dialog names the two backups it compares. It lists every item that changed, with its name and type:

* **Deleted**: the item existed in the previous backup and is gone
* **Changed**: the item's configuration is different
* **Added**: the item is new

Deleted items are listed first, then changed and added items, sorted by type and name.

Click a changed item to expand it. TenuVault lists each changed setting with its path, the old value in red and the new value in green. A setting that was added or removed shows "not set" on the side where it did not exist.

**View Changes** is unavailable when there is no earlier backup to compare with, or when the backup was made by an older version.

## How the comparison works

* **Which backup it compares with.** Each backup is compared with the newest older backup that finished and records fingerprints. Failed backups and incomplete backups are skipped. Backups that completed with warnings are included.
* **Only shared types.** Only types that both backups hold a complete copy of are compared. If one backup left out apps, apps are not reported as added or deleted.
* **What does not count as a change.** Values Intune changes on every read or write, such as modification times, version counters and the reference IDs of encrypted values, are ignored. Earlier versions saved Settings Catalog policies (including endpoint security and Settings Catalog compliance policies) without their assignments, so against a backup from such a version their assignments are not compared.
* **Setting details.** The setting-by-setting view is shown for the first 100 changed items, with up to 50 settings each. Long values are shortened. Some properties, such as the description, are not listed in the setting details, so an item can show as **Changed** without a list of settings.

:::note
To compare the tenant as it is right now with your last backup, run a new backup first, then view its changes.
:::

## Act on a change

* To put an item back as it was, open **Restore from this backup** on the older backup. See [Restore items](/restore/).
* To revert a recent change in place, or restore a copy, use [Drift detection](/drift/).
