---
title: "Multi Admin Approval and TenuVault"
description: How Intune Multi Admin Approval affects TenuVault. Backups keep working, writes to protected policy types are refused, and how to apply those changes in the Intune admin center.
faq:
  - question: "Does Intune Multi Admin Approval stop TenuVault backups?"
    answer: "No. Multi Admin Approval only intercepts changes (create, update, assign and delete). Backups, drift detection, change reports, alerts, the Backup Reader and cloud backups only read Intune, so they keep working in a tenant with Multi Admin Approval."
  - question: "Can TenuVault restore a policy that Multi Admin Approval protects?"
    answer: "Not today. Intune refuses the change and nothing is written for that item. TenuVault does not create approval requests, so make the change in the Intune admin center, where it goes through approval, and use the backup as the reference."
  - question: "Does excluding the TenuVault app registration from an access policy help?"
    answer: "No. App exclusions in a Multi Admin Approval access policy only apply to app-only calls. TenuVault signs in as you with delegated permissions, so the access policy still applies to it."
  - question: "Does Multi Admin Approval affect tenants that do not use it?"
    answer: "No. Nothing changes until an access policy exists for an area. Without one, TenuVault restores, promotes and remediates as usual."
---

[Multi Admin Approval](https://learn.microsoft.com/intune/fundamentals/role-based-access-control/multi-admin-approval) is an Intune feature that requires a second administrator to approve changes to protected areas before they take effect. This page explains what it means for TenuVault: what keeps working, what Intune refuses, and how to apply those changes.

## What keeps working

Multi Admin Approval only intercepts **changes**: creating, updating, assigning and deleting. It never intercepts reads. Everything in TenuVault that only reads Intune works as usual in a tenant with Multi Admin Approval:

* Backups, manual and scheduled, including the [Backup Reader](/backups/backup-reader/) and [cloud backups](/backups/cloud/)
* [Drift detection](/drift/), [change reports](/reports/), the [audit log](/audit-log/) and [alerts](/notifications/)
* Framework coverage and CIS assessments

Tenants that have no access policy for an area see no change at all.

## When Intune refuses a change from TenuVault

A change is refused when all three of these are true:

1. The tenant has an **access policy** for that area. Multi Admin Approval is turned on per area, under **Tenant administration** > **Multi Admin Approval** > **Access policies** in the Intune admin center.
2. TenuVault **writes** to it, during a restore, a [Dev to Prod promotion or baseline upgrade](/changes/), a [CIS remediation](/baselines/cis-benchmarks/) or an [OpenIntuneBaseline](/baselines/quick-start/) deployment.
3. The item is in a **protected area**. Microsoft currently protects:
   * Apps (app deployments and assignments, not app protection policies)
   * Compliance policies
   * Settings Catalog configuration policies
   * Scripts for Windows devices
   * Intune roles and role assignments
   * Device categories
   * Device actions such as wipe, retire and delete (TenuVault does not run these)
   * The Multi Admin Approval access policies themselves

   Microsoft adds areas over time, so check the access policies in your tenant for the current list. Legacy device configuration profiles, administrative templates, update rings, enrollment and branding are not protected today.

Changes to the access policies themselves always need approval, even in a tenant that has none yet. So restoring **Multi admin approval policies** from a backup must be done in the Intune admin center.

## What you see

Intune refuses the write for that item. **Nothing is changed for it**, so your tenant stays as it was. Other items in the same run that are not protected are applied as usual, so one restore can end with some items restored and the protected ones failed.

The failed item shows Microsoft's message, for example:

> Header 'x-msft-approval-justification' is required to request approval

or a message that mentions approval or a pending request. **Retry failed items** does not help here: Intune refuses the change again for as long as the access policy is in place. There is nothing to resolve in [Restore write history](/restore/limitations/#restore-write-history), because nothing was written.

### When only a follow-up step is refused

Some writes take more than one step: the policy is created first, then its assignments or settings are added. If the create goes through but a later step is refused, the policy **exists in Intune without its assignments** (or settings). The result says so:

* In a restore: "Assignments could not be restored: *message*" or "Settings could not be restored: *message*", with "Incomplete object: *ID*".
* In a change set: "The object was created but its reviewed assignments failed: *message*" or "The configuration was written but the reviewed assignments failed: *message*".

Open the object in the Intune admin center and add the missing assignments or settings there, where the change goes through approval. Use the backup or the reviewed change set as the reference.

## How to apply a protected change

TenuVault does not create approval requests, and it does not approve or complete them. Approval stays in the Intune admin center, where your access policies and approvers already work:

1. Note what you need from TenuVault: open the backup or [compare backups](/backups/compare/) to see the backed-up settings and assignments, or keep the reviewed change set open.
2. Make the change in the Intune admin center. Intune asks for a justification and creates an approval request.
3. A second administrator in the access policy's approver group approves it under **Tenant administration** > **Multi Admin Approval** > **Received requests**, or under **Tenant administration** > **Admin tasks**.
4. You open the request under **My requests** and select **Complete**. The change takes effect only then.

For a restore with many protected items, plan time for the approvals. The approver cannot be the account that made the request, Intune sends no notifications about new requests, and a request that is not processed within a few days expires and must be submitted again. While a request for an object is pending, Intune refuses new requests for the same object.

## App exclusions do not apply to TenuVault

An access policy can exclude apps from approval. Microsoft applies those exclusions only to **app-only** calls, made by an app without a signed-in user. TenuVault writes signed in as you, with [delegated permissions](/security/permissions/), so excluding the TenuVault app registration does not exempt its changes. That is intended: changes made through TenuVault go through the same approval as changes you make in the admin center.

## Related pages

* [Restore Intune policies](/restore/)
* [What cannot be restored](/restore/limitations/)
* [Changes](/changes/)
* [CIS Benchmarks](/baselines/cis-benchmarks/)
* [App registration and delegated permissions](/security/permissions/)
* [Troubleshooting](/troubleshooting/#restore)
