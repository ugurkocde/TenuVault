---
title: "Restore items"
description: Bring Intune items back from a backup with the five step restore wizard.
---

The restore wizard brings Intune items back as they were when a backup ran. You pick a backup, choose the items, decide how to restore them, review exactly what will happen to each item, and then watch the restore run.

## Before you start

* The tenant is signed in and its license is active. If not, TenuVault shows a notice with **Open sign-in settings** and **Open license** above the page. See [Sign in to your tenant](/getting-started/connect-tenant/) and [Activate and manage your license](/licensing/manage/).
* The tenant has backup storage chosen, and at least one backup with items in it. See [Run a backup](/backups/).
* Your admin account has an Intune role that can write the item types you restore, for example Intune Administrator. TenuVault uses delegated permissions, so it can never do more than your account can.
* If the backup is in Azure storage and you are on a different device than the one that made it, import the recovery key first. See [Encryption and recovery key](/security/encryption/).

## What your plan includes

| Capability | Community | Pro | MSP |
| --- | --- | --- | --- |
| Restore one item at a time as an unassigned **[Restored]** copy | Yes | Yes | Yes |
| Restore several items at once | No | Yes | Yes |
| **Replace in place** | No | Yes | Yes |
| **Restore assignments** | No | Yes | Yes |
| **Copy to other tenants instead** | No | No | Yes |

Features your plan does not include show a plan badge in the wizard. If you send a request your plan does not cover, TenuVault answers with a message such as "Restoring several items at once: included in TenuVault Pro and MSP. Upgrade on the License page."

## Open the wizard

You can start a restore in two ways:

* Go to **Backup & Restore**, select the tenant, and open the **Restore** tab. The wizard starts at step 1.
* Go to **Backup & Restore** > **Backup History**, select a backup in the timeline, and click **Restore from this backup** in **Backup Details**. The wizard opens with that backup already chosen, at step 2. The button is unavailable while the backup is still running or when it holds no items.

The steps across the top are **Backup**, **Items**, **Options**, **Review** and **Restore**. You can click an earlier step to go back to it. Once a restore starts, the other steps are locked. When it finishes, use **Restore more items** to make a new selection.

## Step 1: Choose a backup

**Choose a backup** lists every backup for the selected tenant that holds at least one item and is not still running. Each entry shows the date and time, the number of items, the size and the backup status (**Complete**, **Completed with warnings** or **Failed**). A backup that left some types out also shows its scope.

Backups that stopped early are listed too, because they still hold complete snapshots of the items they saved. When you choose one, step 2 shows: "This backup did not complete fully, so some items may be missing from it."

If no backup qualifies, the wizard shows **No backups to restore from** and asks you to run a backup first.

Click a backup to continue.

## Step 2: Choose what to restore

TenuVault reads the backup (**Reading the backup...**) and lists its items grouped by area (for example **Device configuration**, **Compliance**, **Apps**) and then by type.

1. Use **Search by name or type** to filter the list. Matching types expand automatically.
2. Expand a type and select individual items, or use the checkbox next to a type to select all of its restorable items.
3. On Pro and MSP, **Select all** (or **Select all shown** while searching) selects every restorable item in view, and **Clear** clears the selection.
4. On Pro and MSP, the **Restore method** list lets you pick **Create copies** or **Replace in place** now, because some items can only be restored one way. You confirm the method again in step 3.

The counter shows how many items are selected, for example "3 of 120 selected".

Items that cannot be restored with the current method are greyed out and show the reason under their name. For example, an app that needs an installer file shows "Intune does not let apps download installer files. Upload the installer again to restore this app." An item that can only be updated in place, such as a tenant default, shows "Replace only: this object cannot be copied." when you create copies. See [What cannot be restored](/restore/limitations/) for the full list.

:::note
Community restores one item at a time. Selecting a second item replaces the first, and the **Restore method** list and **Select all** are not shown.
:::

### Recovery readiness

Above the list, **Recovery readiness for N objects** expands into a read-only report for every item in the backup. For each item it shows:

* **Automatic configuration restore available** or **Review required**
* **External artifacts**: things TenuVault cannot recreate, such as installers or Apple tokens
* **Missing mappings**: references to other tenant objects that would need a target in another tenant
* **Manual actions**: steps you complete in Intune yourself

The report is conservative because it assumes a copy into another tenant. Nothing changes in your tenant while you read it. See [Disaster recovery](/restore/disaster-recovery/) for how to act on it.

Click **Next** when your selection is ready, or **Other backup** to go back.

## Step 3: How to restore

**How to restore** shows how many items are selected and offers the restore options:

