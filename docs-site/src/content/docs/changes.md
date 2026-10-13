---
title: "Changes"
description: Promote Settings Catalog policies from a development tenant to production, and upgrade installed baselines while keeping your customizations.
---

The **Changes** hub groups two screens for the tenant selected in the tenant switcher: **Dev to Prod** and **Baseline upgrades**. Both write through a reviewed change set: you review the difference against the live tenant, approve it, apply it with a backup first, and can roll it back. Nothing is written while you plan.

Open **Changes** in the sidebar, then choose a screen at the top of the page. Without a connected tenant the page says "Connect or select a tenant to use changes." and no screen runs.

## What your plan includes

| Screen | Community | Pro | MSP |
| --- | --- | --- | --- |
| Dev to Prod | No | Yes | Yes |
| Baseline upgrades | No | Yes | Yes |

On Pro, Dev to Prod runs between the two tenants of your license. On a plan that does not include a screen, the tab shows a plan badge and a locked preview that describes what the screen does, with **See plans**. Promotions and upgrades that were already created and stored on an earlier plan stay readable after a downgrade; only creating new ones needs the plan. See [Plans and features](/licensing/).

Every apply and rollback from this hub is recorded in the [audit log](/audit-log/) as an applied or rolled back change set.

## How change sets work

Promotions, baseline upgrades and standard adoptions all end in a change set. The change set card walks through the same steps everywhere:

1. **Review diff**: click **Review against the live tenant** to compare the planned change with the tenant as it is now. Blockers stop the apply. The review shows any irreversible steps.
2. **Approve**: enter the **Reviewer** and a **Decision note**, then click **Approve this content and target state**, or **Reject**. An approval is bound to this content and target state, so a later change to either needs a fresh review.
3. **Apply**: click **Apply to tenant**. The target is read again first; any change since approval stops the apply and needs a fresh review. Before anything is written, TenuVault captures the current state of the affected objects and runs the pre-change backup recorded on the card.
4. **Results**: each operation shows whether it was verified, failed, uncertain or not attempted. **Reconcile and retry** reconciles uncertain operations from live state before writing again; verified operations are never written again.
5. **Rollback preview**: click the rollback button to preview the reverse change, then review, approve and apply the rollback change set in the same way. Objects whose masked values were not stored cannot be rolled back automatically and say so on the card.

## Dev to Prod

Dev to Prod promotes selected Settings Catalog policies from a development tenant to the production tenant you selected, one way and on demand. The selected tenant is always the destination. Promotion copies the reviewed version once; later edits in the source are never synchronized.

### Before you start

* Connect both tenants and make sure your license covers both. On Pro the source must be the other tenant of the same license; the app enforces this. If no other tenant is connected, the screen says "Connect the development tenant covered by the same license to promote from it."
* Only Settings Catalog policies can be promoted.

### Plan a promotion

1. Select the production tenant in the tenant switcher.
2. Open **Changes** in the sidebar and choose **Dev to Prod**.
3. In **Promote settings into** the destination tenant, choose the **Source (development) tenant**. The **Destination (production) tenant** is the selected tenant and cannot be changed here; select another tenant in the switcher to promote into it instead.
4. In the policy list, tick **Promote** for each source policy to include. For each one, choose **Create a new policy**, or **Update:** an existing destination policy. A destination policy with the same name is only marked as "same name, confirm it is the same policy"; a matching name never selects the target for you.
5. Leave **Promote assignments too, after reviewing their mapped groups and filters (default: created unassigned, existing assignments untouched)** unticked to keep assignments out, or tick it to include assignments after review. By default new policies are created unassigned and existing assignments stay untouched.
6. Tick **I understand that secrets in this policy are not promoted and must be set again in the destination** when the policies carry secret values. Secrets are never promoted.
7. Enter a **Title**, for example "Promote OIB Windows 3.6", and a **Ticket or reference** if you use one.
8. Click **Plan promotion**. Planning reads both tenants and writes nothing. While it reads, the button shows "Reading both tenants".

You can plan at most 25 policies at once.

### Review and apply

1. In **Promotions**, click the planned promotion. Each policy shows **ready** or **blocked**, whether it creates a new policy or updates an existing one, and its findings. Blocking findings must be resolved before the change set can be applied.
2. When a plan is blocked, use **Dependency mappings** to map each tenant specific reference, such as a group, filter or scope tag, to its target in the destination, tick to confirm each mapping, then click **Plan again**.
3. Work through the change set as described in [How change sets work](#how-change-sets-work): review against the live tenant, approve, then apply. Production is backed up and its current state is captured before anything is written.
4. After an apply, use the **Rollback** change set on the same promotion to review, approve and apply the reverse change.

Stored promotions stay listed under **Promotions** with their status, and open read only after a downgrade.

### Limits

* Only Settings Catalog policies are supported. Other policy types cannot be promoted.
* Promotion is one way and runs only when you start it. It never synchronizes later source edits.
* Secret values are not promoted and must be set again in the destination.
* Assignments stay out unless you include them and review their mapped groups and filters.
* At most 25 policies per promotion.

## Baseline upgrades

Baseline upgrades compares three versions of your installed OpenIntuneBaseline baseline: the version you installed, your tenant's current settings, and a newer upstream version. Unchanged local overrides are kept, and conflicting edits ask for your decision. Without recorded provenance, the comparison is manual and every difference needs your decision.

### Record an installed baseline

Upgrades need a recorded install to compare against.

1. Open **Changes** in the sidebar and choose **Baseline upgrades**.
2. In **Record an installed baseline**, find the OpenIntuneBaseline deployment and click **Record**. The list shows deployments made on this device, including earlier Quick Start runs, with the policies they created or updated.

Recording stores the exact OpenIntuneBaseline content as the base of later comparisons. When the deployed commit is not recorded, the baseline is recorded with unknown provenance and upgrades are compared manually. To deploy a baseline first, see [OpenIntuneBaseline](/baselines/quick-start/).

### Compare with a newer version

1. In **Installed baselines**, click **Check the latest OpenIntuneBaseline version** on the baseline.
2. When a newer version is available, click **Compare with** followed by its tag. Baselines recorded from a workspace pack also offer **Compare with the workspace pack**.

The comparison opens in **Upgrades**. Each policy is marked as matched, added, removed, missing locally, unsupported or unreadable, with the number still to resolve.

### Resolve differences

1. Click a policy to expand it. The table lists each changed setting with its **Installed**, **Tenant** and **Release** values and its outcome.
2. For each setting that needs a resolution, choose **keep tenant value** or **take release value** in the **Use** column.
3. For a policy that is new in the release, choose **create it** or **skip it**. For a policy the release removed, choose **keep the tenant policy** or **delete the tenant policy**.
4. Click **Save resolutions**.

Settings documented under [Governance](/governance/) organization customizations are marked "(documented)" in the list. Unchanged settings are counted but not listed. Assignments are never changed by an upgrade, and unresolved settings stop the upgrade.

### Apply the upgrade

1. Click **Create change set**.
2. Work through the change set as described in [How change sets work](#how-change-sets-work): review against the live tenant, approve, then apply with its pre-change backup, and roll it back from the same card when needed.
3. To drop an upgrade you no longer want, click **Discard** before it has any batches.

### Limits

* An upgrade applies only through a confirmed change set with backup and read-back. Nothing is written by comparing or resolving.
* Without recorded provenance, every difference needs your decision in a manual comparison.
* Assignments are never changed by an upgrade.
