---
title: "Copy to Tenants"
description: Copy selected Intune policies from one tenant to others, one way and only when you start it, with a review per target, an optional backup and rollback.
---

**Copy to Tenants** copies selected policies from one tenant, the source, to one or more other tenants, the targets. It runs one way and only when you start it. Every target is reviewed against its live state before anything is written, and every target can be rolled back.

Open **Copy to Tenants** in the sidebar, directly under **Drift Detection**.

## What Copy to Tenants does and does not do

* It copies the policies you select from the source to each target you choose. The source tenant is only read; it never changes.
* It runs only when you start it. Copy to Tenants never runs on its own and never copies back from a target. Later edits in the source reach a target only through a new copy that you review and approve.
* It remembers which policy in a target each source policy was written to. The next copy of the same policy updates that policy instead of creating another one.
* It writes nothing for a policy that is already up to date: when neither the source policy nor its copy in the target changed since the last copy, that policy is skipped in that target.
* It does not copy assignments. New policies are created unassigned, and the assignments of existing policies stay as they are.
* It does not copy secret values. Values Intune masks must be set again in each target.
* It does not delete anything in a target.

Copy to Tenants works like [Dev to Prod](/changes/#dev-to-prod), with more than one target and links between the source and target policies: each target gets its own reviewed change set, backup and rollback, and a failure in one target never stops or undoes another.

## What your plan includes

| | Community | Pro | MSP |
| --- | --- | --- | --- |
| Copy settings to other tenants | | Yes (the two tenants of your license, or two tenants on a Pro trial) | Yes |

* **Pro** copies between the two tenants of your license, in either direction. During a Pro trial, two tenants that each run a Pro trial on this computer can copy to each other the same way, one target per copy.
* **MSP** copies from one tenant to several tenants at once. Every tenant in the copy needs MSP.
* **Community** sees a preview of what Copy to Tenants does, with **See plans**.

When the selected tenant's plan does not include Copy to Tenants, the **Copy to Tenants** entry in the sidebar shows a **Pro** badge. It still opens the page. See [Plans and features](/licensing/).

## Copy step by step

The page leads you through four steps: **Choose settings**, **Choose targets**, **Review** and **Copy**.

### 1. Choose settings

1. Choose the **Source tenant**. It starts as the tenant selected in the tenant switcher; you can choose any connected tenant whose plan includes Copy to Tenants (Pro or MSP).
2. Choose a policy type: **Settings Catalog**, **Compliance**, **Endpoint security** or **Device configuration**. Policies are read live from the source tenant; placeholder rows show while they load, and each status appears as soon as it is read.
3. Tick the policies to copy. You can select policies of several types; the type buttons show how many you selected of each. Each policy shows its status:
   * **Not copied yet**: no earlier copy wrote this policy to a target you can choose.
   * **Up to date in** a tenant: neither the source policy nor the copied policy changed since the last copy.
   * **Changed in** a tenant: the policy was edited since the last copy. The chip names where: the source tenant, the target tenant (or **N targets**), or **Changed in both** when both sides were edited. Hover the chip to see the state in every target.
   * **Missing in target**: the policy an earlier copy wrote no longer exists in a target. The next copy creates it again.
   * **Unknown**: a tenant could not be read, or the change cannot be told.
4. Click **Copy N policies**. You can copy up to 25 policies at once.

The status is read again when you start a new copy, after a copy or rollback finishes, and when you return to the TenuVault window, so it reflects edits made in a tenant meanwhile.

<figure class="docs-screenshot">
  <a href="/images/screenshots/sync.webp" aria-label="Open full-size screenshot: Copy to Tenants">
    <img src="/images/screenshots/sync.webp" alt="Copy to Tenants starts by choosing settings from the selected source tenant" width="2880" height="2000" loading="lazy" decoding="async" />
  </a>
  <figcaption>Copy to Tenants starts by choosing settings from the selected source tenant. Example policy list; no copy was planned or applied. Select the image to view it full size.</figcaption>
</figure>

### 2. Choose targets

Every other connected tenant shows as a card with its name and domain.

* Click a card to choose it. A card shows **N policies linked** when earlier copies from this source wrote policies to it.
* On Pro, only the other tenant of your license can be chosen. It shows **Available on Pro**. When the source runs a Pro trial, every other tenant that runs a Pro trial can be chosen in the same way. The other tenants show **MSP** and the note "Pro copies between the two tenants of your license, or between two tenants that each run a Pro trial. Copying to more tenants is part of MSP."
* A tenant whose plan does not include Copy to Tenants, or that you are not signed in to, cannot be chosen.

Click **Review N tenants**. TenuVault plans the copy and reads every target tenant. Nothing is written.

While the plan runs, the review says what is being read, for example **Reading Contoso Lab and 3 target tenants**, with a moving bar. Each target then appears and shows **Checking against the live tenant** until its own check finishes, then its result. A read that takes longer than five seconds shows how long it has been running, for example **Still reading, 12 s**, so a slow tenant does not look stuck.

### 3. Review

The review shows one block per target. Each selected policy shows what happens in that target:

* **Create**: the policy does not exist in the target yet, or was never copied to it, and is created unassigned.
* **Update**: an earlier copy linked this policy, and the linked policy in the target is updated. Its assignments stay as they are.
* **Skip: already up to date**: neither the source policy nor its copy in the target changed since the last copy, and this copy uses the same options for that target as the copy that wrote it (whether assignments are included and the confirmed mappings). Nothing is written for it. If TenuVault cannot read the source to check, or the options differ, the policy is planned as an update instead.
* **No change**: the policy is updated, but no setting differs from the policy in the target, for example when the target was not read back after an earlier copy and a change there cannot be ruled out. It is written again unchanged.
* **Blocked**: the policy cannot be copied to this target. The finding below it says why, and nothing is written to that target.

When every selected policy is already up to date in a target, that target shows **Already up to date**. Nothing is planned or written there and no backup is taken. When every target is already up to date, the backup choice is not shown, the review says **Nothing is written.** and the button reads **Continue: nothing to write**.

Warnings show under the policy they concern, for example:

* **Link missing**: the policy an earlier copy wrote no longer exists in this target, so this copy creates a new one.
* **Earlier copy unconfirmed**: an earlier copy of this policy to this target has an unconfirmed result, so copying again may create a second policy. Retry that earlier copy first so TenuVault can check.
* **Same name**: a policy with the same name already exists in the target, and this copy creates another one. A matching name never links policies. The warning shows once per policy, with the count read from the live tenant.
* **Secrets**: the policy holds values Intune masks. They are not copied and must be set again in the target.
* **Assignments not copied**: the source policy has assignments. They are not copied; a new policy is created unassigned and an existing one keeps its assignments.
* **Default scope tag**: a scope tag of the source policy has no matching tag in the target, so the new policy uses the Default scope tag instead.

A target is left out, with the reason shown in its block, when it could not be planned or read, when a finding blocks it, or when it has no backup storage and you chose to back up first. The other targets are not affected.

When a selected policy holds secrets, tick **I understand that secrets in these policies are not copied and must be set again in each target.** TenuVault then plans the copy again with your acknowledgement. **Approve and copy** stays unavailable until you do.

#### Backup before changes

Choose what happens before anything is written:

* **Back up first** (the default): each target is backed up first, using that tenant's backup settings (**Settings**, backup scope). If the backup does not cover every policy type this copy changes, or fails, nothing is changed in that tenant. A target without backup storage cannot be backed up, so it is left out unless you choose **Skip the backup**.
* **Skip the backup**: no backup is taken. Rollback still works from the saved versions in a target tenant that has backup storage: TenuVault saves the current version of every policy it changes before writing, and a rollback always takes a backup first. Those saved versions are kept on this device only; without a backup they are the only copy. In a target tenant without backup storage a rollback cannot run, so the review says on that target: "Rollback needs backup storage in this tenant. Without it, this copy cannot be rolled back from TenuVault."

Click **Approve and copy to N tenants**. Every ready target is approved and applied on its own, with the backup you chose. The backup choice is stored with each target's approval, so its apply, any retry and an apply from **Details** use the same choice, also when you open the copy again later. While another change is being applied to the same tenant, an approval is refused; approve again when that change finishes. Copy to Tenants records no reviewer name or decision note; the approval is recorded with the signed-in admin in the [audit log](/audit-log/).

### 4. Copy

The result view shows the source tenant on the left, with the first three selected policies, and one node per target on the right, linked by a short line. It stays compact and centred at any window width. It follows each target's stored state while it is written, never a timer:

* The header shows **Copying to N tenants** with how many finished and a progress bar over every target.
* While a target is written, its line draws in, dots travel along it, and its node shows three stages: **Approve**, **Back up** (or **Save** when you skipped the backup) and **Write and verify**. The current stage is named in the node: **Approving** until the approval is stored, then **Backing up** or **Saving current versions** until the current state is captured, then **Writing and verifying 1 of 3**, which counts the policies written and verified by read-back so far.
* When every change was verified, the line and node turn green, a check appears on the line, and the node shows **N changes verified**, with **Backup taken first** or **No backup taken**, and how many policies were created, updated, skipped as already up to date or failed.
* A target where every policy was already up to date turns green and shows **Already up to date, nothing written. No backup taken.**
* A written target without backup storage also shows **Rollback needs backup storage in this tenant.**, in its node and in **Details**.
* When some changes failed, the line and node turn amber, with a warning sign on the line, and list the failed policies with the error. When nothing was written, they turn red, with a cross on the line.
* A target that was left out shows **Not copied** with the reason, faded, on a dashed line.

With reduced motion turned on in your operating system, the view shows each state without animation.

Each finished target offers:

* **Open Intune**: opens the Intune admin center in that target tenant. With one copied policy it opens that policy; with several it opens the list of the policy type.
* **Retry failed**: applies the target again with the backup choice it was approved with, shown under the button. A retry never switches between backing up and skipping the backup, also when you open the copy again later. Policies already verified are not written again.
* **Details**: shows the target's change set with the result of every policy, the pre-change evidence and **Preview rollback**.

#### A copy that was planned and never approved

When you open a copy from **Recent copies** that was reviewed but where no target was approved, the result view shows **Planned, not approved yet** with two actions:

* **Continue to review** opens the review of that copy again, with its policies and targets. Every target is read against its live state again before you can approve it, as in a new review.
* **Discard** removes the plan from **Recent copies**. Nothing in any tenant changes, and the record is kept on this device. A copy can be discarded only while none of its targets was approved or applied; otherwise TenuVault refuses and the copy stays listed. Use it, for example, to clear an old draft that points at a production tenant.

When every target finished and at least one target was written, the summary shows **Links saved for the next copy**, **Rollback available per tenant** (or **Rollback available in N of M tenants** when some written tenants have no backup storage), **Backup taken in each tenant** (or **Backup taken in N of M tenants** when a backup did not complete) or **Backup skipped**, and **Recorded in the audit log**. Click **Start a new copy** to begin again.

## Roll back a target

1. Open the copy under **Recent copies** and click **Details** on the target.
2. Click **Preview rollback**, check what it would change, then click **Create rollback change set for review**.
3. Review the rollback against the live tenant, approve it and apply it. A rollback always backs up the target first, so it needs backup storage in that tenant.

A rollback writes only to its target. It keeps working after the source tenant's license ends.

When a rollback deletes a policy the copy created, TenuVault removes the link to it once the delete is verified, so the policy shows **Not copied yet** again in **Choose settings** and the next copy creates it again. When every written target of a copy was rolled back, the copy shows **Rolled back** under **Recent copies**.

## Recent copies

**Recent copies** lists the copies started from the source tenant, newest first. Each row shows the source and its target (or the number of targets), how long ago it was started (hover for the full date) and its outcome:

* **Applied**: every target that was applied verified every change.
* **Partly applied**: some changes or some targets failed or are unconfirmed.
* **Failed**: nothing was written in any target that was applied.
* **Copying**: a target is being written right now.
* **Rolled back**: every target that was written was rolled back.
* **Not applied**: the copy was planned but never applied, including a plan you replaced by going back and reviewing again.
* **Already up to date**: every target was already up to date, so nothing was planned.

Discarded copies are not listed. Click a copy to open its result view, read from the stored records.

## Links and status

When a copy verifies a write, TenuVault links the source policy to the policy it wrote in the target. Links are stored on this device, per source and target tenant. The next copy of a linked policy updates the linked policy, or skips it when neither side changed since. The status in **Choose settings** compares both sides with the state at the last copy, by the same rule.

If the linked policy was deleted in the target, the next copy creates it again and says so in the review.

## Limits

* Four policy types: Settings Catalog policies, compliance policies, endpoint security policies and device configuration profiles.
* At most 25 policies per copy.
* At most 25 target tenants per copy.
* Assignments and secret values are not copied.
* Copy to Tenants is one way and runs only when you start it.

## Related pages

* [Changes](/changes/)
* [Restore to another tenant](/restore/cross-tenant/)
* [Audit log](/audit-log/)
* [Plans and features](/licensing/)
