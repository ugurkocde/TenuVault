---
title: "Multi Admin Approval and TenuVault"
description: How TenuVault works with Intune Multi Admin Approval. Backups keep working, and a restore sends protected items to Intune for approval by a second admin, then completes them after approval.
faq:
  - question: "Does Intune Multi Admin Approval stop TenuVault backups?"
    answer: "No. Multi Admin Approval only intercepts changes (create, update, assign and delete). Backups, drift detection, change reports, alerts, the Backup Reader and cloud backups only read Intune, so they keep working in a tenant with Multi Admin Approval."
  - question: "Can TenuVault restore a policy that Multi Admin Approval protects?"
    answer: "Yes. The restore sends each protected item to Intune as an approval request with your justification. A second admin approves it in the Intune admin center, and you then select Complete under Waiting for approval in TenuVault. Assignments need their own approval round after the policy itself."
  - question: "Does TenuVault approve requests?"
    answer: "No. Approving and rejecting stay in the Intune admin center, done by an admin in the access policy's approver group. TenuVault only sends the request and, after approval, completes it as the admin who sent it."
  - question: "Does excluding the TenuVault app registration from an access policy help?"
    answer: "No. App exclusions in a Multi Admin Approval access policy only apply to app-only calls. TenuVault signs in as you with delegated permissions, so the access policy still applies to it."
  - question: "Does Multi Admin Approval affect tenants that do not use it?"
    answer: "No. Nothing changes until an access policy exists for an area. Without one, TenuVault restores, promotes and remediates as usual, and the restore wizard shows no approval fields."
---