* **Create copies**: "Each item is created next to the current one with a [Restored] name. Nothing existing changes."
* **Replace in place**: "Items that still exist are put back to the backed-up version. Deleted items are recreated with their original name. Items that already match are left alone."
* **Restore assignments**: "Assign restored items to the same groups and filters as in the backup."
* **Where**: **Copy to other tenants instead** lets MSP tenants send copies to other connected tenants. Leave all tenants unchecked to restore to the selected tenant.

The details of each option, including which types support assignment restore, are in [Restore modes and assignments](/restore/modes/). Copying to other tenants is covered in [Restore to another tenant](/restore/cross-tenant/).

Click **Review** to continue, or **Items** to go back.

## Step 4: Review

**Review** shows what restoring each selected item will do. What TenuVault checks depends on the method:

* **Create copies** and copies to other tenants do not read the existing items, because nothing existing changes. The wizard only checks the selected items (**Checking the selected items...**).
* **Replace in place** reads every selected item from the tenant as it is now (**Comparing with *tenant*...**) and compares it with the backup.

A row of counters summarizes the plan, and the list below shows one label per item:

| Label | Meaning |
| --- | --- |
| **Create a [Restored] copy** | A new copy is created next to the current item. |
| **Copy to the chosen tenants** | A copy is created in each selected target tenant. |
| **Recreate: deleted from the tenant** | The item no longer exists and is recreated under its original name. |
| **Overwrite the current version** | The item exists but differs from the backup, and is put back to the backed-up version. |
| **Skip: already matches the backup** | The item already matches, so nothing is sent. With **Restore assignments** off, an item whose only difference is its assignments is also skipped. |
| **Cannot be restored** | The item cannot be restored with this method. The reason is shown under the item name. |
| **Restore: the current version could not be checked** | TenuVault could not read the current item. It will still be restored, and the read error is shown under the item name. |

If an item was renamed since the backup, the row shows its current name, for example `now named "Contoso Baseline v2"`.

Each row also has **Review snapshot content (may contain secrets)**, which expands the exact JSON TenuVault restores from the backup. Use it to check the settings before you write them.

### Confirm changes to existing items

If any item will be overwritten, recreated or restored without a check, TenuVault asks you to confirm with a checkbox that spells out the effect, for example:

> I understand that 4 items in Contoso will be overwritten, including assignments and 1 item deleted from Contoso will be recreated. Changes reach devices at their next check-in. Run a backup first if you may want the current versions back.

The restore button stays disabled until you tick it. If every selected item already matches or cannot be restored, the wizard shows "Nothing to restore: every selected item already matches the backup or cannot be restored."

Click **Restore N items** to start. Only items that will actually change are sent; skipped and blocked items are left out of the count.

## Step 5: Restore

The **Restoring...** screen shows the item being restored and a progress bar. TenuVault restores items that others depend on first (scope tags, assignment filters, Intune roles, app categories, device categories, notification templates and reusable settings) and policy sets last. When an item is recreated with a new ID, later items in the same restore that reference it are pointed to the new ID.

When the restore ends, the heading changes to **Restore finished** and a summary such as "12 items completed; 1 failed." appears. Each item shows its outcome:

| Outcome | Meaning |
| --- | --- |
| **Created a [Restored] copy** | A copy was created in this tenant. |
| **Recreated** | A deleted item was created again under its original name. |
| **Put back to the backed-up version** | An existing item was updated in place. |
| **Copied** | A copy was created in the target tenant shown before the item name. |
| **Already matched the backup** | Nothing needed to change. |
| An error message | The item failed. The message comes from Microsoft Graph or TenuVault. |

Some results carry extra notes:

* **Incomplete object: *ID*.** The item was created or updated, but a follow-up step (such as settings, categories or assignments) failed. If TenuVault can safely resume, the note says "Retry repairs the remaining steps without creating another object. Repair is available for one hour in this app session." Otherwise it says "Check and repair it in Intune."
* **Check this item in Intune before retrying; a write may already have completed.** The response was lost, so TenuVault does not know whether the write reached Intune. It does not retry this item automatically. See [Restore write history](/restore/limitations/#restore-write-history).
* Warnings in amber describe partial problems, for example "Assignments could not be restored: ..." followed by the Graph error.

### After the restore

* **Retry failed items** appears when some failures are safe to retry. It retries only confirmed failures, in their original target tenant, and repairs incomplete objects instead of creating new ones. Successful items are never sent again.
* **Restore more items** returns to step 2 with the same backup so you can make another selection.
* Restores are recorded in the tenant's [audit log](/audit-log/).
* Restored or overwritten items reach devices at their next check-in. Unassigned copies do not reach any device until you assign them in Intune.

## Related pages

* [Restore modes and assignments](/restore/modes/)
* [Restore to another tenant](/restore/cross-tenant/)
* [What cannot be restored and restore write history](/restore/limitations/)
* [Disaster recovery](/restore/disaster-recovery/)
* [Drift detection](/drift/), for reverting a single changed policy
