---
title: "Sync"
description: Copy selected Intune policies from one tenant to others, one way and only when you start it, with a review per target, an optional backup and rollback.
---

**Sync** copies selected policies from one tenant, the source, to one or more other tenants, the targets. It runs one way and only when you start it. Every target is reviewed against its live state before anything is written, and every target can be rolled back.

Open **Sync** in the sidebar, directly under **Drift Detection**.

## What Sync does and does not do

* It copies the policies you select from the source to each target you choose. The source tenant is only read; it never changes.
* It runs only when you start it. Sync never runs on its own, and later edits in the source reach a target only through a new sync that you review and approve.
* It remembers which policy in a target each source policy was written to. The next sync of the same policy updates that policy instead of creating another one.
* It writes nothing for a policy that is already in sync: when neither the source policy nor its synced copy changed since the last sync, that policy is skipped in that target.
* It does not sync assignments. New policies are created unassigned, and the assignments of existing policies stay as they are.
* It does not sync secret values. Values Intune masks must be set again in each target.
* It does not delete anything in a target.

Sync works like [Dev to Prod](/changes/#dev-to-prod), with more than one target and links between the source and target policies: each target gets its own reviewed change set, backup and rollback, and a failure in one target never stops or undoes another.

## What your plan includes

| | Community | Pro | MSP |
| --- | --- | --- | --- |
| Sync settings to other tenants | | Yes (the two tenants of your license) | Yes |

* **Pro** syncs between the two tenants of your license, in either direction.
* **MSP** syncs from one tenant to several tenants at once. Every tenant in the sync needs MSP.
* **Community** sees a preview of what Sync does, with **See plans**.

When the selected tenant's plan does not include Sync, the **Sync** entry in the sidebar shows a **Pro** badge. It still opens the page. See [Plans and features](/licensing/).

## Sync step by step

The page leads you through four steps: **Choose settings**, **Choose targets**, **Review** and **Sync**.

### 1. Choose settings

1. Choose the **Source tenant**. It starts as the tenant selected in the tenant switcher; you can choose any connected tenant.
2. Choose a policy type: **Settings Catalog**, **Compliance**, **Endpoint security** or **Device configuration**. Policies are read live from the source tenant.
3. Tick the policies to sync. You can select policies of several types; the type buttons show how many you selected of each. Each policy shows its status:
   * **Not synced yet**: no earlier sync wrote this policy to a target you can choose.
   * **In sync with** a tenant: neither the source policy nor the synced policy changed since the last sync.
   * **Changed since last sync**: the source policy, the synced policy or both changed.
   * **Missing in target**: the policy an earlier sync wrote no longer exists in a target. The next sync creates it again.
   * **Unknown**: a tenant could not be read, or the change cannot be told.
4. Click **Sync N policies**. You can sync up to 25 policies at once.

### 2. Choose targets

Every other connected tenant shows as a card with its name and domain.

* Click a card to choose it. A card shows **N policies linked** when earlier syncs from this source wrote policies to it.
* On Pro, only the other tenant of your license can be chosen. It shows **On your Pro license**. The other tenants show **MSP** and the note "Pro syncs between the two tenants of your license. Syncing to more tenants is part of MSP."
* A tenant whose plan does not include Sync, or that you are not signed in to, cannot be chosen.

Click **Review N tenants**. TenuVault plans the sync and reads every target tenant. Nothing is written.

### 3. Review

The review shows one block per target. Each selected policy shows what happens in that target:

* **Create**: the policy does not exist in the target yet, or was never synced to it, and is created unassigned.
* **Update**: an earlier sync linked this policy, and the linked policy in the target is updated. Its assignments stay as they are.
* **Skip: already in sync**: neither the source policy nor its synced copy in the target changed since the last sync, and this sync uses the same options for that target as the sync that wrote it (whether assignments are included and the confirmed mappings). Nothing is written for it. If TenuVault cannot read the source to check, or the options differ, the policy is planned as an update instead.
* **No change**: the policy is updated, but no setting differs from the policy in the target, for example when the target was not read back after an earlier sync and a change there cannot be ruled out. It is written again unchanged.
* **Blocked**: the policy cannot be synced to this target. The finding below it says why, and nothing is written to that target.

When every selected policy is already in sync in a target, that target shows **Already in sync**. Nothing is planned or written there and no backup is taken. When every target is already in sync, the button reads **Continue: nothing to write**.

Warnings show under the policy they concern, for example:

* **Link missing**: the policy an earlier sync wrote no longer exists in this target, so this sync creates a new one.
* **Earlier sync unconfirmed**: an earlier sync of this policy to this target has an unconfirmed result, so syncing again may create a second copy. Retry that earlier sync first so TenuVault can check.
* **Same name**: a policy with the same name already exists in the target, and this sync creates another one. A matching name never links policies.
* **Secrets**: the policy holds values Intune masks. They are not synced and must be set again in the target.
* **Assignments not synced**: the source policy has assignments. They are not copied; a new policy is created unassigned and an existing one keeps its assignments.
* **Default scope tag**: a scope tag of the source policy has no matching tag in the target, so the new policy uses the Default scope tag instead.

A target is left out, with the reason shown in its block, when it could not be planned or read, when a finding blocks it, or when it has no backup storage and you chose to back up first. The other targets are not affected.

When a selected policy holds secrets, tick **I understand that secrets in these policies are not synced and must be set again in each target.** TenuVault then plans the sync again with your acknowledgement. **Approve and sync** stays unavailable until you do.

#### Backup before changes

Choose what happens before anything is written:

* **Back up the affected policy types now** (the default): each target backs up only the policy types this sync changes before anything else happens. If the backup fails, nothing is changed in that tenant. A target without backup storage cannot be backed up, so it is left out unless you choose **Skip the backup**.
* **Skip the backup**: no backup is taken. Rollback still works: TenuVault saves the current version of every policy it changes before writing. Those saved versions are kept on this device only; without a backup they are the only copy.

Click **Approve and sync to N tenants**. Every ready target is approved and applied on its own, with the backup you chose. Sync records no reviewer name or decision note; the approval is recorded with the signed-in admin in the [audit log](/audit-log/).

### 4. Sync

The result view shows the source tenant on the left and one node per target on the right, linked by a line. It follows each target's stored state while it is written:

* While a target is written, its line draws out and its node shows **Backing up, then writing**, or **Saving current versions, then writing** when you skipped the backup, followed by how many changes are verified.
* When every change was verified, the line and node turn green and show **N changes verified**, with **Backup taken first** or **No backup taken**.
* A target where every policy was already in sync turns green and shows **Already in sync, nothing written. No backup taken.**
* When some changes failed, the line and node turn amber and list the failed policies with the error. When nothing was written, they turn red.
* A target that was left out shows **Not synced** with the reason.

With reduced motion turned on in your operating system, the view shows each state without animation.

Each finished target offers:

* **Open Intune**: opens the Intune admin center in that target tenant. With one synced policy it opens that policy; with several it opens the list of the policy type.
* **Retry failed**: applies the target again with the backup choice its first apply used, shown under the button. A retry never switches between backing up and skipping the backup, also when you open the sync again later. Policies already verified are not written again.
* **Details**: shows the target's change set with the result of every policy, the pre-change evidence and **Preview rollback**.

When every target finished and at least one target was written, the summary shows **Links saved for the next sync**, **Rollback available per tenant**, **Backup taken in each tenant** (or **Backup taken in N of M tenants** when a backup did not complete) or **Backup skipped**, and **Recorded in the audit log**. Click **Start a new sync** to begin again.

## Roll back a target

1. Open the sync under **Recent syncs** and click **Details** on the target.
2. Click **Preview rollback**, check what it would change, then click **Create rollback change set for review**.
3. Review the rollback against the live tenant, approve it and apply it. A rollback always backs up the target first.

A rollback writes only to its target. It keeps working after the source tenant's license ends.

## Recent syncs

**Recent syncs** lists the syncs started from the source tenant, newest first, with their targets. A sync that was planned but never applied shows **Not applied**, including a plan you replaced by going back and reviewing again. Click a sync to open its result view, read from the stored records.

## Links and status

When a sync verifies a write, TenuVault links the source policy to the policy it wrote in the target. Links are stored on this device, per source and target tenant. The next sync of a linked policy updates the linked policy, or skips it when neither side changed since. The status in **Choose settings** compares both sides with the state at the last sync, by the same rule.

If the linked policy was deleted in the target, the next sync creates it again and says so in the review.

## Limits

* Four policy types: Settings Catalog policies, compliance policies, endpoint security policies and device configuration profiles.
* At most 25 policies per sync.
* At most 25 target tenants per sync.
* Assignments and secret values are not synced.
* Sync is one way and runs only when you start it.

## Related pages

* [Changes](/changes/)
* [Restore to another tenant](/restore/cross-tenant/)
* [Audit log](/audit-log/)
* [Plans and features](/licensing/)