[Multi Admin Approval](https://learn.microsoft.com/intune/fundamentals/role-based-access-control/multi-admin-approval) is an Intune feature that requires a second administrator to approve changes to protected areas before they take effect. This page explains what it means for TenuVault: what keeps working, how a restore goes through approval, and what to do for other kinds of changes.

## What keeps working

Multi Admin Approval only intercepts **changes**: creating, updating, assigning and deleting. It never intercepts reads. Everything in TenuVault that only reads Intune works as usual in a tenant with Multi Admin Approval:

* Backups, manual and scheduled, including the [Backup Reader](/backups/backup-reader/) and [cloud backups](/backups/cloud/)
* [Drift detection](/drift/), [change reports](/reports/), the [audit log](/audit-log/) and [alerts](/notifications/)
* Framework coverage and CIS assessments

Tenants that have no access policy at all see no change, and the restore wizard shows no approval fields for them. The wizard checks the tenant as a whole: when it has any access policy, the justification field appears even if the items you restore are not protected. Unprotected items are then restored directly; the justification is only used for protected ones.

## Which changes need approval

A change needs approval when all three of these are true:

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

Changes to the access policies themselves always need approval, even in a tenant that has none yet.

## Restore through approval

A restore in the same tenant, with **Create copies** or **Replace in place**, sends protected items to Intune for approval. Approval itself stays in the Intune admin center.

### 1. Enter a justification

When the tenant has an access policy, the **Review** step of the restore wizard shows a **Justification** field, prefilled with the number of items and the backup date. Edit it to say why you restore (up to 700 characters). Approvers see it in Intune. The field is required for the restore to start.

The field does not appear when TenuVault cannot read the access policies (your Intune role lacks the Multi Admin Approval read permission), or when the tenant has none yet. The second case matters when you restore **Multi admin approval policies** themselves: creating the first access policy always needs approval. A protected item then ends as **Approval required**, nothing is sent yet, and you send it from **Waiting for approval** with a justification.

<figure class="docs-screenshot">
  <a href="/images/screenshots/maa-confirm.webp" aria-label="Open full-size screenshot: maa confirm">
    <img src="/images/screenshots/maa-confirm.webp" alt="An approval-protected restore asks for a justification at Review" width="2880" height="2240" loading="lazy" decoding="async" />
  </a>
  <figcaption>An approval-protected restore asks for a justification at Review. Simulated approval state; no request was sent to Intune. Select the image to view it full size.</figcaption>
</figure>

### 2. Run the restore

Unprotected items are restored as usual. Each protected item is sent to Intune as an approval request and shows **Submitted for approval** in the results. Nothing is written for it yet.

<figure class="docs-screenshot">
  <a href="/images/screenshots/maa-submitted.webp" aria-label="Open full-size screenshot: maa submitted">
    <img src="/images/screenshots/maa-submitted.webp" alt="Protected items can finish the submission step as pending approval" width="2880" height="2240" loading="lazy" decoding="async" />
  </a>
  <figcaption>Protected items can finish the submission step as pending approval. Simulated result, not a completed restore. Select the image to view it full size.</figcaption>
</figure>

### 3. A second admin approves in Intune

An admin in the access policy's approver group approves the request in the Intune admin center, under **Tenant administration** > **Multi Admin Approval** > **Received requests**, or under **Tenant administration** > **Admin tasks**. You cannot approve your own request. Intune sends no notification about new requests, so tell your approver.

### 4. Complete it in TenuVault

**Waiting for approval**, above the restore steps, lists the restore requests sent from this TenuVault installation for this tenant, with their status, the approver's note and the time left. It does not list every request in the tenant: requests made in the admin center or from another computer are not shown. Complete a request on the installation that sent it, and keep that installation's data until the request is completed. The list refreshes when you open it, when you select **Refresh**, and once a minute while it is open.

When a request shows **Approved, ready to complete**, select **Complete**. TenuVault then:

* checks that you are the admin who sent the request (only that admin can complete it, as in Intune),
* for **Replace in place**, checks that the live policy has not changed since you sent the request,
* sends exactly the change that was approved, and records it in the [audit log](/audit-log/) and [Restore write history](/restore/limitations/#restore-write-history) like any restore.

### Assignments need a second round

Intune treats assigning a policy as a separate protected change. When the restore has assignments to write (**Restore assignments** on, and the backup holds assignments for the policy), a protected policy takes two rounds: first the policy itself, then its assignments. After you complete the first round, TenuVault sends the assignments for approval automatically with the same justification, and the list shows **Step 2 of 2**. A policy restored without assignments, such as an unassigned copy, has only one round.

While the assignments round waits, the first round is already applied:

* A **recreated** policy or a **copy** exists in Intune without its restored assignments, so it reaches no devices yet.
* A **replaced** Settings Catalog policy already has the backed-up settings and keeps its current assignments. Devices in those current groups receive the restored settings before the assignments round is approved.

### Other actions

* **Withdraw** cancels a request that is still waiting or approved.
* **Dismiss** removes a finished request (completed, rejected, withdrawn or expired) from the list, or one you decided not to send.
* **Rejected** requests show the approver's note. Restore the item again if you want to send a new request.
* Requests expire in Intune after a few days. The list shows the time left; an expired request has to be sent again.

### Messages you may see

| Message | Meaning | What to do |
| --- | --- | --- |
| Submitted for approval | The request is waiting in Intune. Nothing was written for this step. | Ask an approver to approve it, then select **Complete**. |
| Earlier restore steps were written. Submitted for approval | The policy was already created or updated; its assignments (step 2) wait for approval. | Ask an approver to approve the assignments request, then select **Complete**. |
| Multi Admin Approval protects *type* in this tenant. Nothing was changed. | Intune asked for approval, and the item was not sent (no justification). | Open **Waiting for approval**, enter a justification and select **Submit for approval**. |
| Another admin already has a pending request for this object in Intune. | Intune allows one pending request per object. | Wait until that request is completed or withdrawn, then restore again. |
| A different change to this object is already waiting for approval in Intune. Complete or withdraw it first. | You already sent another change for the same policy. | Complete or withdraw the earlier request. |
| The live object changed after submission. Review it and start a fresh restore. | Someone changed the policy while the request waited. Completing would overwrite that change. | Review the policy, then start a new restore. |
| Intune refused to complete this request. It may have expired, been changed, or been completed already. | Intune did not accept the completion. | Check the request in the Intune admin center. |
| Only the original requester can complete or withdraw this request | You are signed in as a different admin. | Sign in as the admin shown as requester. |
| TenuVault could not read this object when the request was sent, so it cannot check whether it changed since. | The live policy could not be read when the request was sent, so overwriting it now could undo someone else's change. | Review the policy in Intune, withdraw the request and restore again. |

A **copy to other tenants** does not send approval requests. If a protected item is refused there, make the change in the target tenant's Intune admin center.

## Promotions, CIS remediation and baselines

[Changes](/changes/) (Dev to Prod promotion, baseline upgrades), [CIS remediation](/baselines/cis-benchmarks/) and [OpenIntuneBaseline](/baselines/quick-start/) deployments do not send approval requests. A protected operation is marked as blocked by Multi Admin Approval with the message "Multi Admin Approval protects *type* in this tenant. Nothing was changed.", and the change set summary counts it separately. Other operations in the same change set run as usual.

To apply a blocked operation, make the change in the Intune admin center, where it goes through approval, using the reviewed change set as the reference. An operation that was blocked before anything was written can be retried later, for example after the access policy changes.

If only a follow-up step was blocked (the policy was created or updated, but its assignments need approval), the message says what was written: "The configuration was written, but assignments or a follow-up step need approval." Add the assignments in the Intune admin center.

## App exclusions do not apply to TenuVault

An access policy can exclude apps from approval. Microsoft applies those exclusions only to **app-only** calls, made by an app without a signed-in user. TenuVault writes signed in as you, with [delegated permissions](/security/permissions/), so excluding the TenuVault app registration does not exempt its changes. That is intended: changes made through TenuVault go through the same approval as changes you make in the admin center.

## Related pages

* [Restore Intune policies](/restore/)
* [What cannot be restored](/restore/limitations/)
* [Changes](/changes/)
* [CIS Benchmarks](/baselines/cis-benchmarks/)
* [App registration and delegated permissions](/security/permissions/)
* [Troubleshooting](/troubleshooting/#restore)
