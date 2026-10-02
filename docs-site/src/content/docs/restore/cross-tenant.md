---
title: "Restore to another tenant"
description: Copy items from one tenant's backup into other connected tenants (MSP).
---

With TenuVault MSP you can copy items from a backup of one tenant into one or more other tenants you have connected. Use it to roll a known good configuration out to customer tenants, or to rebuild configuration in a replacement tenant.

## Requirements

* **MSP plan on every tenant involved.** Copying to other tenants is an MSP feature. TenuVault checks the plan of the source tenant and of every target tenant before anything is written, and stops with an upgrade message if one of them is not covered.
* **Every target tenant is connected and signed in.** Targets are the other tenants listed in TenuVault. Each target is written with its own sign-in and its own app registration. See [Manage tenants](/tenants/).
* **An Intune role in each target tenant** that can create the item types you copy.

If the source tenant's plan does not include MSP features, **Copy to other tenants instead** is greyed out with a plan badge. If you have no other connected tenants, the wizard shows "Connect another tenant to copy items to it."

## How copies to other tenants work

Items copied to another tenant are handled differently from restores in the same tenant, because group, filter and scope tag IDs only exist in the source tenant:

* Copies always use **Create copies**. **Replace in place** and **Restore assignments** are turned off and cannot be selected.
* Copies keep their **original names**, without the `[Restored]` prefix.
* Copies get the **Default** scope tag.
* Copies are **never assigned**. Recreate group targeting, exclusions and filters in the target tenant after you review the copies.
* The source tenant does not change. The review step says "Copies go to *N* tenants; *source tenant* does not change."

## Copy items step by step

1. Go to **Backup & Restore**, select the source tenant and open the **Restore** tab.
2. **Choose a backup**, then select the items to copy on **Choose what to restore**.
3. Click **Next**. On **How to restore**, under **Where**, tick each target tenant under **Copy to other tenants instead**. Each tenant shows its name and domain.
4. Optional, for one target tenant only: go back to **Items** to enter reviewed dependency mappings. See [Map dependencies](#map-dependencies).
5. Click **Review**. Each item is labelled **Copy to the chosen tenants**, or **Cannot be restored** with a reason.
6. Click **Restore N items**. The progress bar counts one step per item per target tenant.
7. Check the results. Each outcome starts with the target tenant's name, for example `Fabrikam: Contoso Defender Antivirus`, and shows **Copied** or the error.

**Retry failed items** retries each failed item only in the tenant where it failed. If a target tenant was removed from TenuVault in the meantime, the retry stops with "The original target tenant is no longer connected."

## Dependencies between items

Many Intune objects refer to other objects by ID, for example a policy that references a scope tag or an assignment filter, or an app that references an app category. Those IDs do not exist in the target tenant.

TenuVault handles this in two ways:

* **Copy the dependencies in the same restore.** TenuVault restores referenced objects first (scope tags, assignment filters, Intune roles, app categories, device categories, notification templates and reusable settings) and rewrites references in later items to the new IDs it just created. Select the dependencies together with the items that use them.
* **Map to objects that already exist in the target tenant.** For apps and app categories you can supply reviewed mappings, described below.

Service-wide identifiers that are the same in every tenant, such as setting definition IDs, template IDs and administrative template definitions, need no mapping.

If an item still refers to an ID TenuVault cannot resolve in the target tenant, it is not created. It fails with "Unresolved target dependencies (*paths*). Copy the dependencies first or reconcile this object in the target tenant." Nothing is written for that item.

## Map dependencies

When you copy to exactly **one** target tenant, step 2 (**Items**) shows **Reviewed target dependencies (one target tenant)**. Enter a JSON array that maps each source object ID to the ID of the matching object in the target tenant:

```json
[
  {
    "folder": "Apps",
    "sourceId": "11111111-1111-1111-1111-111111111111",
    "targetId": "22222222-2222-2222-2222-222222222222"
  },
  {
    "folder": "AppCategories",
    "sourceId": "33333333-3333-3333-3333-333333333333",
    "targetId": "44444444-4444-4444-4444-444444444444"
  }
]
```

Rules for mappings:

* `folder` is `Apps` or `AppCategories`. Other dependency types cannot be mapped; recover those objects manually and reconcile their references in Intune.
* `sourceId` and `targetId` are GUIDs. Each source ID can appear only once.
* You can enter up to 100 mappings.
* Tick "I reviewed these IDs in the selected target tenant. Target objects will be checked before any restore writes."

Before any restore write, TenuVault reads every mapped target object in the target tenant. If one is missing or unreadable, the restore stops with "A mapped dependency is missing or unreadable in the target tenant" and nothing is written.

Mappings only rewrite references to dependencies. They never change configuration text, and they do not upload installers. If the source app needs an installer, upload it in the target tenant through Intune first, then map the resulting app.

:::caution
Never copy source tenant IDs into a mapping blindly. Look up each target object in the target tenant's Intune admin center and confirm it is the object you mean.
:::

Mapping errors you may see:

| Message | Fix |
| --- | --- |
| Dependency mappings must be valid JSON | Correct the JSON syntax. The default value is `[]`. |
| Mappings require a unique source GUID, target GUID and supported folder (Apps or AppCategories) | Check every entry has `folder`, `sourceId` and `targetId`, uses a supported folder, and that no source ID repeats. |
| Supply at most 100 dependency mappings | Split the restore into smaller selections. |
| Confirm the reviewed mappings and select exactly one target tenant | Tick the review checkbox and select a single target tenant. |

## After the copy

* Open each target tenant in the Intune admin center and review the copied items.
* Recreate assignments, exclusions and filters for the target tenant's own groups.
* Adjust scope tags if the target tenant uses more than **Default**.
* Review Intune roles and their memberships separately, so a copy does not grant access you did not intend.

## Related pages

* [Restore items](/restore/)
* [Disaster recovery](/restore/disaster-recovery/)
* [What cannot be restored](/restore/limitations/)
* [Plans and features](/licensing/)
