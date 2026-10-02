---
title: "Restore modes and assignments"
description: Choose between creating copies and replacing in place, and decide whether assignments come back.
---

Every restore uses one of two methods: **Create copies** or **Replace in place**. You can also choose to bring back the assignments recorded in the backup. This page explains what each choice does to your tenant.

## Compare the methods

| | **Create copies** | **Replace in place** |
| --- | --- | --- |
| Existing items | Never changed | Put back to the backed-up version |
| Deleted items | A copy is created | Recreated under the original name |
| Items that already match | A copy is still created | Left alone |
| Name | Prefixed with **[Restored]** | Original name |
| Reads the tenant before restoring | No | Yes, every selected item |
| Confirmation checkbox | No | Yes, when anything is overwritten or recreated |
| Plan | All plans | Pro and MSP |

## Create copies

"Each item is created next to the current one with a [Restored] name. Nothing existing changes."

Use copies when you want to inspect an old configuration next to the current one, or when you are not sure the backed-up version is what you want. Copies are the safest option: TenuVault only creates new objects.

* The copy's name is the original name with a `[Restored]` prefix, for example `[Restored] Contoso Defender Antivirus`.
* Without **Restore assignments**, copies are created unassigned, so they do not reach any device until you assign them in Intune.
* With **Restore assignments** (Pro and MSP), copies get the same groups and filters as in the backup. The review step then warns: "Assigned copies reach devices at their next check-in."
* Some objects cannot be copied, only updated in place. Examples are the tenant default enrollment configuration ("This is the tenant default. Restore updates it in place.") and the default Company Portal branding ("This is the default branding. Restore updates it in place."). Use **Replace in place** for those.

Community restores exactly one item at a time, always as an unassigned copy.

## Replace in place

"Items that still exist are put back to the backed-up version. Deleted items are recreated with their original name. Items that already match are left alone."

Use replace in place to undo an unwanted change or recover deleted items. Before anything is written, the **Review** step reads each selected item from the tenant and labels it:

* **Overwrite the current version** when the item exists and differs from the backup. The item keeps its ID and name from the backup.
* **Recreate: deleted from the tenant** when the item no longer exists. It is recreated with a new ID and its original name.
* **Skip: already matches the backup** when there is nothing to change.
* **Restore: the current version could not be checked** when the read failed. It is still restored, so check the error shown under the item.

You must tick the confirmation checkbox before you can start. TenuVault also compares each item again right before writing it, so an item that matches by then is reported as **Already matched the backup** and left alone.

:::caution
Overwritten versions are not kept anywhere by the restore itself. Run a backup first if you may want the current versions back. The confirmation text reminds you of this.
:::

### When replace in place is blocked

Some items cannot be replaced, and show **Cannot be restored** with a reason:

* **Unverified legacy snapshots.** Backups written in Azure storage before client-side encryption are shown with an `[Unverified legacy]` prefix. They cannot replace live items: "This snapshot is not authenticated. Review its content and restore a copy; replacement is blocked."
* **Changed creation-only app properties.** For web apps and WinGet apps, some properties cannot be changed on an existing app, for example: "appUrl changed since the backup and Intune cannot change it on an existing app. Delete the app and restore it to recreate it."
* **Administrative templates that cannot be read.** "The current administrative template could not be read, so it cannot be replaced in place."
* **Reference-only types and masked secrets**, described in [What cannot be restored](/restore/limitations/).

### What replace in place keeps

A few properties are handled specially so a replace does not cause side effects:

* Terms and conditions keep their live version number, so users are not asked to accept the terms again.
* Android Enterprise enrollment profiles keep their live enrollment token.
* App categories, app dependencies and supersedence are compared with the live app and only changed where they differ.
* Compliance notification templates match messages by language, so a replace never adds a second message for the same language.

## Restore assignments

"Assign restored items to the same groups and filters as in the backup. Without this, copies are created unassigned" (or, when replacing, "current assignments stay as they are").

**Restore assignments** is available on Pro and MSP, and applies to every selected item.

When you replace in place with assignments on, TenuVault replaces the item's assignments as a whole. Assignments added since the backup are removed, and assignments deleted since the backup come back.

TenuVault also takes care of these details:

* Assignments an item inherited from a policy set are not restored as direct assignments. They come back when you restore the policy set.
* Enrollment configurations and terms and conditions do not accept exclusion assignments, so exclusions are left out for those types.
* When the settings match but only the assignments differ, the item is labelled **Skip** with assignments off, and **Overwrite the current version** with assignments on.

### Types that need assignments reconciled in Intune

When you choose **Replace in place**, the wizard shows this note:

> Restore assignments applies to every selected item. For Windows Autopilot profiles, Apple user enrollment profiles, terms and conditions, and Intune roles, turn it off and reconcile assignments in Intune. Restore assignments for supported types in a separate selection.

For these four types, replacing assignments in place is not supported. If you select one of them with **Restore assignments** on, the item fails with "Assignment replacement is not supported for *type*. Turn off Restore assignments and reconcile assignments in Intune." Restore these items in their own selection with assignments off, then fix their assignments in the Intune admin center.

:::caution
For Intune roles, restoring assignments can reinstate access you revoked after the backup. Review role memberships before and after the restore.
:::

## Where restored items go

By default, items are restored to the tenant selected at the top of **Backup & Restore**. On MSP, **Copy to other tenants instead** sends copies to other connected tenants. Copies to other tenants always use **Create copies**, keep their original names, get the Default scope tag and are never assigned. See [Restore to another tenant](/restore/cross-tenant/).

## Related pages

* [Restore items](/restore/)
* [What cannot be restored and restore write history](/restore/limitations/)
* [Plans and features](/licensing/)
